/**
 * Tests for file-guard extension.
 *
 * Uses the pi SDK with the faux mock provider to drive the agent
 * through scripted tool-call sequences, then asserts that the
 * extension blocks or allows each call correctly.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    Context,
    FauxProviderRegistration,
    FauxProviderState,
    FauxResponseStep,
    SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fileGuard from "../extensions/file-guard.js";
import { createFauxModelRuntime } from "./test-utils.js";

// ── Helpers ────────────────────────────────────────────────────────────

interface ToolEndEvent {
    toolCallId: string;
    toolName: string;
    isError: boolean;
    result: any;
}

/**
 * Boot a minimal agent session with the file-guard extension loaded,
 * send one prompt, wait for completion, and return all
 * tool_execution_end events collected during the run.
 *
 * `responses` is the full faux response queue — it must end with a
 * response that has no tool calls (stopReason "stop") so the agent
 * terminates.
 */
async function runAgent(
    cwd: string,
    faux: FauxProviderRegistration,
    responses: FauxResponseStep[],
): Promise<ToolEndEvent[]> {
    faux.setResponses(responses);

    const model = faux.getModel()!;
    const modelRuntime = await createFauxModelRuntime(faux);
    const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: join(cwd, ".pi-test-agent"),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [fileGuard],
        systemPromptOverride: () => "You are a test assistant.",
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
        cwd,
        agentDir: join(cwd, ".pi-test-agent"),
        model,
        thinkingLevel: "off",

        resourceLoader,
        sessionManager: SessionManager.inMemory(),
        settingsManager,
        modelRuntime,
    });

    const events: ToolEndEvent[] = [];
    session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_end") {
            events.push({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                isError: event.isError,
                result: event.result,
            });
        }
    });

    await session.prompt("go");
    session.dispose();
    return events;
}

function resultText(event: ToolEndEvent): string {
    const content = event.result?.content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
}

// ── Test suite ─────────────────────────────────────────────────────────

describe("file-guard extension", () => {
    let tmpDir: string;
    let faux: FauxProviderRegistration;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "file-guard-test-"));
        faux = registerFauxProvider();
    });

    afterEach(async () => {
        faux.unregister();
        await rm(tmpDir, { recursive: true, force: true });
    });

    // ── Edit is not gated ─────────────────────────────────────────

    it("allows edit without a prior read (edit is not gated)", async () => {
        const filePath = join(tmpDir, "existing.txt");
        await writeFile(filePath, "original content");

        const events = await runAgent(tmpDir, faux, [
            fauxAssistantMessage(
                fauxToolCall("edit", {
                    path: filePath,
                    edits: [
                        {
                            oldText: "original",
                            newText: "modified",
                        },
                    ],
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("ok")),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0].toolName).toBe("edit");
        expect(events[0].isError).toBe(false);
        expect(await readFile(filePath, "utf-8")).toBe("modified content");
    });

    // ── Write without prior read → blocked ────────────────────────

    it("blocks write when existing file has not been read", async () => {
        const filePath = join(tmpDir, "existing.txt");
        await writeFile(filePath, "original content");

        const events = await runAgent(tmpDir, faux, [
            fauxAssistantMessage(
                fauxToolCall("write", {
                    path: filePath,
                    content: "overwritten",
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("ok")),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0].toolName).toBe("write");
        expect(events[0].isError).toBe(true);
        expect(resultText(events[0])).toContain("has not been read");
    });

    // ── Write to new file (ENOENT) is allowed ──────────────────────

    it("allows write to a new (non-existent) file", async () => {
        const filePath = join(tmpDir, "brand-new.txt");

        const events = await runAgent(tmpDir, faux, [
            fauxAssistantMessage(
                fauxToolCall("write", {
                    path: filePath,
                    content: "hello world",
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("ok")),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0].toolName).toBe("write");
        expect(events[0].isError).toBe(false);
        expect(await readFile(filePath, "utf-8")).toBe("hello world");
    });

    // ── Read, external modification, then write → blocked ─────────

    it("blocks write when file was modified after read (mtime mismatch)", async () => {
        const filePath = join(tmpDir, "volatile.txt");
        await writeFile(filePath, "initial");

        const events = await runAgent(tmpDir, faux, [
            // Turn 1: read the file
            fauxAssistantMessage(fauxToolCall("read", { path: filePath }), {
                stopReason: "toolUse",
            }),
            // Turn 2: write — but a factory callback mutates the file first
            ((
                _context: Context,
                _options: SimpleStreamOptions | undefined,
                _state: FauxProviderState,
            ) => {
                // Use a factory response to modify the file right
                // before the LLM "responds" with the write request.
                writeFileSync(filePath, "externally modified");
                return fauxAssistantMessage(
                    fauxToolCall("write", {
                        path: filePath,
                        content: "agent modified",
                    }),
                    { stopReason: "toolUse" },
                );
            }) as any,
            fauxAssistantMessage(fauxText("ok")),
        ]);

        const writeEv = events.find((e) => e.toolName === "write");
        expect(writeEv).toBeDefined();
        expect(writeEv!.isError).toBe(true);
        expect(resultText(writeEv!)).toContain("mtime mismatch");
        expect(await readFile(filePath, "utf-8")).toBe("externally modified");
    });

    it("allows edit after an external modification (edit is not gated)", async () => {
        const filePath = join(tmpDir, "volatile-edit.txt");
        await writeFile(filePath, "initial");

        const events = await runAgent(tmpDir, faux, [
            // Turn 1: read the file
            fauxAssistantMessage(fauxToolCall("read", { path: filePath }), {
                stopReason: "toolUse",
            }),
            // Turn 2: edit — the factory callback mutates the file
            // first, so the stored mtime is stale
            ((
                _context: Context,
                _options: SimpleStreamOptions | undefined,
                _state: FauxProviderState,
            ) => {
                writeFileSync(filePath, "externally modified");
                return fauxAssistantMessage(
                    fauxToolCall("edit", {
                        path: filePath,
                        edits: [
                            {
                                oldText: "externally modified",
                                newText: "agent modified",
                            },
                        ],
                    }),
                    { stopReason: "toolUse" },
                );
            }) as any,
            fauxAssistantMessage(fauxText("ok")),
        ]);

        const editEv = events.find((e) => e.toolName === "edit");
        expect(editEv).toBeDefined();
        expect(editEv!.isError).toBe(false);
        expect(await readFile(filePath, "utf-8")).toBe("agent modified");
    });

    // ── Failed read does not count as "read" ───────────────────────

    it("blocks write after a failed read (tracked entry rolls back)", async () => {
        const filePath = join(tmpDir, "real.txt");
        await writeFile(filePath, "content");

        const events = await runAgent(tmpDir, faux, [
            // Turn 1: read past EOF → the stat() before the read
            // tracked the file, and the failed read must roll it back
            fauxAssistantMessage(
                fauxToolCall("read", { path: filePath, offset: 100 }),
                { stopReason: "toolUse" },
            ),
            // Turn 2: write the same file → blocked, the read failed
            fauxAssistantMessage(
                fauxToolCall("write", {
                    path: filePath,
                    content: "hacked",
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("ok")),
        ]);

        const readEv = events.find((e) => e.toolName === "read");
        const writeEv = events.find((e) => e.toolName === "write");
        expect(readEv).toBeDefined();
        expect(readEv!.isError).toBe(true);
        expect(writeEv).toBeDefined();
        expect(writeEv!.isError).toBe(true);
        expect(resultText(writeEv!)).toContain("has not been read");
        expect(await readFile(filePath, "utf-8")).toBe("content");
    });

    // ── An edit refreshes the mtime for a later write ──────────────

    it("allows write after the agent's own edit (mtime refreshed)", async () => {
        const filePath = join(tmpDir, "multi.txt");
        await writeFile(filePath, "aaa bbb");

        const events = await runAgent(tmpDir, faux, [
            // Turn 1: read
            fauxAssistantMessage(fauxToolCall("read", { path: filePath }), {
                stopReason: "toolUse",
            }),
            // Turn 2: edit — not gated, but it does change the file
            fauxAssistantMessage(
                fauxToolCall("edit", {
                    path: filePath,
                    edits: [{ oldText: "aaa", newText: "AAA" }],
                }),
                { stopReason: "toolUse" },
            ),
            // Turn 3: write — allowed, the edit refreshed the mtime
            fauxAssistantMessage(
                fauxToolCall("write", {
                    path: filePath,
                    content: "AAA BBB\n",
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);

        const editEv = events.find((e) => e.toolName === "edit");
        const writeEv = events.find((e) => e.toolName === "write");
        expect(editEv).toBeDefined();
        expect(editEv!.isError).toBe(false);
        expect(writeEv).toBeDefined();
        expect(writeEv!.isError).toBe(false);
        expect(await readFile(filePath, "utf-8")).toBe("AAA BBB\n");
    });

    // ── Relative paths resolved against cwd ────────────────────────

    it("resolves relative paths against session cwd", async () => {
        const filePath = join(tmpDir, "rel.txt");
        await writeFile(filePath, "relative test");

        const events = await runAgent(tmpDir, faux, [
            // Use relative path for read
            fauxAssistantMessage(fauxToolCall("read", { path: "rel.txt" }), {
                stopReason: "toolUse",
            }),
            // Use absolute path for write (same file)
            fauxAssistantMessage(
                fauxToolCall("write", {
                    path: filePath,
                    content: "relative done",
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);

        const writeEv = events.find((e) => e.toolName === "write");
        expect(writeEv).toBeDefined();
        expect(writeEv!.isError).toBe(false);
        expect(await readFile(filePath, "utf-8")).toBe("relative done");
    });

    // ── Read tool is never blocked ─────────────────────────────────

    it("never blocks read tool calls", async () => {
        const filePath = join(tmpDir, "readable.txt");
        await writeFile(filePath, "can always read");

        const events = await runAgent(tmpDir, faux, [
            fauxAssistantMessage(fauxToolCall("read", { path: filePath }), {
                stopReason: "toolUse",
            }),
            // Read it again immediately
            fauxAssistantMessage(fauxToolCall("read", { path: filePath }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxText("done")),
        ]);

        const reads = events.filter((e) => e.toolName === "read");
        expect(reads).toHaveLength(2);
        expect(reads[0].isError).toBe(false);
        expect(reads[1].isError).toBe(false);
    });

    // ── Non-file tools are not affected ────────────────────────────

    it("does not interfere with non-file tools (e.g. bash)", async () => {
        const events = await runAgent(tmpDir, faux, [
            fauxAssistantMessage(fauxToolCall("bash", { command: "echo hello" }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(fauxText("done")),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0].toolName).toBe("bash");
        expect(events[0].isError).toBe(false);
    });

    // ── Write to new file in non-existent subdirectory → allowed ───

    it("allows write to a path in a non-existent subdirectory", async () => {
        const filePath = join(tmpDir, "sub", "dir", "new.txt");

        const events = await runAgent(tmpDir, faux, [
            fauxAssistantMessage(
                fauxToolCall("write", {
                    path: filePath,
                    content: "nested new file",
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0].toolName).toBe("write");
        expect(events[0].isError).toBe(false);
        expect(await readFile(filePath, "utf-8")).toBe("nested new file");
    });

    // ── Read then write → allowed ──────────────────────────────────

    it("allows write after reading the file", async () => {
        const filePath = join(tmpDir, "overwrite-me.txt");
        await writeFile(filePath, "old content");

        const events = await runAgent(tmpDir, faux, [
            fauxAssistantMessage(fauxToolCall("read", { path: filePath }), {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage(
                fauxToolCall("write", {
                    path: filePath,
                    content: "new content",
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);

        const writeEv = events.find((e) => e.toolName === "write");
        expect(writeEv).toBeDefined();
        expect(writeEv!.isError).toBe(false);
        expect(await readFile(filePath, "utf-8")).toBe("new content");
    });
});
