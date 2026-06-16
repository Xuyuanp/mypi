/**
 * Execution orchestration for the subagent extension.
 *
 * Owns agent resolution, foreground/background execution coordination,
 * and result construction. Pure functions are exported for testing;
 * async execution functions are the primary interface.
 *
 * All framework objects (ctx, bgManager, etc.) are passed as explicit
 * function parameters — no closure over ExtensionAPI.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";

import type { ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import type { BackgroundManager } from "./background.js";
import { runSubagent } from "./execute.js";
import { getFinalOutput } from "./render.js";
import { createProgressTracker } from "./tracker.js";
import type {
    AgentRunResult,
    AgentSpec,
    PersistedResolvedAgent,
    ResolvedAgent,
    SubagentDetails,
    SubagentToolParams,
    ToolResult,
} from "./types.js";
import { isSubagentError, ZERO_USAGE } from "./types.js";

// ── Pure resolution helpers ──────────────────────────────────────────

/**
 * Resolve skill names to absolute file paths via the skill cache.
 * Returns resolved paths, or an error message if any skill is unknown.
 */
export function resolveSkills(
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

/**
 * Validate params and resolve the final ResolvedAgent.
 * Returns a ResolvedAgent on success, or an error string on failure.
 */
export function resolveAgentConfig(
    params: SubagentToolParams,
    agents: AgentSpec[],
    skillCache: Map<string, Skill>,
    ctx: ExtensionContext,
): ResolvedAgent | string {
    const agent = agents.find((a) => a.name === params.agent);
    if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return `Unknown agent: "${params.agent}". Available agents: ${available}.`;
    }

    const skillNames =
        params.skills !== undefined ? params.skills : agent.skillNames;
    const skillResult = resolveSkills(skillNames, skillCache);
    if (skillResult.error) {
        return skillResult.error;
    }

    const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
    const resolvedModel = (params.model || undefined) ?? agent.model ?? parentModel;
    if (!resolvedModel) {
        return "No model available: agent has no default model and no parent model is set.";
    }

    return {
        name: agent.name,
        tools: agent.tools,
        skillPaths: skillResult.paths,
        model: resolvedModel,
        systemPrompt: agent.systemPrompt,
        source: agent.source,
    };
}

/** Resolve the context window for a model string via the model registry. */
export function resolveContextWindow(
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

/** Derive a subagent session directory and ID from the parent session. */
export function deriveSessionPath(
    agentName: string,
    ctx: ExtensionContext,
): { dir: string; id: string } | undefined {
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    if (!parentSessionFile) return undefined;
    const dir = path.resolve(
        parentSessionFile.slice(0, -".jsonl".length),
        "subagent",
    );
    const id = `${agentName}-${randomUUID().slice(0, 8)}`;
    return { dir, id };
}

/** Strip systemPrompt from ResolvedAgent for session persistence. */
export function persistAgent(agent: ResolvedAgent): PersistedResolvedAgent {
    const { systemPrompt: _, ...rest } = agent;
    return rest;
}

/** Extract a human-readable error/output string from a completed agent result. */
export function getResultOutput(result: AgentRunResult): string {
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

/** Build an error ToolResult from a message string and the original params. */
export function makeErrorToolResult(
    msg: string,
    params: SubagentToolParams,
): ToolResult {
    return {
        content: [{ type: "text", text: msg }],
        details: {
            kind: "foreground",
            result: {
                agent: params.agent,
                agentSource: "unknown",
                task: params.task,
                outcome: {
                    status: "error",
                    exitCode: 1,
                    message: msg,
                },
                messages: [],
                stderr: msg,
                usage: ZERO_USAGE,
                durationMs: 0,
            },
            execStatuses: {},
        },
        isError: true,
    };
}

// ── Execution functions ──────────────────────────────────────────────

/** Execute a subagent in background (fire-and-forget) mode. */
export function executeBackground(
    resolvedAgent: ResolvedAgent,
    params: SubagentToolParams,
    session: { dir: string; id: string } | undefined,
    bgManager: BackgroundManager,
    onUpdate:
        | ((update: {
              content: { type: "text"; text: string }[];
              details: SubagentDetails;
          }) => void)
        | undefined,
    ctx: ExtensionContext,
): ToolResult {
    const id = session?.id ?? `${resolvedAgent.name}-${randomUUID().slice(0, 8)}`;

    const controller = new AbortController();
    const tracker = createProgressTracker({
        onChange: () => bgManager.updateWidget(),
    });
    const contextWindow = resolveContextWindow(resolvedAgent.model, ctx);

    const sessionFile = session
        ? path.join(session.dir, `${session.id}.jsonl`)
        : undefined;

    const promise = runSubagent(resolvedAgent, params.task, params.cwd ?? ctx.cwd, {
        signal: controller.signal,
        onProgress: tracker.onProgress,
        sessionFile,
    });

    const entry = {
        id,
        description: params.description,
        agentName: resolvedAgent.name,
        task: params.task,
        kill: () => controller.abort(),
        promise,
        startedAt: Date.now(),
        tracker,
    };
    bgManager.register(entry);

    const bgDetails = (
        cancelled: boolean,
    ): Omit<SubagentDetails, "result" | "kind"> => ({
        description: params.description,
        cancelled,
        execStatuses: Object.fromEntries(tracker.execStatuses),
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
    if (toolResult.details)
        onUpdate?.({ ...toolResult, details: toolResult.details });

    return toolResult;
}

/** Execute a subagent in foreground (blocking) mode. */
export async function executeForeground(
    resolvedAgent: ResolvedAgent,
    params: SubagentToolParams,
    session: { dir: string; id: string } | undefined,
    signal: AbortSignal | undefined,
    onUpdate:
        | ((update: {
              content: { type: "text"; text: string }[];
              details: SubagentDetails;
          }) => void)
        | undefined,
    ctx: ExtensionContext,
    opts?: { resumedFrom?: string; resume?: boolean },
): Promise<ToolResult> {
    const contextWindow = resolveContextWindow(resolvedAgent.model, ctx);
    const resumedFrom = opts?.resumedFrom;

    const makeDetails = (result: AgentRunResult): SubagentDetails => ({
        kind: "foreground",
        result,
        execStatuses: Object.fromEntries(tracker.execStatuses),
        session,
        resolvedAgent: persistAgent(resolvedAgent),
        contextWindow,
        ...(resumedFrom ? { resumedFrom } : {}),
    });

    const tracker = createProgressTracker({
        onChange: onUpdate
            ? () => {
                  const partialResult: AgentRunResult = {
                      agent: resolvedAgent.name,
                      agentSource: resolvedAgent.source,
                      task: params.task,
                      outcome: { status: "success" },
                      messages: [...tracker.messages],
                      stderr: "",
                      usage: tracker.usage,
                      model: resolvedAgent.model,
                      durationMs: 0,
                  };
                  onUpdate({
                      content: [{ type: "text", text: "" }],
                      details: makeDetails(partialResult),
                  });
              }
            : undefined,
    });

    const sessionFile = session
        ? path.join(session.dir, `${session.id}.jsonl`)
        : undefined;

    const result = await runSubagent(
        resolvedAgent,
        params.task,
        params.cwd ?? ctx.cwd,
        {
            signal,
            onProgress: tracker.onProgress,
            sessionFile,
            resume: opts?.resume,
        },
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
