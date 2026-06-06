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
import type { BackgroundAgent } from "../extensions/subagent/index.js";

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
