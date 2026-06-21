/**
 * Tests for the background subagent feature.
 *
 * Tests cover the createBackgroundManager API:
 * - register/remove lifecycle and widget updates
 * - cancel kills and removes agents
 * - Result injection on completion (with triggerTurn control)
 * - Shutdown kills all agents and marks inactive
 * - Session-inactive guard prevents injection
 */

import { describe, expect, it, vi } from "vitest";
import { createBackgroundManager } from "../extensions/subagent/background.js";
import {
    type BackgroundAgent,
    createZeroUsage,
} from "../extensions/subagent/index.js";
import { createProgressTracker } from "../extensions/subagent/tracker.js";
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

function makeFakeEntry(overrides?: Partial<BackgroundAgent>): BackgroundAgent {
    return {
        id: "scout-a1b2c3d4",
        description: "test",
        agentName: "scout",
        task: "do it",
        kill: () => {},
        promise: new Promise(() => {}) as any,
        startedAt: Date.now(),
        tracker: createProgressTracker(),
        ...overrides,
    };
}

describe("createBackgroundManager", () => {
    function makeMockInject() {
        return vi.fn();
    }

    function makeMockSetWidget() {
        return vi.fn();
    }

    it("register updates widget", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        const setWidget = makeMockSetWidget();
        mgr.setUI(setWidget);

        const entry = makeFakeEntry({ kill: vi.fn() });
        mgr.register(entry);

        expect(mgr.agents.size).toBe(1);
        expect(setWidget).toHaveBeenCalled();
    });

    it("remove clears widget when last agent removed", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        const setWidget = makeMockSetWidget();
        mgr.setUI(setWidget);

        const entry = makeFakeEntry({ kill: vi.fn() });
        mgr.register(entry);
        setWidget.mockClear();

        mgr.remove(entry.id);

        expect(mgr.agents.size).toBe(0);
        expect(setWidget).toHaveBeenCalledWith("subagent-bg", undefined);
    });

    it("cancel kills and removes, returns false for unknown IDs", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        const setWidget = makeMockSetWidget();
        mgr.setUI(setWidget);

        const killFn = vi.fn();
        const entry = makeFakeEntry({ kill: killFn });
        mgr.register(entry);

        expect(mgr.cancel("nonexistent")).toBe(false);

        expect(mgr.cancel(entry.id)).toBe(true);
        expect(killFn).toHaveBeenCalledOnce();
        expect(mgr.agents.size).toBe(0);
    });

    it("injectResult sends followUp with triggerTurn: true for completion", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        mgr.injectResult(
            "test-id",
            "completed",
            "output text",
            makeFakeResult({ outcome: { status: "success" } }),
            { description: "test task", cancelled: false },
        );

        expect(injectMessage).toHaveBeenCalledOnce();
        const [msg, opts] = injectMessage.mock.calls[0];
        expect(opts.deliverAs).toBe("followUp");
        expect(opts.triggerTurn).toBe(true);
        expect(msg.content).toContain("completed");
    });

    it("injectResult sends triggerTurn: false for cancelled", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        mgr.injectResult(
            "test-id",
            "cancelled",
            "(cancelled by user)",
            makeFakeResult({ outcome: { status: "success" } }),
            { description: "test task", cancelled: true },
        );

        expect(injectMessage).toHaveBeenCalledOnce();
        const [_msg, opts] = injectMessage.mock.calls[0];
        expect(opts.triggerTurn).toBe(false);
    });

    it("shutdown marks inactive and kills/awaits/clears", async () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        const setWidget = makeMockSetWidget();
        mgr.setUI(setWidget);

        const killFn = vi.fn();
        const entry = makeFakeEntry({
            kill: killFn,
            promise: Promise.resolve(makeFakeResult()) as any,
        });
        mgr.register(entry);

        await mgr.shutdown();

        expect(mgr.sessionActive).toBe(false);
        expect(killFn).toHaveBeenCalledOnce();
        expect(mgr.agents.size).toBe(0);
    });

    it("injectResult is a no-op when session is inactive", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(false);

        mgr.injectResult(
            "test-id",
            "completed",
            "output",
            makeFakeResult({ outcome: { status: "success" } }),
        );

        expect(injectMessage).not.toHaveBeenCalled();
    });

    it("injectResult constructs SubagentDetails with kind='background'", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        mgr.injectResult(
            "bg-id",
            "completed",
            "done",
            makeFakeResult({ outcome: { status: "success" } }),
            { description: "bg task", cancelled: false },
        );

        const [msg] = injectMessage.mock.calls[0];
        expect(msg.details.kind).toBe("background");
        expect(msg.details.description).toBe("bg task");
        expect(msg.details.cancelled).toBe(false);
    });
});
