/**
 * Unit tests for orchestration.ts functions.
 *
 * Covers: getResultOutput, makeErrorToolResult, makeResumeErrorResult.
 */

import { describe, expect, it } from "vitest";
import {
    getResultOutput,
    makeErrorToolResult,
    makeResumeErrorResult,
} from "../extensions/subagent/orchestration.js";
import type {
    AgentRunResult,
    SubagentToolParams,
} from "../extensions/subagent/types.js";
import { createZeroUsage } from "../extensions/subagent/types.js";

// ── getResultOutput ──────────────────────────────────────────────────

describe("getResultOutput", () => {
    it("returns outcome.message for error status", () => {
        const result: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: {
                status: "error",
                exitCode: 1,
                message: "spawn ENOENT",
            },
            messages: [],
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 0,
        };
        expect(getResultOutput(result)).toBe("spawn ENOENT");
    });

    it("falls back to stderr when outcome has no message", () => {
        const result: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: {
                status: "error",
                exitCode: 1,
                message: "",
            },
            messages: [],
            stderr: "command not found",
            usage: createZeroUsage(),
            durationMs: 0,
        };
        expect(getResultOutput(result)).toBe("command not found");
    });

    it("falls back to final output from messages", () => {
        const result: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: {
                status: "error",
                exitCode: 1,
                message: "",
            },
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "text", text: "I failed" }],
                },
            ] as any,
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 0,
        };
        expect(getResultOutput(result)).toBe("I failed");
    });

    it("returns (no output) for error with no message anywhere", () => {
        const result: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: {
                status: "error",
                exitCode: 1,
                message: "",
            },
            messages: [],
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 0,
        };
        expect(getResultOutput(result)).toBe("(no output)");
    });

    it("returns outcome.message for aborted status", () => {
        const result: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: {
                status: "aborted",
                message: "user cancelled",
            },
            messages: [],
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 0,
        };
        expect(getResultOutput(result)).toBe("user cancelled");
    });

    it("returns (aborted) for aborted with no message", () => {
        const result: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: { status: "aborted" },
            messages: [],
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 0,
        };
        expect(getResultOutput(result)).toBe("(aborted)");
    });

    it("returns final output for success", () => {
        const result: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: { status: "success" },
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Found 5 files" }],
                },
            ] as any,
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 0,
        };
        expect(getResultOutput(result)).toBe("Found 5 files");
    });

    it("returns (no output) for success with no text", () => {
        const result: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: { status: "success" },
            messages: [],
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 0,
        };
        expect(getResultOutput(result)).toBe("(no output)");
    });
});

// ── makeErrorToolResult ──────────────────────────────────────────────

describe("makeErrorToolResult", () => {
    it("builds an error ToolResult with the given message", () => {
        const params: SubagentToolParams = {
            agent: "scout",
            description: "find",
            task: "search",
        };
        const result = makeErrorToolResult("something went wrong", params);

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
            { type: "text", text: "something went wrong" },
        ]);
        expect(result.details?.kind).toBe("foreground");
        expect(result.details?.result.outcome.status).toBe("error");
        expect(result.details?.result.outcome).toMatchObject({
            status: "error",
            exitCode: 1,
            message: "something went wrong",
        });
    });

    it("sets agentSource to unknown", () => {
        const params: SubagentToolParams = {
            agent: "scout",
            description: "find",
            task: "search",
        };
        const result = makeErrorToolResult("err", params);
        expect(result.details?.result.agentSource).toBe("unknown");
    });

    it("sets empty messages and execStatuses", () => {
        const params: SubagentToolParams = {
            agent: "scout",
            description: "find",
            task: "search",
        };
        const result = makeErrorToolResult("err", params);
        expect(result.details?.result.messages).toEqual([]);
        expect(result.details?.execStatuses).toEqual({});
    });
});

// ── makeResumeErrorResult ────────────────────────────────────────────

describe("makeResumeErrorResult", () => {
    it("builds error ToolResult with undefined details", () => {
        const result = makeResumeErrorResult("something went wrong");
        expect(result.isError).toBe(true);
        expect(result.details).toBeUndefined();
    });

    it("embeds message in content", () => {
        const result = makeResumeErrorResult("session not found");
        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toEqual({
            type: "text",
            text: "session not found",
        });
    });

    it("handles empty message string", () => {
        const result = makeResumeErrorResult("");
        expect(result.content[0].text).toBe("");
        expect(result.isError).toBe(true);
        expect(result.details).toBeUndefined();
    });
});
