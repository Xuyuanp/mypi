/**
 * Background agent lifecycle management (factory pattern).
 *
 * Encapsulates the Map of running background agents, TUI widget/status,
 * result injection via pi.sendMessage, and cooperative shutdown.
 * State lives in the closure returned by createBackgroundManager.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { buildLastLine, ICON_RUNNING } from "./render.js";
import type { AgentRunResult, BackgroundAgent, SubagentDetails } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────

/** Custom message type used for background agent result injection. */
export const BACKGROUND_RESULT_TYPE = "subagent_background_result";

/** TUI widget and status bar key. */
const BG_WIDGET_KEY = "subagent-bg";

const MAX_ENTRIES = 5;

// ── Manager interface ────────────────────────────────────────────────

export interface BackgroundManager {
    /** Read-only view of all active background agents. */
    readonly agents: ReadonlyMap<string, BackgroundAgent>;

    /** Register a new background agent entry and update the widget. */
    register(entry: BackgroundAgent): void;

    /** Remove a completed agent (without killing) and update the widget. */
    remove(id: string): boolean;

    /** Cancel an agent: delete, kill, update widget. Returns false for unknown IDs. */
    cancel(id: string): boolean;

    /** Clear all entries without killing and update the widget. */
    clear(): void;

    /** Set the current extension context (resets widgetActive on session start). */
    setContext(ctx: ExtensionContext | null): void;

    /** Mark the session as active or inactive. */
    setSessionActive(active: boolean): void;

    /** Whether the current session is active. */
    get sessionActive(): boolean;

    /** Force a widget refresh. */
    updateWidget(): void;

    /** Shutdown: mark inactive, clear UI, kill all, await, clear. */
    shutdown(): Promise<void>;

    /**
     * Inject a background agent result as a follow-up message.
     * No-op when the session is inactive.
     */
    injectResult(
        id: string,
        status: "completed" | "failed" | "cancelled",
        output: string,
        result: AgentRunResult,
        details?: Omit<SubagentDetails, "result" | "kind">,
    ): void;
}

// ── Factory ──────────────────────────────────────────────────────────

/** Create a BackgroundManager instance bound to the given pi API. */
export function createBackgroundManager(pi: ExtensionAPI): BackgroundManager {
    const agents = new Map<string, BackgroundAgent>();
    let active = true;
    let currentCtx: ExtensionContext | null = null;
    let widgetActive = false;

    function updateWidget(): void {
        const ctx = currentCtx;
        if (!ctx) return;
        const count = agents.size;

        if (count === 0) {
            if (widgetActive) {
                ctx.ui.setWidget(BG_WIDGET_KEY, undefined);
                widgetActive = false;
            }
            ctx.ui.setStatus(BG_WIDGET_KEY, undefined);
            return;
        }

        // Update status count
        ctx.ui.setStatus(
            BG_WIDGET_KEY,
            ctx.ui.theme.fg("accent", `${ICON_RUNNING} ${count} bg`),
        );

        // Create widget only on first spawn (0 -> 1 transition)
        if (!widgetActive) {
            ctx.ui.setWidget(BG_WIDGET_KEY, (tui, theme) => {
                const interval = setInterval(() => tui.requestRender(), 1000);
                return {
                    render(width: number): string[] {
                        const lines: string[] = [];
                        const ICON_W = 2; // "X "
                        const NAME_W = 10; // agent name + padding
                        const ID_W = 10; // short uuid + spacing
                        const FIXED_W = ICON_W + NAME_W + ID_W;
                        const descAvail = Math.max(8, width - FIXED_W);

                        // Snapshot to avoid partial iteration if mutated
                        const entries = [...agents.values()];
                        let rendered = 0;
                        for (const entry of entries) {
                            if (rendered >= MAX_ENTRIES) {
                                const remaining = entries.length - MAX_ENTRIES;
                                lines.push(
                                    truncateToWidth(
                                        theme.fg("muted", `  +${remaining} more`),
                                        width,
                                    ),
                                );
                                break;
                            }
                            const p = entry.tracker;
                            const elapsed = Date.now() - entry.startedAt;

                            // Line 1: icon + agent + id + description
                            const agentName = entry.agentName.padEnd(8).slice(0, 8);
                            const shortId = entry.id.slice(
                                entry.id.lastIndexOf("-") + 1,
                            );
                            const desc = truncateToWidth(
                                entry.description,
                                descAvail,
                                "\u2026",
                            );
                            const line1 =
                                `${theme.fg("accent", ICON_RUNNING)} ` +
                                `${theme.fg("muted", agentName)}  ` +
                                `${theme.fg("dim", shortId)}  ` +
                                `${theme.fg("muted", desc)}`;
                            lines.push(truncateToWidth(line1, width));

                            // Line 2: usage summary
                            const usageLine = buildLastLine(
                                {
                                    usage: p.usage,
                                    durationMs: elapsed,
                                },
                                p.toolStartCount,
                            );
                            const line2 = `  ${theme.fg("dim", usageLine)}`;
                            lines.push(truncateToWidth(line2, width));
                            rendered++;
                        }
                        return lines;
                    },
                    invalidate(): void {
                        /* no-op: render is stateless */
                    },
                    dispose(): void {
                        clearInterval(interval);
                    },
                };
            });
            widgetActive = true;
        }
    }

    const manager: BackgroundManager = {
        get agents() {
            return agents as ReadonlyMap<string, BackgroundAgent>;
        },

        get sessionActive() {
            return active;
        },

        register(entry: BackgroundAgent): void {
            agents.set(entry.id, entry);
            updateWidget();
        },

        remove(id: string): boolean {
            const deleted = agents.delete(id);
            if (deleted) updateWidget();
            return deleted;
        },

        cancel(id: string): boolean {
            const entry = agents.get(id);
            if (!entry) return false;
            agents.delete(id);
            entry.kill();
            updateWidget();
            return true;
        },

        clear(): void {
            agents.clear();
            updateWidget();
        },

        setContext(ctx: ExtensionContext | null): void {
            currentCtx = ctx;
            widgetActive = false;
        },

        setSessionActive(isActive: boolean): void {
            active = isActive;
        },

        updateWidget,

        async shutdown(): Promise<void> {
            active = false;
            // Clear widget and status before killing (so UI is clean immediately)
            if (currentCtx) {
                currentCtx.ui.setWidget(BG_WIDGET_KEY, undefined);
                currentCtx.ui.setStatus(BG_WIDGET_KEY, undefined);
            }
            widgetActive = false;
            currentCtx = null;
            const entries = [...agents.values()];
            if (entries.length === 0) return;
            for (const entry of entries) {
                entry.kill();
            }
            await Promise.allSettled(entries.map((e) => e.promise));
            agents.clear();
        },

        injectResult(
            id: string,
            status: "completed" | "failed" | "cancelled",
            output: string,
            result: AgentRunResult,
            details?: Omit<SubagentDetails, "result" | "kind">,
        ): void {
            if (!active) return;
            const sessionHeader = details?.session
                ? `[subagent: ${details.session.id}]\n\n`
                : "";
            const content = `${sessionHeader}[Background subagent result \u2014 this is NOT a user message. A fire-and-forget background agent "${id}" has been ${status}. ${status === "cancelled" ? "Do not wait for its result." : "Acknowledge briefly or act on the result only if relevant to the current task."}]\n\n${output}`;
            pi.sendMessage<SubagentDetails>(
                {
                    customType: BACKGROUND_RESULT_TYPE,
                    content,
                    display: true,
                    details: {
                        kind: "background",
                        result,
                        description: details?.description ?? "(unknown)",
                        cancelled: details?.cancelled ?? false,
                        execStatuses: details?.execStatuses ?? {},
                        session: details?.session,
                        resolvedAgent: details?.resolvedAgent,
                        contextWindow: details?.contextWindow,
                    },
                },
                {
                    deliverAs: "followUp",
                    triggerTurn: status !== "cancelled",
                },
            );
        },
    };

    return manager;
}
