/**
 * TPS (Tokens Per Second) Extension
 *
 * Tracks output token throughput for each LLM response in the current
 * session and displays the metric in the footer status bar.
 *
 * Metrics shown (footer status):
 *   - Last response TPS (output tokens / response wall-clock time)
 *   - Session average TPS (total output tokens / total LLM time)
 *
 * Timing is measured from message_start to message_end for assistant
 * messages only, excluding tool execution time.
 *
 * Provides a `/tps` command that shows a detailed summary of session
 * token throughput statistics.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "tps";

interface TurnMetrics {
    outputTokens: number;
    elapsedMs: number;
}

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

export default function (pi: ExtensionAPI) {
    let messageStartTime: number | null = null;
    let turns: TurnMetrics[] = [];
    let totalOutputTokens = 0;
    let totalElapsedMs = 0;
    function reset(): void {
        messageStartTime = null;
        turns = [];
        totalOutputTokens = 0;
        totalElapsedMs = 0;
    }

    function updateStatus(ctx: {
        ui: { setStatus(key: string, text: string | undefined): void };
    }): void {
        if (turns.length === 0) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
            return;
        }

        const last = formatTps(
            turns[turns.length - 1].outputTokens,
            turns[turns.length - 1].elapsedMs,
        );
        const avg = formatTps(totalOutputTokens, totalElapsedMs);

        if (turns.length === 1) {
            ctx.ui.setStatus(STATUS_KEY, last);
        } else {
            ctx.ui.setStatus(STATUS_KEY, `${last} (avg ${avg})`);
        }
    }

    pi.on("session_start", async () => {
        reset();
    });

    pi.on("session_switch", async () => {
        reset();
    });

    pi.on("message_start", async (event) => {
        if (event.message.role === "assistant") {
            messageStartTime = Date.now();
        }
    });

    pi.on("message_end", async (event, ctx) => {
        if (event.message.role !== "assistant" || messageStartTime === null) {
            return;
        }

        const elapsedMs = Date.now() - messageStartTime;
        messageStartTime = null;

        const msg = event.message as AssistantMessage;
        const outputTokens = msg.usage?.output ?? 0;

        if (outputTokens === 0) return;

        const metrics: TurnMetrics = { outputTokens, elapsedMs };
        turns.push(metrics);
        totalOutputTokens += outputTokens;
        totalElapsedMs += elapsedMs;

        updateStatus(ctx);
    });

    pi.on("agent_end", async (_event, ctx) => {
        updateStatus(ctx);
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
                "─".repeat(50),
            ];

            for (let i = 0; i < turns.length; i++) {
                lines.push(formatSummaryLine(`  Response ${i + 1}`, turns[i]));
            }

            lines.push("─".repeat(50));
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
