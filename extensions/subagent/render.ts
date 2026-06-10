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
import type {
    AgentRunResult,
    BackgroundSubagentDetails,
    ForegroundSubagentDetails,
    UsageStats,
} from "./types.js";
import { isSubagentError } from "./types.js";

// ── Presentation-only types (moved from types.ts) ────────────────────

export type ToolCallStatus = "success" | "error" | "pending";

export type DisplayItem =
    | { type: "text"; text: string }
    | {
          type: "toolCall";
          name: string;
          args: Record<string, unknown>;
          status: ToolCallStatus;
      };

export interface FormatUsageOpts {
    model?: string;
    durationMs?: number;
    contextWindow?: number;
}

// ── Local type aliases ───────────────────────────────────────────────
// ThemeFg and ThemeBg are not public exports of @earendil-works/pi-coding-agent.
// We define local aliases matching the Theme class method signatures.

type ThemeFg = (color: ThemeColor, text: string) => string;
type ThemeBgFn = Theme["bg"];

// ── Constants ────────────────────────────────────────────────────────

export const ICON_RUNNING = "\u25cb";
export const ICON_SUCCESS = "\u25cf";
export const ICON_ERROR = "\u25cf";

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
    const { model, durationMs, contextWindow } = opts ?? {};
    const parts: string[] = [];
    if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
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
    if (durationMs !== undefined) parts.push(formatDuration(durationMs));
    if (model) parts.push(model);
    return parts.join(" ");
}

/** Build the summary line showing tool count and usage stats. */
export function buildLastLine(r: AgentRunResult, toolCallCount: number): string {
    const countStr = toolCallCount > 0 ? `${toolCallCount} tools` : "";
    const usageStr = formatUsageStats(r.usage, {
        model: r.model,
        durationMs: r.durationMs,
        contextWindow: r.contextWindow,
    });
    return [countStr, usageStr].filter(Boolean).join(" ");
}

// ── Tool call formatting ─────────────────────────────────────────────

const HOME_DIR = os.homedir();

function shortenPath(p: string): string {
    return p.startsWith(HOME_DIR) ? `~${p.slice(HOME_DIR.length)}` : p;
}

/** Format a tool call with TUI theme colors. */
export function formatToolCall(
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
export function toolStatusIcon(
    status: ToolCallStatus,
    theme: { fg: ThemeFg },
): string {
    switch (status) {
        case "success":
            return theme.fg("dim", ICON_SUCCESS);
        case "error":
            return ICON_ERROR;
        case "pending":
            return theme.fg("dim", ICON_RUNNING);
    }
}

/** Plain-text status icon for a tool call. */
export function toolStatusIconPlain(status: ToolCallStatus): string {
    switch (status) {
        case "success":
            return ICON_SUCCESS;
        case "error":
            return ICON_ERROR;
        case "pending":
            return ICON_RUNNING;
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

// ── Result renderers ─────────────────────────────────────────────────

/**
 * Render a completed foreground subagent result into a TUI Component.
 *
 * Used by the tool's `renderResult` callback for foreground results.
 */
export function renderSubagentResult(
    details: ForegroundSubagentDetails,
    expanded: boolean,
    theme: {
        fg: ThemeFg;
        bold: (text: string) => string;
    },
): Container | Text {
    const r = details.result;
    const mdTheme = getMarkdownTheme();
    const isRunning = r.outcome.status === "running";
    const isError = !isRunning && isSubagentError(r);
    const execStatusMap = new Map(Object.entries(details.execStatuses));
    const displayItems = getDisplayItems(r.messages, execStatusMap);
    const toolCallItems = displayItems.filter(
        (i) => i.type === "toolCall",
    ) as (DisplayItem & { type: "toolCall" })[];
    const finalOutput = getFinalOutput(r.messages);

    if (expanded) {
        const container = new Container();
        container.addChild(
            new Text(
                theme.fg("muted", "\u2500\u2500\u2500 Task \u2500\u2500\u2500"),
                0,
                0,
            ),
        );
        container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
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
                        ` ${icon} ` +
                            formatToolCall(
                                item.name,
                                item.args,
                                theme.fg.bind(theme),
                            ),
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
        const lastLine = buildLastLine(r, toolCallItems.length);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", lastLine), 0, 0));
        return container;
    }

    // Collapsed view -- last 3 tool calls
    const recentToolCalls = toolCallItems.slice(-3);
    let text = "";
    for (const item of recentToolCalls) {
        if (text) text += "\n";
        const icon = toolStatusIcon(item.status, theme);
        text += ` ${icon} ${formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
    }
    const lastLine = buildLastLine(r, toolCallItems.length);
    if (isError) {
        const errorMsg =
            r.outcome.status === "error"
                ? r.outcome.message
                : r.outcome.status === "aborted"
                  ? r.outcome.message || "(aborted)"
                  : "failed";
        if (text) text += "\n";
        text += theme.fg("error", errorMsg);
        if (lastLine) text += `\n${theme.fg("dim", lastLine)}`;
    } else {
        if (text) text += "\n";
        text += theme.fg("dim", lastLine);
    }
    return new Text(text, 0, 0);
}

/**
 * Render a background subagent result message into a TUI Component.
 *
 * Used by the custom message renderer registered for background results.
 * When `details` is undefined, falls back to rendering `contentText`.
 */
export function renderBackgroundSubagentResult(
    details: BackgroundSubagentDetails | undefined,
    contentText: string,
    expanded: boolean,
    theme: {
        fg: ThemeFg;
        bg: ThemeBgFn;
        bold: (text: string) => string;
    },
): Box | Text {
    if (!details) {
        return new Text(contentText || "(no output)", 0, 0);
    }

    const r = details.result;
    const isCancelled = details.cancelled;
    const isError = !isCancelled && isSubagentError(r);
    const bgFn =
        isCancelled || isError
            ? (t: string) => theme.bg("toolErrorBg", t)
            : (t: string) => theme.bg("toolSuccessBg", t);

    const agentName = r.agent || "...";
    const desc = details.description || "...";
    const status = isCancelled ? "cancelled" : isError ? "error" : "completed";
    const statusColor = isCancelled ? "warning" : isError ? "error" : "success";
    const modelSuffix = r.model ? theme.fg("muted", ` [${r.model}]`) : "";
    const headerText =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("text", agentName) +
        modelSuffix +
        theme.fg("muted", " (bg)") +
        theme.fg(statusColor, ` [${status}]`) +
        theme.fg("dim", ` ${desc}`);

    const output = getFinalOutput(r.messages) || "(no output)";
    const mdTheme = getMarkdownTheme();

    const toolCallCount = countToolCalls(r.messages);
    const usageLine = buildLastLine(r, toolCallCount);

    const box = new Box(1, 1, bgFn);
    box.addChild(new Text(headerText, 0, 0));
    box.addChild(new Spacer(1));

    if (expanded) {
        box.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
    } else {
        const lines = output.trim().split("\n");
        const truncated = lines.length > 3;
        const preview = lines.slice(0, 3).join("\n");
        box.addChild(new Text(preview, 0, 0));
        if (truncated) {
            box.addChild(new Text(theme.fg("muted", "... ctrl-o to expand"), 0, 0));
        }
    }

    if (usageLine) {
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg("dim", usageLine), 0, 0));
    }
    return box;
}
