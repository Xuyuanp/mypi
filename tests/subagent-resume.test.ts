/**
 * Tests for subagent_resume tool (issue #13) and listCompletedSubagents.
 *
 * Tests cover:
 * - Lookup function: found in foreground, found in background, not found, missing session field
 * - Error messages for each error case
 * - Session ID collection for "available sessions" hint
 * - listCompletedSubagents: terminal session collection, filtering, deduplication, params recovery
 * - Execute-handler integration: fork-on-resume behavior
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../extensions/subagent/execute.js", () => ({
    runSubagent: vi.fn(),
    buildSubagentCommand: vi.fn(),
    getPiInvocation: vi.fn(),
}));

import { createZeroUsage } from "../extensions/subagent/index.js";
import {
    type LookupEntry,
    listCompletedSubagents,
    lookupSubagentSession,
} from "../extensions/subagent/resume.js";
import type {
    AgentRunResult,
    SubagentDetails,
} from "../extensions/subagent/types.js";
import { BACKGROUND_RESULT_TYPE } from "../extensions/subagent/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

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

function makeForegroundEntry(
    session?: { dir: string; id: string },
    agentName = "scout",
): LookupEntry {
    const details: SubagentDetails = {
        kind: "foreground",
        result: makeFakeResult({ agent: agentName }),
        execStatuses: {},
        session,
    };
    return {
        type: "message",
        message: {
            role: "toolResult",
            toolName: "subagent",
            details,
        },
    };
}

function makeBackgroundEntry(
    session?: { dir: string; id: string },
    agentName = "worker",
): LookupEntry {
    const details: SubagentDetails = {
        kind: "background",
        result: makeFakeResult({ agent: agentName }),
        description: "test task",
        cancelled: false,
        session,
    };
    return {
        type: "custom_message",
        customType: BACKGROUND_RESULT_TYPE,
        details,
    };
}

function makeIrrelevantEntry(): LookupEntry {
    return { type: "message", message: { role: "user" } };
}

// ── Lookup tests ─────────────────────────────────────────────────────

describe("lookupSubagentSession", () => {
    it("finds session in foreground tool result", () => {
        const session = { dir: "/tmp/sessions/abc/subagent", id: "scout-a1b2c3d4" };
        const entries: LookupEntry[] = [
            makeIrrelevantEntry(),
            makeForegroundEntry(session),
            makeIrrelevantEntry(),
        ];

        const result = lookupSubagentSession(entries, "scout-a1b2c3d4");

        expect(result.found).toBe(true);
        if (result.found) {
            expect(result.session).toEqual(session);
            expect(result.details.kind).toBe("foreground");
            expect(result.details.result.agent).toBe("scout");
        }
    });

    it("finds session in background custom message", () => {
        const session = { dir: "/tmp/sessions/abc/subagent", id: "worker-e5f6g7h8" };
        const entries: LookupEntry[] = [
            makeIrrelevantEntry(),
            makeBackgroundEntry(session, "worker"),
            makeIrrelevantEntry(),
        ];

        const result = lookupSubagentSession(entries, "worker-e5f6g7h8");

        expect(result.found).toBe(true);
        if (result.found) {
            expect(result.session).toEqual(session);
            expect(result.details.kind).toBe("background");
            expect(result.details.result.agent).toBe("worker");
        }
    });

    it("returns not_found with available IDs when ID does not match", () => {
        const session1 = { dir: "/tmp/s/subagent", id: "scout-11111111" };
        const session2 = { dir: "/tmp/s/subagent", id: "worker-22222222" };
        const entries: LookupEntry[] = [
            makeForegroundEntry(session1),
            makeBackgroundEntry(session2, "worker"),
        ];

        const result = lookupSubagentSession(entries, "reviewer-99999999");

        expect(result.found).toBe(false);
        if (!result.found && result.error === "not_found") {
            expect(result.availableIds).toContain("scout-11111111");
            expect(result.availableIds).toContain("worker-22222222");
        } else {
            expect.unreachable("expected not_found error");
        }
    });

    it("returns no_session_info when entry predates resume support", () => {
        // Entry without session field (predates issue #12)
        const entries: LookupEntry[] = [makeForegroundEntry(undefined, "scout")];

        const result = lookupSubagentSession(entries, "scout-a1b2c3d4");

        expect(result.found).toBe(false);
        if (!result.found && result.error === "no_session_info") {
            expect(result.id).toBe("scout-a1b2c3d4");
        } else {
            expect.unreachable("expected no_session_info error");
        }
    });

    it("returns not_found with empty available list when no entries exist", () => {
        const entries: LookupEntry[] = [makeIrrelevantEntry()];

        const result = lookupSubagentSession(entries, "scout-a1b2c3d4");

        expect(result.found).toBe(false);
        if (!result.found && result.error === "not_found") {
            expect(result.availableIds).toEqual([]);
        } else {
            expect.unreachable("expected not_found error");
        }
    });

    it("deduplicates available IDs when same session appears multiple times", () => {
        const session = { dir: "/tmp/s/subagent", id: "scout-11111111" };
        const entries: LookupEntry[] = [
            makeForegroundEntry(session),
            makeForegroundEntry(session), // same session resumed
        ];

        const result = lookupSubagentSession(entries, "nonexistent-id");

        expect(result.found).toBe(false);
        if (!result.found && result.error === "not_found") {
            expect(result.availableIds).toEqual(["scout-11111111"]);
        } else {
            expect.unreachable("expected not_found error");
        }
    });

    it("ignores custom messages with wrong customType", () => {
        const entries: LookupEntry[] = [
            {
                type: "custom_message",
                customType: "something_else",
                details: {
                    kind: "background",
                    result: makeFakeResult({ agent: "scout" }),
                    description: "test",
                    cancelled: false,
                    session: { dir: "/tmp", id: "scout-a1b2c3d4" },
                },
            },
        ];

        const result = lookupSubagentSession(entries, "scout-a1b2c3d4");

        expect(result.found).toBe(false);
        if (!result.found) {
            expect(result.error).toBe("not_found");
        }
    });

    it("ignores tool results from other tools", () => {
        const entries: LookupEntry[] = [
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "bash",
                    details: {
                        kind: "foreground",
                        result: makeFakeResult(),
                        execStatuses: {},
                        session: { dir: "/tmp", id: "scout-a1b2c3d4" },
                    },
                },
            },
        ];

        const result = lookupSubagentSession(entries, "scout-a1b2c3d4");

        expect(result.found).toBe(false);
    });

    it("prefers entry with session info over one without", () => {
        const session = { dir: "/tmp/s/subagent", id: "scout-a1b2c3d4" };
        const entries: LookupEntry[] = [
            makeForegroundEntry(undefined, "scout"), // old entry without session
            makeForegroundEntry(session, "scout"), // newer entry with session
        ];

        const result = lookupSubagentSession(entries, "scout-a1b2c3d4");

        expect(result.found).toBe(true);
        if (result.found) {
            expect(result.session).toEqual(session);
        }
    });
});

// ── listCompletedSubagents tests ─────────────────────────────────

/** Build a fake assistant tool call message entry. */
function makeAssistantToolCall(
    toolCallId: string,
    params: SubagentToolParams,
): LookupEntry {
    return {
        type: "message",
        message: {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    toolName: "subagent",
                    id: toolCallId,
                    arguments: params,
                },
            ],
        },
    };
}

/** Build a foreground tool result with a toolCallId for param recovery. */
function makeForegroundEntryWithToolCallId(
    session: { dir: string; id: string },
    toolCallId: string,
    agentName = "scout",
): LookupEntry {
    const details: SubagentDetails = {
        kind: "foreground",
        result: makeFakeResult({ agent: agentName }),
        execStatuses: {},
        session,
    };
    return {
        type: "message",
        message: {
            role: "toolResult",
            toolName: "subagent",
            toolCallId,
            details,
        },
    };
}

/** Build a background START tool result (not terminal). */
function makeBackgroundStartEntry(
    session: { dir: string; id: string },
    toolCallId: string,
    agentName = "worker",
): LookupEntry {
    const details: SubagentDetails = {
        kind: "background",
        result: makeFakeResult({ agent: agentName }),
        description: "running task",
        cancelled: false,
        session,
    };
    return {
        type: "message",
        message: {
            role: "toolResult",
            toolName: "subagent",
            toolCallId,
            details,
        },
    };
}

import type { SubagentToolParams } from "../extensions/subagent/types.js";

describe("listCompletedSubagents", () => {
    it("collects foreground and terminal background sessions", () => {
        const fgSession = {
            dir: "/tmp/s/subagent",
            id: "scout-11111111",
        };
        const bgSession = {
            dir: "/tmp/s/subagent",
            id: "worker-22222222",
        };
        const entries: LookupEntry[] = [
            makeForegroundEntry(fgSession, "scout"),
            makeBackgroundEntry(bgSession, "worker"),
        ];

        const result = listCompletedSubagents(entries);

        expect(result).toHaveLength(2);
        expect(result.map((r) => r.id)).toContain("scout-11111111");
        expect(result.map((r) => r.id)).toContain("worker-22222222");
    });

    it("skips running background start entries", () => {
        const bgSession = {
            dir: "/tmp/s/subagent",
            id: "worker-33333333",
        };
        const entries: LookupEntry[] = [
            // This is a background START entry (tool result with
            // kind === "background"). It should NOT appear.
            makeBackgroundStartEntry(bgSession, "tc-1", "worker"),
        ];

        const result = listCompletedSubagents(entries);

        expect(result).toHaveLength(0);
    });

    it("deduplicates by session ID (keeps last terminal entry)", () => {
        const session = {
            dir: "/tmp/s/subagent",
            id: "scout-44444444",
        };
        const details1: SubagentDetails = {
            kind: "foreground",
            result: makeFakeResult({ agent: "scout", task: "first" }),
            execStatuses: {},
            session,
        };
        const details2: SubagentDetails = {
            kind: "foreground",
            result: makeFakeResult({ agent: "scout", task: "second" }),
            execStatuses: {},
            session,
        };
        const entries: LookupEntry[] = [
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "subagent",
                    details: details1,
                },
            },
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "subagent",
                    details: details2,
                },
            },
        ];

        const result = listCompletedSubagents(entries);

        expect(result).toHaveLength(1);
        expect(result[0].details.result.task).toBe("second");
    });

    it("skips entries without session info", () => {
        const entries: LookupEntry[] = [
            makeForegroundEntry(undefined, "scout"), // no session
        ];

        const result = listCompletedSubagents(entries);

        expect(result).toHaveLength(0);
    });

    it("returns empty array when no subagents exist", () => {
        const entries: LookupEntry[] = [
            makeIrrelevantEntry(),
            { type: "message", message: { role: "user" } },
        ];

        const result = listCompletedSubagents(entries);

        expect(result).toEqual([]);
    });

    it("recovers originalParams from foreground tool call", () => {
        const session = {
            dir: "/tmp/s/subagent",
            id: "scout-55555555",
        };
        const params: SubagentToolParams = {
            agent: "scout",
            description: "explore",
            task: "find files",
            cwd: "/custom/path",
        };
        const entries: LookupEntry[] = [
            makeAssistantToolCall("tc-5", params),
            makeForegroundEntryWithToolCallId(session, "tc-5", "scout"),
        ];

        const result = listCompletedSubagents(entries);

        expect(result).toHaveLength(1);
        expect(result[0].originalParams).toEqual(params);
        expect(result[0].originalParams?.cwd).toBe("/custom/path");
    });

    it("recovers originalParams for background custom result via session ID", () => {
        const session = {
            dir: "/tmp/s/subagent",
            id: "worker-66666666",
        };
        const params: SubagentToolParams = {
            agent: "worker",
            description: "build",
            task: "compile project",
            cwd: "/project/root",
            background: true,
        };
        const entries: LookupEntry[] = [
            // 1. Assistant makes the tool call
            makeAssistantToolCall("tc-6", params),
            // 2. Background START tool result (links toolCallId -> session)
            makeBackgroundStartEntry(session, "tc-6", "worker"),
            // 3. Background terminal custom message (no toolCallId)
            makeBackgroundEntry(session, "worker"),
        ];

        const result = listCompletedSubagents(entries);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("worker-66666666");
        expect(result[0].originalParams).toEqual(params);
        expect(result[0].originalParams?.cwd).toBe("/project/root");
    });

    it("collects subagent_resume tool results (fork sessions)", () => {
        const forkSession = {
            dir: "/tmp/s/subagent",
            id: "scout-77777777",
        };
        const details: SubagentDetails = {
            kind: "foreground",
            result: makeFakeResult({ agent: "scout", task: "follow up" }),
            execStatuses: {},
            session: forkSession,
            resumedFrom: "scout-11111111",
        };
        const entries: LookupEntry[] = [
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "subagent_resume",
                    details,
                },
            },
        ];

        const result = listCompletedSubagents(entries);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("scout-77777777");
        expect(result[0].details.resumedFrom).toBe("scout-11111111");
    });

    it("lookup finds a fork session by its new ID", () => {
        const originalSession = {
            dir: "/tmp/s/subagent",
            id: "scout-11111111",
        };
        const forkSession = {
            dir: "/tmp/s/subagent",
            id: "scout-88888888",
        };
        const entries: LookupEntry[] = [
            // Original spawn
            makeForegroundEntry(originalSession, "scout"),
            // Fork from resume
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "subagent_resume",
                    details: {
                        kind: "foreground",
                        result: makeFakeResult({ agent: "scout" }),
                        execStatuses: {},
                        session: forkSession,
                        resumedFrom: "scout-11111111",
                    } as SubagentDetails,
                },
            },
        ];

        // Can find the fork by its ID
        const forkLookup = lookupSubagentSession(entries, "scout-88888888");
        expect(forkLookup.found).toBe(true);
        if (forkLookup.found) {
            expect(forkLookup.session).toEqual(forkSession);
        }

        // Can still find the original
        const origLookup = lookupSubagentSession(entries, "scout-11111111");
        expect(origLookup.found).toBe(true);
        if (origLookup.found) {
            expect(origLookup.session).toEqual(originalSession);
        }
    });
});

// ── subagent_resume execute handler (fork-on-resume) ───────────────

import { runSubagent } from "../extensions/subagent/execute.js";
import subagentExtension from "../extensions/subagent/index.js";
import type {
    PersistedResolvedAgent,
    ToolResult,
} from "../extensions/subagent/types.js";
import { parseModelString } from "../extensions/subagent/types.js";

/** Minimal stub ExtensionAPI that captures registered tools. */
function createStubExtensionAPI() {
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    const api = {
        on: vi.fn(),
        sendMessage: vi.fn(),
        getThinkingLevel: vi.fn().mockReturnValue("off"),
        registerMessageRenderer: vi.fn(),
        registerCommand: vi.fn(),
        registerTool: vi.fn((spec: any) => {
            tools.set(spec.name, spec);
        }),
        registerShortcut: vi.fn(),
    };
    return { api, tools };
}

describe("subagent_resume execute handler (fork-on-resume)", () => {
    let tmpDir: string;
    let sessionDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-fork-test-"));
        sessionDir = path.join(tmpDir, "subagent");
        fs.mkdirSync(sessionDir, { recursive: true });
        vi.mocked(runSubagent).mockReset();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function setupHandler() {
        const { api, tools } = createStubExtensionAPI();
        subagentExtension(api as any);
        const resumeTool = tools.get("subagent_resume")!;
        expect(resumeTool).toBeDefined();
        return resumeTool;
    }

    function makePersistedAgent(): PersistedResolvedAgent {
        return {
            name: "scout",
            tools: ["read", "bash"],
            model: parseModelString("anthropic/claude-sonnet")!,
            source: "system",
        };
    }

    function makeBranchEntries(
        session: { dir: string; id: string },
        resolvedAgent: PersistedResolvedAgent,
    ): LookupEntry[] {
        const details: SubagentDetails = {
            kind: "foreground",
            result: makeFakeResult({ agent: "scout" }),
            execStatuses: {},
            session,
            resolvedAgent,
        };
        return [
            { type: "message", message: { role: "user" } },
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "subagent",
                    details,
                },
            },
        ];
    }

    it("forks session and returns new ID", async () => {
        // Create the original subagent session file
        const originalId = "scout-aaaaaaaa";
        const originalContent =
            '{"type":"session","version":3,"id":"uuid"}\n' +
            '{"type":"message","id":"m1","message":{"role":"user","content":"original task"}}\n';
        const originalFile = path.join(sessionDir, `${originalId}.jsonl`);
        fs.writeFileSync(originalFile, originalContent);

        const session = { dir: sessionDir, id: originalId };
        const resolvedAgent = makePersistedAgent();
        const entries = makeBranchEntries(session, resolvedAgent);

        // Mock runSubagent to return a successful result
        const fakeRunResult = {
            agent: "scout",
            agentSource: "system",
            task: "follow up question",
            outcome: { status: "success" },
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Here is my answer" }],
                } as any,
            ],
            stderr: "",
            usage: createZeroUsage(),
            durationMs: 100,
        };
        vi.mocked(runSubagent).mockResolvedValue(fakeRunResult);

        const resumeTool = setupHandler();
        const ctx = {
            sessionManager: { getBranch: () => entries },
            cwd: tmpDir,
            model: {
                provider: "anthropic",
                id: "claude-sonnet",
                contextWindow: 200000,
            },
            modelRegistry: {
                find: () => ({ contextWindow: 200000 }),
            },
        };

        const result: ToolResult = await resumeTool.execute(
            "call-1",
            { id: originalId, follow_up: "follow up question" },
            undefined, // signal
            undefined, // onUpdate
            ctx,
        );

        // 1. Result should not be an error
        expect(result.isError).toBeFalsy();

        // 2. Result content should contain a NEW session ID (not the original)
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("[subagent:");
        expect(text).not.toContain(`[subagent: ${originalId}]`);

        // 3. details.session.id should be the new ID
        expect(result.details).toBeDefined();
        expect(result.details!.session).toBeDefined();
        expect(result.details!.session!.id).not.toBe(originalId);
        expect(result.details!.session!.id).toMatch(/^scout-[0-9a-f]{8}$/);

        // 4. details.resumedFrom should be the original ID
        expect(result.details!.resumedFrom).toBe(originalId);

        // 5. Original file should be unchanged
        expect(fs.readFileSync(originalFile, "utf-8")).toBe(originalContent);

        // 6. Fork file should exist with the original content
        const newId = result.details!.session!.id;
        const forkFile = path.join(sessionDir, `${newId}.jsonl`);
        expect(fs.existsSync(forkFile)).toBe(true);
        expect(fs.readFileSync(forkFile, "utf-8")).toBe(originalContent);

        // 7. runSubagent was called with the fork file path
        expect(runSubagent).toHaveBeenCalledTimes(1);
        const callArgs = vi.mocked(runSubagent).mock.calls[0];
        expect(callArgs[3].sessionFile).toBe(forkFile);
        expect(callArgs[3].resume).toBe(true);
    });

    it("returns error when original file is missing on disk", async () => {
        const originalId = "scout-bbbbbbbb";
        // Don't create the file -- simulate it being deleted after session entry was stored
        const session = { dir: sessionDir, id: originalId };
        const resolvedAgent = makePersistedAgent();
        const entries = makeBranchEntries(session, resolvedAgent);

        const resumeTool = setupHandler();
        const ctx = {
            sessionManager: { getBranch: () => entries },
            cwd: tmpDir,
            model: {
                provider: "anthropic",
                id: "claude-sonnet",
                contextWindow: 200000,
            },
            modelRegistry: {
                find: () => ({ contextWindow: 200000 }),
            },
        };

        const result: ToolResult = await resumeTool.execute(
            "call-2",
            { id: originalId, follow_up: "question" },
            undefined,
            undefined,
            ctx,
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("not found on disk");
    });

    it("returns error when fork copy fails", async () => {
        const originalId = "scout-cccccccc";
        const originalFile = path.join(sessionDir, `${originalId}.jsonl`);
        fs.writeFileSync(originalFile, '{"type":"session"}\n');

        const session = { dir: sessionDir, id: originalId };
        const resolvedAgent = makePersistedAgent();
        const entries = makeBranchEntries(session, resolvedAgent);

        const resumeTool = setupHandler();

        // Make session dir read-only so copyFile fails with EACCES
        fs.chmodSync(sessionDir, 0o555);

        const ctx = {
            sessionManager: { getBranch: () => entries },
            cwd: tmpDir,
            model: {
                provider: "anthropic",
                id: "claude-sonnet",
                contextWindow: 200000,
            },
            modelRegistry: {
                find: () => ({ contextWindow: 200000 }),
            },
        };

        try {
            const result: ToolResult = await resumeTool.execute(
                "call-3",
                { id: originalId, follow_up: "question" },
                undefined,
                undefined,
                ctx,
            );

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("Failed to fork session");
        } finally {
            // Restore permissions for cleanup
            fs.chmodSync(sessionDir, 0o755);
        }
    });
});
