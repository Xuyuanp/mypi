/**
 * Tests for createProgressTracker (issue #subagent-unification).
 *
 * Covers: initial state, message accumulation, execStatuses,
 * toolStartCount, onChange firing, error swallowing, usage getter.
 */

import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createProgressTracker } from "../extensions/subagent/tracker.js";
import { createZeroUsage } from "../extensions/subagent/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeMessageEvent(
    message: Message,
    usage = createZeroUsage(),
): { type: "message"; message: Message; usage: typeof usage } {
    return { type: "message", message, usage };
}

function makeToolStartEvent(toolCallId: string): {
    type: "tool_start";
    toolCallId: string;
} {
    return { type: "tool_start", toolCallId };
}

function makeToolEndEvent(
    toolCallId: string,
    isError = false,
): { type: "tool_end"; toolCallId: string; isError: boolean } {
    return { type: "tool_end", toolCallId, isError };
}

function makeToolResultEvent(message: Message): {
    type: "tool_result";
    message: Message;
} {
    return { type: "tool_result", message };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("createProgressTracker", () => {
    it("returns empty initial state", () => {
        const tracker = createProgressTracker();
        expect(tracker.messages).toEqual([]);
        expect(tracker.execStatuses.size).toBe(0);
        expect(tracker.usage).toEqual(createZeroUsage());
        expect(tracker.toolStartCount).toBe(0);
    });

    it("onProgress accumulates messages on 'message' event", () => {
        const tracker = createProgressTracker();
        const msg: Message = {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
        } as Message;

        const usage = { ...createZeroUsage(), inputTokens: 100, turns: 1 };
        tracker.onProgress(makeMessageEvent(msg, usage));

        expect(tracker.messages).toHaveLength(1);
        expect(tracker.messages[0]).toBe(msg);
        expect(tracker.usage.inputTokens).toBe(100);
        expect(tracker.usage.turns).toBe(1);
    });

    it("onProgress sets execStatuses on 'tool_end' event", () => {
        const tracker = createProgressTracker();

        tracker.onProgress(makeToolEndEvent("tc1", false));
        tracker.onProgress(makeToolEndEvent("tc2", true));

        expect(tracker.execStatuses.size).toBe(2);
        expect(tracker.execStatuses.get("tc1")).toBe(false);
        expect(tracker.execStatuses.get("tc2")).toBe(true);
    });

    it("onProgress increments toolStartCount on 'tool_start'", () => {
        const tracker = createProgressTracker();

        tracker.onProgress(makeToolStartEvent("tc1"));
        tracker.onProgress(makeToolStartEvent("tc2"));
        tracker.onProgress(makeToolStartEvent("tc3"));

        expect(tracker.toolStartCount).toBe(3);
    });

    it("onProgress pushes tool_result messages", () => {
        const tracker = createProgressTracker();
        const msg: Message = {
            role: "toolResult",
            toolCallId: "tc1",
            content: [{ type: "text", text: "output" }],
            isError: false,
        } as Message;

        tracker.onProgress(makeToolResultEvent(msg));

        expect(tracker.messages).toHaveLength(1);
        expect(tracker.messages[0]).toBe(msg);
    });

    it("onChange fires on message, tool_start, and tool_end events", () => {
        const onChange = vi.fn();
        const tracker = createProgressTracker({ onChange });

        const msg: Message = {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
        } as Message;

        tracker.onProgress(makeMessageEvent(msg));
        tracker.onProgress(makeToolStartEvent("tc1"));
        tracker.onProgress(makeToolEndEvent("tc1", false));

        expect(onChange).toHaveBeenCalledTimes(3);
    });

    it("onChange does not fire on tool_result", () => {
        const onChange = vi.fn();
        const tracker = createProgressTracker({ onChange });

        const msg: Message = {
            role: "toolResult",
            toolCallId: "tc1",
            content: [{ type: "text", text: "output" }],
            isError: false,
        } as Message;

        tracker.onProgress(makeToolResultEvent(msg));

        expect(onChange).not.toHaveBeenCalled();
    });

    it("onChange exceptions are swallowed", () => {
        const onChange = vi.fn(() => {
            throw new Error("render failure");
        });
        const tracker = createProgressTracker({ onChange });

        const msg: Message = {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
        } as Message;

        // Should not throw
        expect(() => {
            tracker.onProgress(makeMessageEvent(msg));
        }).not.toThrow();

        // The message should still be accumulated despite the callback throwing
        expect(tracker.messages).toHaveLength(1);
    });

    it("usage getter returns latest snapshot (not accumulated)", () => {
        const tracker = createProgressTracker();
        const msg1: Message = {
            role: "assistant",
            content: [{ type: "text", text: "first" }],
        } as Message;
        const msg2: Message = {
            role: "assistant",
            content: [{ type: "text", text: "second" }],
        } as Message;

        const usage1 = { ...createZeroUsage(), inputTokens: 100, turns: 1 };
        const usage2 = { ...createZeroUsage(), inputTokens: 300, turns: 2 };

        tracker.onProgress(makeMessageEvent(msg1, usage1));
        expect(tracker.usage.inputTokens).toBe(100);

        tracker.onProgress(makeMessageEvent(msg2, usage2));
        // Usage is replaced, not accumulated: should be 300, not 400
        expect(tracker.usage.inputTokens).toBe(300);
        expect(tracker.usage.turns).toBe(2);
    });
});
