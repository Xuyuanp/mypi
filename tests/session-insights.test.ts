/**
 * Tests for the session-insights extension: pure insight computation and
 * HTML rendering. No pi runtime is involved.
 */

import { describe, expect, it } from "vitest";
import {
    formatDuration,
    formatTokens,
    formatUsd,
} from "../extensions/session-insights/format.js";
import { computeInsights } from "../extensions/session-insights/insights.js";
import { renderInsightsHtml } from "../extensions/session-insights/render.js";
import type { EntryLike } from "../extensions/session-insights/types.js";

const MODEL_CHANGE: EntryLike = {
    type: "model_change",
    timestamp: "2026-01-01T00:00:00.000Z",
    provider: "openai",
    modelId: "gpt-x",
};

/** Epoch ms of the session's first ISO timestamp, used to build message times. */
const BASE = Date.parse("2026-01-01T00:00:00.000Z");

/** A full run: one tool call, one tool error, one assistant error. */
const ENTRIES: EntryLike[] = [
    {
        type: "session",
        timestamp: "2026-01-01T00:00:00.000Z",
    },
    MODEL_CHANGE,
    {
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", timestamp: BASE },
    },
    {
        type: "message",
        timestamp: "2026-01-01T00:00:10.000Z",
        message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-x",
            timestamp: BASE + 1000,
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "c1", name: "bash" }],
            usage: {
                input: 1000,
                output: 500,
                cacheRead: 2000,
                cacheWrite: 0,
                reasoning: 100,
                totalTokens: 3500,
                cost: {
                    input: 0.01,
                    output: 0.02,
                    cacheRead: 0.001,
                    cacheWrite: 0,
                    total: 0.031,
                },
            },
        },
    },
    {
        type: "message",
        timestamp: "2026-01-01T00:00:11.000Z",
        message: {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
            isError: false,
        },
    },
    {
        type: "message",
        timestamp: "2026-01-01T00:00:20.000Z",
        message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-x",
            timestamp: BASE + 19_000,
            stopReason: "error",
            errorMessage: "boom",
            content: [],
            usage: {
                input: 10,
                output: 0,
                totalTokens: 10,
                cost: { total: 0.0001 },
            },
        },
    },
    {
        type: "message",
        timestamp: "2026-01-01T00:00:21.000Z",
        message: {
            role: "toolResult",
            toolCallId: "c2",
            toolName: "read",
            content: [{ type: "text", text: "ENOENT: no such file" }],
            isError: true,
        },
    },
];

function compute(entries: EntryLike[] = ENTRIES) {
    return computeInsights({
        entries,
        sessionId: "abcdef12-3456",
        sessionName: "test session",
        sessionFile: "/tmp/session.jsonl",
        cwd: "/work",
        context: { tokens: 3510, contextWindow: 10_000, percent: 35.1 },
        now: 1_700_000_000_000,
    });
}

describe("computeInsights", () => {
    it("counts turns, tool calls and errors", () => {
        const insights = compute();
        expect(insights.userTurns).toBe(1);
        expect(insights.assistantTurns).toBe(2);
        expect(insights.toolCalls).toBe(1);
        expect(insights.toolResults).toBe(2);
        expect(insights.toolErrors).toBe(1);
        expect(insights.assistantErrors).toBe(1);
        expect(insights.errors).toBe(2);
        expect(insights.errorRate).toBe(1);
    });

    it("sums tokens and cost across messages", () => {
        const insights = compute();
        expect(insights.tokens.input).toBe(1010);
        expect(insights.tokens.output).toBe(500);
        expect(insights.tokens.cacheRead).toBe(2000);
        expect(insights.tokens.total).toBe(3510);
        expect(insights.cost.total).toBeCloseTo(0.0311, 6);
    });

    it("attributes usage to the active model", () => {
        const insights = compute();
        expect(insights.models).toHaveLength(1);
        expect(insights.models[0].model).toBe("gpt-x");
        expect(insights.models[0].provider).toBe("openai");
        expect(insights.models[0].turns).toBe(2);
        expect(insights.models[0].cost).toBeCloseTo(0.0311, 6);
        expect(insights.primaryModel).toBe("openai/gpt-x");
    });

    it("derives throughput from the message start/end pair", () => {
        const insights = compute();
        expect(insights.turns).toHaveLength(2);
        expect(insights.turns[0].durationMs).toBe(9000);
        expect(insights.turns[1].durationMs).toBe(1000);
        // 500 output tokens over 10s of generation.
        expect(insights.tps).toBeCloseTo(50, 5);
        expect(insights.tpsEstimated).toBe(false);
        expect(insights.activeMs).toBe(10_000);
    });

    it("records the per-turn breakdown for the timeline", () => {
        const insights = compute();
        const [first, second] = insights.turns;
        expect(first.inputTokens).toBe(1000);
        expect(first.outputTokens).toBe(500);
        expect(first.cacheReadTokens).toBe(2000);
        expect(first.cacheWriteTokens).toBe(0);
        expect(first.totalTokens).toBe(3500);
        expect(first.toolNames).toEqual(["bash"]);
        expect(first.provider).toBe("openai");
        expect(first.model).toBe("gpt-x");
        expect(first.tps).toBeCloseTo(500 / 9, 5);
        expect(first.cumulativeCost).toBeCloseTo(0.031, 6);
        expect(second.outputTokens).toBe(0);
        expect(second.cumulativeCost).toBeCloseTo(0.0311, 6);
        expect(second.stopReason).toBe("error");
    });

    it("computes cache hit rate over prompt-side tokens", () => {
        const insights = compute();
        expect(insights.cacheHitRate).toBeCloseTo(2000 / 3010, 6);
    });

    it("collects error items with tool and assistant kinds", () => {
        const insights = compute();
        const kinds = insights.errorItems.map((item) => item.kind).sort();
        expect(kinds).toEqual(["assistant", "tool"]);
        const toolError = insights.errorItems.find((i) => i.kind === "tool");
        expect(toolError?.label).toBe("read");
        expect(toolError?.message).toContain("ENOENT");
    });

    it("uses live timing when supplied", () => {
        const live = {
            generationMs: new Map([[BASE + 1000, 4000]]),
            ttftMs: new Map([[BASE + 1000, 250]]),
            toolDurationMs: new Map([["c1", 42]]),
        };
        const insights = computeInsights({
            entries: ENTRIES,
            sessionId: "s",
            cwd: "/work",
            live,
        });
        expect(insights.turns[0].durationMs).toBe(4000);
        expect(insights.turns[0].ttftMs).toBe(250);
        expect(insights.ttftAvgMs).toBe(250);
        expect(insights.tools.find((t) => t.name === "bash")?.durationMs).toBe(42);
    });

    it("handles an empty session", () => {
        const insights = compute([]);
        expect(insights.assistantTurns).toBe(0);
        expect(insights.tps).toBe(0);
        expect(insights.errorRate).toBe(0);
        expect(insights.models).toEqual([]);
        expect(insights.wallMs).toBe(0);
    });
});

describe("renderInsightsHtml", () => {
    it("renders a self-contained document with the key numbers", () => {
        const html = renderInsightsHtml(compute());
        expect(html.startsWith("<!doctype html>")).toBe(true);
        expect(html).toContain("<style>");
        expect(html).toContain("Session Insights");
        expect(html).toContain("openai/gpt-x");
        expect(html).toContain("Total cost");
        expect(html).toContain("Tool error rate");
        // No external resources: offline, file:// friendly.
        expect(html).not.toContain("http://");
        expect(html).not.toContain("https://");
        expect(html).not.toContain('src="http');
    });

    it("embeds the interactive timeline data and controls", () => {
        const html = renderInsightsHtml(compute());
        expect(html).toContain('id="tl-tabs"');
        expect(html).toContain('data-metric="tokens"');
        expect(html).toContain('data-metric="cost"');
        expect(html).toContain('data-metric="time"');
        expect(html).toContain('data-metric="speed"');
        expect(html).toContain('id="turn-detail"');
        expect(html).toContain('id="tl-cum"');
        expect(html).toContain('<script type="application/json" id="turn-data">');
        // The embedded turn data carries the per-turn breakdown.
        expect(html).toContain('"cumulativeCost"');
        expect(html).toContain('"durationMs"');
    });

    it("shows cost by default in the timeline", () => {
        const html = renderInsightsHtml(compute());
        expect(html).toContain(
            '<button class="mtab active" type="button" data-metric="cost">',
        );
        expect(html).not.toContain(
            '<button class="mtab active" type="button" data-metric="tokens">',
        );
        // The cost view and its cumulative line render without JavaScript.
        expect(html).toContain('class="stacked" style="display:none"');
        expect(html).toContain('id="tl-cum" points="');
        expect(html).toContain("cost / turn");
        // The server-rendered axis uses dollars, not token counts.
        expect(html).toMatch(/class="axis ylab"[^>]*>\$[\d.]+<\/text>/);
    });

    it("escapes untrusted session metadata", () => {
        const insights = compute();
        insights.sessionName = `<img src=x onerror="alert(1)">`;
        insights.cwd = `/work/"><script>evil()</script>`;
        const html = renderInsightsHtml(insights);
        expect(html).not.toContain("<img src=x");
        expect(html).not.toContain('"><script>');
        expect(html).toContain("&lt;img src=x");
    });

    it("escapes untrusted tool names inside the embedded turn data", () => {
        const maliciousName = "</script><script>evil()</script>";
        const entries: EntryLike[] = [
            MODEL_CHANGE,
            {
                type: "message",
                timestamp: "2026-01-01T00:00:00.000Z",
                message: { role: "user", timestamp: BASE },
            },
            {
                type: "message",
                timestamp: "2026-01-01T00:00:05.000Z",
                message: {
                    role: "assistant",
                    provider: "openai",
                    model: "gpt-x",
                    timestamp: BASE,
                    stopReason: "toolUse",
                    content: [{ type: "toolCall", id: "c1", name: maliciousName }],
                    usage: { input: 1, output: 1, totalTokens: 2 },
                },
            },
        ];
        const html = renderInsightsHtml(
            computeInsights({ entries, sessionId: "s", cwd: "/w" }),
        );
        expect(html).not.toContain(maliciousName);
        expect(html).not.toContain("</script><script>evil()");
    });

    it("survives a session with no turns or models", () => {
        const html = renderInsightsHtml(compute([]));
        expect(html).toContain("No turns recorded yet.");
        expect(html).toContain("No model usage recorded yet.");
        expect(html).toContain("No tool calls recorded yet.");
    });
});

describe("formatters", () => {
    it("formats token counts", () => {
        expect(formatTokens(0)).toBe("0");
        expect(formatTokens(999)).toBe("999");
        expect(formatTokens(1500)).toBe("1.5k");
        expect(formatTokens(45_000)).toBe("45k");
        expect(formatTokens(2_500_000)).toBe("2.50M");
    });

    it("formats USD amounts", () => {
        expect(formatUsd(0)).toBe("$0.00");
        expect(formatUsd(0.0311)).toBe("$0.031");
        expect(formatUsd(2.5)).toBe("$2.50");
    });

    it("formats durations", () => {
        expect(formatDuration(0)).toBe("0s");
        expect(formatDuration(4500)).toBe("4.5s");
        expect(formatDuration(65_000)).toBe("1m 5s");
        expect(formatDuration(3_900_000)).toBe("1h 5m");
        // Rounding must never produce "7m 60s".
        expect(formatDuration(479_700)).toBe("8m 0s");
        expect(formatDuration(3_599_000)).toBe("59m 59s");
    });
});
