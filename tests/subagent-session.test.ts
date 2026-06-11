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
import { createZeroUsage } from "../extensions/subagent/index.js";
import { createBackgroundManager } from "../extensions/subagent/background.js";
import type {
    AgentRunResult,
    BackgroundSubagentDetails,
    ForegroundSubagentDetails,
} from "../extensions/subagent/types.js";

function makeFakeResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
    return {
        agent: "scout",
        agentSource: "system" as const,
        task: "do something",
        outcome: { status: "success" },
        messages: [],
        stderr: "",
        usage: createZeroUsage(),
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

describe("foreground subagent session in details", () => {
    it("session field is populated in ForegroundSubagentDetails", () => {
        const session = { dir: "/tmp/sessions/abc123/subagent", id: "scout-a1b2c3d4" };
        const details: ForegroundSubagentDetails = {
            kind: "foreground",
            result: makeFakeResult(),
            execStatuses: {},
            session,
        };

        expect(details.session).toEqual(session);
        expect(details.session?.dir).toBe("/tmp/sessions/abc123/subagent");
        expect(details.session?.id).toBe("scout-a1b2c3d4");
    });

    it("session field is optional and defaults to undefined", () => {
        const details: ForegroundSubagentDetails = {
            kind: "foreground",
            result: makeFakeResult(),
            execStatuses: {},
        };

        expect(details.session).toBeUndefined();
    });
});

describe("background subagent session in details", () => {
    it("session field is populated in BackgroundSubagentDetails", () => {
        const session = { dir: "/tmp/sessions/abc123/subagent", id: "worker-e5f6g7h8" };
        const details: BackgroundSubagentDetails = {
            kind: "background",
            result: makeFakeResult(),
            description: "test task",
            cancelled: false,
            session,
        };

        expect(details.session).toEqual(session);
        expect(details.session?.dir).toBe("/tmp/sessions/abc123/subagent");
        expect(details.session?.id).toBe("worker-e5f6g7h8");
    });

    it("session field is optional and defaults to undefined", () => {
        const details: BackgroundSubagentDetails = {
            kind: "background",
            result: makeFakeResult(),
            description: "test task",
            cancelled: false,
        };

        expect(details.session).toBeUndefined();
    });
});

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
        mgr.injectResult(
            "worker-e5f6g7h8",
            "completed",
            "done",
            makeFakeResult(),
            { description: "bg task", cancelled: false, session },
        );

        const [msg] = pi.sendMessage.mock.calls[0];
        expect(msg.details.session).toEqual(session);
    });

    it("details.session is undefined when not provided", () => {
        const pi = makeMockPi();
        const mgr = createBackgroundManager(pi);
        const ctx = makeMockCtx();
        mgr.setContext(ctx);
        mgr.setSessionActive(true);

        mgr.injectResult(
            "worker-e5f6g7h8",
            "completed",
            "done",
            makeFakeResult(),
            { description: "bg task", cancelled: false },
        );

        const [msg] = pi.sendMessage.mock.calls[0];
        expect(msg.details.session).toBeUndefined();
    });
});
