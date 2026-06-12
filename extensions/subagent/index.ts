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
    type Skill,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";
import type { BackgroundManager } from "./background.js";
import { BACKGROUND_RESULT_TYPE, createBackgroundManager } from "./background.js";
import { registerSubagentCommand } from "./command.js";
import { getFinalOutput, renderSubagentResult } from "./render.js";
import { lookupSubagentSession } from "./resume.js";
import type {
    AgentOutcome,
    AgentRunResult,
    BackgroundAgent,
    BackgroundSubagentDetails,
    ForegroundSubagentDetails,
    SubagentDetails,
    SubagentProgressCallback,
    UsageStats,
} from "./types.js";
import { createZeroUsage, isSubagentError, ZERO_USAGE } from "./types.js";

// ── Re-exports for backward compatibility ────────────────────────────
export type { BackgroundAgent } from "./types.js";
export { createZeroUsage } from "./types.js";

// ── Local constants & helpers ────────────────────────────────────────

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

function getPiInvocation(args: string[]): {
    command: string;
    args: string[];
} {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return {
            command: process.execPath,
            args: [currentScript, ...args],
        };
    }

    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: process.execPath, args };
    }

    return { command: "pi", args };
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

// ── Backward compatibility shims ─────────────────────────────────────

/**
 * Normalize an AgentOutcome from a possibly old-format result.
 *
 * Old format stored exitCode/stopReason/errorMessage as top-level fields.
 * New format uses a single `outcome` discriminated union.
 */
function normalizeOutcome(r: Record<string, unknown>): AgentOutcome {
    // New format: already has outcome
    if (r.outcome && typeof r.outcome === "object") {
        return r.outcome as AgentOutcome;
    }
    // Old format: reconstruct from legacy fields via buildOutcome.
    // Special case: exitCode -1 was the old "running" sentinel.
    const exitCode = (r.exitCode as number | undefined) ?? 0;
    if (exitCode === -1) return { status: "running" };
    return buildOutcome(
        exitCode,
        false, // wasAborted cannot be inferred from serialized data
        r.stopReason as string | undefined,
        r.errorMessage as string | undefined,
        "", // stderr not stored in old details
    );
}

/**
 * Normalize UsageStats from a possibly old-format shape.
 *
 * Old format: { input, output, cacheRead, cacheWrite, totalTokens, ... }
 * New format: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ... }
 */
function normalizeUsage(raw: Record<string, unknown>): UsageStats {
    // New format detection: has `inputTokens`
    if ("inputTokens" in raw) return raw as unknown as UsageStats;
    // Old format: map field names
    return {
        inputTokens: (raw.input as number) || 0,
        outputTokens: (raw.output as number) || 0,
        cacheReadTokens: (raw.cacheRead as number) || 0,
        cacheWriteTokens: (raw.cacheWrite as number) || 0,
        contextTokens: (raw.contextTokens as number) || 0,
        cost: (raw.cost as UsageStats["cost"]) || {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
        turns: (raw.turns as number) || 0,
    };
}

/**
 * Normalize SubagentDetails from a possibly old-format shape.
 *
 * Old format: { result: { exitCode, ... }, background?, description?, cancelled?, execStatuses? }
 * New format: { kind: "foreground"|"background", result: { outcome, ... }, ... }
 */
function normalizeDetails(raw: unknown): SubagentDetails | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const d = raw as Record<string, unknown>;
    // New-format detection: has `kind` field
    if (d.kind === "foreground" || d.kind === "background") {
        return raw as SubagentDetails;
    }
    // Old-format: map to new shape
    const rawResult = d.result as Record<string, unknown> | undefined;
    if (!rawResult) return undefined;
    const outcome = normalizeOutcome(rawResult);
    const usage = rawResult.usage
        ? normalizeUsage(rawResult.usage as Record<string, unknown>)
        : createZeroUsage();
    const newResult: AgentRunResult = {
        agent: (rawResult.agent as string) || "",
        agentSource:
            (rawResult.agentSource as AgentRunResult["agentSource"]) || "unknown",
        task: (rawResult.task as string) || "",
        outcome,
        messages: (rawResult.messages as Message[]) || [],
        stderr: (rawResult.stderr as string) || "",
        usage,
        model: rawResult.model as string | undefined,
        contextWindow: rawResult.contextWindow as number | undefined,
        durationMs: rawResult.durationMs as number | undefined,
    };
    if (d.background || d.description != null || d.cancelled != null) {
        return {
            kind: "background",
            result: newResult,
            description: (d.description as string) || "(unknown)",
            cancelled: (d.cancelled as boolean) || false,
        };
    }
    return {
        kind: "foreground",
        result: newResult,
        execStatuses: (d.execStatuses as Record<string, boolean>) || {},
    };
}

// ── Subprocess execution ─────────────────────────────────────────────

async function runSubagent(
    agent: AgentConfig,
    task: string,
    cwd: string,
    signal: AbortSignal | undefined,
    onProgress: SubagentProgressCallback | undefined,
    session: { dir: string; id: string } | undefined,
    ctx: ExtensionContext,
    resume?: boolean,
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
        args.push("--session", path.join(session.dir, `${session.id}.jsonl`));
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
        outcome: { status: "running" },
        messages: [],
        stderr: "",
        usage: createZeroUsage(),
        model: modelArg,
        contextWindow,
    };

    const startTime = Date.now();

    // Local variables for streaming state — NOT stored on outcome
    // during streaming. Merged into the single outcome assignment
    // at completion.
    let latestStopReason: string | undefined;
    let latestErrorMessage: string | undefined;

    try {
        const fullSystemPrompt = agent.systemPrompt.trim()
            ? `${SUBAGENT_PREAMBLE}\n${agent.systemPrompt}`
            : SUBAGENT_PREAMBLE.trim();
        tmpPromptPath = await writePromptToTempFile(agent.name, fullSystemPrompt);
        args.push("--append-system-prompt", tmpPromptPath);

        args.push(resume ? task : `Task: ${task}`);
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
                        if (msg.stopReason) latestStopReason = msg.stopReason;
                        if (msg.errorMessage) latestErrorMessage = msg.errorMessage;
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
                    onProgress?.(currentResult, {
                        type: "tool_result",
                    });
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
                else
                    signal.addEventListener("abort", killProc, {
                        once: true,
                    });
            }
        });

        currentResult.durationMs = Date.now() - startTime;
        currentResult.outcome = buildOutcome(
            exitCode,
            wasAborted,
            latestStopReason,
            latestErrorMessage,
            currentResult.stderr,
        );
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

// ── Tool schema & description ────────────────────────────────────────

// ── Subagent tool params & types ─────────────────────────────────────

interface SubagentToolParams {
    agent: string;
    description: string;
    task: string;
    model?: string;
    cwd?: string;
    skills?: string[];
    background?: boolean;
}

interface ToolResult {
    content: { type: "text"; text: string }[];
    details: ForegroundSubagentDetails | BackgroundSubagentDetails;
    isError?: boolean;
}

const SubagentParams = Type.Object({
    agent: Type.String({
        description:
            "Name of an available agent. Must match a <name> from the agent list.",
    }),
    description: Type.String({
        description: "A short (3-5 word) summary of the delegated task.",
    }),
    task: Type.String({
        description:
            "Self-contained task description. The subagent has NO access to your conversation history -- include all necessary context, file paths, constraints, and expected output format. Be explicit about whether to write code or only research.",
    }),
    model: Type.Optional(
        Type.String({
            description: 'Model override, e.g. "anthropic/claude-sonnet:high".',
        }),
    ),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory override for the subprocess.",
        }),
    ),
    skills: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "Skill names to attach. Replaces the agent's default skills.",
        }),
    ),
    background: Type.Optional(
        Type.Boolean({
            description: "Run as a fire-and-forget background task.",
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

    return `Spawn an agent to work on a focused task in an isolated context with its own tool set.

The result is only visible to you. If the user should see it, summarize it yourself.

<available_agents>
${agentList}
</available_agents>

**Writing the \`task\`**
- The agent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt. The agent should not have to search for things you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.

**Usage of Optional Parameters**

- \`model\`: Set only when the user explicitly requests a specific model; otherwise omit to use the agent default.
- \`cwd\`: Set when the task targets a different project root than the current working directory.
- \`skills\`: Attach specialized skills by name. Use when the task requires domain knowledge not built into the agent.
- \`background\`: Set to true for fire-and-forget work whose result you do not need to continue your current turn. Multiple foreground agents already run in parallel within a single turn -- prefer foreground unless you truly do not need the result.

**When NOT to Use**

- Reading a known file path
- Searching a small number of known files
- Tasks that can be completed in one or two direct tool calls

Each completed subagent can be resumed via subagent_resume using the subagent ID shown in the result.`;
}

// ── Execute helpers ──────────────────────────────────────────────────

/** Extract a human-readable error/output string from a completed agent result. */
function getResultOutput(result: AgentRunResult): string {
    if (result.outcome.status === "error") {
        return (
            result.outcome.message ||
            result.stderr ||
            getFinalOutput(result.messages) ||
            "(no output)"
        );
    }
    if (result.outcome.status === "aborted") {
        return (
            result.outcome.message ||
            result.stderr ||
            getFinalOutput(result.messages) ||
            "(aborted)"
        );
    }
    return getFinalOutput(result.messages) || "(no output)";
}

/**
 * Resolve skill names to absolute file paths via the skill cache.
 * Returns resolved paths, or an error message if any skill is unknown.
 */
function resolveSkills(
    skillNames: string[] | undefined,
    skillCache: Map<string, Skill>,
):
    | { paths: string[] | undefined; error?: never }
    | { error: string; paths?: never } {
    if (!skillNames?.length) return { paths: undefined };
    const unresolved = skillNames.filter((name) => !skillCache.has(name));
    if (unresolved.length) {
        const available =
            skillCache.size > 0
                ? [...skillCache.keys()].map((n) => `"${n}"`).join(", ")
                : "none (skill cache empty)";
        const msg = `Unknown skill${unresolved.length > 1 ? "s" : ""}: ${unresolved.map((n) => `"${n}"`).join(", ")}. Available: ${available}.`;
        return { error: msg };
    }
    return { paths: skillNames.map((name) => skillCache.get(name)!.filePath) };
}

type ResolveResult =
    | { error: ToolResult; agent?: never; session?: never }
    | {
          error?: never;
          agent: AgentConfig;
          session: { dir: string; id: string } | undefined;
      };

/**
 * Validate params and resolve the final AgentConfig + session path.
 * Returns either a ready-to-use config or an early-error tool result.
 */
function resolveAgentConfig(
    params: SubagentToolParams,
    agents: AgentConfig[],
    skillCache: Map<string, Skill>,
    ctx: ExtensionContext,
): ResolveResult {
    const makeErrorResult = (
        msg: string,
        agentSource: AgentRunResult["agentSource"],
    ): ToolResult => ({
        content: [{ type: "text", text: msg }],
        details: {
            kind: "foreground",
            result: {
                agent: params.agent,
                agentSource,
                task: params.task,
                outcome: { status: "error", exitCode: 1, message: msg },
                messages: [],
                stderr: msg,
                usage: ZERO_USAGE,
            },
            execStatuses: {},
        },
        isError: true,
    });

    const agent = agents.find((a) => a.name === params.agent);
    if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        const msg = `Unknown agent: "${params.agent}". Available agents: ${available}.`;
        return { error: makeErrorResult(msg, "unknown") };
    }

    const skillNames = params.skills !== undefined ? params.skills : agent.skills;
    const skillResult = resolveSkills(skillNames, skillCache);
    if (skillResult.error) {
        return { error: makeErrorResult(skillResult.error, agent.source) };
    }

    const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;

    const resolvedAgent: AgentConfig = {
        ...agent,
        model: (params.model || undefined) ?? agent.model ?? parentModel,
        skills: skillResult.paths,
    };

    // Persist subagent session alongside the parent session.
    // Layout: <parent-session-without-ext>/subagent/<name>-<uuid8>.jsonl
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

    return { agent: resolvedAgent, session };
}

/** Execute a subagent in background (fire-and-forget) mode. */
function executeBackground(
    resolvedAgent: AgentConfig,
    params: SubagentToolParams,
    session: { dir: string; id: string } | undefined,
    bgManager: BackgroundManager,
    ctx: ExtensionContext,
): ToolResult {
    const id =
        session?.id ??
        `${sanitizeAgentName(resolvedAgent.name)}-${randomUUID().slice(0, 8)}`;

    const controller = new AbortController();

    let entry: BackgroundAgent | undefined;

    const bgOnProgress: SubagentProgressCallback = (result, event) => {
        if (!entry) return;
        entry.latestResult = result;
        if (event.type === "tool_start") {
            entry.toolCallCount++;
        }
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
            outcome: { status: "running" },
            messages: [],
            stderr: "",
            usage: createZeroUsage(),
            model: resolvedAgent.model,
            contextWindow: resolveContextWindow(resolvedAgent.model, ctx),
        },
    };
    bgManager.register(entry);

    // When done, inject result and clean up
    promise
        .then((result) => {
            const wasCancelled = controller.signal.aborted;
            bgManager.remove(id);
            if (!bgManager.sessionActive) return;

            if (wasCancelled) {
                bgManager.injectResult(
                    id,
                    "cancelled",
                    "(cancelled by user)",
                    result,
                    { description: params.description, cancelled: true, session },
                );
                return;
            }

            bgManager.injectResult(
                id,
                isSubagentError(result) ? "failed" : "completed",
                getResultOutput(result),
                result,
                { description: params.description, cancelled: false, session },
            );
        })
        .catch((err: unknown) => {
            const wasCancelled = controller.signal.aborted;
            bgManager.remove(id);
            if (!bgManager.sessionActive) return;

            if (wasCancelled) {
                bgManager.injectResult(
                    id,
                    "cancelled",
                    "(cancelled by user)",
                    entry!.latestResult,
                    { description: params.description, cancelled: true, session },
                );
                return;
            }

            // Pre-spawn or unexpected failure — notify the LLM.
            const errMsg = err instanceof Error ? err.message : "unknown error";
            bgManager.injectResult(
                id,
                "failed",
                `Failed to start: ${errMsg}`,
                {
                    agent: params.agent,
                    agentSource: resolvedAgent.source,
                    task: params.task,
                    outcome: {
                        status: "error",
                        exitCode: 1,
                        message: errMsg,
                    },
                    messages: [],
                    stderr: errMsg,
                    usage: ZERO_USAGE,
                },
                { description: params.description, cancelled: false, session },
            );
        });

    return {
        content: [
            {
                type: "text",
                text: `Background agent started: ${id}`,
            },
        ],
        details: {
            kind: "background",
            result: entry.latestResult,
            description: params.description,
            cancelled: false,
            session,
        },
    };
}

/** Execute a subagent in foreground (blocking) mode. */
async function executeForeground(
    resolvedAgent: AgentConfig,
    params: SubagentToolParams,
    session: { dir: string; id: string } | undefined,
    signal: AbortSignal | undefined,
    onUpdate:
        | ((update: {
              content: { type: "text"; text: string }[];
              details: ForegroundSubagentDetails;
          }) => void)
        | undefined,
    ctx: ExtensionContext,
): Promise<ToolResult> {
    const execStatusMap = new Map<string, boolean>();

    const makeDetails = (result: AgentRunResult): ForegroundSubagentDetails => ({
        kind: "foreground",
        result,
        execStatuses: Object.fromEntries(execStatusMap),
        session,
    });

    const onProgress: SubagentProgressCallback | undefined = onUpdate
        ? (result, event) => {
              if (event.type === "tool_end") {
                  execStatusMap.set(event.toolCallId, event.isError);
              }
              // Only push updates on events that change rendered state
              if (event.type === "tool_end" || event.type === "message") {
                  onUpdate({
                      content: [{ type: "text", text: "" }],
                      details: makeDetails(result),
                  });
              }
          }
        : undefined;

    const result = await runSubagent(
        resolvedAgent,
        params.task,
        params.cwd ?? ctx.cwd,
        signal,
        onProgress,
        session,
        ctx,
    );

    const sessionHeader = session ? `[subagent: ${session.id}]\n\n` : "";

    if (isSubagentError(result)) {
        return {
            content: [
                {
                    type: "text",
                    text: `${sessionHeader}Agent failed: ${getResultOutput(result)}`,
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
                text: `${sessionHeader}${getFinalOutput(result.messages) || "(no output)"}`,
            },
        ],
        details: makeDetails(result),
    };
}

// ── Extension entry point ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    // Pre-load agents at registration time so the LLM
    // knows which agents are available from the tool description.
    const knownAgents = discoverAgents().agents;

    // Background agent lifecycle manager
    const bgManager = createBackgroundManager(pi);

    registerSubagentCommand(pi, bgManager);

    // Cache loaded skills from the parent session so we can resolve
    // skill names to filesystem paths for --skill flags.
    let skillCache = new Map<string, Skill>();

    pi.on("session_start", (_event, ctx) => {
        bgManager.setSessionActive(true);
        bgManager.setContext(ctx);
    });

    pi.on("session_shutdown", async () => {
        await bgManager.shutdown();
    });

    pi.on("before_agent_start", (event) => {
        const skills = event.systemPromptOptions.skills;
        skillCache = skills ? new Map(skills.map((s) => [s.name, s])) : new Map();
    });

    // Register custom message renderer for background agent results
    pi.registerMessageRenderer<SubagentDetails>(
        BACKGROUND_RESULT_TYPE,
        (message, { expanded }, theme) => {
            // Normalize details from possibly old session format
            const details = normalizeDetails(message.details);
            const bgDetails = details?.kind === "background" ? details : undefined;
            if (!bgDetails) {
                const contentText =
                    typeof message.content === "string"
                        ? message.content
                        : message.content
                              .map((p) => (p.type === "text" ? p.text : ""))
                              .join("");
                return new Text(contentText || "(no output)", 0, 0);
            }
            return renderSubagentResult(bgDetails, expanded, theme);
        },
    );

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: buildToolDescription(knownAgents),
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const resolved = resolveAgentConfig(
                params,
                discoverAgents().agents,
                skillCache,
                ctx,
            );
            if (resolved.error) return resolved.error;

            const { agent: resolvedAgent, session } = resolved;

            if (params.background) {
                return executeBackground(
                    resolvedAgent,
                    params,
                    session,
                    bgManager,
                    ctx,
                );
            }

            return executeForeground(
                resolvedAgent,
                params,
                session,
                signal,
                onUpdate,
                ctx,
            );
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
            // Normalize details from possibly old session format
            const details = normalizeDetails(result.details);
            if (!details) {
                const text = result.content[0];
                return new Text(
                    text?.type === "text"
                        ? theme.fg("dim", text.text)
                        : "(no output)",
                    0,
                    0,
                );
            }
            // Background tool result ("started") — renderCall
            // already provides the header, just show model + task.
            if (details.kind === "background") {
                const r = details.result;
                const modelLine = r.model ? theme.fg("muted", r.model) : "";
                const contentText = result.content[0];
                const msg =
                    contentText?.type === "text" ? contentText.text : "(started)";
                const parts = [theme.fg("dim", msg), modelLine]
                    .filter(Boolean)
                    .join(" ");
                if (expanded && r.task) {
                    const container = new Container();
                    container.addChild(new Text(parts, 0, 0));
                    container.addChild(new Spacer(1));
                    container.addChild(
                        new Text(
                            theme.fg(
                                "muted",
                                "\u2500\u2500\u2500 Task \u2500\u2500\u2500",
                            ),
                            0,
                            0,
                        ),
                    );
                    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
                    return container;
                }
                return new Text(parts, 0, 0);
            }
            // Foreground result — no header (renderCall provides it)
            return renderSubagentResult(details, expanded, theme);
        },
    });

    // ── subagent_resume tool ──────────────────────────────────────────

    const ResumeParams = Type.Object({
        id: Type.String({
            description: "Session ID of the completed subagent to resume.",
        }),
        follow_up: Type.String({
            description:
                "New message to send to the subagent, continuing its conversation.",
        }),
    });

    type ResumeToolParams = { id: string; follow_up: string };

    pi.registerTool({
        name: "subagent_resume",
        label: "Subagent Resume",
        description:
            "Resume a completed subagent session with a follow-up message. " +
            "Use when the follow-up depends on the subagent's prior context " +
            "(files it read, conclusions it reached, changes it made). " +
            "The subagent reloads its full conversation history and continues from where it left off. " +
            "Always executes in foreground (blocking).",
        parameters: ResumeParams,

        async execute(_toolCallId, params: ResumeToolParams, signal, onUpdate, ctx) {
            const { id, follow_up } = params;

            const errorResult = (text: string) => ({
                content: [{ type: "text" as const, text }],
                details: undefined,
                isError: true,
            });

            if (bgManager.agents.has(id)) {
                return errorResult(
                    `Agent "${id}" is still running. Wait for it to complete or cancel it first.`,
                );
            }

            // Lookup session in message history
            const entries = ctx.sessionManager.getEntries() as any[];
            const lookup = lookupSubagentSession(entries, id);

            if (!lookup.found) {
                if (lookup.error === "no_session_info") {
                    return errorResult(
                        `Session "${id}" predates resume support (no session info stored).`,
                    );
                }
                const available =
                    lookup.availableIds.length > 0
                        ? lookup.availableIds.map((i) => `"${i}"`).join(", ")
                        : "none";
                return errorResult(
                    `No subagent found with id "${id}". Available sessions: ${available}.`,
                );
            }

            const { details: matchedDetails, session } = lookup;

            const sessionFile = path.join(session.dir, `${session.id}.jsonl`);
            if (!fs.existsSync(sessionFile)) {
                return errorResult(`Session file not found on disk: ${sessionFile}`);
            }

            const agentName = matchedDetails.result.agent;
            const agent = knownAgents.find((a) => a.name === agentName);
            if (!agent) {
                return errorResult(`Agent "${agentName}" is no longer available.`);
            }

            // Resolve skills and model for the resumed agent
            const skillResult = resolveSkills(agent.skills, skillCache);
            if (skillResult.error) {
                return errorResult(skillResult.error);
            }

            const parentModel = ctx.model
                ? `${ctx.model.provider}/${ctx.model.id}`
                : undefined;
            const resolvedAgent: AgentConfig = {
                ...agent,
                skills: skillResult.paths,
                model: matchedDetails.result.model ?? agent.model ?? parentModel,
            };

            // Execute resumed subagent
            const execStatusMap = new Map<string, boolean>();

            const makeDetails = (
                result: AgentRunResult,
            ): ForegroundSubagentDetails => ({
                kind: "foreground",
                result,
                execStatuses: Object.fromEntries(execStatusMap),
                session,
                resumedFrom: id,
            });

            const onProgress: SubagentProgressCallback | undefined = onUpdate
                ? (result, event) => {
                      if (event.type === "tool_end") {
                          execStatusMap.set(event.toolCallId, event.isError);
                      }
                      if (event.type === "tool_end" || event.type === "message") {
                          onUpdate({
                              content: [{ type: "text", text: "" }],
                              details: makeDetails(result),
                          });
                      }
                  }
                : undefined;

            const result = await runSubagent(
                resolvedAgent,
                follow_up,
                ctx.cwd,
                signal,
                onProgress,
                session,
                ctx,
                true, // resume mode: no "Task: " prefix
            );

            const sessionHeader = `[subagent: ${session.id}]\n\n`;

            if (isSubagentError(result)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `${sessionHeader}Agent failed: ${getResultOutput(result)}`,
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
                        text: `${sessionHeader}${getFinalOutput(result.messages) || "(no output)"}`,
                    },
                ],
                details: makeDetails(result),
            };
        },

        renderCall(args, theme, _context) {
            const sessionId = args.id || "...";
            const text =
                theme.fg("toolTitle", theme.bold("subagent_resume ")) +
                theme.fg("text", sessionId) +
                theme.fg("muted", " (resumed)");
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme, _context) {
            const details = normalizeDetails(result.details);
            if (!details || details.kind !== "foreground") {
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
