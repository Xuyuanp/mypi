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
import keepalive from "../extensions/keepalive.js";

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
});
