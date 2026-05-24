/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Single mode only: { agent: "name", task: "..." }
 *
 * The tool does NOT declare executionMode: "sequential", so the
 * agent loop can invoke multiple subagent calls in one batch and
 * they will execute concurrently via Promise.all.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

import {
    type ExtensionAPI,
    getMarkdownTheme,
    type ThemeColor,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";

const ICON_RUNNING = "○";
const ICON_SUCCESS = "●";
const ICON_ERROR = "●";
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
            return theme.fg("success", ICON_SUCCESS);
        case "error":
            return theme.fg("error", ICON_ERROR);
        case "pending":
            return theme.fg("warning", ICON_RUNNING);
    }
}

const SUBAGENT_PREAMBLE = `You are now running as a subagent. All the \`user\` messages are sent by the main agent. The main agent cannot see your context, it can only see your last message when you finish the task. You must treat the parent agent as your caller. Do not directly ask the end user questions. If something is unclear, explain the ambiguity in your final summary to the parent agent.

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

function formatUsageStats(
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        contextTokens?: number;
        turns?: number;
    },
    model?: string,
    durationMs?: number,
): string {
    const parts: string[] = [];
    if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
    if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
    if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
    if (usage.contextTokens && usage.contextTokens > 0) {
        parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
    }
    if (durationMs !== undefined) parts.push(formatDuration(durationMs));
    if (model) parts.push(model);
    return parts.join(" ");
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
            return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;
            let text = themeFg("accent", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                text += themeFg(
                    "warning",
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
            let text = themeFg("muted", "write ") + themeFg("accent", filePath);
            if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
            return text;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return (
                themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
            );
        }
        case "ls": {
            const rawPath = (args.path || ".") as string;
            return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
        }
        case "find": {
            const pattern = (args.pattern || "*") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "find ") +
                themeFg("accent", pattern) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        case "grep": {
            const pattern = (args.pattern || "") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "grep ") +
                themeFg("accent", `/${pattern}/`) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview =
                argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
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
            return `$ ${preview}`;
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
    cost: number;
    contextTokens: number;
    turns: number;
}

interface AgentRunResult {
    agent: string;
    agentSource: "user" | "system" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    durationMs?: number;
}

interface SubagentDetails {
    result: AgentRunResult;
    execStatuses?: Record<string, boolean>;
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

async function writePromptToTempFile(
    agentName: string,
    prompt: string,
): Promise<{ dir: string; filePath: string }> {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
    const safeName = agentName.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
    await withFileMutationQueue(filePath, async () => {
        await fs.promises.writeFile(filePath, prompt, {
            encoding: "utf-8",
            mode: 0o600,
        });
    });
    return { dir: tmpDir, filePath };
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

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSubagent(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    modelOverride: string | undefined,
    fallbackModel: string | undefined,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: (result: AgentRunResult) => SubagentDetails,
    execStatusMap: Map<string, boolean>,
): Promise<AgentRunResult> {
    const agent = agents.find((a) => a.name === agentName);

    if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return {
            agent: agentName,
            agentSource: "unknown",
            task,
            exitCode: 1,
            messages: [],
            stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
            },
        };
    }

    const args: string[] = [
        "--mode",
        "json",
        "--no-extensions",
        "--no-skills",
        "--no-session",
        "--no-context-files",
        "--offline",
        "--print",
    ];
    const modelArg = (modelOverride || undefined) ?? agent.model ?? fallbackModel;
    if (modelArg) args.push("--model", modelArg);
    // Disable thinking unless the model name includes a thinking level
    // (e.g., "anthropic/claude-sonnet:high")
    const hasThinkingLevel = modelArg && /:[a-z]+$/.test(modelArg);
    if (!hasThinkingLevel) args.push("--thinking", "off");
    if (agent.tools && agent.tools.length > 0)
        args.push("--tools", agent.tools.join(","));

    let tmpPromptDir: string | null = null;
    let tmpPromptPath: string | null = null;

    const currentResult: AgentRunResult = {
        agent: agentName,
        agentSource: agent.source,
        task,
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
        },
        model: modelArg,
    };

    const emitUpdate = () => {
        if (!onUpdate) return;

        const items = getDisplayItems(currentResult.messages, execStatusMap);
        const toolCalls = items.filter((i) => i.type === "toolCall");
        const lastToolCall =
            toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : null;

        const lastToolLine = lastToolCall
            ? `${toolStatusIconPlain(lastToolCall.status)} ${formatToolCallPlain(lastToolCall.name, lastToolCall.args)}`
            : "(running...)";

        const usageStr = formatUsageStats(currentResult.usage, currentResult.model);
        const statusLine = usageStr ? `${ICON_RUNNING} ${usageStr}` : ICON_RUNNING;

        onUpdate({
            content: [
                {
                    type: "text",
                    text: `${lastToolLine}\n${statusLine}`,
                },
            ],
            details: makeDetails(currentResult),
        });
    };

    const startTime = Date.now();

    try {
        const fullSystemPrompt = agent.systemPrompt.trim()
            ? `${SUBAGENT_PREAMBLE}${agent.systemPrompt}`
            : SUBAGENT_PREAMBLE.trim();
        const tmp = await writePromptToTempFile(agent.name, fullSystemPrompt);
        tmpPromptDir = tmp.dir;
        tmpPromptPath = tmp.filePath;
        args.push("--system-prompt", tmpPromptPath);

        args.push(`Task: ${task}`);
        let wasAborted = false;

        const exitCode = await new Promise<number>((resolve) => {
            const invocation = getPiInvocation(args);
            const proc = spawn(invocation.command, invocation.args, {
                cwd: cwd ?? defaultCwd,
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
                        const usage = msg.usage;
                        if (usage) {
                            currentResult.usage.input += usage.input || 0;
                            currentResult.usage.output += usage.output || 0;
                            currentResult.usage.cacheRead += usage.cacheRead || 0;
                            currentResult.usage.cacheWrite += usage.cacheWrite || 0;
                            currentResult.usage.cost += usage.cost?.total || 0;
                            currentResult.usage.contextTokens =
                                usage.totalTokens || 0;
                        }
                        if (!currentResult.model && msg.model)
                            currentResult.model = msg.model;
                        if (msg.stopReason)
                            currentResult.stopReason = msg.stopReason;
                        if (msg.errorMessage)
                            currentResult.errorMessage = msg.errorMessage;
                    }
                    emitUpdate();
                }

                if (event.type === "tool_execution_start" && event.toolCallId) {
                    emitUpdate();
                }

                if (event.type === "tool_execution_end" && event.toolCallId) {
                    execStatusMap.set(event.toolCallId, !!event.isError);
                    emitUpdate();
                }

                if (event.type === "tool_result_end" && event.message) {
                    currentResult.messages.push(event.message as Message);
                    emitUpdate();
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
                const killProc = () => {
                    wasAborted = true;
                    proc.kill("SIGTERM");
                    setTimeout(() => {
                        if (!proc.killed) proc.kill("SIGKILL");
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
        if (tmpPromptDir)
            try {
                fs.rmdirSync(tmpPromptDir);
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
                'Override the model for this invocation (e.g. "anthropic/claude-sonnet:high")',
        }),
    ),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory for the agent process",
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
- Use \`model\` to override the agent's default model (e.g. for a harder task that needs a stronger model).
- Use \`cwd\` to override the working directory when the task targets a different project root.

**Scout Agent -- Preferred for Codebase Research**

When you need to understand the codebase before making changes, fixing bugs, or planning features,
prefer the \`scout\` agent over doing the search yourself. It is optimized for fast, read-only
codebase investigation. Use it when:

- Your task will clearly require more than 3 search queries
- You need to understand how a module, feature, or code path works
- You want to investigate multiple independent questions -- launch multiple scout agents concurrently

When calling scout, specify the desired thoroughness in the task:

- "quick": targeted lookups -- find a specific file, function, or config value
- "medium": understand a module -- how does auth work, what calls this API
- "thorough": cross-cutting analysis -- architecture overview, dependency mapping, multi-module investigation

**When NOT to Use Subagent**

- Reading a known file path
- Searching a small number of known files
- Tasks that can be completed in one or two direct tool calls`;
}

export default function (pi: ExtensionAPI) {
    // Pre-load agents at registration time so the LLM
    // knows which agents are available from the tool description.
    const knownAgents = discoverAgents().agents;

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: buildToolDescription(knownAgents),
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const agents = discoverAgents().agents;

            // Tracks per-tool-call completion from tool_execution_end events.
            // Shared with runSubagent so makeDetails can snapshot it.
            const execStatusMap = new Map<string, boolean>();

            const makeDetails = (result: AgentRunResult): SubagentDetails => ({
                result,
                execStatuses: Object.fromEntries(execStatusMap),
            });

            const parentModel = ctx.model
                ? `${ctx.model.provider}/${ctx.model.id}`
                : undefined;

            const result = await runSubagent(
                ctx.cwd,
                agents,
                params.agent,
                params.task,
                params.cwd,
                params.model,
                parentModel,
                signal,
                onUpdate,
                makeDetails,
                execStatusMap,
            );

            const isError =
                result.exitCode !== 0 ||
                result.stopReason === "error" ||
                result.stopReason === "aborted";

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
            const text =
                theme.fg("toolTitle", theme.bold("subagent ")) +
                theme.fg("text", agentName) +
                theme.fg("dim", ` ${desc}`);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme, _context) {
            const details = result.details as SubagentDetails | undefined;
            if (!details) {
                const text = result.content[0];
                return new Text(
                    text?.type === "text" ? text.text : "(no output)",
                    0,
                    0,
                );
            }

            const r = details.result;
            const mdTheme = getMarkdownTheme();
            const isRunning = r.exitCode === -1;
            const isError =
                !isRunning &&
                (r.exitCode !== 0 ||
                    r.stopReason === "error" ||
                    r.stopReason === "aborted");
            const statusIcon = isRunning
                ? theme.fg("success", ICON_RUNNING)
                : isError
                  ? theme.fg("error", ICON_ERROR)
                  : theme.fg("success", ICON_SUCCESS);
            const execStatusMap = details.execStatuses
                ? new Map(Object.entries(details.execStatuses))
                : undefined;
            const displayItems = getDisplayItems(r.messages, execStatusMap);
            const toolCallItems = displayItems.filter((i) => i.type === "toolCall");
            const finalOutput = getFinalOutput(r.messages);

            if (expanded) {
                const container = new Container();
                container.addChild(
                    new Text(theme.fg("muted", "─── Task ───"), 0, 0),
                );
                container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
                container.addChild(new Spacer(1));
                container.addChild(
                    new Text(theme.fg("muted", "─── Output ───"), 0, 0),
                );
                if (toolCallItems.length === 0 && !finalOutput) {
                    container.addChild(
                        new Text(theme.fg("muted", "(no output)"), 0, 0),
                    );
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
                        container.addChild(
                            new Markdown(finalOutput.trim(), 0, 0, mdTheme),
                        );
                    }
                }
                const usageStr = formatUsageStats(r.usage, r.model, r.durationMs);
                container.addChild(new Spacer(1));
                container.addChild(
                    new Text(`${statusIcon} ${theme.fg("dim", usageStr)}`, 0, 0),
                );
                return container;
            }

            // Collapsed view — last 3 tool calls
            const recentToolCalls = toolCallItems.slice(-3);
            let text = "";
            for (const item of recentToolCalls) {
                if (text) text += "\n";
                const icon = toolStatusIcon(item.status, theme);
                text +=
                    ` ${icon} ` +
                    formatToolCall(item.name, item.args, theme.fg.bind(theme));
            }
            if (isError) {
                const errorMsg = r.errorMessage || r.stopReason || "failed";
                if (text) text += "\n";
                text += `${statusIcon} ${theme.fg("error", errorMsg)}`;
                const usageStr = formatUsageStats(r.usage, r.model, r.durationMs);
                if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
            } else {
                const usageStr = formatUsageStats(r.usage, r.model, r.durationMs);
                if (text) text += "\n";
                text += `${statusIcon} ${theme.fg("dim", usageStr)}`;
            }
            return new Text(text, 0, 0);
        },
    });
}
