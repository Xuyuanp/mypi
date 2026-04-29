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
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    registerFauxProvider,
} from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fileGuard from "../extensions/file-guard.js";

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
    responses: ReturnType<typeof fauxAssistantMessage>[],
): Promise<ToolEndEvent[]> {
    faux.setResponses(responses);

    const model = faux.getModel()!;
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, "fake-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
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
        authStorage,
        modelRegistry,
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

    // ── Edit / Write without prior read ────────────────────────────

    it("blocks edit when file has not been read", async () => {
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
        expect(events[0].isError).toBe(true);
        expect(resultText(events[0])).toContain("has not been read");
    });

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

    // ── Read then edit → allowed ───────────────────────────────────

    it("allows edit after reading the file", async () => {
        const filePath = join(tmpDir, "hello.txt");
        await writeFile(filePath, "hello world");

        const events = await runAgent(tmpDir, faux, [
            // Turn 1: read the file
            fauxAssistantMessage(fauxToolCall("read", { path: filePath }), {
                stopReason: "toolUse",
            }),
            // Turn 2: edit the file
            fauxAssistantMessage(
                fauxToolCall("edit", {
                    path: filePath,
                    edits: [
                        {
                            oldText: "hello world",
                            newText: "hello earth",
                        },
                    ],
                }),
                { stopReason: "toolUse" },
            ),
            // Turn 3: done
            fauxAssistantMessage(fauxText("done")),
        ]);

        const readEv = events.find((e) => e.toolName === "read");
        const editEv = events.find((e) => e.toolName === "edit");
        expect(readEv).toBeDefined();
        expect(readEv!.isError).toBe(false);
        expect(editEv).toBeDefined();
        expect(editEv!.isError).toBe(false);
        expect(await readFile(filePath, "utf-8")).toBe("hello earth");
    });

    // ── Read, external modification, then edit → blocked ───────────

    it("blocks edit when file was modified after read (mtime mismatch)", async () => {
        const filePath = join(tmpDir, "volatile.txt");
        await writeFile(filePath, "initial");

        const events = await runAgent(tmpDir, faux, [
            // Turn 1: read the file
            fauxAssistantMessage(fauxToolCall("read", { path: filePath }), {
                stopReason: "toolUse",
            }),
            // Turn 2: edit — but a factory callback mutates the file first
            ((_context, _options, _state) => {
                // Use a factory response to modify the file right
                // before the LLM "responds" with the edit request.
                writeFileSync(filePath, "externally modified");
                return fauxAssistantMessage(
                    fauxToolCall("edit", {
                        path: filePath,
                        edits: [
                            {
                                oldText: "initial",
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
        expect(editEv!.isError).toBe(true);
        expect(resultText(editEv!)).toContain("mtime mismatch");
    });

    // ── Failed read does not count as "read" ───────────────────────

    it("blocks edit after a failed read (non-existent file)", async () => {
        const missingPath = join(tmpDir, "does-not-exist.txt");
        const existingPath = join(tmpDir, "real.txt");
        await writeFile(existingPath, "content");

        const events = await runAgent(tmpDir, faux, [
            // Turn 1: read a non-existent file → error
            fauxAssistantMessage(fauxToolCall("read", { path: missingPath }), {
                stopReason: "toolUse",
            }),
            // Turn 2: try to edit that non-existent path
            // (it doesn't exist on disk → ENOENT → allowed as new file)
            // So instead we test with the existing file that was never read:
            fauxAssistantMessage(
                fauxToolCall("edit", {
                    path: existingPath,
                    edits: [
                        {
                            oldText: "content",
                            newText: "hacked",
                        },
                    ],
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("ok")),
        ]);

        const editEv = events.find((e) => e.toolName === "edit");
        expect(editEv).toBeDefined();
        expect(editEv!.isError).toBe(true);
        expect(resultText(editEv!)).toContain("has not been read");
    });

    // ── Consecutive edits after read → second edit allowed ─────────

    it("allows consecutive edits (mtime updated after first edit)", async () => {
        const filePath = join(tmpDir, "multi.txt");
        await writeFile(filePath, "aaa bbb");

        const events = await runAgent(tmpDir, faux, [
            // Turn 1: read
            fauxAssistantMessage(fauxToolCall("read", { path: filePath }), {
                stopReason: "toolUse",
            }),
            // Turn 2: first edit
            fauxAssistantMessage(
                fauxToolCall("edit", {
                    path: filePath,
                    edits: [{ oldText: "aaa", newText: "AAA" }],
                }),
                { stopReason: "toolUse" },
            ),
            // Turn 3: second edit
            fauxAssistantMessage(
                fauxToolCall("edit", {
                    path: filePath,
                    edits: [{ oldText: "bbb", newText: "BBB" }],
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);

        const edits = events.filter((e) => e.toolName === "edit");
        expect(edits).toHaveLength(2);
        expect(edits[0].isError).toBe(false);
        expect(edits[1].isError).toBe(false);
        expect(await readFile(filePath, "utf-8")).toBe("AAA BBB");
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
            // Use absolute path for edit (same file)
            fauxAssistantMessage(
                fauxToolCall("edit", {
                    path: filePath,
                    edits: [
                        {
                            oldText: "relative test",
                            newText: "relative done",
                        },
                    ],
                }),
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxText("done")),
        ]);

        const editEv = events.find((e) => e.toolName === "edit");
        expect(editEv).toBeDefined();
        expect(editEv!.isError).toBe(false);
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
