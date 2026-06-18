/**
 * Pure lookup logic for subagent_resume.
 *
 * Scans session entries to find a matching subagent session reference
 * by ID. Extracted as a testable pure function.
 */

import type { SubagentDetails, SubagentToolParams } from "./types.js";
import { BACKGROUND_RESULT_TYPE } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * A terminal (completed/failed/cancelled) subagent session entry.
 * Used by the `/subagent attach` command to present a picker.
 */
export interface CompletedSubagent {
    /** Same value as session.id; this is the ID shown to users. */
    id: string;
    details: SubagentDetails;
    session: { dir: string; id: string };
    originalParams?: SubagentToolParams;
}

type LookupResult =
    | {
          found: true;
          details: SubagentDetails;
          session: { dir: string; id: string };
          /** The original subagent tool call params, if recoverable. */
          originalParams?: SubagentToolParams;
      }
    | { found: false; error: "not_found"; availableIds: string[] }
    | { found: false; error: "no_session_info"; id: string };

// ── Entry iteration type ─────────────────────────────────────────────

/**
 * Minimal entry shape needed for the lookup.
 * Matches both SessionMessageEntry and CustomMessageEntry from the
 * session manager without importing the full union.
 */
export type LookupEntry =
    | {
          type: "message";
          message: {
              role: string;
              toolCallId?: string;
              toolName?: string;
              content?: unknown;
              details?: unknown;
          };
      }
    | { type: "custom_message"; customType: string; details?: unknown }
    | { type: string };

// ── listCompletedSubagents ───────────────────────────────────────────

/**
 * Collect all terminal subagent sessions from the parent session entries.
 *
 * Includes:
 * - Foreground subagent tool-result entries (details.kind === "foreground")
 *   with a valid session field.
 * - Background terminal result custom messages
 *   (customType === BACKGROUND_RESULT_TYPE, details.kind === "background")
 *   with a valid session field.
 *
 * Skips:
 * - Background **start** tool-result entries (details.kind === "background"
 *   on the initial subagent tool result). Those are not terminal.
 * - Entries without session info.
 *
 * Deduplication: Iterates in chronological array order; later entries
 * overwrite earlier entries with the same session.id, so the last
 * encountered terminal record is kept.
 */
export function listCompletedSubagents(
    entries: readonly LookupEntry[],
): CompletedSubagent[] {
    // Single pass: assistant messages always precede their corresponding
    // tool results in chronological order, so forward lookups work.
    const toolCallParamsMap = new Map<string, SubagentToolParams>();
    const sessionParamsMap = new Map<string, SubagentToolParams>();
    const result = new Map<string, CompletedSubagent>();

    for (const entry of entries) {
        if (entry.type === "message" && "message" in entry) {
            const msg = entry.message;

            if (msg.role === "assistant" && Array.isArray(msg.content)) {
                for (const block of msg.content as any[]) {
                    if (
                        block.type === "toolCall" &&
                        block.toolName === "subagent" &&
                        block.id &&
                        block.arguments
                    ) {
                        toolCallParamsMap.set(block.id, block.arguments);
                    }
                }
            } else if (msg.role === "toolResult" && msg.toolName === "subagent") {
                const details = msg.details as SubagentDetails | undefined;
                if (!details?.session?.id) continue;

                // Track session -> params for background custom
                // messages that lack a toolCallId.
                if (msg.toolCallId) {
                    const params = toolCallParamsMap.get(msg.toolCallId);
                    if (params) {
                        sessionParamsMap.set(details.session.id, params);
                    }
                }

                // Skip background START entries (not terminal).
                if (details.kind === "background") continue;

                // Foreground entries are always terminal.
                if (details.kind === "foreground") {
                    const params = msg.toolCallId
                        ? toolCallParamsMap.get(msg.toolCallId)
                        : sessionParamsMap.get(details.session.id);
                    result.set(details.session.id, {
                        id: details.session.id,
                        details,
                        session: details.session,
                        originalParams: params,
                    });
                }
            }
        } else if (entry.type === "custom_message") {
            const cm = entry as {
                type: "custom_message";
                customType: string;
                details?: unknown;
            };
            if (cm.customType !== BACKGROUND_RESULT_TYPE) continue;
            const details = cm.details as SubagentDetails | undefined;
            if (!details || details.kind !== "background" || !details.session?.id)
                continue;

            // Background custom messages are always terminal
            // (completed, failed, or cancelled).
            result.set(details.session.id, {
                id: details.session.id,
                details,
                session: details.session,
                originalParams: sessionParamsMap.get(details.session.id),
            });
        }
    }

    return [...result.values()];
}

// ── Lookup function ──────────────────────────────────────────────────

/**
 * Find a completed subagent session by ID.
 *
 * Returns the matched SubagentDetails + session ref + original params,
 * or a typed error (not_found with available IDs, or no_session_info
 * for entries that predate session persistence).
 */
export function lookupSubagentSession(
    entries: readonly LookupEntry[],
    targetId: string,
): LookupResult {
    const completed = listCompletedSubagents(entries);
    const match = completed.find((c) => c.id === targetId);

    if (match) {
        return {
            found: true,
            details: match.details,
            session: match.session,
            originalParams: match.originalParams,
        };
    }

    // Check for old entries that predate session support.
    for (const entry of entries) {
        if (entry.type !== "message" || !("message" in entry)) continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "subagent") continue;
        const details = msg.details as SubagentDetails | undefined;
        if (!details) continue;
        if (
            !details.session &&
            details.result?.agent &&
            targetId.startsWith(details.result.agent)
        ) {
            return {
                found: false,
                error: "no_session_info",
                id: targetId,
            };
        }
    }

    return {
        found: false,
        error: "not_found",
        availableIds: completed.map((c) => c.id),
    };
}
