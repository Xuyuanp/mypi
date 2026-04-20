/**
 * Progress overlay rendering for the review-fix loop.
 *
 * This module exports a single `ReviewFixOverlay` component that lives
 * in the input-editor slot while a loop is active (driven by
 * `ctx.ui.custom`). It also exports result-message rendering helpers
 * which are unchanged from the previous widget-based implementation.
 *
 * Modeled on `extensions/btw.ts` -- shares the scroll/markdown wrapping
 * idiom but diverges in the header/footer styling and the phase-aware
 * mutators driven by the orchestration in `index.ts`.
 */

import {
    getMarkdownTheme,
    type Theme,
    type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import {
    type Component,
    Container,
    type Focusable,
    Markdown,
    matchesKey,
    type TUI,
    truncateToWidth,
    visibleWidth,
} from "@mariozechner/pi-tui";
import type { LoopExitReason, LoopResult } from "./types.js";

// -- Constants --

export const REFRESH_MS = 500;
export const MAX_VISIBLE_LINES = 30;
export const ARMING_WINDOW_MS = 1500;

const MD_THEME = getMarkdownTheme();

// -- Types --

export type WidgetPhase = "reviewing" | "fixing" | "clean";

// -- Pure helpers --

export function formatElapsed(startTime: number): string {
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}m${remaining}s`;
}

/**
 * Render markdown to lines. Falls back to codepoint-aware wrapping
 * if markdown parsing throws (mirrors btw.ts).
 */
function renderMarkdownLines(text: string, width: number): string[] {
    if (!text) return [];
    try {
        const md = new Markdown(text, 0, 0, MD_THEME);
        return md.render(width);
    } catch {
        return text.split("\n").flatMap((line) => {
            if (!line) return [""];
            const wrapped: string[] = [];
            let start = 0;
            while (start < line.length) {
                let end = start;
                let w = 0;
                while (end < line.length) {
                    const cp = line.codePointAt(end);
                    if (cp === undefined) break;
                    const charW = visibleWidth(String.fromCodePoint(cp));
                    if (w + charW > width) break;
                    w += charW;
                    end += cp > 0xffff ? 2 : 1;
                }
                if (end === start) {
                    const cp = line.codePointAt(end);
                    end += cp !== undefined && cp > 0xffff ? 2 : 1;
                }
                wrapped.push(line.slice(start, end));
                start = end;
            }
            return wrapped.length > 0 ? wrapped : [""];
        });
    }
}

function phaseColor(phase: WidgetPhase): ThemeColor {
    switch (phase) {
        case "reviewing":
            return "warning";
        case "fixing":
            return "accent";
        case "clean":
            return "success";
    }
}

/**
 * Ceil a remaining millisecond duration to the nearest 500ms and
 * format as "Ns" (e.g. 1500 -> "1.5s", 700 -> "1.0s", 1 -> "0.5s").
 */
function formatArmCountdown(remainingMs: number): string {
    const clamped = Math.max(0, remainingMs);
    const halfSeconds = Math.max(1, Math.ceil(clamped / 500));
    const seconds = halfSeconds * 0.5;
    return `${seconds.toFixed(1)}s`;
}

// -- Overlay component --

export class ReviewFixOverlay implements Component, Focusable {
    focused = false;

    // Phase state (driven by orchestration)
    private phase: WidgetPhase = "reviewing";
    private phaseStartTime = Date.now();
    private iteration = 0;
    private maxIterations = 0;
    private bodyText = "";

    // Abort-arming state
    private armedAt: number | null = null;

    // Scroll / render caches
    private lines: string[] = [];
    private lastInnerW = 0;
    private totalContentLines = 0;
    private scrollOffset = 0;
    private isAtBottom = true;

    // Abort + timer
    private readonly abortController = new AbortController();
    private refreshTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private tui: TUI,
        private theme: Theme,
    ) {
        this.refreshTimer = setInterval(() => {
            // Auto-disarm if the 1.5s window has elapsed without a second press.
            if (
                this.armedAt !== null &&
                Date.now() - this.armedAt > ARMING_WINDOW_MS
            ) {
                this.armedAt = null;
            }
            tui.requestRender();
        }, REFRESH_MS);
    }

    get signal(): AbortSignal {
        return this.abortController.signal;
    }

    dispose(): void {
        if (this.refreshTimer !== null) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        // Fail-safe: if the overlay is disposed (e.g. the custom slot is
        // torn down) before the loop finishes, abort so `runLoop`
        // observes cancellation and stops issuing further review/fix
        // iterations without an attached UI.
        if (!this.abortController.signal.aborted) {
            this.abortController.abort();
        }
    }

    // -- Mutators called by orchestration --

    setPhase(phase: WidgetPhase, iteration: number, maxIterations: number): void {
        this.phase = phase;
        this.phaseStartTime = Date.now();
        this.iteration = iteration;
        this.maxIterations = maxIterations;
        if (phase === "reviewing") {
            this.bodyText = "";
        }
        this.lines = [];
        this.scrollOffset = 0;
        this.isAtBottom = true;
        this.tui.requestRender();
    }

    appendReviewDelta(delta: string): void {
        if (this.phase !== "reviewing") return;
        this.bodyText += delta;
        this.lines = [];
        this.tui.requestRender();
    }

    setFixingBody(reviewOutput: string): void {
        this.bodyText = reviewOutput;
        this.lines = [];
        this.scrollOffset = 0;
        this.isAtBottom = true;
        this.tui.requestRender();
    }

    setClean(): void {
        this.phase = "clean";
        this.phaseStartTime = Date.now();
        this.bodyText = "**No blocking issues found.**";
        this.lines = [];
        this.scrollOffset = 0;
        this.isAtBottom = true;
        this.tui.requestRender();
    }

    setError(message: string): void {
        this.bodyText = this.theme.fg("error", message);
        this.lines = [];
        this.scrollOffset = 0;
        this.isAtBottom = true;
        this.tui.requestRender();
    }

    // -- Input --

    handleInput(data: string): void {
        // Scroll keys always disarm abort, then scroll.
        if (matchesKey(data, "up") || data === "k") {
            this.clearArm();
            if (this.scrollOffset > 0) {
                this.scrollOffset--;
            }
            this.updateIsAtBottom();
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, "down") || data === "j") {
            this.clearArm();
            const maxScroll = this.maxScrollOffset();
            if (this.scrollOffset < maxScroll) {
                this.scrollOffset++;
            }
            this.updateIsAtBottom();
            this.tui.requestRender();
            return;
        }

        // q or Esc: arm or confirm.
        if (matchesKey(data, "escape") || data === "q") {
            if (
                this.armedAt !== null &&
                Date.now() - this.armedAt <= ARMING_WINDOW_MS
            ) {
                // Confirm abort. Orchestration observes the signal and
                // drives `done()` via the LoopResult; the overlay does
                // not call done() directly.
                this.armedAt = null;
                this.abortController.abort();
            } else {
                this.armedAt = Date.now();
            }
            this.tui.requestRender();
            return;
        }

        // Any other key cancels arming silently.
        if (this.armedAt !== null) {
            this.armedAt = null;
            this.tui.requestRender();
        }
    }

    // -- Render --

    render(width: number): string[] {
        const th = this.theme;
        // `width - 2` reserves one column for the left pad and one for
        // the right pad. In very narrow terminals (<2 cols) `innerW`
        // collapses to 0 and `row()` emits an empty/space-only string
        // bounded by `width` -- never wider than the terminal.
        const innerW = Math.max(0, width - 2);

        if (this.lines.length === 0 || this.lastInnerW !== innerW) {
            this.lines = this.buildContent(innerW);
            this.lastInnerW = innerW;
        }

        const contentLines = this.lines;
        this.totalContentLines = contentLines.length;

        const maxScroll = this.maxScrollOffset();
        if (this.scrollOffset > maxScroll) {
            this.scrollOffset = maxScroll;
        }

        // Re-derive smart-follow after any clamp/reflow. If the content
        // shrank (e.g. terminal resized wider so fewer wrapped lines),
        // a previously scrolled-up position may now sit at the new
        // bottom. Without this, `isAtBottom` stays stale and subsequent
        // streaming deltas would not auto-follow the newest content.
        if (this.scrollOffset >= maxScroll) {
            this.isAtBottom = true;
        }

        // Smart-follow: if we were at the bottom, stick to the bottom as
        // new content arrives (only meaningful while reviewer streams).
        if (this.isAtBottom) {
            this.scrollOffset = maxScroll;
        }

        const visibleLines = contentLines.slice(
            this.scrollOffset,
            this.scrollOffset + MAX_VISIBLE_LINES,
        );

        const pad = (s: string, len: number) => {
            const vis = visibleWidth(s);
            return s + " ".repeat(Math.max(0, len - vis));
        };

        const row = (content: string) => {
            // Guard against sub-2-column terminals: a row needs at
            // least 2 columns for the left/right padding characters.
            // For width 0 or 1, emit a blank row bounded by `width`.
            if (width < 2) return " ".repeat(Math.max(0, width));
            const truncated = truncateToWidth(content, innerW, "");
            return ` ${pad(truncated, innerW)} `;
        };

        const out: string[] = [];

        // Top border (plain dashes, full width).
        out.push(th.fg("border", "\u2500".repeat(width)));

        // Header row: "review-fix [N/M]  <phase>  <elapsed>"
        const iter = th.fg(
            "accent",
            `[${this.iteration + 1}/${this.maxIterations}]`,
        );
        const phaseLabel = th.fg(phaseColor(this.phase), this.phase);
        const elapsed = th.fg("dim", formatElapsed(this.phaseStartTime));
        out.push(row(`review-fix ${iter}  ${phaseLabel}   ${elapsed}`));

        // Inner separator row.
        out.push(row(th.fg("border", "\u2500".repeat(innerW))));

        // Scroll indicator (top) when scrollable.
        const isScrollable = contentLines.length > MAX_VISIBLE_LINES;
        const remaining =
            contentLines.length - this.scrollOffset - MAX_VISIBLE_LINES;

        if (isScrollable && this.scrollOffset > 0) {
            out.push(
                row(
                    th.fg(
                        "dim",
                        `... ${this.scrollOffset} more line${this.scrollOffset === 1 ? "" : "s"} above`,
                    ),
                ),
            );
        }

        // Body.
        for (const line of visibleLines) {
            out.push(row(line));
        }

        // Scroll indicator (bottom) when scrollable.
        if (isScrollable && remaining > 0) {
            out.push(
                row(
                    th.fg(
                        "dim",
                        `... ${remaining} more line${remaining === 1 ? "" : "s"} below`,
                    ),
                ),
            );
        }

        // Bottom border with embedded footer label.
        out.push(this.renderFooterBorder(width));

        return out;
    }

    invalidate(): void {
        this.lines = [];
    }

    // -- Internals --

    private buildContent(innerW: number): string[] {
        if (!this.bodyText) {
            if (this.phase === "reviewing") {
                return [this.theme.fg("dim", "Waiting for reviewer...")];
            }
            if (this.phase === "fixing") {
                return [this.theme.fg("dim", "Applying fixes...")];
            }
            return [""];
        }
        return renderMarkdownLines(this.bodyText, innerW);
    }

    private maxScrollOffset(): number {
        return Math.max(0, this.totalContentLines - MAX_VISIBLE_LINES);
    }

    private updateIsAtBottom(): void {
        this.isAtBottom = this.scrollOffset >= this.maxScrollOffset();
    }

    private clearArm(): void {
        if (this.armedAt !== null) {
            this.armedAt = null;
        }
    }

    private renderFooterBorder(width: number): string {
        const th = this.theme;
        if (width <= 0) return "";

        let label: string;
        let labelColor: ThemeColor;

        if (this.armedAt !== null) {
            const remainingMs = ARMING_WINDOW_MS - (Date.now() - this.armedAt);
            label = ` Press Esc again to abort (${formatArmCountdown(remainingMs)}) `;
            labelColor = "warning";
        } else {
            label = " q/Esc to exit ";
            labelColor = "accent";
        }

        // The footer border is `leftLen` dashes + label + `rightLen`
        // dashes, summing to exactly `width`. In narrow terminals we
        // shrink `leftLen` first, then truncate the label so at least
        // one right dash remains when possible. This guarantees the
        // returned string is never wider than `width`.
        const leftLen = Math.min(2, width);
        const afterLeft = width - leftLen;
        if (afterLeft <= 0) {
            return th.fg("border", "\u2500".repeat(width));
        }
        // Reserve 1 column for at least one right dash when possible.
        const labelBudget = Math.max(0, afterLeft - 1);
        const truncatedLabel = truncateToWidth(label, labelBudget, "");
        const actualLabelLen = visibleWidth(truncatedLabel);
        const rightLen = afterLeft - actualLabelLen;

        return (
            th.fg("border", "\u2500".repeat(leftLen)) +
            (actualLabelLen > 0 ? th.fg(labelColor, truncatedLabel) : "") +
            th.fg("border", "\u2500".repeat(rightLen))
        );
    }
}

// -- Result message rendering (unchanged from previous impl) --

export type ResultMessageDetails = LoopResult & {
    warning?: string;
};

function exitReasonLabel(reason: LoopExitReason, errorMessage?: string): string {
    switch (reason) {
        case "clean":
            return "No more blocking issues found.";
        case "max-iterations":
            return "Stopped after reaching the iteration limit.";
        case "aborted":
            return "Aborted by user.";
        case "error":
            // Prefer the concrete failure reason captured in `runLoop`.
            // The overlay that showed it is disposed by the time this
            // message renders, so without propagation the user would
            // only see the generic fallback.
            return errorMessage && errorMessage.trim().length > 0
                ? `Stopped due to an error: ${errorMessage}`
                : "Stopped due to an error.";
    }
}

export function buildResultMessage(
    result: LoopResult,
    warning?: string,
): { content: string; details: ResultMessageDetails } {
    const parts: string[] = [
        `**Review-fix loop complete** (${result.iterations} iteration${result.iterations === 1 ? "" : "s"})`,
        "",
        exitReasonLabel(result.exitReason, result.errorMessage),
    ];

    if (result.exitReason === "clean" || result.exitReason === "max-iterations") {
        parts.push(
            "",
            "See `DECISIONS.md` for the full log of findings and outcomes.",
        );
    }

    if (warning) {
        parts.push("", `**Warning:** ${warning}`);
    }

    return {
        content: parts.join("\n"),
        details: { ...result, warning },
    };
}

export function renderResultMessage(
    message: { content: string; details?: ResultMessageDetails },
    _options: { expanded: boolean },
    _theme: {
        fg: (color: ThemeColor, text: string) => string;
        bold: (text: string) => string;
    },
): { render(width: number): string[]; invalidate(): void } {
    const mdTheme = getMarkdownTheme();
    const container = new Container();
    const body = new Markdown(message.content, 1, 0, mdTheme);
    container.addChild(body);

    return {
        render(width: number) {
            return container.render(width);
        },
        invalidate() {
            container.invalidate();
        },
    };
}
