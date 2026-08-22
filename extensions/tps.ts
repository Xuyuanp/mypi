import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Reports tokens-per-second and average time-to-first-token (TTFT).
 * Tracks across the full agent chain: retries, auto-compaction retries,
 * and queued follow-ups are accumulated until agent_settled.
 *
 * Generation time is measured as the sum of (message_start -> message_end)
 * intervals for assistant messages, excluding tool execution time that
 * occurs between message_end and the next turn_start.
 *
 * TTFT is measured per assistant message as the interval from message_start
 * to the first streamed content delta (text or thinking). The report shows
 * the mean of all samples collected during the run.
 */
interface RunState {
    agentStartMs: number;
    generationMs: number;
    generationStartMs: number | null;

    /** Wall-clock start of the assistant message currently streaming. */
    messageStartMs: number | null;
    /** TTFT samples in ms; one sample per assistant message that streamed. */
    ttftSamples: number[];

    turns: number;
    toolCalls: number;
    usage: Usage;

    subagentCost: number;
}

function createRunState(): RunState {
    return {
        agentStartMs: Date.now(),
        generationMs: 0,
        generationStartMs: null,
        messageStartMs: null,
        ttftSamples: [],
        turns: 0,
        toolCalls: 0,
        subagentCost: 0,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
            cacheWrite1h: 0,
            reasoning: 0,
        },
    };
}

function sumUsage(target: Usage, source: Usage): void {
    target.input += source.input;
    target.output += source.output;
    target.cacheRead += source.cacheRead;
    target.cacheWrite += source.cacheWrite;
    target.totalTokens += source.totalTokens;
    target.cost.input += source.cost.input;
    target.cost.output += source.cost.output;
    target.cost.cacheRead += source.cost.cacheRead;
    target.cost.cacheWrite += source.cost.cacheWrite;
    target.cost.total += source.cost.total;
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + (source.cacheWrite1h ?? 0);
    target.reasoning = (target.reasoning ?? 0) + (source.reasoning ?? 0);
}

function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}

function formatLatency(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

/** Capture a TTFT sample from the first streamed delta of a message. */
function recordFirstToken(s: RunState): void {
    if (s.messageStartMs === null) return;
    s.ttftSamples.push(Date.now() - s.messageStartMs);
    s.messageStartMs = null;
}

/** Build the settled-run report line, or null when there is nothing to show. */
function buildSettledReport(s: RunState): string | null {
    if (s.generationMs <= 0 || s.usage.output <= 0) return null;

    const wallSeconds = (Date.now() - s.agentStartMs) / 1000;
    const genSeconds = s.generationMs / 1000;
    const promptTokens = s.usage.input + s.usage.cacheRead + s.usage.cacheWrite;
    const hasCacheActivity = s.usage.cacheRead > 0 || s.usage.cacheWrite > 0;

    // Activity
    const activityParts: string[] = [];
    if (s.turns) {
        activityParts.push(`${s.turns} turn${s.turns > 1 ? "s" : ""}`);
    }
    if (s.toolCalls) {
        activityParts.push(`${s.toolCalls} tool${s.toolCalls > 1 ? "s" : ""}`);
    }

    // Tokens
    const tokenParts: string[] = [
        `\u2191${formatTokens(s.usage.input)}`,
        `\u2193${formatTokens(s.usage.output)}`,
    ];
    if (s.usage.cacheRead > 0) {
        tokenParts.push(`R${formatTokens(s.usage.cacheRead)}`);
    }
    if (s.usage.cacheWrite > 0) {
        tokenParts.push(`W${formatTokens(s.usage.cacheWrite)}`);
    }
    if (hasCacheActivity && promptTokens > 0) {
        tokenParts.push(
            `CH${((s.usage.cacheRead / promptTokens) * 100).toFixed(1)}%`,
        );
    }

    // Cost
    let cost = "";
    if (s.usage.cost.total > 0 || s.subagentCost > 0) {
        cost = `$${s.usage.cost.total.toFixed(4)}`;
        if (s.subagentCost > 0) {
            cost += `(+$${s.subagentCost.toFixed(4)})`;
        }
    }

    // Latency: TPS + average TTFT
    const latencyParts = [`TPS ${(s.usage.output / genSeconds).toFixed(1)} tok/s`];
    if (s.ttftSamples.length > 0) {
        const ttftAvg =
            s.ttftSamples.reduce((a, b) => a + b, 0) / s.ttftSamples.length;
        latencyParts.push(`TTFT ${formatLatency(ttftAvg)}`);
    }

    // Assemble
    const segments: string[] = [
        latencyParts.join(" | "),
        activityParts.join(" "),
        tokenParts.join(" "),
    ];
    if (cost) segments.push(cost);
    segments.push(`${wallSeconds.toFixed(1)}s`);
    return segments.join(" | ");
}

const STATUS_KEY = "tps-timer";

export default function (pi: ExtensionAPI) {
    let s = createRunState();
    let running = false;
    let timerInterval: ReturnType<typeof setInterval> | null = null;

    pi.on("agent_start", (_event, ctx) => {
        if (!running) {
            s = createRunState();
            running = true;
        }
        if (ctx.mode !== "tui") return;
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            const elapsed = ((Date.now() - s.agentStartMs) / 1000).toFixed(1);
            ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${elapsed}s`));
        }, 100);
    });

    pi.on("message_start", (event) => {
        if (event.message.role !== "assistant") return;
        s.messageStartMs = Date.now();
        s.generationStartMs = Date.now();
    });

    pi.on("message_update", (event) => {
        const delta = event.assistantMessageEvent.type;
        if (delta !== "text_delta" && delta !== "thinking_delta") return;
        recordFirstToken(s);
    });

    pi.on("message_end", (event) => {
        if (event.message.role !== "assistant" || s.generationStartMs === null)
            return;
        s.generationMs += Date.now() - s.generationStartMs;
        s.generationStartMs = null;
        s.messageStartMs = null;
        const msg = event.message as AssistantMessage;
        sumUsage(s.usage, msg.usage);
    });

    pi.on("turn_end", () => {
        s.turns++;
    });

    pi.on("tool_result", (event) => {
        s.toolCalls++;
        const details = event.details as
            | { result?: { usage?: { cost?: { total?: number } } } }
            | undefined;
        s.subagentCost += details?.result?.usage?.cost?.total ?? 0;
    });

    pi.on("agent_settled", (_event, ctx) => {
        running = false;
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        if (!ctx.hasUI) return;
        const message = buildSettledReport(s);
        if (!message) return;
        ctx.ui.notify(message, "info");
    });
}
