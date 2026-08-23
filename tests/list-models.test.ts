import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
    buildModelRows,
    buildScopeLabel,
    detailLinesForRow,
    filterRows,
    formatPrice,
    formatTokens,
    type ModelRow,
    renderPlainTable,
    rowCells,
    selectionCell,
    thinkingLevelSummary,
    windowRows,
} from "../extensions/list-models.js";

// --- Fixtures ---

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
    return {
        id: "test-model",
        name: "Test Model",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
        ...overrides,
    };
}

const ANTHROPIC_SONNET = makeModel({
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 1.5 },
});

const DEEPSEEK_CHAT = makeModel({
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    contextWindow: 128000,
    maxTokens: 8000,
    cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
});

function makeRow(overrides: Partial<ModelRow> = {}): ModelRow {
    return {
        model: ANTHROPIC_SONNET,
        providerName: "anthropic",
        isActive: false,
        hasAuth: true,
        ...overrides,
    };
}

const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
} as unknown as Theme;

// --- formatTokens ---

describe("formatTokens", () => {
    it("formats raw token counts", () => {
        expect(formatTokens(0)).toBe("0");
        expect(formatTokens(512)).toBe("512");
    });

    it("formats thousands", () => {
        expect(formatTokens(1000)).toBe("1k");
        expect(formatTokens(128000)).toBe("128k");
        expect(formatTokens(200000)).toBe("200k");
        expect(formatTokens(272000)).toBe("272k");
    });

    it("formats millions with fractional precision", () => {
        expect(formatTokens(1000000)).toBe("1M");
        expect(formatTokens(1050000)).toBe("1.05M");
    });
});

// --- formatPrice ---

describe("formatPrice", () => {
    it("formats per-1M token prices", () => {
        expect(formatPrice(0)).toBe("$0");
        expect(formatPrice(0.07)).toBe("$0.07");
        expect(formatPrice(0.3)).toBe("$0.30");
        expect(formatPrice(1.25)).toBe("$1.25");
        expect(formatPrice(3)).toBe("$3");
        expect(formatPrice(15)).toBe("$15");
    });
});

// --- buildModelRows ---

describe("buildModelRows", () => {
    const defaultOptions = {
        activeModel: undefined,
        hasAuth: () => true,
        providerName: (model: Model<Api>) => model.provider,
        pinnedThinking: () => undefined,
    };

    it("sorts by provider then model id", () => {
        const rows = buildModelRows(
            [DEEPSEEK_CHAT, ANTHROPIC_SONNET],
            defaultOptions,
        );
        expect(rows.map((row) => row.model.id)).toEqual([
            "claude-sonnet-4-5",
            "deepseek-chat",
        ]);
    });

    it("marks the active model", () => {
        const rows = buildModelRows([ANTHROPIC_SONNET], {
            ...defaultOptions,
            activeModel: ANTHROPIC_SONNET,
        });
        expect(rows[0]?.isActive).toBe(true);
    });

    it("resolves auth and provider name through callbacks", () => {
        const rows = buildModelRows([ANTHROPIC_SONNET], {
            ...defaultOptions,
            hasAuth: () => false,
            providerName: () => "Anthropic",
        });
        expect(rows[0]).toMatchObject({
            providerName: "Anthropic",
            hasAuth: false,
        });
    });

    it("captures pinned thinking levels from scoped entries", () => {
        const rows = buildModelRows([ANTHROPIC_SONNET], {
            ...defaultOptions,
            pinnedThinking: () => "high",
        });
        expect(rows[0]?.pinnedThinking).toBe("high");
    });
});

// --- filterRows ---

describe("filterRows", () => {
    const rows = [
        makeRow(),
        makeRow({ model: DEEPSEEK_CHAT, providerName: "deepseek" }),
    ];

    it("returns all rows for an empty filter", () => {
        expect(filterRows(rows, "")).toHaveLength(2);
    });

    it("matches model id case-insensitively", () => {
        const matches = filterRows(rows, "DEEPSEEK");
        expect(matches).toHaveLength(1);
        expect(matches[0]?.model.id).toBe("deepseek-chat");
    });

    it("matches provider name", () => {
        expect(filterRows(rows, "anthropic")).toHaveLength(1);
    });

    it("matches the human-readable name", () => {
        expect(filterRows(rows, "sonnet")).toHaveLength(1);
    });

    it("matches the api type", () => {
        const matches = filterRows(rows, "openai-completions");
        expect(matches).toHaveLength(1);
        expect(matches[0]?.model.id).toBe("deepseek-chat");
    });

    it("returns no rows for a miss", () => {
        expect(filterRows(rows, "gpt-5")).toHaveLength(0);
    });
});

// --- thinkingLevelSummary ---

describe("thinkingLevelSummary", () => {
    it("returns — for non-reasoning models", () => {
        expect(thinkingLevelSummary(DEEPSEEK_CHAT)).toBe("—");
    });

    it("returns off→max when no custom map exists", () => {
        expect(thinkingLevelSummary(ANTHROPIC_SONNET)).toBe("off→max");
    });

    it("joins supported levels from a custom map", () => {
        const model = makeModel({
            reasoning: true,
            thinkingLevelMap: {
                off: null,
                minimal: null,
                high: "high",
                max: "max",
            },
        });
        expect(thinkingLevelSummary(model)).toBe("high·max");
    });
});

// --- buildScopeLabel ---

describe("buildScopeLabel", () => {
    it("describes the scoped case", () => {
        expect(buildScopeLabel(5, 9, true)).toBe("5 of 9 · scoped");
    });

    it("describes the unscoped case", () => {
        expect(buildScopeLabel(9, 9, false)).toBe("all 9 available");
    });
});

// --- renderPlainTable ---

describe("renderPlainTable", () => {
    it("prints the scope header and column header", () => {
        const lines = renderPlainTable(
            [makeRow({ model: ANTHROPIC_SONNET })],
            "all 1 available",
        );
        expect(lines[0]).toBe("MODELS — all 1 available");
        expect(lines[1]).toContain("PROVIDER");
        expect(lines[1]).toContain("CTX");
    });

    it("renders one fixed-width line per model", () => {
        const lines = renderPlainTable(
            [makeRow({ model: ANTHROPIC_SONNET })],
            "all 1 available",
        );
        expect(lines).toHaveLength(3);
        expect(lines[2]).toContain("claude-sonnet-4-5");
        expect(lines[2]).toContain("200k");
        expect(lines[2]).toContain("$3/$15");
        expect(lines[2]).toContain("$0.30/$1.50");
    });

    it("marks missing auth", () => {
        const lines = renderPlainTable(
            [makeRow({ hasAuth: false })],
            "1 of 2 · scoped",
        );
        expect(lines[2]).toContain("✗");
    });

    it("truncates long model ids", () => {
        const long = makeModel({ id: "x".repeat(80) });
        const lines = renderPlainTable(
            [makeRow({ model: long })],
            "all 1 available",
        );
        expect(lines[2]!.length).toBeLessThanOrEqual(92);
    });

    it("caps the row count", () => {
        const rows = Array.from({ length: 250 }, (_, i) =>
            makeRow({ model: makeModel({ id: `m${i}` }) }),
        );
        const lines = renderPlainTable(rows, "all 250 available");
        expect(lines).toContain("… 50 more models");
    });
});

// --- detailLinesForRow ---

describe("detailLinesForRow", () => {
    it("shows the key spec fields", () => {
        const lines = detailLinesForRow(
            makeRow({ model: ANTHROPIC_SONNET }),
            theme,
            60,
        );
        const joined = `\n${lines.join("\n")}`;
        expect(joined).toContain("anthropic");
        expect(joined).toContain("api.anthropic.com");
        expect(joined).toContain("✓ configured");
        expect(joined).toContain("200,000 tokens");
        expect(joined).toContain("$3 in · $15 out");
        expect(joined).toContain("$0.30 / $1.50");
    });

    it("keeps every line within the pane width", () => {
        const lines = detailLinesForRow(
            makeRow({ model: ANTHROPIC_SONNET }),
            theme,
            40,
        );
        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(40);
        }
    });

    it("shows pinned thinking and tiers when present", () => {
        const row = makeRow({
            model: makeModel({
                reasoning: true,
                cost: {
                    input: 5,
                    output: 30,
                    cacheRead: 0.5,
                    cacheWrite: 6.25,
                    tiers: [
                        {
                            inputTokensAbove: 272000,
                            input: 10,
                            output: 45,
                            cacheRead: 1,
                            cacheWrite: 12.5,
                        },
                    ],
                },
            }),
            pinnedThinking: "max",
        });
        const joined = detailLinesForRow(row, theme, 60).join("\n");
        expect(joined).toContain("max");
        expect(joined).toContain("≥272k");
    });
});

// --- selectionCell ---

describe("selectionCell", () => {
    it("is exactly two visible characters wide in all states", () => {
        expect(selectionCell(false, false, theme)).toBe("  ");
        expect(selectionCell(false, true, theme)).toBe(" ●");
        expect(selectionCell(true, false, theme)).toBe("▶ ");
        expect(selectionCell(true, true, theme)).toBe("▶●");
    });

    it("never slices inside an ANSI escape", () => {
        const styled = selectionCell(true, false, {
            fg: (color: string, text: string) => `\x1b[${color}m${text}\x1b[0m`,
            bg: (_color: string, text: string) => text,
        } as unknown as Theme);
        expect(styled).toContain("▶");
        expect(styled).toContain("\x1b[");
    });
});

// --- rowCells ---

describe("rowCells", () => {
    const styled = {
        fg: (_color: string, text: string) => `\x1b[38;2;1;1;1m${text}\x1b[0m`,
        bg: (_color: string, text: string) => text,
    } as unknown as Theme;
    const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
    const widths = [2, 11, 10, 4, 4, 6, 6, 12];

    it("pads every styled cell to its column width", () => {
        const rows = [
            makeRow({ model: makeModel({ id: "sonnet", reasoning: true }) }),
            makeRow({ model: makeModel({ id: "local" }), hasAuth: false }),
            makeRow({
                model: makeModel({ id: "sonnet2", reasoning: true }),
                pinnedThinking: "high",
            }),
            makeRow({ model: makeModel({ id: "free" }) }),
        ];
        for (const row of rows) {
            const cells = rowCells(row, true, 10, styled);
            expect(cells.map((cell) => strip(cell).length)).toEqual(widths);
        }
    });

    it("keeps the selection cell two columns wide in every state", () => {
        for (const row of [makeRow(), makeRow({ isActive: true })]) {
            const cells = rowCells(row, true, 10, styled);
            expect(strip(cells[0]!).length).toBe(2);
        }
    });
});

// --- windowRows ---

function manyRows(count: number): ModelRow[] {
    return Array.from({ length: count }, (_, i) =>
        makeRow({ model: makeModel({ id: `model-${i}` }) }),
    );
}

describe("windowRows", () => {
    it("returns all rows when the list fits", () => {
        const rows = manyRows(15);
        const window = windowRows(rows, 7, 20);
        expect(window.start).toBe(0);
        expect(window.rows).toHaveLength(15);
    });

    it("returns all rows for a non-positive max", () => {
        const rows = manyRows(30);
        expect(windowRows(rows, 0, 0).rows).toHaveLength(30);
    });

    it("keeps the selection visible at the top of the list", () => {
        const window = windowRows(manyRows(40), 0, 20);
        expect(window.start).toBe(0);
        expect(window.rows[0]?.model.id).toBe("model-0");
    });

    it("centers the window on a middle selection", () => {
        const window = windowRows(manyRows(40), 15, 20);
        expect(window.start).toBe(5);
        expect(window.rows[10]?.model.id).toBe("model-15");
        expect(window.rows).toHaveLength(20);
    });

    it("anchors the window at the end of the list", () => {
        const window = windowRows(manyRows(40), 39, 20);
        expect(window.start).toBe(20);
        expect(window.rows[19]?.model.id).toBe("model-39");
    });
});
