/**
 * ProgressTracker factory — shared mutable accumulator for all three
 * subagent execution paths (foreground, background, resume).
 *
 * The tracker is a single object with a .onProgress callback that
 * runSubagent feeds events into. Callers read the accumulated state
 * directly (messages, execStatuses, usage, toolStartCount) and
 * optionally register an onChange callback for side effects
 * (widget refresh, partial-result push).
 */

import type { Message } from "@earendil-works/pi-ai";
import type {
    ProgressTracker,
    SubagentProgressCallback,
    UsageStats,
} from "./types.js";
import { createZeroUsage } from "./types.js";

// ── Factory options ──────────────────────────────────────────────────

interface CreateProgressTrackerOpts {
    /** Called on every state-changing event (message, tool_start, tool_end). */
    onChange?: () => void;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createProgressTracker(
    opts: CreateProgressTrackerOpts = {},
): ProgressTracker {
    const messages: Message[] = [];
    const execStatuses = new Map<string, boolean>();
    let usage: UsageStats = createZeroUsage();
    let toolStartCount = 0;

    function notifyChange(): void {
        try {
            opts.onChange?.();
        } catch {
            /* Render/update failures must not kill subprocess event handling. */
        }
    }

    const onProgress: SubagentProgressCallback = (event) => {
        if (event.type === "tool_start") {
            toolStartCount++;
            notifyChange();
        } else if (event.type === "tool_end") {
            execStatuses.set(event.toolCallId, event.isError);
            notifyChange();
        } else if (event.type === "message") {
            messages.push(event.message);
            usage = event.usage;
            notifyChange();
        } else if (event.type === "tool_result") {
            messages.push(event.message);
            // No onChange: current render state is already updated by tool_end;
            // final rendering uses the authoritative AgentRunResult messages.
        }
    };

    return {
        onProgress,
        messages,
        execStatuses,
        get usage() {
            return usage;
        },
        get toolStartCount() {
            return toolStartCount;
        },
    };
}
