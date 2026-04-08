/**
 * KV Cache Status Extension
 *
 * Displays a colored dot in the footer indicating whether the Anthropic
 * KV cache is likely still alive. The ephemeral cache TTL is 5 minutes
 * by default, or 1 hour when PI_CACHE_RETENTION=long.
 *
 * - Green dot: cache likely alive (within TTL of last LLM call)
 * - Yellow dot: cache likely expired (TTL elapsed since last LLM call)
 *
 * Only shown for Anthropic models.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
    ThemeColor,
} from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "kv-cache";
const TTL_SHORT_MS = 5 * 60 * 1000;
const TTL_LONG_MS = 60 * 60 * 1000;

function getTtlMs(): number {
    const retention = process.env.PI_CACHE_RETENTION;
    return retention === "long" ? TTL_LONG_MS : TTL_SHORT_MS;
}

function isAnthropic(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "anthropic";
}

function renderDot(
    color: ThemeColor,
    theme: { fg: (color: ThemeColor, text: string) => string },
): string {
    const label = theme.fg("dim", "Cache:");
    const dot = theme.fg(color, "●");
    return `${label}${dot}`;
}

export default function (pi: ExtensionAPI) {
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCtx: ExtensionContext | null = null;

    function clearTimer(): void {
        if (expiryTimer !== null) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }
    }

    function setExpired(): void {
        if (lastCtx?.hasUI) {
            lastCtx.ui.setStatus(STATUS_KEY, renderDot("warning", lastCtx.ui.theme));
        }
    }

    function setAlive(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        ctx.ui.setStatus(STATUS_KEY, renderDot("success", ctx.ui.theme));
    }

    function hide(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    function startTimer(ctx: ExtensionContext, delayMs: number): void {
        clearTimer();
        lastCtx = ctx;
        setAlive(ctx);
        expiryTimer = setTimeout(setExpired, delayMs);
    }

    function resetTimer(ctx: ExtensionContext): void {
        startTimer(ctx, getTtlMs());
    }

    /**
     * Find the timestamp of the last Anthropic assistant message
     * in the current session branch. Returns undefined if none found.
     */
    function findLastAnthropicTimestamp(ctx: ExtensionContext): number | undefined {
        const entries = ctx.sessionManager.getBranch();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (
                entry.type === "message" &&
                entry.message.role === "assistant" &&
                entry.message.provider === "anthropic"
            ) {
                return entry.message.timestamp;
            }
        }
        return undefined;
    }

    pi.on("session_start", async (_event, ctx) => {
        if (!ctx.hasUI || !isAnthropic(ctx)) return;

        const lastTs = findLastAnthropicTimestamp(ctx);
        if (lastTs === undefined) return;

        const elapsed = Date.now() - lastTs;
        const ttl = getTtlMs();
        const remaining = ttl - elapsed;

        if (remaining > 0) {
            startTimer(ctx, remaining);
        } else {
            lastCtx = ctx;
            setExpired();
        }
    });

    pi.on("turn_end", async (_event, ctx) => {
        if (!ctx.hasUI || !isAnthropic(ctx)) return;
        resetTimer(ctx);
    });

    pi.on("model_select", async (event, ctx) => {
        if (!ctx.hasUI) return;
        if (event.model.provider !== "anthropic") {
            clearTimer();
            hide(ctx);
        }
    });

    pi.on("session_shutdown", async () => {
        clearTimer();
        lastCtx = null;
    });
}
