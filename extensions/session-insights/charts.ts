/**
 * SVG chart builders. Each returns an HTML string with an inline <svg>.
 * Geometry comes from TIMELINE in theme.ts; the client script in timeline.js
 * mirrors the same numbers.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, formatTokens, formatUsd } from "./format.js";
import { PALETTE, TIMELINE } from "./theme.js";
import type { SessionInsights, TurnPoint } from "./types.js";

const ASSET_DIR = dirname(fileURLToPath(import.meta.url));

/** Client-side timeline enhancement, inlined into the generated dashboard. */
const TIMELINE_SCRIPT = readFileSync(
    join(ASSET_DIR, "timeline.js"),
    "utf8",
).trimEnd();

export interface DonutSegment {
    label: string;
    value: number;
    color: string;
}

export function donutSvg(
    segments: DonutSegment[],
    size = 190,
    format: (value: number) => string = formatTokens,
): string {
    const thickness = 24;
    const radius = (size - thickness) / 2;
    const center = size / 2;
    const circumference = 2 * Math.PI * radius;
    const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);

    const rings: string[] = [
        `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="${thickness}"/>`,
    ];
    let offset = 0;
    for (const segment of segments) {
        const value = Math.max(0, segment.value);
        if (value <= 0 || total <= 0) continue;
        const length = (value / total) * circumference;
        const gap = Math.max(0, circumference - length - 2);
        rings.push(
            `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="${thickness}" stroke-dasharray="${length.toFixed(2)} ${gap.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${center} ${center})"><title>${escapeHtml(segment.label)}: ${format(value)}</title></circle>`,
        );
        offset += length + 2;
    }

    return `<svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">${rings.join("")}</svg>`;
}

export function gaugeSvg(
    fraction: number,
    label: string,
    sublabel: string,
    color: string,
    size = 150,
): string {
    const thickness = 12;
    const radius = (size - thickness) / 2;
    const center = size / 2;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(1, fraction));
    const filled = circumference * clamped;
    const pct = Math.round(clamped * 100);

    return [
        `<svg class="gauge" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">`,
        `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="${thickness}"/>`,
        `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${color}" stroke-width="${thickness}" stroke-linecap="round" stroke-dasharray="${filled.toFixed(2)} ${(circumference - filled).toFixed(2)}" transform="rotate(-90 ${center} ${center})"/>`,
        `<text x="${center}" y="${center - 2}" class="gauge-value" text-anchor="middle">${pct}%</text>`,
        `<text x="${center}" y="${center + 20}" class="gauge-cap" text-anchor="middle">${escapeHtml(label)}</text>`,
        `</svg>`,
        `<div class="gauge-sub">${escapeHtml(sublabel)}</div>`,
    ].join("");
}

function bucketTurns(turns: TurnPoint[], maxBuckets: number): TurnPoint[] {
    if (turns.length <= maxBuckets) return turns;
    const size = Math.ceil(turns.length / maxBuckets);
    const out: TurnPoint[] = [];
    for (let i = 0; i < turns.length; i += size) {
        const slice = turns.slice(i, i + size);
        const sum = (pick: (turn: TurnPoint) => number): number =>
            slice.reduce((acc, turn) => acc + pick(turn), 0);
        const durationMs = sum((t) => t.durationMs);
        const outputTokens = sum((t) => t.outputTokens);
        out.push({
            index: slice[0].index,
            timestamp: slice[slice.length - 1].timestamp,
            inputTokens: sum((t) => t.inputTokens),
            outputTokens,
            cacheReadTokens: sum((t) => t.cacheReadTokens),
            cacheWriteTokens: sum((t) => t.cacheWriteTokens),
            totalTokens: sum((t) => t.totalTokens),
            cost: sum((t) => t.cost),
            cumulativeCost: 0,
            durationMs,
            tps: durationMs > 0 ? outputTokens / (durationMs / 1000) : 0,
            ttftMs: null,
            toolCalls: sum((t) => t.toolCalls),
            toolNames: [...new Set(slice.flatMap((t) => t.toolNames))],
            provider: slice[slice.length - 1].provider,
            model: slice[slice.length - 1].model,
            stopReason: slice.some((t) => t.stopReason === "error") ? "error" : "",
            bucket: slice.length,
        });
    }
    let cumulative = 0;
    for (const turn of out) {
        cumulative += turn.cost;
        turn.cumulativeCost = cumulative;
    }
    return out;
}

function timelineSvg(turns: TurnPoint[]): string {
    const g = TIMELINE;
    const innerW = g.width - g.padL - g.padR;
    const count = Math.max(1, turns.length);
    const slot = innerW / count;
    const barW = Math.max(3, Math.min(34, slot * 0.6));
    const xFor = (index: number): number =>
        g.padL + slot * index + (slot - barW) / 2;
    const maxTotal = Math.max(1, ...turns.map((t) => t.totalTokens));
    const maxCost = Math.max(0.000001, ...turns.map((t) => t.cost));
    const maxCum = Math.max(0.000001, ...turns.map((t) => t.cumulativeCost));

    const grid: string[] = [];
    for (let level = 0; level <= 4; level++) {
        const y = g.mainTop + (g.mainHeight / 4) * level;
        const value = maxCost * (1 - level / 4);
        grid.push(
            `<line x1="${g.padL}" y1="${y.toFixed(1)}" x2="${g.width - g.padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.06)"/>`,
            `<text x="${g.padL - 9}" y="${(y + 4).toFixed(1)}" class="axis ylab" data-l="${level}" text-anchor="end">${formatUsd(value)}</text>`,
        );
    }

    const groups: string[] = [];
    const toolBars: string[] = [];
    const cumPoints: string[] = [];

    turns.forEach((turn, index) => {
        const x = xFor(index);
        const segments = [
            { key: "input", value: turn.inputTokens, color: PALETTE.input },
            {
                key: "cacheRead",
                value: turn.cacheReadTokens,
                color: PALETTE.cacheRead,
            },
            { key: "output", value: turn.outputTokens, color: PALETTE.output },
            {
                key: "cacheWrite",
                value: turn.cacheWriteTokens,
                color: PALETTE.cacheWrite,
            },
        ];
        let cursor = g.mainBottom;
        const rects: string[] = [];
        for (const segment of segments) {
            const height = (segment.value / maxTotal) * g.mainHeight;
            if (height <= 0) continue;
            const y = cursor - height;
            rects.push(
                `<rect class="seg" data-k="${segment.key}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.6, height).toFixed(1)}" fill="${segment.color}"/>`,
            );
            cursor -= height;
        }
        const toolHeight =
            turn.toolCalls > 0 ? Math.min(g.toolHeight, 4 + turn.toolCalls * 4) : 2;
        toolBars.push(
            `<rect class="toolbar" data-i="${index}" x="${x.toFixed(1)}" y="${(g.toolTop + g.toolHeight - toolHeight).toFixed(1)}" width="${barW.toFixed(1)}" height="${toolHeight.toFixed(1)}" rx="2" fill="${turn.toolCalls > 0 ? PALETTE.tools : "rgba(255,255,255,.08)"}"/>`,
        );
        // Cost is the default view. The stacked token bars ship hidden, ready
        // for the Tokens tab to reveal.
        const costHeight = Math.max(
            turn.cost > 0 ? 2 : 0,
            (turn.cost / maxCost) * g.mainHeight,
        );
        cumPoints.push(
            `${(x + barW / 2).toFixed(1)},${(g.mainBottom - (turn.cumulativeCost / maxCum) * g.mainHeight * 0.94).toFixed(1)}`,
        );
        groups.push(
            `<g class="turn" data-i="${index}">`,
            `<g class="stacked" style="display:none">${rects.join("")}</g>`,
            `<rect class="solo" x="${x.toFixed(1)}" y="${(g.mainBottom - costHeight).toFixed(1)}" width="${barW.toFixed(1)}" height="${costHeight.toFixed(1)}" rx="2" fill="${turn.stopReason === "error" ? PALETTE.bad : "url(#costGradient)"}"/>`,
            turn.ttftMs !== null
                ? `<circle class="ttft" cx="${(x + barW / 2).toFixed(1)}" cy="${g.mainBottom}" r="2.6" fill="${PALETTE.output}" visibility="hidden"/>`
                : "",
            `<rect class="hit" data-i="${index}" x="${x.toFixed(1)}" y="${g.mainTop}" width="${barW.toFixed(1)}" height="${(g.toolTop + g.toolHeight - g.mainTop).toFixed(1)}" fill="transparent"/>`,
            `</g>`,
        );
    });

    const tickStep = Math.max(1, Math.ceil(count / 12));
    const ticks: string[] = [];
    turns.forEach((turn, index) => {
        if (index % tickStep !== 0) return;
        const x = g.padL + slot * index + slot / 2;
        ticks.push(
            `<text x="${x.toFixed(1)}" y="${g.axisY}" class="axis" text-anchor="middle">${turn.index}</text>`,
        );
    });

    return [
        `<svg class="timeline" id="timeline" viewBox="0 0 ${g.width} 300" role="img">`,
        `<defs><linearGradient id="costGradient" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#7a5316"/><stop offset="100%" stop-color="#ffb84d"/></linearGradient></defs>`,
        grid.join(""),
        `<g id="tl-bars">${groups.join("")}</g>`,
        `<g id="tl-tools">${toolBars.join("")}</g>`,
        `<polyline id="tl-cum" points="${cumPoints.join(" ")}" fill="none" stroke="#ffd166" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>`,
        ticks.join(""),
        `<text x="${g.padL - 9}" y="${g.toolTop + g.toolHeight + 4}" class="axis" text-anchor="end">tools</text>`,
        `</svg>`,
    ].join("");
}

export function timelineChart(insights: SessionInsights): string {
    if (insights.turns.length === 0) {
        return `<p class="empty">No turns recorded yet.</p>`;
    }
    const turns = bucketTurns(insights.turns, 90);
    const data = JSON.stringify(turns).replace(/</g, "\\u003c");
    const tab = (metric: string, label: string, active: boolean): string =>
        `<button class="mtab${active ? " active" : ""}" type="button" data-metric="${metric}">${label}</button>`;
    return [
        `<div class="tl-toolbar">`,
        `<div class="mtabs" id="tl-tabs">`,
        tab("tokens", "Tokens", false),
        tab("cost", "Cost", true),
        tab("time", "Time", false),
        tab("speed", "Speed", false),
        `</div>`,
        `<div class="chart-legend" id="tl-legend">`,
        `<span class="lg-item"><i style="background:${PALETTE.cost}"></i>cost / turn</span>`,
        `<span class="lg-item"><i style="background:${PALETTE.cum}"></i>cumulative</span>`,
        `<span class="lg-item"><i style="background:${PALETTE.tools}"></i>tool calls</span>`,
        `</div>`,
        `</div>`,
        timelineSvg(turns),
        `<div class="turn-detail" id="turn-detail"><span class="td-hint">Hover a turn for token, cost, latency and tool details.</span></div>`,
        `<script type="application/json" id="turn-data">${data}</script>`,
        `<script>${TIMELINE_SCRIPT}</script>`,
    ].join("");
}
