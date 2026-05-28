/**
 * Goals Extension
 *
 * Persists a single budget-tracked objective per session and autonomously
 * continues across turn boundaries until the goal is achieved, the budget is
 * exhausted, or the user intervenes.
 *
 * State is stored in session entries via `pi.appendEntry`, so it is branch-
 * aware and travels with session forks. See `store.ts`.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
    AgentEndEvent,
    ExtensionAPI,
    ExtensionContext,
    TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    renderBudgetLimitPrompt,
    renderCompletionReport,
    renderContinuationPrompt,
    renderObjectiveUpdatedPrompt,
} from "./prompts.js";
import {
    canTransition,
    type TransitionActor,
    validateModelTransition,
} from "./state-machine.js";
import { createGoalStore, type GoalStore } from "./store.js";
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

/**
 * Pure helper for the empty-progress counter step inside agent_end.
 *
 * - User-initiated runs always reset the counter: a fresh user turn is by
 *   definition progress, regardless of whether the assistant happened to
 *   call a tool. Otherwise a text-only user reply would leave a stale
 *   autonomous count intact and prematurely auto-pause on the next empty
 *   run.
 * - Autonomous runs reset on tool calls (real progress) and increment
 *   when the assistant produced text only.
 *
 * Exported for unit testing; called from agent_end.
 */
export function nextEmptyProgressCount(
    current: number,
    wasAutonomous: boolean,
    currentRunHadToolCalls: boolean,
): number {
    if (!wasAutonomous) return 0;
    if (currentRunHadToolCalls) return 0;
    return current + 1;
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

    /**
     * Lifecycle flags for cooperative bail-out inside setImmediate
     * callbacks. AGENTS.md forbids broad try/catch around stale ctx; we
     * use lifecycle-driven flags instead.
     *
     *  - sessionActive: cleared on session_shutdown.
     *  - scheduleGeneration: bumped on session_start AND session_tree.
     *    Each setImmediate captures the generation at schedule time and
     *    bails when it changes (covers the reload race where the same
     *    closure sees shutdown+session_start, plus branch navigation).
     */
    let sessionActive = true;
    let scheduleGeneration = 0;

    // ── Store ────────────────────────────────────────────────────────
    // Declared after the lifecycle flags so the store can read them via
    // an injected predicate. Persistence is skipped when the session is
    // inactive, replacing the previous try/catch around pi.appendEntry.

    const store: GoalStore = createGoalStore(pi, {
        isSessionActive: () => sessionActive,
    });

    // ── Helpers that need ctx ─────────────────────────────────────────

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
     * Defer `body` to the next tick, gated by the lifecycle flags and
     * the idle/pending-messages guards that every continuation needs.
     *
     * Cooperative bail-out per AGENTS.md: lifecycle flags express
     * intent; all checks are pure local-state reads with no ctx access
     * before they pass. `sessionActive` covers shutdown-without-restart;
     * the generation counter covers reload (session_shutdown +
     * session_start in the same closure) and /tree branch navigation.
     */
    function scheduleSafeImmediate(ctx: ExtensionContext, body: () => void): void {
        const myGeneration = scheduleGeneration;
        setImmediate(() => {
            if (!sessionActive) return;
            if (myGeneration !== scheduleGeneration) return;
            if (!ctx.isIdle()) return;
            if (ctx.hasPendingMessages()) return;
            body();
        });
    }

    /**
     * Schedule the next autonomous continuation.
     *
     * Must be deferred via setImmediate: agent_end fires while the agent's
     * activeRun is still set; calling agent.prompt() synchronously throws.
     * setImmediate runs after the current run's lifecycle has cleared.
     */
    function scheduleContinuation(ctx: ExtensionContext): void {
        scheduleSafeImmediate(ctx, () => {
            // Re-check goal state & guardrails before firing. State may
            // have changed under us during the setImmediate delay
            // (concurrent mutation, command, etc.); never start a run
            // that would violate the turn cap or budget.
            const current = store.getGoal();
            if (!current || current.status !== "active") return;
            if (current.turns_used >= MAX_AUTONOMOUS_TURNS) return;
            if (
                current.token_budget !== null &&
                current.tokens_used >= current.token_budget
            ) {
                return;
            }
            isAutonomousContinuation = true;
            emit(EVT_GOAL_CONTINUATION, {
                turn_number: current.turns_used,
            });
            // Render the prompt from the freshly-read goal (current),
            // not a stale capture: between scheduling and execution,
            // objective or budget may have been updated by another
            // command.
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
        });
    }

    function pauseGoal(
        ctx: ExtensionContext,
        actor: TransitionActor,
        reason: string,
    ): SessionGoal | null {
        const goal = store.getGoal();
        if (!goal) return null;
        if (!canTransition(goal.status, "paused", actor)) return goal;
        const previousStatus = goal.status;
        const updated = store.updateStatus("paused");
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
        goal: SessionGoal,
        isTurnCap: boolean,
    ): void {
        const previousStatus = goal.status;
        const updated = store.updateStatus("budget_limited");
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
        // Send wrap-up steering prompt as a one-shot turn. Same lifecycle
        // bail-out as scheduleContinuation via the shared helper.
        scheduleSafeImmediate(ctx, () => {
            try {
                pi.sendMessage(
                    {
                        customType: BUDGET_LIMIT_MESSAGE_TYPE,
                        content: wrapUp,
                        display: false,
                    },
                    { triggerTurn: true },
                );
            } catch {
                // sendMessage failure is best-effort: goal is already
                // budget_limited, the wrap-up prompt is non-essential.
            }
        });
    }

    /**
     * Reset all per-run and per-loop bookkeeping. Called from
     * session_start and session_tree -- both indicate the previous
     * branch's logical loop is no longer the active loop.
     */
    function resetLoopState(): void {
        // Per-run flags (set in agent_start, consumed in agent_end).
        isAutonomousContinuation = false;
        currentRunHadToolCalls = false;
        currentRunTokens = 0;
        budgetExceededDuringRun = false;
        goalActiveAtRunStart = false;
        // Per-loop flags (accumulated across multiple autonomous runs in
        // the same branch's continuation loop).
        emptyProgressCount = 0;
        usageUnavailableWarned = false;
    }

    // ── Event: session_shutdown ─────────────────────────────────────

    pi.on("session_shutdown", async () => {
        // Cooperative bail-out flag for any in-flight setImmediate.
        sessionActive = false;
    });

    // ── Event: session_start ─────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        sessionActive = true;
        scheduleGeneration++;
        resetLoopState();

        store.reconstruct(ctx);
        const goal = store.getGoal();
        if (!goal) {
            refreshStatus(ctx, null);
            return;
        }

        if (goal.status === "active") {
            const ageSeconds = Math.floor(Date.now() / 1000) - goal.updated_at;
            if (ageSeconds > STALE_GOAL_SECONDS) {
                const updated = store.updateStatus("paused");
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
                const updated = store.updateStatus("budget_limited");
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
            scheduleContinuation(ctx);
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

    // ── Event: session_tree ─────────────────────────────────────────

    pi.on("session_tree", async (_event, ctx) => {
        // Bump first so any in-flight setImmediate from the previous
        // branch bails on its generation check before touching ctx.
        scheduleGeneration++;
        resetLoopState();
        store.reconstruct(ctx);
        refreshStatus(ctx, store.getGoal());
        // Intentionally do NOT auto-schedule a continuation, and do NOT
        // apply session_start's stale/over-budget transition logic.
        // Branch navigation is exploratory; the user resumes via
        // /goal resume, and persisting status mutations on every /tree
        // would dirty every branch the user visits.
    });

    // ── Event: agent_start ──────────────────────────────────────────

    pi.on("agent_start", async (_event, _ctx) => {
        currentRunHadToolCalls = false;
        currentRunTokens = 0;
        budgetExceededDuringRun = false;
        runStartTimestamp = Date.now();

        // Snapshot goal status at run start so accounting is scoped to
        // runs that began while the goal was active (plus the
        // active-to-complete/paused transition run).
        goalActiveAtRunStart = false;
        const goal = store.getGoal();
        if (goal && goal.status === "active") {
            goalActiveAtRunStart = true;
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
        const goal = store.getGoal();
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
        const wasAutonomous = isAutonomousContinuation;
        isAutonomousContinuation = false;
        if (!store.getGoal()) {
            return;
        }

        // [1] Flush token / time accounting. Only if the goal was active
        // when this run started. Covers the transitioning run (active at
        // start, flipped to complete/paused mid-run by update_goal); skips
        // unrelated runs that start while the goal is already in a
        // terminal state.
        if (goalActiveAtRunStart) {
            const elapsed = Math.max(
                0,
                Math.floor((Date.now() - runStartTimestamp) / 1000),
            );
            const hadAccounting = currentRunTokens > 0 || elapsed > 0;
            if (hadAccounting) {
                store.accountTokens(currentRunTokens, elapsed);
            }

            // [1b] For autonomous runs where the goal was active at run
            // start but transitioned away during the run (e.g., model
            // called update_goal(complete)), still count the turn.
            // Without this, the final autonomous run is undercounted in
            // turns_used.
            const transitionedAway =
                wasAutonomous && store.getGoal()!.status !== "active";
            if (transitionedAway) {
                store.incrementTurns();
            }

            // Early-return paths follow; flush accounting first.
            if (hadAccounting || transitionedAway) {
                store.persist();
            }
        }
        currentRunTokens = 0;

        // Capture once after accounting; mutations below re-read.
        const goalAfterAccounting = store.getGoal();
        if (!goalAfterAccounting) return;

        // After accounting, the rest of the loop logic only applies to
        // active goals.
        if (goalAfterAccounting.status !== "active") {
            return;
        }
        let goal = goalAfterAccounting;

        // [2] Update empty-progress counter for this run.
        emptyProgressCount = nextEmptyProgressCount(
            emptyProgressCount,
            wasAutonomous,
            currentRunHadToolCalls,
        );

        const stopReason = lastAssistantStopReason(event.messages);

        // [3] Aborted: pause and stop.
        if (stopReason === "aborted") {
            pauseGoal(
                ctx,
                "system",
                "Goal paused -- interrupted. Resume with /goal resume.",
            );
            return;
        }

        // [4] Error: pause and stop.
        if (stopReason === "error") {
            pauseGoal(
                ctx,
                "system",
                "Goal paused due to error. Resume with /goal resume.",
            );
            return;
        }

        // [4b] Continuation requires stopReason === "stop" (spec section
        // 8.1.3). Any other value -- including `undefined` (no assistant
        // message was produced) -- indicates an unhealthy run. For
        // autonomous runs, pause the goal to break the loop. For user-
        // initiated runs, just skip continuation scheduling without
        // pausing (the user can re-engage).
        if (stopReason !== "stop") {
            if (wasAutonomous) {
                pauseGoal(
                    ctx,
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
                "system",
                `Goal paused: no progress detected after ${EMPTY_PROGRESS_LIMIT} turns.`,
            );
            return;
        }

        // [6] Budget hit: transition to budget_limited and inject wrap-up.
        const budgetHit =
            budgetExceededDuringRun ||
            (goal.token_budget !== null && goal.tokens_used >= goal.token_budget);
        const turnCapHit = goal.turns_used >= MAX_AUTONOMOUS_TURNS;
        if (budgetHit || turnCapHit) {
            transitionToBudgetLimited(ctx, goal, turnCapHit);
            return;
        }

        // [7] Pending user input: skip continuation, let it run as its own turn.
        if (ctx.hasPendingMessages()) return;

        // [8] All conditions pass: increment turn counter and continue.
        store.incrementTurns();
        store.persist();
        goal = store.getGoal()!;
        refreshStatus(ctx, goal);

        // [8b] Post-increment cap check: incrementTurns may have pushed
        // turns_used to exactly MAX_AUTONOMOUS_TURNS. If so, transition to
        // budget_limited with wrap-up rather than calling
        // scheduleContinuation (which would silently block without
        // transitioning).
        const postIncrementCapHit = goal.turns_used >= MAX_AUTONOMOUS_TURNS;
        const postIncrementBudgetHit =
            goal.token_budget !== null && goal.tokens_used >= goal.token_budget;
        if (postIncrementCapHit || postIncrementBudgetHit) {
            transitionToBudgetLimited(ctx, goal, postIncrementCapHit);
            return;
        }
        scheduleContinuation(ctx);
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
            const created = store.createGoal(
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
        async execute(_id, _params, _signal, _onUpdate, _ctx) {
            const goal = store.getGoal();
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
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            const goal = store.getGoal();
            if (!goal) {
                return toolErrorResult("No active goal to update.");
            }
            const validation = validateModelTransition(goal.status, "complete");
            if (!validation.valid) {
                return toolErrorResult(validation.error ?? "Invalid transition.");
            }
            const previousStatus = goal.status;
            const updated = store.updateStatus("complete");
            if (!updated) {
                return toolErrorResult("Failed to update goal.");
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
            "Manage the session goal: /goal status|pause|resume|edit|budget|complete|clear or /goal <objective> to create",
        handler: async (args, ctx) => {
            const { sub, rest } = parseCommand(args);

            switch (sub) {
                case "":
                case "status": {
                    const goal = store.getGoal();
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

                case "pause": {
                    const goal = store.getGoal();
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
                    const updated = store.updateStatus("paused");
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
                    const goal = store.getGoal();
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
                    const updated = store.updateStatus("active");
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
                    scheduleContinuation(ctx);
                    return;
                }
                case "edit": {
                    const goal = store.getGoal();
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
                    const updated = store.updateObjective(trimmedObjective);
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
                    // an objective-updated steering prompt as a hidden
                    // message.
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
                                    "Warning: objective updated but steering prompt could not be delivered to the model.",
                                    "warning",
                                );
                            }
                        }
                    }
                    return;
                }
                case "budget": {
                    const goal = store.getGoal();
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
                    const updated = store.updateBudget(n);
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
                    const goal = store.getGoal();
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
                    const updated = store.updateStatus("complete");
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
                    const goal = store.getGoal();
                    if (!goal) {
                        if (ctx.hasUI) ctx.ui.notify("No active goal.", "info");
                        return;
                    }
                    store.deleteGoal();
                    emit(EVT_GOAL_CLEARED, {});
                    refreshStatus(ctx, null);
                    if (ctx.hasUI) ctx.ui.notify("Goal cleared.", "info");
                    return;
                }
                default: {
                    // No known subcommand matched; treat entire args as
                    // a goal creation request.
                    const rawObjective = args.trim();
                    const { objective, budget, error } =
                        parseObjectiveAndBudget(rawObjective);
                    if (error) {
                        if (ctx.hasUI) ctx.ui.notify(error, "error");
                        return;
                    }
                    if (!objective) {
                        if (ctx.hasUI) {
                            ctx.ui.notify(
                                "Usage: /goal <objective> [--budget <n>]",
                                "error",
                            );
                        }
                        return;
                    }
                    const created = store.createGoal(objective, budget, true);
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
                    scheduleContinuation(ctx);
                    return;
                }
            }
        },
    });
}
