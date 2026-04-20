/**
 * Types and constants for the review-fix-loop extension.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export type { ThinkingLevel };

export const DEFAULT_MAX_ITERATIONS = 5;
export const REVIEW_MODEL_PROVIDER = "github-copilot";
export const REVIEW_MODEL_ID = "gpt-5.3-codex";
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
export const REVIEW_MODEL_ENV = "PI_REVIEW_FIX_MODEL";
export const LOOP_START_TIMEOUT_MS = 30_000;
export const LOOP_START_POLL_MS = 100;

export type ReviewFixConfig = {
    target: "uncommitted";
    maxIterations: number;
    extraFocus: string | undefined;
    modelProvider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
};

export type LoopExitReason = "clean" | "max-iterations" | "aborted" | "error";

export type LoopResult = {
    iterations: number;
    exitReason: LoopExitReason;
    /**
     * Specific failure reason when `exitReason === "error"`.
     *
     * The overlay is torn down as soon as `runLoop` returns (via
     * `ctx.ui.custom`'s `done()` callback), so any message passed to
     * `overlay.setError(...)` is no longer visible. Carrying it on
     * `LoopResult` lets the final result message surface the concrete
     * cause (reviewer failure text, turn-start timeout, stop-reason,
     * navigation failure, ...) instead of a generic "Stopped due to an
     * error."
     */
    errorMessage?: string;
};

export type AssistantSnapshot = {
    id: string;
    text: string;
    stopReason?: string;
};

export type ReviewEvent =
    | { type: "thinking_delta"; delta: string }
    | { type: "thinking_end" }
    | { type: "text_delta"; delta: string }
    | { type: "tool_start"; toolName: string; args: Record<string, unknown> }
    | { type: "tool_end"; toolName: string; isError: boolean };

export type ReviewEventCallback = (event: ReviewEvent) => void;

export const RESULT_MESSAGE_TYPE = "review-fix-result";
