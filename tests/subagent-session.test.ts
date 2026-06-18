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

function makeMockPi() {
    return {
        sendMessage: vi.fn(),
    } as any;
}

function makeMockCtx() {
    return {
        ui: {
            setWidget: vi.fn(),
            setStatus: vi.fn(),
            theme: {
                fg: (_color: string, text: string) => text,
            },
        },
    } as any;
}

describe("background injectResult session header", () => {
    it("prepends [session: <id>] header when session is provided", () => {
        const pi = makeMockPi();
        const mgr = createBackgroundManager(pi);
        const ctx = makeMockCtx();
        mgr.setContext(ctx);
        mgr.setSessionActive(true);

        const session = { dir: "/tmp/sessions/abc/subagent", id: "scout-a1b2c3d4" };
        mgr.injectResult(
            "scout-a1b2c3d4",
            "completed",
            "output text",
            makeFakeResult(),
            { description: "test task", cancelled: false, session },
        );

        expect(pi.sendMessage).toHaveBeenCalledOnce();
        const [msg] = pi.sendMessage.mock.calls[0];
        expect(msg.content).toMatch(/^\[subagent: scout-a1b2c3d4\]\n\n/);
        expect(msg.content).toContain("output text");
    });

    it("does not prepend header when session is undefined", () => {
        const pi = makeMockPi();
        const mgr = createBackgroundManager(pi);
        const ctx = makeMockCtx();
        mgr.setContext(ctx);
        mgr.setSessionActive(true);

        mgr.injectResult(
            "scout-a1b2c3d4",
            "completed",
            "output text",
            makeFakeResult(),
            { description: "test task", cancelled: false },
        );

        expect(pi.sendMessage).toHaveBeenCalledOnce();
        const [msg] = pi.sendMessage.mock.calls[0];
        expect(msg.content).not.toMatch(/^\[subagent:/);
        expect(msg.content).toContain("output text");
    });

    it("stores session in injected message details", () => {
        const pi = makeMockPi();
        const mgr = createBackgroundManager(pi);
        const ctx = makeMockCtx();
        mgr.setContext(ctx);
        mgr.setSessionActive(true);

        const session = { dir: "/tmp/sessions/abc/subagent", id: "worker-e5f6g7h8" };
        mgr.injectResult("worker-e5f6g7h8", "completed", "done", makeFakeResult(), {
            description: "bg task",
            cancelled: false,
            session,
        });

        const [msg] = pi.sendMessage.mock.calls[0];
        expect(msg.details.session).toEqual(session);
    });

    it("details.session is undefined when not provided", () => {
        const pi = makeMockPi();
        const mgr = createBackgroundManager(pi);
        const ctx = makeMockCtx();
        mgr.setContext(ctx);
        mgr.setSessionActive(true);

        mgr.injectResult("worker-e5f6g7h8", "completed", "done", makeFakeResult(), {
            description: "bg task",
            cancelled: false,
        });

        const [msg] = pi.sendMessage.mock.calls[0];
        expect(msg.details.session).toBeUndefined();
    });
});
