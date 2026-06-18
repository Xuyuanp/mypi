/**
 * Tests for subagent_resume tool (issue #13) and listCompletedSubagents.
 *
 * Tests cover:
 * - Lookup function: found in foreground, found in background, not found, missing session field
 * - Error messages for each error case
 * - Session ID collection for "available sessions" hint
 * - listCompletedSubagents: terminal session collection, filtering, deduplication, params recovery
 */

import { describe, expect, it } from "vitest";
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
});
