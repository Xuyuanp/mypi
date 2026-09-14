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
    shouldRefreshUsage,
} from "../extensions/llm-usage.js";

// Reset times are offsets from the current time, so the tests hold at
// any run time. `now` is injected, so each delta stays exact.
const NOW = Date.now();
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const resetIn = (ms: number) => new Date(NOW + ms).toISOString();

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

describe("shouldRefreshUsage", () => {
    it("refreshes on every 10th turn", () => {
        expect(shouldRefreshUsage(10)).toBe(true);
        expect(shouldRefreshUsage(20)).toBe(true);
        expect(shouldRefreshUsage(30)).toBe(true);
    });

    it("does not refresh between refreshes", () => {
        expect(shouldRefreshUsage(1)).toBe(false);
        expect(shouldRefreshUsage(9)).toBe(false);
        expect(shouldRefreshUsage(11)).toBe(false);
        expect(shouldRefreshUsage(19)).toBe(false);
    });

    it("does not refresh at or below zero", () => {
        expect(shouldRefreshUsage(0)).toBe(false);
        expect(shouldRefreshUsage(-10)).toBe(false);
    });
});

describe("renderOpencodeUsage", () => {
    it("shows windows >= 1% in rolling/weekly/monthly order", () => {
        const payload: OpencodeUsageResponse = {
            usage: {
                rolling: { status: "ok", percent: 10 },
                weekly: { status: "ok", percent: 15 },
                monthly: { status: "ok", percent: 20 },
            },
        };

        expect(renderOpencodeUsage(payload.usage, theme, NOW)).toBe(
            "<success>R10%</success> <success>W15%</success> <success>M20%</success>",
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
            "<success>W1%</success> <success>M16%</success>",
        );
    });

    it("keeps RWM order even when percent ranks differ", () => {
        const payload: OpencodeUsageResponse = {
            usage: {
                rolling: { status: "ok", percent: 95 },
                weekly: { status: "ok", percent: 50 },
                monthly: { status: "ok", percent: 5 },
            },
        };

        expect(renderOpencodeUsage(payload.usage, theme, NOW)).toBe(
            "<error>R95%</error> <success>W50%</success> <success>M5%</success>",
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

    it("keeps a stressed window with percent below 1", () => {
        expect(
            renderOpencodeUsage(
                { weekly: { status: "exceeded", percent: 0 } },
                theme,
                NOW,
            ),
        ).toBe("<error>W0%</error>");
    });

    it("keeps a stressed window with no percent", () => {
        expect(
            renderOpencodeUsage({ weekly: { status: "exceeded" } }, theme, NOW),
        ).toBe("<error>W0%</error>");
    });

    it("shows a stressed window next to a healthy empty one", () => {
        expect(
            renderOpencodeUsage(
                {
                    rolling: { status: "ok", percent: 0.4 },
                    weekly: { status: "exceeded", percent: 0 },
                },
                theme,
                NOW,
            ),
        ).toBe("<error>W0%</error>");
    });

    it("treats a NaN percent as zero", () => {
        expect(
            renderOpencodeUsage(
                { weekly: { status: "ok", percent: Number.NaN } },
                theme,
                NOW,
            ),
        ).toBe("<success>0%</success>");
        expect(
            renderOpencodeUsage(
                { weekly: { status: "error", percent: Number.NaN } },
                theme,
                NOW,
            ),
        ).toBe("<error>W0%</error>");
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
                    resetsAt: resetIn(-HOUR_MS),
                },
                weekly: {
                    status: "warning",
                    percent: 82,
                    resetsAt: resetIn(5 * DAY_MS),
                },
                monthly: {
                    status: "ok",
                    percent: 94,
                    resetsAt: resetIn(22 * DAY_MS),
                },
            },
        };

        expect(renderOpencodeUsage(stress.usage, theme, NOW)).toBe(
            "<warning>W82%</warning> <dim>~5d</dim> " +
                "<error>M94%</error> <dim>~22d</dim>",
        );
    });

    it("formats countdowns in hours and minutes for sub-day resets", () => {
        const at = (resetsAt: string) =>
            renderOpencodeUsage(
                { weekly: { status: "ok", percent: 80, resetsAt } },
                theme,
                NOW,
            );

        expect(at(resetIn(3 * HOUR_MS))).toBe(
            "<warning>W80%</warning> <dim>~3h</dim>",
        );
        expect(at(resetIn(45 * MINUTE_MS))).toBe(
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
                        resetsAt: resetIn(-HOUR_MS),
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

    it("omits the countdown when resetsAt is invalid", () => {
        expect(
            renderOpencodeUsage(
                {
                    weekly: {
                        status: "warning",
                        percent: 80,
                        resetsAt: "not-a-date",
                    },
                },
                theme,
                NOW,
            ),
        ).toBe("<warning>W80%</warning>");
    });

    it("does not add a countdown to healthy windows", () => {
        expect(
            renderOpencodeUsage(
                {
                    weekly: {
                        status: "ok",
                        percent: 15,
                        resetsAt: resetIn(5 * DAY_MS),
                    },
                },
                theme,
                NOW,
            ),
        ).toBe("<success>W15%</success>");
    });
});

describe("renderOpencodeUsage time pressure", () => {
    const ok = (ms: number) => ({
        status: "ok",
        percent: 10,
        resetsAt: resetIn(ms),
    });

    it("shows a countdown under 40% of a 5h rolling window", () => {
        expect(renderOpencodeUsage({ rolling: ok(HOUR_MS) }, theme, NOW)).toBe(
            "<success>R10%</success> <dim>~1h</dim>",
        );
    });

    it("hides the countdown above 40% of the rolling window", () => {
        expect(renderOpencodeUsage({ rolling: ok(3 * HOUR_MS) }, theme, NOW)).toBe(
            "<success>R10%</success>",
        );
    });

    it("hides the countdown at exactly 40% of the rolling window", () => {
        expect(renderOpencodeUsage({ rolling: ok(2 * HOUR_MS) }, theme, NOW)).toBe(
            "<success>R10%</success>",
        );
    });

    it("uses a 7d window for weekly", () => {
        expect(renderOpencodeUsage({ weekly: ok(2 * DAY_MS) }, theme, NOW)).toBe(
            "<success>W10%</success> <dim>~2d</dim>",
        );
        expect(renderOpencodeUsage({ weekly: ok(3 * DAY_MS) }, theme, NOW)).toBe(
            "<success>W10%</success>",
        );
    });

    it("uses a 30d window for monthly", () => {
        expect(renderOpencodeUsage({ monthly: ok(10 * DAY_MS) }, theme, NOW)).toBe(
            "<success>M10%</success> <dim>~10d</dim>",
        );
        expect(renderOpencodeUsage({ monthly: ok(13 * DAY_MS) }, theme, NOW)).toBe(
            "<success>M10%</success>",
        );
    });

    it("still shows a countdown for a stressed window far from its reset", () => {
        expect(
            renderOpencodeUsage(
                {
                    weekly: {
                        status: "warning",
                        percent: 82,
                        resetsAt: resetIn(5 * DAY_MS),
                    },
                },
                theme,
                NOW,
            ),
        ).toBe("<warning>W82%</warning> <dim>~5d</dim>");
    });
});
