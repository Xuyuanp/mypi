/**
 * Tests for the `/tools` extension's pure row-building logic.
 *
 * Covers `buildToolRows` (ordering, source derivation, flattening, dedup) and
 * `computeColumnWidths` (graceful degradation on narrow terminals).
 */

import { describe, expect, it } from "vitest";
import { buildToolRows, COL_GAP, computeColumnWidths } from "../extensions/tools.js";

type Tool = {
    name: string;
    description?: string;
    sourceInfo?: { source?: string; path?: string };
};

const builtin = (name: string, description = ""): Tool => ({
    name,
    description,
    sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
});

const ext = (name: string, file: string, description = ""): Tool => ({
    name,
    description,
    sourceInfo: { source: file, path: `/abs/path/${file}` },
});

describe("buildToolRows", () => {
    it("orders active tools first in getActiveTools order, then inactive in getAllTools order", () => {
        const all = [
            builtin("read"),
            builtin("bash"),
            builtin("grep"),
            ext("todo", "todo.ts"),
        ];
        const active = ["bash", "read"];

        const rows = buildToolRows(all, active);

        expect(rows.map((r) => r.name)).toEqual(["bash", "read", "grep", "todo"]);
        expect(rows.map((r) => r.active)).toEqual([true, true, false, false]);
    });

    it("skips active names that are not present in allTools", () => {
        const all = [builtin("read")];
        const active = ["read", "ghost"];

        const rows = buildToolRows(all, active);

        expect(rows.map((r) => r.name)).toEqual(["read"]);
    });

    it("dedupes repeated active names", () => {
        const all = [builtin("read"), builtin("bash")];
        const active = ["read", "read", "bash"];

        const rows = buildToolRows(all, active);

        expect(rows.map((r) => r.name)).toEqual(["read", "bash"]);
    });

    it("derives source: builtin and sdk verbatim, extension basename without suffix", () => {
        const all = [
            builtin("read"),
            { name: "sdk_tool", sourceInfo: { source: "sdk", path: "" } },
            ext("subagent", "subagent.ts"),
            ext("goal", "goals.mjs"),
        ];

        const rows = buildToolRows(all, []);

        expect(rows.map((r) => r.source)).toEqual([
            "builtin",
            "sdk",
            "subagent",
            "goals",
        ]);
    });

    it("falls back to source string then 'extension' when path is unusable", () => {
        const all = [
            { name: "a", sourceInfo: { source: "custom-src", path: "" } },
            { name: "b", sourceInfo: {} },
            { name: "c" },
        ];

        const rows = buildToolRows(all, []);

        expect(rows.map((r) => r.source)).toEqual([
            "custom-src",
            "extension",
            "extension",
        ]);
    });

    it("flattens multiline/whitespace descriptions to a single line", () => {
        const all = [
            builtin("read", "Read a file.\n\n  Some  details\twith  spaces."),
        ];

        const rows = buildToolRows(all, []);

        expect(rows[0].description).toBe("Read a file. Some details with spaces.");
    });

    it("handles an empty inventory", () => {
        expect(buildToolRows([], [])).toEqual([]);
        expect(buildToolRows([], ["read"])).toEqual([]);
    });
});

describe("computeColumnWidths", () => {
    const longRows = buildToolRows(
        [
            {
                name: "a_very_long_tool_name_exceeding_cap",
                description: "x",
                sourceInfo: { source: "some_long_extension_name", path: "" },
            },
        ],
        [],
    );

    it("fills the available width exactly when there is plenty of room", () => {
        const total = 120;
        const w = computeColumnWidths(longRows, total);
        const sum = w.name + w.act + w.source + w.desc + COL_GAP * 3;
        expect(sum).toBe(total);
    });

    it("never lets the row exceed a narrow available width", () => {
        for (const total of [20, 30, 40, 51]) {
            const w = computeColumnWidths(longRows, total);
            const sum = w.name + w.act + w.source + w.desc + COL_GAP * 3;
            expect(sum).toBeLessThanOrEqual(total);
            expect(w.name).toBeGreaterThanOrEqual(1);
            expect(w.source).toBeGreaterThanOrEqual(1);
            expect(w.desc).toBeGreaterThanOrEqual(1);
        }
    });
});
