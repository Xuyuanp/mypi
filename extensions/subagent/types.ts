/**
 * Cross-module types and small value utilities for the subagent extension.
 *
 * Only interfaces/types that must cross module boundaries live here.
 * Presentation-only types (DisplayItem, ToolCallStatus, FormatUsageOpts)
 * live in render.ts.
 */

import type { Message } from "@earendil-works/pi-ai";

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
    /** Skill names (not resolved paths). */
    skills?: string[];
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
    model: string;
    systemPrompt: string;
    source: "user" | "system";
}

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
    model?: string;
    durationMs: number;
}

// ── RunProgress ──────────────────────────────────────────────────────

/**
 * Lightweight mutable struct for background widget observation.
 *
 * Purpose-built for the progress display — not a full AgentRunResult.
 * Background entries accumulate this via progress events instead of
 * holding a live reference to the internal accumulator.
 */
export interface RunProgress {
    usage: UsageStats;
    model?: string;
    toolCallCount: number;
    turns: number;
}

// ── SubagentDetails ──────────────────────────────────────────────────

export interface ForegroundSubagentDetails {
    kind: "foreground";
    result: AgentRunResult;
    execStatuses: Record<string, boolean>;
    session?: { dir: string; id: string };
    resumedFrom?: string;
    /** Model context window size for usage % display. Set at result time. */
    contextWindow?: number;
}

export interface BackgroundSubagentDetails {
    kind: "background";
    result: AgentRunResult;
    description: string;
    cancelled: boolean;
    session?: { dir: string; id: string };
    /** Model context window size for usage % display. Set at result time. */
    contextWindow?: number;
}

export type SubagentDetails = ForegroundSubagentDetails | BackgroundSubagentDetails;

// ── BackgroundAgent ──────────────────────────────────────────────────

export interface BackgroundAgent {
    id: string;
    description: string;
    agentName: string;
    task: string;
    kill: () => void;
    promise: Promise<AgentRunResult>;
    startedAt: number;
    progress: RunProgress;
}

// ── Progress events ──────────────────────────────────────────────────

/**
 * Event-based progress reporting from `runSubagent`.
 *
 * Each variant carries exactly what changed — consumers accumulate
 * their own views from these atomic events.
 */
export type SubagentProgressEvent =
    | { type: "message"; message: Message; usage: UsageStats; model?: string }
    | { type: "tool_start"; toolCallId: string }
    | { type: "tool_end"; toolCallId: string; isError: boolean }
    | { type: "tool_result"; message: Message };

export type SubagentProgressCallback = (event: SubagentProgressEvent) => void;

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

/** Create a fresh zero-initialized RunProgress. */
export function createZeroProgress(): RunProgress {
    return {
        usage: createZeroUsage(),
        model: undefined,
        toolCallCount: 0,
        turns: 0,
    };
}
