/**
 * /models (alias: /list-models) — interactive model table with a detail pane.
 *
 * Shows the models usable in the current session, respecting the scoped
 * model list (`enabledModels` setting / `--models` flag) via
 * `ctx.scopedModels`. Falls back to the full available catalogue when no
 * scoping is configured.
 *
 * TUI mode: master–detail component — left pane lists provider, model,
 * reasoning, auth, context window, max output, and per-1M input/output
 * price; right pane shows the full spec of the highlighted model
 * (api, baseUrl, thinking levels, cost tiers, cache rates, compat flags).
 * `Enter` switches the active model, `/`-typing filters, `Tab` toggles
 * the detail pane, `Esc` closes.
 *
 * Note: the built-in `/model` command is intercepted by the TUI frontend
 * before extension commands are consulted, so it cannot be replaced by an
 * extension. `/models` is the conflict-free equivalent.
 *
 * Print mode: prints a plain fixed-width table to stdout so the output
 * can be piped. JSON mode stays silent.
 */

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    Theme,
    ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Key,
    matchesKey,
    type TUI,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";

// --- Types ---

export interface ModelRow {
    model: Model<Api>;
    providerName: string;
    isActive: boolean;
    hasAuth: boolean;
    pinnedThinking?: ModelThinkingLevel;
}

export interface BuildModelRowOptions {
    activeModel?: Model<Api>;
    hasAuth: (model: Model<Api>) => boolean;
    providerName: (model: Model<Api>) => string;
    pinnedThinking?: (model: Model<Api>) => ModelThinkingLevel | undefined;
}

interface ModelTableComponentOptions {
    tui: TUI;
    theme: Theme;
    rows: ModelRow[];
    scopeLabel: string;
    onSwitch: (row: ModelRow) => Promise<void>;
    onDone: () => void;
}

// --- Constants ---

const THINKING_LEVELS: ModelThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

const TABLE_COLUMNS = [
    { key: "sel", label: "", width: 2 },
    { key: "provider", label: "PROVIDER", width: 11 },
    { key: "model", label: "MODEL", width: 0 }, // flexible
    { key: "reas", label: "R", width: 4 },
    { key: "auth", label: "AUTH", width: 4 },
    { key: "ctx", label: "CTX", width: 6 },
    { key: "out", label: "OUT", width: 6 },
    { key: "price", label: "$/1M", width: 12 },
] as const;

const FIXED_TABLE_WIDTH = TABLE_COLUMNS.reduce(
    (total, column) => total + (column.key === "model" ? 0 : column.width),
    0,
);

const SPLIT_MIN_WIDTH = 120;
const STACK_MIN_WIDTH = 60;
const DETAIL_LABEL_WIDTH = 10;
const MAX_PLAIN_ROWS = 200;
/** Rows rendered at once in the interactive table; selection scrolls the window. */
const MAX_VISIBLE_ROWS = 20;

// --- Formatting helpers ---

function trimZero(value: string): string {
    return value.replace(/\.?0+$/, "");
}

/** 200_000 → "200k", 1_050_000 → "1.05M", 512 → "512" */
export function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
        return `${trimZero((tokens / 1_000_000).toFixed(2))}M`;
    }
    if (tokens >= 1_000) {
        return `${trimZero((tokens / 1_000).toFixed(1))}k`;
    }
    return `${tokens}`;
}

/** 3 → "$3", 0.3 → "$0.30", 0.07 → "$0.07", 1.25 → "$1.25", 0 → "$0" */
export function formatPrice(price: number): string {
    if (price === 0) return "$0";
    if (Number.isInteger(price)) return `$${price}`;
    return `$${price.toFixed(2)}`;
}

// --- Model row helpers ---

export function buildModelRows(
    models: readonly Model<Api>[],
    options: BuildModelRowOptions,
): ModelRow[] {
    return [...models]
        .map((model) => ({
            model,
            providerName: options.providerName(model),
            isActive:
                options.activeModel?.provider === model.provider &&
                options.activeModel.id === model.id,
            hasAuth: options.hasAuth(model),
            pinnedThinking: options.pinnedThinking?.(model),
        }))
        .sort(
            (a, b) =>
                a.providerName.localeCompare(b.providerName) ||
                a.model.id.localeCompare(b.model.id),
        );
}

export function filterRows(rows: readonly ModelRow[], filter: string): ModelRow[] {
    const query = filter.trim().toLowerCase();
    if (!query) return [...rows];
    return rows.filter((row) =>
        `${row.model.id} ${row.model.name} ${row.providerName} ${row.model.api}`
            .toLowerCase()
            .includes(query),
    );
}

/**
 * Summarizes supported thinking levels: "—" for non-reasoning models,
 * "off→max" for default maps, "off·high·max" when a custom
 * thinkingLevelMap restricts levels.
 */
export function thinkingLevelSummary(model: Model<Api>): string {
    if (!model.reasoning) return "—";
    const map = model.thinkingLevelMap;
    if (!map) return "off→max";
    const supported = THINKING_LEVELS.filter(
        (level) => map[level] !== undefined && map[level] !== null,
    );
    return supported.length > 0 ? supported.join("·") : "—";
}

/** "y" when the model reasons, "y*" when the session pins a thinking level. */
function reasoningMark(row: ModelRow): string {
    if (row.pinnedThinking !== undefined) return "y*";
    return row.model.reasoning ? "y" : "—";
}

/**
 * Window of at most `max` rows centered on the selection, for lists longer
 * than the terminal can display. `start` is the slice offset into `rows`.
 */
export function windowRows(
    rows: readonly ModelRow[],
    selectedIndex: number,
    max: number,
): { rows: readonly ModelRow[]; start: number } {
    if (rows.length <= max || max <= 0) {
        return { rows, start: 0 };
    }
    const start = Math.min(
        Math.max(0, selectedIndex - Math.floor(max / 2)),
        rows.length - max,
    );
    return { rows: rows.slice(start, start + max), start };
}

export function buildScopeLabel(
    shown: number,
    total: number,
    scoped: boolean,
): string {
    return scoped ? `${shown} of ${total} · scoped` : `all ${total} available`;
}

// --- Non-UI table ---

const PLAIN_COLUMNS = [
    { label: "PROVIDER", width: 12 },
    { label: "MODEL", width: 26 },
    { label: "R", width: 3 },
    { label: "AUTH", width: 4 },
    { label: "CTX", width: 7 },
    { label: "OUT", width: 7 },
    { label: "$ IN/OUT", width: 13 },
    { label: "CACHE R/W", width: 13 },
];

function plainCell(text: string, width: number): string {
    const ellipsis = text.length > width ? "..." : "";
    const truncated = ellipsis
        ? text.slice(0, Math.max(0, width - ellipsis.length))
        : text;
    const padding = " ".repeat(
        Math.max(0, width - truncated.length - ellipsis.length),
    );
    return `${truncated}${ellipsis}${padding}`;
}

/** Fixed-width table without ANSI codes, for print mode. */
export function renderPlainTable(
    rows: readonly ModelRow[],
    scopeLabel: string,
): string[] {
    const lines = [`MODELS — ${scopeLabel}`];
    lines.push(
        PLAIN_COLUMNS.map((column) => column.label.padEnd(column.width)).join(" "),
    );
    for (const row of rows.slice(0, MAX_PLAIN_ROWS)) {
        const model = row.model;
        const cells = [
            plainCell(row.providerName, 12),
            plainCell(model.id, 26),
            plainCell(reasoningMark(row), 3),
            plainCell(row.hasAuth ? "✓" : "✗", 4),
            plainCell(formatTokens(model.contextWindow), 7),
            plainCell(formatTokens(model.maxTokens), 7),
            plainCell(
                `${formatPrice(model.cost.input)}/${formatPrice(model.cost.output)}`,
                13,
            ),
            plainCell(
                `${formatPrice(model.cost.cacheRead)}/${formatPrice(model.cost.cacheWrite)}`,
                13,
            ),
        ];
        lines.push(cells.join(" "));
    }
    if (rows.length > MAX_PLAIN_ROWS) {
        lines.push(`… ${rows.length - MAX_PLAIN_ROWS} more models`);
    }
    return lines;
}

// --- Detail pane ---

function stripProtocol(baseUrl: string): string {
    return baseUrl.replace(/^https?:\/\//, "");
}

/** Key-value detail lines for the selected row, styled with the theme. */
export function detailLinesForRow(
    row: ModelRow,
    theme: Theme,
    width: number,
): string[] {
    const model = row.model;
    const value = (text: string, color?: ThemeColor): string =>
        theme.fg(
            color ?? "text",
            truncateToWidth(text, Math.max(1, width - DETAIL_LABEL_WIDTH - 1)),
        );

    const key = (text: string): string =>
        theme.fg("dim", text.padEnd(DETAIL_LABEL_WIDTH));

    const lines: string[] = [
        theme.fg(
            "accent",
            truncateToWidth(`${row.isActive ? "● " : ""}${model.id}`, width),
        ),
        truncateToWidth(theme.fg("border", "─".repeat(width)), width),
    ];

    const pairs: Array<[string, string, ThemeColor?]> = [
        ["provider", row.providerName],
        ["api", model.api],
        ["baseUrl", stripProtocol(model.baseUrl) || "—"],
        [
            "auth",
            row.hasAuth ? "✓ configured" : "✗ no key",
            row.hasAuth ? "success" : "error",
        ],
        [
            "reasoning",
            model.reasoning ? `yes · ${thinkingLevelSummary(model)}` : "no",
        ],
        ["input", model.input.join(" + ") || "—"],
        [
            "context",
            `${model.contextWindow.toLocaleString()} tokens (${formatTokens(model.contextWindow)})`,
        ],
        [
            "maxOutput",
            `${model.maxTokens.toLocaleString()} tokens (${formatTokens(model.maxTokens)})`,
        ],
        [
            "cost $/1M",
            `${formatPrice(model.cost.input)} in · ${formatPrice(model.cost.output)} out`,
        ],
        [
            "cache R/W",
            `${formatPrice(model.cost.cacheRead)} / ${formatPrice(model.cost.cacheWrite)}`,
        ],
        [
            "pinned",
            row.pinnedThinking ?? "—",
            row.pinnedThinking ? "warning" : undefined,
        ],
    ];

    const tiers = model.cost.tiers ?? [];
    if (tiers.length > 0) {
        pairs.push([
            "tiers",
            tiers
                .map(
                    (tier) =>
                        `≥${formatTokens(tier.inputTokensAbove)}: ${formatPrice(tier.input)}/${formatPrice(tier.output)}`,
                )
                .join(" · "),
        ]);
    }

    const sampling = Object.keys(model.samplingParams ?? {});
    pairs.push(["sampling", sampling.length > 0 ? sampling.join(", ") : "—"]);

    const compat = Object.keys(model.compat ?? {});
    pairs.push(["compat", compat.length > 0 ? compat.join(", ") : "—"]);

    for (const [label, text, color] of pairs) {
        lines.push(truncateToWidth(`${key(label)}${value(text, color)}`, width));
    }

    return lines;
}

function padTo(text: string, width: number): string {
    return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

/** Two-column selection cell: "▶ " selected, " ●" active, "▶●" both. */
export function selectionCell(
    isSelected: boolean,
    isActive: boolean,
    theme: Theme,
): string {
    if (isSelected) {
        return isActive
            ? `${theme.fg("accent", "▶")}${theme.fg("success", "●")}`
            : `${theme.fg("accent", "▶")} `;
    }
    return isActive ? ` ${theme.fg("success", "●")}` : "  ";
}

/**
 * One table row's grid cells. Each cell is padded to its column width
 * before styling so header and data columns stay aligned.
 */
export function rowCells(
    row: ModelRow,
    isSelected: boolean,
    modelWidth: number,
    theme: Theme,
): string[] {
    const model = row.model;
    const reasoningColor: ThemeColor =
        row.pinnedThinking !== undefined
            ? "warning"
            : model.reasoning
              ? "success"
              : "text";
    const price = `${formatPrice(model.cost.input)}/${formatPrice(model.cost.output)}`;
    const costColor: ThemeColor =
        model.cost.input === 0 && model.cost.output === 0 ? "success" : "text";
    return [
        selectionCell(isSelected, row.isActive, theme),
        theme.fg("accent", row.providerName.padEnd(11)),
        theme.fg("text", model.id.padEnd(modelWidth)),
        theme.fg(reasoningColor, reasoningMark(row).padEnd(4)),
        theme.fg(
            row.hasAuth ? "success" : "error",
            (row.hasAuth ? "✓" : "✗").padEnd(4),
        ),
        formatTokens(model.contextWindow).padEnd(6),
        formatTokens(model.maxTokens).padEnd(6),
        theme.fg(costColor, price.padEnd(12)),
    ];
}

// --- Interactive component ---

class ModelTableComponent implements Component {
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly rows: ModelRow[];
    private readonly scopeLabel: string;
    private readonly onSwitch: (row: ModelRow) => Promise<void>;
    private readonly onDone: () => void;
    private selectedIndex = 0;
    private filter = "";
    private showDetail = true;
    private status: { text: string; color: ThemeColor } | undefined;
    private cachedWidth?: number;
    private cachedLines?: string[];

    constructor(options: ModelTableComponentOptions) {
        this.tui = options.tui;
        this.theme = options.theme;
        this.rows = options.rows;
        this.scopeLabel = options.scopeLabel;
        this.onSwitch = options.onSwitch;
        this.onDone = options.onDone;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }

    setStatus(text: string, color: ThemeColor): void {
        this.status = { text, color };
        this.invalidate();
        this.tui.requestRender();
    }

    private changed(): void {
        this.invalidate();
        this.tui.requestRender();
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            if (this.filter.length > 0) {
                this.filter = "";
                this.selectedIndex = 0;
                this.changed();
            } else {
                this.onDone();
            }
            return;
        }

        if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
            const visible = filterRows(this.rows, this.filter);
            const row = visible[this.selectedIndex];
            if (row) void this.onSwitch(row);
            return;
        }

        if (matchesKey(data, Key.tab)) {
            this.showDetail = !this.showDetail;
            this.changed();
            return;
        }

        if (matchesKey(data, Key.backspace)) {
            this.filter = this.filter.slice(0, -1);
            this.selectedIndex = 0;
            this.changed();
            return;
        }

        const lower = data.toLowerCase();
        const isJkNav = (lower === "k" || lower === "j") && this.filter.length === 0;
        const isArrowNav = matchesKey(data, Key.up) || matchesKey(data, Key.down);
        if (isJkNav || isArrowNav) {
            const visible = filterRows(this.rows, this.filter);
            if (visible.length === 0) return;
            const direction = lower === "k" || matchesKey(data, Key.up) ? -1 : 1;
            this.selectedIndex =
                (this.selectedIndex + direction + visible.length) % visible.length;
            this.changed();
            return;
        }

        if (data.length === 1 && data >= " ") {
            this.filter += data;
            this.selectedIndex = 0;
            this.changed();
        }
    }

    render(width: number): string[] {
        if (this.cachedWidth === width && this.cachedLines) {
            return this.cachedLines;
        }
        const lines = this.renderLines(width);
        this.cachedWidth = width;
        this.cachedLines = lines;
        return lines;
    }

    private renderLines(width: number): string[] {
        const visible = filterRows(this.rows, this.filter);
        const selected = visible[Math.min(this.selectedIndex, visible.length - 1)];
        const detail = this.showDetail && visible.length > 0;

        if (detail && width >= SPLIT_MIN_WIDTH) {
            const leftWidth = Math.floor(width * 0.55);
            const rightWidth = width - leftWidth - 1;
            const divider = this.theme.fg("border", "│");
            const tableLines = this.renderTableLines(visible, leftWidth);
            const detailLines = detailLinesForRow(selected, this.theme, rightWidth);
            const merged: string[] = [];
            const count = Math.max(tableLines.length, detailLines.length);
            for (let i = 0; i < count; i += 1) {
                const left = i < tableLines.length ? tableLines[i]! : "";
                const right = i < detailLines.length ? detailLines[i]! : "";
                merged.push(
                    `${padTo(left, leftWidth)}${divider}${padTo(right, rightWidth)}`,
                );
            }
            return merged;
        }

        const tableLines = this.renderTableLines(visible, width);
        if (detail && width >= STACK_MIN_WIDTH) {
            const detailHeader = this.theme.fg(
                "border",
                "─".repeat(Math.max(1, width - 2)),
            );
            const detailLines = detailLinesForRow(selected, this.theme, width);
            return [
                ...tableLines,
                "",
                detailHeader,
                ...detailLines.map((line) =>
                    truncateToWidth(`${" ".repeat(2)}${line}`, width),
                ),
            ];
        }
        return tableLines.map((line) => truncateToWidth(line, width));
    }

    private renderTableLines(visible: ModelRow[], width: number): string[] {
        const theme = this.theme;
        const title = ` ${theme.fg("accent", "models")} ${theme.fg("dim", this.scopeLabel)}`;
        const lines: string[] = [truncateToWidth(title, width)];

        const modelWidth = Math.max(
            4,
            width - FIXED_TABLE_WIDTH - (TABLE_COLUMNS.length - 1),
        );
        const header = TABLE_COLUMNS.map((column) =>
            column.key === "model"
                ? theme.fg("dim", column.label.padEnd(modelWidth))
                : theme.fg("dim", column.label.padEnd(column.width)),
        ).join(" ");
        lines.push(truncateToWidth(header, width));

        if (visible.length === 0) {
            lines.push(theme.fg("warning", " no matching models"));
        }

        const selectedIndex = Math.min(this.selectedIndex, visible.length - 1);
        const window = windowRows(visible, selectedIndex, MAX_VISIBLE_ROWS);
        if (window.start > 0) {
            lines.push(theme.fg("dim", ` ▴ ${window.start} more above`));
        }
        window.rows.forEach((row, index) => {
            const isSelected = index + window.start === selectedIndex;
            const rowText = truncateToWidth(
                rowCells(row, isSelected, modelWidth, theme).join(" "),
                width,
            );
            lines.push(isSelected ? theme.bg("selectedBg", rowText) : rowText);
        });

        const below = visible.length - window.start - window.rows.length;
        if (below > 0) {
            lines.push(theme.fg("dim", ` ▾ ${below} more below`));
        }

        lines.push("");

        const filterLine =
            this.filter.length > 0
                ? ` filter: ${this.filter}${theme.fg("accent", "▎")}`
                : theme.fg("dim", " filter: type to search");
        lines.push(
            truncateToWidth(
                this.status
                    ? theme.fg(this.status.color, ` ${this.status.text}`)
                    : filterLine,
                width,
            ),
        );

        const count = this.filter.length > 0 ? `${visible.length} shown · ` : "";
        const hints = theme.fg(
            "dim",
            ` ${count}↑↓/jk move · enter switch · tab detail · esc close`,
        );
        lines.push(truncateToWidth(hints, width));
        return lines;
    }
}

// --- Extension entry point ---

async function runListModels(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const registry = ctx.modelRegistry;
    const all = registry.getAvailable();
    const scopedEntries = ctx.scopedModels;
    const scopedModels = scopedEntries.map((entry) => entry.model);
    const scoped = scopedModels.length > 0;
    const models = scoped ? scopedModels : all;

    const rows = buildModelRows(models, {
        activeModel: ctx.model,
        hasAuth: (model) => registry.hasConfiguredAuth(model),
        providerName: (model) => registry.getProviderDisplayName(model.provider),
        pinnedThinking: (model) =>
            scopedEntries.find(
                (entry) =>
                    entry.model.provider === model.provider &&
                    entry.model.id === model.id,
            )?.thinkingLevel,
    });

    const scopeLabel = buildScopeLabel(rows.length, all.length, scoped);
    if (!ctx.hasUI) {
        if (ctx.mode === "json") return;
        console.log(renderPlainTable(rows, scopeLabel).join("\n"));
        return;
    }

    await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
        const component = new ModelTableComponent({
            tui,
            theme,
            rows,
            scopeLabel,
            onSwitch: async (row) => {
                if (row.isActive) {
                    done(null);
                    return;
                }
                const ok = await pi.setModel(row.model);
                if (ok) {
                    ctx.ui.notify(`switched to ${row.model.id}`, "info");
                    done(null);
                } else {
                    component.setStatus(`no API key for ${row.model.id}`, "error");
                }
            },
            onDone: () => done(null),
        });
        return component;
    });
}

export default function (pi: ExtensionAPI) {
    for (const name of ["models", "list-models"]) {
        pi.registerCommand(name, {
            description:
                "List available models with provider, context window, and cost",
            handler: (_args, ctx: ExtensionCommandContext) => runListModels(pi, ctx),
        });
    }
}
