/**
 * HTML rendering. The document shell lives in template.html; the data-driven
 * fragments are built here. renderInsightsHtml fills the slots and returns a
 * complete, self-contained page.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DonutSegment, donutSvg, gaugeSvg, timelineChart } from "./charts.js";
import {
    escapeHtml,
    formatDuration,
    formatPercent,
    formatTokens,
    formatUsd,
    truncate,
} from "./format.js";
import { PALETTE } from "./theme.js";
import type { SessionInsights } from "./types.js";

const ASSET_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(ASSET_DIR, "template.html"), "utf8");

function fillTemplate(values: Record<string, string>): string {
    return TEMPLATE.replace(
        /\{\{([A-Z0-9_]+)\}\}/g,
        (_, key: string) => values[key] ?? "",
    );
}

function statCard(
    label: string,
    value: string,
    unit: string,
    sub: string,
    accent: string,
): string {
    return [
        `<div class="card kpi" style="--accent:${accent}">`,
        `<div class="kpi-label">${escapeHtml(label)}</div>`,
        `<div class="kpi-value">${escapeHtml(value)}<span class="kpi-unit">${escapeHtml(unit)}</span></div>`,
        `<div class="kpi-sub">${sub}</div>`,
        `</div>`,
    ].join("");
}

function compositionBar(insights: SessionInsights): string {
    const parts = [
        { label: "input", value: insights.tokens.input, color: PALETTE.input },
        { label: "output", value: insights.tokens.output, color: PALETTE.output },
        {
            label: "cache read",
            value: insights.tokens.cacheRead,
            color: PALETTE.cacheRead,
        },
        {
            label: "cache write",
            value: insights.tokens.cacheWrite,
            color: PALETTE.cacheWrite,
        },
    ];
    const total = Math.max(
        1,
        parts.reduce((sum, part) => sum + part.value, 0),
    );
    const segments = parts
        .filter((part) => part.value > 0)
        .map(
            (part) =>
                `<div class="seg" style="width:${((part.value / total) * 100).toFixed(2)}%;background:${part.color}"><title>${escapeHtml(part.label)}: ${formatTokens(part.value)}</title></div>`,
        )
        .join("");
    const legend = parts
        .map(
            (part) =>
                `<div class="legend-item"><span class="dot" style="background:${part.color}"></span>${escapeHtml(part.label)}<b>${formatTokens(part.value)}</b></div>`,
        )
        .join("");
    return `<div class="stack">${segments}</div><div class="legend">${legend}</div>`;
}

function modelsTable(insights: SessionInsights): string {
    if (insights.models.length === 0) {
        return `<p class="empty">No model usage recorded yet.</p>`;
    }
    const maxCost = Math.max(
        0.000001,
        ...insights.models.map((model) => model.cost),
    );
    const rows = insights.models
        .map((model) => {
            const share = (model.cost / maxCost) * 100;
            return [
                `<tr>`,
                `<td><div class="model-name">${escapeHtml(model.key)}</div></td>`,
                `<td class="num">${model.turns}</td>`,
                `<td class="num">${formatTokens(model.tokens.input)}</td>`,
                `<td class="num">${formatTokens(model.tokens.output)}</td>`,
                `<td class="num">${formatTokens(model.tokens.cacheRead)}</td>`,
                `<td class="num strong">${formatUsd(model.cost)}</td>`,
                `<td class="bar-cell"><div class="mini-bar"><span style="width:${share.toFixed(1)}%"></span></div></td>`,
                `</tr>`,
            ].join("");
        })
        .join("");
    return [
        `<table class="table">`,
        `<thead><tr><th>Model</th><th class="num">Turns</th><th class="num">In</th><th class="num">Out</th><th class="num">Cache R</th><th class="num">Cost</th><th>Share</th></tr></thead>`,
        `<tbody>${rows}</tbody>`,
        `</table>`,
    ].join("");
}

function toolsList(insights: SessionInsights): string {
    if (insights.tools.length === 0) {
        return `<p class="empty">No tool calls recorded yet.</p>`;
    }
    const maxCalls = Math.max(1, ...insights.tools.map((tool) => tool.calls));
    const items = insights.tools
        .map((tool) => {
            const width = (tool.calls / maxCalls) * 100;
            const errorBadge = tool.errors
                ? `<span class="badge bad">${tool.errors} err</span>`
                : "";
            const duration = tool.durationMs
                ? `<span class="muted">${formatDuration(tool.durationMs)}</span>`
                : `<span class="muted">${formatTokens(tool.resultBytes)}B out</span>`;
            return [
                `<div class="tool-row">`,
                `<div class="tool-head"><span class="tool-name">${escapeHtml(tool.name)}</span><span class="tool-meta">${duration}${errorBadge}</span></div>`,
                `<div class="track"><span style="width:${width.toFixed(1)}%"></span></div>`,
                `<div class="tool-count">${tool.calls} call${tool.calls === 1 ? "" : "s"}</div>`,
                `</div>`,
            ].join("");
        })
        .join("");
    return `<div class="tools">${items}</div>`;
}

function errorsList(insights: SessionInsights): string {
    if (insights.errorItems.length === 0) {
        return `<p class="empty good-empty">No errors recorded — clean run. ✓</p>`;
    }
    const items = insights.errorItems
        .map((item) => {
            const when = item.timestamp
                ? new Date(item.timestamp).toLocaleTimeString()
                : "";
            const badge =
                item.kind === "tool"
                    ? `<span class="badge bad">tool</span>`
                    : `<span class="badge warn">model</span>`;
            return [
                `<li class="error-item">`,
                `<div class="error-top">${badge}<span class="error-label">${escapeHtml(item.label)}</span><span class="error-time">${escapeHtml(when)}</span></div>`,
                `<div class="error-msg">${escapeHtml(truncate(item.message, 220))}</div>`,
                `</li>`,
            ].join("");
        })
        .join("");
    return `<ul class="errors">${items}</ul>`;
}

function contextCard(insights: SessionInsights): string {
    const context = insights.context;
    if (!context || context.tokens === null) {
        return `<p class="empty">Context usage unavailable.</p>`;
    }
    const fraction =
        context.percent !== null
            ? context.percent / 100
            : context.contextWindow > 0
              ? context.tokens / context.contextWindow
              : 0;
    return gaugeSvg(
        fraction,
        "context used",
        `~${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)} tokens`,
        fraction > 0.85 ? PALETTE.cacheWrite : PALETTE.input,
        150,
    );
}
export function renderInsightsHtml(insights: SessionInsights): string {
    const costSegments: DonutSegment[] = [
        { label: "input", value: insights.cost.input, color: PALETTE.input },
        { label: "output", value: insights.cost.output, color: PALETTE.output },
        {
            label: "cache read",
            value: insights.cost.cacheRead,
            color: PALETTE.cacheRead,
        },
        {
            label: "cache write",
            value: insights.cost.cacheWrite,
            color: PALETTE.cacheWrite,
        },
    ];
    const donutTotal = costSegments.reduce((sum, s) => sum + s.value, 0);
    const donut =
        donutTotal > 0
            ? donutSvg(costSegments, 190, formatUsd)
            : `<p class="empty">Cost data unavailable.</p>`;
    const donutLegend = costSegments
        .map(
            (segment) =>
                `<div class="legend-item"><span class="dot" style="background:${segment.color}"></span>${escapeHtml(segment.label)}<b>${formatUsd(segment.value)}</b></div>`,
        )
        .join("");

    const tpsLabel = insights.tps > 0 ? insights.tps.toFixed(1) : "0.0";
    const tpsSub = insights.ttftAvgMs
        ? `TTFT ${formatDuration(insights.ttftAvgMs)}`
        : "TTFT n/a";
    const tokensSub = `↑${formatTokens(insights.tokens.input)} in · ↓${formatTokens(insights.tokens.output)} out · R${formatTokens(insights.tokens.cacheRead)}`;
    const costSub = `cache ${formatUsd(insights.cost.cacheRead + insights.cost.cacheWrite)} · ${formatUsd(insights.cost.total / Math.max(1, insights.assistantTurns))}/turn`;
    const turnsSub = `${insights.userTurns} prompt${insights.userTurns === 1 ? "" : "s"} · ${insights.assistantTurns} assistant`;
    const toolsSub =
        insights.toolErrors > 0
            ? `${insights.toolErrors} failed · ${insights.toolResults} results`
            : `${insights.toolResults} results · all ok`;
    const errorSub = `${insights.errors} total · ${insights.assistantErrors} model`;

    const startedLabel = insights.startedAt
        ? new Date(insights.startedAt).toLocaleString()
        : "—";
    const generatedLabel = new Date(insights.generatedAt).toLocaleString();
    const thinking = insights.thinkingLevels.length
        ? insights.thinkingLevels.join(" → ")
        : "off";

    const kpiCards = [
        statCard(
            "Total cost",
            formatUsd(insights.cost.total).replace("$", ""),
            "USD",
            costSub,
            PALETTE.input,
        ),
        statCard(
            "Total tokens",
            formatTokens(insights.tokens.total),
            "",
            tokensSub,
            PALETTE.output,
        ),
        statCard("Throughput", tpsLabel, "tok/s", tpsSub, PALETTE.reasoning),
        statCard(
            "Turns",
            String(insights.assistantTurns),
            "",
            turnsSub,
            PALETTE.cacheRead,
        ),
        statCard(
            "Tool calls",
            String(insights.toolCalls),
            "",
            toolsSub,
            PALETTE.cacheWrite,
        ),
        statCard(
            "Tool error rate",
            formatPercent(insights.errorRate),
            "",
            errorSub,
            PALETTE.bad,
        ),
    ].join("\n    ");

    return fillTemplate({
        TITLE: escapeHtml(insights.sessionName ?? insights.sessionId),
        MODEL_BADGE: escapeHtml(insights.primaryModel),
        THINKING: escapeHtml(thinking),
        ASSISTANT_TURNS: String(insights.assistantTurns),
        SESSION_LABEL: escapeHtml(
            insights.sessionName ?? insights.sessionId.slice(0, 8),
        ),
        GENERATED_LABEL: escapeHtml(generatedLabel),
        STARTED_LABEL: escapeHtml(startedLabel),
        CWD: escapeHtml(insights.cwd),
        SESSION_FILE: escapeHtml(insights.sessionFile ?? "ephemeral"),
        WALL_LABEL: `${formatDuration(insights.wallMs)} · active ${formatDuration(insights.activeMs)}`,
        KPI_CARDS: kpiCards,
        DONUT: donut,
        DONUT_LEGEND: donutLegend,
        COMPOSITION_BAR: compositionBar(insights),
        GAUGE_CACHE: gaugeSvg(
            insights.cacheHitRate,
            "cache hit",
            `${formatTokens(insights.tokens.cacheRead)} read tokens`,
            PALETTE.cacheRead,
        ),
        GAUGE_REASONING: gaugeSvg(
            Math.min(
                1,
                insights.tokens.reasoning / Math.max(1, insights.tokens.output),
            ),
            "reasoning",
            `${formatTokens(insights.tokens.reasoning)} thinking tokens`,
            PALETTE.reasoning,
        ),
        GAUGE_CONTEXT: contextCard(insights),
        MODELS_TABLE: modelsTable(insights),
        TOOLS_LIST: toolsList(insights),
        TIMELINE: timelineChart(insights),
        ERROR_COUNT: String(insights.errors),
        ERRORS_LIST: errorsList(insights),
        COMPACTIONS: String(insights.compactions),
        ASSISTANT_ERRORS: String(insights.assistantErrors),
        REASONING_TOKENS: formatTokens(insights.tokens.reasoning),
    });
}
