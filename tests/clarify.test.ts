/**
 * Unit tests for the pure arg-building helpers of the clarify extension.
 *
 * No subprocess is spawned here: the child pi invocation is verified
 * manually (it needs a live provider).
 */

import { describe, expect, it } from "vitest";

import { buildClarifyArgs, formatModelString } from "../extensions/clarify.js";

const FIXED_FLAGS = [
    "--no-session",
    "--no-skills",
    "--no-extensions",
    "--no-tools",
    "--offline",
    "--no-context-files",
];

describe("formatModelString", () => {
    it("joins provider and name", () => {
        expect(
            formatModelString({
                provider: "anthropic",
                name: "claude-sonnet-4-5",
            }),
        ).toBe("anthropic/claude-sonnet-4-5");
    });

    it("appends the thinking level suffix", () => {
        expect(
            formatModelString({
                provider: "openai",
                name: "gpt-5",
                thinkingLevel: "high",
            }),
        ).toBe("openai/gpt-5:high");
    });
});

describe("buildClarifyArgs", () => {
    it("starts with print mode and the fixed flags", () => {
        const args = buildClarifyArgs(undefined, "task");
        expect(args[0]).toBe("-p");
        for (const flag of FIXED_FLAGS) {
            expect(args).toContain(flag);
        }
    });

    it("passes the rewriter system prompt", () => {
        const args = buildClarifyArgs(undefined, "task");
        const i = args.indexOf("--system-prompt");
        expect(i).toBeGreaterThan(-1);
        expect(args[i + 1]).toContain("You rewrite rough, plain-language");
    });

    it("adds the model flag when a model is active", () => {
        const args = buildClarifyArgs(
            { provider: "anthropic", name: "claude-sonnet-4-5" },
            "task",
        );
        expect(args[args.indexOf("--model") + 1]).toBe(
            "anthropic/claude-sonnet-4-5",
        );
    });

    it("omits the model flag when no model is active", () => {
        const args = buildClarifyArgs(undefined, "task");
        expect(args).not.toContain("--model");
    });

    it("keeps the task as the last argument", () => {
        const task = "make the thumbnail grow into the big image";
        const args = buildClarifyArgs(undefined, task);
        expect(args[args.length - 1]).toBe(task);
    });
});
