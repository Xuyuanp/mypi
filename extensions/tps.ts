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
 *
 * Generation time is measured as the sum of (message_start -> message_end)
 * intervals for assistant messages, excluding tool execution time that
 * occurs between message_end and the next turn_start.
 */
interface TurnState {
    agentStartMs: number;
    generationMs: number;
    generationStartMs: number | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    parentCost: number;
    subagentCost: number;
}

function createTurnState(): TurnState {
    return {
        agentStartMs: Date.now(),
        generationMs: 0,
        generationStartMs: null,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        parentCost: 0,
        subagentCost: 0,
    };
}

export default function (pi: ExtensionAPI) {
    let s = createTurnState();

    pi.on("agent_start", () => {
        s = createTurnState();
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

    pi.on("tool_result", (event) => {
        if (event.toolName !== "subagent") return;
        const details = event.details as
            | { result?: { usage?: { cost?: { total?: number } } } }
            | undefined;
        s.subagentCost += details?.result?.usage?.cost?.total ?? 0;
    });

    pi.on("agent_end", (_event, ctx) => {
        if (!ctx.hasUI) return;
        if (s.generationMs <= 0) return;
        if (s.output <= 0) return;

        const genSeconds = s.generationMs / 1000;
        const tokensPerSecond = s.output / genSeconds;
        const wallSeconds = (Date.now() - s.agentStartMs) / 1000;
        const promptTokens = s.input + s.cacheRead + s.cacheWrite;
        const hasCacheActivity = s.cacheRead > 0 || s.cacheWrite > 0;
        const hitRateSegment =
            hasCacheActivity && promptTokens > 0
                ? ` CH${((s.cacheRead / promptTokens) * 100).toFixed(0)}%`
                : "";
        let costSegment = "";
        if (s.parentCost > 0 || s.subagentCost > 0) {
            costSegment = ` | $${s.parentCost.toFixed(4)}`;
            if (s.subagentCost > 0) {
                costSegment += `(+$${s.subagentCost.toFixed(4)})`;
            }
        }
        const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s | \u2191${formatTokens(s.input)} \u2193${formatTokens(s.output)} R${formatTokens(s.cacheRead)} W${formatTokens(s.cacheWrite)}${hitRateSegment} total ${formatTokens(s.totalTokens)}${costSegment} | ${wallSeconds.toFixed(1)}s`;
        ctx.ui.notify(message, "info");
    });
}
