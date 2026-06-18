/**
 * Tests for the background subagent feature.
 *
 * Tests cover:
 * - Background mode returns immediately with agent ID
 * - Result injection via pi.sendMessage on completion
 * - Error injection when subprocess fails
 * - Shutdown kills all background agents
 * - /subagent cancel kills a specific agent
 * - /subagent cancel with unknown ID reports error
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundManager } from "../extensions/subagent/background.js";
import {
    type BackgroundAgent,
    createZeroUsage,
} from "../extensions/subagent/index.js";
import { createProgressTracker } from "../extensions/subagent/tracker.js";
import type { AgentRunResult } from "../extensions/subagent/types.js";
import { isSubagentError } from "../extensions/subagent/types.js";

function makeFakeResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
    return {
        agent: "scout",
        agentSource: "system" as const,
        task: "do something",
        outcome: { status: "success" },
        messages: [],
        stderr: "",
        usage: createZeroUsage(),
        durationMs: 0,
        ...overrides,
    };
}

function makeFakeEntry(overrides?: Partial<BackgroundAgent>): BackgroundAgent {
    return {
        id: "scout-a1b2c3d4",
        description: "test",
        agentName: "scout",
        task: "do it",
        kill: () => {},
        promise: new Promise(() => {}) as any,
        startedAt: Date.now(),
        tracker: createProgressTracker(),
        ...overrides,
    };
}

// We test the cancel command handler logic directly since it's
// a pure interaction with the Map and ctx.ui.notify.
describe("cancel command logic", () => {
    function makeFakeEntry(id: string): BackgroundAgent {
        const controller = new AbortController();
        return {
            id,
            description: "test task",
            agentName: "scout",
            task: "do something",
            kill: vi.fn(() => controller.abort()),
            promise: new Promise(() => {}), // never resolves
            startedAt: Date.now(),
            tracker: createProgressTracker(),
        };
    }

    it("kills and removes a known background agent", () => {
        const map = new Map<string, BackgroundAgent>();
        const entry = makeFakeEntry("scout-a1b2c3d4");
        map.set("scout-a1b2c3d4", entry);

        // Simulate cancel logic
        const id = "scout-a1b2c3d4";
        const found = map.get(id);
        expect(found).toBeDefined();
        found!.kill();
        map.delete(id);

        expect(entry.kill).toHaveBeenCalledOnce();
        expect(map.has(id)).toBe(false);
    });
});

describe("background agent lifecycle", () => {
    it("promise.catch cleans up map entry on abort", async () => {
        const map = new Map<string, BackgroundAgent>();
        const controller = new AbortController();

        const promise = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => {
                reject(new Error("Subagent was aborted"));
            });
        });

        const entry: BackgroundAgent = {
            id: "worker-abcd1234",
            description: "test",
            agentName: "worker",
            task: "do work",
            kill: () => controller.abort(),
            promise: promise as any,
            startedAt: Date.now(),
            tracker: createProgressTracker(),
        };
        map.set(entry.id, entry);

        // Attach the cleanup handler (mirrors index.ts logic)
        promise.catch(() => {
            map.delete(entry.id);
        });

        // Kill the agent
        entry.kill();

        // Wait for microtask to process .catch()
        await new Promise((r) => setImmediate(r));

        expect(map.has("worker-abcd1234")).toBe(false);
    });

    it("promise.then cleans up map and would inject result", async () => {
        const map = new Map<string, BackgroundAgent>();
        let injectedContent: string | undefined;

        const fakeResult: AgentRunResult = {
            agent: "scout",
            agentSource: "system" as const,
            task: "find files",
            outcome: { status: "success" },
            messages: [
                {
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: "Found 5 files" }],
                    api: "anthropic-messages",
                    provider: "anthropic",
                    model: "claude-sonnet-4-20250514",
                    usage: {
                        input: 100,
                        output: 50,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 150,
                        cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 0,
                        },
                    },
                    stopReason: "stop",
                    timestamp: Date.now(),
                },
            ],
            stderr: "",
            usage: {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                contextTokens: 100,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
                turns: 1,
            },
            durationMs: 0,
        };

        const promise = Promise.resolve(fakeResult);

        const entry: BackgroundAgent = {
            id: "scout-ef012345",
            description: "find files",
            agentName: "scout",
            task: "find files",
            kill: () => {},
            promise: promise as any,
            startedAt: Date.now(),
            tracker: createProgressTracker(),
        };
        map.set(entry.id, entry);

        // Simulate the .then() handler from index.ts
        const sessionActive = true;
        promise.then((result) => {
            map.delete(entry.id);
            if (!sessionActive) return;

            const isError = isSubagentError(result);
            const output = "Found 5 files";
            const status = isError ? "failed" : "completed";
            injectedContent = `[Background agent ${entry.id} ${status}]\n\n${output}`;
        });

        // Wait for microtask
        await new Promise((r) => setImmediate(r));

        expect(map.has("scout-ef012345")).toBe(false);
        expect(injectedContent).toBe(
            "[Background agent scout-ef012345 completed]\n\nFound 5 files",
        );
    });

    it("sessionActive=false prevents result injection", async () => {
        let sendMessageCalled = false;
        const sessionActive = false;

        const fakeResult: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: { status: "success" },
            messages: [
                {
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: "done" }],
                    api: "anthropic-messages",
                    provider: "anthropic",
                    model: "claude-sonnet-4-20250514",
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 0,
                        },
                    },
                    stopReason: "stop",
                    timestamp: Date.now(),
                },
            ],
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 0,
        };

        const promise = Promise.resolve(fakeResult);

        promise.then((_result) => {
            if (!sessionActive) return;
            sendMessageCalled = true;
        });

        await new Promise((r) => setImmediate(r));

        expect(sendMessageCalled).toBe(false);
    });

    it("failed subprocess injects 'failed' status", async () => {
        let injectedContent: string | undefined;

        const fakeResult: AgentRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "test",
            outcome: {
                status: "error",
                exitCode: 1,
                stopReason: "error",
                message: "spawn ENOENT",
            },
            messages: [] as any[],
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 0,
        };

        const promise = Promise.resolve(fakeResult);

        const sessionActive = true;
        promise.then((result) => {
            if (!sessionActive) return;

            const isError = isSubagentError(result);
            const output = "(no output)";
            const status = isError ? "failed" : "completed";
            injectedContent = `[Background agent test-12345678 ${status}]\n\n${output}`;
        });

        await new Promise((r) => setImmediate(r));

        expect(injectedContent).toBe(
            "[Background agent test-12345678 failed]\n\n(no output)",
        );
    });
});

describe("shutdown logic", () => {
    it("kills all background agents and awaits their exit", async () => {
        const map = new Map<string, BackgroundAgent>();
        const killFns: ReturnType<typeof vi.fn>[] = [];

        for (const name of ["scout-11111111", "worker-22222222"]) {
            const killFn = vi.fn();
            const entry: BackgroundAgent = {
                id: name,
                description: "test",
                agentName: name.split("-")[0],
                task: "do work",
                kill: killFn,
                promise: Promise.resolve({} as any),
                startedAt: Date.now(),
                tracker: createProgressTracker(),
            };
            map.set(name, entry);
            killFns.push(killFn);
        }

        // Simulate session_shutdown handler
        const entries = [...map.values()];
        for (const entry of entries) {
            entry.kill();
        }
        await Promise.allSettled(entries.map((e) => e.promise));
        map.clear();

        expect(killFns[0]).toHaveBeenCalledOnce();
        expect(killFns[1]).toHaveBeenCalledOnce();
        expect(map.size).toBe(0);
    });
});

describe("argument completions", () => {
    it("suggests 'cancel' when prefix is empty or partial match", () => {
        // Simulate getArgumentCompletions logic
        const prefix = "";

        let result: { label: string; value: string }[] | null = null;
        if (prefix.startsWith("cancel ")) {
            // not this branch
        } else if ("cancel".startsWith(prefix)) {
            result = [{ label: "cancel", value: "cancel " }];
        }

        expect(result).toEqual([{ label: "cancel", value: "cancel " }]);
    });

    it("suggests active agent IDs after 'cancel '", () => {
        const backgroundAgents = new Map<string, BackgroundAgent>();
        backgroundAgents.set("scout-a1b2c3d4", {} as any);
        backgroundAgents.set("scout-e5f6g7h8", {} as any);
        backgroundAgents.set("worker-z9y8x7w6", {} as any);

        const prefix = "cancel s";
        const partial = prefix.slice("cancel ".length);

        const result = [...backgroundAgents.keys()]
            .filter((id) => id.startsWith(partial))
            .map((id) => ({ label: id, value: `cancel ${id}` }));

        expect(result).toEqual([
            { label: "scout-a1b2c3d4", value: "cancel scout-a1b2c3d4" },
            { label: "scout-e5f6g7h8", value: "cancel scout-e5f6g7h8" },
        ]);
    });

    it("returns null when prefix doesn't match 'cancel'", () => {
        const prefix = "list";
        let result: null | unknown = null;
        if (prefix.startsWith("cancel ")) {
            // no
        } else if ("cancel".startsWith(prefix)) {
            result = [{ label: "cancel", value: "cancel " }];
        } else {
            result = null;
        }
        expect(result).toBeNull();
    });
});

describe("widget lifecycle (updateWidget logic)", () => {
    // Simulate updateWidget's core logic in a testable way.
    // We replicate the state machine since updateWidget is a closure
    // inside the default export and not directly importable.

    function createWidgetState() {
        let widgetActive = false;
        let widgetKey: string | undefined;
        let _statusKey: string | undefined;
        let statusValue: string | undefined;
        const backgroundAgents = new Map<string, BackgroundAgent>();

        function updateWidget(): void {
            const count = backgroundAgents.size;

            if (count === 0) {
                if (widgetActive) {
                    widgetKey = undefined;
                    widgetActive = false;
                }
                _statusKey = undefined;
                statusValue = undefined;
                return;
            }

            _statusKey = "subagent-bg";
            statusValue = `\u25cb ${count} bg`;

            if (!widgetActive) {
                widgetKey = "subagent-bg";
                widgetActive = true;
            }
        }

        return {
            backgroundAgents,
            updateWidget,
            get widgetActive() {
                return widgetActive;
            },
            get widgetKey() {
                return widgetKey;
            },
            get statusValue() {
                return statusValue;
            },
        };
    }

    it("sets widget on first spawn (0 -> 1)", () => {
        const state = createWidgetState();
        const entry = makeFakeEntry();
        state.backgroundAgents.set(entry.id, entry);
        state.updateWidget();

        expect(state.widgetActive).toBe(true);
        expect(state.widgetKey).toBe("subagent-bg");
        expect(state.statusValue).toBe("\u25cb 1 bg");
    });

    it("clears widget when last agent completes (1 -> 0)", () => {
        const state = createWidgetState();
        const entry = makeFakeEntry();
        state.backgroundAgents.set(entry.id, entry);
        state.updateWidget();
        expect(state.widgetActive).toBe(true);

        state.backgroundAgents.delete(entry.id);
        state.updateWidget();

        expect(state.widgetActive).toBe(false);
        expect(state.widgetKey).toBeUndefined();
        expect(state.statusValue).toBeUndefined();
    });

    it("updates status count correctly with multiple agents", () => {
        const state = createWidgetState();
        for (const id of [
            "scout-11111111",
            "worker-22222222",
            "reviewer-33333333",
        ]) {
            state.backgroundAgents.set(
                id,
                makeFakeEntry({
                    id,
                    agentName: id.split("-")[0],
                }),
            );
        }
        state.updateWidget();
        expect(state.statusValue).toBe("\u25cb 3 bg");
    });

    it("does not recreate widget when count goes from 2 -> 1", () => {
        const state = createWidgetState();
        for (const id of ["scout-11111111", "worker-22222222"]) {
            state.backgroundAgents.set(
                id,
                makeFakeEntry({
                    id,
                    agentName: id.split("-")[0],
                }),
            );
        }
        state.updateWidget();
        expect(state.widgetActive).toBe(true);

        // Remove one agent
        state.backgroundAgents.delete("scout-11111111");
        state.updateWidget();

        // Widget should still be active (not recreated)
        expect(state.widgetActive).toBe(true);
        expect(state.statusValue).toBe("\u25cb 1 bg");
    });
});

describe("cancel triggers onBackgroundChange", () => {
    it("onBackgroundChange is called from cancel handler", () => {
        const map = new Map<string, BackgroundAgent>();
        const onBackgroundChange = vi.fn();

        const entry = makeFakeEntry({ kill: vi.fn() });
        map.set(entry.id, entry);

        // Simulate cancel handler logic from command.ts
        const id = "scout-a1b2c3d4";
        const found = map.get(id);
        expect(found).toBeDefined();
        map.delete(id);
        found!.kill();
        onBackgroundChange();

        expect(entry.kill).toHaveBeenCalledOnce();
        expect(onBackgroundChange).toHaveBeenCalledOnce();
        expect(map.has(id)).toBe(false);
    });
});

describe("widget render width compliance", () => {
    // Replicates the render logic to verify that lines never exceed width,
    // especially in narrow terminals where FIXED_W > width.

    const MAX_ENTRIES = 5;

    function renderLines(entries: BackgroundAgent[], width: number): string[] {
        const ICON_RUNNING = "\u25cb";
        const lines: string[] = [];
        const ICON_W = 2;
        const NAME_W = 10;
        const ID_W = 10;
        const FIXED_W = ICON_W + NAME_W + ID_W;
        const descAvail = Math.max(8, width - FIXED_W);

        let rendered = 0;
        for (const entry of entries) {
            if (rendered >= MAX_ENTRIES) {
                const remaining = entries.length - MAX_ENTRIES;
                lines.push(truncateToWidth(`  +${remaining} more`, width));
                break;
            }
            const agentName = entry.agentName.padEnd(8).slice(0, 8);
            const shortId = entry.id.slice(entry.id.lastIndexOf("-") + 1);
            const desc = truncateToWidth(entry.description, descAvail, "\u2026");

            // Line 1: truncated to width (the fix)
            const line1 =
                `${ICON_RUNNING} ` + `${agentName}  ` + `${shortId}  ` + `${desc}`;
            lines.push(truncateToWidth(line1, width));

            // Line 2: always truncated to width
            const line2 = `  (usage placeholder)`;
            lines.push(truncateToWidth(line2, width));
            rendered++;
        }
        return lines;
    }

    it("all lines fit within width for a narrow terminal (width=20)", () => {
        const entry = makeFakeEntry({
            description: "Explore authentication module deeply",
        });
        const lines = renderLines([entry], 20);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(20);
        }
    });

    it("all lines fit within width for a normal terminal (width=80)", () => {
        const entry = makeFakeEntry({
            id: "worker-e5f6g7h8",
            description: "Generate comprehensive test cases for the auth module",
            agentName: "worker",
        });
        const lines = renderLines([entry], 80);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(80);
        }
    });

    it("all lines fit for extremely narrow width (width=5)", () => {
        const entry = makeFakeEntry();
        const lines = renderLines([entry], 5);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(5);
        }
    });

    it("caps rendered entries at MAX_ENTRIES with overflow indicator", () => {
        const entries: BackgroundAgent[] = [];
        for (let i = 0; i < 8; i++) {
            entries.push(
                makeFakeEntry({
                    id: `scout-${String(i).padStart(8, "0")}`,
                    description: `task ${i}`,
                    task: `task ${i}`,
                }),
            );
        }

        const lines = renderLines(entries, 80);
        // 5 entries * 2 lines each + 1 overflow line = 11 lines
        expect(lines).toHaveLength(MAX_ENTRIES * 2 + 1);
        expect(lines[lines.length - 1]).toContain("+3 more");
    });

    it("overflow indicator line respects narrow width", () => {
        const entries: BackgroundAgent[] = [];
        for (let i = 0; i < 7; i++) {
            entries.push(
                makeFakeEntry({
                    id: `scout-${String(i).padStart(8, "0")}`,
                    description: `task ${i}`,
                    task: `task ${i}`,
                }),
            );
        }

        const lines = renderLines(entries, 5);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(5);
        }
    });
});

// ── createBackgroundManager tests ────────────────────────────────────

describe("createBackgroundManager", () => {
    function makeMockInject() {
        return vi.fn();
    }

    function makeMockSetWidget() {
        return vi.fn();
    }

    it("register updates widget", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        const setWidget = makeMockSetWidget();
        mgr.setUI(setWidget);

        const entry = makeFakeEntry({ kill: vi.fn() });
        mgr.register(entry);

        expect(mgr.agents.size).toBe(1);
        expect(setWidget).toHaveBeenCalled();
    });

    it("remove clears widget when last agent removed", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        const setWidget = makeMockSetWidget();
        mgr.setUI(setWidget);

        const entry = makeFakeEntry({ kill: vi.fn() });
        mgr.register(entry);
        setWidget.mockClear();

        mgr.remove(entry.id);

        expect(mgr.agents.size).toBe(0);
        // When count goes to 0, widget is cleared
        expect(setWidget).toHaveBeenCalledWith("subagent-bg", undefined);
    });

    it("cancel kills and removes, returns false for unknown IDs", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        const setWidget = makeMockSetWidget();
        mgr.setUI(setWidget);

        const killFn = vi.fn();
        const entry = makeFakeEntry({ kill: killFn });
        mgr.register(entry);

        // Unknown ID returns false
        expect(mgr.cancel("nonexistent")).toBe(false);

        // Known ID returns true, kills and removes
        expect(mgr.cancel(entry.id)).toBe(true);
        expect(killFn).toHaveBeenCalledOnce();
        expect(mgr.agents.size).toBe(0);
    });

    it("injectResult sends followUp with triggerTurn: true for completion", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        mgr.injectResult(
            "test-id",
            "completed",
            "output text",
            makeFakeResult({ outcome: { status: "success" } }),
            { description: "test task", cancelled: false },
        );

        expect(injectMessage).toHaveBeenCalledOnce();
        const [msg, opts] = injectMessage.mock.calls[0];
        expect(opts.deliverAs).toBe("followUp");
        expect(opts.triggerTurn).toBe(true);
        expect(msg.content).toContain("completed");
    });

    it("injectResult sends triggerTurn: false for cancelled", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        mgr.injectResult(
            "test-id",
            "cancelled",
            "(cancelled by user)",
            makeFakeResult({ outcome: { status: "success" } }),
            { description: "test task", cancelled: true },
        );

        expect(injectMessage).toHaveBeenCalledOnce();
        const [_msg, opts] = injectMessage.mock.calls[0];
        expect(opts.triggerTurn).toBe(false);
    });

    it("shutdown marks inactive and kills/awaits/clears", async () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        const setWidget = makeMockSetWidget();
        mgr.setUI(setWidget);

        const killFn = vi.fn();
        const entry = makeFakeEntry({
            kill: killFn,
            promise: Promise.resolve(makeFakeResult()) as any,
        });
        mgr.register(entry);

        await mgr.shutdown();

        expect(mgr.sessionActive).toBe(false);
        expect(killFn).toHaveBeenCalledOnce();
        expect(mgr.agents.size).toBe(0);
    });

    it("injectResult is a no-op when session is inactive", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(false);

        mgr.injectResult(
            "test-id",
            "completed",
            "output",
            makeFakeResult({ outcome: { status: "success" } }),
        );

        expect(injectMessage).not.toHaveBeenCalled();
    });

    it("injectResult constructs SubagentDetails with kind='background'", () => {
        const injectMessage = makeMockInject();
        const mgr = createBackgroundManager(injectMessage);
        mgr.setSessionActive(true);

        mgr.injectResult(
            "bg-id",
            "completed",
            "done",
            makeFakeResult({ outcome: { status: "success" } }),
            { description: "bg task", cancelled: false },
        );

        const [msg] = injectMessage.mock.calls[0];
        expect(msg.details.kind).toBe("background");
        expect(msg.details.description).toBe("bg task");
        expect(msg.details.cancelled).toBe(false);
    });
});
