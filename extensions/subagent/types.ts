/**
 * Cross-module types and small value utilities for the subagent extension.
 *
 * Only interfaces/types that must cross module boundaries live here.
 * Presentation-only types (DisplayItem, ToolCallStatus, FormatUsageOpts)
 * live in render.ts.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";

// ── AgentOutcome ─────────────────────────────────────────────────────

/**
 * Discriminated union expressing the terminal state of a subagent run.
 *
 * - "running": subprocess in progress (replaces the old exitCode: -1 sentinel)
 * - "success": clean exit (exit code 0, no error stop reason)
 * - "error": non-zero exit or agent-reported error
 * - "aborted": cancelled via AbortSignal
 */
export type AgentOutcome =
    | { status: "running" }
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

export interface AgentRunResult {
    agent: string;
    agentSource: "user" | "system" | "unknown";
    task: string;
    outcome: AgentOutcome;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    contextWindow?: number;
    durationMs?: number;
}

// ── SubagentDetails ──────────────────────────────────────────────────

export interface ForegroundSubagentDetails {
    kind: "foreground";
    result: AgentRunResult;
    execStatuses: Record<string, boolean>;
    session?: { dir: string; id: string };
    resumedFrom?: string;
}

export interface BackgroundSubagentDetails {
    kind: "background";
    result: AgentRunResult;
    description: string;
    cancelled: boolean;
    session?: { dir: string; id: string };
}

export type SubagentDetails = ForegroundSubagentDetails | BackgroundSubagentDetails;

// ── BackgroundAgent ──────────────────────────────────────────────────

export interface BackgroundAgent {
    id: string;
    description: string;
    agent: AgentConfig;
    task: string;
    kill: () => void;
    promise: Promise<AgentRunResult>;
    startedAt: number;
    latestResult: AgentRunResult;
    toolCallCount: number;
}

// ── Progress events ──────────────────────────────────────────────────

export type SubagentProgressEvent =
    | { type: "message" }
    | { type: "tool_start"; toolCallId: string }
    | { type: "tool_end"; toolCallId: string; isError: boolean }
    | { type: "tool_result" };

export type SubagentProgressCallback = (
    result: AgentRunResult,
    event: SubagentProgressEvent,
) => void;

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
 * Positively matches error/aborted variants (future-proof if new
 * non-error variants are added).
 */
export function isSubagentError(r: AgentRunResult): r is AgentRunResult & {
    outcome: { status: "error" | "aborted" };
} {
    return r.outcome.status === "error" || r.outcome.status === "aborted";
}
