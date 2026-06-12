/**
 * Tests for subagent_resume tool (issue #13).
 *
 * Tests cover:
 * - Lookup function: found in foreground, found in background, not found, missing session field
 * - Error messages for each error case
 * - Session ID collection for "available sessions" hint
 */

import { describe, expect, it } from "vitest";
import {
    lookupSubagentSession,
    type LookupEntry,
} from "../extensions/subagent/resume.js";
import { createZeroUsage } from "../extensions/subagent/index.js";
import { BACKGROUND_RESULT_TYPE } from "../extensions/subagent/background.js";
import type {
    AgentRunResult,
    BackgroundSubagentDetails,
    ForegroundSubagentDetails,
} from "../extensions/subagent/types.js";

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
        ...overrides,
    };
}

function makeForegroundEntry(
    session?: { dir: string; id: string },
    agentName = "scout",
): LookupEntry {
    const details: ForegroundSubagentDetails = {
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
    const details: BackgroundSubagentDetails = {
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
        if (!result.found) {
            expect(result.error).toBe("not_found");
            expect(result.availableIds).toContain("scout-11111111");
            expect(result.availableIds).toContain("worker-22222222");
        }
    });

    it("returns no_session_info when entry predates resume support", () => {
        // Entry without session field (predates issue #12)
        const entries: LookupEntry[] = [
            makeForegroundEntry(undefined, "scout"),
        ];

        const result = lookupSubagentSession(entries, "scout-a1b2c3d4");

        expect(result.found).toBe(false);
        if (!result.found) {
            expect(result.error).toBe("no_session_info");
            expect(result.id).toBe("scout-a1b2c3d4");
        }
    });

    it("returns not_found with empty available list when no entries exist", () => {
        const entries: LookupEntry[] = [makeIrrelevantEntry()];

        const result = lookupSubagentSession(entries, "scout-a1b2c3d4");

        expect(result.found).toBe(false);
        if (!result.found) {
            expect(result.error).toBe("not_found");
            expect(result.availableIds).toEqual([]);
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
        if (!result.found) {
            expect(result.error).toBe("not_found");
            expect(result.availableIds).toEqual(["scout-11111111"]);
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
            makeForegroundEntry(session, "scout"),   // newer entry with session
        ];

        const result = lookupSubagentSession(entries, "scout-a1b2c3d4");

        expect(result.found).toBe(true);
        if (result.found) {
            expect(result.session).toEqual(session);
        }
    });
});
