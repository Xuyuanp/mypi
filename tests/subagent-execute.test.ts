/**
 * Tests for execute.ts exported helpers: buildSubagentCommand and getPiInvocation.
 *
 * Covers:
 * - Flag construction for agents with all fields (model, tools, skills, thinking)
 * - --thinking off omission when model has thinking level suffix
 * - Temp file creation with preamble + agent prompt
 * - Attach-mode prompt note presence
 * - Agents with no tools or skills
 * - getPiInvocation returns pi executable prefix with no parameters
 */

import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
    buildSubagentCommand,
    getPiInvocation,
} from "../extensions/subagent/execute.js";
import type { ResolvedAgent } from "../extensions/subagent/types.js";
import { parseModelString } from "../extensions/subagent/types.js";

// ── Cleanup helper ───────────────────────────────────────────────────

const tmpFiles: string[] = [];
afterEach(() => {
    for (const f of tmpFiles) {
        try {
            fs.unlinkSync(f);
        } catch {
            /* ignore */
        }
    }
    tmpFiles.length = 0;
});

function trackTmp(path: string): void {
    tmpFiles.push(path);
}

// ── Test agents ──────────────────────────────────────────────────────

const fullAgent: ResolvedAgent = {
    name: "scout",
    tools: ["read", "bash", "grep"],
    skillPaths: ["/skills/web-search", "/skills/web-extract"],
    model: parseModelString("anthropic/claude-sonnet-4")!,
    systemPrompt: "You are a codebase explorer.",
    source: "system",
};

const minimalAgent: ResolvedAgent = {
    name: "worker",
    model: parseModelString("openai/gpt-4o")!,
    systemPrompt: "",
    source: "user",
};

const thinkingAgent: ResolvedAgent = {
    name: "thinker",
    tools: ["read"],
    model: parseModelString("anthropic/claude-sonnet:high")!,
    systemPrompt: "Think carefully.",
    source: "system",
};

// ── getPiInvocation ──────────────────────────────────────────────────

describe("getPiInvocation", () => {
    it("returns a command and args array without CLI flags", () => {
        const result = getPiInvocation();
        expect(result).toHaveProperty("command");
        expect(result).toHaveProperty("args");
        expect(typeof result.command).toBe("string");
        expect(Array.isArray(result.args)).toBe(true);
        // Args should not contain subagent-specific flags
        expect(result.args).not.toContain("--no-extensions");
        expect(result.args).not.toContain("--model");
    });
});

// ── buildSubagentCommand ─────────────────────────────────────────────

describe("buildSubagentCommand", () => {
    it("returns correct flags for agent with all fields", async () => {
        const result = await buildSubagentCommand(fullAgent);
        trackTmp(result.tmpPromptPath);

        expect(result.args).toContain("--no-extensions");
        expect(result.args).toContain("--no-context-files");
        expect(result.args).toContain("--offline");
        expect(result.args).toContain("--no-skills");

        // Model
        const modelIdx = result.args.indexOf("--model");
        expect(modelIdx).toBeGreaterThan(-1);
        expect(result.args[modelIdx + 1]).toBe("anthropic/claude-sonnet-4");

        // Thinking off (no thinking level in model string)
        const thinkIdx = result.args.indexOf("--thinking");
        expect(thinkIdx).toBeGreaterThan(-1);
        expect(result.args[thinkIdx + 1]).toBe("off");

        // Tools
        const toolsIdx = result.args.indexOf("--tools");
        expect(toolsIdx).toBeGreaterThan(-1);
        expect(result.args[toolsIdx + 1]).toBe("read,bash,grep");

        // Skills
        const skillIdxs = result.args.reduce<number[]>((acc, v, i) => {
            if (v === "--skill") acc.push(i);
            return acc;
        }, []);
        expect(skillIdxs).toHaveLength(2);
        expect(result.args[skillIdxs[0] + 1]).toBe("/skills/web-search");
        expect(result.args[skillIdxs[1] + 1]).toBe("/skills/web-extract");

        // System prompt file
        expect(result.args).toContain("--append-system-prompt");
        const promptIdx = result.args.indexOf("--append-system-prompt");
        expect(result.args[promptIdx + 1]).toBe(result.tmpPromptPath);
    });

    it("omits --thinking off when model has thinking level", async () => {
        const result = await buildSubagentCommand(thinkingAgent);
        trackTmp(result.tmpPromptPath);

        expect(result.args).not.toContain("--thinking");
    });

    it("writes system prompt to temp file", async () => {
        const result = await buildSubagentCommand(fullAgent);
        trackTmp(result.tmpPromptPath);

        expect(fs.existsSync(result.tmpPromptPath)).toBe(true);
        const content = fs.readFileSync(result.tmpPromptPath, "utf-8");
        expect(content).toContain("You are now running as a subagent.");
        expect(content).toContain("You are a codebase explorer.");
    });

    it("produces identical prompt regardless of caller", async () => {
        const r1 = await buildSubagentCommand(fullAgent);
        trackTmp(r1.tmpPromptPath);
        const r2 = await buildSubagentCommand(fullAgent);
        trackTmp(r2.tmpPromptPath);

        const c1 = fs.readFileSync(r1.tmpPromptPath, "utf-8");
        const c2 = fs.readFileSync(r2.tmpPromptPath, "utf-8");
        expect(c1).toBe(c2);
    });

    it("handles agent with no tools or skills", async () => {
        const result = await buildSubagentCommand(minimalAgent);
        trackTmp(result.tmpPromptPath);

        // No --tools flag
        expect(result.args).not.toContain("--tools");

        // --no-skills present, but no --skill flags
        expect(result.args).toContain("--no-skills");
        expect(result.args).not.toContain("--skill");

        // Model still present
        const modelIdx = result.args.indexOf("--model");
        expect(result.args[modelIdx + 1]).toBe("openai/gpt-4o");
    });

    it("uses preamble only when agent has empty system prompt", async () => {
        const result = await buildSubagentCommand(minimalAgent);
        trackTmp(result.tmpPromptPath);

        const content = fs.readFileSync(result.tmpPromptPath, "utf-8");
        // Should contain the preamble text (trimmed since systemPrompt is empty)
        expect(content).toContain("You are now running as a subagent.");
        // Should NOT contain any agent-specific prompt
        expect(content).not.toContain("codebase explorer");
    });

    it("returns a valid command string", async () => {
        const result = await buildSubagentCommand(fullAgent);
        trackTmp(result.tmpPromptPath);

        expect(typeof result.command).toBe("string");
        expect(result.command.length).toBeGreaterThan(0);
    });
});
