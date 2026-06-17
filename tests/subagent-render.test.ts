/**
 * Tests for extracted rendering/formatting helpers in render.ts.
 *
 * Covers: formatTokens, formatDuration, formatUsageStats,
 * getDisplayItems, getFinalOutput,
 * renderSubagentResult (foreground + background),
 * AgentOutcome variants, isSubagentError, SubagentDetails discriminated union.
 */

import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
    formatDuration,
    formatTokens,
    formatUsageStats,
    getDisplayItems,
    getFinalOutput,
    renderSubagentResult,
} from "../extensions/subagent/render.js";
import type {
    AgentOutcome,
    AgentRunResult,
    SubagentDetails,
} from "../extensions/subagent/types.js";
import {
    createZeroUsage,
    isSubagentError,
    parseModelString,
} from "../extensions/subagent/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
    return {
        agent: "scout",
        agentSource: "system",
        task: "find files",
        outcome: { status: "success" },
        messages: [],
        stderr: "",
        usage: createZeroUsage(),
        durationMs: 0,
        ...overrides,
    };
}

function makeTheme() {
    return {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    };
}

// ── formatTokens ─────────────────────────────────────────────────────

describe("formatTokens", () => {
    it("renders numbers < 1000 as-is", () => {
        expect(formatTokens(0)).toBe("0");
        expect(formatTokens(999)).toBe("999");
        expect(formatTokens(42)).toBe("42");
    });

    it("renders 1000-9999 as X.Xk", () => {
        expect(formatTokens(1000)).toBe("1.0k");
        expect(formatTokens(1500)).toBe("1.5k");
        expect(formatTokens(9999)).toBe("10.0k");
    });

    it("renders 10000-999999 as Xk", () => {
        expect(formatTokens(10000)).toBe("10k");
        expect(formatTokens(55000)).toBe("55k");
        expect(formatTokens(999999)).toBe("1000k");
    });

    it("renders >= 1M as X.XM", () => {
        expect(formatTokens(1000000)).toBe("1.0M");
        expect(formatTokens(2500000)).toBe("2.5M");
    });
});

// ── formatDuration ───────────────────────────────────────────────────

describe("formatDuration", () => {
    it("renders < 1000 as Xms", () => {
        expect(formatDuration(0)).toBe("0ms");
        expect(formatDuration(500)).toBe("500ms");
        expect(formatDuration(999)).toBe("999ms");
    });

    it("renders 1000-59999 as X.Xs", () => {
        expect(formatDuration(1000)).toBe("1.0s");
        expect(formatDuration(5500)).toBe("5.5s");
        expect(formatDuration(59999)).toBe("60.0s");
    });

    it("renders >= 60000 as XmXs", () => {
        expect(formatDuration(60000)).toBe("1m0s");
        expect(formatDuration(90000)).toBe("1m30s");
        expect(formatDuration(125000)).toBe("2m5s");
    });
});

// ── formatUsageStats ─────────────────────────────────────────────────

describe("formatUsageStats", () => {
    it("returns empty string for zero usage", () => {
        expect(formatUsageStats(createZeroUsage())).toBe("");
    });

    it("includes all token and cost fields when present", () => {
        const usage = {
            ...createZeroUsage(),
            inputTokens: 1500,
            outputTokens: 500,
            cacheReadTokens: 3000,
            cacheWriteTokens: 100,
            contextTokens: 4600,
            cost: {
                input: 0.001,
                output: 0.002,
                cacheRead: 0.001,
                cacheWrite: 0,
                total: 0.004,
            },
            turns: 2,
        };
        const result = formatUsageStats(usage, 10000);
        expect(result).toContain("\u21911.5k");
        expect(result).toContain("\u2193500");
        expect(result).toContain("R3.0k");
        expect(result).toContain("W100");
        expect(result).toContain("CH");
        expect(result).toContain("ctx 46%/10k");
        expect(result).toContain("$0.0040");
        expect(result).not.toContain("turn");
        expect(result).not.toContain("tool");
    });

    it("calculates cache hit ratio correctly", () => {
        const usage = {
            ...createZeroUsage(),
            inputTokens: 500,
            cacheReadTokens: 1500,
            cacheWriteTokens: 0,
            turns: 1,
        };
        const result = formatUsageStats(usage);
        // cacheRead / (input + cacheRead + cacheWrite) = 1500/2000 = 75%
        expect(result).toContain("CH75%");
    });

    it("does not include turns or tool counts", () => {
        const usage = { ...createZeroUsage(), inputTokens: 100, turns: 3 };
        const result = formatUsageStats(usage);
        expect(result).toContain("\u2191100");
        expect(result).not.toContain("turn");
        expect(result).not.toContain("tool");
    });
});

// ── getDisplayItems ──────────────────────────────────────────────────

describe("getDisplayItems", () => {
    it("returns empty array for empty messages", () => {
        expect(getDisplayItems([])).toEqual([]);
    });

    it("produces correct DisplayItem sequence from mixed messages", () => {
        const messages: Message[] = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "hello" },
                    {
                        type: "toolCall",
                        id: "tc1",
                        name: "bash",
                        arguments: { command: "ls" },
                    },
                ],
            },
            {
                role: "toolResult",
                toolCallId: "tc1",
                content: [{ type: "text", text: "files" }],
                isError: false,
            },
            {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: "tc2",
                        name: "read",
                        arguments: { path: "/a.txt" },
                    },
                ],
            },
        ] as Message[];

        const items = getDisplayItems(messages);
        expect(items).toHaveLength(3);
        expect(items[0]).toEqual({ type: "text", text: "hello" });
        expect(items[1]).toMatchObject({
            type: "toolCall",
            name: "bash",
            status: "success",
        });
        expect(items[2]).toMatchObject({
            type: "toolCall",
            name: "read",
            status: "pending",
        });
    });
});

// ── getFinalOutput ───────────────────────────────────────────────────

describe("getFinalOutput", () => {
    it("returns empty string for no assistant messages", () => {
        const messages: Message[] = [
            { role: "user", content: [{ type: "text", text: "hi" }] },
        ] as Message[];
        expect(getFinalOutput(messages)).toBe("");
    });

    it("returns first text part from latest assistant message with text", () => {
        const messages: Message[] = [
            {
                role: "assistant",
                content: [{ type: "text", text: "first" }],
            },
            { role: "user", content: [{ type: "text", text: "q" }] },
            {
                role: "assistant",
                content: [
                    { type: "toolCall", id: "x", name: "bash", arguments: {} },
                ],
            },
            {
                role: "assistant",
                content: [{ type: "text", text: "final answer" }],
            },
        ] as Message[];
        expect(getFinalOutput(messages)).toBe("final answer");
    });
});

// ── AgentOutcome variants ────────────────────────────────────────────

describe("AgentOutcome variants", () => {
    it("success variant accepts optional stopReason", () => {
        const outcome: AgentOutcome = { status: "success", stopReason: "end_turn" };
        expect(outcome.status).toBe("success");
        expect(outcome.stopReason).toBe("end_turn");
    });

    it("success variant with no stopReason", () => {
        const outcome: AgentOutcome = { status: "success" };
        expect(outcome.status).toBe("success");
        expect(outcome.stopReason).toBeUndefined();
    });

    it("error variant requires exitCode and message", () => {
        const outcome: AgentOutcome = {
            status: "error",
            exitCode: 1,
            message: "spawn failed",
            stopReason: "error",
        };
        expect(outcome.status).toBe("error");
        expect(outcome.exitCode).toBe(1);
        expect(outcome.message).toBe("spawn failed");
    });

    it("aborted variant accepts optional message", () => {
        const outcome: AgentOutcome = {
            status: "aborted",
            message: "user cancelled",
        };
        expect(outcome.status).toBe("aborted");
        expect(outcome.message).toBe("user cancelled");
    });
});

// ── isSubagentError ──────────────────────────────────────────────────

describe("isSubagentError", () => {
    it("returns true for error outcome", () => {
        expect(
            isSubagentError(
                makeResult({
                    outcome: { status: "error", exitCode: 1, message: "failed" },
                }),
            ),
        ).toBe(true);
    });

    it("returns true for aborted outcome", () => {
        expect(
            isSubagentError(
                makeResult({
                    outcome: { status: "aborted" },
                }),
            ),
        ).toBe(true);
    });

    it("returns false for success outcome", () => {
        expect(
            isSubagentError(
                makeResult({
                    outcome: { status: "success", stopReason: "end_turn" },
                }),
            ),
        ).toBe(false);
    });

    it("returns false for success outcome without stopReason", () => {
        expect(
            isSubagentError(
                makeResult({
                    outcome: { status: "success" },
                }),
            ),
        ).toBe(false);
    });
});

// ── SubagentDetails discriminated union ──────────────────────────────

describe("SubagentDetails unified shape", () => {
    it("foreground has kind='foreground' with execStatuses", () => {
        const details: SubagentDetails = {
            kind: "foreground",
            result: makeResult(),
            execStatuses: { tc1: false, tc2: true },
        };
        expect(details.kind).toBe("foreground");
        expect(details.execStatuses).toEqual({ tc1: false, tc2: true });
    });

    it("background has kind='background', description, cancelled", () => {
        const details: SubagentDetails = {
            kind: "background",
            result: makeResult(),
            description: "find auth files",
            cancelled: false,
        };
        expect(details.kind).toBe("background");
        expect(details.description).toBe("find auth files");
        expect(details.cancelled).toBe(false);
    });
});

// ── createZeroUsage new fields ───────────────────────────────────────

describe("createZeroUsage", () => {
    it("returns object with new field names all zero", () => {
        const usage = createZeroUsage();
        expect(usage.inputTokens).toBe(0);
        expect(usage.outputTokens).toBe(0);
        expect(usage.cacheReadTokens).toBe(0);
        expect(usage.cacheWriteTokens).toBe(0);
        expect(usage.contextTokens).toBe(0);
        expect(usage.cost.total).toBe(0);
        expect(usage.turns).toBe(0);
    });

    it("does not have totalTokens field", () => {
        const usage = createZeroUsage() as unknown as Record<string, unknown>;
        expect("totalTokens" in usage).toBe(false);
    });
});

// ── renderSubagentResult ─────────────────────────────────────────────

describe("renderSubagentResult", () => {
    it("collapsed success includes recent tools and usage line", () => {
        const messages: Message[] = [
            {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: "t1",
                        name: "bash",
                        arguments: { command: "ls" },
                    },
                    {
                        type: "toolCall",
                        id: "t2",
                        name: "read",
                        arguments: { path: "/a" },
                    },
                ],
            },
            {
                role: "toolResult",
                toolCallId: "t1",
                content: [{ type: "text", text: "ok" }],
                isError: false,
            },
            {
                role: "toolResult",
                toolCallId: "t2",
                content: [{ type: "text", text: "ok" }],
                isError: false,
            },
            {
                role: "assistant",
                content: [{ type: "text", text: "Done" }],
            },
        ] as Message[];

        const details: SubagentDetails = {
            kind: "foreground",
            result: makeResult({
                messages,
                usage: {
                    ...createZeroUsage(),
                    inputTokens: 100,
                    outputTokens: 50,
                    turns: 1,
                },
                durationMs: 1000,
            }),
            execStatuses: {},
        };

        const component = renderSubagentResult(details, false, makeTheme());
        // Renders as Text for collapsed view
        const rendered = component.render(80);
        expect(rendered.length).toBeGreaterThan(0);
        const text = rendered.join("\n");
        // Completed foreground shows final output preview, not tool calls
        expect(text).toContain("Done");
        expect(text).toContain("1 turn");
    });

    it("expanded error includes task, tools, and error message", () => {
        const messages: Message[] = [
            {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: "t1",
                        name: "bash",
                        arguments: { command: "fail" },
                    },
                ],
            },
            {
                role: "toolResult",
                toolCallId: "t1",
                content: [{ type: "text", text: "err" }],
                isError: true,
            },
        ] as Message[];

        const details: SubagentDetails = {
            kind: "foreground",
            result: makeResult({
                outcome: {
                    status: "error",
                    exitCode: 1,
                    stopReason: "error",
                    message: "command failed",
                },
                messages,
                usage: { ...createZeroUsage(), turns: 1 },
            }),
            execStatuses: { t1: true },
        };

        const component = renderSubagentResult(details, true, makeTheme());
        const rendered = component.render(80);
        const text = rendered.join("\n");
        expect(text).toContain("Task");
        expect(text).toContain("Output");
        expect(text).toContain("bash");
    });
});

// ── renderSubagentResult (background) ─────────────────────────────────

describe("renderSubagentResult (background)", () => {
    it("renders completed result with header and output", () => {
        const messages: Message[] = [
            {
                role: "assistant",
                content: [{ type: "text", text: "Found 5 files" }],
            },
        ] as Message[];

        const details: SubagentDetails = {
            kind: "background",
            result: makeResult({
                messages,
                usage: { ...createZeroUsage(), inputTokens: 200, turns: 1 },
            }),
            execStatuses: {},
            description: "find files",
            cancelled: false,
        };

        const component = renderSubagentResult(details, false, makeTheme());
        const rendered = component.render(80);
        const text = rendered.join("\n");
        expect(text).toContain("background agent");
        expect(text).toContain("[completed]");
        expect(text).toContain("find files");
    });

    it("renders cancelled result without requiring output", () => {
        const details: SubagentDetails = {
            kind: "background",
            result: makeResult({ outcome: { status: "success" }, messages: [] }),
            execStatuses: {},
            description: "cancelled task",
            cancelled: true,
        };

        const component = renderSubagentResult(details, false, makeTheme());
        const rendered = component.render(80);
        const text = rendered.join("\n");
        expect(text).toContain("[cancelled]");
        expect(text).toContain("cancelled task");
    });

    it("renders old serialized running state gracefully (backward compat)", () => {
        // Old sessions may still have outcome.status === "running" in
        // persisted data. The renderer handles this at runtime even
        // though it's no longer in the AgentOutcome type.
        const details: SubagentDetails = {
            kind: "background",
            result: makeResult({
                outcome: { status: "running" } as any,
                task: "explore codebase",
            }),
            execStatuses: {},
            resolvedAgent: {
                name: "scout",
                model: parseModelString("deepseek/deepseek-v4-flash")!,
                source: "system",
            },
            description: "find files",
            cancelled: false,
        };

        const component = renderSubagentResult(details, false, makeTheme());
        const rendered = component.render(80);
        const text = rendered.join("\n");
        expect(text).toContain("background agent");
        expect(text).toContain("[running]");
        // Model now in header line (not separate line below)
        expect(text).toContain("deepseek/deepseek-v4-flash");
    });

    it("includes model in background header, not in last line", () => {
        const details: SubagentDetails = {
            kind: "background",
            result: makeResult({
                messages: [
                    {
                        role: "assistant",
                        content: [{ type: "text", text: "result" }],
                    },
                ] as Message[],
                usage: {
                    ...createZeroUsage(),
                    inputTokens: 100,
                    turns: 1,
                },
                durationMs: 2000,
            }),
            execStatuses: {},
            resolvedAgent: {
                name: "scout",
                model: parseModelString("anthropic/claude-sonnet")!,
                source: "system",
            },
            description: "do work",
            cancelled: false,
        };

        const component = renderSubagentResult(details, false, makeTheme());
        const rendered = component.render(80);
        const text = rendered.join("\n");
        // Model appears in header area (before status/description)
        expect(text).toContain("anthropic/claude-sonnet");
        const modelIdx = text.indexOf("anthropic/claude-sonnet");
        const statusIdx = text.indexOf("[completed]");
        expect(modelIdx).toBeLessThan(statusIdx);
        // Last non-empty line has stats but NOT model
        const lastNonEmpty = rendered.filter((l) => l.trim().length > 0).pop() || "";
        expect(lastNonEmpty).toContain("1 turn");
        expect(lastNonEmpty).not.toContain("anthropic/claude-sonnet");
    });
});

// ── accumulateUsage maps framework fields ────────────────────────────

describe("accumulateUsage integration", () => {
    it("createZeroUsage followed by manual accumulation produces correct totals", () => {
        const usage = createZeroUsage();
        usage.inputTokens += 100;
        usage.outputTokens += 50;
        usage.cacheReadTokens += 200;
        usage.turns = 1;

        const line = formatUsageStats(usage);
        expect(line).toContain("\u2191100");
        expect(line).toContain("\u219350");
        expect(line).toContain("R200");
    });
});
