/**
 * Agents overview - `/subagent` slash command.
 *
 * Renders an interactive, selectable table of every subagent discovered for
 * the session (system agents bundled with the extension and user agents from
 * the agent directory), showing each agent's source, model, and a truncated
 * description.
 *
 * Use Up/Down (or k/j) to move the selection; Enter opens a scrollable overlay
 * showing the full agent definition `.md` file (frontmatter + body) rendered
 * as Markdown; Esc/q closes the overlay (back to the table) or the table (back
 * to the session).
 *
 * Rows preserve `discoverAgents()` order: user agents override system agents
 * of the same name, and no alphabetical sort is applied.
 *
 * This is an interactive-only diagnostic: in headless modes (print `-p`,
 * JSON), where there is no UI to render to, the command is a no-op. Emitting
 * the table any other way (e.g. `pi.sendMessage`) would inject it into the
 * LLM context, which is undesirable for a read-only inspection command.
 *
 * Usage:
 *   /subagent
 */

import * as fs from "node:fs";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Container,
    Key,
    Markdown,
    matchesKey,
    type OverlayHandle,
    Text,
    type TUI,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type { BackgroundManager } from "./background.js";
import type { AgentSpec } from "./types.js";

interface AgentRow {
    name: string;
    source: string;
    model: string;
    description: string;
    filePath: string;
}

const NAME_CAP = 20;
const SOURCE_CAP = 8;
const MODEL_CAP = 28;
export const COL_GAP = 2;
const MIN_DESC_WIDTH = 12;
// Two-column gutter at the start of every table row for the selection marker.
const GUTTER_WIDTH = 2;

const HEADER_NAME = "NAME";
const HEADER_SOURCE = "SOURCE";
const HEADER_MODEL = "MODEL";
const HEADER_DESC = "DESCRIPTION";

const DEFAULT_MODEL_LABEL = "(default)";

/** Clamp `value` into the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
    if (max < min) return min;
    return Math.min(max, Math.max(min, value));
}

/** Whether `data` is an "up" key (arrow or vim `k`). */
function isUp(data: string): boolean {
    return matchesKey(data, Key.up) || data === "k";
}

/** Whether `data` is a "down" key (arrow or vim `j`). */
function isDown(data: string): boolean {
    return matchesKey(data, Key.down) || data === "j";
}

/** Whether `data` is a dismiss key (Esc, Ctrl-C, or `q`). */
function isCloseKey(data: string): boolean {
    return (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        data.toLowerCase() === "q"
    );
}

/** Collapse whitespace/newlines so a description renders on a single line. */
function flattenDescription(desc: string | undefined): string {
    return (desc ?? "").replace(/\s+/g, " ").trim();
}

/** Build display rows from the discovered agents, preserving their order. */
export function buildAgentRows(agents: AgentSpec[]): AgentRow[] {
    return agents.map((a) => ({
        name: a.name,
        source: a.source,
        model: a.model ?? DEFAULT_MODEL_LABEL,
        description: flattenDescription(a.description),
        filePath: a.filePath,
    }));
}

interface ColumnWidths {
    name: number;
    source: number;
    model: number;
    desc: number;
}

export function computeColumnWidths(
    rows: AgentRow[],
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
    let modelW = Math.min(
        MODEL_CAP,
        Math.max(HEADER_MODEL.length, ...rows.map((r) => r.model.length)),
    );
    const gaps = COL_GAP * 3;
    let desc = totalWidth - (nameW + sourceW + modelW + gaps);

    // When the terminal is too narrow to grant the description its minimum,
    // reclaim space by shrinking model, then source, then name (each down to
    // its header width) before letting the description fall below the minimum.
    // This keeps the rendered row width <= totalWidth so the Text component
    // never wraps.
    if (desc < MIN_DESC_WIDTH) {
        let deficit = MIN_DESC_WIDTH - desc;

        const modelShrink = Math.min(deficit, modelW - HEADER_MODEL.length);
        modelW -= modelShrink;
        deficit -= modelShrink;

        const sourceShrink = Math.min(deficit, sourceW - HEADER_SOURCE.length);
        sourceW -= sourceShrink;
        deficit -= sourceShrink;

        const nameShrink = Math.min(deficit, nameW - HEADER_NAME.length);
        nameW -= nameShrink;
        deficit -= nameShrink;

        desc = Math.max(1, MIN_DESC_WIDTH - Math.max(0, deficit));
    }

    return { name: nameW, source: sourceW, model: modelW, desc };
}

/**
 * Scrollable overlay showing the full content of an agent's `.md` definition
 * file, rendered as Markdown (headings, code blocks, lists, etc.). The
 * rendered lines are windowed to a fixed height; Up/Down/PageUp/PageDown/
 * Home/End scroll, Esc/q/Enter close.
 */
class AgentDetailView implements Component {
    private tui: TUI;
    private theme: Theme;
    private title: string;
    private onClose: () => void;
    private markdown: Markdown;

    private scrollOffset = 0;
    private cachedWidth?: number;
    private wrapped: string[] = [];
    private maxVisible = 1;

    constructor(
        tui: TUI,
        theme: Theme,
        title: string,
        content: string,
        onClose: () => void,
    ) {
        this.tui = tui;
        this.theme = theme;
        this.title = title;
        this.onClose = onClose;
        // 1-column inner padding; vertical padding is handled by box chrome.
        this.markdown = new Markdown(content, 1, 0, getMarkdownTheme());
    }

    private viewportHeight(): number {
        // Leave room for the top border+title, the scroll-info line, the
        // footer hint, and the bottom border (4 chrome rows), plus a little
        // breathing space around the overlay.
        return Math.max(3, this.tui.terminal.rows - 8);
    }

    private rewrap(width: number): void {
        const innerW = Math.max(1, width - 2);
        // Markdown handles its own width-aware wrapping; we window the result.
        this.wrapped = this.markdown.render(innerW);
        this.cachedWidth = width;
    }

    private maxScroll(): number {
        return Math.max(0, this.wrapped.length - this.maxVisible);
    }

    handleInput(data: string): void {
        if (isCloseKey(data) || data === "\r") {
            this.onClose();
            return;
        }

        const max = this.maxScroll();
        let next = this.scrollOffset;
        if (isUp(data)) next -= 1;
        else if (isDown(data)) next += 1;
        else if (matchesKey(data, Key.pageUp)) next -= this.maxVisible;
        else if (matchesKey(data, Key.pageDown)) next += this.maxVisible;
        else if (matchesKey(data, Key.home) || data === "g") next = 0;
        else if (matchesKey(data, Key.end) || data === "G") next = max;
        else return;

        next = clamp(next, 0, max);
        if (next !== this.scrollOffset) {
            this.scrollOffset = next;
            this.tui.requestRender();
        }
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.markdown.invalidate();
    }

    render(width: number): string[] {
        if (this.cachedWidth !== width) this.rewrap(width);
        this.maxVisible = this.viewportHeight();
        this.scrollOffset = clamp(this.scrollOffset, 0, this.maxScroll());

        const th = this.theme;
        const border = (s: string) => th.fg("border", s);
        const innerW = Math.max(1, width - 2);
        const pad = (s: string) => {
            const cell = truncateToWidth(s, innerW, "…", true);
            return cell + " ".repeat(Math.max(0, innerW - visibleWidth(cell)));
        };

        const result: string[] = [];

        const titleStr = truncateToWidth(` ${this.title} `, innerW);
        const titleW = visibleWidth(titleStr);
        const left = "─".repeat(Math.floor((innerW - titleW) / 2));
        const right = "─".repeat(Math.max(0, innerW - titleW - left.length));
        result.push(
            border(`╭${left}`) + th.fg("accent", titleStr) + border(`${right}╮`),
        );

        const total = this.wrapped.length;
        const shown = Math.min(this.maxVisible, total - this.scrollOffset);
        const end = this.scrollOffset + Math.max(0, shown);
        const scrollInfo =
            total > this.maxVisible
                ? `${this.scrollOffset + 1}-${end} / ${total}`
                : `${total} line${total === 1 ? "" : "s"}`;
        result.push(border("│") + pad(th.fg("dim", ` ${scrollInfo}`)) + border("│"));

        const visible = this.wrapped.slice(this.scrollOffset, end);
        // Markdown lines already carry their own ANSI styling; just pad them.
        for (const line of visible)
            result.push(border("│") + pad(line) + border("│"));
        for (let i = visible.length; i < this.maxVisible; i++)
            result.push(border("│") + pad("") + border("│"));

        result.push(
            border("│") +
                pad(th.fg("dim", " \u2191\u2193 scroll \u00b7 esc back")) +
                border("│"),
        );
        result.push(border(`╰${"─".repeat(innerW)}╯`));
        return result;
    }
}

class AgentsListView implements Component {
    private tui: TUI;
    private theme: Theme;
    private onDone: () => void;
    private rows: AgentRow[];
    private container: Container;
    private body: Text;
    private cachedWidth?: number;
    private selectedIndex = 0;
    private overlay: OverlayHandle | null = null;
    private readonly userCount: number;
    private readonly systemCount: number;

    constructor(tui: TUI, theme: Theme, rows: AgentRow[], onDone: () => void) {
        this.tui = tui;
        this.theme = theme;
        this.rows = rows;
        this.onDone = onDone;
        // Source counts are fixed for the view's lifetime; compute them once.
        this.userCount = rows.filter((r) => r.source === "user").length;
        this.systemCount = rows.length - this.userCount;

        this.container = new Container();
        this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
        this.container.addChild(
            new Text(
                theme.fg("accent", theme.bold("Subagents")) +
                    theme.fg(
                        "dim",
                        "  (\u2191\u2193 navigate \u00b7 enter view \u00b7 esc close)",
                    ),
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
        const accent = (s: string) => this.theme.fg("accent", s);

        if (this.rows.length === 0) {
            this.body.setText(muted("No agents discovered."));
            this.cachedWidth = width;
            return;
        }

        // Reserve space for the Text component's left padding, the border, and
        // the selection gutter, then let computeColumnWidths clamp columns to
        // this width so rows never exceed the viewport and wrap.
        const usable = Math.max(1, width - 2 - GUTTER_WIDTH);
        const w = computeColumnWidths(this.rows, usable);

        const lines: string[] = [];

        const headerName = truncateToWidth(HEADER_NAME, w.name, "…", true);
        const headerSource = truncateToWidth(HEADER_SOURCE, w.source, "…", true);
        const headerModel = truncateToWidth(HEADER_MODEL, w.model, "…", true);
        const headerDesc = truncateToWidth(HEADER_DESC, w.desc, "…", false);
        lines.push(
            `${" ".repeat(GUTTER_WIDTH)}${dim(
                `${headerName}  ${headerSource}  ${headerModel}  ${headerDesc}`,
            )}`,
        );

        this.rows.forEach((r, i) => {
            const nameCell = truncateToWidth(r.name, w.name, "…", true);
            const sourceCell = truncateToWidth(r.source, w.source, "…", true);
            const modelCell = truncateToWidth(r.model, w.model, "…", true);
            const descCell = truncateToWidth(r.description, w.desc, "…", false);
            const selected = i === this.selectedIndex;
            const gutter = selected
                ? accent("\u203a".padEnd(GUTTER_WIDTH))
                : " ".repeat(GUTTER_WIDTH);
            const nameOut = selected
                ? accent(this.theme.bold(nameCell))
                : text(this.theme.bold(nameCell));
            const sourceOut = selected ? accent(sourceCell) : muted(sourceCell);
            const modelOut = selected ? accent(modelCell) : muted(modelCell);
            const descOut = selected ? text(descCell) : dim(descCell);
            lines.push(`${gutter}${nameOut}  ${sourceOut}  ${modelOut}  ${descOut}`);
        });

        lines.push("");
        lines.push(
            muted(`${this.rows.length} agents \u00b7 `) +
                text(`${this.userCount} user`) +
                muted(" \u00b7 ") +
                text(`${this.systemCount} system`),
        );

        this.body.setText(lines.join("\n"));
        this.cachedWidth = width;
    }

    private moveSelection(delta: number): void {
        if (this.rows.length === 0) return;
        const next = clamp(this.selectedIndex + delta, 0, this.rows.length - 1);
        if (next === this.selectedIndex) return;
        this.selectedIndex = next;
        this.cachedWidth = undefined;
        this.container.invalidate();
        this.tui.requestRender();
    }

    private openSelected(): void {
        const row = this.rows[this.selectedIndex];
        if (!row || this.overlay) return;

        let content: string;
        try {
            content = fs.readFileSync(row.filePath, "utf-8");
        } catch (err) {
            content = `Failed to read agent definition:\n${row.filePath}\n\n${
                err instanceof Error ? err.message : String(err)
            }`;
        }

        const title = `${row.name} (${row.source}) \u2014 ${row.filePath}`;
        const detail = new AgentDetailView(
            this.tui,
            this.theme,
            title,
            content,
            () => this.closeOverlay(),
        );
        this.overlay = this.tui.showOverlay(detail, {
            anchor: "center",
            width: "80%",
        });
        this.tui.requestRender();
    }

    private closeOverlay(): void {
        if (!this.overlay) return;
        this.overlay.hide();
        this.overlay = null;
        this.tui.requestRender();
    }

    handleInput(data: string): void {
        if (isUp(data)) {
            this.moveSelection(-1);
            return;
        }
        if (isDown(data)) {
            this.moveSelection(1);
            return;
        }
        if (data === "\r") {
            this.openSelected();
            return;
        }
        if (isCloseKey(data)) {
            this.onDone();
            return;
        }
    }

    invalidate(): void {
        this.container.invalidate();
        this.cachedWidth = undefined;
    }

    dispose(): void {
        this.closeOverlay();
    }

    render(width: number): string[] {
        if (this.cachedWidth !== width) this.rebuild(width);
        return this.container.render(width);
    }
}

export function registerSubagentCommand(
    pi: ExtensionAPI,
    bgManager: BackgroundManager,
    agents: AgentSpec[],
): void {
    pi.registerCommand("subagent", {
        description: "List agents or cancel a background agent",
        getArgumentCompletions(prefix) {
            if (prefix.startsWith("cancel ")) {
                const partial = prefix.slice("cancel ".length);
                return [...bgManager.agents.keys()]
                    .filter((id) => id.startsWith(partial))
                    .map((id) => ({
                        label: id,
                        value: `cancel ${id}`,
                    }));
            }
            if ("cancel".startsWith(prefix)) {
                return [{ label: "cancel", value: "cancel " }];
            }
            return null;
        },
        handler: async (args, ctx: ExtensionCommandContext) => {
            const trimmed = args.trim();

            // /subagent cancel <id>
            if (trimmed.startsWith("cancel ")) {
                const id = trimmed.slice("cancel ".length).trim();
                if (!bgManager.cancel(id)) {
                    ctx.ui.notify(`No background agent with id: ${id}`);
                    return;
                }
                ctx.ui.notify(`Cancelled background agent: ${id}`);
                return;
            }

            // Default: show agent list (TUI-only)
            if (ctx.mode !== "tui") return;

            const rows = buildAgentRows(agents);
            await ctx.ui.custom<void>((tui, theme, _kb, done) => {
                return new AgentsListView(tui, theme, rows, done);
            });
        },
    });
}
