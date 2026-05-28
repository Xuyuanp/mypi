/**
 * Auto-generates a short session title from the first user/assistant exchange.
 *
 * Triggers on `turn_end` after the first complete turn. Uses a lightweight
 * model (claude-haiku) to produce a 4-word-or-less title. Falls back to a
 * truncated snippet of the user message if all LLM attempts fail.
 *
 * Exports pure helpers (`buildFallbackTitle`, `postProcessTitle`) and the
 * async `generateTitle` / `generateAndSetTitle` for testability.
 */

import process from "node:process";
import {
    type AssistantMessage,
    completeSimple,
    type Message,
    type TextContent,
    type UserMessage,
} from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TITLE_MODEL_PROVIDER = process.env.PI_TITLE_MODEL_PROVIDER ?? "anthropic";
const TITLE_MODEL_NAME = process.env.PI_TITLE_MODEL_NAME ?? "claude-haiku-4-5";

const TITLE_MODEL = {
    provider: TITLE_MODEL_PROVIDER,
    model: TITLE_MODEL_NAME,
} as const;

const MAX_TITLE_LENGTH = 50;
const MAX_RETRIES = 2;
const FALLBACK_LENGTH = 50;

const TITLE_PROMPT = `Generate a short title (four words or less) that describes the topic of the user's messages.
Reply with only the title, nothing else. Do not show your reasoning.

Examples:
- "how do I reverse a list in python?" → Python list reversal
- "what's the weather in Tokyo?" → Tokyo weather
- "explain how transformers work in ML" → ML transformers explained`;

export function buildFallbackTitle(userText: string): string {
    const text = userText.trim();
    if (text.length <= FALLBACK_LENGTH) return text;
    const truncated = text.slice(0, FALLBACK_LENGTH - 3);
    const lastSpace = truncated.lastIndexOf(" ");
    return `${lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated}...`;
}

export function postProcessTitle(raw: string): string {
    let title = raw;

    // Strip <think>...</think> tags (some models leak these)
    title = title.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

    // Strip wrapping quotes (single, double, backticks)
    title = title.replace(/^["'`]+|["'`]+$/g, "");

    // Strip markdown formatting (bold, italic, headers)
    title = title.replace(/^#+\s*/, "");
    title = title.replace(/\*{1,2}(.*?)\*{1,2}/g, "$1");
    title = title.replace(/_{1,2}(.*?)_{1,2}/g, "$1");

    // Strip meta-prefixes the model might add despite instructions
    title = title.replace(/^(Title|Summary|Session)\s*:\s*/i, "");

    // Take first non-empty line only
    title =
        title
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? title;

    // Trim whitespace
    title = title.trim();

    // Enforce max length: truncate at word boundary, add "..." if truncated
    if (title.length > MAX_TITLE_LENGTH) {
        const truncated = title.slice(0, MAX_TITLE_LENGTH - 3);
        const lastSpace = truncated.lastIndexOf(" ");
        title = `${lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated}...`;
    }

    return title;
}

export async function generateTitle(
    userText: string,
    assistantText: string,
    ctx: ExtensionContext,
): Promise<string> {
    const model = ctx.modelRegistry.find(TITLE_MODEL.provider, TITLE_MODEL.model);
    if (!model) {
        throw new Error(
            `Model not found: ${TITLE_MODEL.provider}/${TITLE_MODEL.model}`,
        );
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
        throw new Error(`No API key for provider: ${TITLE_MODEL.provider}`);
    }

    // TODO: set temperature to 0.3 when pi-ai exposes it
    const contextParts = [`User message:\n${userText}`];
    if (assistantText) {
        contextParts.push(`Assistant response:\n${assistantText}`);
    }

    const messages: Message[] = [
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: `${contextParts.join("\n\n")}\n\nGenerate a title for this conversation.`,
                },
            ],
            timestamp: Date.now(),
        },
    ];

    const response = await completeSimple(
        model,
        { systemPrompt: TITLE_PROMPT, messages },
        { apiKey: auth.apiKey, headers: auth.headers },
    );

    const raw = response.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();

    return postProcessTitle(raw);
}

export function getFirstUserText(ctx: ExtensionContext): string | null {
    const entries = ctx.sessionManager.getEntries();
    const firstUserEntry = entries.find(
        (e) => e.type === "message" && e.message.role === "user",
    );
    if (!firstUserEntry || firstUserEntry.type !== "message") return null;

    const msg = firstUserEntry.message as UserMessage;
    if (typeof msg.content === "string") {
        return msg.content;
    }
    return msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join(" ");
}

export function getFirstAssistantText(ctx: ExtensionContext): string | null {
    const entries = ctx.sessionManager.getEntries();
    const firstAssistantEntry = entries.find(
        (e) => e.type === "message" && e.message.role === "assistant",
    );
    if (!firstAssistantEntry || firstAssistantEntry.type !== "message") return null;

    const msg = firstAssistantEntry.message as AssistantMessage;
    // Filter for text content only -- this naturally excludes thinking blocks
    // which have type "thinking", not "text".
    return msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
}

export async function generateAndSetTitle(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    isActive: () => boolean = () => true,
): Promise<void> {
    const userText = getFirstUserText(ctx);
    if (!userText?.trim()) {
        ctx.ui.notify("No user message to generate title from", "warning");
        return;
    }

    const assistantText = getFirstAssistantText(ctx) ?? "";

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const title = await generateTitle(userText, assistantText, ctx);
            if (!isActive()) return;
            if (!title) {
                lastError = new Error("Model returned empty title");
                if (attempt < MAX_RETRIES) {
                    ctx.ui.notify(
                        `Title generation returned empty (attempt ${attempt}/${MAX_RETRIES}), retrying...`,
                        "warning",
                    );
                }
                continue;
            }
            pi.setSessionName(title);
            ctx.ui.notify(`Session: ${title}`, "info");
            return;
        } catch (error) {
            if (!isActive()) return;
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < MAX_RETRIES) {
                ctx.ui.notify(
                    `Title generation failed ${lastError} (attempt ${attempt}/${MAX_RETRIES}), retrying...`,
                    "warning",
                );
            }
        }
    }

    if (!isActive()) return;

    // All retries exhausted -- fallback
    const fallback = buildFallbackTitle(userText);
    pi.setSessionName(fallback);
    ctx.ui.notify(`Title generation failed, using fallback: ${fallback}`, "error");
}

interface SessionNameState {
    hasAutoNamed: boolean;
    sessionActive: boolean;
}

export default function sessionNameExtension(pi: ExtensionAPI) {
    const state: SessionNameState = {
        hasAutoNamed: false,
        sessionActive: false,
    };

    pi.on("session_start", async () => {
        state.hasAutoNamed = false;
        state.sessionActive = true;
    });

    pi.on("session_shutdown", async () => {
        state.sessionActive = false;
    });

    pi.on("turn_end", async (_event, ctx) => {
        if (!state.sessionActive || state.hasAutoNamed) return;

        if (pi.getSessionName()) {
            state.hasAutoNamed = true;
            return;
        }

        await generateAndSetTitle(pi, ctx, () => state.sessionActive);
        // Always mark as named: if session became inactive mid-call,
        // this is harmless -- state resets on next session_start.
        state.hasAutoNamed = true;
    });
}
