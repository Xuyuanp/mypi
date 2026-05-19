/**
 * Goals Extension
 *
 * Persists a single budget-tracked objective per session and autonomously
 * continues across turn boundaries until the goal is achieved, the budget is
 * exhausted, or the user intervenes.
 *
 * Feature gate: enabled when env `PI_GOALS_ENABLED=1` is set.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
    AgentEndEvent,
    ExtensionAPI,
    ExtensionContext,
    TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GoalDatabase } from "./db.js";
import {
    renderBudgetLimitPrompt,
    renderCompletionReport,
    renderContinuationPrompt,
    renderObjectiveUpdatedPrompt,
} from "./prompts.js";
import { canTransition, validateModelTransition } from "./state-machine.js";
import {
    BUDGET_LIMIT_MESSAGE_TYPE,
    CONTINUATION_MESSAGE_TYPE,
    EMPTY_PROGRESS_LIMIT,
    EVT_GOAL_CLEARED,
    EVT_GOAL_CONTINUATION,
    EVT_GOAL_CREATED,
    EVT_GOAL_UPDATED,
    type GoalStatus,
    MAX_AUTONOMOUS_TURNS,
    OBJECTIVE_UPDATED_MESSAGE_TYPE,
    type SessionGoal,
    STALE_GOAL_SECONDS,
    STATUS_KEY,
} from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Default DB path. Override via PI_GOALS_DB_PATH (used by tests). */
function defaultDbPath(): string {
    return (
        process.env.PI_GOALS_DB_PATH || join(homedir(), ".pi", "state", "goals.db")
    );
}

/**
 * Extract billable token usage from a TurnEndEvent message.
 * Spec section 4.3: input - cacheRead + output. Returns 0 when usage is
 * absent (provider not reporting).
 */
function tokenDelta(event: TurnEndEvent): number {
    const message = event.message;
    if (message.role !== "assistant") return 0;
    const usage = message.usage;
    if (!usage) return 0;
    const input = Number(usage.input) || 0;
    const cacheRead = Number(usage.cacheRead) || 0;
    const output = Number(usage.output) || 0;
    return Math.max(0, input - cacheRead) + Math.max(0, output);
}

/** Find the last assistant message in a list (used at agent_end). */
function lastAssistantStopReason(
    messages: AgentEndEvent["messages"],
): "stop" | "length" | "toolUse" | "error" | "aborted" | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "assistant") return m.stopReason;
    }
    return undefined;
}

function formatStatus(goal: SessionGoal): string {
    const tokens = goal.tokens_used.toLocaleString();
    const budget =
        goal.token_budget === null
            ? "unlimited"
            : goal.token_budget.toLocaleString();
    return `[Goal: ${goal.status} | ${tokens}/${budget} tokens | turn ${goal.turns_used}/${MAX_AUTONOMOUS_TURNS}]`;
}

function timeAgo(epochSeconds: number): string {
    const delta = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

// ── Tool schemas ────────────────────────────────────────────────────────

const CreateGoalParams = Type.Object({
    objective: Type.String({
        description: "Required. The concrete objective to pursue.",
        minLength: 1,
        maxLength: 4000,
    }),
    token_budget: Type.Optional(
        Type.Integer({
            description: "Optional positive token budget.",
            minimum: 1,
        }),
    ),
});

const GetGoalParams = Type.Object({});

const UpdateGoalParams = Type.Object({
    status: StringEnum(["complete"] as const, {
        description: "Required. Must be 'complete'.",
    }),
    expected_goal_id: Type.Optional(
        Type.String({
            description:
                "Optional. The goal_id from the most recent get_goal call. If provided and the stored goal_id has changed, the call fails.",
        }),
    ),
});

interface GoalToolResult {
    goal: SessionGoal | null;
    remaining_tokens: number | null;
}

interface UpdateGoalToolResult extends GoalToolResult {
    completion_report: string | null;
}

function remainingTokens(goal: SessionGoal | null): number | null {
    if (!goal || goal.token_budget === null) return null;
    return Math.max(0, goal.token_budget - goal.tokens_used);
}

function toolErrorResult(text: string) {
    return {
        content: [{ type: "text" as const, text }],
        details: { error: text },
    };
}

function toolJsonResult(payload: unknown) {
    return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        details: payload,
    };
}

// ── Extension ───────────────────────────────────────────────────────────

export default function goalsExtension(pi: ExtensionAPI) {
    if (process.env.PI_GOALS_ENABLED !== "1") return;

    // ── DB ───────────────────────────────────────────────────────────

    let db: GoalDatabase | null = null;
    let dbInitError: string | undefined;

    function ensureDb(): GoalDatabase | null {
        if (db) return db;
        if (dbInitError) return null;
        try {
            db = new GoalDatabase(defaultDbPath());
            return db;
        } catch (err) {
            dbInitError = err instanceof Error ? err.message : String(err);
            return null;
        }
    }

    // ── Per-run state (closure) ──────────────────────────────────────

    let isAutonomousContinuation = false;
    let currentRunHadToolCalls = false;
    let runStartTimestamp = 0;
    let currentRunTokens = 0;
    let budgetExceededDuringRun = false;
    /** Counter of consecutive empty autonomous runs. Reset on user input or progress. */
    let emptyProgressCount = 0;
    /**
     * Whether the goal was "active" at the start of the current run.
     * Accounting (token/time flush) only applies when this is true -- it
     * covers the normal active-run case AND the transitioning run (active
     * at start, flipped to complete/paused mid-run by update_goal). Runs
     * that start with an already-paused/complete/budget_limited goal do
     * NOT consume budget.
     */
    let goalActiveAtRunStart = false;
    /**
     * Whether a "no usage data" warning has been emitted for the current
     * goal. Set to true after the first notification so we don't spam.
     * Reset when a new goal is created.
     */
    let usageUnavailableWarned = false;

    // ── Helpers that need ctx ─────────────────────────────────────────

    function getSessionId(ctx: ExtensionContext): string {
        return ctx.sessionManager.getSessionId();
    }

    function emit(channel: string, payload: unknown): void {
        try {
            pi.events.emit(channel, payload);
        } catch {
            // pi.events may not be available in some test setups.
        }
    }

    function refreshStatus(ctx: ExtensionContext, goal: SessionGoal | null): void {
        if (!ctx.hasUI) return;
        if (!goal) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
            return;
        }
        ctx.ui.setStatus(STATUS_KEY, formatStatus(goal));
    }

    /**
     * Schedule the next autonomous continuation.
     *
     * Must be deferred via setImmediate: agent_end fires while the agent's
     * activeRun is still set; calling agent.prompt() synchronously throws.
     * setImmediate runs after the current run's lifecycle has cleared.
     */
    function scheduleContinuation(ctx: ExtensionContext, sessionId: string): void {
        setImmediate(() => {
            // Re-check goal state & guardrails before firing. The DB may
            // have changed under us during the setImmediate delay (concurrent
            // mutation, command, etc.); never start a run that would violate
            // the turn cap or budget.
            //
            // The whole body is wrapped because ctx may be stale (session
            // disposed/replaced) by the time setImmediate fires. ctx.isIdle
            // and friends throw on stale ctx; treat that as "do not
            // continue" rather than crashing the process.
            try {
                const dbi = ensureDb();
                if (!dbi) return;
                const current = dbi.getGoal(sessionId);
                if (!current || current.status !== "active") return;
                if (current.turns_used >= MAX_AUTONOMOUS_TURNS) return;
                if (
                    current.token_budget !== null &&
                    current.tokens_used >= current.token_budget
                ) {
                    return;
                }
                if (!ctx.isIdle()) return;
                if (ctx.hasPendingMessages()) return;
                isAutonomousContinuation = true;
                emit(EVT_GOAL_CONTINUATION, {
                    session_id: sessionId,
                    turn_number: current.turns_used,
                });
                // Render the prompt from the freshly-read goal (current),
                // not the stale `goal` parameter from the caller. Between
                // scheduling and execution, objective or budget may have
                // been updated by another session/command.
                const prompt = renderContinuationPrompt(current);
                try {
                    pi.sendMessage(
                        {
                            customType: CONTINUATION_MESSAGE_TYPE,
                            content: prompt,
                            display: false,
                        },
                        { triggerTurn: true },
                    );
                } catch {
                    isAutonomousContinuation = false;
                }
            } catch {
                // Stale ctx (session disposed) or transient runtime error.
                isAutonomousContinuation = false;
            }
        });
    }

    function pauseGoal(
        ctx: ExtensionContext,
        sessionId: string,
        actor: "user" | "system",
        reason: string,
    ): SessionGoal | null {
        const dbi = ensureDb();
        if (!dbi) return null;
        const goal = dbi.getGoal(sessionId);
        if (!goal) return null;
        if (!canTransition(goal.status, "paused", actor)) return goal;
        const previousStatus = goal.status;
        const updated = dbi.updateStatus(sessionId, null, "paused");
        if (updated) {
            emit(EVT_GOAL_UPDATED, {
                goal: updated,
                previous_status: previousStatus,
            });
            refreshStatus(ctx, updated);
            if (ctx.hasUI) ctx.ui.notify(reason, "warning");
        }
        return updated;
    }

    /**
     * Transition goal to `budget_limited`, notify the user, and send a
     * wrap-up steering prompt. Extracted as a helper because the same
     * logic is needed both when the budget/cap is hit during a run (step
     * [6]) and when the post-increment check hits it (step [8b]).
     */
    function transitionToBudgetLimited(
        ctx: ExtensionContext,
        dbi: GoalDatabase,
        sessionId: string,
        goal: SessionGoal,
        isTurnCap: boolean,
    ): void {
        const previousStatus = goal.status;
        const updated = dbi.updateStatus(sessionId, null, "budget_limited");
        if (!updated) return;
        emit(EVT_GOAL_UPDATED, {
            goal: updated,
            previous_status: previousStatus,
        });
        refreshStatus(ctx, updated);
        const wrapUp = renderBudgetLimitPrompt(updated);
        if (ctx.hasUI) {
            ctx.ui.notify(
                isTurnCap
                    ? "Goal reached the autonomous turn cap. Wrapping up..."
                    : `Goal budget reached (${updated.token_budget} tokens). Wrapping up...`,
                "warning",
            );
        }
        // Send wrap-up steering prompt as a one-shot turn. The entire
        // body is wrapped in try/catch because ctx may be stale (session
        // disposed/replaced) by the time setImmediate fires.
        setImmediate(() => {
            try {
                if (!ctx.isIdle()) return;
                if (ctx.hasPendingMessages()) return;
                pi.sendMessage(
                    {
                        customType: BUDGET_LIMIT_MESSAGE_TYPE,
                        content: wrapUp,
                        display: false,
                    },
                    { triggerTurn: true },
                );
            } catch {
                // Stale ctx or transient runtime error -- goal is already
                // budget_limited, the wrap-up prompt is best-effort.
            }
        });
    }

    // ── Event: session_start ─────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        // Reset per-session flags.
        isAutonomousContinuation = false;
        currentRunHadToolCalls = false;
        currentRunTokens = 0;
        budgetExceededDuringRun = false;
        emptyProgressCount = 0;
        usageUnavailableWarned = false;

        const dbi = ensureDb();
        if (!dbi) {
            if (ctx.hasUI && dbInitError) {
                ctx.ui.notify(
                    `Goals: failed to open database: ${dbInitError}`,
                    "error",
                );
            }
            return;
        }
        const sessionId = getSessionId(ctx);
        const goal = dbi.getGoal(sessionId);
        if (!goal) {
            refreshStatus(ctx, null);
            return;
        }

        if (goal.status === "active") {
            const ageSeconds = Math.floor(Date.now() / 1000) - goal.updated_at;
            if (ageSeconds > STALE_GOAL_SECONDS) {
                const updated = dbi.updateStatus(sessionId, null, "paused");
                if (updated) {
                    emit(EVT_GOAL_UPDATED, {
                        goal: updated,
                        previous_status: "active" satisfies GoalStatus,
                    });
                    refreshStatus(ctx, updated);
                    if (ctx.hasUI) {
                        ctx.ui.notify(
                            `Stale active goal detected (last updated ${timeAgo(goal.updated_at)}). Resume with /goal resume or clear with /goal clear.`,
                            "warning",
                        );
                    }
                }
                return;
            }
            // Enforce safety caps BEFORE scheduling continuation. A crash
            // between incrementTurns() and the next run could leave a goal
            // "active" with turns_used >= MAX or tokens_used >= budget; on
            // restart we must transition it to budget_limited rather than
            // resuming the loop.
            const turnCapHit = goal.turns_used >= MAX_AUTONOMOUS_TURNS;
            const budgetHit =
                goal.token_budget !== null && goal.tokens_used >= goal.token_budget;
            if (turnCapHit || budgetHit) {
                const updated = dbi.updateStatus(sessionId, null, "budget_limited");
                if (updated) {
                    emit(EVT_GOAL_UPDATED, {
                        goal: updated,
                        previous_status: "active" satisfies GoalStatus,
                    });
                    refreshStatus(ctx, updated);
                    if (ctx.hasUI) {
                        ctx.ui.notify(
                            turnCapHit
                                ? "Goal at autonomous turn cap. Resume with /goal resume after raising the limit."
                                : `Goal already over budget (${updated.tokens_used}/${updated.token_budget}). Resume with /goal resume after raising the budget.`,
                            "warning",
                        );
                    }
                }
                return;
            }
            if (ctx.hasUI) {
                ctx.ui.notify(`Resuming active goal: ${goal.objective}`, "info");
            }
            refreshStatus(ctx, goal);
            scheduleContinuation(ctx, sessionId);
            return;
        }

        // Paused / budget_limited / complete
        refreshStatus(ctx, goal);
        if (ctx.hasUI && goal.status !== "complete") {
            ctx.ui.notify(
                `Goal is ${goal.status}. Resume with /goal resume.`,
                "info",
            );
        }
    });

    // ── Event: agent_start ──────────────────────────────────────────

    pi.on("agent_start", async (_event, ctx) => {
        currentRunHadToolCalls = false;
        currentRunTokens = 0;
        budgetExceededDuringRun = false;
        runStartTimestamp = Date.now();

        // Snapshot goal status at run start so accounting is scoped to
        // runs that began while the goal was active (plus the
        // active-to-complete/paused transition run).
        goalActiveAtRunStart = false;
        const dbi = ensureDb();
        if (dbi) {
            const sessionId = getSessionId(ctx);
            const goal = dbi.getGoal(sessionId);
            if (goal && goal.status === "active") {
                goalActiveAtRunStart = true;
            }
        }
    });

    // ── Event: tool_execution_end ───────────────────────────────────

    pi.on("tool_execution_end", async (_event, _ctx) => {
        currentRunHadToolCalls = true;
    });

    // ── Event: turn_end ─────────────────────────────────────────────

    pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
        // Only accumulate tokens if the goal was active when this run
        // started. This covers the normal active case AND the
        // transitioning run (active at start, flipped mid-run by
        // update_goal). Runs that start with an already-paused/complete
        // goal do not consume budget.
        if (!goalActiveAtRunStart) return;
        const dbi = ensureDb();
        if (!dbi) return;
        const sessionId = getSessionId(ctx);
        const goal = dbi.getGoal(sessionId);
        if (!goal) return;

        const delta = tokenDelta(event);
        currentRunTokens += delta;

        // Warn once per goal when the provider does not report usage but
        // a budget is configured -- budget enforcement is non-functional.
        if (
            !usageUnavailableWarned &&
            goal.token_budget !== null &&
            event.message.role === "assistant" &&
            !event.message.usage
        ) {
            usageUnavailableWarned = true;
            if (ctx.hasUI) {
                ctx.ui.notify(
                    "Warning: token usage data is unavailable from this provider. Budget enforcement will not function until usage reporting is enabled.",
                    "warning",
                );
            }
        }

        if (
            goal.token_budget !== null &&
            goal.tokens_used + currentRunTokens >= goal.token_budget
        ) {
            budgetExceededDuringRun = true;
        }
    });

    // ── Event: agent_end ────────────────────────────────────────────

    pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
        const dbi = ensureDb();
        if (!dbi) {
            isAutonomousContinuation = false;
            return;
        }
        const sessionId = getSessionId(ctx);
        let goal = dbi.getGoal(sessionId);
        const wasAutonomous = isAutonomousContinuation;
        isAutonomousContinuation = false;
        if (!goal) {
            return;
        }

        // [1] Flush token / time accounting. Only if the goal was active
        // when this run started. This covers the transitioning run (active
        // at start, flipped to complete/paused mid-run by update_goal) but
        // skips unrelated runs that start while the goal is already in a
        // terminal state (paused/complete/budget_limited).
        if (goalActiveAtRunStart) {
            const elapsed = Math.max(
                0,
                Math.floor((Date.now() - runStartTimestamp) / 1000),
            );
            if (currentRunTokens > 0 || elapsed > 0) {
                const updated = dbi.accountTokens(
                    sessionId,
                    currentRunTokens,
                    elapsed,
                );
                if (updated) goal = updated;
            }
        }
        currentRunTokens = 0;

        // [1b] For autonomous runs where the goal was active at run
        // start but transitioned away during the run (e.g., model called
        // update_goal(complete)), still count the turn. Without this, the
        // final autonomous run is undercounted in turns_used.
        if (wasAutonomous && goalActiveAtRunStart && goal.status !== "active") {
            dbi.incrementTurns(sessionId);
        }

        // After accounting, the rest of the loop logic (empty progress,
        // continuation, budget transitions) only applies to active goals.
        if (goal.status !== "active") {
            return;
        }

        // [2] Track empty progress for autonomous runs only.
        if (wasAutonomous) {
            if (currentRunHadToolCalls) {
                emptyProgressCount = 0;
            } else {
                emptyProgressCount += 1;
            }
        } else {
            // User intervention always resets the counter -- a fresh user
            // turn is by definition progress, regardless of whether the
            // assistant happened to call a tool in response. Otherwise a
            // text-only user reply would leave a stale autonomous count
            // intact and prematurely auto-pause on the next empty run.
            emptyProgressCount = 0;
        }

        const stopReason = lastAssistantStopReason(event.messages);

        // [3] Aborted: pause and stop.
        if (stopReason === "aborted") {
            pauseGoal(
                ctx,
                sessionId,
                "system",
                "Goal paused -- interrupted. Resume with /goal resume.",
            );
            return;
        }

        // [4] Error: pause and stop.
        if (stopReason === "error") {
            pauseGoal(
                ctx,
                sessionId,
                "system",
                "Goal paused due to error. Resume with /goal resume.",
            );
            return;
        }

        // [4b] Continuation requires stopReason === "stop" (spec section
        // 8.1.3). Any other value -- including `undefined` (no assistant
        // message was produced, e.g. run failed before model output) --
        // indicates an unhealthy or incomplete run. For autonomous runs,
        // pause the goal to break the loop. For user-initiated runs, just
        // skip continuation scheduling without pausing (the user can
        // re-engage).
        if (stopReason !== "stop") {
            if (wasAutonomous) {
                pauseGoal(
                    ctx,
                    sessionId,
                    "system",
                    stopReason === undefined
                        ? "Goal paused -- run ended without assistant output. Resume with /goal resume."
                        : `Goal paused -- run ended with stopReason "${stopReason}". Resume with /goal resume.`,
                );
            }
            return;
        }

        refreshStatus(ctx, goal);

        // [5] Empty progress detector.
        if (emptyProgressCount >= EMPTY_PROGRESS_LIMIT) {
            emptyProgressCount = 0;
            pauseGoal(
                ctx,
                sessionId,
                "system",
                `Goal paused: no progress detected after ${EMPTY_PROGRESS_LIMIT} turns.`,
            );
            return;
        }

        // [6] Budget hit: transition to budget_limited and inject wrap-up prompt.
        const budgetHit =
            budgetExceededDuringRun ||
            (goal.token_budget !== null && goal.tokens_used >= goal.token_budget);
        const turnCapHit = goal.turns_used >= MAX_AUTONOMOUS_TURNS;
        if (budgetHit || turnCapHit) {
            transitionToBudgetLimited(ctx, dbi, sessionId, goal, turnCapHit);
            return;
        }

        // [7] Pending user input: skip continuation, let it run as its own turn.
        if (ctx.hasPendingMessages()) return;

        // [8] All conditions pass: increment turn counter and continue.
        const incremented = dbi.incrementTurns(sessionId);
        if (!incremented) return;
        refreshStatus(ctx, incremented);

        // [8b] Post-increment cap check: incrementTurns may have pushed
        // turns_used to exactly MAX_AUTONOMOUS_TURNS. If so, transition to
        // budget_limited with wrap-up rather than calling scheduleContinuation
        // (which would silently block without transitioning).
        const postIncrementCapHit = incremented.turns_used >= MAX_AUTONOMOUS_TURNS;
        const postIncrementBudgetHit =
            incremented.token_budget !== null &&
            incremented.tokens_used >= incremented.token_budget;
        if (postIncrementCapHit || postIncrementBudgetHit) {
            transitionToBudgetLimited(
                ctx,
                dbi,
                sessionId,
                incremented,
                postIncrementCapHit,
            );
            return;
        }
        scheduleContinuation(ctx, sessionId);
    });

    // ── Tools ───────────────────────────────────────────────────────

    pi.registerTool({
        name: "create_goal",
        label: "Create Goal",
        description:
            "Create a persistent goal only when explicitly requested by the user. Do not infer goals from ordinary tasks. Set token_budget only when an explicit budget is requested.",
        parameters: CreateGoalParams,
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const objective = params.objective?.trim() ?? "";
            if (objective.length === 0) {
                return toolErrorResult(
                    "objective must not be empty (1-4000 characters required).",
                );
            }
            if (objective.length > 4000) {
                return toolErrorResult(
                    "objective exceeds the 4000 character limit.",
                );
            }
            const dbi = ensureDb();
            if (!dbi) {
                return toolErrorResult(
                    `Goals database unavailable: ${dbInitError ?? "unknown error"}`,
                );
            }
            const sessionId = getSessionId(ctx);
            const created = dbi.createGoal(
                sessionId,
                objective,
                params.token_budget ?? null,
                false,
            );
            if (!created) {
                return toolErrorResult("A goal already exists. Clear it first.");
            }
            // A freshly-created goal is active; enable accounting for the
            // remainder of this run (the run started before the goal
            // existed, but tokens spent after creation belong to it).
            goalActiveAtRunStart = true;
            usageUnavailableWarned = false;
            emit(EVT_GOAL_CREATED, { goal: created });
            refreshStatus(ctx, created);
            return toolJsonResult({
                goal: created,
                remaining_tokens: remainingTokens(created),
            } satisfies GoalToolResult);
        },
    });

    pi.registerTool({
        name: "get_goal",
        label: "Get Goal",
        description: "Get the current goal including status, budgets, and usage.",
        parameters: GetGoalParams,
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            const dbi = ensureDb();
            if (!dbi) {
                return toolErrorResult(
                    `Goals database unavailable: ${dbInitError ?? "unknown error"}`,
                );
            }
            const sessionId = getSessionId(ctx);
            const goal = dbi.getGoal(sessionId);
            return toolJsonResult({
                goal,
                remaining_tokens: remainingTokens(goal),
            } satisfies GoalToolResult);
        },
    });

    pi.registerTool({
        name: "update_goal",
        label: "Update Goal",
        description:
            "Mark the goal complete only when the objective is fully achieved and no required work remains. Do not call merely because the budget is low or you are stopping.",
        parameters: UpdateGoalParams,
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const dbi = ensureDb();
            if (!dbi) {
                return toolErrorResult(
                    `Goals database unavailable: ${dbInitError ?? "unknown error"}`,
                );
            }
            const sessionId = getSessionId(ctx);
            const goal = dbi.getGoal(sessionId);
            if (!goal) {
                return toolErrorResult("No active goal to update.");
            }
            if (
                params.expected_goal_id !== undefined &&
                params.expected_goal_id !== goal.goal_id
            ) {
                return toolErrorResult(
                    "Goal was changed externally. Call get_goal to read current state.",
                );
            }
            const validation = validateModelTransition(goal.status, "complete");
            if (!validation.valid) {
                return toolErrorResult(validation.error ?? "Invalid transition.");
            }
            const previousStatus = goal.status;
            const updated = dbi.updateStatus(
                sessionId,
                params.expected_goal_id ?? goal.goal_id,
                "complete",
            );
            if (!updated) {
                return toolErrorResult(
                    "Goal was changed externally. Call get_goal to read current state.",
                );
            }
            emit(EVT_GOAL_UPDATED, {
                goal: updated,
                previous_status: previousStatus,
            });
            refreshStatus(ctx, updated);
            const completion_report =
                updated.token_budget !== null
                    ? renderCompletionReport(updated)
                    : null;
            return toolJsonResult({
                goal: updated,
                remaining_tokens: remainingTokens(updated),
                completion_report,
            } satisfies UpdateGoalToolResult);
        },
    });
    // ── Commands ────────────────────────────────────────────────────

    function parseCommand(args: string): { sub: string; rest: string } {
        const trimmed = args.trim();
        if (!trimmed) return { sub: "", rest: "" };
        const idx = trimmed.search(/\s/);
        if (idx === -1) return { sub: trimmed, rest: "" };
        return {
            sub: trimmed.slice(0, idx),
            rest: trimmed.slice(idx + 1).trim(),
        };
    }

    /** Maximum objective length (matches tool schema maxLength). */
    const MAX_OBJECTIVE_LENGTH = 4000;

    /**
     * Parse `<text> [--budget N]` or `--budget N <text>`.
     * Returns objective without the budget flag and the parsed budget.
     */

    function parseObjectiveAndBudget(rest: string): {
        objective: string;
        budget: number | null;
        error?: string;
    } {
        // Match --budget followed by any non-whitespace token so we can
        // reject malformed values (negative, trailing chars, etc.) rather
        // than silently ignoring them.
        const m = rest.match(/--budget\s+(\S+)/);
        let budget: number | null = null;
        let objective = rest;
        if (m) {
            const raw = m[1];
            // Strict check: must be all digits (no sign, no decimals, no
            // trailing chars).
            if (!/^\d+$/.test(raw)) {
                return {
                    objective: "",
                    budget: null,
                    error: "Invalid --budget value (must be a positive integer).",
                };
            }
            const n = Number.parseInt(raw, 10);
            if (!Number.isFinite(n) || n <= 0) {
                return {
                    objective: "",
                    budget: null,
                    error: "Invalid --budget value (must be a positive integer).",
                };
            }
            budget = n;
            objective = (rest.slice(0, m.index) + rest.slice(m.index! + m[0].length))
                .replace(/\s+/g, " ")
                .trim();
        }
        objective = objective.trim();
        if (objective.length > MAX_OBJECTIVE_LENGTH) {
            return {
                objective: "",
                budget: null,
                error: `Objective exceeds the ${MAX_OBJECTIVE_LENGTH} character limit (got ${objective.length}).`,
            };
        }
        return { objective, budget };
    }

    pi.registerCommand("goal", {
        description:
            "Manage the session goal: /goal create|status|pause|resume|edit|budget|complete|clear",
        handler: async (args, ctx) => {
            const dbi = ensureDb();
            if (!dbi) {
                if (ctx.hasUI) {
                    ctx.ui.notify(
                        `Goals database unavailable: ${dbInitError ?? "unknown error"}`,
                        "error",
                    );
                }
                return;
            }
            const sessionId = getSessionId(ctx);
            const { sub, rest } = parseCommand(args);

            switch (sub) {
                case "":
                case "status": {
                    const goal = dbi.getGoal(sessionId);
                    if (!goal) {
                        if (ctx.hasUI) ctx.ui.notify("No active goal.", "info");
                        return;
                    }
                    refreshStatus(ctx, goal);
                    if (ctx.hasUI) {
                        const lines = [
                            `Objective: ${goal.objective}`,
                            `Status: ${goal.status}`,
                            `Tokens: ${goal.tokens_used}${goal.token_budget !== null ? `/${goal.token_budget}` : ""}`,
                            `Time: ${goal.time_used_seconds}s`,
                            `Turns: ${goal.turns_used}/${MAX_AUTONOMOUS_TURNS}`,
                        ];
                        ctx.ui.notify(lines.join("\n"), "info");
                    }
                    return;
                }
                case "create": {
                    const { objective, budget, error } =
                        parseObjectiveAndBudget(rest);
                    if (error) {
                        if (ctx.hasUI) ctx.ui.notify(error, "error");
                        return;
                    }
                    if (!objective) {
                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                "Usage: /goal create <objective> [--budget <n>]",
                                "error",
                            );
                        }
                        return;
                    }
                    const created = dbi.createGoal(
                        sessionId,
                        objective,
                        budget,
                        true,
                    );
                    if (!created) return;
                    usageUnavailableWarned = false;
                    // Reset the empty-progress counter: a fresh goal starts
                    // a new autonomous loop with a clean slate.
                    emptyProgressCount = 0;
                    emit(EVT_GOAL_CREATED, { goal: created });
                    refreshStatus(ctx, created);
                    if (ctx.hasUI) {
                        ctx.ui.notify(`Goal created: ${objective}`, "info");
                    }
                    scheduleContinuation(ctx, sessionId);
                    return;
                }
                case "pause": {
                    const goal = dbi.getGoal(sessionId);
                    if (!goal) {
                        if (ctx.hasUI) ctx.ui.notify("No active goal.", "info");
                        return;
                    }
                    if (!canTransition(goal.status, "paused", "user")) {
                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                `Cannot pause goal in status ${goal.status}.`,
                                "warning",
                            );
                        }
                        return;
                    }
                    const previousStatus = goal.status;
                    const updated = dbi.updateStatus(sessionId, null, "paused");
                    if (updated) {
                        emit(EVT_GOAL_UPDATED, {
                            goal: updated,
                            previous_status: previousStatus,
                        });
                        refreshStatus(ctx, updated);
                        if (ctx.hasUI) ctx.ui.notify("Goal paused.", "info");
                    }
                    return;
                }
                case "resume": {
                    const goal = dbi.getGoal(sessionId);
                    if (!goal) {
                        if (ctx.hasUI) ctx.ui.notify("No active goal.", "info");
                        return;
                    }
                    if (!canTransition(goal.status, "active", "user")) {
                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                `Cannot resume goal in status ${goal.status}.`,
                                "warning",
                            );
                        }
                        return;
                    }
                    const previousStatus = goal.status;
                    // Pre-check: if the guardrails that caused budget_limited
                    // are STILL violated (user resumed without raising the
                    // limit), reject the transition rather than leaving the
                    // goal stuck in "active" with no continuation running.
                    const turnCapStillHit = goal.turns_used >= MAX_AUTONOMOUS_TURNS;
                    const budgetStillHit =
                        goal.token_budget !== null &&
                        goal.tokens_used >= goal.token_budget;
                    if (turnCapStillHit || budgetStillHit) {
                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                turnCapStillHit
                                    ? "Cannot resume: autonomous turn cap still reached. Raise the limit first."
                                    : `Cannot resume: token budget still exceeded (${goal.tokens_used}/${goal.token_budget}). Raise the budget first.`,
                                "warning",
                            );
                        }
                        return;
                    }
                    const updated = dbi.updateStatus(sessionId, null, "active");
                    if (!updated) return;
                    // Reset the empty-progress counter: an explicit user
                    // resume starts a fresh autonomous loop. Without this,
                    // a stale count from the prior loop can cause premature
                    // auto-pause on the very first resumed run.
                    emptyProgressCount = 0;
                    emit(EVT_GOAL_UPDATED, {
                        goal: updated,
                        previous_status: previousStatus,
                    });
                    refreshStatus(ctx, updated);
                    if (ctx.hasUI) ctx.ui.notify("Goal resumed.", "info");
                    scheduleContinuation(ctx, sessionId);
                    return;
                }
                case "edit": {
                    const goal = dbi.getGoal(sessionId);
                    if (!goal) {
                        if (ctx.hasUI) ctx.ui.notify("No active goal.", "info");
                        return;
                    }
                    const trimmedObjective = rest?.trim() ?? "";
                    if (!trimmedObjective) {
                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                "Usage: /goal edit <new objective>",
                                "error",
                            );
                        }
                        return;
                    }
                    if (trimmedObjective.length > MAX_OBJECTIVE_LENGTH) {
                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                `Objective exceeds the ${MAX_OBJECTIVE_LENGTH} character limit (got ${trimmedObjective.length}).`,
                                "error",
                            );
                        }
                        return;
                    }
                    const updated = dbi.updateObjective(
                        sessionId,
                        null,
                        trimmedObjective,
                    );
                    if (!updated) return;
                    emit(EVT_GOAL_UPDATED, {
                        goal: updated,
                        previous_status: goal.status,
                    });
                    refreshStatus(ctx, updated);
                    if (ctx.hasUI) {
                        ctx.ui.notify(`Goal objective updated.`, "info");
                    }
                    // If the goal is active and a turn is in flight, send
                    // an objective-updated steering prompt as a hidden message.
                    if (updated.status === "active") {
                        const prompt = renderObjectiveUpdatedPrompt(updated);
                        try {
                            pi.sendMessage(
                                {
                                    customType: OBJECTIVE_UPDATED_MESSAGE_TYPE,
                                    content: prompt,
                                    display: false,
                                },
                                { triggerTurn: false },
                            );
                        } catch {
                            if (ctx.hasUI) {
                                ctx.ui.notify(
                                    "Warning: objective updated in DB but steering prompt could not be delivered to the model.",
                                    "warning",
                                );
                            }
                        }
                    }
                    return;
                }
                case "budget": {
                    const goal = dbi.getGoal(sessionId);
                    if (!goal) {
                        if (ctx.hasUI) ctx.ui.notify("No active goal.", "info");
                        return;
                    }
                    const n = Number.parseInt(rest, 10);
                    if (!Number.isFinite(n) || n <= 0) {
                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                "Usage: /goal budget <positive integer>",
                                "error",
                            );
                        }
                        return;
                    }
                    const updated = dbi.updateBudget(sessionId, null, n);
                    if (!updated) return;
                    emit(EVT_GOAL_UPDATED, {
                        goal: updated,
                        previous_status: goal.status,
                    });
                    refreshStatus(ctx, updated);
                    if (ctx.hasUI) {
                        ctx.ui.notify(`Goal budget set to ${n} tokens.`, "info");
                    }
                    return;
                }
                case "complete": {
                    const goal = dbi.getGoal(sessionId);
                    if (!goal) {
                        if (ctx.hasUI) ctx.ui.notify("No active goal.", "info");
                        return;
                    }
                    if (!canTransition(goal.status, "complete", "user")) {
                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                `Cannot complete goal in status ${goal.status}.`,
                                "warning",
                            );
                        }
                        return;
                    }
                    const previousStatus = goal.status;
                    const updated = dbi.updateStatus(sessionId, null, "complete");
                    if (!updated) return;
                    emit(EVT_GOAL_UPDATED, {
                        goal: updated,
                        previous_status: previousStatus,
                    });
                    refreshStatus(ctx, updated);
                    if (ctx.hasUI) {
                        ctx.ui.notify("Goal marked complete.", "info");
                    }
                    return;
                }
                case "clear": {
                    const goal = dbi.getGoal(sessionId);
                    if (!goal) {
                        if (ctx.hasUI) ctx.ui.notify("No active goal.", "info");
                        return;
                    }
                    dbi.deleteGoal(sessionId);
                    emit(EVT_GOAL_CLEARED, {
                        session_id: sessionId,
                        goal_id: goal.goal_id,
                    });
                    refreshStatus(ctx, null);
                    if (ctx.hasUI) ctx.ui.notify("Goal cleared.", "info");
                    return;
                }
                default: {
                    if (ctx.hasUI) {
                        ctx.ui.notify(
                            `Unknown subcommand: ${sub}. Try /goal create|status|pause|resume|edit|budget|complete|clear.`,
                            "error",
                        );
                    }
                    return;
                }
            }
        },
    });

    // Cleanly close DB on shutdown so SQLite flushes.
    pi.on("session_shutdown", async () => {
        if (db) {
            try {
                db.close();
            } catch {}
            db = null;
        }
    });
}
