/**
 * Subagent Tool - Task delegation to specialized agents.
 *
 * Thin wiring layer: tool registration, event subscriptions, and
 * delegation to execute.ts / background.ts / render.ts.
 *
 * Key capabilities:
 * - Concurrent execution: no executionMode declared, so the agent
 *   loop can batch multiple subagent calls via Promise.all.
 * - Model override: per-call model param > agent default > parent.
 * - Abort support: SIGTERM on signal, SIGKILL after 5s timeout.
 * - TUI rendering: collapsed/expanded views with tool-specific
 *   formatting, status icons, and usage stats (tokens/cost/time).
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

import type {
    ExtensionAPI,
    ExtensionContext,
    Skill,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents } from "./agents.js";
import type { BackgroundManager } from "./background.js";
import { BACKGROUND_RESULT_TYPE, createBackgroundManager } from "./background.js";
import { registerSubagentCommand } from "./command.js";
import { runSubagent } from "./execute.js";
import { getFinalOutput, renderSubagentResult } from "./render.js";
import { lookupSubagentSession } from "./resume.js";
import type {
    AgentRunResult,
    AgentSpec,
    BackgroundAgent,
    BackgroundSubagentDetails,
    ForegroundSubagentDetails,
    PersistedResolvedAgent,
    ResolvedAgent,
    SubagentDetails,
    SubagentProgressCallback,
    UsageStats,
} from "./types.js";
import {
    createZeroProgress,
    createZeroUsage,
    isSubagentError,
    ZERO_USAGE,
} from "./types.js";

// ── Re-exports for backward compatibility ────────────────────────────
export type { BackgroundAgent } from "./types.js";
export { createZeroUsage } from "./types.js";

// ── Renderer state ───────────────────────────────────────────────────

/**
 * Shared renderer state passed between renderCall and renderResult
 * via ToolRenderContext.state. Allows renderResult to communicate
 * the resolved agent back to renderCall for display in the header.
 */
interface SubagentRenderState {
    resolvedAgent?: PersistedResolvedAgent;
}

// ── Local helpers ────────────────────────────────────────────────────

/** Strip systemPrompt from ResolvedAgent for session persistence. */
function persistAgent(agent: ResolvedAgent): PersistedResolvedAgent {
    const { systemPrompt: _, ...rest } = agent;
    return rest;
}

function escapeXml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeAgentName(name: string): string {
    return (
        name
            .replace(/[^\w.-]+/g, "_")
            .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "") || "agent"
    );
}

/** Resolve the context window for a model string via the model registry. */
function resolveContextWindow(
    modelStr: string | undefined,
    ctx: ExtensionContext,
): number | undefined {
    if (!modelStr) return ctx.model?.contextWindow;
    const slash = modelStr.indexOf("/");
    if (slash === -1) return ctx.model?.contextWindow;
    const provider = modelStr.slice(0, slash);
    const rest = modelStr.slice(slash + 1);
    const match = rest.match(/^(.+):([a-z]+)$/);
    const id = match ? match[1] : rest;
    const model = ctx.modelRegistry.find(provider, id);
    return model?.contextWindow ?? ctx.model?.contextWindow;
}

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

// ── Subagent tool params ─────────────────────────────────────────────

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
    details: ForegroundSubagentDetails | BackgroundSubagentDetails | undefined;
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

function buildToolDescription(agents: AgentSpec[]): string {
    const agentList =
        agents.length > 0
            ? [...agents]
                  .sort((a, b) => a.name.localeCompare(b.name))
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

// ── Resolution logic ─────────────────────────────────────────────────

type ResolveResult =
    | { error: ToolResult; agent?: never; session?: never }
    | {
          error?: never;
          agent: ResolvedAgent;
          session: { dir: string; id: string } | undefined;
      };

/**
 * Validate params and resolve the final ResolvedAgent + session path.
 */
function resolveAgentConfig(
    params: SubagentToolParams,
    agents: AgentSpec[],
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
                durationMs: 0,
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

    const skillNames =
        params.skills !== undefined ? params.skills : agent.skillNames;
    const skillResult = resolveSkills(skillNames, skillCache);
    if (skillResult.error) {
        return { error: makeErrorResult(skillResult.error, agent.source) };
    }

    const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
    const resolvedModel = (params.model || undefined) ?? agent.model ?? parentModel;
    if (!resolvedModel) {
        return {
            error: makeErrorResult(
                "No model available: agent has no default model and no parent model is set.",
                agent.source,
            ),
        };
    }

    const resolvedAgent: ResolvedAgent = {
        name: agent.name,
        tools: agent.tools,
        skillPaths: skillResult.paths,
        model: resolvedModel,
        systemPrompt: agent.systemPrompt,
        source: agent.source,
    };

    // Persist subagent session alongside the parent session.
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

// ── Execute helpers ──────────────────────────────────────────────────

/** Execute a subagent in background (fire-and-forget) mode. */
function executeBackground(
    resolvedAgent: ResolvedAgent,
    params: SubagentToolParams,
    session: { dir: string; id: string } | undefined,
    bgManager: BackgroundManager,
    onUpdate:
        | ((update: {
              content: { type: "text"; text: string }[];
              details: BackgroundSubagentDetails;
          }) => void)
        | undefined,
    ctx: ExtensionContext,
): ToolResult {
    const id =
        session?.id ??
        `${sanitizeAgentName(resolvedAgent.name)}-${randomUUID().slice(0, 8)}`;

    const controller = new AbortController();
    const progress = createZeroProgress();
    const contextWindow = resolveContextWindow(resolvedAgent.model, ctx);

    const bgOnProgress: SubagentProgressCallback = (event) => {
        if (event.type === "message") {
            progress.usage = event.usage;

            progress.turns = event.usage.turns;
        } else if (event.type === "tool_start") {
            progress.toolCallCount++;
        }
    };

    const sessionFile = session
        ? path.join(session.dir, `${session.id}.jsonl`)
        : undefined;

    const promise = runSubagent(resolvedAgent, params.task, params.cwd ?? ctx.cwd, {
        signal: controller.signal,
        onProgress: bgOnProgress,
        sessionFile,
    });

    const entry: BackgroundAgent = {
        id,
        description: params.description,
        agentName: resolvedAgent.name,
        task: params.task,
        kill: () => controller.abort(),
        promise,
        startedAt: Date.now(),
        progress,
    };
    bgManager.register(entry);

    const bgDetails = (cancelled: boolean) => ({
        description: params.description,
        cancelled,
        session,
        resolvedAgent: persistAgent(resolvedAgent),
        contextWindow,
    });

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
                    bgDetails(true),
                );
                return;
            }

            bgManager.injectResult(
                id,
                isSubagentError(result) ? "failed" : "completed",
                getResultOutput(result),
                result,
                bgDetails(false),
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
                    {
                        agent: params.agent,
                        agentSource: resolvedAgent.source,
                        task: params.task,
                        outcome: { status: "aborted" },
                        messages: [],
                        stderr: "",
                        usage: ZERO_USAGE,
                        durationMs: 0,
                    },
                    bgDetails(true),
                );
                return;
            }

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
                    durationMs: 0,
                },
                bgDetails(false),
            );
        });

    const toolResult: ToolResult = {
        content: [
            {
                type: "text",
                text: `Background agent started: ${id}`,
            },
        ],
        details: {
            kind: "background",
            result: {
                agent: resolvedAgent.name,
                agentSource: resolvedAgent.source,
                task: params.task,
                outcome: { status: "success" },
                messages: [],
                stderr: "",
                usage: ZERO_USAGE,
                model: resolvedAgent.model,
                durationMs: 0,
            },
            ...bgDetails(false),
        },
    };

    // Emit a preliminary update so renderResult populates shared state
    // before the final render. Without this, renderCall on the final
    // render would see empty state (render order: call before result).
    onUpdate?.(toolResult as { content: any; details: BackgroundSubagentDetails });

    return toolResult;
}

/** Execute a subagent in foreground (blocking) mode. */
async function executeForeground(
    resolvedAgent: ResolvedAgent,
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
    const messages: Message[] = [];
    const contextWindow = resolveContextWindow(resolvedAgent.model, ctx);

    const makeDetails = (result: AgentRunResult): ForegroundSubagentDetails => ({
        kind: "foreground",
        result,
        execStatuses: Object.fromEntries(execStatusMap),
        session,
        resolvedAgent: persistAgent(resolvedAgent),
        contextWindow,
    });

    let latestUsage: UsageStats = createZeroUsage();
    let latestModel: string | undefined = resolvedAgent.model;

    const onProgress: SubagentProgressCallback | undefined = onUpdate
        ? (event) => {
              if (event.type === "tool_end") {
                  execStatusMap.set(event.toolCallId, event.isError);
              }
              if (event.type === "message") {
                  messages.push(event.message);
                  latestUsage = event.usage;
                  if (event.model) latestModel = event.model;
              }
              if (event.type === "tool_result") {
                  messages.push(event.message);
              }
              // Push update on events that change rendered state
              if (event.type === "tool_end" || event.type === "message") {
                  const partialResult: AgentRunResult = {
                      agent: resolvedAgent.name,
                      agentSource: resolvedAgent.source,
                      task: params.task,
                      outcome: { status: "success" },
                      messages: [...messages],
                      stderr: "",
                      usage: latestUsage,
                      model: latestModel,
                      durationMs: 0,
                  };
                  onUpdate({
                      content: [{ type: "text", text: "" }],
                      details: makeDetails(partialResult),
                  });
              }
          }
        : undefined;

    const sessionFile = session
        ? path.join(session.dir, `${session.id}.jsonl`)
        : undefined;

    const result = await runSubagent(
        resolvedAgent,
        params.task,
        params.cwd ?? ctx.cwd,
        { signal, onProgress, sessionFile },
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
    const knownAgents = discoverAgents();
    const bgManager = createBackgroundManager(pi);

    registerSubagentCommand(pi, bgManager);

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
            const details = message.details;
            const bgDetails =
                details &&
                typeof details === "object" &&
                "kind" in details &&
                details.kind === "background"
                    ? (details as BackgroundSubagentDetails)
                    : undefined;
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
                knownAgents,
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
                    onUpdate,
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

        renderCall(args, theme, context) {
            const agentName = args.agent || "...";
            const desc = args.description || "...";
            const bgIndicator = args.background ? theme.fg("muted", " (bg)") : "";
            const state = context.state as SubagentRenderState;
            const modelPart = state.resolvedAgent
                ? theme.fg("muted", ` ${state.resolvedAgent.model}`)
                : "";
            const text =
                theme.fg("toolTitle", theme.bold("subagent ")) +
                theme.fg("text", agentName) +
                modelPart +
                bgIndicator +
                theme.fg("dim", ` ${desc}`);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme, context) {
            const details = result.details;
            if (!details || typeof details !== "object" || !("kind" in details)) {
                const text = result.content[0];
                return new Text(
                    text?.type === "text"
                        ? theme.fg("dim", text.text)
                        : "(no output)",
                    0,
                    0,
                );
            }
            const typed = details as SubagentDetails;
            // Publish resolved agent to shared state for renderCall
            const state = context.state as SubagentRenderState;
            if (typed.resolvedAgent) state.resolvedAgent = typed.resolvedAgent;

            if (typed.kind === "background") {
                const contentText = result.content[0];
                const msg =
                    contentText?.type === "text" ? contentText.text : "(started)";
                if (expanded && typed.result.task) {
                    const container = new Container();
                    container.addChild(new Text(theme.fg("dim", msg), 0, 0));
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
                    container.addChild(
                        new Text(theme.fg("dim", typed.result.task), 0, 0),
                    );
                    return container;
                }
                return new Text(theme.fg("dim", msg), 0, 0);
            }
            return renderSubagentResult(typed, expanded, theme);
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

            if (!matchedDetails.resolvedAgent) {
                return errorResult(
                    `Session "${id}" has no resolved agent info. Cannot resume.`,
                );
            }
            const persisted = matchedDetails.resolvedAgent;
            const agent = knownAgents.find((a) => a.name === persisted.name);
            if (!agent) {
                return errorResult(
                    `Agent "${persisted.name}" is no longer available.`,
                );
            }
            const resolvedAgent: ResolvedAgent = {
                ...persisted,
                systemPrompt: agent.systemPrompt,
            };

            const execStatusMap = new Map<string, boolean>();
            const progressMessages: Message[] = [];

            const resumeContextWindow = resolveContextWindow(
                resolvedAgent.model,
                ctx,
            );
            const makeDetails = (
                result: AgentRunResult,
            ): ForegroundSubagentDetails => ({
                kind: "foreground",
                result,
                execStatuses: Object.fromEntries(execStatusMap),
                session,
                resumedFrom: id,
                resolvedAgent: persistAgent(resolvedAgent),
                contextWindow: resumeContextWindow,
            });

            let resumeLatestUsage: UsageStats = createZeroUsage();
            let resumeLatestModel: string | undefined = resolvedAgent.model;

            const onProgress: SubagentProgressCallback | undefined = onUpdate
                ? (event) => {
                      if (event.type === "tool_end") {
                          execStatusMap.set(event.toolCallId, event.isError);
                      }
                      if (event.type === "message") {
                          progressMessages.push(event.message);
                          resumeLatestUsage = event.usage;
                          if (event.model) resumeLatestModel = event.model;
                      }
                      if (event.type === "tool_result") {
                          progressMessages.push(event.message);
                      }
                      if (event.type === "tool_end" || event.type === "message") {
                          const partialResult: AgentRunResult = {
                              agent: resolvedAgent.name,
                              agentSource: resolvedAgent.source,
                              task: follow_up,
                              outcome: { status: "success" },
                              messages: [...progressMessages],
                              stderr: "",
                              usage: resumeLatestUsage,
                              model: resumeLatestModel,
                              durationMs: 0,
                          };
                          onUpdate({
                              content: [{ type: "text", text: "" }],
                              details: makeDetails(partialResult),
                          });
                      }
                  }
                : undefined;

            const result = await runSubagent(resolvedAgent, follow_up, ctx.cwd, {
                signal,
                onProgress,
                sessionFile,
                resume: true,
            });

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

        renderCall(args, theme, context) {
            const sessionId = args.id || "...";
            const agentName = sessionId.replace(/-[^-]+$/, "") || sessionId;
            const state = context.state as SubagentRenderState;
            const modelPart = state.resolvedAgent
                ? theme.fg("muted", ` ${state.resolvedAgent.model}`)
                : "";
            const rawFollowUp = args.follow_up
                ? args.follow_up.replace(/\s+/g, " ").trim()
                : "...";
            const followUp =
                rawFollowUp.length > 60
                    ? `${rawFollowUp.slice(0, 60)}...`
                    : rawFollowUp;
            const text =
                theme.fg("toolTitle", theme.bold("subagent_resume ")) +
                theme.fg("text", agentName) +
                modelPart +
                theme.fg("dim", ` ${followUp}`);
            return new Text(text, 0, 0);
        },

        renderResult(result, { expanded }, theme, context) {
            const details = result.details;
            if (
                !details ||
                typeof details !== "object" ||
                !("kind" in details) ||
                details.kind !== "foreground"
            ) {
                const text = result.content[0];
                return new Text(
                    text?.type === "text"
                        ? theme.fg("dim", text.text)
                        : "(no output)",
                    0,
                    0,
                );
            }
            // Publish resolved agent to shared state for renderCall
            const state = context.state as SubagentRenderState;
            const typed = details as ForegroundSubagentDetails;
            if (typed.resolvedAgent) state.resolvedAgent = typed.resolvedAgent;

            return renderSubagentResult(typed, expanded, theme);
        },
    });
}
