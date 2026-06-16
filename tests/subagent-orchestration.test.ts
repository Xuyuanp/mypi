/**
 * Unit tests for orchestration.ts pure functions.
 *
 * Covers: resolveSkills, resolveAgentConfig, resolveContextWindow,
 * deriveSessionPath, persistAgent, getResultOutput, makeErrorToolResult.
 */

import { describe, expect, it } from "vitest";
import {
    getResultOutput,
    makeErrorToolResult,
    persistAgent,
    resolveAgentConfig,
    resolveContextWindow,
    resolveSkills,
} from "../extensions/subagent/orchestration.js";
import type {
    AgentRunResult,
    AgentSpec,
    ResolvedAgent,
    SubagentToolParams,
} from "../extensions/subagent/types.js";
import { createZeroUsage } from "../extensions/subagent/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeAgentSpec(overrides?: Partial<AgentSpec>): AgentSpec {
    return {
        name: "scout",
        description: "explore",
        systemPrompt: "You are a scout.",
        source: "system",
        filePath: "/abs/scout.md",
        ...overrides,
    };
}

function makeResolvedAgent(overrides?: Partial<ResolvedAgent>): ResolvedAgent {
    return {
        name: "scout",
        tools: ["read", "bash"],
        model: "anthropic/claude-sonnet",
        systemPrompt: "You are a scout.",
        source: "system",
        ...overrides,
    };
}

function makeSkillCache(
    skills: { name: string; filePath: string }[],
): Map<string, any> {
    return new Map(skills.map((s) => [s.name, s]));
}

function makeMockCtx(overrides?: Record<string, unknown>) {
    return {
        model: { provider: "anthropic", id: "claude-sonnet", contextWindow: 200000 },
        modelRegistry: {
            find: (_provider: string, _id: string) => ({
                contextWindow: 100000,
            }),
        },
        sessionManager: {
            getSessionFile: () => "/tmp/sessions/abc123.jsonl",
        },
        ...overrides,
    } as any;
}

// ── resolveSkills ────────────────────────────────────────────────────

describe("resolveSkills", () => {
    it("returns undefined paths when no skill names provided", () => {
        const result = resolveSkills(undefined, new Map());
        expect(result.paths).toBeUndefined();
        expect(result.error).toBeUndefined();
    });

    it("returns undefined paths for empty array", () => {
        const result = resolveSkills([], new Map());
        expect(result.paths).toBeUndefined();
    });

    it("resolves known skill names to file paths", () => {
        const cache = makeSkillCache([
            { name: "code-review", filePath: "/abs/skills/code-review.md" },
            { name: "testing", filePath: "/abs/skills/testing.md" },
        ]);
        const result = resolveSkills(["code-review", "testing"], cache);
        expect(result.paths).toEqual([
            "/abs/skills/code-review.md",
            "/abs/skills/testing.md",
        ]);
    });

    it("returns error for unknown skill names", () => {
        const cache = makeSkillCache([
            { name: "code-review", filePath: "/abs/skills/code-review.md" },
        ]);
        const result = resolveSkills(["unknown-skill"], cache);
        expect(result.error).toBeDefined();
        expect(result.error).toContain('Unknown skill: "unknown-skill"');
        expect(result.error).toContain('Available: "code-review"');
        expect(result.paths).toBeUndefined();
    });

    it("returns error with multiple unknown skills", () => {
        const cache = makeSkillCache([
            { name: "code-review", filePath: "/abs/skills/code-review.md" },
        ]);
        const result = resolveSkills(["a", "b"], cache);
        expect(result.error).toContain('Unknown skills: "a", "b"');
    });

    it("returns 'none (skill cache empty)' when cache is empty", () => {
        const result = resolveSkills(["anything"], new Map());
        expect(result.error).toContain("none (skill cache empty)");
    });
});

// ── resolveAgentConfig ───────────────────────────────────────────────

describe("resolveAgentConfig", () => {
    const params: SubagentToolParams = {
        agent: "scout",
        description: "find files",
        task: "search for auth",
    };

    it("resolves a known agent with default model", () => {
        const agents = [makeAgentSpec({ name: "scout", model: "deepseek/v4" })];
        const ctx = makeMockCtx();
        const result = resolveAgentConfig(params, agents, new Map(), ctx);
        expect(typeof result).toBe("object");
        if (typeof result === "object") {
            expect(result.name).toBe("scout");
            expect(result.model).toBe("deepseek/v4");
            expect(result.systemPrompt).toBe("You are a scout.");
            expect(result.source).toBe("system");
        }
    });

    it("returns error for unknown agent", () => {
        const agents = [makeAgentSpec({ name: "worker" })];
        const ctx = makeMockCtx();
        const result = resolveAgentConfig(params, agents, new Map(), ctx);
        expect(typeof result).toBe("string");
        expect(result).toContain('Unknown agent: "scout"');
        expect(result).toContain('Available agents: "worker"');
    });

    it("returns error when no agents exist", () => {
        const ctx = makeMockCtx();
        const result = resolveAgentConfig(params, [], new Map(), ctx);
        expect(typeof result).toBe("string");
        expect(result).toContain("none");
    });

    it("uses param model override over agent default", () => {
        const agents = [makeAgentSpec({ name: "scout", model: "deepseek/v4" })];
        const ctx = makeMockCtx();
        const overrideParams = { ...params, model: "anthropic/opus" };
        const result = resolveAgentConfig(overrideParams, agents, new Map(), ctx);
        if (typeof result === "object") {
            expect(result.model).toBe("anthropic/opus");
        }
    });

    it("falls back to parent model when agent has no model", () => {
        const agents = [makeAgentSpec({ name: "scout", model: undefined })];
        const ctx = makeMockCtx();
        const result = resolveAgentConfig(params, agents, new Map(), ctx);
        if (typeof result === "object") {
            expect(result.model).toBe("anthropic/claude-sonnet");
        }
    });

    it("returns error when no model is available at all", () => {
        const agents = [makeAgentSpec({ name: "scout", model: undefined })];
        const ctx = makeMockCtx({ model: null });
        const result = resolveAgentConfig(params, agents, new Map(), ctx);
        expect(typeof result).toBe("string");
        expect(result).toContain("No model available");
    });

    it("returns skill error when unknown skills requested", () => {
        const agents = [makeAgentSpec({ name: "scout" })];
        const ctx = makeMockCtx();
        const skillParams = { ...params, skills: ["unknown"] };
        const result = resolveAgentConfig(skillParams, agents, new Map(), ctx);
        expect(typeof result).toBe("string");
        expect(result).toContain("Unknown skill");
    });

    it("uses agent skillNames when params.skills is undefined", () => {
        const agents = [
            makeAgentSpec({
                name: "scout",
                skillNames: ["code-review"],
            }),
        ];
        const ctx = makeMockCtx();
        const cache = makeSkillCache([
            { name: "code-review", filePath: "/abs/skills/cr.md" },
        ]);
        const result = resolveAgentConfig(params, agents, cache, ctx);
        if (typeof result === "object") {
            expect(result.skillPaths).toEqual(["/abs/skills/cr.md"]);
        }
    });

    it("params.skills overrides agent.skillNames", () => {
        const agents = [
            makeAgentSpec({
                name: "scout",
                skillNames: ["code-review"],
            }),
        ];
        const ctx = makeMockCtx();
        const cache = makeSkillCache([
            { name: "testing", filePath: "/abs/skills/testing.md" },
        ]);
        const skillParams = { ...params, skills: ["testing"] };
        const result = resolveAgentConfig(skillParams, agents, cache, ctx);
        if (typeof result === "object") {
            expect(result.skillPaths).toEqual(["/abs/skills/testing.md"]);
        }
    });

    it("empty params.skills overrides agent.skillNames (no skills)", () => {
        const agents = [
            makeAgentSpec({
                name: "scout",
                skillNames: ["code-review"],
            }),
        ];
        const ctx = makeMockCtx();
        const skillParams = { ...params, skills: [] };
        const result = resolveAgentConfig(skillParams, agents, new Map(), ctx);
        if (typeof result === "object") {
            expect(result.skillPaths).toBeUndefined();
        }
    });
});

// ── resolveContextWindow ─────────────────────────────────────────────

describe("resolveContextWindow", () => {
    it("returns parent model context window when modelStr is undefined", () => {
        const ctx = makeMockCtx();
        expect(resolveContextWindow(undefined, ctx)).toBe(200000);
    });

    it("returns parent model context window when modelStr has no slash", () => {
        const ctx = makeMockCtx();
        expect(resolveContextWindow("claude-sonnet", ctx)).toBe(200000);
    });

    it("looks up model in registry when modelStr has provider/id", () => {
        const ctx = makeMockCtx();
        expect(resolveContextWindow("deepseek/deepseek-v4-flash", ctx)).toBe(100000);
    });

    it("strips thinking level suffix from model string", () => {
        const ctx = makeMockCtx();
        expect(resolveContextWindow("anthropic/claude-sonnet:high", ctx)).toBe(
            100000,
        );
    });

    it("returns undefined when parent model is null", () => {
        const ctx = makeMockCtx({ model: null });
        expect(resolveContextWindow(undefined, ctx)).toBeUndefined();
    });

    it("falls back to parent context window when registry lookup fails", () => {
        const ctx = makeMockCtx({
            modelRegistry: {
                find: () => undefined,
            },
        });
        expect(resolveContextWindow("unknown/provider", ctx)).toBe(200000);
    });
});

// ── persistAgent ─────────────────────────────────────────────────────

describe("persistAgent", () => {
    it("strips systemPrompt from ResolvedAgent", () => {
        const agent = makeResolvedAgent({
            systemPrompt: "You are a helpful assistant.",
        });
        const persisted = persistAgent(agent);
        expect(persisted).not.toHaveProperty("systemPrompt");
        expect(persisted.name).toBe("scout");
        expect(persisted.model).toBe("anthropic/claude-sonnet");
        expect(persisted.tools).toEqual(["read", "bash"]);
    });

    it("handles empty systemPrompt", () => {
        const agent = makeResolvedAgent({ systemPrompt: "" });
        const persisted = persistAgent(agent);
        expect(persisted).not.toHaveProperty("systemPrompt");
    });
});

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
