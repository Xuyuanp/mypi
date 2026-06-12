/**
 * Pure lookup logic for subagent_resume.
 *
 * Scans session entries to find a matching subagent session reference
 * by ID. Extracted as a testable pure function.
 */

import { BACKGROUND_RESULT_TYPE } from "./background.js";
import type { SubagentDetails } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export type LookupResult =
    | { found: true; details: SubagentDetails; session: { dir: string; id: string } }
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
          message: { role: string; toolName?: string; details?: unknown };
      }
    | { type: "custom_message"; customType: string; details?: unknown }
    | { type: string };

// ── Lookup function ──────────────────────────────────────────────────

/**
 * Scan session entries for a subagent session matching the given ID.
 *
 * Searches both:
 * - Tool result messages (role "toolResult", toolName "subagent") with details.session.id
 * - Custom messages (type "subagent_background_result") with details.session.id
 *
 * Returns the matched SubagentDetails + session ref, or a typed error.
 */
export function lookupSubagentSession(
    entries: readonly LookupEntry[],
    targetId: string,
): LookupResult {
    const availableIds = new Set<string>();
    let matchedDetails: SubagentDetails | undefined;
    let matchedSession: { dir: string; id: string } | undefined;
    let noSessionCandidate = false;

    for (const entry of entries) {
        if (entry.type === "message" && "message" in entry) {
            const msg = entry.message;
            if (msg.role !== "toolResult" || msg.toolName !== "subagent") continue;
            const details = msg.details as SubagentDetails | undefined;
            if (
                !details ||
                (details.kind !== "foreground" && details.kind !== "background")
            )
                continue;

            const session = details.session;
            if (session?.id) {
                availableIds.add(session.id);
                if (session.id === targetId) {
                    matchedDetails = details;
                    matchedSession = session;
                }
            } else if (
                details.result?.agent &&
                targetId.startsWith(details.result.agent)
            ) {
                noSessionCandidate = true;
            }
        } else if (entry.type === "custom_message") {
            const cm = entry as {
                type: "custom_message";
                customType: string;
                details?: unknown;
            };
            if (cm.customType !== BACKGROUND_RESULT_TYPE) continue;
            const details = cm.details as SubagentDetails | undefined;
            if (!details || details.kind !== "background") continue;

            const session = details.session;
            if (session?.id) {
                availableIds.add(session.id);
                if (session.id === targetId) {
                    matchedDetails = details;
                    matchedSession = session;
                }
            }
        }
    }

    if (matchedDetails && matchedSession) {
        return { found: true, details: matchedDetails, session: matchedSession };
    }

    if (noSessionCandidate) {
        return { found: false, error: "no_session_info", id: targetId };
    }

    return {
        found: false,
        error: "not_found",
        availableIds: [...availableIds],
    };
}
