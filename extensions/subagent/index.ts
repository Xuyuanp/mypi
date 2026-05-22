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
import { StringEnum } from "@earendil-works/pi-ai";
import {
    type ExtensionAPI,
    getMarkdownTheme,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

const ICON_RUNNING = "○";
const ICON_SUCCESS = "●";
const ICON_ERROR = "●";

const SUBAGENT_PREAMBLE = `You are now running as a subagent. All the \`user\` messages are sent by the main agent. The main agent cannot see your context, it can only see your last message when you finish the task. You must treat the parent agent as your caller. Do not directly ask the end user questions. If something is unclear, explain the ambiguity in your final summary to the parent agent.

`;

function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
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

interface SingleResult {
    agent: string;
    agentSource: "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
}

interface SubagentDetails {
    agentScope: AgentScope;
    projectAgentsDir: string | null;
    result: SingleResult;
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
    | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text")
                    items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall")
                    items.push({
                        type: "toolCall",
                        name: part.name,
                        args: part.arguments,
                    });
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

async function runSingleAgent(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: (result: SingleResult) => SubagentDetails,
): Promise<SingleResult> {
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
    if (agent.model) args.push("--model", agent.model);
    if (agent.tools && agent.tools.length > 0)
        args.push("--tools", agent.tools.join(","));

    let tmpPromptDir: string | null = null;
    let tmpPromptPath: string | null = null;

    const currentResult: SingleResult = {
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
        model: agent.model,
    };

    const emitUpdate = () => {
        if (!onUpdate) return;

        const items = getDisplayItems(currentResult.messages);
        const toolCalls = items.filter((i) => i.type === "toolCall");
        const lastToolCall =
            toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : null;

        const lastToolLine = lastToolCall
            ? formatToolCallPlain(lastToolCall.name, lastToolCall.args)
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

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
    description:
        'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
    default: "user",
});

const SubagentParams = Type.Object({
    agent: Type.String({
        description: "Name of the agent to invoke",
    }),
    task: Type.String({
        description: "Task to delegate to the agent",
    }),
    agentScope: Type.Optional(AgentScopeSchema),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory for the agent process",
        }),
    ),
});

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: [
            "Delegate tasks to specialized subagents with isolated context.",
            'Default agent scope is "user" (from ~/.pi/agent/agents).',
            'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
        ].join(" "),
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const agentScope: AgentScope = params.agentScope ?? "user";
            const discovery = discoverAgents(ctx.cwd, agentScope);
            const agents = discovery.agents;

            const makeDetails = (result: SingleResult): SubagentDetails => ({
                agentScope,
                projectAgentsDir: discovery.projectAgentsDir,
                result,
            });

            if ((agentScope === "project" || agentScope === "both") && ctx.hasUI) {
                const agent = agents.find((a) => a.name === params.agent);
                if (agent?.source === "project") {
                    const dir = discovery.projectAgentsDir ?? "(unknown)";
                    const ok = await ctx.ui.confirm(
                        "Run project-local agent?",
                        `Agent: ${agent.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
                    );
                    if (!ok)
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Canceled: project-local agent not approved.",
                                },
                            ],
                            details: makeDetails({
                                agent: params.agent,
                                agentSource: "project",
                                task: params.task,
                                exitCode: 1,
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
                            }),
                        };
                }
            }

            const result = await runSingleAgent(
                ctx.cwd,
                agents,
                params.agent,
                params.task,
                params.cwd,
                signal,
                onUpdate,
                makeDetails,
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
            const scope: AgentScope = args.agentScope ?? "user";
            const agentName = args.agent || "...";
            const taskPreview = args.task
                ? args.task.length > 60
                    ? `${args.task.slice(0, 60)}...`
                    : args.task
                : "...";
            const text =
                theme.fg("toolTitle", theme.bold("subagent ")) +
                theme.fg("accent", agentName) +
                theme.fg("muted", ` [${scope}] `) +
                theme.fg("dim", taskPreview);
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
            const displayItems = getDisplayItems(r.messages);
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
                        container.addChild(
                            new Text(
                                theme.fg("muted", "  → ") +
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
                const usageStr = formatUsageStats(r.usage, r.model);
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
                text +=
                    theme.fg("muted", "  → ") +
                    formatToolCall(item.name, item.args, theme.fg.bind(theme));
            }
            if (isError) {
                const errorMsg = r.errorMessage || r.stopReason || "failed";
                if (text) text += "\n";
                text += `${statusIcon} ${theme.fg("error", errorMsg)}`;
                const usageStr = formatUsageStats(r.usage, r.model);
                if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
            } else {
                const usageStr = formatUsageStats(r.usage, r.model);
                if (text) text += "\n";
                text += `${statusIcon} ${theme.fg("dim", usageStr)}`;
            }
            return new Text(text, 0, 0);
        },
    });
}
