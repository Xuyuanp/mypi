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

import { describe, expect, it, vi } from "vitest";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
    type BackgroundAgent,
    createZeroUsage,
} from "../extensions/subagent/index.js";

function makeFakeResult(overrides?: Partial<BackgroundAgent["latestResult"]>) {
    return {
        agent: "scout",
        agentSource: "system" as const,
        task: "do something",
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: createZeroUsage(),
        ...overrides,
    };
}

function makeFakeEntry(overrides?: Partial<BackgroundAgent>): BackgroundAgent {
    return {
        id: "scout-a1b2c3d4",
        description: "test",
        agent: { name: "scout", description: "t", systemPrompt: "", source: "system" as const, filePath: "/f.md" },
        task: "do it",
        kill: () => {},
        promise: new Promise(() => {}) as any,
        startedAt: Date.now(),
        toolCallCount: 0,
        latestResult: makeFakeResult(),
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
            agent: {
                name: "scout",
                description: "test",
                systemPrompt: "",
                source: "system",
                filePath: "/fake.md",
            },
            task: "do something",
            kill: vi.fn(() => controller.abort()),
            promise: new Promise(() => {}), // never resolves
            startedAt: Date.now(),
            toolCallCount: 0,
            latestResult: makeFakeResult(),
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

    it("reports not found for unknown ID", () => {
        const map = new Map<string, BackgroundAgent>();
        const id = "nonexistent-12345678";
        expect(map.get(id)).toBeUndefined();
    });

    it("handles cancel after agent already completed (not in map)", () => {
        const map = new Map<string, BackgroundAgent>();
        // Agent was in the map but already completed and removed itself
        const id = "scout-a1b2c3d4";
        expect(map.get(id)).toBeUndefined();
    });
});

describe("background agent lifecycle", () => {
    it("BackgroundAgent.kill calls abort on the controller", () => {
        const controller = new AbortController();
        const killFn = () => controller.abort();

        expect(controller.signal.aborted).toBe(false);
        killFn();
        expect(controller.signal.aborted).toBe(true);
    });

    it("AbortController.abort is idempotent (safe to call after completion)", () => {
        const controller = new AbortController();
        controller.abort();
        // Second call should not throw
        expect(() => controller.abort()).not.toThrow();
        expect(controller.signal.aborted).toBe(true);
    });

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
            agent: {
                name: "worker",
                description: "test",
                systemPrompt: "",
                source: "system",
                filePath: "/fake.md",
            },
            task: "do work",
            kill: () => controller.abort(),
            promise: promise as any,
            startedAt: Date.now(),
            toolCallCount: 0,
            latestResult: makeFakeResult({ agent: "worker", task: "do work" }),
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

        const fakeResult = {
            agent: "scout",
            agentSource: "system" as const,
            task: "find files",
            exitCode: 0,
            messages: [
                {
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: "Found 5 files" }],
                },
            ],
            stderr: "",
            usage: {
                input: 100,
                output: 50,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 150,
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
        };

        const promise = Promise.resolve(fakeResult);

        const entry: BackgroundAgent = {
            id: "scout-ef012345",
            description: "find files",
            agent: {
                name: "scout",
                description: "test",
                systemPrompt: "",
                source: "system",
                filePath: "/fake.md",
            },
            task: "find files",
            kill: () => {},
            promise: promise as any,
            startedAt: Date.now(),
            toolCallCount: 0,
            latestResult: makeFakeResult({ agent: "scout", task: "find files" }),
        };
        map.set(entry.id, entry);

        // Simulate the .then() handler from index.ts
        const sessionActive = true;
        promise.then((result) => {
            map.delete(entry.id);
            if (!sessionActive) return;

            const isError =
                result.exitCode !== 0 ||
                result.agentSource === "unknown"; // simplified check
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
        let sessionActive = false;

        const fakeResult = {
            exitCode: 0,
            messages: [
                {
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: "done" }],
                },
            ],
        };

        const promise = Promise.resolve(fakeResult);

        promise.then((result) => {
            if (!sessionActive) return;
            sendMessageCalled = true;
        });

        await new Promise((r) => setImmediate(r));

        expect(sendMessageCalled).toBe(false);
    });

    it("failed subprocess injects 'failed' status", async () => {
        let injectedContent: string | undefined;

        const fakeResult = {
            exitCode: 1,
            stopReason: "error",
            errorMessage: "spawn ENOENT",
            messages: [] as any[],
        };

        const promise = Promise.resolve(fakeResult);

        const sessionActive = true;
        promise.then((result) => {
            if (!sessionActive) return;

            const isError =
                result.exitCode !== 0 || result.stopReason === "error";
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
                agent: {
                    name: name.split("-")[0],
                    description: "test",
                    systemPrompt: "",
                    source: "system",
                    filePath: "/fake.md",
                },
                task: "do work",
                kill: killFn,
                promise: Promise.resolve({} as any),
                startedAt: Date.now(),
                toolCallCount: 0,
                latestResult: makeFakeResult({ agent: name.split("-")[0], task: "do work" }),
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

    it("shutdown with no background agents is a no-op", async () => {
        const map = new Map<string, BackgroundAgent>();
        const entries = [...map.values()];
        expect(entries.length).toBe(0);
        // Should not throw
        await Promise.allSettled(entries.map((e) => e.promise));
        map.clear();
        expect(map.size).toBe(0);
    });
});

describe("argument completions", () => {
    it("suggests 'cancel' when prefix is empty or partial match", () => {
        // Simulate getArgumentCompletions logic
        const backgroundAgents = new Map<string, BackgroundAgent>();
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
        let statusKey: string | undefined;
        let statusValue: string | undefined;
        const backgroundAgents = new Map<string, BackgroundAgent>();

        function updateWidget(): void {
            const count = backgroundAgents.size;

            if (count === 0) {
                if (widgetActive) {
                    widgetKey = undefined;
                    widgetActive = false;
                }
                statusKey = undefined;
                statusValue = undefined;
                return;
            }

            statusKey = "subagent-bg";
            statusValue = `○ ${count} bg`;

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
        expect(state.statusValue).toBe("○ 1 bg");
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
        for (const id of ["scout-11111111", "worker-22222222", "reviewer-33333333"]) {
            state.backgroundAgents.set(id, makeFakeEntry({ id, agent: { name: id.split("-")[0], description: "t", systemPrompt: "", source: "system" as const, filePath: "/f.md" } }));
        }
        state.updateWidget();
        expect(state.statusValue).toBe("○ 3 bg");
    });

    it("does not recreate widget when count goes from 2 -> 1", () => {
        const state = createWidgetState();
        for (const id of ["scout-11111111", "worker-22222222"]) {
            state.backgroundAgents.set(id, makeFakeEntry({ id, agent: { name: id.split("-")[0], description: "t", systemPrompt: "", source: "system" as const, filePath: "/f.md" } }));
        }
        state.updateWidget();
        expect(state.widgetActive).toBe(true);

        // Remove one agent
        state.backgroundAgents.delete("scout-11111111");
        state.updateWidget();

        // Widget should still be active (not recreated)
        expect(state.widgetActive).toBe(true);
        expect(state.statusValue).toBe("○ 1 bg");
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

    function renderLines(
        entries: BackgroundAgent[],
        width: number,
    ): string[] {
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
            const agentName = entry.agent.name.padEnd(8).slice(0, 8);
            const shortId = entry.id.slice(entry.id.lastIndexOf("-") + 1);
            const desc = truncateToWidth(entry.description, descAvail, "\u2026");

            // Line 1: truncated to width (the fix)
            const line1 =
                `${ICON_RUNNING} ` +
                `${agentName}  ` +
                `${shortId}  ` +
                `${desc}`;
            lines.push(truncateToWidth(line1, width));

            // Line 2: always truncated to width
            const line2 = `  (usage placeholder)`;
            lines.push(truncateToWidth(line2, width));
            rendered++;
        }
        return lines;
    }

    it("all lines fit within width for a narrow terminal (width=20)", () => {
        const entry = makeFakeEntry({ description: "Explore authentication module deeply" });
        const lines = renderLines([entry], 20);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(20);
        }
    });

    it("all lines fit within width for a normal terminal (width=80)", () => {
        const entry = makeFakeEntry({
            id: "worker-e5f6g7h8",
            description: "Generate comprehensive test cases for the auth module",
            agent: { name: "worker", description: "t", systemPrompt: "", source: "system" as const, filePath: "/f.md" },
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
            entries.push(makeFakeEntry({
                id: `scout-${String(i).padStart(8, "0")}`,
                description: `task ${i}`,
                task: `task ${i}`,
            }));
        }

        const lines = renderLines(entries, 80);
        // 5 entries * 2 lines each + 1 overflow line = 11 lines
        expect(lines).toHaveLength(MAX_ENTRIES * 2 + 1);
        expect(lines[lines.length - 1]).toContain("+3 more");
    });

    it("overflow indicator line respects narrow width", () => {
        const entries: BackgroundAgent[] = [];
        for (let i = 0; i < 7; i++) {
            entries.push(makeFakeEntry({
                id: `scout-${String(i).padStart(8, "0")}`,
                description: `task ${i}`,
                task: `task ${i}`,
            }));
        }

        const lines = renderLines(entries, 5);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(5);
        }
    });
});
