/**
 * Auto-generates a short session title from the first agent interaction.
 *
 * Triggers on `agent_end` after the first complete agent run. Reuses the
 * session model with the full conversation prefix (system prompt + tools +
 * messages) to get a KV cache hit, appending a title-generation instruction
 * as a trailing user message.
 */

import {
    completeSimple,
    type Message,
    type TextContent,
} from "@earendil-works/pi-ai/compat";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    BorderedLoader,
    buildSessionContext,
    convertToLlm,
} from "@earendil-works/pi-coding-agent";

const MAX_TITLE_LENGTH = 50;

const TITLE_INSTRUCTION = `Generate a short title (four words or less) that describes the topic of this conversation.
Reply with only the title, nothing else. Do not show your reasoning.

Examples:
- "how do I reverse a list in python?" → Python list reversal
- "what's the weather in Tokyo?" → Tokyo weather
- "explain how transformers work in ML" → ML transformers explained`;

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
    pi: ExtensionAPI,
    ctx: ExtensionContext,
): Promise<string> {
    const model = ctx.model;
    if (!model) {
        throw new Error("No model selected");
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
        throw new Error(`Authentication failed for ${model.id}: ${auth.error}`);
    }

    // Preserve KV cache prefix: same system prompt + tools + messages
    const systemPrompt = ctx.getSystemPrompt() ?? "";

    const allTools = new Map(pi.getAllTools().map((t) => [t.name, t]));
    const tools = pi
        .getActiveTools()
        .map((name) => allTools.get(name))
        .filter((t) => t !== undefined)
        .map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
        }));

    // Build messages from session branch, then append title instruction
    // as a trailing user message so the shared prefix stays intact.
    const branch = ctx.sessionManager.getBranch();
    const sctx = buildSessionContext(branch);
    const llmMessages = convertToLlm(sctx.messages);

    const messages: Message[] = [
        ...llmMessages,
        {
            role: "user",
            content: [{ type: "text", text: TITLE_INSTRUCTION }],
            timestamp: Date.now(),
        },
    ];

    const thinkingLevel = pi.getThinkingLevel();
    const reasoning = thinkingLevel !== "off" ? thinkingLevel : undefined;

    const response = await completeSimple(
        model,
        { systemPrompt, messages, tools },
        { apiKey: auth.apiKey, headers: auth.headers, reasoning },
    );

    const raw = response.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();

    return postProcessTitle(raw);
}

export async function setTitle(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    isActive: () => boolean = () => true,
): Promise<void> {
    try {
        const title = await generateTitle(pi, ctx);
        if (!isActive()) return;
        if (title) {
            pi.setSessionName(title);
        }
    } catch (error) {
        if (!isActive()) return;
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Title generation failed: ${msg}`, "warning");
    }
}

interface SessionNameState {
    hasAutoNamed: boolean;
    sessionActive: boolean;
    generation: number;
}

export default function sessionNameExtension(pi: ExtensionAPI) {
    const state: SessionNameState = {
        hasAutoNamed: false,
        sessionActive: false,
        generation: 0,
    };

    pi.on("session_start", async () => {
        state.hasAutoNamed = false;
        state.sessionActive = true;
        state.generation++;
    });

    pi.on("session_shutdown", async () => {
        state.sessionActive = false;
    });

    pi.registerCommand("title", {
        description: "Generate a session title from the conversation",
        handler: async (_args, ctx) => {
            if (!state.sessionActive) return;
            await ctx.ui.custom<void>((tui, theme, _kb, done) => {
                const loader = new BorderedLoader(tui, theme, "Generating title...");
                setTitle(pi, ctx, () => state.sessionActive).finally(() =>
                    done(undefined),
                );
                return loader;
            });
        },
    });

    pi.on("agent_end", async (_event, ctx) => {
        if (ctx.mode !== "tui") return;
        if (!state.sessionActive || state.hasAutoNamed) return;

        if (pi.getSessionName()) {
            state.hasAutoNamed = true;
            return;
        }

        // Mark eagerly to prevent re-entry, then fire-and-forget.
        state.hasAutoNamed = true;
        const gen = state.generation;
        setTitle(
            pi,
            ctx,
            () => state.sessionActive && state.generation === gen,
        ).catch(() => {});
    });
}
