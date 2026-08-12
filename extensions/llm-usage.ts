/**
 * Multi-provider usage fetcher.
 *
 * Displays the current session model provider's usage/balance in the
 * footer status bar. Each provider renders its own usage string; the
 * extension shows a dim provider label followed by that string.
 *
 * Providers:
 * - deepseek: money balance. GET https://api.deepseek.com/user/balance
 * - opencode-go: quota percent across rolling/weekly/monthly windows.
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Windows under pressure (>= 70% or non-ok status) also show the
 *   time until their reset.
 *
 * Auth for both: Authorization: Bearer ${apiKey}
 */

import type {
    ExtensionAPI,
    ExtensionContext,
    ThemeColor,
} from "@earendil-works/pi-coding-agent";

// --- Types ---

type UsageLevel = "ok" | "warning" | "error";

export interface Theme {
    fg: (color: ThemeColor, text: string) => string;
}

export interface DeepseekBalanceResponse {
    is_available: boolean;
    balance_infos: Array<{
        currency: "CNY" | "USD";
        total_balance: string;
        granted_balance: string;
        topped_up_balance: string;
    }>;
}

export interface OpencodeUsageResponse {
    usage?: {
        rolling?: OpencodeUsageWindow;
        weekly?: OpencodeUsageWindow;
        monthly?: OpencodeUsageWindow;
    };
}

interface OpencodeUsageWindow {
    status?: string;
    percent?: number;
    resetsAt?: string;
}

interface ProviderFetcher {
    label: string;
    renderUsage(apiKey: string, theme: Theme): Promise<string>;
}

// --- Constants ---

const STATUS_KEY = "provider-usage";

const OPENCODE_WINDOWS = [
    { key: "rolling", letter: "R" },
    { key: "weekly", letter: "W" },
    { key: "monthly", letter: "M" },
] as const;

const USAGE_FETCHERS: Record<string, ProviderFetcher> = {
    deepseek: { label: "DS", renderUsage: fetchDeepseekUsage },
    "opencode-go": { label: "OCG", renderUsage: fetchOpencodeUsage },
};

const WARNING_PERCENT = 70;
const ERROR_PERCENT = 90;

const LEVEL_COLORS: Record<UsageLevel, ThemeColor> = {
    ok: "success",
    warning: "warning",
    error: "error",
};

// --- Shared helpers ---

async function getJson(url: string, apiKey: string): Promise<unknown> {
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
    }

    return response.json();
}

// --- DeepSeek fetcher ---

export function renderDeepseekBalance(
    data: DeepseekBalanceResponse,
    theme: Theme,
): string {
    const first = data.balance_infos?.[0];
    if (!first) {
        throw new Error("DeepSeek balance_infos is empty");
    }

    const symbol = first.currency === "USD" ? "$" : "¥";
    const color = LEVEL_COLORS[data.is_available ? "ok" : "warning"];
    return theme.fg(color, `${symbol}${first.total_balance}`);
}

async function fetchDeepseekUsage(apiKey: string, theme: Theme): Promise<string> {
    const data = (await getJson(
        "https://api.deepseek.com/user/balance",
        apiKey,
    )) as DeepseekBalanceResponse;
    return renderDeepseekBalance(data, theme);
}

// --- OpenCode Go fetcher ---

function levelForWindow(window: OpencodeUsageWindow): UsageLevel {
    if (window.status && window.status !== "ok") {
        return window.status === "warning" ? "warning" : "error";
    }
    const percent = window.percent ?? 0;
    if (percent >= ERROR_PERCENT) return "error";
    if (percent >= WARNING_PERCENT) return "warning";
    return "ok";
}

function resetsAtMs(window: OpencodeUsageWindow): number {
    if (!window.resetsAt) return Number.MAX_SAFE_INTEGER;
    return new Date(window.resetsAt).getTime();
}

function formatReset(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 60) return `~${minutes}m`;
    const hours = Math.round(ms / 3600000);
    if (hours < 24) return `~${hours}h`;
    return `~${Math.round(ms / 86400000)}d`;
}

/**
 * Renders a usage payload into the colored usage string: drops windows
 * below 1%, sorts by percent desc (soonest reset breaks ties), colors
 * each window, and appends a dim reset countdown to stressed windows.
 * Pure — `now` is injected for deterministic tests.
 */
export function renderOpencodeUsage(
    usage: OpencodeUsageResponse["usage"],
    theme: Theme,
    now: number = Date.now(),
): string {
    const shown: Array<{ letter: string; window: OpencodeUsageWindow }> = [];
    for (const def of OPENCODE_WINDOWS) {
        const window = usage?.[def.key];
        if (window && (window.percent ?? 0) >= 1) {
            shown.push({ letter: def.letter, window });
        }
    }

    if (shown.length === 0) {
        return theme.fg("success", "0%");
    }

    shown.sort(
        (a, b) =>
            (b.window.percent ?? 0) - (a.window.percent ?? 0) ||
            resetsAtMs(a.window) - resetsAtMs(b.window),
    );

    const parts: string[] = [];
    for (const { letter, window } of shown) {
        const level = levelForWindow(window);
        parts.push(
            theme.fg(
                LEVEL_COLORS[level],
                `${letter}${Math.round(window.percent ?? 0)}%`,
            ),
        );
        if (level !== "ok" && window.resetsAt) {
            parts.push(theme.fg("dim", formatReset(resetsAtMs(window) - now)));
        }
    }
    return parts.join(" ");
}

async function fetchOpencodeUsage(apiKey: string, theme: Theme): Promise<string> {
    const data = (await getJson(
        "https://opencode.ai/zen/go/v1/usage",
        apiKey,
    )) as OpencodeUsageResponse;
    return renderOpencodeUsage(data.usage, theme, Date.now());
}

// --- Update logic ---

async function updateUsage(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;

    const model = ctx.model;
    if (!model) return;

    const fetcher = USAGE_FETCHERS[model.provider];
    if (!fetcher) return;

    const label = fetcher.label;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return;

    // getApiKeyAndHeaders doesn't fall back to env vars (includeFallback: false),
    // so resolve the key separately if missing.
    const apiKey =
        auth.apiKey ??
        (await ctx.modelRegistry.getApiKeyForProvider(model.provider));

    if (!apiKey) {
        ctx.ui.setStatus(
            STATUS_KEY,
            ctx.ui.theme.fg("error", `${label} no API key`),
        );
        return;
    }

    try {
        const rendered = await fetcher.renderUsage(apiKey, ctx.ui.theme);
        ctx.ui.setStatus(STATUS_KEY, `${ctx.ui.theme.fg("dim", label)} ${rendered}`);
    } catch {
        ctx.ui.setStatus(
            STATUS_KEY,
            ctx.ui.theme.fg("error", `${label} fetch failed`),
        );
    }
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        await updateUsage(ctx);
    });
    pi.on("agent_end", async (_event, ctx) => {
        await updateUsage(ctx);
    });
    pi.on("model_select", async (event, ctx) => {
        // Same provider shows the same usage; skip the network call.
        if (event.previousModel?.provider === event.model.provider) return;
        await updateUsage(ctx);
    });
}
