/**
 * Tests for session persistence in subagent tool results (issue #12).
 *
 * Tests cover:
 * - session stored in foreground details
 * - session stored in background details
 * - header prepended to result text
 * - no header when session is undefined
 */

import { describe, expect, it, vi } from "vitest";
import { createBackgroundManager } from "../extensions/subagent/background.js";
import { createZeroUsage } from "../extensions/subagent/index.js";
import type { AgentRunResult } from "../extensions/subagent/types.js";

function makeFakeResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
    return {
        agent: "scout",
        agentSource: "system" as const,
        task: "do something",
        outcome: { status: "success" },
        messages: [],
        stderr: "",
        usage: createZeroUsage(),
        durationMs: 0,
        ...overrides,
    };
}

function makeMockInject() {
    return vi.fn();
}

describe("background injectResult session header", () => {
    it("prepends [session: <id>] header when session is provided", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        const session = { dir: "/tmp/sessions/abc/subagent", id: "scout-a1b2c3d4" };
        mgr.injectResult(
            "scout-a1b2c3d4",
            "completed",
            "output text",
            makeFakeResult(),
            { description: "test task", cancelled: false, session },
        );

        expect(injectMessage).toHaveBeenCalledOnce();
        const [msg] = injectMessage.mock.calls[0];
        expect(msg.content).toMatch(/^\[subagent: scout-a1b2c3d4\]\n\n/);
        expect(msg.content).toContain("output text");
    });

    it("does not prepend header when session is undefined", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        mgr.injectResult(
            "scout-a1b2c3d4",
            "completed",
            "output text",
            makeFakeResult(),
            { description: "test task", cancelled: false },
        );

        expect(injectMessage).toHaveBeenCalledOnce();
        const [msg] = injectMessage.mock.calls[0];
        expect(msg.content).not.toMatch(/^\[subagent:/);
        expect(msg.content).toContain("output text");
    });

    it("stores session in injected message details", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        const session = { dir: "/tmp/sessions/abc/subagent", id: "worker-e5f6g7h8" };
        mgr.injectResult("worker-e5f6g7h8", "completed", "done", makeFakeResult(), {
            description: "bg task",
            cancelled: false,
            session,
        });

        const [msg] = injectMessage.mock.calls[0];
        expect(msg.details.session).toEqual(session);
    });

    it("details.session is undefined when not provided", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        mgr.injectResult("worker-e5f6g7h8", "completed", "done", makeFakeResult(), {
            description: "bg task",
            cancelled: false,
        });

        const [msg] = injectMessage.mock.calls[0];
        expect(msg.details.session).toBeUndefined();
    });
});
