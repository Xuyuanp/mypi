/**
 * Integration tests for the goals extension.
 *
 * Drives the extension end-to-end via a faux model. Shared infrastructure
 * (faux provider, resource loader, settings, auth) is created once in
 * beforeAll. Each test only creates a fresh session + SessionManager.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    registerFauxProvider,
} from "@earendil-works/pi-ai";
import {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import goalsExtension from "../extensions/goals/index.js";
import type { GoalEntryData } from "../extensions/goals/store.js";
import { GOAL_ENTRY_TYPE, type SessionGoal } from "../extensions/goals/types.js";

// ── Event-loop flush ──────────────────────────────────────────────────

/**
 * Flush the event loop by yielding to setImmediate multiple times.
 * The goals extension schedules continuations via setImmediate, and each
 * continuation completes within a single event-loop tick (faux provider
 * responds synchronously). Flushing N ticks processes up to N continuations.
 */
async function flush(ticks = 5): Promise<void> {
    for (let i = 0; i < ticks; i++) {
        await new Promise<void>((r) => setImmediate(r));
    }
}

// ── Helpers for reading and pre-staging session entries ──────────────

function getGoalFromSession(sm: SessionManager): SessionGoal | null {
    const branch = sm.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "custom" && entry.customType === GOAL_ENTRY_TYPE) {
            const data = entry.data as GoalEntryData;
            return data.kind === "cleared" ? null : data.goal;
        }
    }
    return null;
}

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
    const now = Math.floor(Date.now() / 1000);
    return {
        objective: "test",
        status: "active",
        token_budget: null,
        tokens_used: 0,
        time_used_seconds: 0,
        iters_used: 0,
        created_at: now,
        updated_at: now,
        ...overrides,
    };
}

function stageGoal(sm: SessionManager, sessionId: string, goal: SessionGoal): void {
    sm.newSession({ id: sessionId });
    sm.appendCustomEntry(GOAL_ENTRY_TYPE, {
        kind: "snapshot",
        goal,
    } satisfies GoalEntryData);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("goals extension", () => {
    // Shared infrastructure — created once, reused across all 32 tests.
    let faux: FauxProviderRegistration;
    let cwd: string;
    let settingsManager: SettingsManager;
    let authStorage: AuthStorage;
    let modelRegistry: ModelRegistry;

    beforeAll(async () => {
        cwd = await mkdtemp(join(tmpdir(), "goals-test-"));
        faux = registerFauxProvider();
        const model = faux.getModel()!;
        authStorage = AuthStorage.inMemory();
        authStorage.setRuntimeApiKey(model.provider, "fake-key");
        modelRegistry = ModelRegistry.inMemory(authStorage);
        settingsManager = SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
        });
    });

    afterAll(async () => {
        faux.unregister();
        await rm(cwd, { recursive: true, force: true });
    });

    // ── Per-test session factory ─────────────────────────────────────

    async function makeSession(sm?: SessionManager) {
        const sessionManager = sm ?? SessionManager.inMemory(cwd);
        // ResourceLoader must be fresh per session: createAgentSession
        // binds extension instances to it and they are not reusable.
        const rl = new DefaultResourceLoader({
            cwd,
            agentDir: join(cwd, ".pi-test-agent"),
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [goalsExtension],
            systemPromptOverride: () => "test",
        });
        await rl.reload();
        const { session } = await createAgentSession({
            cwd,
            agentDir: join(cwd, ".pi-test-agent"),
            model: faux.getModel()!,
            thinkingLevel: "off",
            resourceLoader: rl,
            sessionManager,
            settingsManager,
            authStorage,
            modelRegistry,
        });
        await session.bindExtensions({});
        return { session, sessionManager };
    }

    /**
     * Boot session, send prompt, wait for continuation loop to settle,
     * then dispose. Returns run counts and the SessionManager for assertions.
     */
    async function run(prompt: string, sm?: SessionManager) {
        const { session, sessionManager } = await makeSession(sm);
        let agentRuns = 0;
        let stopped = false;
        session.subscribe((event) => {
            if (event.type === "agent_start") agentRuns++;
            if (agentRuns >= 20 && !stopped) {
                stopped = true;
                session.abort();
            }
        });
        await session.prompt(prompt);
        await flush();
        session.dispose();
        return {
            agentRuns,
            autonomousRuns: Math.max(0, agentRuns - 1),
            sessionManager,
        };
    }

    // ── Tool-based goal lifecycle ─────────────────────────────────────

    it("test_create_goal_tool: model creates goal and marks complete", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "Test objective" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await run("make a goal");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.objective).toBe("Test objective");
    });

    it("test_create_goal_tool_fails_if_exists: model gets error, not replacement", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "First objective" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "Second objective" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await run("make a goal");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.objective).toBe("First objective");
        expect(goal!.status).toBe("complete");
    });

    it("test_update_goal_complete_tool: marks complete, continuation stops", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("create_goal", { objective: "obj" }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const result = await run("go");
        expect(result.autonomousRuns).toBeLessThanOrEqual(2);

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("complete");
    });

    it("test_continuation_fires_after_turn: at least one autonomous run occurs", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("create_goal", { objective: "obj" }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxText("acked")),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await run("go");
        expect(result.autonomousRuns).toBeGreaterThanOrEqual(1);
        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("complete");
        expect(goal!.iters_used).toBeGreaterThanOrEqual(1);
    });

    it("test_completion_report_returned: budgeted goal yields completion report", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", {
                    objective: "obj",
                    token_budget: 1_000_000,
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await run("go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("complete");
        expect(goal!.token_budget).toBe(1_000_000);
    });

    it("test_budget_limit_stops_continuation: tiny budget transitions to budget_limited", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", {
                    objective: "tiny budget",
                    token_budget: 1,
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("wrapping up")),
            fauxAssistantMessage(fauxText("done")),
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const result = await run("go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("budget_limited");
        expect(goal!.tokens_used).toBeGreaterThan(0);
    });

    it("test_empty_progress_pauses: 3 consecutive empty autonomous runs pause the goal", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "explore" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("thinking 1")),
            fauxAssistantMessage(fauxText("thinking 2")),
            fauxAssistantMessage(fauxText("thinking 3")),
            fauxAssistantMessage(fauxText("should not run")),
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const result = await run("go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("paused");
    });

    it("test_abort_pauses_goal: aborted run pauses an active goal", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "abort me" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("interrupted"), {
                stopReason: "aborted",
            }),
            fauxAssistantMessage(fauxText("never")),
        ]);
        const result = await run("go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("paused");
    });

    it("test_error_pauses_goal: error stopReason pauses an active goal", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "error me" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("provider died"), {
                stopReason: "error",
                errorMessage: "boom",
            }),
            fauxAssistantMessage(fauxText("never")),
        ]);
        const result = await run("go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("paused");
    });

    it("test_no_goal_no_continuation: empty session does not auto-continue", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("ok, ready"))]);
        const result = await run("hi");
        expect(result.agentRuns).toBe(1);
        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    // ── Startup behavior with pre-staged goals ────────────────────────

    it("test_stale_goal_detection: stale active goal is paused on session_start", async () => {
        const sm = SessionManager.inMemory(cwd);
        stageGoal(
            sm,
            "stale-goal-session",
            makeGoal({
                objective: "ancient",
                updated_at: Math.floor(Date.now() / 1000) - 2 * 86400,
                created_at: Math.floor(Date.now() / 1000) - 2 * 86400,
            }),
        );

        faux.setResponses([fauxAssistantMessage(fauxText("should not run"))]);
        const { session } = await makeSession(sm);
        await flush();
        const sentinelConsumed = faux.getPendingResponseCount() === 0;
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("paused");
        expect(sentinelConsumed).toBe(false);
    });

    it("test_startup_enforces_iter_cap: pre-staged active goal at MAX iters transitions to budget_limited", async () => {
        const sm = SessionManager.inMemory(cwd);
        stageGoal(
            sm,
            "known-session-aaaa-bbbb-cccc-dddd",
            makeGoal({ objective: "already at cap", iters_used: 100 }),
        );
        faux.setResponses([fauxAssistantMessage(fauxText("should not run"))]);
        const { session } = await makeSession(sm);
        await flush();
        const sentinelConsumed = faux.getPendingResponseCount() === 0;
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.status).not.toBe("active");
        expect(sentinelConsumed).toBe(false);
    });

    it("test_startup_enforces_budget: pre-staged active goal already over budget transitions to budget_limited", async () => {
        const sm = SessionManager.inMemory(cwd);
        stageGoal(
            sm,
            "known-session-budget-overrun",
            makeGoal({
                objective: "already over budget",
                token_budget: 100,
                tokens_used: 500,
            }),
        );
        faux.setResponses([fauxAssistantMessage(fauxText("should not run"))]);
        const { session } = await makeSession(sm);
        await flush();
        const sentinelConsumed = faux.getPendingResponseCount() === 0;
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal!.status).not.toBe("active");
        expect(sentinelConsumed).toBe(false);
    });

    it("test_exact_iter_cap_transitions_to_budget_limited: incrementing to MAX_AUTONOMOUS_ITERS does not leave goal active", async () => {
        const sm = SessionManager.inMemory(cwd);
        stageGoal(
            sm,
            "exact-turn-cap-session",
            makeGoal({ objective: "long running", iters_used: 99 }),
        );
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("get_goal", {}), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxText("proceeding")),
            fauxAssistantMessage(fauxText("wrapping up")),
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const { session } = await makeSession(sm);
        await flush();
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.iters_used).toBe(100);
        expect(goal!.status).toBe("budget_limited");
    });

    it("test_startup_completion_run_counts_iter: first autonomous run from session_start increments iters_used even if it completes the goal", async () => {
        const sm = SessionManager.inMemory(cwd);
        stageGoal(
            sm,
            "startup-complete-turn-count",
            makeGoal({ objective: "complete me on resume", iters_used: 5 }),
        );
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const { session } = await makeSession(sm);
        await flush();
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("complete");
        expect(goal!.iters_used).toBe(6);
    });

    // ── Command-based tests ───────────────────────────────────────────

    it("test_goal_create_command: /goal <objective> sets up the goal", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await run("/goal Refactor auth --budget 5000");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.objective).toBe("Refactor auth");
        expect(goal!.token_budget).toBe(5000);
    });

    it("test_goal_status_command: /goal status returns without mutating state", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await run("/goal status");
        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_goal_pause_and_resume_commands: pause then resume cycles status", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxText("ack")),
            fauxAssistantMessage(fauxText("ack")),
            fauxAssistantMessage(fauxText("ack")),
        ]);
        const result = await run("/goal Pausable");
        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(["active", "paused"]).toContain(goal!.status);
    });

    it("test_goal_complete_command: /goal complete marks the goal complete", async () => {
        const { session, sessionManager } = await makeSession();
        faux.setResponses([
            fauxAssistantMessage(fauxText("ack 1")),
            fauxAssistantMessage(fauxText("ack 2")),
            fauxAssistantMessage(fauxText("ack 3")),
            fauxAssistantMessage(fauxText("ack 4")),
        ]);
        await session.prompt("/goal FromCommand");
        await flush();
        await session.prompt("/goal complete");
        await flush();
        session.dispose();

        const goal = getGoalFromSession(sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("complete");
    });

    it("test_length_stop_reason_does_not_continue: non-stop stopReason pauses goal", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "keep going" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("acked")),
            fauxAssistantMessage(fauxText("truncated..."), {
                stopReason: "length",
            }),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("would-be-completed")),
        ]);
        const result = await run("go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("paused");
    });

    // ── Token accounting ──────────────────────────────────────────────

    it("test_completion_run_tokens_accounted: tokens spent in the run that completes the goal are recorded", async () => {
        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", {
                    objective: "complete-me",
                    token_budget: 1_000_000,
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await run("go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("complete");
        expect(goal!.tokens_used).toBeGreaterThan(0);
    });

    it("test_paused_goal_no_token_accumulation: runs after completion do not increment tokens_used", async () => {
        const { session, sessionManager } = await makeSession();

        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", {
                    objective: "paused-test",
                    token_budget: 1_000_000,
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        await session.prompt("create and complete goal");
        await flush();

        let goal = getGoalFromSession(sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("complete");
        const tokensAfterComplete = goal!.tokens_used;
        expect(tokensAfterComplete).toBeGreaterThan(0);

        faux.setResponses([fauxAssistantMessage(fauxText("just chatting"))]);
        await session.prompt("how is the weather?");
        await flush();

        goal = getGoalFromSession(sessionManager);
        session.dispose();
        expect(goal!.tokens_used).toBe(tokensAfterComplete);
    });

    // ── Validation ────────────────────────────────────────────────────

    it("test_empty_objective_rejected: create_goal with empty string returns error", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall("create_goal", { objective: "" }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await run("go");
        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_command_create_overlong_objective_rejected: /goal with >4000 chars rejected", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await run(`/goal ${"x".repeat(4001)}`);
        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_command_edit_overlong_objective_rejected: /goal edit with >4000 chars rejected", async () => {
        const { session, sessionManager } = await makeSession();

        faux.setResponses([
            fauxAssistantMessage(fauxText("ack")),
            fauxAssistantMessage(fauxText("ack")),
            fauxAssistantMessage(fauxText("ack")),
        ]);
        await session.prompt("/goal Valid objective");
        await flush();

        const before = getGoalFromSession(sessionManager);
        expect(before).not.toBeNull();
        expect(before!.objective).toBe("Valid objective");

        faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        await session.prompt(`/goal edit ${"y".repeat(4001)}`);
        await flush();
        session.dispose();

        const after = getGoalFromSession(sessionManager);
        expect(after).not.toBeNull();
        expect(after!.objective).toBe("Valid objective");
    });

    it("test_budget_negative_rejected: /goal with --budget -5 returns error, no goal created", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await run("/goal task --budget -5");
        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_budget_trailing_chars_rejected: /goal with --budget 10abc returns error, no goal created", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await run("/goal task --budget 10abc");
        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_budget_zero_rejected: /goal with --budget 0 returns error, no goal created", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await run("/goal task --budget 0");
        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    // ── Resume behavior ───────────────────────────────────────────────

    it("test_resume_command_resets_empty_progress: /goal resume clears stale emptyProgressCount", async () => {
        const sm = SessionManager.inMemory(cwd);
        sm.newSession({ id: "resume-empty-progress-session" });

        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "explore" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("acked")),
            fauxAssistantMessage(fauxText("thinking 1")),
            fauxAssistantMessage(fauxText("thinking 2")),
        ]);

        const { session } = await makeSession(sm);
        await session.prompt("go");
        await flush();

        let goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("paused");

        faux.setResponses([
            fauxAssistantMessage(fauxText("resumed thinking")),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        await session.prompt("/goal resume");
        await flush();

        goal = getGoalFromSession(sm);
        session.dispose();
        expect(goal!.status).toBe("complete");
    });

    it("test_resume_at_budget_cap_does_not_leave_goal_active: /goal resume without raising budget keeps goal budget_limited", async () => {
        const sm = SessionManager.inMemory(cwd);
        stageGoal(
            sm,
            "resume-at-cap-session",
            makeGoal({
                objective: "do stuff",
                token_budget: 100,
                tokens_used: 150,
                status: "budget_limited",
            }),
        );

        faux.setResponses([fauxAssistantMessage(fauxText("should not run"))]);
        const { session } = await makeSession(sm);
        await session.prompt("/goal resume");
        await flush();

        const sentinelConsumed = faux.getPendingResponseCount() === 0;
        const goal = getGoalFromSession(sm);
        session.dispose();

        expect(goal).not.toBeNull();
        expect(goal!.status).not.toBe("active");
        expect(sentinelConsumed).toBe(false);
    });

    it("test_resume_at_iter_cap_does_not_leave_goal_active: /goal resume without raising iteration cap keeps goal budget_limited", async () => {
        const sm = SessionManager.inMemory(cwd);
        stageGoal(
            sm,
            "resume-at-turn-cap-session",
            makeGoal({
                objective: "do stuff",
                iters_used: 100,
                status: "budget_limited",
            }),
        );

        faux.setResponses([fauxAssistantMessage(fauxText("should not run"))]);
        const { session } = await makeSession(sm);
        await session.prompt("/goal resume");
        await flush();

        const sentinelConsumed = faux.getPendingResponseCount() === 0;
        const goal = getGoalFromSession(sm);
        session.dispose();

        expect(goal).not.toBeNull();
        expect(goal!.status).not.toBe("active");
        expect(sentinelConsumed).toBe(false);
    });

    // ── Session tree navigation ───────────────────────────────────────

    it("test_session_tree_reconstructs: branch navigation rehydrates store from new branch", async () => {
        const sm = SessionManager.inMemory(cwd);
        const { session } = await makeSession(sm);

        faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", {
                    objective: "branch-A objective",
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        await session.prompt("create branch A goal");
        await flush();

        const goalA = getGoalFromSession(sm);
        expect(goalA).not.toBeNull();
        expect(goalA!.objective).toBe("branch-A objective");
        expect(goalA!.status).toBe("complete");

        faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
        await session.prompt("/goal clear");
        await flush();

        const cleared = getGoalFromSession(sm);
        expect(cleared).toBeNull();
        session.dispose();
    });
});
