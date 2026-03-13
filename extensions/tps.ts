/**
 * TPS (Tokens Per Second) Extension
 *
 * Tracks output token throughput for each LLM response in the current
 * session and displays a live, real-time metric in the footer status bar.
 *
 * During streaming, the footer updates continuously using the partial
 * message's usage.output (when the provider reports incremental usage)
 * or a delta-event count as a fallback approximation.
 *
 * Once a response completes, the display switches to the final accurate
 * TPS calculated from the completed message's usage.output.
 *
 * Metrics shown (footer status):
 *   While streaming:  "~42.3 tok/s" (live, prefixed with ~ when approximate)
 *   After response:   "38.1 tok/s (avg 40.2 tok/s)"
 *
 * Timing is measured from message_start to message_end for assistant
 * messages only, excluding tool execution time.
 *
 * Provides a `/tps` command that shows a detailed summary of session
 * token throughput statistics.
 */

import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "tps";
const UPDATE_INTERVAL_MS = 300;

interface TurnMetrics {
    outputTokens: number;
    elapsedMs: number;
}

interface StreamingState {
    startTime: number;
    deltaCount: number;
    lastUsageOutput: number;
    lastUpdateTime: number;
}

type StatusCtx = {
    ui: { setStatus(key: string, text: string | undefined): void };
};

function formatTps(tokens: number, ms: number): string {
    if (ms <= 0) return "-- tok/s";
    const tps = (tokens / ms) * 1000;
    return `${tps.toFixed(1)} tok/s`;
}

function formatSummaryLine(label: string, metrics: TurnMetrics): string {
    const tps =
        metrics.elapsedMs > 0
            ? ((metrics.outputTokens / metrics.elapsedMs) * 1000).toFixed(1)
            : "--";
    const seconds = (metrics.elapsedMs / 1000).toFixed(1);
    return `${label}: ${tps} tok/s (${metrics.outputTokens} tokens in ${seconds}s)`;
}

function isDeltaEvent(event: AssistantMessageEvent): boolean {
    return (
        event.type === "text_delta" ||
        event.type === "thinking_delta" ||
        event.type === "toolcall_delta"
    );
}

export default function (pi: ExtensionAPI) {
    let streaming: StreamingState | null = null;
    let turns: TurnMetrics[] = [];
    let totalOutputTokens = 0;
    let totalElapsedMs = 0;

    function reset(): void {
        streaming = null;
        turns = [];
        totalOutputTokens = 0;
        totalElapsedMs = 0;
    }

    function showFinalStatus(ctx: StatusCtx): void {
        if (turns.length === 0) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
            return;
        }

        const lastTurn = turns[turns.length - 1];
        const last = formatTps(lastTurn.outputTokens, lastTurn.elapsedMs);
        const avg = formatTps(totalOutputTokens, totalElapsedMs);

        if (turns.length === 1) {
            ctx.ui.setStatus(STATUS_KEY, last);
        } else {
            ctx.ui.setStatus(STATUS_KEY, `${last} (avg ${avg})`);
        }
    }

    function showStreamingStatus(ctx: StatusCtx): void {
        if (!streaming) return;

        const elapsedMs = Date.now() - streaming.startTime;
        const hasProviderUsage = streaming.lastUsageOutput > 0;
        const tokens = hasProviderUsage
            ? streaming.lastUsageOutput
            : streaming.deltaCount;
        const prefix = hasProviderUsage ? "" : "~";

        if (tokens <= 0 || elapsedMs <= 0) {
            ctx.ui.setStatus(STATUS_KEY, "streaming...");
            return;
        }

        ctx.ui.setStatus(STATUS_KEY, `${prefix}${formatTps(tokens, elapsedMs)}`);
    }

    pi.on("session_start", async () => {
        reset();
    });

    pi.on("session_switch", async () => {
        reset();
    });

    pi.on("message_start", async (event) => {
        if (event.message.role === "assistant") {
            streaming = {
                startTime: Date.now(),
                deltaCount: 0,
                lastUsageOutput: 0,
                lastUpdateTime: 0,
            };
        }
    });

    pi.on("message_update", async (event, ctx) => {
        if (event.message.role !== "assistant" || !streaming) {
            return;
        }

        const streamEvent = event.assistantMessageEvent;

        if (isDeltaEvent(streamEvent)) {
            streaming.deltaCount++;
        }

        const partial = event.message as AssistantMessage;
        if (partial.usage?.output > 0) {
            streaming.lastUsageOutput = partial.usage.output;
        }

        const now = Date.now();
        if (now - streaming.lastUpdateTime >= UPDATE_INTERVAL_MS) {
            streaming.lastUpdateTime = now;
            showStreamingStatus(ctx);
        }
    });

    pi.on("message_end", async (event, ctx) => {
        if (event.message.role !== "assistant" || !streaming) {
            return;
        }

        const elapsedMs = Date.now() - streaming.startTime;
        streaming = null;

        const msg = event.message as AssistantMessage;
        const outputTokens = msg.usage?.output ?? 0;

        if (outputTokens === 0) return;

        const metrics: TurnMetrics = { outputTokens, elapsedMs };
        turns.push(metrics);
        totalOutputTokens += outputTokens;
        totalElapsedMs += elapsedMs;

        showFinalStatus(ctx);
    });

    pi.on("agent_end", async (_event, ctx) => {
        streaming = null;
        showFinalStatus(ctx);
    });

    pi.registerCommand("tps", {
        description: "Show token throughput statistics for the current session",
        handler: async (_args, ctx) => {
            if (turns.length === 0) {
                ctx.ui.notify(
                    "No LLM responses recorded in this session yet.",
                    "info",
                );
                return;
            }

            const lines: string[] = [
                `Session TPS Summary (${turns.length} response${turns.length === 1 ? "" : "s"})`,
                "\u2500".repeat(50),
            ];

            for (let i = 0; i < turns.length; i++) {
                lines.push(formatSummaryLine(`  Response ${i + 1}`, turns[i]));
            }

            lines.push("\u2500".repeat(50));
            lines.push(
                formatSummaryLine("  Average", {
                    outputTokens: totalOutputTokens,
                    elapsedMs: totalElapsedMs,
                }),
            );
            lines.push(`  Total output tokens: ${totalOutputTokens}`);
            lines.push(`  Total LLM time: ${(totalElapsedMs / 1000).toFixed(1)}s`);

            ctx.ui.notify(lines.join("\n"), "info");
        },
    });
}
