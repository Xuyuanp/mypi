import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Reports tokens-per-second based on generation time only.
 * Tracks across the full agent chain: retries, auto-compaction retries,
 * and queued follow-ups are accumulated until agent_settled.
 *
 * Generation time is measured as the sum of (message_start -> message_end)
 * intervals for assistant messages, excluding tool execution time that
 * occurs between message_end and the next turn_start.
 */
interface RunState {
    agentStartMs: number;
    generationMs: number;
    generationStartMs: number | null;
    turns: number;
    toolCalls: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    parentCost: number;
    subagentCost: number;
}

function createRunState(): RunState {
    return {
        agentStartMs: Date.now(),
        generationMs: 0,
        generationStartMs: null,
        turns: 0,
        toolCalls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        parentCost: 0,
        subagentCost: 0,
    };
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
        if (event.message.role === "assistant") {
            s.generationStartMs = Date.now();
        }
    });

    pi.on("message_end", (event) => {
        if (event.message.role !== "assistant" || s.generationStartMs === null)
            return;
        s.generationMs += Date.now() - s.generationStartMs;
        s.generationStartMs = null;
        const msg = event.message as AssistantMessage;
        s.input += msg.usage.input;
        s.output += msg.usage.output;
        s.cacheRead += msg.usage.cacheRead;
        s.cacheWrite += msg.usage.cacheWrite;
        s.totalTokens += msg.usage.totalTokens;
        s.parentCost += msg.usage.cost.total;
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
        const wallSeconds = (Date.now() - s.agentStartMs) / 1000;
        if (s.generationMs <= 0) return;
        if (s.output <= 0) return;

        const genSeconds = s.generationMs / 1000;
        const tokensPerSecond = s.output / genSeconds;
        const promptTokens = s.input + s.cacheRead + s.cacheWrite;
        const hasCacheActivity = s.cacheRead > 0 || s.cacheWrite > 0;
        // Activity
        const activityParts: string[] = [];
        if (s.turns) activityParts.push(`${s.turns} turn${s.turns > 1 ? "s" : ""}`);
        if (s.toolCalls)
            activityParts.push(`${s.toolCalls} tool${s.toolCalls > 1 ? "s" : ""}`);

        // Tokens
        const tokenParts: string[] = [
            `\u2191${formatTokens(s.input)}`,
            `\u2193${formatTokens(s.output)}`,
            `R${formatTokens(s.cacheRead)}`,
            `W${formatTokens(s.cacheWrite)}`,
        ];
        if (hasCacheActivity && promptTokens > 0) {
            tokenParts.push(`CH${((s.cacheRead / promptTokens) * 100).toFixed(1)}%`);
        }

        // Cost
        let cost = "";
        if (s.parentCost > 0 || s.subagentCost > 0) {
            cost = `$${s.parentCost.toFixed(4)}`;
            if (s.subagentCost > 0) {
                cost += `(+$${s.subagentCost.toFixed(4)})`;
            }
        }

        // Assemble
        const segments: string[] = [
            `TPS ${tokensPerSecond.toFixed(1)} tok/s`,
            activityParts.join(" "),
            tokenParts.join(" "),
        ];
        if (cost) segments.push(cost);
        segments.push(`${wallSeconds.toFixed(1)}s`);
        const message = segments.join(" | ");
        ctx.ui.notify(message, "info");
    });
}
