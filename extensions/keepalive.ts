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

function getMaxPings(): number {
    const val = process.env.PI_KEEPALIVE_MAX_PINGS;
    if (val) {
        const n = Number(val);
        if (!Number.isNaN(n) && n > 0) return Math.floor(n);
    }
    return DEFAULT_MAX_PINGS;
}

function getMaxTotalCost(): number {
    const val = process.env.PI_KEEPALIVE_MAX_COST;
    if (val) {
        const n = Number(val);
        if (!Number.isNaN(n) && n > 0) return n;
    }
    return DEFAULT_MAX_TOTAL_COST;
}

function isAnthropic(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "anthropic";
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

    function clearTimer(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
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
        const costStr = totalCost > 0 ? ` $${totalCost.toFixed(2)}` : "";
        const th = ctx.ui.theme;
        const color: ThemeColor = active ? "success" : "dim";
        const label = th.fg("dim", "Keepalive:");
        const count = th.fg(color, `${pingCount}/${max}`);
        const cost = costStr ? th.fg("dim", costStr) : "";
        ctx.ui.setStatus(STATUS_KEY, `${label}${count}${cost}`);
    }

    function hideStatus(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    function budgetExhausted(): boolean {
        return pingCount >= getMaxPings() || totalCost >= getMaxTotalCost();
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
        timer = setTimeout(() => {
            timer = null;
            executePing();
        }, delay);
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

        if (pingCount >= getMaxPings()) {
            stopKeepalive(ctx, `Ping limit reached (${pingCount}/${getMaxPings()})`);
            return;
        }

        if (totalCost >= getMaxTotalCost()) {
            stopKeepalive(
                ctx,
                `Budget exhausted ($${totalCost.toFixed(2)}/$${getMaxTotalCost().toFixed(2)})`,
            );
            return;
        }

        const usage = await ghostPing(ctx);

        if (!active || !sessionActive) return;

        if (usage === null) {
            stopKeepalive(ctx, "Ping failed");
            return;
        }

        totalCost += usage.cost.total;
        pingCount++;
        renderStatus(ctx);

        if (budgetExhausted()) {
            const reason =
                pingCount >= getMaxPings()
                    ? `Ping limit reached (${pingCount}/${getMaxPings()})`
                    : `Budget exhausted ($${totalCost.toFixed(2)}/$${getMaxTotalCost().toFixed(2)})`;
            stopKeepalive(ctx, reason);
            return;
        }

        schedulePing(ctx);
    }

    function startKeepalive(ctx: ExtensionContext): void {
        active = true;
        pingCount = 0;
        totalCost = 0;
        renderStatus(ctx);
        const delay = computeFirstDelay(ctx);
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
                // whether the scheduler is active. Does not touch the ping/cost
                // counters so it never interferes with the active loop's
                // budgeting. Reports usage so cache behavior is observable --
                // a high cacheRead (R) with near-zero cacheWrite (W) means the
                // ping hit the main agent's cached prefix.
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
                const msg = [
                    "Ghost ping ok",
                    `↑${usage.input}`,
                    `↓${usage.output}`,
                    `R${usage.cacheRead}`,
                    `W${usage.cacheWrite}`,
                    `$${usage.cost.total.toFixed(4)}`,
                ].join(" | ");
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

    pi.on("agent_start", async () => {
        if (!active) return;
        clearTimer();
        abortInFlight();
    });

    pi.on("agent_end", async (_event, ctx) => {
        lastCacheRefreshTime = Date.now();
        if (!active) return;
        if (!isAnthropic(ctx)) return;
        if (budgetExhausted()) {
            const reason =
                pingCount >= getMaxPings()
                    ? `Ping limit reached (${pingCount}/${getMaxPings()})`
                    : `Budget exhausted ($${totalCost.toFixed(2)}/$${getMaxTotalCost().toFixed(2)})`;
            stopKeepalive(ctx, reason);
            return;
        }
        schedulePing(ctx);
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
