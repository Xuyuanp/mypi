/**
 * Stateless rendering and formatting for the subagent extension.
 *
 * All functions here produce TUI components or formatted strings but do not
 * mutate extension/framework state, perform subprocess work, or touch the
 * filesystem (except os.homedir() for path abbreviation).
 *
 * Presentation-only types (DisplayItem, ToolCallStatus, FormatUsageOpts)
 * live here — they model how data is shown, not what it is.
 */

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import {
    getMarkdownTheme,
    type Theme,
    type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentRunResult, SubagentDetails, UsageStats } from "./types.js";
import { isSubagentError } from "./types.js";

// ── buildLastLine input type ─────────────────────────────────────────

/** Minimal shape needed by buildLastLine — decoupled from AgentRunResult. */
interface BuildLastLineInput {
    usage: UsageStats;
    durationMs?: number;
    contextWindow?: number;
}

// ── Presentation-only types (moved from types.ts) ────────────────────

type ToolCallStatus = "success" | "error" | "pending";

export type DisplayItem =
    | { type: "text"; text: string }
    | {
          type: "toolCall";
          name: string;
          args: Record<string, unknown>;
          status: ToolCallStatus;
      };

interface FormatUsageOpts {
    durationMs?: number;
    contextWindow?: number;
    toolCallCount?: number;
}

// ── Local type aliases ───────────────────────────────────────────────
// ThemeFg and ThemeBg are not public exports of @earendil-works/pi-coding-agent.
// We define local aliases matching the Theme class method signatures.

type ThemeFg = (color: ThemeColor, text: string) => string;
type ThemeBgFn = Theme["bg"];

// ── Constants ────────────────────────────────────────────────────────

export const ICON_RUNNING = "\u25cb";
const ICON_SUCCESS = "\u25cf";
const ICON_ERROR = "\u25cf";

// ── Formatting helpers ───────────────────────────────────────────────

/** Format a token count into a human-readable short form. */
export function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}

/** Format a duration in milliseconds into a human-readable short form. */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSec = Math.round(seconds % 60);
    return `${minutes}m${remainingSec}s`;
}

/** Build a space-separated usage summary string. */
export function formatUsageStats(usage: UsageStats, opts?: FormatUsageOpts): string {
    const { durationMs, contextWindow, toolCallCount } = opts ?? {};
    const parts: string[] = [];
    if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
    if (toolCallCount)
        parts.push(`${toolCallCount} tool${toolCallCount > 1 ? "s" : ""}`);
    if (usage.inputTokens) parts.push(`\u2191${formatTokens(usage.inputTokens)}`);
    if (usage.outputTokens) parts.push(`\u2193${formatTokens(usage.outputTokens)}`);
    if (usage.cacheReadTokens) parts.push(`R${formatTokens(usage.cacheReadTokens)}`);
    if (usage.cacheWriteTokens)
        parts.push(`W${formatTokens(usage.cacheWriteTokens)}`);
    const promptTokens =
        usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (
        (usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) &&
        promptTokens > 0
    ) {
        parts.push(`CH${Math.round((usage.cacheReadTokens / promptTokens) * 100)}%`);
    }
    if (contextWindow && usage.contextTokens) {
        const pct = Math.round((usage.contextTokens / contextWindow) * 100);
        parts.push(`ctx ${pct}%`);
    }
    if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
    const base = parts.join(" ");
    if (durationMs)
        return base
            ? `${base} in ${formatDuration(durationMs)}`
            : `in ${formatDuration(durationMs)}`;
    return base;
}

/** Build the summary line showing tool count and usage stats. */
export function buildLastLine(r: BuildLastLineInput, toolCallCount: number): string {
    return formatUsageStats(r.usage, {
        durationMs: r.durationMs,
        contextWindow: r.contextWindow,
        toolCallCount,
    });
}

// ── Tool call formatting ─────────────────────────────────────────────

const HOME_DIR = os.homedir();

function shortenPath(p: string): string {
    return p.startsWith(HOME_DIR) ? `~${p.slice(HOME_DIR.length)}` : p;
}

/** Format a tool call with TUI theme colors. */
function formatToolCall(
    toolName: string,
    args: Record<string, unknown>,
    themeFg: ThemeFg,
): string {
    switch (toolName) {
        case "bash": {
            const command = (args.command as string) || "...";
            const preview =
                command.length > 60 ? `${command.slice(0, 60)}...` : command;
            return themeFg("muted", "bash ") + themeFg("dim", preview);
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;
            let text = themeFg("dim", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                text += themeFg(
                    "dim",
                    `:${startLine}${endLine ? `-${endLine}` : ""}`,
                );
            }
            return themeFg("muted", "read ") + text;
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const content = (args.content || "") as string;
            const lines = content.split("\n").length;
            let text = themeFg("muted", "write ") + themeFg("dim", filePath);
            if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
            return text;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return themeFg("muted", "edit ") + themeFg("dim", shortenPath(rawPath));
        }
        case "ls": {
            const rawPath = (args.path || ".") as string;
            return themeFg("muted", "ls ") + themeFg("dim", shortenPath(rawPath));
        }
        case "find": {
            const pattern = (args.pattern || "*") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "find ") +
                themeFg("dim", pattern) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        case "grep": {
            const pattern = (args.pattern || "") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "grep ") +
                themeFg("dim", `/${pattern}/`) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview =
                argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return themeFg("muted", toolName) + themeFg("dim", ` ${preview}`);
        }
    }
}

/** Format a tool call as plain text (no theme colors). */
export function formatToolCallPlain(
    toolName: string,
    args: Record<string, unknown>,
): string {
    switch (toolName) {
        case "bash": {
            const command = (args.command as string) || "...";
            const preview =
                command.length > 60 ? `${command.slice(0, 60)}...` : command;
            return `bash ${preview}`;
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return `read ${shortenPath(rawPath)}`;
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return `write ${shortenPath(rawPath)}`;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return `edit ${shortenPath(rawPath)}`;
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview =
                argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return `${toolName} ${preview}`;
        }
    }
}

// ── Status icons ─────────────────────────────────────────────────────

/** Themed status icon for a tool call. */
function toolStatusIcon(status: ToolCallStatus, theme: { fg: ThemeFg }): string {
    switch (status) {
        case "success":
            return theme.fg("dim", ICON_SUCCESS);
        case "error":
            return ICON_ERROR;
        case "pending":
            return theme.fg("dim", ICON_RUNNING);
    }
}

// ── Message inspection ───────────────────────────────────────────────

/** Extract display items (text + tool calls with status) from messages. */
export function getDisplayItems(
    messages: Message[],
    execStatusMap?: Map<string, boolean>,
): DisplayItem[] {
    const items: DisplayItem[] = [];
    const resultMap = new Map<string, boolean>();
    for (const msg of messages) {
        if (msg.role === "toolResult") {
            resultMap.set(msg.toolCallId, msg.isError);
        }
    }
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text")
                    items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall") {
                    let status: ToolCallStatus = "pending";
                    if (resultMap.has(part.id)) {
                        status = resultMap.get(part.id) ? "error" : "success";
                    } else if (execStatusMap?.has(part.id)) {
                        status = execStatusMap.get(part.id) ? "error" : "success";
                    }
                    items.push({
                        type: "toolCall",
                        name: part.name,
                        args: part.arguments,
                        status,
                    });
                }
            }
        }
    }
    return items;
}

/** Get the final text output from the last assistant message. */
export function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") return part.text;
            }
        }
    }
    return "";
}

/** Count tool calls in a message array (single pass, no allocation). */
export function countToolCalls(messages: Message[]): number {
    let count = 0;
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "toolCall") count++;
            }
        }
    }
    return count;
}

// ── Result renderer ──────────────────────────────────────────────────

interface RenderTheme {
    fg: ThemeFg;
    bg?: ThemeBgFn;
    bold: (text: string) => string;
}

/** Build the background Box wrapper function based on error/cancel state. */
function resolveBgFn(
    isCancelled: boolean,
    isError: boolean,
    theme: RenderTheme,
): ((t: string) => string) | undefined {
    if (!theme.bg) return undefined;
    return isCancelled || isError
        ? (t: string) => theme.bg!("toolErrorBg", t)
        : (t: string) => theme.bg!("toolSuccessBg", t);
}

/** Create the appropriate container: Box (with bg) or plain Container. */
function makeContainer(bgFn: ((t: string) => string) | undefined): Box | Container {
    return bgFn ? new Box(1, 1, bgFn) : new Container();
}

/** Append expanded content (Task + Output + tools + markdown + usage) to a container. */
function appendExpandedContent(
    container: Box | Container,
    task: string,
    toolCallItems: (DisplayItem & { type: "toolCall" })[],
    finalOutput: string,
    lastLine: string,
    theme: RenderTheme,
): void {
    const mdTheme = getMarkdownTheme();
    container.addChild(
        new Text(
            theme.fg("muted", "\u2500\u2500\u2500 Task \u2500\u2500\u2500"),
            0,
            0,
        ),
    );
    container.addChild(new Text(theme.fg("dim", task), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(
        new Text(
            theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"),
            0,
            0,
        ),
    );
    if (toolCallItems.length === 0 && !finalOutput) {
        container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
    } else {
        for (const item of toolCallItems) {
            const icon = toolStatusIcon(item.status, theme);
            container.addChild(
                new Text(
                    ` ${icon} ${formatToolCall(item.name, item.args, theme.fg.bind(theme))}`,
                    0,
                    0,
                ),
            );
        }
        if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
        }
    }
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", lastLine), 0, 0));
}

/** Build collapsed output preview text (first 3 lines + expand hint). */
function buildOutputPreview(finalOutput: string, theme: RenderTheme): string {
    const output = finalOutput || "(no output)";
    const lines = output.trim().split("\n");
    const truncated = lines.length > 3;
    let text = lines.slice(0, 3).join("\n");
    if (truncated) {
        text += `\n${theme.fg("muted", "... ctrl-o to expand")}`;
    }
    return text;
}

/** Build collapsed tool call text (last 3 with status icons). */
function buildRecentToolCallsText(
    toolCallItems: (DisplayItem & { type: "toolCall" })[],
    theme: RenderTheme,
): string {
    const recent = toolCallItems.slice(-3);
    let text = "";
    for (const item of recent) {
        if (text) text += "\n";
        const icon = toolStatusIcon(item.status, theme);
        text += ` ${icon} ${formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
    }
    return text;
}

/** Render the background-running state (header + optional task). */
function renderBackgroundRunning(
    headerText: string,
    result: AgentRunResult,
    expanded: boolean,
    bgFn: ((t: string) => string) | undefined,
    theme: RenderTheme,
): Box | Container {
    const box = makeContainer(bgFn);
    box.addChild(new Text(headerText, 0, 0));
    if (expanded && result.task) {
        box.addChild(new Spacer(1));
        box.addChild(
            new Text(
                theme.fg("muted", "\u2500\u2500\u2500 Task \u2500\u2500\u2500"),
                0,
                0,
            ),
        );
        box.addChild(new Text(theme.fg("dim", result.task), 0, 0));
    }
    return box;
}

/** Build background header text line. */
function buildBackgroundHeader(
    details: SubagentDetails,
    isRunning: boolean,
    isCancelled: boolean,
    isError: boolean,
    theme: RenderTheme,
): string {
    const agentName = details.result.agent || "...";
    const model = details.result.model;
    const statusLabel = isRunning
        ? "running"
        : isCancelled
          ? "cancelled"
          : isError
            ? "error"
            : "completed";
    const statusColor: ThemeColor = isRunning
        ? "muted"
        : isCancelled
          ? "warning"
          : isError
            ? "error"
            : "success";
    const desc = details.description || "...";
    return (
        theme.fg("toolTitle", theme.bold("background agent ")) +
        theme.fg("text", agentName) +
        (model ? theme.fg("muted", ` ${model}`) : "") +
        theme.fg(statusColor, ` [${statusLabel}]`) +
        theme.fg("dim", ` ${desc}`)
    );
}

/**
 * Unified renderer for subagent results (foreground + background).
 *
 * Dispatches to focused helpers based on kind, state, and expanded flag.
 * Background results get a colored Box wrapper and header line;
 * foreground results render bare (renderCall provides the header).
 */
export function renderSubagentResult(
    details: SubagentDetails,
    expanded: boolean,
    theme: RenderTheme,
): Container | Box | Text {
    const r = details.result;
    const isForeground = details.kind === "foreground";
    const isCancelled = !isForeground && (details.cancelled ?? false);
    // "running" is no longer a valid AgentOutcome variant, but old
    // serialized sessions may still contain it. Guard at runtime.
    const isRunning = (r.outcome as { status: string }).status === "running";
    const isError = !isRunning && !isCancelled && isSubagentError(r);

    // ── Shared data ──────────────────────────────────────────────────
    const agentId = details.session?.id;
    const execStatusMap = new Map(Object.entries(details.execStatuses ?? {}));
    const displayItems = getDisplayItems(r.messages, execStatusMap);
    const toolCallItems = displayItems.filter(
        (i) => i.type === "toolCall",
    ) as (DisplayItem & { type: "toolCall" })[];
    const rawLastLine = buildLastLine(
        { ...r, contextWindow: details.contextWindow },
        toolCallItems.length,
    );
    const lastLine = agentId ? `${agentId} ${rawLastLine}` : rawLastLine;
    const finalOutput = getFinalOutput(r.messages);

    // ── Background agent ─────────────────────────────────────────────
    if (!isForeground) {
        const bgFn = resolveBgFn(isCancelled, isError, theme);
        const headerText = buildBackgroundHeader(
            details,
            isRunning,
            isCancelled,
            isError,
            theme,
        );

        if (isRunning) {
            return renderBackgroundRunning(headerText, r, expanded, bgFn, theme);
        }

        if (expanded) {
            const container = makeContainer(bgFn);
            container.addChild(new Text(headerText, 0, 0));
            container.addChild(new Spacer(1));
            appendExpandedContent(
                container,
                r.task,
                toolCallItems,
                finalOutput,
                lastLine,
                theme,
            );
            return container;
        }

        // Background collapsed
        const box = makeContainer(bgFn);
        box.addChild(new Text(headerText, 0, 0));
        box.addChild(new Spacer(1));
        box.addChild(new Text(buildOutputPreview(finalOutput, theme), 0, 0));
        if (lastLine) {
            box.addChild(new Spacer(1));
            box.addChild(new Text(theme.fg("dim", lastLine), 0, 0));
        }
        return box;
    }

    // ── Foreground expanded ──────────────────────────────────────────
    if (expanded) {
        const container = new Container();
        appendExpandedContent(
            container,
            r.task,
            toolCallItems,
            finalOutput,
            lastLine,
            theme,
        );
        return container;
    }

    // ── Foreground collapsed ─────────────────────────────────────────
    const isCompleted = !isError;
    // Show output preview only after execution finishes (durationMs > 0).
    // During streaming (durationMs === 0), prefer showing recent tool calls
    // so progress is visible even when an early text message sets finalOutput.
    const isFinished = isCompleted && r.durationMs > 0;
    let text =
        isFinished && finalOutput
            ? buildOutputPreview(finalOutput, theme)
            : buildRecentToolCallsText(toolCallItems, theme);

    if (isError) {
        const errorMsg =
            r.outcome.status === "error"
                ? r.outcome.message
                : r.outcome.status === "aborted"
                  ? r.outcome.message || "(aborted)"
                  : "failed";
        if (text) text += "\n";
        text += theme.fg("error", errorMsg);
    }
    if (lastLine) {
        if (text) text += "\n";
        text += theme.fg("dim", lastLine);
    }
    return new Text(text, 0, 0);
}
