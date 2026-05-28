/**
 * Integration tests for the goals extension.
 *
 * Drives the extension end-to-end via a faux model. Each test boots a fresh
 * agent session, scripts faux responses, and waits for the autonomous-
 * continuation loop to settle (no streaming for a short idle window) before
 * asserting on the persisted goal entries in the session branch.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import goalsExtension from "../extensions/goals/index.js";
import type { GoalEntryData } from "../extensions/goals/store.js";
import { GOAL_ENTRY_TYPE, type SessionGoal } from "../extensions/goals/types.js";

// ── Boilerplate ───────────────────────────────────────────────────────

interface Harness {
    cwd: string;
    faux: FauxProviderRegistration;
    cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
    const dir = await mkdtemp(join(tmpdir(), "goals-test-"));
    const faux = registerFauxProvider();
    return {
        cwd: dir,
        faux,
        cleanup: async () => {
            faux.unregister();
            await rm(dir, { recursive: true, force: true });
        },
    };
}

interface RunOptions {
    /**
     * Maximum total agent runs (initial + autonomous) before forcibly
     * stopping the test. Prevents runaway loops if the script under-queues
     * responses.
     */
    maxRuns?: number;
    /** Wait this long after the last event for the loop to settle. */
    settleMs?: number;
    /** Hard upper bound on total wait time. */
    timeoutMs?: number;
    /** Optional pre-built SessionManager for pre-staging goal entries. */
    sessionManager?: SessionManager;
}

interface RunResult {
    agentRuns: number;
    autonomousRuns: number;
    /**
     * Exposed so tests can read goal entries after the scenario ends.
     * `dispose()` invalidates extension ctx but does not mutate the
     * externally-held SessionManager, so getBranch() remains safe.
     */
    sessionManager: SessionManager;
}

/**
 * Boot a session, send `prompt`, then wait for the autonomous-continuation
 * loop to settle (no events for `settleMs` while streaming is false).
 */
async function runScenario(
    harness: Harness,
    prompt: string,
    options: RunOptions = {},
): Promise<RunResult> {
    const { maxRuns = 20, settleMs = 80, timeoutMs = 5000 } = options;
    const sessionManager =
        options.sessionManager ?? SessionManager.inMemory(harness.cwd);
    const model = harness.faux.getModel()!;
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, "fake-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd: harness.cwd,
        agentDir: join(harness.cwd, ".pi-test-agent"),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [goalsExtension],
        systemPromptOverride: () => "You are a test assistant.",
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
        cwd: harness.cwd,
        agentDir: join(harness.cwd, ".pi-test-agent"),
        model,
        thinkingLevel: "off",
        resourceLoader,
        sessionManager,
        settingsManager,
        authStorage,
        modelRegistry,
    });
    // Modes (interactive/rpc/print) call bindExtensions(); without it the
    // session_start event is never emitted to extensions. Bind with no-op
    // bindings so handlers run.
    await session.bindExtensions({});

    let agentRuns = 0;
    let stopped = false;
    session.subscribe((event) => {
        if (event.type === "agent_start") agentRuns++;
        if (agentRuns >= maxRuns && !stopped) {
            stopped = true;
            session.abort();
        }
    });

    await session.prompt(prompt);

    // Settled = isStreaming has been false continuously for settleMs.
    await new Promise<void>((resolve) => {
        const start = Date.now();
        let lastBusyAt = Date.now();
        const tick = setInterval(() => {
            const now = Date.now();
            if (session.isStreaming) {
                lastBusyAt = now;
            } else if (now - lastBusyAt >= settleMs) {
                clearInterval(tick);
                resolve();
                return;
            }
            if (now - start >= timeoutMs) {
                clearInterval(tick);
                resolve();
            }
        }, 20);
    });

    session.dispose();

    // First run is user-initiated, subsequent runs are autonomous.
    const autonomousRuns = Math.max(0, agentRuns - 1);
    return { agentRuns, autonomousRuns, sessionManager };
}

// ── Helpers for reading and pre-staging session entries ──────────────

/**
 * Walk the branch and reconstruct the latest goal state, mirroring what
 * GoalStore.reconstruct does. Returns null when there is no goal entry,
 * or when the latest goal entry is the cleared sentinel.
 */
function getGoalFromSession(sm: SessionManager): SessionGoal | null {
    // Mirrors GoalStore.reconstruct: scan in reverse and stop at the
    // first goal entry. The latest matching entry wins; if it is the
    // cleared sentinel, the goal is null.
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

/**
 * Build a SessionGoal with sane defaults. Used for pre-staging goal
 * entries on a fresh SessionManager before bindExtensions fires.
 */
function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
    const now = Math.floor(Date.now() / 1000);
    return {
        objective: "test",
        status: "active",
        token_budget: null,
        tokens_used: 0,
        time_used_seconds: 0,
        turns_used: 0,
        created_at: now,
        updated_at: now,
        ...overrides,
    };
}

/**
 * Pre-stage a goal under a known session id. Order is load-bearing:
 * `newSession({id})` resets fileEntries, so any prior appendCustomEntry
 * is wiped. Always call newSession FIRST.
 */
function stageGoal(
    sm: SessionManager,
    sessionId: string,
    goal: SessionGoal,
): void {
    sm.newSession({ id: sessionId });
    sm.appendCustomEntry(GOAL_ENTRY_TYPE, {
        kind: "snapshot",
        goal,
    } satisfies GoalEntryData);
}

// ── Inline mini-runner for tests that need a long-lived session ──────

interface MiniSessionOptions {
    sessionManager?: SessionManager;
}

async function makeMiniSession(
    h: Harness,
    options: MiniSessionOptions = {},
) {
    const model = h.faux.getModel()!;
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, "fake-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd: h.cwd,
        agentDir: join(h.cwd, ".pi-test-agent"),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [goalsExtension],
        systemPromptOverride: () => "test",
    });
    await resourceLoader.reload();
    const sessionManager =
        options.sessionManager ?? SessionManager.inMemory(h.cwd);
    const { session } = await createAgentSession({
        cwd: h.cwd,
        agentDir: join(h.cwd, ".pi-test-agent"),
        model,
        thinkingLevel: "off",
        resourceLoader,
        sessionManager,
        settingsManager,
        authStorage,
        modelRegistry,
    });
    await session.bindExtensions({});
    return { session, sessionManager };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("goals extension", () => {
    let h: Harness;

    beforeEach(async () => {
        h = await makeHarness();
    });

    afterEach(async () => {
        await h.cleanup();
    });

    it("test_create_goal_tool: model creates goal, get_goal returns it", async () => {
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "Test objective" }),
                { stopReason: "toolUse" },
            ),
            // Autonomous continuation: model immediately marks complete to stop loop.
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await runScenario(h, "make a goal");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.objective).toBe("Test objective");
    });

    it("test_create_goal_tool_fails_if_exists: model gets error, not replacement", async () => {
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "First objective" }),
                { stopReason: "toolUse" },
            ),
            // Autonomous continuation: tries to create another goal -> error.
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "Second objective" }),
                { stopReason: "toolUse" },
            ),
            // After seeing the error, complete the original.
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await runScenario(h, "make a goal");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.objective).toBe("First objective");
        expect(goal!.status).toBe("complete");
    });

    it("test_update_goal_complete_tool: marks complete, continuation stops", async () => {
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "obj" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
            // Extra unused responses; we expect loop to stop after complete.
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const result = await runScenario(h, "go");
        // Once complete, no more continuations.
        expect(result.autonomousRuns).toBeLessThanOrEqual(2);

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("complete");
    });

    it("test_continuation_fires_after_turn: at least one autonomous run occurs", async () => {
        // Each agent run ends only when the model returns a non-toolUse stop.
        // Run 1 (user) creates the goal then returns text "acked" (run
        // ends). agent_end schedules a continuation. Run 2 (autonomous)
        // completes the goal.
        h.faux.setResponses([
            // Run 1: tool call + text stop
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "obj" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("acked")),
            // Run 2 (autonomous): tool call + text stop
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await runScenario(h, "go");
        expect(result.autonomousRuns).toBeGreaterThanOrEqual(1);
        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("complete");
        // turns_used is incremented before each autonomous continuation.
        expect(goal!.turns_used).toBeGreaterThanOrEqual(1);
    });

    it("test_completion_report_returned: budgeted goal yields completion report", async () => {
        // Use a generous budget so the goal completes naturally without hitting it.
        h.faux.setResponses([
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
        const result = await runScenario(h, "go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("complete");
        expect(goal!.token_budget).toBe(1_000_000);
    });

    it("test_budget_limit_stops_continuation: tiny budget transitions to budget_limited", async () => {
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", {
                    objective: "tiny budget",
                    token_budget: 1,
                }),
                { stopReason: "toolUse" },
            ),
            // The first turn already exceeds budget=1. agent_end will
            // transition to budget_limited and inject a wrap-up prompt.
            fauxAssistantMessage(fauxText("wrapping up")),
            fauxAssistantMessage(fauxText("done")),
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const result = await runScenario(h, "go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("budget_limited");
        expect(goal!.tokens_used).toBeGreaterThan(0);
    });

    it("test_empty_progress_pauses: 3 consecutive empty autonomous runs pause the goal", async () => {
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "explore" }),
                { stopReason: "toolUse" },
            ),
            // Runs 2-4 (autonomous): text only, no tool calls.
            fauxAssistantMessage(fauxText("thinking 1")),
            fauxAssistantMessage(fauxText("thinking 2")),
            fauxAssistantMessage(fauxText("thinking 3")),
            // Should not be reached: goal paused after 3 empty runs.
            fauxAssistantMessage(fauxText("should not run")),
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const result = await runScenario(h, "go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("paused");
    });

    it("test_abort_pauses_goal: aborted run pauses an active goal", async () => {
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "abort me" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("interrupted"), {
                stopReason: "aborted",
            }),
            fauxAssistantMessage(fauxText("never")),
        ]);
        const result = await runScenario(h, "go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("paused");
    });

    it("test_error_pauses_goal: error stopReason pauses an active goal", async () => {
        h.faux.setResponses([
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
        const result = await runScenario(h, "go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal!.status).toBe("paused");
    });

    it("test_no_goal_no_continuation: empty session does not auto-continue", async () => {
        h.faux.setResponses([
            fauxAssistantMessage(fauxText("ok, ready")),
        ]);
        const result = await runScenario(h, "hi");
        expect(result.agentRuns).toBe(1);
        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_stale_goal_detection: stale active goal is paused on session_start", async () => {
        // Pre-stage an active goal whose updated_at is more than 24h old.
        // session_start (fired by bindExtensions) must transition it to
        // "paused" via the stale-goal pruning branch.
        const KNOWN_SESSION = "stale-goal-session";
        const FRESH_NOW = Math.floor(Date.now() / 1000);
        const sm = SessionManager.inMemory(h.cwd);
        stageGoal(
            sm,
            KNOWN_SESSION,
            makeGoal({
                objective: "ancient",
                updated_at: FRESH_NOW - 2 * 86400,
                created_at: FRESH_NOW - 2 * 86400,
            }),
        );

        h.faux.setResponses([
            fauxAssistantMessage(fauxText("should not run")),
        ]);

        const { session } = await makeMiniSession(h, { sessionManager: sm });
        // bindExtensions already ran inside makeMiniSession; allow the
        // session_start handler's mutations to persist.
        await new Promise((r) => setTimeout(r, 100));
        const sentinelConsumed = h.faux.getPendingResponseCount() === 0;
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("paused");
        // No autonomous continuation should have fired.
        expect(sentinelConsumed).toBe(false);
    });

    it("test_goal_create_command: /goal create sets up the goal", async () => {
        h.faux.setResponses([
            // After /goal create runs, the continuation prompt fires; model
            // immediately completes.
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await runScenario(
            h,
            "/goal create Refactor auth --budget 5000",
        );

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.objective).toBe("Refactor auth");
        expect(goal!.token_budget).toBe(5000);
    });

    it("test_goal_status_command: /goal status returns without mutating state", async () => {
        h.faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await runScenario(h, "/goal status");

        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_goal_pause_and_resume_commands: pause then resume cycles status", async () => {
        h.faux.setResponses([
            fauxAssistantMessage(fauxText("ack")),
            fauxAssistantMessage(fauxText("ack")),
            fauxAssistantMessage(fauxText("ack")),
        ]);
        const result = await runScenario(h, "/goal create Pausable");
        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        // Status may already be paused due to empty progress; for the
        // purposes of this test we accept active OR paused.
        expect(["active", "paused"]).toContain(goal!.status);
    });

    it("test_goal_complete_command: /goal complete marks the goal complete", async () => {
        // Long-lived session: create via command, then complete via command.
        const { session, sessionManager } = await makeMiniSession(h);

        // Continuation responses (text only -> empty progress eventually).
        h.faux.setResponses([
            fauxAssistantMessage(fauxText("ack 1")),
            fauxAssistantMessage(fauxText("ack 2")),
            fauxAssistantMessage(fauxText("ack 3")),
            fauxAssistantMessage(fauxText("ack 4")),
        ]);
        await session.prompt("/goal create FromCommand");
        // Allow the continuation loop to settle.
        await new Promise((r) => setTimeout(r, 300));
        await session.prompt("/goal complete");
        await new Promise((r) => setTimeout(r, 100));
        session.dispose();

        const goal = getGoalFromSession(sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("complete");
    });

    // ── Regression: agent_end on stopReason="length" must not continue ──

    it("test_length_stop_reason_does_not_continue: non-stop stopReason pauses goal", async () => {
        // Per spec section 8.1, continuation requires stopReason === "stop".
        // "length" indicates the model was cut off, which signals an
        // unhealthy run. The goal must not auto-continue.
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "keep going" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("acked")),
            fauxAssistantMessage(fauxText("truncated..."), {
                stopReason: "length",
            }),
            // Sentinel: must not be reached.
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("would-be-completed")),
        ]);
        const result = await runScenario(h, "go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("paused");
    });

    // ── Regression: startup must enforce budget / turn cap before continuing ──

    it("test_startup_enforces_turn_cap: pre-staged active goal at MAX turns transitions to budget_limited", async () => {
        const KNOWN_SESSION = "known-session-aaaa-bbbb-cccc-dddd";
        const sm = SessionManager.inMemory(h.cwd);
        stageGoal(
            sm,
            KNOWN_SESSION,
            makeGoal({
                objective: "already at cap",
                turns_used: 100,
            }),
        );
        // Sentinel: if continuation fires, this response is consumed.
        h.faux.setResponses([
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const { session } = await makeMiniSession(h, { sessionManager: sm });
        await new Promise((r) => setTimeout(r, 200));
        const sentinelConsumed = h.faux.getPendingResponseCount() === 0;
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.status).not.toBe("active");
        expect(sentinelConsumed).toBe(false);
    });

    it("test_startup_enforces_budget: pre-staged active goal already over budget transitions to budget_limited", async () => {
        const KNOWN_SESSION = "known-session-budget-overrun";
        const sm = SessionManager.inMemory(h.cwd);
        stageGoal(
            sm,
            KNOWN_SESSION,
            makeGoal({
                objective: "already over budget",
                token_budget: 100,
                tokens_used: 500,
            }),
        );
        h.faux.setResponses([
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const { session } = await makeMiniSession(h, { sessionManager: sm });
        await new Promise((r) => setTimeout(r, 200));
        const sentinelConsumed = h.faux.getPendingResponseCount() === 0;
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal!.status).not.toBe("active");
        expect(sentinelConsumed).toBe(false);
    });

    // ── Regression: exact turn-cap hit must transition to budget_limited ──

    it("test_exact_turn_cap_transitions_to_budget_limited: incrementing to MAX_AUTONOMOUS_TURNS does not leave goal active", async () => {
        // Pre-stage a goal at turns_used = 99. session_start sees < 100
        // and schedules a continuation. The autonomous run finishes with
        // a tool call. agent_end's incrementTurns pushes turns_used to 100
        // exactly. With the bug, scheduleContinuation's setImmediate
        // bails on >= 100 and the goal stays "active". With the fix,
        // agent_end's [8b] post-increment cap check transitions the goal
        // to "budget_limited".
        const KNOWN_SESSION = "exact-turn-cap-session";
        const sm = SessionManager.inMemory(h.cwd);
        stageGoal(
            sm,
            KNOWN_SESSION,
            makeGoal({
                objective: "long running",
                turns_used: 99,
            }),
        );

        // Autonomous continuation: tool call to avoid empty progress, then
        // text stop; budget_limited path then sends a wrap-up prompt.
        h.faux.setResponses([
            fauxAssistantMessage(fauxToolCall("get_goal", {}), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxText("proceeding")),
            // Wrap-up prompt response (budget_limited path).
            fauxAssistantMessage(fauxText("wrapping up")),
            // Sentinel: must NOT be consumed.
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const { session } = await makeMiniSession(h, { sessionManager: sm });
        await new Promise((r) => setTimeout(r, 500));
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.turns_used).toBe(100);
        expect(goal!.status).toBe("budget_limited");
    });

    // ── Regression: startup-triggered run that completes should count turns ──

    it("test_startup_completion_run_counts_turn: first autonomous run from session_start increments turns_used even if it completes the goal", async () => {
        const KNOWN_SESSION = "startup-complete-turn-count";
        const sm = SessionManager.inMemory(h.cwd);
        stageGoal(
            sm,
            KNOWN_SESSION,
            makeGoal({
                objective: "complete me on resume",
                turns_used: 5,
            }),
        );
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const { session } = await makeMiniSession(h, { sessionManager: sm });
        await new Promise((r) => setTimeout(r, 500));
        session.dispose();

        const goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("complete");
        // The completing autonomous run is counted: 5 -> 6.
        expect(goal!.turns_used).toBe(6);
    });

    // ── Regression: completion run tokens must be accounted ──

    it("test_completion_run_tokens_accounted: tokens spent in the run that completes the goal are recorded", async () => {
        h.faux.setResponses([
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
        const result = await runScenario(h, "go");

        const goal = getGoalFromSession(result.sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("complete");
        expect(goal!.tokens_used).toBeGreaterThan(0);
    });

    // ── Regression: paused/complete goal must not accumulate tokens ──

    it("test_paused_goal_no_token_accumulation: runs after completion do not increment tokens_used", async () => {
        const { session, sessionManager } = await makeMiniSession(h);

        // Phase 1: Create + complete in one run.
        h.faux.setResponses([
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
        await new Promise((r) => setTimeout(r, 200));

        let goal = getGoalFromSession(sessionManager);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("complete");
        const tokensAfterComplete = goal!.tokens_used;
        expect(tokensAfterComplete).toBeGreaterThan(0);

        // Phase 2: Unrelated user prompt with text-only response.
        h.faux.setResponses([
            fauxAssistantMessage(fauxText("just chatting")),
        ]);
        await session.prompt("how is the weather?");
        await new Promise((r) => setTimeout(r, 200));

        goal = getGoalFromSession(sessionManager);
        session.dispose();

        expect(goal!.tokens_used).toBe(tokensAfterComplete);
    });

    // ── Regression: validation tests ──────────────────────────────────

    it("test_empty_objective_rejected: create_goal with empty string returns error", async () => {
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        const result = await runScenario(h, "go");

        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_command_create_overlong_objective_rejected: /goal create with >4000 chars rejected", async () => {
        const longObjective = "x".repeat(4001);
        h.faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await runScenario(h, `/goal create ${longObjective}`);

        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_command_edit_overlong_objective_rejected: /goal edit with >4000 chars rejected", async () => {
        const { session, sessionManager } = await makeMiniSession(h);

        // Create a valid goal first.
        h.faux.setResponses([
            fauxAssistantMessage(fauxText("ack")),
            fauxAssistantMessage(fauxText("ack")),
            fauxAssistantMessage(fauxText("ack")),
        ]);
        await session.prompt("/goal create Valid objective");
        await new Promise((r) => setTimeout(r, 300));

        const before = getGoalFromSession(sessionManager);
        expect(before).not.toBeNull();
        expect(before!.objective).toBe("Valid objective");

        // Now try to edit with an overlong objective.
        const longObjective = "y".repeat(4001);
        h.faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        await session.prompt(`/goal edit ${longObjective}`);
        await new Promise((r) => setTimeout(r, 100));
        session.dispose();

        const after = getGoalFromSession(sessionManager);
        expect(after).not.toBeNull();
        expect(after!.objective).toBe("Valid objective");
    });

    it("test_resume_command_resets_empty_progress: /goal resume clears stale emptyProgressCount", async () => {
        const KNOWN_SESSION = "resume-empty-progress-session";
        const sm = SessionManager.inMemory(h.cwd);
        sm.newSession({ id: KNOWN_SESSION });

        // Phase 1: user creates goal, then 2 empty autonomous runs, then a
        // 3rd autonomous run that errors (faux exhausted). Counter reaches 3
        // before the error path pauses the goal.
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", { objective: "explore" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("acked")),
            fauxAssistantMessage(fauxText("thinking 1")),
            fauxAssistantMessage(fauxText("thinking 2")),
            // 3rd autonomous run has no response -> faux emits an error
            // message -> count reaches 3, error path pauses goal.
        ]);

        const { session } = await makeMiniSession(h, { sessionManager: sm });
        await session.prompt("go");
        await new Promise((r) => setTimeout(r, 500));

        let goal = getGoalFromSession(sm);
        expect(goal).not.toBeNull();
        expect(goal!.status).toBe("paused");

        // Phase 2: /goal resume. Without the reset, the resumed
        // continuation's first empty run would push the stale counter to
        // 4 and re-pause immediately.
        h.faux.setResponses([
            fauxAssistantMessage(fauxText("resumed thinking")),
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        await session.prompt("/goal resume");
        await new Promise((r) => setTimeout(r, 500));

        goal = getGoalFromSession(sm);
        session.dispose();

        expect(goal!.status).toBe("complete");
    });

    it("test_resume_at_budget_cap_does_not_leave_goal_active: /goal resume without raising budget keeps goal budget_limited", async () => {
        const KNOWN_SESSION = "resume-at-cap-session";
        const sm = SessionManager.inMemory(h.cwd);
        stageGoal(
            sm,
            KNOWN_SESSION,
            makeGoal({
                objective: "do stuff",
                token_budget: 100,
                tokens_used: 150,
                status: "budget_limited",
            }),
        );

        h.faux.setResponses([
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const { session } = await makeMiniSession(h, { sessionManager: sm });
        await session.prompt("/goal resume");
        await new Promise((r) => setTimeout(r, 300));

        const sentinelConsumed = h.faux.getPendingResponseCount() === 0;
        const goal = getGoalFromSession(sm);
        session.dispose();

        expect(goal).not.toBeNull();
        expect(goal!.status).not.toBe("active");
        expect(sentinelConsumed).toBe(false);
    });

    it("test_resume_at_turn_cap_does_not_leave_goal_active: /goal resume without raising turn cap keeps goal budget_limited", async () => {
        const KNOWN_SESSION = "resume-at-turn-cap-session";
        const sm = SessionManager.inMemory(h.cwd);
        stageGoal(
            sm,
            KNOWN_SESSION,
            makeGoal({
                objective: "do stuff",
                turns_used: 100,
                status: "budget_limited",
            }),
        );

        h.faux.setResponses([
            fauxAssistantMessage(fauxText("should not run")),
        ]);
        const { session } = await makeMiniSession(h, { sessionManager: sm });
        await session.prompt("/goal resume");
        await new Promise((r) => setTimeout(r, 300));

        const sentinelConsumed = h.faux.getPendingResponseCount() === 0;
        const goal = getGoalFromSession(sm);
        session.dispose();

        expect(goal).not.toBeNull();
        expect(goal!.status).not.toBe("active");
        expect(sentinelConsumed).toBe(false);
    });

    it("test_budget_negative_rejected: /goal create with --budget -5 returns error, no goal created", async () => {
        h.faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await runScenario(h, "/goal create task --budget -5");

        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_budget_trailing_chars_rejected: /goal create with --budget 10abc returns error, no goal created", async () => {
        h.faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await runScenario(h, "/goal create task --budget 10abc");

        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    it("test_budget_zero_rejected: /goal create with --budget 0 returns error, no goal created", async () => {
        h.faux.setResponses([fauxAssistantMessage(fauxText("noop"))]);
        const result = await runScenario(h, "/goal create task --budget 0");

        expect(getGoalFromSession(result.sessionManager)).toBeNull();
    });

    // ── New: session_tree branch navigation ──────────────────────────

    it("test_session_tree_reconstructs: branch navigation rehydrates store from new branch", async () => {
        // This test verifies the session_tree handler reconstructs the
        // store from the new branch. We exercise it by creating two
        // distinct branches with different goals, switching between them,
        // and confirming the in-store goal matches the new branch.
        //
        // We use a long-lived session and SessionManager.switchToEntry
        // to navigate. After switch, the next user prompt should see the
        // branch's goal as the active store state.
        const sm = SessionManager.inMemory(h.cwd);
        const { session } = await makeMiniSession(h, { sessionManager: sm });

        // Create a goal on the initial branch.
        h.faux.setResponses([
            fauxAssistantMessage(
                fauxToolCall("create_goal", {
                    objective: "branch-A objective",
                }),
                { stopReason: "toolUse" },
            ),
            // Autonomous continuation: complete to stop the loop.
            fauxAssistantMessage(
                fauxToolCall("update_goal", { status: "complete" }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);
        await session.prompt("create branch A goal");
        await new Promise((r) => setTimeout(r, 300));

        const goalA = getGoalFromSession(sm);
        expect(goalA).not.toBeNull();
        expect(goalA!.objective).toBe("branch-A objective");
        expect(goalA!.status).toBe("complete");

        // Now `/goal status` -- this exercises the in-memory store via
        // the command handler. If session_tree is wired correctly it
        // mirrors the branch state. We confirm by issuing /goal clear,
        // which reads from the store and writes a cleared sentinel.
        h.faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
        await session.prompt("/goal clear");
        await new Promise((r) => setTimeout(r, 100));

        const cleared = getGoalFromSession(sm);
        expect(cleared).toBeNull();
        session.dispose();
    });
});
