/**
 * Subagent Tool - Task delegation to specialized agents.
 *
 * Discovers agent definitions (system + user) from .md files with
 * YAML frontmatter, each specifying allowed tools, model, and a
 * system prompt body. Spawns an isolated `pi` subprocess per
 * invocation (--mode json, no extensions/skills) and streams
 * structured JSON events (message_end, tool_execution_start/end,
 * tool_result_end) back in real-time.
 *
 * Key capabilities:
 * - Concurrent execution: no executionMode declared, so the agent
 *   loop can batch multiple subagent calls via Promise.all.
 * - Model override: per-call model param > agent default > parent.
 * - Abort support: SIGTERM on signal, SIGKILL after 5s timeout.
 * - TUI rendering: collapsed/expanded views with tool-specific
 *   formatting, status icons, and usage stats (tokens/cost/time).
 * - Token tracking: accumulates input, output, cache read/write,
 *   cost, and context tokens across all turns.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

import {
    type ExtensionAPI,
    type ExtensionContext,
    getMarkdownTheme,
    type Skill,
    type ThemeColor,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
    Box,
    Container,
    Markdown,
    Spacer,
    Text,
    truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";
import { registerSubagentCommand } from "./command.js";

export interface BackgroundAgent {
    id: string;
    description: string;
    agent: AgentConfig;
    task: string;
    kill: () => void;
    promise: Promise<AgentRunResult>;
    startedAt: number;
    latestResult: AgentRunResult;
    toolCallCount: number;
}

const ICON_RUNNING = "○";
const BG_WIDGET_KEY = "subagent-bg";
const ICON_SUCCESS = "●";
const ICON_ERROR = "●";

function isSubagentError(r: AgentRunResult): boolean {
    return (
        r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted"
    );
}
type ToolCallStatus = "success" | "error" | "pending";

function toolStatusIconPlain(status: ToolCallStatus): string {
    switch (status) {
        case "success":
            return ICON_SUCCESS;
        case "error":
            return ICON_ERROR;
        case "pending":
            return ICON_RUNNING;
    }
}

function toolStatusIcon(
    status: ToolCallStatus,
    theme: { fg: (color: ThemeColor, text: string) => string },
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

const SUBAGENT_PREAMBLE = `${[
    "You are now running as a subagent.",
    "All the `user` messages are sent by the main agent.",
    "The main agent cannot see your context,",
    "it can only see your last message when you finish the task.",
    "You must treat the parent agent as your caller.",
    "Do not directly ask the end user questions.",
    "If something is unclear,",
    "explain the ambiguity in your final summary to the parent agent.",
].join(" ")}
`;

function escapeXml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSec = Math.round(seconds % 60);
    return `${minutes}m${remainingSec}s`;
}

interface FormatUsageOpts {
    model?: string;
    durationMs?: number;
    contextWindow?: number;
}

function formatUsageStats(usage: UsageStats, opts?: FormatUsageOpts): string {
    const { model, durationMs, contextWindow } = opts ?? {};
    const parts: string[] = [];
    if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
    if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
    if (contextWindow && usage.contextTokens) {
        const pct = Math.round((usage.contextTokens / contextWindow) * 100);
        parts.push(`ctx ${pct}%`);
    }
    if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
    if (durationMs !== undefined) parts.push(formatDuration(durationMs));
    if (model) parts.push(model);
    return parts.join(" ");
}

function buildLastLine(r: AgentRunResult, toolCallCount: number): string {
    const countStr = toolCallCount > 0 ? `${toolCallCount} tools` : "";
    const usageStr = formatUsageStats(r.usage, {
        model: r.model,
        durationMs: r.durationMs,
        contextWindow: r.contextWindow,
    });
    return [countStr, usageStr].filter(Boolean).join(" ");
}

/**
 * Parse a model string in `provider/id` or `provider/id:thinkingLevel` form.
 * Returns null if the string doesn't contain a provider/id separator.
 */
function parseModelStr(
    modelStr: string,
): { provider: string; id: string; thinkingLevel?: string } | null {
    const slash = modelStr.indexOf("/");
    if (slash === -1) return null;
    const provider = modelStr.slice(0, slash);
    const rest = modelStr.slice(slash + 1);
    const match = rest.match(/^(.+):([a-z]+)$/);
    if (match) return { provider, id: match[1], thinkingLevel: match[2] };
    return { provider, id: rest };
}

/**
 * Resolve the context window (in tokens) for the subagent's model.
 *
 * Falls back to the parent model's context window when the subagent inherits
 * the parent model or the model cannot be resolved.
 */
function resolveContextWindow(
    modelStr: string | undefined,
    ctx: ExtensionContext,
): number | undefined {
    if (!modelStr) return ctx.model?.contextWindow;
    const parsed = parseModelStr(modelStr);
    if (!parsed) return ctx.model?.contextWindow;
    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    return model?.contextWindow ?? ctx.model?.contextWindow;
}

function formatToolCall(
    toolName: string,
    args: Record<string, unknown>,
    themeFg: (color: any, text: string) => string,
): string {
    const shortenPath = (p: string) => {
        const home = os.homedir();
        return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
    };

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

function formatToolCallPlain(
    toolName: string,
    args: Record<string, unknown>,
): string {
    const shortenPath = (p: string) => {
        const home = os.homedir();
        return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
    };

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

interface UsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    /** Prompt size of the most recent assistant turn (input + cache read + cache write). */
    contextTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
    turns: number;
}

export function createZeroUsage(): UsageStats {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        contextTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        turns: 0,
    };
}

function accumulateUsage(
    target: UsageStats,
    source: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            total?: number;
        };
    },
): void {
    target.input += source.input || 0;
    target.output += source.output || 0;
    target.cacheRead += source.cacheRead || 0;
    target.cacheWrite += source.cacheWrite || 0;
    target.totalTokens += source.totalTokens || 0;
    const cost = source.cost;
    if (cost) {
        target.cost.input += cost.input || 0;
        target.cost.output += cost.output || 0;
        target.cost.cacheRead += cost.cacheRead || 0;
        target.cost.cacheWrite += cost.cacheWrite || 0;
        target.cost.total += cost.total || 0;
    }
}

const ZERO_USAGE: Readonly<UsageStats> = Object.freeze({
    ...createZeroUsage(),
    cost: Object.freeze(createZeroUsage().cost),
});

interface AgentRunResult {
    agent: string;
    agentSource: "user" | "system" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    contextWindow?: number;
    stopReason?: string;
    errorMessage?: string;
    durationMs?: number;
}

interface SubagentDetails {
    result: AgentRunResult;
    execStatuses?: Record<string, boolean>;
    description?: string;
}

function getFinalOutput(messages: Message[]): string {
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

type DisplayItem =
    | { type: "text"; text: string }
    | {
          type: "toolCall";
          name: string;
          args: Record<string, any>;
          status: ToolCallStatus;
      };

function getDisplayItems(
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

/** Count tool calls in a message array (single pass, no allocation). */
function countToolCalls(messages: Message[]): number {
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

/**
 * Sanitize an agent name for use in filesystem identifiers (session IDs, temp files).
 * Replaces non-word chars with "_", trims non-alphanumeric edges, falls back to "agent".
 */
function sanitizeAgentName(name: string): string {
    return (
        name
            .replace(/[^\w.-]+/g, "_")
            .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "") || "agent"
    );
}

async function writePromptToTempFile(
    agentName: string,
    prompt: string,
): Promise<string> {
    const safeName = sanitizeAgentName(agentName);
    const filePath = path.join(
        os.tmpdir(),
        `pi-subagent-${safeName}-${randomUUID()}.md`,
    );
    await withFileMutationQueue(filePath, async () => {
        await fs.promises.writeFile(filePath, prompt, {
            encoding: "utf-8",
            mode: 0o600,
        });
    });
    return filePath;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }

    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: process.execPath, args };
    }

    return { command: "pi", args };
}

type SubagentProgressEvent =
    | { type: "message" }
    | { type: "tool_start"; toolCallId: string }
    | { type: "tool_end"; toolCallId: string; isError: boolean }
    | { type: "tool_result" };

type SubagentProgressCallback = (
    result: AgentRunResult,
    event: SubagentProgressEvent,
) => void;

async function runSubagent(
    agent: AgentConfig,
    task: string,
    cwd: string,
    signal: AbortSignal | undefined,
    onProgress: SubagentProgressCallback | undefined,
    session: { dir: string; id: string } | undefined,
    ctx: ExtensionContext,
): Promise<AgentRunResult> {
    const args: string[] = [
        "--mode",
        "json",
        "--no-extensions",
        "--no-context-files",
        "--offline",
        "--print",
    ];

    if (session) {
        args.push("--session-dir", session.dir, "--session-id", session.id);
    } else {
        args.push("--no-session");
    }
    // --no-skills disables auto-discovered skills;
    // --skill re-adds specific ones (resolved file paths).
    args.push("--no-skills");
    if (agent.skills?.length) {
        for (const skill of agent.skills) {
            args.push("--skill", skill);
        }
    }
    const modelArg = agent.model;
    if (modelArg) args.push("--model", modelArg);
    // Disable thinking unless the model name includes a thinking level
    // (e.g., "anthropic/claude-sonnet:high")
    const hasThinkingLevel = modelArg && parseModelStr(modelArg)?.thinkingLevel;
    if (!hasThinkingLevel) args.push("--thinking", "off");
    if (agent.tools && agent.tools.length > 0)
        args.push("--tools", agent.tools.join(","));

    let tmpPromptPath: string | null = null;

    const contextWindow = resolveContextWindow(agent.model, ctx);

    const currentResult: AgentRunResult = {
        agent: agent.name,
        agentSource: agent.source,
        task,
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: createZeroUsage(),
        model: modelArg,
        contextWindow,
    };

    const startTime = Date.now();

    try {
        const fullSystemPrompt = agent.systemPrompt.trim()
            ? `${SUBAGENT_PREAMBLE}\n${agent.systemPrompt}`
            : SUBAGENT_PREAMBLE.trim();
        tmpPromptPath = await writePromptToTempFile(agent.name, fullSystemPrompt);
        args.push("--append-system-prompt", tmpPromptPath);

        args.push(`Task: ${task}`);
        let wasAborted = false;

        const exitCode = await new Promise<number>((resolve) => {
            const invocation = getPiInvocation(args);
            const proc = spawn(invocation.command, invocation.args, {
                cwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                    ...process.env,
                    PI_SUBAGENT: "1",
                    PI_SUBAGENT_NAME: agent.name,
                },
            });
            let buffer = "";

            const processLine = (line: string) => {
                if (!line.trim()) return;
                let event: any;
                try {
                    event = JSON.parse(line);
                } catch {
                    return;
                }

                if (event.type === "message_end" && event.message) {
                    const msg = event.message as Message;
                    currentResult.messages.push(msg);

                    if (msg.role === "assistant") {
                        currentResult.usage.turns++;
                        if (msg.usage) {
                            accumulateUsage(currentResult.usage, msg.usage);
                            // Context size is the latest turn's prompt, not a
                            // running total, so overwrite rather than accumulate.
                            currentResult.usage.contextTokens =
                                (msg.usage.input || 0) +
                                (msg.usage.cacheRead || 0) +
                                (msg.usage.cacheWrite || 0);
                        }
                        if (!currentResult.model && msg.model) {
                            currentResult.model = msg.model;
                            currentResult.contextWindow = resolveContextWindow(
                                msg.model,
                                ctx,
                            );
                        }
                        if (msg.stopReason)
                            currentResult.stopReason = msg.stopReason;
                        if (msg.errorMessage)
                            currentResult.errorMessage = msg.errorMessage;
                    }
                    onProgress?.(currentResult, { type: "message" });
                }

                if (event.type === "tool_execution_start" && event.toolCallId) {
                    onProgress?.(currentResult, {
                        type: "tool_start",
                        toolCallId: event.toolCallId,
                    });
                }

                if (event.type === "tool_execution_end" && event.toolCallId) {
                    onProgress?.(currentResult, {
                        type: "tool_end",
                        toolCallId: event.toolCallId,
                        isError: !!event.isError,
                    });
                }

                if (event.type === "tool_result_end" && event.message) {
                    currentResult.messages.push(event.message as Message);
                    onProgress?.(currentResult, { type: "tool_result" });
                }
            };

            proc.stdout.on("data", (data) => {
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) processLine(line);
            });

            proc.stderr.on("data", (data) => {
                currentResult.stderr += data.toString();
            });

            proc.on("close", (code) => {
                if (buffer.trim()) processLine(buffer);
                resolve(code ?? 0);
            });

            proc.on("error", () => {
                resolve(1);
            });

            if (signal) {
                let exited = false;
                proc.on("close", () => {
                    exited = true;
                });
                const killProc = () => {
                    wasAborted = true;
                    proc.kill("SIGTERM");
                    setTimeout(() => {
                        if (!exited) proc.kill("SIGKILL");
                    }, 5000);
                };
                if (signal.aborted) killProc();
                else signal.addEventListener("abort", killProc, { once: true });
            }
        });

        currentResult.exitCode = exitCode;
        currentResult.durationMs = Date.now() - startTime;
        if (wasAborted) throw new Error("Subagent was aborted");
        return currentResult;
    } finally {
        if (tmpPromptPath)
            try {
                fs.unlinkSync(tmpPromptPath);
            } catch {
                /* ignore */
            }
    }
}

const SubagentParams = Type.Object({
    agent: Type.String({
        description: "Name of the agent to invoke",
    }),
    description: Type.String({
        description: "A short (3-5 word) summary of what this subagent will do",
    }),
    task: Type.String({
        description: "Task to delegate to the agent",
    }),
    model: Type.Optional(
        Type.String({
            description:
                'Override the model for this invocation (e.g. "anthropic/claude-sonnet:high"). Only set this when the user explicitly requests a specific model; otherwise omit it to use the agent default.',
        }),
    ),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory for the agent process",
        }),
    ),
    skills: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "Override skills for this invocation. Replaces agent default skills.",
        }),
    ),
    background: Type.Optional(
        Type.Boolean({
            description:
                "Run in background -- returns immediately with an agent ID. Result is delivered later as a follow-up message. Use when you can continue other work without waiting for this agent's output.",
        }),
    ),
});

function buildToolDescription(agents: AgentConfig[]): string {
    const agentList =
        agents.length > 0
            ? agents
                  .map(
                      (a) =>
                          `<agent>\n  <name>${escapeXml(a.name)}</name>\n  <description>${escapeXml(a.description)}</description>\n</agent>`,
                  )
                  .join("\n")
            : "(none)";

    return `Start a subagent instance to work on a focused task.

Each instance runs in an isolated context with its own tool set.
The subagent result is only visible to you. If the user should see it, summarize it yourself.

<available_agents>
${agentList}
</available_agents>

**Usage**

- Use \`agent\` to select an available agent by name.
- Always provide a short \`description\` (3-5 words) summarizing the task.
- Provide a clear, self-contained \`task\`. The subagent has no access to your conversation history.
- Be explicit about whether the subagent should write code or only do research.
- Only set \`model\` when the user explicitly requests a specific model; otherwise omit it to use the agent default.
- Use \`cwd\` to override the working directory when the task targets a different project root.

**When NOT to Use Subagent**

- Reading a known file path
- Searching a small number of known files
- Tasks that can be completed in one or two direct tool calls`;
}

const BACKGROUND_RESULT_TYPE = "subagent_background_result";

/**
 * Render a completed subagent result into a Component (shared between
 * foreground renderResult and background message renderer).
 */
function renderSubagentResult(
    details: SubagentDetails,
    expanded: boolean,
    theme: {
        fg: (color: ThemeColor, text: string) => string;
        bold: (text: string) => string;
    },
): Container | Text {
    const r = details.result;
    const mdTheme = getMarkdownTheme();
    const isError = isSubagentError(r);
    const execStatusMap = details.execStatuses
        ? new Map(Object.entries(details.execStatuses))
        : undefined;
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
        const errorMsg = r.errorMessage || r.stopReason || "failed";
        if (text) text += "\n";
        text += theme.fg("error", errorMsg);
        if (lastLine) text += `\n${theme.fg("dim", lastLine)}`;
    } else {
        if (text) text += "\n";
        text += theme.fg("dim", lastLine);
    }
    return new Text(text, 0, 0);
}

export default function (pi: ExtensionAPI) {
    // Pre-load agents at registration time so the LLM
    // knows which agents are available from the tool description.
    const knownAgents = discoverAgents().agents;

    // Background agent tracking
    const backgroundAgents = new Map<string, BackgroundAgent>();
    let sessionActive = true;
    let currentCtx: ExtensionContext | null = null;
    let widgetActive = false;

    function updateWidget(): void {
        const ctx = currentCtx;
        if (!ctx) return;
        const count = backgroundAgents.size;

        if (count === 0) {
            if (widgetActive) {
                ctx.ui.setWidget(BG_WIDGET_KEY, undefined);
                widgetActive = false;
            }
            ctx.ui.setStatus(BG_WIDGET_KEY, undefined);
            return;
        }

        // Update status count
        ctx.ui.setStatus(
            BG_WIDGET_KEY,
            ctx.ui.theme.fg("accent", `${ICON_RUNNING} ${count} bg`),
        );

        // Create widget only on first spawn (0 -> 1 transition)
        if (!widgetActive) {
            ctx.ui.setWidget(BG_WIDGET_KEY, (tui, theme) => {
                const interval = setInterval(() => tui.requestRender(), 1000);
                return {
                    render(width: number): string[] {
                        const lines: string[] = [];
                        const MAX_ENTRIES = 5;
                        const ICON_W = 2; // "X "
                        const NAME_W = 10; // agent name + padding
                        const ID_W = 10; // short uuid + spacing
                        const FIXED_W = ICON_W + NAME_W + ID_W;
                        const descAvail = Math.max(8, width - FIXED_W);

                        let rendered = 0;
                        for (const entry of backgroundAgents.values()) {
                            if (rendered >= MAX_ENTRIES) {
                                const remaining =
                                    backgroundAgents.size - MAX_ENTRIES;
                                lines.push(
                                    truncateToWidth(
                                        theme.fg("muted", `  +${remaining} more`),
                                        width,
                                    ),
                                );
                                break;
                            }
                            const r = entry.latestResult;
                            const elapsed = Date.now() - entry.startedAt;

                            // Line 1: icon + agent + id + description
                            const agentName = entry.agent.name.padEnd(8).slice(0, 8);
                            const shortId = entry.id.slice(
                                entry.id.lastIndexOf("-") + 1,
                            );
                            const desc = truncateToWidth(
                                entry.description,
                                descAvail,
                                "\u2026",
                            );
                            const line1 =
                                `${theme.fg("accent", ICON_RUNNING)} ` +
                                `${theme.fg("muted", agentName)}  ` +
                                `${theme.fg("dim", shortId)}  ` +
                                `${theme.fg("muted", desc)}`;
                            lines.push(truncateToWidth(line1, width));

                            // Line 2: usage (toolCallCount pre-computed in onProgress)
                            const usageLine = buildLastLine(
                                {
                                    ...r,
                                    durationMs: elapsed,
                                    contextWindow: undefined,
                                },
                                entry.toolCallCount,
                            );
                            const line2 = `  ${theme.fg("dim", usageLine)}`;
                            lines.push(truncateToWidth(line2, width));
                            rendered++;
                        }
                        return lines;
                    },
                    invalidate(): void {
                        /* no-op: render is stateless */
                    },
                    dispose(): void {
                        clearInterval(interval);
                    },
                };
            });
            widgetActive = true;
        }
    }

    registerSubagentCommand(pi, backgroundAgents, updateWidget);

    // Cache loaded skills from the parent session so we can resolve
    // skill names to filesystem paths for --skill flags.
    let skillCache = new Map<string, Skill>();

    pi.on("session_start", (_event, ctx) => {
        sessionActive = true;
        currentCtx = ctx;
        widgetActive = false;
    });

    pi.on("session_shutdown", async () => {
        sessionActive = false;
        // Clear widget and status before killing (so UI is clean immediately)
        if (currentCtx) {
            currentCtx.ui.setWidget(BG_WIDGET_KEY, undefined);
            currentCtx.ui.setStatus(BG_WIDGET_KEY, undefined);
        }
        widgetActive = false;
        currentCtx = null;
        const entries = [...backgroundAgents.values()];
        if (entries.length === 0) return;
        for (const entry of entries) {
            entry.kill();
        }
        await Promise.allSettled(entries.map((e) => e.promise));
        backgroundAgents.clear();
    });

    pi.on("before_agent_start", (event) => {
        const skills = event.systemPromptOptions.skills;
        skillCache = skills ? new Map(skills.map((s) => [s.name, s])) : new Map();
    });

    // Register custom message renderer for background agent results
    pi.registerMessageRenderer<SubagentDetails>(
        BACKGROUND_RESULT_TYPE,
        (message, { expanded }, theme) => {
            const details = message.details;
            if (!details) {
                const content =
                    typeof message.content === "string"
                        ? message.content
                        : message.content
                              .map((p) => (p.type === "text" ? p.text : ""))
                              .join("");
                return new Text(content || "(no output)", 0, 0);
            }

            const r = details.result;
            const isError = isSubagentError(r);
            const bgFn = isError
                ? (t: string) => theme.bg("toolErrorBg", t)
                : (t: string) => theme.bg("toolSuccessBg", t);

            const agentName = r.agent || "...";
            const desc = details.description || "...";
            const status = isError ? "error" : "completed";
            const statusColor = isError ? "error" : "success";
            const headerText =
                theme.fg("toolTitle", theme.bold("subagent ")) +
                theme.fg("text", agentName) +
                theme.fg("muted", " (bg)") +
                theme.fg(statusColor, ` [${status}]`) +
                theme.fg("dim", ` ${desc}`);

            const output = getFinalOutput(r.messages) || "(no output)";
            const mdTheme = getMarkdownTheme();

            const execStatusMap = details.execStatuses
                ? new Map(Object.entries(details.execStatuses))
                : undefined;
            const displayItems = getDisplayItems(r.messages, execStatusMap);
            const toolCallCount = displayItems.filter(
                (i) => i.type === "toolCall",
            ).length;
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
                    box.addChild(
                        new Text(theme.fg("muted", "... ctrl-o to expand"), 0, 0),
                    );
                }
            }

            if (usageLine) {
                box.addChild(new Spacer(1));
                box.addChild(new Text(theme.fg("dim", usageLine), 0, 0));
            }
            return box;
        },
    );

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: buildToolDescription(knownAgents),
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const agents = discoverAgents().agents;

            const execStatusMap = new Map<string, boolean>();

            const makeDetails = (result: AgentRunResult): SubagentDetails => ({
                result,
                execStatuses: Object.fromEntries(execStatusMap),
            });

            const onProgress: SubagentProgressCallback | undefined = onUpdate
                ? (result, event) => {
                      if (event.type === "tool_end") {
                          execStatusMap.set(event.toolCallId, event.isError);
                      }

                      const items = getDisplayItems(result.messages, execStatusMap);
                      let lastToolCall: (DisplayItem & { type: "toolCall" }) | null =
                          null;
                      for (let i = items.length - 1; i >= 0; i--) {
                          const item = items[i];
                          if (item.type === "toolCall") {
                              lastToolCall = item;
                              break;
                          }
                      }

                      const lastToolLine = lastToolCall
                          ? `${toolStatusIconPlain(lastToolCall.status)} ${formatToolCallPlain(lastToolCall.name, lastToolCall.args)}`
                          : "(running...)";

                      const usageStr = formatUsageStats(result.usage, {
                          model: result.model,
                          contextWindow: result.contextWindow,
                      });
                      const statusLine = usageStr
                          ? `${ICON_RUNNING} ${usageStr}`
                          : ICON_RUNNING;

                      onUpdate({
                          content: [
                              {
                                  type: "text",
                                  text: `${lastToolLine}\n${statusLine}`,
                              },
                          ],
                          details: makeDetails(result),
                      });
                  }
                : undefined;

            const earlyError = (
                msg: string,
                agentSource: AgentRunResult["agentSource"],
            ) => ({
                content: [{ type: "text" as const, text: msg }],
                details: makeDetails({
                    agent: params.agent,
                    agentSource,
                    task: params.task,
                    exitCode: 1,
                    messages: [],
                    stderr: msg,
                    usage: ZERO_USAGE,
                }),
                isError: true,
            });

            const parentModel = ctx.model
                ? `${ctx.model.provider}/${ctx.model.id}`
                : undefined;

            const agent = agents.find((a) => a.name === params.agent);

            if (!agent) {
                const available =
                    agents.map((a) => `"${a.name}"`).join(", ") || "none";
                const msg = `Unknown agent: "${params.agent}". Available agents: ${available}.`;
                return earlyError(msg, "unknown");
            }

            const skillNames =
                params.skills !== undefined ? params.skills : agent.skills;
            const unresolvedSkills = skillNames?.filter(
                (name) => !skillCache.has(name),
            );
            if (unresolvedSkills?.length) {
                const available =
                    skillCache.size > 0
                        ? [...skillCache.keys()].map((n) => `"${n}"`).join(", ")
                        : "none (skill cache empty)";
                const msg = `Unknown skill${unresolvedSkills.length > 1 ? "s" : ""}: ${unresolvedSkills.map((n) => `"${n}"`).join(", ")}. Available: ${available}.`;
                return earlyError(msg, agent.source);
            }
            const resolvedSkillPaths = skillNames?.map(
                (name) => skillCache.get(name)!.filePath,
            );

            // Note: skills is overwritten from names to resolved file paths
            // for the subprocess --skill flag.
            const resolvedAgent: AgentConfig = {
                ...agent,
                model: (params.model || undefined) ?? agent.model ?? parentModel,
                skills: resolvedSkillPaths?.length ? resolvedSkillPaths : undefined,
            };

            // Persist subagent session alongside the parent session.
            // Layout: <parent-session-without-ext>/subagent/<name>-<uuid8>.jsonl
            // (Pi prepends its own timestamp to the filename.)
            let session: { dir: string; id: string } | undefined;
            const parentSessionFile = ctx.sessionManager.getSessionFile();
            if (parentSessionFile) {
                const dir = path.resolve(
                    parentSessionFile.slice(0, -".jsonl".length),
                    "subagent",
                );
                const safeName = sanitizeAgentName(resolvedAgent.name);
                const id = `${safeName}-${randomUUID().slice(0, 8)}`;
                session = { dir, id };
            }

            // ── Background mode ──────────────────────────────────────
            if (params.background) {
                const id =
                    session?.id ??
                    `${sanitizeAgentName(resolvedAgent.name)}-${randomUUID().slice(0, 8)}`;

                const controller = new AbortController();

                let entry: BackgroundAgent | undefined;

                const bgOnProgress: SubagentProgressCallback = (result) => {
                    if (!entry) return;
                    entry.latestResult = result;
                    entry.toolCallCount = countToolCalls(result.messages);
                };

                const promise = runSubagent(
                    resolvedAgent,
                    params.task,
                    params.cwd ?? ctx.cwd,
                    controller.signal,
                    bgOnProgress,
                    session,
                    ctx,
                );

                entry = {
                    id,
                    description: params.description,
                    agent: resolvedAgent,
                    task: params.task,
                    kill: () => controller.abort(),
                    promise,
                    startedAt: Date.now(),
                    toolCallCount: 0,
                    latestResult: {
                        agent: resolvedAgent.name,
                        agentSource: resolvedAgent.source,
                        task: params.task,
                        exitCode: -1,
                        messages: [],
                        stderr: "",
                        usage: createZeroUsage(),
                        model: resolvedAgent.model,
                        contextWindow: resolveContextWindow(
                            resolvedAgent.model,
                            ctx,
                        ),
                    },
                };
                backgroundAgents.set(id, entry);
                updateWidget();

                // When done, inject result and clean up
                const injectResult = (
                    status: "completed" | "failed",
                    output: string,
                    result: AgentRunResult,
                ) => {
                    const content = `[Background subagent result — this is NOT a user message. A fire-and-forget background agent "${id}" has ${status}. Acknowledge briefly or act on the result only if relevant to the current task.]

${output}`;
                    pi.sendMessage<SubagentDetails>(
                        {
                            customType: BACKGROUND_RESULT_TYPE,
                            content,
                            display: true,
                            details: { result, description: params.description },
                        },
                        { deliverAs: "followUp", triggerTurn: true },
                    );
                };

                promise
                    .then((result) => {
                        // delete returns false if already removed (e.g. by cancel)
                        if (!backgroundAgents.delete(id)) return;
                        updateWidget();
                        if (!sessionActive) return;

                        const isError = isSubagentError(result);
                        const output = isError
                            ? result.errorMessage ||
                              result.stderr ||
                              getFinalOutput(result.messages) ||
                              "(no output)"
                            : getFinalOutput(result.messages) || "(no output)";
                        injectResult(
                            isError ? "failed" : "completed",
                            output,
                            result,
                        );
                    })
                    .catch((err: unknown) => {
                        backgroundAgents.delete(id);
                        updateWidget();
                        // If it was an intentional abort (cancel/shutdown), do nothing.
                        if (!sessionActive || controller.signal.aborted) return;

                        // Pre-spawn or unexpected failure — notify the LLM.
                        const errMsg =
                            err instanceof Error ? err.message : "unknown error";
                        injectResult("failed", `Failed to start: ${errMsg}`, {
                            agent: params.agent,
                            agentSource: resolvedAgent.source,
                            task: params.task,
                            exitCode: 1,
                            messages: [],
                            stderr: errMsg,
                            usage: ZERO_USAGE,
                        });
                    });

                return {
                    content: [
                        {
                            type: "text",
                            text: `Background agent started: ${id}`,
                        },
                    ],
                    details: makeDetails({
                        agent: params.agent,
                        agentSource: agent.source,
                        task: params.task,
                        exitCode: -1,
                        messages: [],
                        stderr: "",
                        usage: ZERO_USAGE,
                    }),
                };
            }

            // ── Foreground mode (default) ────────────────────────────
            const result = await runSubagent(
                resolvedAgent,
                params.task,
                params.cwd ?? ctx.cwd,
                signal,
                onProgress,
                session,
                ctx,
            );

            const isError = isSubagentError(result);

            if (isError) {
                const errorMsg =
                    result.errorMessage ||
                    result.stderr ||
                    getFinalOutput(result.messages) ||
                    "(no output)";
                return {
                    content: [
                        {
                            type: "text",
                            text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
                        },
                    ],
                    details: makeDetails(result),
                    isError: true,
                };
            }

            return {
                content: [
                    {
                        type: "text",
                        text: getFinalOutput(result.messages) || "(no output)",
                    },
                ],
                details: makeDetails(result),
            };
        },

        renderCall(args, theme, _context) {
            const agentName = args.agent || "...";
            const desc = args.description || "...";
            const bgIndicator = args.background ? theme.fg("muted", " (bg)") : "";
            const text =
                theme.fg("toolTitle", theme.bold("subagent ")) +
                theme.fg("text", agentName) +
                bgIndicator +
                theme.fg("dim", ` ${desc}`);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme, _context) {
            const details = result.details as SubagentDetails | undefined;
            if (!details || details.result.exitCode === -1) {
                const text = result.content[0];
                return new Text(
                    text?.type === "text"
                        ? theme.fg("dim", text.text)
                        : "(no output)",
                    0,
                    0,
                );
            }
            return renderSubagentResult(details, expanded, theme);
        },
    });
}
