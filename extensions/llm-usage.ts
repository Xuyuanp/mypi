/**
 * Quota Usage Extension
 *
 * Fetches LLM budget usage from the company AI gateway on each turn_end
 * and displays usage percentage and dollars in the footer status bar.
 *
 * Requires env var: LLM_BRIDGE_API_KEY
 */

import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";

const KEY_INFO_URL = "https://llm-bridge.tigerbrokers.net/key/info";
const STATUS_KEY = "quota-usage";

interface KeyInfoResponse {
    info: {
        spend: number;
        max_budget: number;
    };
}

async function fetchUsage(
    apiKey: string,
): Promise<{ spend: number; maxBudget: number }> {
    const response = await fetch(KEY_INFO_URL, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Key info API returned ${response.status}`);
    }

    const data = (await response.json()) as KeyInfoResponse;
    return { spend: data.info.spend, maxBudget: data.info.max_budget };
}

function formatStatus(
    usage: { spend: number; maxBudget: number },
    theme: { fg: (color: ThemeColor, text: string) => string },
): string {
    const label = theme.fg("dim", "Quota:");

    if (usage.maxBudget <= 0) {
        return `${label}${theme.fg("dim", " N/A")}`;
    }

    const pctNum = (usage.spend / usage.maxBudget) * 100;
    const percent = pctNum.toFixed(1);

    const color = pctNum > 100 ? "error" : pctNum >= 90 ? "warning" : "success";

    const pct = theme.fg(color, `${percent}%`);
    const dollars = theme.fg(
        "dim",
        `($${usage.spend.toFixed(0)}/$${usage.maxBudget.toFixed(0)})`,
    );

    return `${label} ${pct}${dollars}`;
}

export default function (pi: ExtensionAPI) {
    const enabled = process.env.PI_TIGER_LLM_QUOTA;
    if (!enabled || enabled === "0" || enabled === "false") return;
    async function updateUsage(ctx: {
        hasUI: boolean;
        ui: {
            setStatus: (key: string, value: string | undefined) => void;
            theme: { fg: (color: ThemeColor, text: string) => string };
        };
    }): Promise<void> {
        if (!ctx.hasUI) return;
        const apiKey = process.env.LLM_BRIDGE_API_KEY;
        if (!apiKey) return;

        try {
            const usage = await fetchUsage(apiKey);
            ctx.ui.setStatus(STATUS_KEY, formatStatus(usage, ctx.ui.theme));
        } catch {
            ctx.ui.setStatus(
                STATUS_KEY,
                ctx.ui.theme.fg("error", "Quota: fetch failed"),
            );
        }
    }

    pi.on("session_start", async (_event, ctx) => {
        await updateUsage(ctx);
    });
    pi.on("turn_end", async (_event, ctx) => {
        await updateUsage(ctx);
    });
}
