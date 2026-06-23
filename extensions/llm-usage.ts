/**
 * Multi-provider usage fetcher.
 *
 * Displays the current session model provider's usage/balance in the
 * footer status bar. Uses a fetcher registry keyed by provider name —
 * adding a new provider means appending one entry to
 * `BALANCE_FETCHERS`.
 *
 * DeepSeek is the first (and only) provider in this version.
 * - Endpoint: GET https://api.deepseek.com/user/balance
 * - Auth: Authorization: Bearer ${apiKey}
 */

import type {
    ExtensionAPI,
    ExtensionContext,
    ThemeColor,
} from "@earendil-works/pi-coding-agent";

// --- Types ---

interface BalanceResult {
    text: string;
    status: "ok" | "warning";
}

interface DeepseekBalanceResponse {
    is_available: boolean;
    balance_infos: Array<{
        currency: "CNY" | "USD";
        total_balance: string;
        granted_balance: string;
        topped_up_balance: string;
    }>;
}

interface BalanceFetcherDef {
    label: string;
    getBalance(apiKey: string): Promise<BalanceResult>;
}

// --- Constants ---

const STATUS_KEY = "provider-usage";

const BALANCE_FETCHERS: Record<string, BalanceFetcherDef> = {
    deepseek: { label: "DS", getBalance: getDeepseekBalance },
};

// --- DeepSeek fetcher ---

async function getDeepseekBalance(apiKey: string): Promise<BalanceResult> {
    const response = await fetch("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
        throw new Error(`DeepSeek balance API returned ${response.status}`);
    }

    const data = (await response.json()) as DeepseekBalanceResponse;

    const first = data.balance_infos?.[0];
    if (!first) {
        throw new Error("DeepSeek balance_infos is empty");
    }

    const symbol = first.currency === "USD" ? "$" : "¥";

    return {
        text: `${symbol}${first.total_balance}`,
        status: data.is_available ? "ok" : "warning",
    };
}

// --- Status bar formatting ---

function formatUsage(
    text: string,
    status: "ok" | "warning",
    theme: {
        fg: (color: ThemeColor, text: string) => string;
    },
): string {
    const color = status === "ok" ? "success" : "warning";
    return theme.fg(color, text);
}

// --- Update logic ---

async function updateUsage(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;

    const model = ctx.model;
    if (!model) return;

    const fetcherDef = BALANCE_FETCHERS[model.provider];
    if (!fetcherDef) return;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return;

    const label = fetcherDef.label;

    try {
        const result = await fetcherDef.getBalance(auth.apiKey ?? "");
        const text = `${label} ${result.text}`;
        ctx.ui.setStatus(STATUS_KEY, formatUsage(text, result.status, ctx.ui.theme));
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
    pi.on("turn_end", async (_event, ctx) => {
        await updateUsage(ctx);
    });
}
