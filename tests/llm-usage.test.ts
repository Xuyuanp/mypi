/**
 * Tests for the llm-usage provider renderers: provider payload →
 * colored usage string. Network fetching is out of scope; both render
 * functions take the payload and a fake theme.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type {
    DeepseekBalanceResponse,
    OpencodeUsageResponse,
    Theme,
} from "../extensions/llm-usage.js";
import {
    renderDeepseekBalance,
    renderOpencodeUsage,
} from "../extensions/llm-usage.js";

// Fixed reference time so reset countdowns are deterministic.
const NOW = new Date("2026-08-12T12:00:00Z").getTime();

const theme: Theme = {
    fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
};

describe("renderDeepseekBalance", () => {
    const base: DeepseekBalanceResponse = {
        is_available: true,
        balance_infos: [
            {
                currency: "CNY",
                total_balance: "12.34",
                granted_balance: "0",
                topped_up_balance: "12.34",
            },
        ],
    };

    it("renders a CNY balance in green when available", () => {
        expect(renderDeepseekBalance(base, theme)).toBe("<success>¥12.34</success>");
    });

    it("renders a USD balance with a dollar sign", () => {
        const usd: DeepseekBalanceResponse = {
            ...base,
            balance_infos: [
                {
                    currency: "USD",
                    total_balance: "5.00",
                    granted_balance: "0",
                    topped_up_balance: "5.00",
                },
            ],
        };
        expect(renderDeepseekBalance(usd, theme)).toBe("<success>$5.00</success>");
    });

    it("renders in warning color when the account is unavailable", () => {
        expect(renderDeepseekBalance({ ...base, is_available: false }, theme)).toBe(
            "<warning>¥12.34</warning>",
        );
    });

    it("throws when balance_infos is empty", () => {
        expect(() =>
            renderDeepseekBalance({ ...base, balance_infos: [] }, theme),
        ).toThrow("balance_infos is empty");
    });
});

describe("renderOpencodeUsage", () => {
    it("shows windows >= 1% sorted by percent desc", () => {
        const payload: OpencodeUsageResponse = {
            usage: {
                rolling: {
                    status: "ok",
                    percent: 0,
                    resetsAt: "2026-08-12T08:50:21Z",
                },
                weekly: {
                    status: "ok",
                    percent: 15,
                    resetsAt: "2026-08-17T00:00:00Z",
                },
                monthly: {
                    status: "ok",
                    percent: 13,
                    resetsAt: "2026-09-03T03:53:46Z",
                },
            },
        };

        expect(renderOpencodeUsage(payload.usage, theme, NOW)).toBe(
            "<success>W15%</success> <success>M13%</success>",
        );
    });

    it("drops windows below 1% and rounds percent", () => {
        const payload: OpencodeUsageResponse = {
            usage: {
                rolling: { status: "ok", percent: 0.5 },
                weekly: { status: "ok", percent: 1 },
                monthly: { status: "ok", percent: 15.6 },
            },
        };

        expect(renderOpencodeUsage(payload.usage, theme, NOW)).toBe(
            "<success>M16%</success> <success>W1%</success>",
        );
    });

    it("breaks percent ties by soonest reset", () => {
        const payload: OpencodeUsageResponse = {
            usage: {
                weekly: {
                    status: "ok",
                    percent: 50,
                    resetsAt: "2026-08-17T00:00:00Z",
                },
                monthly: {
                    status: "ok",
                    percent: 50,
                    resetsAt: "2026-09-03T03:53:46Z",
                },
            },
        };

        expect(renderOpencodeUsage(payload.usage, theme, NOW)).toBe(
            "<success>W50%</success> <success>M50%</success>",
        );
    });

    it("renders zero usage for missing or empty payloads", () => {
        expect(renderOpencodeUsage(undefined, theme, NOW)).toBe(
            "<success>0%</success>",
        );
        expect(
            renderOpencodeUsage(
                { rolling: { status: "ok", percent: 0 } },
                theme,
                NOW,
            ),
        ).toBe("<success>0%</success>");
    });

    it("grades by percent threshold (69/70/89/90)", () => {
        const at = (percent: number) =>
            renderOpencodeUsage({ weekly: { status: "ok", percent } }, theme, NOW);

        expect(at(69)).toBe("<success>W69%</success>");
        expect(at(70)).toBe("<warning>W70%</warning>");
        expect(at(89)).toBe("<warning>W89%</warning>");
        expect(at(90)).toBe("<error>W90%</error>");
        expect(at(94)).toBe("<error>W94%</error>");
    });

    it("lets a non-ok status override the percent threshold", () => {
        expect(
            renderOpencodeUsage(
                { weekly: { status: "warning", percent: 60 } },
                theme,
                NOW,
            ),
        ).toBe("<warning>W60%</warning>");

        expect(
            renderOpencodeUsage(
                { weekly: { status: "error", percent: 5 } },
                theme,
                NOW,
            ),
        ).toBe("<error>W5%</error>");

        expect(
            renderOpencodeUsage(
                { weekly: { status: "exceeded", percent: 5 } },
                theme,
                NOW,
            ),
        ).toBe("<error>W5%</error>");
    });

    it("appends a dim countdown to stressed windows", () => {
        const stress: OpencodeUsageResponse = {
            usage: {
                rolling: {
                    status: "ok",
                    percent: 0,
                    resetsAt: "2026-08-12T08:50:21Z",
                },
                weekly: {
                    status: "warning",
                    percent: 82,
                    resetsAt: "2026-08-17T00:00:00Z",
                },
                monthly: {
                    status: "ok",
                    percent: 94,
                    resetsAt: "2026-09-03T03:53:46Z",
                },
            },
        };

        expect(renderOpencodeUsage(stress.usage, theme, NOW)).toBe(
            "<error>M94%</error> <dim>~22d</dim> " +
                "<warning>W82%</warning> <dim>~5d</dim>",
        );
    });

    it("formats countdowns in hours and minutes for sub-day resets", () => {
        const at = (resetsAt: string) =>
            renderOpencodeUsage(
                { weekly: { status: "ok", percent: 80, resetsAt } },
                theme,
                NOW,
            );

        expect(at("2026-08-12T15:00:00Z")).toBe(
            "<warning>W80%</warning> <dim>~3h</dim>",
        );
        expect(at("2026-08-12T12:45:00Z")).toBe(
            "<warning>W80%</warning> <dim>~45m</dim>",
        );
    });

    it("clamps a past resetsAt to ~0m", () => {
        expect(
            renderOpencodeUsage(
                {
                    weekly: {
                        status: "ok",
                        percent: 80,
                        resetsAt: "2026-08-12T11:00:00Z",
                    },
                },
                theme,
                NOW,
            ),
        ).toBe("<warning>W80%</warning> <dim>~0m</dim>");
    });

    it("omits the countdown when resetsAt is missing", () => {
        expect(
            renderOpencodeUsage(
                { monthly: { status: "ok", percent: 95 } },
                theme,
                NOW,
            ),
        ).toBe("<error>M95%</error>");
    });

    it("does not add a countdown to healthy windows", () => {
        expect(
            renderOpencodeUsage(
                {
                    weekly: {
                        status: "ok",
                        percent: 15,
                        resetsAt: "2026-08-17T00:00:00Z",
                    },
                },
                theme,
                NOW,
            ),
        ).toBe("<success>W15%</success>");
    });
});
