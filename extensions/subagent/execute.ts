/**
 * Execution module for the subagent extension.
 *
 * Contains `runSubagent()` — in-process subagent execution via the pi SDK
 * (`createAgentSession`) — plus the attach-path helpers (`buildSubagentCommand`,
 * `getPiInvocation`) used by `/subagent attach` to launch an interactive pi
 * process in a multiplexer pane.
 *
 * `runSubagent` always resolves (never rejects for abort). On abort it returns
 * a result with `outcome: { status: "aborted" }`.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type {
    AgentSession,
    ModelRuntime,
    ResourceLoader,
    Skill,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
    CURRENT_SESSION_VERSION,
    createAgentSession,
    createBashToolDefinition,
    createExtensionRuntime,
    SessionManager,
    SettingsManager,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type {
    AgentOutcome,
    AgentRunResult,
    ResolvedAgent,
    SubagentProgressCallback,
    UsageStats,
} from "./types.js";
import { createZeroUsage, formatModelString } from "./types.js";

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
 * Used by the `/subagent attach` command (interactive pane resume).
 * Does NOT include mode-specific flags (--mode, --print, --session,
 * task positional). Callers push those onto the returned `args`.
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

    const modelArg = formatModelString(agent.model);
    args.push("--model", modelArg);

    // Disable thinking unless the model name includes a thinking level.
    if (!agent.model.thinkingLevel) args.push("--thinking", "off");

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
 * Build an AgentOutcome from in-process terminal state.
 *
 * In-process there is no exit code; outcome is derived from the abort flag
 * and the latest assistant message's stopReason/errorMessage.
 */
function buildOutcome(
    wasAborted: boolean,
    latestStopReason: string | undefined,
    latestErrorMessage: string | undefined,
): AgentOutcome {
    if (wasAborted) {
        return { status: "aborted" };
    }
    if (latestStopReason === "error") {
        return {
            status: "error",
            exitCode: 1,
            stopReason: "error",
            message: latestErrorMessage || "(agent error)",
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
    /**
     * Lazily-created shared ModelRuntime provider, injected by index.ts.
     * A thunk (not a bare promise) so eager singleton creation never happens
     * in unit tests that mock runSubagent.
     */
    modelRuntime: () => Promise<ModelRuntime>;
    /** Session skill cache (name -> Skill) used to resolve agent skills. */
    skillCache: Map<string, Skill>;
}

// ── Resource loader ──────────────────────────────────────────────────

/**
 * Build a minimal per-run ResourceLoader for the subagent session.
 *
 * Isolated like the old subprocess flags (--no-extensions --no-context-files):
 * no extensions, no prompts/themes, no context files. The agent's system
 * prompt is appended (getAppendSystemPrompt) rather than replacing pi's
 * default prompt (getSystemPrompt -> undefined would become customPrompt and
 * drop the entire default system prompt).
 */
function createSubagentResourceLoader(
    agent: ResolvedAgent,
    skillCache: Map<string, Skill>,
): ResourceLoader {
    const appendedPrompt = agent.systemPrompt.trim()
        ? `${SUBAGENT_PREAMBLE}\n${agent.systemPrompt}`
        : SUBAGENT_PREAMBLE.trim();
    const skills =
        agent.skillPaths && agent.skillPaths.length > 0
            ? [...skillCache.values()].filter((skill) =>
                  agent.skillPaths!.includes(skill.filePath),
              )
            : [];
    return {
        getExtensions: () => ({
            extensions: [],
            errors: [],
            runtime: createExtensionRuntime(),
        }),
        getSkills: () => ({ skills, diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => undefined,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [appendedPrompt],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {},
    };
}

// ── Session manager ──────────────────────────────────────────────────

/**
 * Build the subagent SessionManager for the given session file.
 *
 * SessionManager.open() on a non-existent path leaves fileEntries empty, and
 * the SDK only flushes the file once the first assistant message arrives — a
 * flushed file without a `session` header would break resume and /subagent
 * attach. So for fresh runs we pre-write a valid header (matching the SDK's
 * format, CURRENT_SESSION_VERSION) before opening.
 *
 * Exported for testing: header write failure handling is a regression
 * surface (EEXIST race vs. real I/O failures).
 */
export async function buildSessionManager(
    sessionFile: string | undefined,
    cwd: string,
    resume: boolean | undefined,
): Promise<SessionManager> {
    if (!sessionFile) return SessionManager.inMemory(cwd);

    if (!resume && !fs.existsSync(sessionFile)) {
        const dir = path.dirname(sessionFile);
        const id = path.basename(sessionFile, ".jsonl");
        await fs.promises.mkdir(dir, { recursive: true });
        const header = {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id,
            timestamp: new Date().toISOString(),
            cwd,
            parentSession: undefined,
        };
        try {
            await fs.promises.writeFile(sessionFile, `${JSON.stringify(header)}\n`, {
                encoding: "utf-8",
                mode: 0o600,
                flag: "wx",
            });
        } catch (err) {
            // Only the concurrent-creation race (EEXIST) is benign; any other
            // write failure must surface — a silently header-less file breaks
            // resume and /subagent attach later.
            const code =
                err instanceof Error && "code" in err
                    ? (err as NodeJS.ErrnoException).code
                    : undefined;
            if (code !== "EEXIST") throw err;
        }
    }
    return SessionManager.open(sessionFile, undefined, cwd);
}

// ── Main execution function ──────────────────────────────────────────

/**
 * Execute a subagent as an in-process AgentSession via the pi SDK.
 *
 * Always resolves — never rejects for abort. On abort, returns a result with
 * `outcome: { status: "aborted" }`.
 *
 * The internal accumulator never escapes this function.
 */
export async function runSubagent(
    agent: ResolvedAgent,
    task: string,
    cwd: string,
    options: RunSubagentOptions,
): Promise<AgentRunResult> {
    const { signal, onProgress, sessionFile, resume } = options;

    // ── Internal accumulator (never escapes) ─────────────────────────
    const messages: Message[] = [];
    const usage: UsageStats = createZeroUsage();
    let latestStopReason: string | undefined;
    let latestErrorMessage: string | undefined;
    let turns = 0;
    let wasAborted = false;

    let session: AgentSession | undefined;
    let removeAbortListener: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const startTime = Date.now();

    try {
        const runtime = await options.modelRuntime();
        if (signal?.aborted) {
            // An abort that lands before the model is resolved wins over the
            // missing-model error path below.
            return {
                agent: agent.name,
                agentSource: agent.source,
                task,
                outcome: { status: "aborted" },
                messages: [],
                stderr: "",
                usage,
                durationMs: 0,
            };
        }
        const model = runtime.getModel(agent.model.provider, agent.model.name);
        if (!model) {
            return {
                agent: agent.name,
                agentSource: agent.source,
                task,
                outcome: {
                    status: "error",
                    exitCode: 1,
                    message: `Model not available: ${formatModelString(agent.model)}`,
                },
                messages: [],
                stderr: "",
                usage,
                durationMs: 0,
            };
        }

        const settingsManager = SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
        });

        // Override the built-in bash tool so commands executed by the
        // subagent can observe that they run inside a subagent. The registry
        // gives customTools precedence over built-ins by name. spawnHook
        // rebuilds env per execution — no global process.env mutation, so
        // the parent's own bash and concurrent background agents are safe.
        const bash = createBashToolDefinition(cwd, {
            commandPrefix: settingsManager.getShellCommandPrefix(),
            shellPath: settingsManager.getShellPath(),
            spawnHook: (spawnContext) => ({
                ...spawnContext,
                env: {
                    ...spawnContext.env,
                    PI_SUBAGENT: "1",
                    PI_SUBAGENT_NAME: agent.name,
                },
            }),
        });

        const resourceLoader = createSubagentResourceLoader(
            agent,
            options.skillCache,
        );
        const sessionManager = await buildSessionManager(sessionFile, cwd, resume);

        const created = await createAgentSession({
            cwd,
            model,
            thinkingLevel: (agent.model.thinkingLevel ?? "off") as ThinkingLevel,
            modelRuntime: runtime,
            resourceLoader,
            sessionManager,
            settingsManager,
            tools: agent.tools?.length ? agent.tools : undefined,
            customTools: [bash as ToolDefinition],
        });
        session = created.session;

        const abort = () => {
            wasAborted = true;
            session?.abort();
        };
        if (signal) {
            if (signal.aborted) {
                abort();
            } else {
                signal.addEventListener("abort", abort, { once: true });
                removeAbortListener = () =>
                    signal.removeEventListener("abort", abort);
            }
        }

        unsubscribe = session.subscribe((event) => {
            if (event.type === "message_end") {
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
                    if (msg.stopReason) latestStopReason = msg.stopReason;
                    if (msg.errorMessage) latestErrorMessage = msg.errorMessage;
                }
                usage.turns = turns;
                onProgress?.({
                    type: "message",
                    message: msg,
                    usage: { ...usage, cost: { ...usage.cost } },
                });
            } else if (event.type === "tool_execution_start") {
                onProgress?.({ type: "tool_start", toolCallId: event.toolCallId });
            } else if (event.type === "tool_execution_end") {
                onProgress?.({
                    type: "tool_end",
                    toolCallId: event.toolCallId,
                    isError: event.isError,
                });
            }
        });

        // If the signal aborted while the setup awaits were in flight, skip
        // the prompt entirely — the provider should not do work for a run
        // that is already cancelled.
        if (!signal?.aborted) {
            await session.prompt(resume ? task : `Task: ${task}`);
        }
    } catch (err: unknown) {
        if (!wasAborted) {
            latestStopReason = "error";
            latestErrorMessage = err instanceof Error ? err.message : String(err);
        }
    } finally {
        unsubscribe?.();
        removeAbortListener?.();
        session?.dispose();
    }

    const durationMs = Date.now() - startTime;
    const outcome = buildOutcome(wasAborted, latestStopReason, latestErrorMessage);

    return {
        agent: agent.name,
        agentSource: agent.source,
        task,
        outcome,
        messages,
        stderr: "",
        usage,
        durationMs,
    };
}
