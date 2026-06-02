/**
 * Tests for keepalive extension.
 *
 * Uses the pi SDK with the faux mock provider (registered as "anthropic")
 * to verify ghost ping behavior, command handling, and event lifecycle.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxText,
    registerFauxProvider,
} from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import keepalive, {
    getMaxPings,
    getMaxTotalCost,
} from "../extensions/keepalive.js";

// ── Helpers ────────────────────────────────────────────────────────────

async function createSession(
    cwd: string,
    faux: FauxProviderRegistration,
): Promise<AgentSession> {
    const model = faux.getModel()!;
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, "fake-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: join(cwd, ".pi-test-agent"),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [keepalive],
        systemPromptOverride: () => "You are a test assistant.",
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
        cwd,
        agentDir: join(cwd, ".pi-test-agent"),
        model,
        thinkingLevel: "off",
        resourceLoader,
        sessionManager: SessionManager.inMemory(),
        settingsManager,
        authStorage,
        modelRegistry,
    });

    return session;
}

function collectEvents(session: AgentSession): AgentSessionEvent[] {
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    return events;
}

// Ping interval matches the extension constant
const PING_INTERVAL_MS = 55 * 60 * 1000;

// ── Test suite ─────────────────────────────────────────────────────────

describe("keepalive extension", () => {
    let tmpDir: string;
    let faux: FauxProviderRegistration;
    let session: AgentSession;

    beforeEach(async () => {
        vi.useFakeTimers();
        tmpDir = await mkdtemp(join(tmpdir(), "keepalive-test-"));
        faux = registerFauxProvider({ provider: "anthropic" });
    });

    afterEach(async () => {
        session?.dispose();
        faux.unregister();
        vi.useRealTimers();
        await rm(tmpDir, { recursive: true, force: true });
    });

    it("starts keepalive on /keepalive on command", async () => {
        // Queue: initial prompt response + ghost ping response
        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")),
            fauxAssistantMessage(fauxText("p")),
        ]);

        session = await createSession(tmpDir, faux);

        // Populate conversation (ghost ping needs messages)
        await session.prompt("hello");
        expect(faux.state.callCount).toBe(1);

        // Start keepalive
        await session.prompt("/keepalive on");

        // No additional API call yet (timer not fired)
        expect(faux.state.callCount).toBe(1);

        // Advance past ping interval
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);

        // Ghost ping should have fired
        expect(faux.state.callCount).toBe(2);
    });

    it("stops keepalive on /keepalive off command", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")),
        ]);

        session = await createSession(tmpDir, faux);
        await session.prompt("hello");

        await session.prompt("/keepalive on");
        await session.prompt("/keepalive off");

        // Advance past ping interval — no ping should fire
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);
        expect(faux.state.callCount).toBe(1);
    });

    it("toggles keepalive with bare /keepalive command", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")),
        ]);

        session = await createSession(tmpDir, faux);
        await session.prompt("hello");

        // Toggle on
        await session.prompt("/keepalive");

        // Toggle off
        await session.prompt("/keepalive");

        // No ping should fire
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);
        expect(faux.state.callCount).toBe(1);
    });

    it("refuses to start for non-anthropic models", async () => {
        // Use a non-anthropic faux provider
        faux.unregister();
        faux = registerFauxProvider({ provider: "openai" });
        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")),
        ]);

        session = await createSession(tmpDir, faux);
        await session.prompt("hello");

        // Should refuse (non-anthropic)
        await session.prompt("/keepalive on");

        // No ping should fire
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);
        expect(faux.state.callCount).toBe(1);
    });

    it("clears timer on agent_start and restarts on agent_end", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")),
            // Response for the second prompt (agent turn)
            fauxAssistantMessage(fauxText("world")),
            // Response for ghost ping after agent_end
            fauxAssistantMessage(fauxText("p")),
        ]);

        session = await createSession(tmpDir, faux);
        await session.prompt("hello");
        expect(faux.state.callCount).toBe(1);

        // Start keepalive
        await session.prompt("/keepalive on");

        // Advance partially (not enough for ping)
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        expect(faux.state.callCount).toBe(1);

        // Send another message (triggers agent_start → clear timer,
        // then agent_end → restart timer)
        await session.prompt("another message");
        expect(faux.state.callCount).toBe(2);

        // Timer was restarted on agent_end, so full interval from now
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);
        expect(faux.state.callCount).toBe(3);
    });

    it("stops at max pings", async () => {
        // Set max pings to 2 via env
        vi.stubEnv("PI_KEEPALIVE_MAX_PINGS", "2");

        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")),
            // Two ghost pings
            fauxAssistantMessage(fauxText("p1")),
            fauxAssistantMessage(fauxText("p2")),
            // Third ping should NOT happen
            fauxAssistantMessage(fauxText("p3")),
        ]);

        session = await createSession(tmpDir, faux);
        await session.prompt("hello");
        expect(faux.state.callCount).toBe(1);

        await session.prompt("/keepalive on");

        // First ping
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);
        expect(faux.state.callCount).toBe(2);

        // Second ping
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);
        expect(faux.state.callCount).toBe(3);

        // Third ping should NOT fire (limit reached)
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);
        expect(faux.state.callCount).toBe(3);

        vi.unstubAllEnvs();
    });

    it("does not restart timer on agent_end when budget exhausted", async () => {
        vi.stubEnv("PI_KEEPALIVE_MAX_PINGS", "1");

        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")),
            // One ghost ping
            fauxAssistantMessage(fauxText("p1")),
            // Second prompt response
            fauxAssistantMessage(fauxText("world")),
            // Should NOT be consumed by ghost ping
            fauxAssistantMessage(fauxText("nope")),
        ]);

        session = await createSession(tmpDir, faux);
        await session.prompt("hello");
        expect(faux.state.callCount).toBe(1);

        await session.prompt("/keepalive on");

        // First ping fires and exhausts budget
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);
        expect(faux.state.callCount).toBe(2);

        // Send another message (agent_end should NOT restart timer
        // because budget is exhausted)
        await session.prompt("another");
        expect(faux.state.callCount).toBe(3);

        // No ping should fire even after full interval
        await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + 1000);
        expect(faux.state.callCount).toBe(3);

        vi.unstubAllEnvs();
    });

    // The cache TTL clock is anchored to when the response BEGINS (recorded via
    // after_provider_response), not when keepalive is activated. These tests use
    // the faux provider, which streams instantly, so the sub-second begin-vs-end
    // difference is not numerically observable here; they instead lock the
    // contract that scheduling is anchored to the last provider response and
    // that the anchor advances on every agent turn.
    it("schedules first ping relative to last response, not activation", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")),
            fauxAssistantMessage(fauxText("p")),
        ]);

        session = await createSession(tmpDir, faux);

        // Real agent turn establishes the cache-refresh anchor.
        await session.prompt("hello");
        expect(faux.state.callCount).toBe(1);

        // Idle for 50 minutes before activating keepalive (anchor stays put:
        // a slash command is not an agent turn, so no after_provider_response).
        await vi.advanceTimersByTimeAsync(50 * 60 * 1000);
        await session.prompt("/keepalive on");

        // Anchor is ~50min old, so the first ping is due in ~5min -- NOT a full
        // interval from activation. At 4min past activation it must not fire.
        await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
        expect(faux.state.callCount).toBe(1);

        // Crossing the ~5min remainder triggers the ping.
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        expect(faux.state.callCount).toBe(2);
    });

    it("refreshes the cache-refresh anchor on a manual /keepalive ping", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")), // real turn -> anchor t0
            fauxAssistantMessage(fauxText("p")), // manual ghost ping
            fauxAssistantMessage(fauxText("p")), // first scheduled ping
        ]);

        session = await createSession(tmpDir, faux);

        // Real agent turn establishes the cache-refresh anchor at t0.
        await session.prompt("hello");
        expect(faux.state.callCount).toBe(1);

        // Idle 50 minutes, then fire a manual ping. The ping warms the cache, so
        // it must advance the anchor to ~now (t0 + 50min).
        await vi.advanceTimersByTimeAsync(50 * 60 * 1000);
        await session.prompt("/keepalive ping");
        expect(faux.state.callCount).toBe(2);

        // Activate keepalive immediately after the manual ping. Because the
        // anchor was refreshed, the first scheduled ping is a FULL interval out.
        // If the manual ping had NOT refreshed the anchor, it would still read
        // t0 (now 50min old) and the first ping would be due in ~5min.
        await session.prompt("/keepalive on");

        // 54min after the manual ping: under a full interval, so no ping yet.
        await vi.advanceTimersByTimeAsync(54 * 60 * 1000);
        expect(faux.state.callCount).toBe(2);

        // Crossing the ~55min interval fires the first scheduled ping.
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        expect(faux.state.callCount).toBe(3);
    });

    it("reschedules the active loop when a manual /keepalive ping fires", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxText("hello")), // real turn -> anchor t0
            fauxAssistantMessage(fauxText("p")), // manual ghost ping
            fauxAssistantMessage(fauxText("p")), // rescheduled scheduled ping
        ]);

        session = await createSession(tmpDir, faux);

        // Real turn anchors at t0, then activate: first ping due at ~t0 + 55min.
        await session.prompt("hello");
        await session.prompt("/keepalive on");
        expect(faux.state.callCount).toBe(1);

        // Manual ping 30min in. It warms the cache and must REPLACE the pending
        // t0+55min timer with one a full interval out (t0+30 + 55 = t0+85min).
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        await session.prompt("/keepalive ping");
        expect(faux.state.callCount).toBe(2);

        // Cross the ORIGINAL t0+55min deadline (now t0+56min). If the manual
        // ping had not rescheduled, the stale timer would fire here (-> 3).
        await vi.advanceTimersByTimeAsync(26 * 60 * 1000);
        expect(faux.state.callCount).toBe(2);

        // Cross the rescheduled t0+85min deadline -> the scheduled ping fires.
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        expect(faux.state.callCount).toBe(3);
    });

    it("advances the cache-refresh anchor with each agent turn", async () => {
        faux.setResponses([
            fauxAssistantMessage(fauxText("first")),
            fauxAssistantMessage(fauxText("second")),
            fauxAssistantMessage(fauxText("p")),
        ]);

        session = await createSession(tmpDir, faux);

        await session.prompt("first"); // anchor = t0
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        await session.prompt("second"); // anchor advances to t0 + 10min
        expect(faux.state.callCount).toBe(2);

        // Idle 40 more minutes (40min since the latest response).
        await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
        await session.prompt("/keepalive on");

        // The latest anchor is 40min old, so the first ping is due in ~15min.
        // If the anchor had NOT advanced past the first turn it would be 50min
        // old and the ping would already be overdue -- so 14min must not fire.
        await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
        expect(faux.state.callCount).toBe(2);

        // Crossing the ~15min remainder fires the ping.
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        expect(faux.state.callCount).toBe(3);
    });
});

describe("getMaxPings", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("returns the default when unset", () => {
        vi.stubEnv("PI_KEEPALIVE_MAX_PINGS", "");
        expect(getMaxPings()).toBe(8);
    });

    it("floors positive values to an integer", () => {
        vi.stubEnv("PI_KEEPALIVE_MAX_PINGS", "2.9");
        expect(getMaxPings()).toBe(2);
    });

    it("falls back to default for values that floor below 1", () => {
        // 0.5 floors to 0; a 0 budget would let one ping slip past the
        // post-ping-only budget gate, so it must fall back to the default.
        vi.stubEnv("PI_KEEPALIVE_MAX_PINGS", "0.5");
        expect(getMaxPings()).toBe(8);
    });

    it("falls back to default for zero, negative, and non-numeric input", () => {
        for (const v of ["0", "-3", "abc"]) {
            vi.stubEnv("PI_KEEPALIVE_MAX_PINGS", v);
            expect(getMaxPings()).toBe(8);
        }
    });
});

describe("getMaxTotalCost", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("returns the default when unset", () => {
        vi.stubEnv("PI_KEEPALIVE_MAX_COST", "");
        expect(getMaxTotalCost()).toBe(1.0);
    });

    it("keeps fractional positive values (cost is continuous)", () => {
        vi.stubEnv("PI_KEEPALIVE_MAX_COST", "2.5");
        expect(getMaxTotalCost()).toBe(2.5);
    });

    it("falls back to default for Infinity, zero, negative, and non-numeric", () => {
        // Infinity must be rejected: it would otherwise be an unbounded cap.
        for (const v of ["Infinity", "0", "-1", "abc"]) {
            vi.stubEnv("PI_KEEPALIVE_MAX_COST", v);
            expect(getMaxTotalCost()).toBe(1.0);
        }
    });
});
