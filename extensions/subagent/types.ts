/**
 * Cross-module types and small value utilities for the subagent extension.
 *
 * Only interfaces/types that must cross module boundaries live here.
 * Presentation-only types (DisplayItem, ToolCallStatus, FormatUsageOpts)
 * live in render.ts.
 */

import type { Message } from "@earendil-works/pi-ai";

// ── Model ───────────────────────────────────────────────────────────

/** Fully parsed model identity used to launch a subagent. */
export interface Model {
    provider: string;
    /** Model name/id as accepted by the pi CLI after the provider slash. */
    name: string;
    /** Optional pi thinking-level suffix parsed from provider/name:level. */
    thinkingLevel: string | undefined;
    /** Resolved context window for rendering usage, when known. */
    contextWindow: number | undefined;
}

/** Parse a provider/name[:thinking] model string into its structured form. */
export function parseModelString(
    modelStr: string,
    contextWindow: number | undefined = undefined,
): Model | undefined {
    const slash = modelStr.indexOf("/");
    if (slash === -1) return undefined;
    const provider = modelStr.slice(0, slash);
    const rest = modelStr.slice(slash + 1);
    if (!provider || !rest) return undefined;

    const match = rest.match(/^(.+):([a-z]+)$/);
    if (match) {
        return {
            provider,
            name: match[1],
            thinkingLevel: match[2],
            contextWindow,
        };
    }

    return { provider, name: rest, thinkingLevel: undefined, contextWindow };
}

/** Format a structured model back into the pi CLI provider/name[:thinking] form. */
export function formatModelString(model: Model): string {
    return `${model.provider}/${model.name}${model.thinkingLevel ? `:${model.thinkingLevel}` : ""}`;
}

// ── AgentSpec ────────────────────────────────────────────────────────

/**
 * Discovery template returned by `discoverAgents()`.
 *
 * Represents an agent definition as declared in a `.md` file. Fields
 * like `skills` hold names (not paths), and `model` is optional
 * (may inherit from the parent session at resolution time).
 */
export interface AgentSpec {
    name: string;
    description: string;
    tools?: string[];
    skillNames?: string[];
    model?: string;
    systemPrompt: string;
    source: "user" | "system";
    filePath: string;
}

// ── ResolvedAgent ────────────────────────────────────────────────────

/**
 * Fully resolved execution config passed to `runSubagent`.
 *
 * All optional resolution has been performed: model is required,
 * skills are absolute filesystem paths (or undefined if none).
 * Drops `description` and `filePath` — not needed at runtime.
 */
export interface ResolvedAgent {
    name: string;
    tools?: string[];
    /** Resolved absolute filesystem paths for --skill flags. */
    skillPaths?: string[];
    /** Required — resolved from param override > agent default > parent model. */
    model: Model;
    systemPrompt: string;
    source: "user" | "system";
}

/**
 * Lightweight variant of ResolvedAgent for persistence in session details.
 * Omits systemPrompt to avoid bloating session files (prompts are 2-10KB).
 * The prompt can be re-resolved from the agent registry at resume time.
 */
export type PersistedResolvedAgent = Omit<ResolvedAgent, "systemPrompt">;

// ── AgentOutcome ─────────────────────────────────────────────────────

/**
 * Discriminated union expressing the terminal state of a subagent run.
 *
 * Only terminal variants — "running" is a lifecycle state handled
 * internally by `execute.ts`, never exposed on a completed result.
 *
 * - "success": clean exit (exit code 0, no error stop reason)
 * - "error": non-zero exit or agent-reported error
 * - "aborted": cancelled via AbortSignal
 */
export type AgentOutcome =
    | { status: "success"; stopReason?: string }
    | {
          status: "error";
          exitCode: number;
          stopReason?: string;
          message: string;
      }
    | { status: "aborted"; message?: string };

// ── UsageStats ───────────────────────────────────────────────────────

export interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
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

// ── AgentRunResult ───────────────────────────────────────────────────

/**
 * Immutable execution record returned by `runSubagent`.
 *
 * `outcome` is always terminal (never "running").
 * `durationMs` is always set.
 * `contextWindow` is not included — it is a rendering concern resolved
 * at the callsite via the model registry.
 */
export interface AgentRunResult {
    agent: string;
    agentSource: "user" | "system" | "unknown";
    task: string;
    outcome: AgentOutcome;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    durationMs: number;
}

// ── SubagentDetails ──────────────────────────────────────────────────

/**
 * Unified subagent detail record — replaces the old discriminated union
 * (ForegroundSubagentDetails | BackgroundSubagentDetails).
 *
 * Fields that are kind-specific (description, cancelled, resumedFrom)
 * are optional. Consumers dispatch on `kind` at runtime.
 */
export interface SubagentDetails {
    kind: "foreground" | "background";
    result: AgentRunResult;
    /**
     * Tool call execution statuses (toolCallId → isError).
     * Always set for newly-written details. May be absent at runtime when
     * deserializing old persisted entries that predate this field.
     */
    execStatuses?: Record<string, boolean>;
    session?: { dir: string; id: string };
    resolvedAgent?: PersistedResolvedAgent;
    contextWindow?: number;
    // background-specific (undefined for foreground)
    description?: string;
    cancelled?: boolean;
    // resume-specific (undefined for non-resume)
    resumedFrom?: string;
}

// ── ProgressTracker ──────────────────────────────────────────────────

/**
 * Mutable progress accumulator shared by all three execution paths
 * (foreground, background, resume).
 *
 * The factory function lives in tracker.ts; this interface is the
 * dependency-free leaf so BackgroundAgent can reference it.
 */
export interface ProgressTracker {
    /** Pass to runSubagent's onProgress option. */
    readonly onProgress: SubagentProgressCallback;
    /** Accumulated assistant + toolResult messages. */
    readonly messages: Message[];
    /** Tool call ID → isError map (populated on tool_end). */
    readonly execStatuses: Map<string, boolean>;
    /** Running usage totals (snapshot from latest message event). */
    readonly usage: UsageStats;
    /** Number of tools started (increments on tool_start, before completion). */
    readonly toolStartCount: number;
}

// ── BackgroundAgent ──────────────────────────────────────────────────

export interface BackgroundAgent {
    id: string;
    description: string;
    agentName: string;
    task: string;
    kill: () => void;
    promise: Promise<AgentRunResult>;
    startedAt: number;
    tracker: ProgressTracker;
    session?: { dir: string; id: string };
}

// ── Progress events ──────────────────────────────────────────────────

/**
 * Event-based progress reporting from `runSubagent`.
 *
 * Each variant carries exactly what changed — consumers accumulate
 * their own views from these atomic events.
 */
export type SubagentProgressEvent =
    | { type: "message"; message: Message; usage: UsageStats }
    | { type: "tool_start"; toolCallId: string }
    | { type: "tool_end"; toolCallId: string; isError: boolean }
    | { type: "tool_result"; message: Message };

export type SubagentProgressCallback = (event: SubagentProgressEvent) => void;

// ── Tool execution types ────────────────────────────────────────────

/** Parameters accepted by the subagent tool. */
export interface SubagentToolParams {
    agent: string;
    description: string;
    task: string;
    model?: string;
    cwd?: string;
    skills?: string[];
    background?: boolean;
}

/** Return type for the subagent tool execute handler. */
export interface ToolResult {
    content: { type: "text"; text: string }[];
    details: SubagentDetails | undefined;
    isError?: boolean;
}

// ── Value utilities ──────────────────────────────────────────────────

/** Create a fresh zero-initialized UsageStats object. */
export function createZeroUsage(): UsageStats {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        contextTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        turns: 0,
    };
}

/** Immutable zero-usage sentinel for read-only comparisons and defaults. */
export const ZERO_USAGE: Readonly<UsageStats> = Object.freeze({
    ...createZeroUsage(),
    cost: Object.freeze(createZeroUsage().cost),
});

/**
 * Returns true when the subagent result indicates a failure.
 * Positively matches error/aborted variants.
 */
export function isSubagentError(r: AgentRunResult): r is AgentRunResult & {
    outcome: { status: "error" | "aborted" };
} {
    return r.outcome.status === "error" || r.outcome.status === "aborted";
}
