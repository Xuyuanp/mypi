/**
 * LLM Bridge Usage Extension
 *
 * Fetches token usage from the company AI gateway on each turn_end
 * and displays the usage percentage in the footer status bar.
 *
 * Requires env var: LLM_BRIDGE_API_KEY
 */

import type { ExtensionAPI, ThemeColor } from "@mariozechner/pi-coding-agent";

const USAGE_URL = "https://llm-bridge.tigerbrokers.net/usage";
const STATUS_KEY = "llm-usage";

interface UsageResponse {
    usage_percent: number;
    has_budget: boolean;
}

async function fetchUsage(apiKey: string): Promise<UsageResponse> {
    const response = await fetch(USAGE_URL, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Usage API returned ${response.status}`);
    }

    return response.json() as Promise<UsageResponse>;
}

function formatStatus(
    usage: UsageResponse,
    theme: { fg: (color: ThemeColor, text: string) => string },
): string {
    const percent = usage.usage_percent.toFixed(1);
    const color = !usage.has_budget
        ? "error"
        : usage.usage_percent >= 90
          ? "warning"
          : "success";

    const label = theme.fg("dim", "LLM:");
    const value = theme.fg(color, `${percent}%`);
    const budget = !usage.has_budget ? theme.fg("error", " (no budget)") : "";

    return `${label}${value}${budget}`;
}

export default function (pi: ExtensionAPI) {
    async function updateUsage(ctx: {
        ui: {
            setStatus: (key: string, value: string | undefined) => void;
            theme: { fg: (color: ThemeColor, text: string) => string };
        };
    }): Promise<void> {
        const apiKey = process.env.LLM_BRIDGE_API_KEY;
        if (!apiKey) return;

        try {
            const usage = await fetchUsage(apiKey);
            ctx.ui.setStatus(STATUS_KEY, formatStatus(usage, ctx.ui.theme));
        } catch {
            ctx.ui.setStatus(
                STATUS_KEY,
                ctx.ui.theme.fg("error", "LLM: fetch failed"),
            );
        }
    }

    pi.on("session_start", async (_event, ctx) => {
        if (!ctx.hasUI) return;
        await updateUsage(ctx);
    });

    pi.on("turn_end", async (_event, ctx) => {
        if (!ctx.hasUI) return;
        await updateUsage(ctx);
    });
}
