/**
 * Session state helpers and assistant snapshot utilities.
 *
 * Functions for reading/writing review session state from the
 * session tree, and for inspecting assistant message snapshots
 * used by the loop-fixing logic.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
    AssistantSnapshot,
    ReviewSessionState,
    ReviewSettingsState,
} from "./types.js";
import {
    REVIEW_LOOP_START_POLL_MS,
    REVIEW_LOOP_START_TIMEOUT_MS,
    REVIEW_SETTINGS_TYPE,
    REVIEW_STATE_TYPE,
} from "./types.js";

export function getReviewState(
    ctx: ExtensionContext,
): ReviewSessionState | undefined {
    let state: ReviewSessionState | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
            state = entry.data as ReviewSessionState | undefined;
        }
    }
    return state;
}

export function getReviewSettings(ctx: ExtensionContext): ReviewSettingsState {
    let state: ReviewSettingsState | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === REVIEW_SETTINGS_TYPE) {
            state = entry.data as ReviewSettingsState | undefined;
        }
    }
    return {
        loopFixingEnabled: state?.loopFixingEnabled === true,
    };
}

function extractAssistantTextContent(content: unknown): string {
    if (typeof content === "string") {
        return content.trim();
    }

    if (!Array.isArray(content)) {
        return "";
    }

    const textParts = content
        .filter((part): part is { type: "text"; text: string } =>
            Boolean(
                part &&
                    typeof part === "object" &&
                    "type" in part &&
                    part.type === "text" &&
                    "text" in part,
            ),
        )
        .map((part) => part.text);
    return textParts.join("\n").trim();
}

export function getLastAssistantSnapshot(
    ctx: ExtensionContext,
): AssistantSnapshot | null {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }

        const assistantMessage = entry.message as {
            content?: unknown;
            stopReason?: string;
        };
        return {
            id: entry.id,
            text: extractAssistantTextContent(assistantMessage.content),
            stopReason: assistantMessage.stopReason,
        };
    }

    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForLoopTurnToStart(
    ctx: ExtensionContext,
    previousAssistantId?: string,
): Promise<boolean> {
    const deadline = Date.now() + REVIEW_LOOP_START_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const lastAssistantId = getLastAssistantSnapshot(ctx)?.id;
        if (
            !ctx.isIdle() ||
            ctx.hasPendingMessages() ||
            (lastAssistantId && lastAssistantId !== previousAssistantId)
        ) {
            return true;
        }
        await sleep(REVIEW_LOOP_START_POLL_MS);
    }

    return false;
}
