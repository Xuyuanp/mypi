/**
 * /insights
 *
 * Builds a single-page HTML dashboard that summarizes the current session:
 * cost, tokens, throughput (tok/s), TTFT, turns, tool calls, error rate,
 * per-model and per-tool breakdowns, and a per-turn timeline.
 *
 * The dashboard is self-contained (inline CSS + inline SVG + one inline
 * script, no CDN, no network) so it renders offline and from a file:// URL.
 * The shell lives in template.html and the client script in timeline.js.
 *
 * Data source: the active branch of `ctx.sessionManager`. Live timing
 * (generation time, TTFT, per-tool wall time) is accumulated from agent events
 * during this process; for messages that predate the process the timing falls
 * back to an estimate from stored entry timestamps.
 *
 * Usage:
 *   /insights                 write to the temp dir and open in a browser
 *   /insights --no-open       write only, do not open
 *   /insights --out <path>    write to a specific file
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./format.js";
import { computeInsights } from "./insights.js";
import { renderInsightsHtml } from "./render.js";
import type { LiveTiming } from "./types.js";

async function openFile(pi: ExtensionAPI, filePath: string): Promise<boolean> {
    try {
        if (process.platform === "darwin") {
            const result = await pi.exec("open", [filePath], { timeout: 10_000 });
            return result.code === 0;
        }
        if (process.platform === "win32") {
            const result = await pi.exec("cmd", ["/c", "start", "", filePath], {
                timeout: 10_000,
            });
            return result.code === 0;
        }
        const result = await pi.exec("xdg-open", [filePath], { timeout: 10_000 });
        return result.code === 0;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function sessionInsightsExtension(pi: ExtensionAPI) {
    const live: LiveTiming = {
        generationMs: new Map(),
        ttftMs: new Map(),
        toolDurationMs: new Map(),
    };
    const toolStarts = new Map<string, number>();
    let pendingMessage: {
        startMs: number;
        firstTokenMs: number | null;
        timestamp: number;
    } | null = null;

    pi.on("session_start", (event) => {
        if (event.reason === "new") {
            live.generationMs.clear();
            live.ttftMs.clear();
            live.toolDurationMs.clear();
            toolStarts.clear();
            pendingMessage = null;
        }
    });

    pi.on("message_start", (event) => {
        if (event.message.role !== "assistant") return;
        pendingMessage = {
            startMs: Date.now(),
            firstTokenMs: null,
            timestamp: event.message.timestamp,
        };
    });

    pi.on("message_update", (event) => {
        const kind = event.assistantMessageEvent.type;
        if (kind !== "text_delta" && kind !== "thinking_delta") return;
        if (pendingMessage && pendingMessage.firstTokenMs === null) {
            pendingMessage.firstTokenMs = Date.now();
        }
    });

    pi.on("message_end", (event) => {
        if (event.message.role !== "assistant" || !pendingMessage) return;
        const timestamp = event.message.timestamp;
        const end = Date.now();
        live.generationMs.set(timestamp, end - pendingMessage.startMs);
        if (pendingMessage.firstTokenMs !== null) {
            live.ttftMs.set(
                timestamp,
                pendingMessage.firstTokenMs - pendingMessage.startMs,
            );
        }
        pendingMessage = null;
    });

    pi.on("tool_execution_start", (event) => {
        toolStarts.set(event.toolCallId, Date.now());
    });

    pi.on("tool_execution_end", (event) => {
        const start = toolStarts.get(event.toolCallId);
        if (start !== undefined) {
            live.toolDurationMs.set(event.toolCallId, Date.now() - start);
            toolStarts.delete(event.toolCallId);
        }
    });

    pi.registerCommand("insights", {
        description:
            "Generate a self-contained HTML dashboard of the current session (cost, tokens, tok/s, turns, tools, errors) and open it",
        handler: async (args, ctx: ExtensionCommandContext) => {
            const argv = args.trim().split(/\s+/).filter(Boolean);
            let shouldOpen = true;
            let outPath: string | undefined;
            for (let i = 0; i < argv.length; i++) {
                if (argv[i] === "--no-open") shouldOpen = false;
                else if (argv[i] === "--out") outPath = argv[++i];
            }

            const contextUsage = ctx.getContextUsage();
            const insights = computeInsights({
                entries: ctx.sessionManager.getBranch(),
                sessionId: ctx.sessionManager.getSessionId(),
                sessionName: ctx.sessionManager.getSessionName(),
                sessionFile: ctx.sessionManager.getSessionFile(),
                cwd: ctx.cwd,
                context: contextUsage
                    ? {
                          tokens: contextUsage.tokens,
                          contextWindow: contextUsage.contextWindow,
                          percent: contextUsage.percent,
                      }
                    : null,
                live,
            });

            const filePath =
                outPath ??
                join(
                    tmpdir(),
                    "pi-session-insights",
                    `insights-${insights.sessionId.slice(0, 8)}-${Date.now()}.html`,
                );

            try {
                await mkdir(dirname(filePath), { recursive: true });
                await writeFile(filePath, renderInsightsHtml(insights), "utf8");
            } catch (error) {
                ctx.ui.notify(
                    `Failed to write insights: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
                return;
            }

            const opened = shouldOpen ? await openFile(pi, filePath) : false;
            const summary = `$${insights.cost.total.toFixed(4)} · ${formatTokens(insights.tokens.total)} tok · ${insights.assistantTurns} turns · ${insights.toolCalls} tools`;
            ctx.ui.notify(
                `${summary} → ${filePath}${shouldOpen && !opened ? " (open manually)" : ""}`,
                "info",
            );
        },
    });
}
