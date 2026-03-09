/**
 * NIS (Next Input Suggestion) Extension
 *
 * Predicts the next message the user will send based on recent conversation
 * context, using a cheap and fast model (claude-haiku-4-5 by default).
 *
 * After each assistant turn ends, the extension fires a background prediction
 * request. The prediction is displayed as inline ghost text in the editor via
 * the ghost-editor extension's EventBus protocol. If the user presses Tab
 * while the editor is empty, the prediction is accepted.
 *
 * Behaviour:
 * - Prediction runs after every agent_end.
 * - Only the latest prediction is kept; a new turn discards the old one.
 * - Ghost text disappears as soon as the user starts typing (handled by ghost-editor).
 * - /nis command toggles the feature on/off.
 * - Ctrl+Shift+N also toggles.
 *
 * Requires: ghost-editor extension (for inline display).
 */

import type {
    AssistantMessage,
    Message,
    TextContent,
    UserMessage,
} from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const PREDICTION_MODEL = {
    provider: "anthropic",
    model: "claude-haiku-4-5",
} as const;

const MAX_CONTEXT_MESSAGES = 10;
const MAX_PREDICTION_LENGTH = 200;

const GHOST_TEXT_SET = "ghost-text:set";
const GHOST_TEXT_CLEAR = "ghost-text:clear";

const PREDICTION_PROMPT = `You are the predictive autocomplete engine for an AI coding agent's input interface. Your sole purpose is to predict the user's exact next keystrokes or command based on the immediate conversation history.

Strict Rules:
1. RAW OUTPUT ONLY: Output nothing but the exact text the user is most likely to type next.
2. NO CHATTER: Do not include explanations, greetings, acknowledgments, or conversational filler.
3. NO FORMATTING: Do not wrap the output in quotes, markdown, or code blocks.
4. ACTION ORIENTED: Predict standard developer commands (e.g., shell commands, git operations), agent-specific commands (e.g., "/approve", "yes", "undo"), or short follow-up questions.
5. CONTEXTUAL AWARENESS:
   - If the AI just proposed a plan, predict the confirmation command.
   - If a test failed, predict the command to view logs or fix the specific file.
   - If a deployment succeeded, predict the command to check the status or move to the next logical task.
6. SILENCE ON UNCERTAINTY: If there is no high-probability prediction, output an empty string.

Analyze the provided conversation history and immediately output the predicted raw string.
`;
// const PREDICTION_PROMPT = `You are a conversational prediction engine. Based on the conversation between a user and a coding assistant, predict the most likely next message the user will send.
//
// Rules:
// - Output ONLY the predicted user message. Nothing else.
// - Keep it concise and natural -- match the user's typical style and language.
// - If the assistant just completed a task, predict a follow-up or confirmation.
// - If the assistant asked a question, predict the user's answer.
// - If the assistant showed results, predict what the user might ask next.
// - Match the user's language (e.g. if they write in Chinese, predict in Chinese).
// - Keep the prediction under 200 characters when possible.
// - Do NOT wrap in quotes or add meta-commentary.
// - Do NOT predict tool calls or system messages.
// - Do NOT starts with "Can you", "What about", "Next message:", "Prediction:", "I think", or similar meta-prefixes. Output the raw predicted user message as-is. Examples: "create a new ...", "continue next step".
// - If the last assistant message ends with an open question or prompt, the prediction should be a direct answer or continuation. If the last assistant message is a statement of work done, the prediction should be a follow-up question, confirmation, or next step.
// `;

function extractTextFromUser(msg: UserMessage): string {
    if (typeof msg.content === "string") return msg.content;
    return msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join(" ");
}

function extractTextFromAssistant(msg: AssistantMessage): string {
    return msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
}

function getRecentMessages(ctx: ExtensionContext): Message[] {
    const entries = ctx.sessionManager.getEntries();
    const messages: Message[] = [];

    for (const entry of entries) {
        if ((entry as any).type !== "message") continue;
        const msg = (entry as any).message;
        if (!msg) continue;
        if (msg.role === "user" || msg.role === "assistant") {
            messages.push(msg);
        }
    }

    return messages.slice(-MAX_CONTEXT_MESSAGES);
}

function buildPredictionContext(recentMessages: Message[]): Message[] {
    const contextMessages: Message[] = [];

    for (const msg of recentMessages) {
        if (msg.role === "user") {
            const text = extractTextFromUser(msg as UserMessage);
            if (text.trim()) {
                contextMessages.push({
                    role: "user",
                    content: [{ type: "text", text: `[User]: ${text}` }],
                    timestamp: Date.now(),
                });
            }
        } else if (msg.role === "assistant") {
            const text = extractTextFromAssistant(msg as AssistantMessage);
            if (text.trim()) {
                const truncated = text.length > 500 ? text.slice(-500) : text;
                contextMessages.push({
                    role: "user",
                    content: [{ type: "text", text: `[Assistant]: ${truncated}` }],
                    timestamp: Date.now(),
                });
            }
        }
    }

    contextMessages.push({
        role: "user",
        content: [
            { type: "text", text: "Predict the next message the user will send." },
        ],
        timestamp: Date.now(),
    });

    return contextMessages;
}

function postProcessPrediction(raw: string): string {
    let text = raw;

    // Strip <think>...</think> tags
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

    // Strip wrapping quotes
    text = text.replace(/^["'`]+|["'`]+$/g, "");

    // Strip meta-prefixes
    text = text.replace(/^(User|Prediction|Next message|Message)\s*:\s*/i, "");

    // Take first non-empty line
    text =
        text
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? text;

    text = text.trim();

    // Enforce max length
    if (text.length > MAX_PREDICTION_LENGTH) {
        const truncated = text.slice(0, MAX_PREDICTION_LENGTH - 3);
        const lastSpace = truncated.lastIndexOf(" ");
        text = `${lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated}...`;
    }

    return text;
}

export default function nisExtension(pi: ExtensionAPI) {
    let enabled = true;
    let predictionAbortController: AbortController | null = null;

    function clearGhostText() {
        pi.events.emit(GHOST_TEXT_CLEAR, undefined);
    }

    function setGhostText(text: string) {
        pi.events.emit(GHOST_TEXT_SET, text);
    }

    function abortPendingPrediction() {
        if (predictionAbortController) {
            predictionAbortController.abort();
            predictionAbortController = null;
        }
    }

    async function generatePrediction(
        ctx: ExtensionContext,
    ): Promise<string | null> {
        const model = ctx.modelRegistry.find(
            PREDICTION_MODEL.provider,
            PREDICTION_MODEL.model,
        );
        if (!model) return null;

        const apiKey = await ctx.modelRegistry.getApiKey(model);
        if (!apiKey) return null;

        const recentMessages = getRecentMessages(ctx);
        if (recentMessages.length === 0) return null;

        const messages = buildPredictionContext(recentMessages);

        abortPendingPrediction();
        predictionAbortController = new AbortController();

        const response = await completeSimple(
            model,
            { systemPrompt: PREDICTION_PROMPT, messages },
            { apiKey, signal: predictionAbortController.signal },
        );

        predictionAbortController = null;

        const raw = response.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("")
            .trim();

        if (!raw) return null;

        return postProcessPrediction(raw);
    }

    function updateStatus(ctx: ExtensionContext) {
        if (ctx.hasUI) {
            ctx.ui.setStatus(
                "nis",
                enabled
                    ? ctx.ui.theme.fg("dim", "nis:on")
                    : ctx.ui.theme.fg("warning", "nis:off"),
            );
        }
    }

    // Toggle command
    pi.registerCommand("nis", {
        description: "Toggle next input suggestion (NIS)",
        handler: async (_args, ctx) => {
            enabled = !enabled;
            if (!enabled) {
                abortPendingPrediction();
                clearGhostText();
            }
            ctx.ui.notify(`NIS ${enabled ? "enabled" : "disabled"}`, "info");
            updateStatus(ctx);
        },
    });

    // Toggle shortcut
    pi.registerShortcut(Key.ctrlShift("n"), {
        description: "Toggle NIS prediction",
        handler: async (ctx) => {
            enabled = !enabled;
            if (!enabled) {
                abortPendingPrediction();
                clearGhostText();
            }
            ctx.ui.notify(`NIS ${enabled ? "enabled" : "disabled"}`, "info");
            updateStatus(ctx);
        },
    });

    // Session lifecycle
    pi.on("session_start", async (_event, ctx) => {
        abortPendingPrediction();
        updateStatus(ctx);
    });

    pi.on("session_switch", async () => {
        abortPendingPrediction();
        clearGhostText();
    });

    // Clear when user starts a new turn
    pi.on("turn_start", async () => {
        abortPendingPrediction();
        clearGhostText();
    });

    // Generate prediction after assistant finishes
    pi.on("agent_end", async (_event, ctx) => {
        if (!enabled) return;

        try {
            const prediction = await generatePrediction(ctx);
            if (prediction && enabled) {
                setGhostText(prediction);
            }
        } catch (err) {
            ctx.ui.notify(`nis failed ${err}`, "error");
        }
    });

    // Clear when user submits input
    pi.on("input", async () => {
        abortPendingPrediction();
        clearGhostText();
        return { action: "continue" };
    });
}
