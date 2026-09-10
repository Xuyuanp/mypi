/**
 * Number coercion, display formatting, HTML escaping, and string truncation.
 */

export function num(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

export function formatTokens(count: number): string {
    if (!Number.isFinite(count) || count <= 0) return "0";
    if (count < 1000) return Math.round(count).toString();
    if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "$0.00";
    if (value >= 1) return `$${value.toFixed(2)}`;
    if (value >= 0.01) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(4)}`;
}

export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "0s";
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
    const minutes = Math.floor(seconds / 60);
    const remSeconds = Math.round(seconds % 60);
    if (minutes < 60) return `${minutes}m ${remSeconds}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

export function formatPercent(fraction: number, digits = 1): string {
    if (!Number.isFinite(fraction)) return "0%";
    return `${(fraction * 100).toFixed(digits)}%`;
}

export function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function truncate(value: string, max: number): string {
    const collapsed = value.replace(/\s+/g, " ").trim();
    if (collapsed.length <= max) return collapsed;
    return `${collapsed.slice(0, max - 1)}…`;
}
