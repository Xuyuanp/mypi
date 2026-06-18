/**
 * Background agent lifecycle management (factory pattern).
 *
 * Encapsulates the Map of running background agents, TUI widget,
 * result injection, and cooperative shutdown.
 * State lives in the closure returned by createBackgroundManager.
 * Framework-free: receives callbacks instead of ExtensionAPI/ExtensionContext.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container, TruncatedText } from "@earendil-works/pi-tui";
import { renderSubagentResult } from "./render.js";
import type { AgentRunResult, BackgroundAgent, SubagentDetails } from "./types.js";
import { BACKGROUND_RESULT_TYPE } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────

/** TUI widget key. */
const BG_WIDGET_KEY = "subagent-bg";

const MAX_ENTRIES = 5;

// ── Callback types ───────────────────────────────────────────────────

/** Narrow widget-setter callback — mirrors ctx.ui.setWidget signature. */
export type SetWidgetFn = (key: string, content: WidgetFactory | undefined) => void;

/** Widget factory signature (matches framework's setWidget overload). */
export type WidgetFactory = (
    tui: TUI,
    theme: Theme,
) => Component & {
    dispose?(): void;
};

/** Message injection callback — wraps pi.sendMessage. */
export type InjectMessageFn = (
    message: {
        customType: string;
        content: string;
        display: boolean;
        details: SubagentDetails;
    },
    options: {
        deliverAs: "followUp";
        triggerTurn: boolean;
    },
) => void;

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

    /** Set the UI output channel for the current session (null to detach). */
    setUI(setWidget: SetWidgetFn | null): void;

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

/** Create a BackgroundManager instance using injected callbacks. */
export function createBackgroundManager(
    injectMessage: InjectMessageFn,
): BackgroundManager {
    const agents = new Map<string, BackgroundAgent>();
    let active = true;
    let currentSetWidget: SetWidgetFn | null = null;
    let widgetActive = false;

    function updateWidget(): void {
        const setWidget = currentSetWidget;
        if (!setWidget) return;
        const count = agents.size;

        if (count === 0) {
            if (widgetActive) {
                setWidget(BG_WIDGET_KEY, undefined);
                widgetActive = false;
            }
            return;
        }

        // Create widget only on first spawn (0 -> 1 transition)
        if (!widgetActive) {
            setWidget(BG_WIDGET_KEY, (tui, theme) => {
                const interval = setInterval(() => tui.requestRender(), 1000);
                return {
                    render(width: number): string[] {
                        const container = new Container();

                        // Snapshot to avoid partial iteration if mutated
                        const entries = [...agents.values()];
                        let rendered = 0;
                        for (const entry of entries) {
                            if (rendered >= MAX_ENTRIES) {
                                const remaining = entries.length - MAX_ENTRIES;
                                container.addChild(
                                    new TruncatedText(
                                        theme.fg("muted", `  +${remaining} more`),
                                    ),
                                );
                                break;
                            }
                            const details: SubagentDetails = {
                                kind: "background",
                                description: entry.description,
                                cancelled: false,
                                session: entry.session,
                                execStatuses: Object.fromEntries(
                                    entry.tracker.execStatuses,
                                ),
                                result: {
                                    agent: entry.agentName,
                                    agentSource: "user",
                                    task: entry.task,
                                    outcome: {
                                        status: "running",
                                    } as unknown as AgentRunResult["outcome"],
                                    messages: entry.tracker.messages,
                                    stderr: "",
                                    usage: entry.tracker.usage,
                                    durationMs: Date.now() - entry.startedAt,
                                },
                            };
                            container.addChild(
                                renderSubagentResult(details, false, theme),
                            );
                            rendered++;
                        }
                        return container.render(width - 1).map((line) => ` ${line}`);
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

        setUI(setWidget: SetWidgetFn | null): void {
            currentSetWidget = setWidget;
            widgetActive = false;
        },

        setSessionActive(isActive: boolean): void {
            active = isActive;
        },

        updateWidget,

        async shutdown(): Promise<void> {
            active = false;
            // Clear widget before killing (so UI is clean immediately)
            if (currentSetWidget) {
                currentSetWidget(BG_WIDGET_KEY, undefined);
            }
            widgetActive = false;
            currentSetWidget = null;
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
            injectMessage(
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
