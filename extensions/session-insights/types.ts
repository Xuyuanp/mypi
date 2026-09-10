/**
 * Shared shapes for the session-insights extension. These are structural
 * subsets of the session entry types, so the computation stays decoupled from
 * the pi runtime and can be driven from stored JSONL or from tests.
 */

export interface UsageLike {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    totalTokens?: number;
    cost?:
        | number
        | {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              total?: number;
          };
}

export interface MessageLike {
    role?: string;
    provider?: string;
    model?: string;
    content?: unknown;
    usage?: UsageLike;
    stopReason?: string;
    errorMessage?: string;
    timestamp?: number;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
}

export interface EntryLike {
    type?: string;
    timestamp?: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    usage?: UsageLike;
    message?: MessageLike;
}

export interface TokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
}

export interface CostTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

export interface ToolStat {
    name: string;
    calls: number;
    errors: number;
    durationMs: number;
    resultBytes: number;
}

export interface ModelStat {
    key: string;
    provider: string;
    model: string;
    turns: number;
    tokens: TokenTotals;
    cost: number;
}

export interface TurnPoint {
    index: number;
    timestamp: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    cost: number;
    cumulativeCost: number;
    durationMs: number;
    tps: number;
    ttftMs: number | null;
    toolCalls: number;
    toolNames: string[];
    provider: string;
    model: string;
    stopReason: string;
    /** Number of original turns folded into this point (timeline bucketing). */
    bucket?: number;
}

export interface ErrorItem {
    kind: "tool" | "assistant";
    label: string;
    message: string;
    timestamp: number;
}

export interface ContextInfo {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}

export interface SessionInsights {
    sessionId: string;
    sessionName?: string;
    sessionFile?: string;
    cwd: string;
    startedAt: number | null;
    endedAt: number | null;
    wallMs: number;
    activeMs: number;
    models: ModelStat[];
    primaryModel: string;
    thinkingLevels: string[];
    userTurns: number;
    assistantTurns: number;
    toolCalls: number;
    toolResults: number;
    toolErrors: number;
    assistantErrors: number;
    errors: number;
    errorRate: number;
    compactions: number;
    tokens: TokenTotals;
    cost: CostTotals;
    cacheHitRate: number;
    tps: number;
    tpsEstimated: boolean;
    ttftAvgMs: number | null;
    tools: ToolStat[];
    turns: TurnPoint[];
    errorItems: ErrorItem[];
    context: ContextInfo | null;
    generatedAt: number;
}

export interface LiveTiming {
    generationMs: Map<number, number>;
    ttftMs: Map<number, number>;
    toolDurationMs: Map<string, number>;
}

export interface InsightsInput {
    entries: readonly EntryLike[];
    sessionId: string;
    sessionName?: string;
    sessionFile?: string;
    cwd: string;
    context?: ContextInfo | null;
    live?: LiveTiming;
    now?: number;
}
