/**
 * Tools overview - `/tools` slash command.
 *
 * Renders a read-only table of every tool known to the session (built-in,
 * SDK, and extension tools), showing whether each is currently active, where
 * it comes from, and a truncated description.
 *
 * Rows are ordered active-first (in `getActiveTools()` order), then the
 * remaining inactive tools in `getAllTools()` order. No alphabetical sort.
 *
 * This is an interactive-only diagnostic: in headless modes (print `-p`,
 * JSON), where there is no UI to render to, the command is a no-op. Emitting
 * the table any other way (e.g. `pi.sendMessage`) would inject it into the
 * LLM context, which is undesirable for a read-only inspection command.
 *
 * Usage:
 *   /tools
 */

import path from "node:path";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Container,
    Key,
    matchesKey,
    Text,
    type TUI,
    truncateToWidth,
} from "@earendil-works/pi-tui";

interface ToolRow {
    name: string;
    active: boolean;
    source: string;
    description: string;
}

const NAME_CAP = 24;
const SOURCE_CAP = 18;
const ACT_WIDTH = 3;
export const COL_GAP = 2;
const MIN_DESC_WIDTH = 12;

const HEADER_NAME = "NAME";
const HEADER_ACT = "ACT";
const HEADER_SOURCE = "SOURCE";
const HEADER_DESC = "DESCRIPTION";

interface ToolInfoLike {
    name: string;
    description?: string;
    sourceInfo?: { source?: string; path?: string };
}

/** Derive a short, human-friendly source label from a tool's sourceInfo. */
function deriveSource(info: ToolInfoLike["sourceInfo"]): string {
    const source = info?.source ?? "";
    if (source === "builtin" || source === "sdk") return source;
    const p = info?.path ?? "";
    if (p) {
        const base = path.basename(p).replace(/\.(ts|js|mjs|cjs)$/i, "");
        if (base) return base;
    }
    return source || "extension";
}

/** Collapse whitespace/newlines so a description renders on a single line. */
function flattenDescription(desc: string | undefined): string {
    return (desc ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Build display rows from the tool inventory.
 * Active tools come first in `activeNames` order, then inactive tools in
 * `allTools` order. Active names not present in `allTools` are skipped.
 */
export function buildToolRows(
    allTools: ToolInfoLike[],
    activeNames: string[],
): ToolRow[] {
    const byName = new Map<string, ToolInfoLike>();
    for (const t of allTools) byName.set(t.name, t);

    const toRow = (t: ToolInfoLike, active: boolean): ToolRow => ({
        name: t.name,
        active,
        source: deriveSource(t.sourceInfo),
        description: flattenDescription(t.description),
    });

    const rows: ToolRow[] = [];
    const seen = new Set<string>();

    for (const name of activeNames) {
        const t = byName.get(name);
        if (!t || seen.has(name)) continue;
        seen.add(name);
        rows.push(toRow(t, true));
    }

    for (const t of allTools) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        rows.push(toRow(t, false));
    }

    return rows;
}

function centerPad(text: string, width: number): string {
    if (text.length >= width) return text.slice(0, width);
    const total = width - text.length;
    const left = Math.floor(total / 2);
    return " ".repeat(left) + text + " ".repeat(total - left);
}

export interface ColumnWidths {
    name: number;
    act: number;
    source: number;
    desc: number;
}

export function computeColumnWidths(
    rows: ToolRow[],
    totalWidth: number,
): ColumnWidths {
    let nameW = Math.min(
        NAME_CAP,
        Math.max(HEADER_NAME.length, ...rows.map((r) => r.name.length)),
    );
    let sourceW = Math.min(
        SOURCE_CAP,
        Math.max(HEADER_SOURCE.length, ...rows.map((r) => r.source.length)),
    );
    const actW = Math.max(ACT_WIDTH, HEADER_ACT.length);
    const gaps = COL_GAP * 3;
    let desc = totalWidth - (nameW + actW + sourceW + gaps);

    // When the terminal is too narrow to grant the description its minimum,
    // reclaim space by shrinking source then name (each down to its header
    // width) before letting the description fall below the minimum. This keeps
    // the rendered row width <= totalWidth so the Text component never wraps.
    if (desc < MIN_DESC_WIDTH) {
        let deficit = MIN_DESC_WIDTH - desc;

        const sourceShrink = Math.min(deficit, sourceW - HEADER_SOURCE.length);
        sourceW -= sourceShrink;
        deficit -= sourceShrink;

        const nameShrink = Math.min(deficit, nameW - HEADER_NAME.length);
        nameW -= nameShrink;
        deficit -= nameShrink;

        desc = Math.max(1, MIN_DESC_WIDTH - Math.max(0, deficit));
    }

    return { name: nameW, act: actW, source: sourceW, desc };
}

class ToolsView implements Component {
    private theme: any;
    private onDone: () => void;
    private rows: ToolRow[];
    private container: Container;
    private body: Text;
    private cachedWidth?: number;

    constructor(_tui: TUI, theme: any, rows: ToolRow[], onDone: () => void) {
        this.theme = theme;
        this.rows = rows;
        this.onDone = onDone;

        this.container = new Container();
        this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
        this.container.addChild(
            new Text(
                theme.fg("accent", theme.bold("Tools")) +
                    theme.fg("dim", "  (Esc/q/Enter to close)"),
                1,
                0,
            ),
        );
        this.container.addChild(new Text("", 1, 0));

        this.body = new Text("", 1, 0);
        this.container.addChild(this.body);

        this.container.addChild(new Text("", 1, 0));
        this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    }

    private rebuild(width: number): void {
        const dim = (s: string) => this.theme.fg("dim", s);
        const muted = (s: string) => this.theme.fg("muted", s);
        const text = (s: string) => this.theme.fg("text", s);

        // Reserve space for the Text component's left padding and the border,
        // then let computeColumnWidths clamp columns to this width so rows
        // never exceed the viewport and wrap.
        const usable = Math.max(1, width - 2);
        const w = computeColumnWidths(this.rows, usable);

        const lines: string[] = [];

        const headerName = truncateToWidth(HEADER_NAME, w.name, "…", true);
        const headerSource = truncateToWidth(HEADER_SOURCE, w.source, "…", true);
        const headerDesc = truncateToWidth(HEADER_DESC, w.desc, "…", false);
        lines.push(
            dim(
                `${headerName}  ${centerPad(HEADER_ACT, w.act)}  ${headerSource}  ${headerDesc}`,
            ),
        );

        const leftPad = Math.floor((w.act - 1) / 2);
        const rightPad = w.act - 1 - leftPad;
        for (const r of this.rows) {
            const nameCell = truncateToWidth(r.name, w.name, "…", true);
            const sourceCell = truncateToWidth(r.source, w.source, "…", true);
            const descCell = truncateToWidth(r.description, w.desc, "…", false);
            const glyph = r.active
                ? this.theme.fg("success", "\u2713")
                : dim("\u00b7");
            const actCell = `${" ".repeat(leftPad)}${glyph}${" ".repeat(rightPad)}`;
            lines.push(
                `${text(this.theme.bold(nameCell))}  ${actCell}  ${muted(sourceCell)}  ${dim(descCell)}`,
            );
        }

        const activeCount = this.rows.filter((r) => r.active).length;
        lines.push("");
        lines.push(
            muted(`${this.rows.length} tools \u00b7 `) +
                text(`${activeCount} active`),
        );

        this.body.setText(lines.join("\n"));
        this.cachedWidth = width;
    }

    handleInput(data: string): void {
        if (
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.ctrl("c")) ||
            data.toLowerCase() === "q" ||
            data === "\r"
        ) {
            this.onDone();
            return;
        }
    }

    invalidate(): void {
        this.container.invalidate();
        this.cachedWidth = undefined;
    }

    render(width: number): string[] {
        if (this.cachedWidth !== width) this.rebuild(width);
        return this.container.render(width);
    }
}

export default function toolsExtension(pi: ExtensionAPI) {
    pi.registerCommand("tools", {
        description: "Show all tools (active first) in a table",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            // Interactive-only: nothing to render without a UI.
            if (!ctx.hasUI) return;

            const rows = buildToolRows(pi.getAllTools(), pi.getActiveTools());
            await ctx.ui.custom<void>((tui, theme, _kb, done) => {
                return new ToolsView(tui, theme, rows, done);
            });
        },
    });
}
