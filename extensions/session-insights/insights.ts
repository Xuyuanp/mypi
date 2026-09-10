/**
 * Insight computation. Pure: it reads a list of session entries and returns
 * an aggregated summary. No pi runtime types are imported.
 */

import { num, truncate } from "./format.js";
import type {
    CostTotals,
    ErrorItem,
    InsightsInput,
    ModelStat,
    SessionInsights,
    TokenTotals,
    ToolStat,
    TurnPoint,
    UsageLike,
} from "./types.js";

const EMPTY_TOKENS = (): TokenTotals => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
});

const EMPTY_COST = (): CostTotals => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
});

function usageCost(usage: UsageLike | undefined): CostTotals {
    const out = EMPTY_COST();
    if (!usage) return out;
    const raw = usage.cost;
    if (typeof raw === "number") {
        out.total = num(raw);
        return out;
    }
    if (raw && typeof raw === "object") {
        out.input = num(raw.input);
        out.output = num(raw.output);
        out.cacheRead = num(raw.cacheRead);
        out.cacheWrite = num(raw.cacheWrite);
        out.total =
            num(raw.total) ||
            out.input + out.output + out.cacheRead + out.cacheWrite;
    }
    return out;
}

function usageTokens(usage: UsageLike | undefined): TokenTotals {
    const out = EMPTY_TOKENS();
    if (!usage) return out;
    out.input = num(usage.input);
    out.output = num(usage.output);
    out.cacheRead = num(usage.cacheRead);
    out.cacheWrite = num(usage.cacheWrite);
    out.reasoning = num(usage.reasoning);
    out.total =
        num(usage.totalTokens) ||
        out.input + out.output + out.cacheRead + out.cacheWrite;
    return out;
}

function addTokens(target: TokenTotals, source: TokenTotals): void {
    target.input += source.input;
    target.output += source.output;
    target.cacheRead += source.cacheRead;
    target.cacheWrite += source.cacheWrite;
    target.reasoning += source.reasoning;
    target.total += source.total;
}

function addCost(target: CostTotals, source: CostTotals): void {
    target.input += source.input;
    target.output += source.output;
    target.cacheRead += source.cacheRead;
    target.cacheWrite += source.cacheWrite;
    target.total += source.total;
}

function parseTimestamp(value: string | undefined): number | null {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function modelKey(provider: string, model: string): string {
    const safeProvider = provider.trim();
    const safeModel = model.trim();
    if (safeProvider && safeModel) return `${safeProvider}/${safeModel}`;
    return safeModel || safeProvider || "unknown";
}

function ensureModel(
    models: Map<string, ModelStat>,
    key: string,
    provider: string,
    model: string,
): ModelStat {
    const existing = models.get(key);
    if (existing) return existing;
    const created: ModelStat = {
        key,
        provider,
        model,
        turns: 0,
        tokens: EMPTY_TOKENS(),
        cost: 0,
    };
    models.set(key, created);
    return created;
}

function ensureTool(tools: Map<string, ToolStat>, name: string): ToolStat {
    const existing = tools.get(name);
    if (existing) return existing;
    const created: ToolStat = {
        name,
        calls: 0,
        errors: 0,
        durationMs: 0,
        resultBytes: 0,
    };
    tools.set(name, created);
    return created;
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
    return Array.isArray(content)
        ? (content.filter((block) => block && typeof block === "object") as Array<
              Record<string, unknown>
          >)
        : [];
}

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    return contentBlocks(content)
        .map((block) =>
            typeof block.text === "string"
                ? block.text
                : typeof block.thinking === "string"
                  ? block.thinking
                  : "",
        )
        .join("\n")
        .trim();
}

function contentBytes(content: unknown): number {
    return contentText(content).length;
}

// ---------------------------------------------------------------------------
// Insight computation (pure)
// ---------------------------------------------------------------------------

export function computeInsights(input: InsightsInput): SessionInsights {
    const entries = input.entries;
    const live = input.live;
    const now = input.now ?? Date.now();

    const tokens = EMPTY_TOKENS();
    const cost = EMPTY_COST();
    const models = new Map<string, ModelStat>();
    const tools = new Map<string, ToolStat>();
    const turns: TurnPoint[] = [];
    const errorItems: ErrorItem[] = [];
    const thinkingLevels: string[] = [];

    let userTurns = 0;
    let assistantTurns = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let toolErrors = 0;
    let assistantErrors = 0;
    let compactions = 0;
    let startedAt: number | null = null;
    let endedAt: number | null = null;
    let generationMs = 0;
    let estimatedCount = 0;
    const ttftSamples: number[] = [];
    let currentProvider = "";
    let currentModel = "";
    let prevTs: number | null = null;

    const touch = (ts: number): void => {
        if (!Number.isFinite(ts) || ts <= 0) return;
        if (startedAt === null || ts < startedAt) startedAt = ts;
        if (endedAt === null || ts > endedAt) endedAt = ts;
    };

    for (const entry of entries) {
        const entryTs = parseTimestamp(entry.timestamp);
        if (entryTs !== null) touch(entryTs);
        const type = entry.type;

        if (type === "model_change") {
            currentProvider = entry.provider ?? "";
            currentModel = entry.modelId ?? "";
            ensureModel(
                models,
                modelKey(currentProvider, currentModel),
                currentProvider,
                currentModel,
            );
            continue;
        }

        if (type === "thinking_level_change") {
            const level = entry.thinkingLevel;
            if (level && !thinkingLevels.includes(level)) thinkingLevels.push(level);
            continue;
        }

        if (type === "compaction" || type === "branch_summary") {
            if (type === "compaction") compactions += 1;
            if (entry.usage) {
                const entryTokens = usageTokens(entry.usage);
                const entryCost = usageCost(entry.usage);
                addTokens(tokens, entryTokens);
                addCost(cost, entryCost);
                const stat = ensureModel(
                    models,
                    modelKey(currentProvider, currentModel),
                    currentProvider,
                    currentModel,
                );
                addTokens(stat.tokens, entryTokens);
                stat.cost += entryCost.total;
            }
            continue;
        }

        if (type !== "message") continue;
        const msg = entry.message;
        if (!msg) continue;
        // `message.timestamp` is the generation start; the entry ISO timestamp
        // is written when the entry is persisted (generation end). The delta is
        // therefore the real generation time for this assistant message.
        const startTs =
            typeof msg.timestamp === "number" ? msg.timestamp : (entryTs ?? 0);
        const endTs = entryTs ?? startTs;
        touch(endTs);

        if (msg.role === "user") {
            userTurns += 1;
            prevTs = endTs;
            continue;
        }

        if (msg.role === "assistant") {
            assistantTurns += 1;
            const provider = msg.provider ?? currentProvider;
            const model = msg.model ?? currentModel;
            const key = modelKey(provider, model);
            const stat = ensureModel(models, key, provider, model);
            stat.turns += 1;

            const turnTokens = usageTokens(msg.usage);
            const turnCost = usageCost(msg.usage);
            addTokens(tokens, turnTokens);
            addCost(cost, turnCost);
            addTokens(stat.tokens, turnTokens);
            stat.cost += turnCost.total;

            let turnToolCalls = 0;
            const turnToolNames: string[] = [];
            for (const block of contentBlocks(msg.content)) {
                if (block.type !== "toolCall") continue;
                const name = String(block.name ?? "unknown");
                toolCalls += 1;
                turnToolCalls += 1;
                turnToolNames.push(name);
                ensureTool(tools, name).calls += 1;
            }

            const stopReason = String(msg.stopReason ?? "");
            if (stopReason === "error" || stopReason === "aborted") {
                assistantErrors += 1;
                const errorLabel = modelKey(provider, model);
                errorItems.push({
                    kind: "assistant",
                    label: errorLabel === "unknown" ? "assistant" : errorLabel,
                    message: String(msg.errorMessage ?? stopReason),
                    timestamp: endTs,
                });
            }

            // Prefer live timing, then the stored start/end pair, then a
            // crude gap-to-previous-entry estimate as a last resort.
            let durationMs = live?.generationMs.get(startTs) ?? 0;
            const ttft = live?.ttftMs.get(startTs) ?? null;
            if (ttft !== null) ttftSamples.push(ttft);
            if (durationMs > 0) {
                generationMs += durationMs;
            } else if (endTs > startTs) {
                durationMs = endTs - startTs;
                generationMs += durationMs;
            } else if (prevTs !== null && endTs > prevTs) {
                durationMs = endTs - prevTs;
                generationMs += durationMs;
                estimatedCount += 1;
            }

            turns.push({
                index: assistantTurns,
                timestamp: endTs,
                inputTokens: turnTokens.input,
                outputTokens: turnTokens.output,
                cacheReadTokens: turnTokens.cacheRead,
                cacheWriteTokens: turnTokens.cacheWrite,
                totalTokens: turnTokens.total,
                cost: turnCost.total,
                cumulativeCost: 0,
                durationMs,
                tps: durationMs > 0 ? turnTokens.output / (durationMs / 1000) : 0,
                ttftMs: ttft,
                toolCalls: turnToolCalls,
                toolNames: turnToolNames,
                provider,
                model: model || "unknown",
                stopReason,
            });
            prevTs = endTs;
            continue;
        }

        if (msg.role === "toolResult") {
            toolResults += 1;
            const name = String(msg.toolName ?? "unknown");
            const stat = ensureTool(tools, name);
            stat.resultBytes += contentBytes(msg.content);
            const duration = live?.toolDurationMs.get(String(msg.toolCallId)) ?? 0;
            stat.durationMs += duration;
            if (msg.isError) {
                toolErrors += 1;
                errorItems.push({
                    kind: "tool",
                    label: name,
                    message: truncate(
                        contentText(msg.content) || "tool failed",
                        240,
                    ),
                    timestamp: endTs,
                });
            }
            if (msg.usage) {
                const nestedTokens = usageTokens(msg.usage);
                const nestedCost = usageCost(msg.usage);
                addTokens(tokens, nestedTokens);
                addCost(cost, nestedCost);
                const nested = ensureModel(
                    models,
                    "tool · nested calls",
                    "",
                    "tool · nested calls",
                );
                addTokens(nested.tokens, nestedTokens);
                nested.cost += nestedCost.total;
            }
            prevTs = endTs;
            continue;
        }

        prevTs = endTs;
    }

    turns.sort((a, b) => a.timestamp - b.timestamp);
    let cumulative = 0;
    for (const turn of turns) {
        cumulative += turn.cost;
        turn.cumulativeCost = cumulative;
    }

    const wallMs =
        startedAt !== null && endedAt !== null
            ? Math.max(0, endedAt - startedAt)
            : 0;
    const tps = generationMs > 0 ? tokens.output / (generationMs / 1000) : 0;
    const cacheable = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    const cacheHitRate = cacheable > 0 ? tokens.cacheRead / cacheable : 0;
    const ttftAvgMs =
        ttftSamples.length > 0
            ? ttftSamples.reduce((a, b) => a + b, 0) / ttftSamples.length
            : null;
    const sortedModels = [...models.values()].sort(
        (a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total,
    );

    return {
        sessionId: input.sessionId,
        sessionName: input.sessionName,
        sessionFile: input.sessionFile,
        cwd: input.cwd,
        startedAt,
        endedAt,
        wallMs,
        activeMs: generationMs,
        models: sortedModels,
        primaryModel:
            sortedModels.find((m) => m.provider)?.key ||
            sortedModels[0]?.key ||
            "unknown",
        thinkingLevels,
        userTurns,
        assistantTurns,
        toolCalls,
        toolResults,
        toolErrors,
        assistantErrors,
        errors: toolErrors + assistantErrors,
        errorRate: toolCalls > 0 ? toolErrors / toolCalls : 0,
        compactions,
        tokens,
        cost,
        cacheHitRate,
        tps,
        tpsEstimated: estimatedCount > 0,
        ttftAvgMs,
        tools: [...tools.values()].sort(
            (a, b) => b.calls - a.calls || b.durationMs - a.durationMs,
        ),
        turns,
        errorItems: errorItems.slice(-40).reverse(),
        context: input.context ?? null,
        generatedAt: now,
    };
}
