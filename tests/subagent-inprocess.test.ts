/**
 * Integration tests for the in-process runSubagent execution path.
 *
 * Drives the SDK-based execution with the faux mock provider:
 * scripted assistant responses, tool-call sequences, abort, and missing model.
 */

import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    registerFauxProvider,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionManager, runSubagent } from "../extensions/subagent/execute.js";
import type {
    ResolvedAgent,
    SubagentProgressEvent,
} from "../extensions/subagent/types.js";
import { getFinalOutput } from "../extensions/subagent/types.js";
import { createFauxModelRuntime } from "./test-utils.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeAgent(model: { provider: string; name: string }): ResolvedAgent {
    return {
        name: "worker",
        tools: ["read"],
        skillPaths: undefined,
        model: {
            provider: model.provider,
            name: model.name,
            thinkingLevel: undefined,
            contextWindow: undefined,
        },
        systemPrompt: "You are a test agent.",
        source: "system",
    };
}

async function setup(
    faux: FauxProviderRegistration,
): Promise<{ runtime: ModelRuntime; model: { provider: string; id: string } }> {
    const runtime = await createFauxModelRuntime(faux);
    return { runtime, model: faux.getModel()! };
}

// ── Test suite ─────────────────────────────────────────────────────────

describe("runSubagent (in-process)", () => {
    it("completes a simple text task", async () => {
        const faux = registerFauxProvider();
        try {
            const { runtime, model } = await setup(faux);
            faux.setResponses([fauxAssistantMessage(fauxText("all done"))]);

            const events: SubagentProgressEvent[] = [];
            const result = await runSubagent(
                makeAgent({ provider: model.provider, name: model.id }),
                "do the thing",
                process.cwd(),
                {
                    modelRuntime: async () => runtime,
                    skillCache: new Map(),
                    onProgress: (e) => events.push(e),
                },
            );

            expect(result.outcome.status).toBe("success");
            expect(getFinalOutput(result.messages)).toContain("all done");
            expect(result.usage.turns).toBeGreaterThanOrEqual(1);
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
            expect(events.some((e) => e.type === "message")).toBe(true);
        } finally {
            faux.unregister();
        }
    });

    it("reports tool execution progress and tool results", async () => {
        const faux = registerFauxProvider();
        try {
            const { runtime, model } = await setup(faux);
            faux.setResponses([
                fauxAssistantMessage(
                    fauxToolCall("read", {
                        path: "/nonexistent-subagent-test-file-xyz",
                    }),
                    { stopReason: "toolUse" },
                ),
                fauxAssistantMessage(fauxText("done")),
            ]);

            const events: SubagentProgressEvent[] = [];
            const result = await runSubagent(
                makeAgent({ provider: model.provider, name: model.id }),
                "read a file",
                process.cwd(),
                {
                    modelRuntime: async () => runtime,
                    skillCache: new Map(),
                    onProgress: (e) => events.push(e),
                },
            );

            expect(result.outcome.status).toBe("success");
            const toolStarts = events.filter((e) => e.type === "tool_start");
            const toolEnds = events.filter((e) => e.type === "tool_end");
            expect(toolStarts.length).toBeGreaterThanOrEqual(1);
            expect(toolEnds.length).toBe(toolStarts.length);
            expect(toolEnds[0].isError).toBe(true);
            expect(result.messages.some((m) => m.role === "toolResult")).toBe(true);
        } finally {
            faux.unregister();
        }
    });

    it("returns an aborted outcome when the signal is already aborted", async () => {
        const faux = registerFauxProvider();
        try {
            const { runtime, model } = await setup(faux);
            faux.setResponses([fauxAssistantMessage(fauxText("never used"))]);

            const controller = new AbortController();
            controller.abort();
            const result = await runSubagent(
                makeAgent({ provider: model.provider, name: model.id }),
                "task",
                process.cwd(),
                {
                    modelRuntime: async () => runtime,
                    skillCache: new Map(),
                    signal: controller.signal,
                },
            );

            expect(result.outcome.status).toBe("aborted");
        } finally {
            faux.unregister();
        }
    });

    it("returns an aborted outcome when aborted mid-run", async () => {
        const faux = registerFauxProvider();
        try {
            const { runtime, model } = await setup(faux);
            faux.setResponses([fauxAssistantMessage(fauxText("done"))]);

            const controller = new AbortController();
            // Fire the abort during runSubagent's setup awaits (after the
            // call starts, before the prompt begins) — deterministic because
            // the microtask runs before createAgentSession completes.
            const run = runSubagent(
                makeAgent({ provider: model.provider, name: model.id }),
                "task",
                process.cwd(),
                {
                    modelRuntime: async () => runtime,
                    skillCache: new Map(),
                    signal: controller.signal,
                },
            );
            queueMicrotask(() => controller.abort());

            const result = await run;
            expect(result.outcome.status).toBe("aborted");
            expect(result.messages).toHaveLength(0);
        } finally {
            faux.unregister();
        }
    });

    it("returns an error result when the model is not available", async () => {
        const faux = registerFauxProvider();
        try {
            const { runtime } = await setup(faux);
            const result = await runSubagent(
                makeAgent({ provider: "no-such-provider", name: "no-model" }),
                "task",
                process.cwd(),
                {
                    modelRuntime: async () => runtime,
                    skillCache: new Map(),
                },
            );

            expect(result.outcome.status).toBe("error");
        } finally {
            faux.unregister();
        }
    });
});

// ── buildSessionManager (session header pre-write) ───────────────────────

describe("buildSessionManager", () => {
    let tmpDir: string;
    let sessionFile: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "pi-subagent-header-"));
        sessionFile = join(tmpDir, "worker-abc12345.jsonl");
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("tolerates the EEXIST concurrent-creation race", async () => {
        const writeFile = vi
            .spyOn(fs.promises, "writeFile")
            .mockRejectedValue(
                Object.assign(new Error("already exists"), { code: "EEXIST" }),
            );

        await expect(
            buildSessionManager(sessionFile, process.cwd(), false),
        ).resolves.toBeDefined();
        expect(writeFile).toHaveBeenCalledTimes(1);
    });

    it("rethrows non-EEXIST header write failures", async () => {
        vi.spyOn(fs.promises, "writeFile").mockRejectedValue(
            Object.assign(new Error("permission denied"), { code: "EACCES" }),
        );

        await expect(
            buildSessionManager(sessionFile, process.cwd(), false),
        ).rejects.toThrow("permission denied");
    });

    it("writes a valid session header for fresh runs", async () => {
        const manager = await buildSessionManager(sessionFile, process.cwd(), false);

        expect(fs.existsSync(sessionFile)).toBe(true);
        const header = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
        expect(header.type).toBe("session");
        expect(header.id).toBe("worker-abc12345");
        expect(manager.getSessionFile()).toBe(sessionFile);
    });
});
