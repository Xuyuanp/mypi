/**
 * Pure subprocess execution module for the subagent extension.
 *
 * Contains `runSubagent()` and all its helpers. Zero framework
 * dependencies — only Node.js built-ins and the `Message` type.
 * Always resolves (never rejects for abort).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
    AgentOutcome,
    AgentRunResult,
    ResolvedAgent,
    SubagentProgressCallback,
    UsageStats,
} from "./types.js";
import { createZeroUsage } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────

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
    target.inputTokens += source.input || 0;
    target.outputTokens += source.output || 0;
    target.cacheReadTokens += source.cacheRead || 0;
    target.cacheWriteTokens += source.cacheWrite || 0;
    const cost = source.cost;
    if (cost) {
        target.cost.input += cost.input || 0;
        target.cost.output += cost.output || 0;
        target.cost.cacheRead += cost.cacheRead || 0;
        target.cost.cacheWrite += cost.cacheWrite || 0;
        target.cost.total += cost.total || 0;
    }
}

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
 * Determine the command/args to invoke the pi binary.
 *
 * Handles bun virtual scripts, generic runtimes (node/bun where pi is
 * the main script), and direct pi executables. Callers concat their own
 * CLI flags onto the returned `args` array.
 */
export function getPiInvocation(): {
    command: string;
    args: string[];
} {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return {
            command: process.execPath,
            args: [currentScript],
        };
    }

    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: process.execPath, args: [] };
    }

    return { command: "pi", args: [] };
}

// ── buildSubagentCommand ─────────────────────────────────────────────

interface BuildSubagentCommandResult {
    command: string;
    args: string[];
    tmpPromptPath: string;
}

/**
 * Build the agent-identity flags and system prompt temp file for
 * spawning a subagent pi process.
 *
 * Does NOT include mode-specific flags (--mode, --print, --session,
 * task positional). Callers push those onto the returned `args`.
 *
 * The system prompt is always identical regardless of how the subagent
 * is launched (run vs attach) to preserve KV cache prefix alignment.
 */
export async function buildSubagentCommand(
    agent: ResolvedAgent,
): Promise<BuildSubagentCommandResult> {
    const invocation = getPiInvocation();
    const args = [
        ...invocation.args,
        "--no-extensions",
        "--no-context-files",
        "--offline",
    ];

    args.push("--no-skills");
    if (agent.skillPaths?.length) {
        for (const skillPath of agent.skillPaths) {
            args.push("--skill", skillPath);
        }
    }

    const modelArg = agent.model;
    args.push("--model", modelArg);

    // Disable thinking unless the model name includes a thinking level
    const hasThinkingLevel = parseModelStr(modelArg)?.thinkingLevel;
    if (!hasThinkingLevel) args.push("--thinking", "off");

    if (agent.tools && agent.tools.length > 0) {
        args.push("--tools", agent.tools.join(","));
    }

    const fullSystemPrompt = agent.systemPrompt.trim()
        ? `${SUBAGENT_PREAMBLE}\n${agent.systemPrompt}`
        : SUBAGENT_PREAMBLE.trim();

    const tmpPromptPath = await writePromptToTempFile(agent.name, fullSystemPrompt);
    args.push("--append-system-prompt", tmpPromptPath);

    return { command: invocation.command, args, tmpPromptPath };
}

/**
 * Build an AgentOutcome from subprocess exit state.
 *
 * This is the single point where exitCode + stopReason + errorMessage
 * are reconciled into a discriminated union variant.
 */
function buildOutcome(
    exitCode: number,
    wasAborted: boolean,
    latestStopReason: string | undefined,
    latestErrorMessage: string | undefined,
    stderr: string,
): AgentOutcome {
    if (wasAborted) {
        return { status: "aborted" };
    }
    if (exitCode !== 0) {
        return {
            status: "error",
            exitCode,
            stopReason: latestStopReason,
            message:
                latestErrorMessage ||
                stderr ||
                `(subprocess exited with code ${exitCode})`,
        };
    }
    if (latestStopReason === "error") {
        return {
            status: "error",
            exitCode: 0,
            stopReason: "error",
            message: latestErrorMessage || stderr || "(agent error)",
        };
    }
    if (latestStopReason === "aborted") {
        return { status: "aborted", message: latestErrorMessage };
    }
    return { status: "success", stopReason: latestStopReason };
}

// ── RunSubagent options ──────────────────────────────────────────────

interface RunSubagentOptions {
    signal?: AbortSignal;
    onProgress?: SubagentProgressCallback;
    sessionFile?: string;
    resume?: boolean;
}

// ── Main execution function ──────────────────────────────────────────

/**
 * Execute a subagent as an isolated subprocess.
 *
 * Always resolves — never rejects for abort. On abort, returns a
 * result with `outcome: { status: "aborted" }`.
 *
 * The internal accumulator never escapes this function.
 */
export async function runSubagent(
    agent: ResolvedAgent,
    task: string,
    cwd: string,
    options: RunSubagentOptions = {},
): Promise<AgentRunResult> {
    const { signal, onProgress, sessionFile, resume } = options;

    // ── Internal accumulator (never escapes) ─────────────────────────
    const messages: Message[] = [];
    const usage: UsageStats = createZeroUsage();
    let stderr = "";
    let model: string | undefined = agent.model;
    let latestStopReason: string | undefined;
    let latestErrorMessage: string | undefined;
    let turns = 0;

    let tmpPromptPath: string | null = null;
    const startTime = Date.now();

    try {
        const built = await buildSubagentCommand(agent);
        tmpPromptPath = built.tmpPromptPath;

        const fullArgs = [...built.args, "--mode", "json", "--print"];

        if (sessionFile) {
            fullArgs.push("--session", sessionFile);
        } else {
            fullArgs.push("--no-session");
        }

        fullArgs.push(resume ? task : `Task: ${task}`);
        let wasAborted = false;

        const exitCode = await new Promise<number>((resolve) => {
            const proc = spawn(built.command, fullArgs, {
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
                    messages.push(msg);

                    if (msg.role === "assistant") {
                        turns++;
                        if (msg.usage) {
                            accumulateUsage(usage, msg.usage);
                            usage.contextTokens =
                                (msg.usage.input || 0) +
                                (msg.usage.cacheRead || 0) +
                                (msg.usage.cacheWrite || 0);
                        }
                        if (!model && msg.model) {
                            model = msg.model;
                        }
                        if (msg.stopReason) latestStopReason = msg.stopReason;
                        if (msg.errorMessage) latestErrorMessage = msg.errorMessage;
                    }
                    usage.turns = turns;
                    onProgress?.({
                        type: "message",
                        message: msg,
                        usage: { ...usage, cost: { ...usage.cost } },
                        model,
                    });
                }

                if (event.type === "tool_execution_start" && event.toolCallId) {
                    onProgress?.({
                        type: "tool_start",
                        toolCallId: event.toolCallId,
                    });
                }

                if (event.type === "tool_execution_end" && event.toolCallId) {
                    onProgress?.({
                        type: "tool_end",
                        toolCallId: event.toolCallId,
                        isError: !!event.isError,
                    });
                }

                if (event.type === "tool_result_end" && event.message) {
                    const msg = event.message as Message;
                    messages.push(msg);
                    onProgress?.({ type: "tool_result", message: msg });
                }
            };

            proc.stdout.on("data", (data) => {
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) processLine(line);
            });

            proc.stderr.on("data", (data) => {
                stderr += data.toString();
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
                else
                    signal.addEventListener("abort", killProc, {
                        once: true,
                    });
            }
        });

        const durationMs = Date.now() - startTime;
        const outcome = buildOutcome(
            exitCode,
            wasAborted,
            latestStopReason,
            latestErrorMessage,
            stderr,
        );

        return {
            agent: agent.name,
            agentSource: agent.source,
            task,
            outcome,
            messages,
            stderr,
            usage,
            model,
            durationMs,
        };
    } finally {
        if (tmpPromptPath) {
            try {
                fs.unlinkSync(tmpPromptPath);
            } catch {
                /* ignore */
            }
        }
    }
}
