/**
 * Tests for the `/subagent` command's pure row-building logic.
 *
 * Covers `buildAgentRows` (order preservation, default-model labeling,
 * description flattening, file-path passthrough), `computeColumnWidths`
 * (graceful degradation on narrow terminals), and `clamp` (selection/scroll
 * bounds).
 */

import { describe, expect, it } from "vitest";
import {
    buildAgentRows,
    buildTmuxArgs,
    COL_GAP,
    clamp,
    computeColumnWidths,
    type PaneDirection,
    shellQuote,
} from "../extensions/subagent/command.js";
import type { AgentSpec } from "../extensions/subagent/types.js";

const agent = (overrides: Partial<AgentSpec>): AgentSpec => ({
    name: "scout",
    description: "explore the codebase",
    systemPrompt: "",
    source: "system",
    filePath: "/abs/scout.md",
    ...overrides,
});

describe("buildAgentRows", () => {
    it("preserves the discovery order", () => {
        const rows = buildAgentRows([
            agent({ name: "scout", source: "system" }),
            agent({ name: "worker", source: "user" }),
            agent({ name: "reviewer", source: "system" }),
        ]);

        expect(rows.map((r) => r.name)).toEqual(["scout", "worker", "reviewer"]);
        expect(rows.map((r) => r.source)).toEqual(["system", "user", "system"]);
    });

    it("uses the agent model when present and a default label otherwise", () => {
        const rows = buildAgentRows([
            agent({ name: "a", model: "anthropic/claude-haiku-4-5" }),
            agent({ name: "b", model: undefined }),
        ]);

        expect(rows.map((r) => r.model)).toEqual([
            "anthropic/claude-haiku-4-5",
            "(default)",
        ]);
    });

    it("flattens multiline/whitespace descriptions to a single line", () => {
        const rows = buildAgentRows([
            agent({ description: "Explore.\n\n  Find  files\twith  spaces." }),
        ]);

        expect(rows[0].description).toBe("Explore. Find files with spaces.");
    });

    it("passes through the agent file path for the detail overlay", () => {
        const rows = buildAgentRows([
            agent({ name: "scout", filePath: "/abs/agents/scout.md" }),
        ]);

        expect(rows[0].filePath).toBe("/abs/agents/scout.md");
    });

    it("handles an empty agent list", () => {
        expect(buildAgentRows([])).toEqual([]);
    });
});

describe("clamp", () => {
    it("returns the value when already in range", () => {
        expect(clamp(3, 0, 10)).toBe(3);
    });

    it("clamps below the minimum and above the maximum", () => {
        expect(clamp(-5, 0, 10)).toBe(0);
        expect(clamp(42, 0, 10)).toBe(10);
    });

    it("returns min when the range is inverted (max < min)", () => {
        // Happens when content is shorter than the viewport: maxScroll() is 0
        // while a stale offset could be larger; clamp must collapse to 0.
        expect(clamp(5, 0, -3)).toBe(0);
    });

    it("hits the boundaries exactly", () => {
        expect(clamp(0, 0, 10)).toBe(0);
        expect(clamp(10, 0, 10)).toBe(10);
    });
});

describe("computeColumnWidths", () => {
    const longRows = buildAgentRows([
        agent({
            name: "a_very_long_agent_name_exceeding_cap",
            description: "x",
            model: "some/very-long-model-identifier-exceeding-the-cap",
            source: "system",
        }),
    ]);

    it("fills the available width exactly when there is plenty of room", () => {
        const total = 140;
        const w = computeColumnWidths(longRows, total);
        const sum = w.name + w.source + w.model + w.desc + COL_GAP * 3;
        expect(sum).toBe(total);
    });

    // The four columns clamp to their header widths plus inter-column gaps,
    // so the narrowest width that can still grant a 1-col description is
    // 4 (NAME) + 6 (SOURCE) + 5 (MODEL) + 6 (gaps) + 1 = 22. Below that the
    // table cannot fit, matching the inherent floor of any fixed-column grid.
    it("never lets the row exceed a narrow available width", () => {
        for (const total of [22, 30, 40, 55]) {
            const w = computeColumnWidths(longRows, total);
            const sum = w.name + w.source + w.model + w.desc + COL_GAP * 3;
            expect(sum).toBeLessThanOrEqual(total);
            expect(w.name).toBeGreaterThanOrEqual(1);
            expect(w.source).toBeGreaterThanOrEqual(1);
            expect(w.model).toBeGreaterThanOrEqual(1);
            expect(w.desc).toBeGreaterThanOrEqual(1);
        }
    });

    it("clamps oversized columns to their caps before allocating the description", () => {
        const w = computeColumnWidths(longRows, 140);
        expect(w.name).toBe(20);
        expect(w.source).toBe("system".length);
        expect(w.model).toBe(28);
    });
});

// ── shellQuote tests ────────────────────────────────────────────────

describe("shellQuote", () => {
    it("wraps a simple string in single quotes", () => {
        expect(shellQuote("hello")).toBe("'hello'");
    });

    it("safely quotes spaces", () => {
        expect(shellQuote("/path/to/my file")).toBe("'/path/to/my file'");
    });

    it("escapes embedded single quotes", () => {
        expect(shellQuote("it's")).toBe("'it'\\''s'");
    });

    it("handles strings with both spaces and single quotes", () => {
        const input = "file's name here";
        const quoted = shellQuote(input);
        expect(quoted).toBe("'file'\\''s name here'");
    });

    it("handles empty string", () => {
        expect(shellQuote("")).toBe("''");
    });

    it("handles double quotes without escaping", () => {
        // Double quotes are safe inside single quotes
        expect(shellQuote('say "hi"')).toBe("'say \"hi\"'");
    });

    it("handles special shell characters", () => {
        const input = "$HOME;rm -rf /";
        expect(shellQuote(input)).toBe("'$HOME;rm -rf /'");
    });
});

// ── buildTmuxArgs tests ─────────────────────────────────────────────

describe("buildTmuxArgs", () => {
    const cwd = "/project/root";
    const cmd = "pi --session /tmp/session.jsonl";

    it("maps 'right' to split-window -h", () => {
        const args = buildTmuxArgs("right", cwd, cmd);
        expect(args).toEqual(["split-window", "-h", "-c", cwd, cmd]);
    });

    it("maps 'bottom' to split-window -v", () => {
        const args = buildTmuxArgs("bottom", cwd, cmd);
        expect(args).toEqual(["split-window", "-v", "-c", cwd, cmd]);
    });

    it("maps 'left' to split-window -hb", () => {
        const args = buildTmuxArgs("left", cwd, cmd);
        expect(args).toEqual(["split-window", "-hb", "-c", cwd, cmd]);
    });

    it("maps 'top' to split-window -vb", () => {
        const args = buildTmuxArgs("top", cwd, cmd);
        expect(args).toEqual(["split-window", "-vb", "-c", cwd, cmd]);
    });

    it("maps 'new-window' to new-window", () => {
        const args = buildTmuxArgs("new-window", cwd, cmd);
        expect(args).toEqual(["new-window", "-c", cwd, cmd]);
    });

    it("includes -c cwd in all directions", () => {
        const directions: PaneDirection[] = [
            "right",
            "bottom",
            "left",
            "top",
            "new-window",
        ];
        for (const dir of directions) {
            const args = buildTmuxArgs(dir, "/custom/dir", cmd);
            const cwdIdx = args.indexOf("-c");
            expect(cwdIdx).toBeGreaterThan(-1);
            expect(args[cwdIdx + 1]).toBe("/custom/dir");
        }
    });

    it("places the shell command as the last argument", () => {
        const directions: PaneDirection[] = [
            "right",
            "bottom",
            "left",
            "top",
            "new-window",
        ];
        for (const dir of directions) {
            const args = buildTmuxArgs(dir, cwd, cmd);
            expect(args[args.length - 1]).toBe(cmd);
        }
    });
});
