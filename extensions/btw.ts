/**
 * /btw -- Side questions without context pollution
 *
 * Ask a quick question about your current work without adding to the
 * conversation history. The question has full visibility into the
 * current conversation but no tool access.
 *
 * Usage:
 *   /btw what was the name of that config file again?
 *   /btw why did you choose that approach?
 *   /btw summarize what we've done so far
 *
 * The answer streams into a dismissible overlay. Press Space, Enter,
 * or Escape to dismiss. Works while the agent is processing.
 */

import { streamSimple, type Usage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
    buildSessionContext,
    convertToLlm,
    getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import {
    type Component,
    type Focusable,
    Markdown,
    matchesKey,
    type TUI,
    truncateToWidth,
    visibleWidth,
} from "@mariozechner/pi-tui";

const SIDE_QUESTION_PROMPT = `This is a side question from the user. You MUST answer this question directly in a single response.

IMPORTANT CONTEXT:

You are a separate, lightweight agent spawned to answer this one question.
The main agent is NOT interrupted - it continues working independently in the background.
You share the conversation context but are a completely separate instance.
Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect.

CRITICAL CONSTRAINTS:

You have NO tools available - you cannot read files, run commands, search, or take any actions.
This is a one-off response - there will be no follow-up turns.
You can ONLY provide information based on what you already know from the conversation context.
NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action.
If you don't know the answer, say so - do not offer to look it up or investigate.
Simply answer the question with the information you have.`;

const TITLE = "/btw";
const MD_THEME = getMarkdownTheme();

function renderMarkdownLines(text: string, width: number): string[] {
    if (!text) return [];
    try {
        const md = new Markdown(text, 0, 0, MD_THEME);
        return md.render(width);
    } catch {
        return text.split("\n").flatMap((line) => {
            if (!line) return [""];
            const wrapped: string[] = [];
            let start = 0;
            while (start < line.length) {
                let end = start;
                let w = 0;
                while (end < line.length) {
                    const cp = line.codePointAt(end)!;
                    const charW = visibleWidth(String.fromCodePoint(cp));
                    if (w + charW > width) break;
                    w += charW;
                    end += cp > 0xffff ? 2 : 1;
                }
                if (end === start) {
                    end += line.codePointAt(end)! > 0xffff ? 2 : 1;
                }
                wrapped.push(line.slice(start, end));
                start = end;
            }
            return wrapped.length > 0 ? wrapped : [""];
        });
    }
}
const MAX_VISIBLE_LINES = 30;

function formatTokens(n: number): string {
    if (n < 1000) return n.toString();
    if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
    return `${Math.round(n / 1000)}k`;
}

function formatUsage(usage: Usage): string {
    const parts: string[] = [];
    if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
    if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
    if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
    if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
    return parts.join(" ");
}

class SideAnswerOverlay implements Component, Focusable {
    focused = false;

    private lines: string[] = [];
    private lastInnerW = 0;
    private text = "";
    private loading = true;
    private usageText = "";
    private scrollOffset = 0;
    private totalContentLines = 0;
    private abortController: AbortController;
    private tui: TUI;

    constructor(
        tui: TUI,
        private theme: Theme,
        private done: (value: null) => void,
    ) {
        this.tui = tui;
        this.abortController = new AbortController();
    }

    get signal(): AbortSignal {
        return this.abortController.signal;
    }

    setText(text: string): void {
        this.text = text;
        this.lines = [];
        this.tui.requestRender();
    }

    setDone(usage?: Usage): void {
        this.loading = false;
        if (usage) {
            this.usageText = formatUsage(usage);
        }
        this.lines = [];
        this.tui.requestRender();
    }

    setError(message: string): void {
        this.text = this.theme.fg("error", message);
        this.loading = false;
        this.lines = [];
        this.tui.requestRender();
    }

    handleInput(data: string): void {
        if (
            matchesKey(data, "escape") ||
            matchesKey(data, "return") ||
            data === " "
        ) {
            this.abortController.abort();
            this.done(null);
            return;
        }

        if (matchesKey(data, "up") || data === "k") {
            if (this.scrollOffset > 0) {
                this.scrollOffset--;
            }
            return;
        }

        if (matchesKey(data, "down") || data === "j") {
            const maxScroll = Math.max(
                0,
                this.totalContentLines - MAX_VISIBLE_LINES,
            );
            if (this.scrollOffset < maxScroll) {
                this.scrollOffset++;
            }
            return;
        }
    }

    render(width: number): string[] {
        const th = this.theme;
        const innerW = Math.max(20, width - 2);

        if (this.lines.length === 0 || this.lastInnerW !== innerW) {
            this.lines = this.buildContent(innerW);
            this.lastInnerW = innerW;
        }

        const contentLines = this.lines;
        this.totalContentLines = contentLines.length;

        const maxScroll = Math.max(0, contentLines.length - MAX_VISIBLE_LINES);
        if (this.scrollOffset > maxScroll) {
            this.scrollOffset = maxScroll;
        }

        const visibleLines = contentLines.slice(
            this.scrollOffset,
            this.scrollOffset + MAX_VISIBLE_LINES,
        );

        const pad = (s: string, len: number) => {
            const vis = visibleWidth(s);
            return s + " ".repeat(Math.max(0, len - vis));
        };

        const row = (content: string) => {
            const truncated = truncateToWidth(content, innerW, "");
            return ` ${pad(truncated, innerW)} `;
        };

        const out: string[] = [];

        // Top border with title
        const titleText = ` ${TITLE} `;
        const borderLen = width - titleText.length;
        const leftBorder = "\u2500".repeat(Math.max(1, Math.floor(borderLen / 2)));
        const rightBorder = "\u2500".repeat(Math.max(1, Math.ceil(borderLen / 2)));
        out.push(
            th.fg("warning", leftBorder) +
                th.fg("accent", titleText) +
                th.fg("warning", rightBorder),
        );

        const isScrollable = contentLines.length > MAX_VISIBLE_LINES;
        const remaining =
            contentLines.length - this.scrollOffset - MAX_VISIBLE_LINES;

        // Scroll indicator (top) -- always present when scrollable
        if (isScrollable) {
            out.push(
                this.scrollOffset > 0
                    ? row(
                          th.fg(
                              "dim",
                              `... ${this.scrollOffset} more line${this.scrollOffset === 1 ? "" : "s"} above`,
                          ),
                      )
                    : row(""),
            );
        }

        // Content
        for (const line of visibleLines) {
            out.push(row(line));
        }

        // Scroll indicator (bottom) -- always present when scrollable
        if (isScrollable) {
            out.push(
                remaining > 0
                    ? row(
                          th.fg(
                              "dim",
                              `... ${remaining} more line${remaining === 1 ? "" : "s"} below`,
                          ),
                      )
                    : row(""),
            );
        }

        // Footer hint
        if (this.loading) {
            out.push(row(th.fg("dim", "Streaming... (Esc to cancel)")));
        } else {
            const scrollHint =
                contentLines.length > MAX_VISIBLE_LINES ? " | j/k to scroll" : "";
            const usagePart = this.usageText
                ? th.fg("dim", ` | ${this.usageText}`)
                : "";
            out.push(
                row(
                    th.fg("dim", `Space/Enter/Esc to dismiss${scrollHint}`) +
                        usagePart,
                ),
            );
        }

        // Bottom border
        out.push(th.fg("warning", "\u2500".repeat(width)));

        return out;
    }

    invalidate(): void {
        this.lines = [];
    }

    private buildContent(innerW: number): string[] {
        if (!this.text && this.loading) {
            return [this.theme.fg("dim", "Thinking...")];
        }

        if (!this.text) {
            return [this.theme.fg("dim", "(no response)")];
        }

        return renderMarkdownLines(this.text, innerW);
    }
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("btw", {
        description: "Ask a side question without adding to conversation history",
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("/btw requires interactive mode", "error");
                return;
            }

            if (!ctx.model) {
                ctx.ui.notify("No model selected", "error");
                return;
            }

            const question = args.trim();
            if (!question) {
                ctx.ui.notify("Usage: /btw <your question>", "error");
                return;
            }

            // Gather conversation messages from current branch,
            // trimming trailing assistant messages so the side
            // question immediately follows the last user turn
            const branch = ctx.sessionManager.getBranch();
            const sctx = buildSessionContext(branch);
            const agentMessages = sctx.messages;
            const llmMessages = convertToLlm(agentMessages);
            while (
                llmMessages.length > 0 &&
                llmMessages[llmMessages.length - 1].role !== "user"
            ) {
                llmMessages.pop();
            }

            // Keep system prompt identical to parent conversation
            // so the provider-level KV cache prefix is reused
            const systemPrompt = ctx.getSystemPrompt() ?? "";

            // Include tool definitions in the same order as the main
            // agent session to preserve the provider KV cache prefix
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

            // Side-question instructions go in the user message,
            // not the system prompt, to preserve the cache prefix
            llmMessages.push({
                role: "user",
                content: [
                    {
                        type: "text",
                        text: `${SIDE_QUESTION_PROMPT}\n\n${question}`,
                    },
                ],
                timestamp: Date.now(),
            });

            await ctx.ui.custom<null>((tui, theme, _kb, done) => {
                const overlay = new SideAnswerOverlay(tui, theme, done);

                const doStream = async () => {
                    const model = ctx.model;
                    if (!model) {
                        overlay.setError("No model selected");
                        return;
                    }

                    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
                    if (!auth.ok) {
                        overlay.setError(
                            `Authentication failed for ${model.id}: ${auth.error}`,
                        );
                        return;
                    }

                    const thinkingLevel = pi.getThinkingLevel();
                    const reasoning =
                        thinkingLevel !== "off" ? thinkingLevel : undefined;

                    const eventStream = streamSimple(
                        model,
                        {
                            systemPrompt,
                            messages: llmMessages,
                            tools,
                        },
                        {
                            apiKey: auth.apiKey,
                            headers: auth.headers,
                            signal: overlay.signal,
                            reasoning,
                        },
                    );

                    let fullText = "";

                    for await (const event of eventStream) {
                        if (overlay.signal.aborted) break;

                        if (event.type === "text_delta") {
                            fullText += event.delta;
                            overlay.setText(fullText);
                        }
                    }

                    if (overlay.signal.aborted) return;

                    try {
                        const result = await eventStream.result();
                        overlay.setDone(result.usage);
                    } catch {
                        overlay.setDone();
                    }
                };

                doStream().catch((err) => {
                    if (overlay.signal.aborted) return;
                    const msg = err instanceof Error ? err.message : String(err);
                    overlay.setError(`Error: ${msg}`);
                });

                return overlay;
            }, {});
        },
    });
}
