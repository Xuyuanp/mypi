/**
 * Execution orchestration for the subagent extension.
 *
 * Owns foreground/background execution coordination and result
 * construction. Delegates agent resolution to resolve.ts and
 * subprocess mechanics to execute.ts.
 *
 * All framework objects (ctx, bgManager, etc.) are passed as explicit
 * function parameters — no closure over ExtensionAPI.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";

import type { BackgroundManager } from "./background.js";
import { runSubagent } from "./execute.js";
import { persistAgent } from "./resolve.js";
import { createProgressTracker } from "./tracker.js";
import type {
    AgentRunResult,
    ResolvedAgent,
    SubagentDetails,
    SubagentToolParams,
    ToolResult,
} from "./types.js";
import { getFinalOutput, isSubagentError, ZERO_USAGE } from "./types.js";

// ── Result helpers ───────────────────────────────────────────────────

/**
 * Build a lightweight error ToolResult for the subagent_resume tool.
 *
 * Unlike makeErrorToolResult (which requires SubagentToolParams and builds
 * a full SubagentDetails), this is for resume-path errors that occur before
 * any agent is resolved — so details is undefined.
 */
export function makeResumeErrorResult(msg: string): ToolResult {
    return {
        content: [{ type: "text", text: msg }],
        details: undefined,
        isError: true,
    };
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
    cwd: string,
): ToolResult {
    const id = session?.id ?? `${resolvedAgent.name}-${randomUUID().slice(0, 8)}`;

    const controller = new AbortController();
    const tracker = createProgressTracker({
        onChange: () => bgManager.updateWidget(),
    });
    const sessionFile = session
        ? path.join(session.dir, `${session.id}.jsonl`)
        : undefined;

    const promise = runSubagent(resolvedAgent, params.task, params.cwd ?? cwd, {
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
        session,
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
    cwd: string,
    opts?: { resumedFrom?: string; resume?: boolean },
): Promise<ToolResult> {
    const resumedFrom = opts?.resumedFrom;

    const makeDetails = (result: AgentRunResult): SubagentDetails => ({
        kind: "foreground",
        result,
        execStatuses: Object.fromEntries(tracker.execStatuses),
        session,
        resolvedAgent: persistAgent(resolvedAgent),
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

    const result = await runSubagent(resolvedAgent, params.task, params.cwd ?? cwd, {
        signal,
        onProgress: tracker.onProgress,
        sessionFile,
        resume: opts?.resume,
    });

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
