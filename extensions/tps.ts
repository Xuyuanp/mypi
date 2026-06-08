import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isAssistantMessage(message: unknown): message is AssistantMessage {
    if (!message || typeof message !== "object") return false;
    const role = (message as { role?: unknown }).role;
    return role === "assistant";
}

function getSubagentCost(message: unknown): number {
    if (!message || typeof message !== "object") return 0;
    const msg = message as { role?: string; toolName?: string; details?: unknown };
    if (msg.role !== "toolResult" || msg.toolName !== "subagent") return 0;
    const details = msg.details as
        | { result?: { usage?: { cost?: { total?: number } } } }
        | undefined;
    return details?.result?.usage?.cost?.total ?? 0;
}

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
export default function (pi: ExtensionAPI) {
    let generationMs = 0;
    let generationStartMs: number | null = null;

    pi.on("agent_start", () => {
        generationMs = 0;
        generationStartMs = null;
    });

    pi.on("message_start", (event) => {
        if (event.message.role === "assistant") {
            generationStartMs = Date.now();
        }
    });

    pi.on("message_end", (event) => {
        if (event.message.role === "assistant" && generationStartMs !== null) {
            generationMs += Date.now() - generationStartMs;
            generationStartMs = null;
        }
    });

    pi.on("agent_end", (event, ctx) => {
        if (!ctx.hasUI) return;
        if (generationMs <= 0) return;

        let input = 0;
        let output = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let totalTokens = 0;
        let parentCost = 0;
        let subagentCost = 0;

        for (const message of event.messages) {
            if (isAssistantMessage(message)) {
                input += message.usage.input;
                output += message.usage.output;
                cacheRead += message.usage.cacheRead;
                cacheWrite += message.usage.cacheWrite;
                totalTokens += message.usage.totalTokens;
                parentCost += message.usage.cost.total;
                continue;
            }
            subagentCost += getSubagentCost(message);
        }

        if (output <= 0) return;

        const elapsedSeconds = generationMs / 1000;
        const tokensPerSecond = output / elapsedSeconds;
        const promptTokens = input + cacheRead + cacheWrite;
        const hasCacheActivity = cacheRead > 0 || cacheWrite > 0;
        const hitRateSegment =
            hasCacheActivity && promptTokens > 0
                ? ` ${((cacheRead / promptTokens) * 100).toFixed(1)}%`
                : "";
        let costSegment = "";
        if (parentCost > 0 || subagentCost > 0) {
            costSegment = ` | $${parentCost.toFixed(4)}`;
            if (subagentCost > 0) {
                costSegment += `(+$${subagentCost.toFixed(4)})`;
            }
        }
        const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s | \u2191${formatTokens(input)} \u2193${formatTokens(output)} R${formatTokens(cacheRead)} W${formatTokens(cacheWrite)} total ${formatTokens(totalTokens)}${hitRateSegment}${costSegment} | ${elapsedSeconds.toFixed(1)}s`;
        ctx.ui.notify(message, "info");
    });
}
