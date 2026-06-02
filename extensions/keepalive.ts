/**
 * KV Cache Keepalive Extension
 *
 * Periodically sends ghost pings to keep the Anthropic KV cache warm
 * while the user is idle. Activated via /keepalive slash command.
 *
 * The ghost ping sends the full conversation prefix (system prompt +
 * tools + messages) with maxTokens: 1, no reasoning. The response is
 * discarded — nothing is appended to session history. The API sees
 * the same prefix, cache-reads it (refreshing the 1h TTL), and
 * returns 1 token.
 *
 * Configurable via environment variables:
 * - PI_KEEPALIVE_MAX_PINGS: max ping count (default 8)
 * - PI_KEEPALIVE_MAX_COST: max total cost in dollars (default 1.00)
 */

import {
    type Api,
    completeSimple,
    type Model,
    type Usage,
} from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";

// NOTE: the cache-marker relocation helpers below are intentionally duplicated
// from extensions/btw.ts rather than shared. Both extensions are fire-and-forget
// Anthropic forks, but they are otherwise independent modules.

/** Provider API id that uses Anthropic-style `cache_control` markers. */
const ANTHROPIC_API = "anthropic-messages";

/**
 * Anthropic block kinds that can carry a `cache_control` marker. Other kinds
 * (e.g. `tool_use`, `thinking`) cannot, so the relocated marker is only ever
 * placed on a block of one of these kinds.
 */
const CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "tool_result"]);

interface AnthropicContentBlock {
    // text | image | tool_use | tool_result | thinking | redacted_thinking
    type: string;
    text?: string;
    cache_control?: unknown;
}

interface AnthropicMessage {
    role: string;
    content: string | AnthropicContentBlock[];
}

interface AnthropicPayload {
    messages?: AnthropicMessage[];
}

/** Remove and return the `cache_control` marker from a message's last block. */
function takeCacheControl(message: AnthropicMessage): unknown {
    if (!Array.isArray(message.content)) return undefined;
    const lastBlock = message.content[message.content.length - 1];
    if (!lastBlock || lastBlock.cache_control === undefined) return undefined;
    const cacheControl = lastBlock.cache_control;
    lastBlock.cache_control = undefined;
    return cacheControl;
}

/**
 * Attach a `cache_control` marker to a message's last content block,
 * normalizing string content into a text block. Returns false (without
 * mutating) when the last block cannot carry a marker.
 */
function setCacheControl(message: AnthropicMessage, cacheControl: unknown): boolean {
    if (typeof message.content === "string") {
        message.content = [
            { type: "text", text: message.content, cache_control: cacheControl },
        ];
        return true;
    }
    const lastBlock = message.content[message.content.length - 1];
    if (!lastBlock || !CACHEABLE_BLOCK_TYPES.has(lastBlock.type)) return false;
    lastBlock.cache_control = cacheControl;
    return true;
}

/**
 * For Anthropic models, move the single `cache_control` marker off the newest
 * (synthetic ping) message and onto the second-to-last (N-2) message -- the
 * last prefix point shared with the parent conversation. This keeps the
 * fire-and-forget ghost ping from writing its ephemeral tail into the shared
 * KV cache (see docs/KV_CACHE.md sections 4 and 6).
 *
 * Returns the mutated payload, or undefined to leave it unchanged.
 */
function moveCacheMarkerToSharedPrefix(
    payload: unknown,
    model: Model<Api>,
): unknown {
    if (model.api !== ANTHROPIC_API) return undefined;
    const { messages } = payload as AnthropicPayload;
    if (!messages || messages.length < 2) return undefined;
    const cacheControl = takeCacheControl(messages[messages.length - 1]);
    if (cacheControl === undefined) return undefined;
    // If the shared-prefix message cannot carry the marker, restore it on the
    // newest message so the request keeps the provider's default single marker.
    if (!setCacheControl(messages[messages.length - 2], cacheControl)) {
        setCacheControl(messages[messages.length - 1], cacheControl);
        return undefined;
    }
    return payload;
}

const PING_INTERVAL_MS = 55 * 60 * 1000;
const DEFAULT_MAX_PINGS = 8;
const DEFAULT_MAX_TOTAL_COST = 1.0;
const STATUS_KEY = "keepalive";
/** Nerd Font nf-fa-heartbeat (U+F21E); stands in for the "Keepalive" label. */
const STATUS_GLYPH = "\uf21e";
/** Separator between status segments (count / cost / next-ping time). */
const STATUS_SEP = " \u2502 ";

export function getMaxPings(): number {
    const val = process.env.PI_KEEPALIVE_MAX_PINGS;
    if (val) {
        // Floor first, then require >= 1. A fractional value in (0, 1) floors
        // to 0, and a 0 limit would let one ping slip past the post-ping budget
        // gate (and break the "active => not exhausted" invariant), so treat it
        // as invalid and fall back to the default.
        const n = Math.floor(Number(val));
        if (Number.isFinite(n) && n >= 1) return n;
    }
    return DEFAULT_MAX_PINGS;
}

export function getMaxTotalCost(): number {
    const val = process.env.PI_KEEPALIVE_MAX_COST;
    if (val) {
        // Cost is continuous, so (unlike getMaxPings) we keep the fractional
        // value. Number.isFinite rejects NaN and Infinity -- the latter would
        // otherwise produce an unbounded cost cap.
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_MAX_TOTAL_COST;
}

function isAnthropic(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "anthropic";
}

/** Format a timestamp as a local HH:MM clock string for the status line. */
function formatClock(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

export default function (pi: ExtensionAPI) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pingCount = 0;
    let totalCost = 0;
    let active = false;
    let lastCtx: ExtensionContext | null = null;
    let abortController: AbortController | null = null;
    let sessionActive = true;
    let lastCacheRefreshTime: number | null = null;
    let nextPingTime: number | null = null;

    function clearTimer(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        nextPingTime = null;
    }

    function abortInFlight(): void {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    }

    function renderStatus(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        const max = getMaxPings();
        const th = ctx.ui.theme;
        const color: ThemeColor = active ? "success" : "dim";
        // The glyph reuses the liveness color: green when pinging, dim when idle.
        const label = th.fg(color, `${STATUS_GLYPH} `);
        // The status is set once (not a live countdown), so an absolute clock
        // time stays accurate where a relative "in Nm" would go stale.
        const segments = [th.fg(color, `${pingCount}/${max}`)];
        if (totalCost > 0) {
            segments.push(th.fg("dim", `$${totalCost.toFixed(2)}`));
        }
        if (active && nextPingTime !== null) {
            segments.push(th.fg("dim", `at ${formatClock(nextPingTime)}`));
        }
        const sep = th.fg("dim", STATUS_SEP);
        const body = `${label}${segments.join(sep)}`;
        ctx.ui.setStatus(
            STATUS_KEY,
            `${th.fg("dim", "[")}${body}${th.fg("dim", "]")}`,
        );
    }

    function hideStatus(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    /**
     * Returns the reason the ping budget is exhausted, or null if budget
     * remains. The truthy/null result doubles as the exhausted/not-exhausted
     * signal, so callers get both the verdict and the message in one check.
     */
    function budgetExhausted(): string | null {
        const maxPings = getMaxPings();
        if (pingCount >= maxPings) {
            return `Ping limit reached (${pingCount}/${maxPings})`;
        }
        const maxCost = getMaxTotalCost();
        if (totalCost >= maxCost) {
            return `Budget exhausted ($${totalCost.toFixed(2)}/$${maxCost.toFixed(2)})`;
        }
        return null;
    }

    async function ghostPing(ctx: ExtensionContext): Promise<Usage | null> {
        const model = ctx.model;
        if (!model) return null;

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) return null;

        const branch = ctx.sessionManager.getBranch();
        const sctx = buildSessionContext(branch);
        const llmMessages = convertToLlm(sctx.messages);

        // Append a minimal user message if the last message is not
        // user-role (the API requires a trailing user turn). The text
        // MUST be non-whitespace: Anthropic rejects whitespace-only text
        // blocks with HTTP 400 ("text content blocks must contain
        // non-whitespace text"), which would fail every ghost ping.
        const pingAppended =
            llmMessages.length === 0 ||
            llmMessages[llmMessages.length - 1].role !== "user";
        if (pingAppended) {
            llmMessages.push({
                role: "user",
                content: [{ type: "text", text: "ping" }],
                timestamp: Date.now(),
            });
        }

        // Fall back to "" (matching the /btw fork pattern) so an
        // undefined-vs-empty-string difference never alters the cached
        // prefix and causes the ping to miss the main agent's cache.
        const systemPrompt = ctx.getSystemPrompt() ?? "";

        // Build tool list in same order as main agent
        const allTools = new Map(pi.getAllTools().map((t) => [t.name, t]));
        const tools = pi
            .getActiveTools()
            .map((name) => allTools.get(name))
            .filter((t) => t !== undefined)
            .map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
            }));

        const thinkingLevel = pi.getThinkingLevel();
        const reasoning = thinkingLevel !== "off" ? thinkingLevel : undefined;

        abortController = new AbortController();

        try {
            const result = await completeSimple(
                model,
                { systemPrompt, messages: llmMessages, tools },
                {
                    apiKey: auth.apiKey,
                    headers: auth.headers,
                    maxTokens: 1,
                    reasoning,
                    signal: abortController.signal,
                    // Only relocate the marker when we appended a synthetic ping
                    // tail. Without a ping, the request is byte-identical to the
                    // main agent's last request and the default marker already
                    // sits on the genuine shared last message.
                    ...(pingAppended
                        ? { onPayload: moveCacheMarkerToSharedPrefix }
                        : {}),
                },
            );

            if (result.stopReason === "aborted") return null;

            return result.usage;
        } catch {
            // A failed ping (network error, HTTP 4xx/5xx, etc.) must not
            // crash the reschedule loop: executePing runs from a timer
            // callback, so an unhandled rejection would silently kill
            // keepalive. Return null -> executePing stops it cleanly.
            return null;
        } finally {
            abortController = null;
        }
    }

    function schedulePing(ctx: ExtensionContext, delayMs?: number): void {
        clearTimer();
        lastCtx = ctx;
        const delay = delayMs ?? PING_INTERVAL_MS;
        nextPingTime = Date.now() + delay;
        timer = setTimeout(() => {
            timer = null;
            executePing();
        }, delay);
        // schedulePing is the single source of "next ping scheduled", so refresh
        // the status here to surface the freshly computed next-ping time.
        renderStatus(ctx);
    }

    /**
     * Compute how long until the next ping should fire based on when
     * the cache was last refreshed (by a real agent turn or a ping).
     * Returns the remaining ms, or 0 if already overdue.
     */
    function computeFirstDelay(ctx: ExtensionContext): number {
        let refTime = lastCacheRefreshTime;

        // If no agent_end recorded yet, scan branch for last
        // Anthropic assistant message timestamp
        if (refTime === null) {
            const entries = ctx.sessionManager.getBranch();
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i];
                if (
                    entry.type === "message" &&
                    entry.message.role === "assistant" &&
                    entry.message.provider === "anthropic"
                ) {
                    refTime = entry.message.timestamp;
                    break;
                }
            }
        }

        if (refTime === null) return PING_INTERVAL_MS;

        const elapsed = Date.now() - refTime;
        const remaining = PING_INTERVAL_MS - elapsed;
        return Math.max(0, remaining);
    }

    async function executePing(): Promise<void> {
        const ctx = lastCtx;
        if (!ctx || !active || !sessionActive) return;

        const usage = await ghostPing(ctx);

        if (!active || !sessionActive) return;

        if (usage === null) {
            stopKeepalive(ctx, "Ping failed");
            return;
        }

        totalCost += usage.cost.total;
        pingCount++;
        // Ghost pings call completeSimple directly and bypass
        // after_provider_response, so the anchor must be set here. A maxTokens:1
        // ping streams in well under a second, so ~now ~= its response-begin.
        lastCacheRefreshTime = Date.now();

        // A scheduled ping should always read the cached prefix. cacheRead === 0
        // WITH a non-zero cacheWrite means the prefix was evicted before the ping
        // landed and the ping just rewrote it (keepalive keeps working, but the
        // warm window was lost -- a sign the interval/anchor is off or the TTL is
        // shorter than assumed). When cacheWrite is also 0 there was simply no
        // cache activity (e.g. prefix below the cacheable threshold), a different
        // condition, so stay silent rather than claim a false eviction.
        if (ctx.hasUI && usage.cacheRead === 0 && usage.cacheWrite > 0) {
            ctx.ui.notify(
                "Keepalive ping missed cache (prefix evicted, cache rewritten)",
                "warning",
            );
        }

        // Single budget gate: counters only grow here, and stopKeepalive clears
        // `active`, so no other site needs to re-check. Relies on limits being
        // positive so a fresh run (zeroed counters) is never already exhausted.
        const reason = budgetExhausted();
        if (reason) {
            stopKeepalive(ctx, reason);
            return;
        }

        // The ping refreshed the cache at ~now (see above), so the next ping is
        // simply one full interval out.
        schedulePing(ctx);
    }

    function startKeepalive(ctx: ExtensionContext): void {
        active = true;
        pingCount = 0;
        totalCost = 0;
        const delay = computeFirstDelay(ctx);
        // schedulePing renders the status (with the computed next-ping time).
        schedulePing(ctx, delay);
        if (ctx.hasUI) {
            ctx.ui.notify("Keepalive started", "info");
        }
    }

    function stopKeepalive(ctx: ExtensionContext, reason?: string): void {
        active = false;
        clearTimer();
        abortInFlight();
        hideStatus(ctx);
        if (ctx.hasUI && reason) {
            ctx.ui.notify(`Keepalive stopped: ${reason}`, "info");
        }
    }

    function resetState(): void {
        active = false;
        clearTimer();
        abortInFlight();
        lastCtx = null;
        pingCount = 0;
        totalCost = 0;
        lastCacheRefreshTime = null;
    }

    // ── Slash command ──────────────────────────────────────────────

    pi.registerCommand("keepalive", {
        description: "Keep KV cache warm with periodic ghost pings",
        getArgumentCompletions: (prefix) => {
            const options = ["on", "off", "status", "ping"];
            const filtered = options.filter((o) => o.startsWith(prefix));
            return filtered.length > 0
                ? filtered.map((o) => ({ value: o, label: o }))
                : null;
        },
        handler: async (args, ctx) => {
            const sub = args.trim().toLowerCase();

            if (sub === "status") {
                const state = active ? "active" : "inactive";
                const msg = [
                    `Keepalive: ${state}`,
                    `Pings: ${pingCount}/${getMaxPings()}`,
                    `Cost: $${totalCost.toFixed(4)}/$${getMaxTotalCost().toFixed(2)}`,
                ].join(" | ");
                ctx.ui.notify(msg, "info");
                return;
            }

            if (sub === "ping") {
                // Debug helper: fire one ghost ping immediately, regardless of
                // whether the scheduler is active. Leaves the ping/cost counters
                // untouched (budgeting is unaffected), but the ping really warms
                // the cache, so it refreshes the cache-TTL anchor below -- and,
                // when active, reschedules the next ping off it so the loop does
                // not fire a redundant ping from the stale anchor.
                // Reports usage so cache behavior is observable --
                // a high cache read with near-zero cache write means the ping
                // hit the main agent's cached prefix.
                if (!ctx.model) {
                    ctx.ui.notify("No model selected", "error");
                    return;
                }
                if (!isAnthropic(ctx)) {
                    ctx.ui.notify("Only supported for Anthropic models", "error");
                    return;
                }
                ctx.ui.notify("Sending ghost ping...", "info");
                const usage = await ghostPing(ctx);
                if (usage === null) {
                    ctx.ui.notify("Ghost ping failed", "error");
                    return;
                }
                // See the handler comment above: anchor off this ping. A
                // maxTokens:1 ping streams in well under a second, so ~now ~=
                // its response-begin (same reasoning as executePing).
                lastCacheRefreshTime = Date.now();
                // The freshly warmed cache buys a full interval, so replace any
                // pending scheduled ping (clearTimer runs inside schedulePing)
                // with one anchored to now. Guarded by `active`: when inactive
                // there is no loop to reschedule and we must not start a timer.
                if (active) {
                    schedulePing(ctx);
                }
                // Format mirrors extensions/tps.ts: ` | `-separated groups,
                // comma-separated `label value` pairs, thousands separators,
                // and a cache hit-rate percentage when there is cache activity.
                const promptTokens =
                    usage.input + usage.cacheRead + usage.cacheWrite;
                const hasCacheActivity = usage.cacheRead > 0 || usage.cacheWrite > 0;
                const hitRateSegment =
                    hasCacheActivity && promptTokens > 0
                        ? `, ${((usage.cacheRead / promptTokens) * 100).toFixed(1)}%`
                        : "";
                const msg = `Ghost ping ok | out ${usage.output.toLocaleString()}, in ${usage.input.toLocaleString()}, cache r/w ${usage.cacheRead.toLocaleString()}/${usage.cacheWrite.toLocaleString()}, total ${usage.totalTokens.toLocaleString()}${hitRateSegment} | $${usage.cost.total.toFixed(4)}`;
                ctx.ui.notify(msg, "info");
                return;
            }

            if (sub === "off") {
                if (!active) {
                    ctx.ui.notify("Keepalive is not active", "info");
                    return;
                }
                stopKeepalive(ctx, "Manual stop");
                return;
            }

            if (sub === "on" || sub === "") {
                // Toggle behavior for empty args
                if (sub === "" && active) {
                    stopKeepalive(ctx, "Manual stop");
                    return;
                }

                if (active) {
                    ctx.ui.notify("Keepalive is already active", "info");
                    return;
                }

                if (!ctx.model) {
                    ctx.ui.notify("No model selected", "error");
                    return;
                }

                if (!isAnthropic(ctx)) {
                    ctx.ui.notify("Only supported for Anthropic models", "error");
                    return;
                }

                startKeepalive(ctx);
                return;
            }

            ctx.ui.notify("Usage: /keepalive [on|off|status|ping]", "error");
        },
    });

    // ── Event handlers ─────────────────────────────────────────────

    pi.on("after_provider_response", async (event, ctx) => {
        // Anchor the cache-TTL clock to response-begin: this fires once the HTTP
        // response is received, before its body streams -- the closest signal pi
        // exposes to when the cache is actually written/refreshed. Record even
        // while inactive so `/keepalive on` can compute an accurate first delay.
        // Skip non-2xx: no successful response means no cache write/refresh.
        if (event.status < 200 || event.status >= 300) return;
        if (!isAnthropic(ctx)) return;
        lastCacheRefreshTime = Date.now();
    });

    pi.on("agent_start", async () => {
        if (!active) return;
        clearTimer();
        abortInFlight();
    });

    pi.on("agent_end", async (_event, ctx) => {
        // No budget check here: exhausting the budget always flips `active` to
        // false (via stopKeepalive in executePing), so reaching this point
        // already implies budget remains.
        if (!active) return;
        if (!isAnthropic(ctx)) return;
        // Schedule from the response-begin anchor recorded above, not from now.
        schedulePing(ctx, computeFirstDelay(ctx));
    });

    pi.on("model_select", async (event, ctx) => {
        if (!active) return;
        if (event.model.provider !== "anthropic") {
            stopKeepalive(ctx, "Model switched to non-Anthropic");
        }
    });

    pi.on("session_compact", async (_event, ctx) => {
        if (!active) return;
        stopKeepalive(ctx, "Session compacted (prefix invalidated)");
    });

    pi.on("session_shutdown", async () => {
        sessionActive = false;
        resetState();
    });

    pi.on("session_start", async () => {
        sessionActive = true;
    });
}
