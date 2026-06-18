/**
 * Unit tests for resolve.ts pure functions.
 *
 * Covers: resolveSkills, resolveAgentConfig, persistAgent,
 * hydrateResolvedAgent.
 */

import { describe, expect, it } from "vitest";
import {
    hydrateResolvedAgent,
    persistAgent,
    resolveAgentConfig,
    resolveSkills,
} from "../extensions/subagent/resolve.js";
import type {
    AgentSpec,
    ResolvedAgent,
    SubagentToolParams,
} from "../extensions/subagent/types.js";
import {
    formatModelString,
    parseModelString,
} from "../extensions/subagent/types.js";

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
        model: parseModelString("anthropic/claude-sonnet", 100000)!,
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
        model: {
            provider: "anthropic",
            id: "claude-sonnet",
            contextWindow: 200000,
        },
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

function makeResolveOpts(ctx: any, parentThinkingLevel?: string) {
    return {
        parentModel: ctx.model
            ? {
                  provider: ctx.model.provider,
                  name: ctx.model.id,
                  thinkingLevel: parentThinkingLevel,
                  contextWindow: ctx.model.contextWindow,
              }
            : undefined,
        getContextWindow: (provider: string, name: string) =>
            ctx.modelRegistry.find(provider, name)?.contextWindow,
    };
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
        const result = resolveAgentConfig(
            params,
            agents,
            new Map(),
            makeResolveOpts(ctx),
        );
        expect(typeof result).toBe("object");
        if (typeof result === "object") {
            expect(result.name).toBe("scout");
            expect(formatModelString(result.model)).toBe("deepseek/v4");
            expect(result.model.contextWindow).toBe(100000);
            expect(result.systemPrompt).toBe("You are a scout.");
            expect(result.source).toBe("system");
        }
    });

    it("returns error for unknown agent", () => {
        const agents = [makeAgentSpec({ name: "worker" })];
        const ctx = makeMockCtx();
        const result = resolveAgentConfig(
            params,
            agents,
            new Map(),
            makeResolveOpts(ctx),
        );
        expect(typeof result).toBe("string");
        expect(result).toContain('Unknown agent: "scout"');
        expect(result).toContain('Available agents: "worker"');
    });

    it("returns error when no agents exist", () => {
        const ctx = makeMockCtx();
        const result = resolveAgentConfig(
            params,
            [],
            new Map(),
            makeResolveOpts(ctx),
        );
        expect(typeof result).toBe("string");
        expect(result).toContain("none");
    });

    it("uses param model override over agent default", () => {
        const agents = [makeAgentSpec({ name: "scout", model: "deepseek/v4" })];
        const ctx = makeMockCtx();
        const overrideParams = { ...params, model: "anthropic/opus" };
        const result = resolveAgentConfig(
            overrideParams,
            agents,
            new Map(),
            makeResolveOpts(ctx),
        );
        if (typeof result === "object") {
            expect(formatModelString(result.model)).toBe("anthropic/opus");
        }
    });

    it("constructs the structured model from parent ctx when agent has no model", () => {
        const agents = [makeAgentSpec({ name: "scout", model: undefined })];
        const ctx = makeMockCtx({
            modelRegistry: {
                find: () => {
                    throw new Error("parent model should not use registry lookup");
                },
            },
        });
        const result = resolveAgentConfig(
            params,
            agents,
            new Map(),
            makeResolveOpts(ctx, "high"),
        );
        if (typeof result === "object") {
            expect(result.model).toEqual({
                provider: "anthropic",
                name: "claude-sonnet",
                thinkingLevel: "high",
                contextWindow: 200000,
            });
        }
    });

    it("omits parent thinking suffix when parent thinking is off", () => {
        const agents = [makeAgentSpec({ name: "scout", model: undefined })];
        const ctx = makeMockCtx();
        const result = resolveAgentConfig(
            params,
            agents,
            new Map(),
            makeResolveOpts(ctx),
        );
        if (typeof result === "object") {
            expect(result.model.thinkingLevel).toBeUndefined();
            expect(formatModelString(result.model)).toBe("anthropic/claude-sonnet");
        }
    });

    it("returns error when no model is available at all", () => {
        const agents = [makeAgentSpec({ name: "scout", model: undefined })];
        const ctx = makeMockCtx({ model: null });
        const result = resolveAgentConfig(
            params,
            agents,
            new Map(),
            makeResolveOpts(ctx),
        );
        expect(typeof result).toBe("string");
        expect(result).toContain("No model available");
    });

    it("returns skill error when unknown skills requested", () => {
        const agents = [makeAgentSpec({ name: "scout" })];
        const ctx = makeMockCtx();
        const skillParams = { ...params, skills: ["unknown"] };
        const result = resolveAgentConfig(
            skillParams,
            agents,
            new Map(),
            makeResolveOpts(ctx),
        );
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
        const result = resolveAgentConfig(
            params,
            agents,
            cache,
            makeResolveOpts(ctx),
        );
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
        const result = resolveAgentConfig(
            skillParams,
            agents,
            cache,
            makeResolveOpts(ctx),
        );
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
        const result = resolveAgentConfig(
            skillParams,
            agents,
            new Map(),
            makeResolveOpts(ctx),
        );
        if (typeof result === "object") {
            expect(result.skillPaths).toBeUndefined();
        }
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
        expect(formatModelString(persisted.model)).toBe("anthropic/claude-sonnet");
        expect(persisted.tools).toEqual(["read", "bash"]);
    });

    it("handles empty systemPrompt", () => {
        const agent = makeResolvedAgent({ systemPrompt: "" });
        const persisted = persistAgent(agent);
        expect(persisted).not.toHaveProperty("systemPrompt");
    });
});

// ── hydrateResolvedAgent ─────────────────────────────────────────────

describe("hydrateResolvedAgent", () => {
    it("returns ResolvedAgent when agent found in registry", () => {
        const persisted = persistAgent(makeResolvedAgent());
        const agents = [
            makeAgentSpec({
                name: "scout",
                systemPrompt: "You are a scout.",
            }),
        ];
        const result = hydrateResolvedAgent(persisted, agents);
        expect(result).toBeDefined();
        expect(result!.name).toBe("scout");
        expect(result!.systemPrompt).toBe("You are a scout.");
    });

    it("returns undefined when agent not in list", () => {
        const persisted = persistAgent(makeResolvedAgent({ name: "unknown" }));
        const agents = [makeAgentSpec({ name: "scout" })];
        const result = hydrateResolvedAgent(persisted, agents);
        expect(result).toBeUndefined();
    });

    it("preserves all persisted fields (model, tools, skillPaths, source)", () => {
        const original = makeResolvedAgent({
            name: "worker",
            tools: ["read", "write", "bash"],
            skillPaths: ["/path/to/skill1", "/path/to/skill2"],
            model: parseModelString("openai/gpt-4o:high", 128000)!,
            source: "user",
            systemPrompt: "You are a worker.",
        });
        const persisted = persistAgent(original);
        const agents = [
            makeAgentSpec({
                name: "worker",
                systemPrompt: "You are a worker.",
            }),
        ];
        const result = hydrateResolvedAgent(persisted, agents);
        expect(result).toBeDefined();
        expect(result!.name).toBe("worker");
        expect(result!.tools).toEqual(["read", "write", "bash"]);
        expect(result!.skillPaths).toEqual(["/path/to/skill1", "/path/to/skill2"]);
        expect(result!.model).toEqual(
            parseModelString("openai/gpt-4o:high", 128000),
        );
        expect(result!.source).toBe("user");
        expect(result!.systemPrompt).toBe("You are a worker.");
    });

    it("uses systemPrompt from registry, not from persisted (it has none)", () => {
        const persisted = persistAgent(makeResolvedAgent({ name: "scout" }));
        const agents = [
            makeAgentSpec({
                name: "scout",
                systemPrompt: "Updated prompt.",
            }),
        ];
        const result = hydrateResolvedAgent(persisted, agents);
        expect(result!.systemPrompt).toBe("Updated prompt.");
    });
});
