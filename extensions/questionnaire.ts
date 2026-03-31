/**
 * Questionnaire Tool & /answer Command
 *
 * Tool: Ask single or multiple questions via a TUI selector.
 * Command: /answer - parse questions from the last assistant message
 *   using a cheap LLM call, show questionnaire UI, send answers back.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionUIContext,
    ModelRegistry,
    Theme,
} from "@mariozechner/pi-coding-agent";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import {
    Editor,
    type EditorTheme,
    Key,
    type KeybindingsManager,
    matchesKey,
    Text,
    type TUI,
    truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Types
interface QuestionOption {
    value: string;
    label: string;
    description?: string;
    recommended?: boolean;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
    id: string;
    label: string;
    prompt: string;
    options: QuestionOption[];
    allowOther: boolean;
}

interface Answer {
    id: string;
    value: string;
    label: string;
    wasCustom: boolean;
    index?: number;
}

interface QuestionnaireResult {
    questions: Question[];
    answers: Answer[];
    cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
    value: Type.String({ description: "The value returned when selected" }),
    label: Type.String({ description: "Display label for the option" }),
    description: Type.Optional(
        Type.String({ description: "Optional description shown below label" }),
    ),
    recommended: Type.Optional(
        Type.Boolean({
            description:
                "Mark this option as the recommended choice (default: false)",
        }),
    ),
});

const QuestionSchema = Type.Object({
    id: Type.String({ description: "Unique identifier for this question" }),
    label: Type.Optional(
        Type.String({
            description:
                "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
        }),
    ),
    prompt: Type.String({ description: "The full question text to display" }),
    options: Type.Array(QuestionOptionSchema, {
        description: "Available options to choose from",
    }),
    allowOther: Type.Optional(
        Type.Boolean({
            description: "Allow 'Type something' option (default: true)",
        }),
    ),
});

const QuestionnaireParams = Type.Object({
    questions: Type.Array(QuestionSchema, {
        description: "Questions to ask the user",
    }),
});

// /answer constants
const DEFAULT_ANSWER_MODEL = "claude-haiku-4-5";

const EXTRACTION_PROMPT = `You extract structured questions from assistant messages.

Given an assistant message, identify every question the assistant is asking the user.
For each question, extract the prompt text and any explicit options.

Return ONLY valid JSON matching this schema (no markdown fences, no commentary):
{
  "questions": [
    {
      "id": "q1",
      "label": "Short label",
      "prompt": "Full question text",
      "allowOther": true,
      "options": [
        { "value": "a", "label": "Option A", "description": "optional", "recommended": true }
      ]
    }
  ]
}

Rules:
- id: sequential q1, q2, etc.
- label: 1-3 word summary for tab display
- prompt: the full question as written
- options: extract numbered/bulleted/lettered choices if present.
  For yes/no questions use [{"value":"yes","label":"Yes"},{"value":"no","label":"No"}].
  For open-ended questions with no choices, use an empty array and set allowOther to true.
- allowOther: true unless the question strictly requires picking from listed options.
- If no questions found, return {"questions":[]}.
- description is optional, use it for sub-text explaining an option.
- recommended: set to true on the single option the assistant explicitly recommends or prefers. At most one option per question should be recommended. Omit or set false for non-recommended options.`;

// Helpers

function wrapText(text: string, maxWidth: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
        if (!current) {
            current = word;
        } else if (current.length + 1 + word.length <= maxWidth) {
            current += ` ${word}`;
        } else {
            lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [""];
}

function errorResult(
    message: string,
    questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
    return {
        content: [{ type: "text", text: message }],
        details: { questions, answers: [], cancelled: true },
    };
}

function createQuestionnaireUI(
    questions: Question[],
): (
    tui: TUI,
    theme: Theme,
    kb: KeybindingsManager,
    done: (result: QuestionnaireResult) => void,
) => Component & { dispose?(): void } {
    const isMulti = questions.length > 1;
    const totalTabs = questions.length + 1; // questions + Submit

    return (tui, theme, _kb, done) => {
        // State
        let currentTab = 0;
        let optionIndex = -1; // set on first render
        let inputMode = false;
        let inputQuestionId: string | null = null;
        let cachedLines: string[] | undefined;
        const answers = new Map<string, Answer>();

        const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
                selectedPrefix: (t) => theme.fg("accent", t),
                selectedText: (t) => theme.fg("accent", t),
                description: (t) => theme.fg("muted", t),
                scrollInfo: (t) => theme.fg("dim", t),
                noMatch: (t) => theme.fg("warning", t),
            },
        };
        const editor = new Editor(tui, editorTheme);

        function refresh() {
            cachedLines = undefined;
            tui.requestRender();
        }

        function submit(cancelled: boolean) {
            done({
                questions,
                answers: Array.from(answers.values()),
                cancelled,
            });
        }

        function currentQuestion(): Question | undefined {
            return questions[currentTab];
        }

        function currentOptions(): RenderOption[] {
            const q = currentQuestion();
            if (!q) return [];
            const opts: RenderOption[] = [...q.options];
            if (q.allowOther) {
                opts.push({
                    value: "__other__",
                    label: "Type something.",
                    isOther: true,
                });
            }
            return opts;
        }

        function recommendedIndex(opts: RenderOption[]): number {
            const idx = opts.findIndex((o) => o.recommended);
            return idx >= 0 ? idx : 0;
        }

        function allAnswered(): boolean {
            return questions.every((q) => answers.has(q.id));
        }

        function advanceAfterAnswer() {
            if (!isMulti) {
                submit(false);
                return;
            }
            if (currentTab < questions.length - 1) {
                currentTab++;
            } else {
                currentTab = questions.length; // Submit tab
            }
            optionIndex = -1;
            refresh();
        }

        function saveAnswer(
            questionId: string,
            value: string,
            label: string,
            wasCustom: boolean,
            index?: number,
        ) {
            answers.set(questionId, {
                id: questionId,
                value,
                label,
                wasCustom,
                index,
            });
        }

        editor.onSubmit = (value) => {
            if (!inputQuestionId) return;
            const trimmed = value.trim() || "(no response)";
            saveAnswer(inputQuestionId, trimmed, trimmed, true);
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            advanceAfterAnswer();
        };

        function ensureOptionIndex(opts: RenderOption[]) {
            if (optionIndex < 0) {
                optionIndex = recommendedIndex(opts);
            }
        }

        function handleInput(data: string) {
            if (inputMode) {
                if (matchesKey(data, Key.escape)) {
                    inputMode = false;
                    inputQuestionId = null;
                    editor.setText("");
                    refresh();
                    return;
                }
                editor.handleInput(data);
                refresh();
                return;
            }

            const q = currentQuestion();
            const opts = currentOptions();
            ensureOptionIndex(opts);

            if (isMulti) {
                if (
                    matchesKey(data, Key.tab) ||
                    matchesKey(data, Key.right) ||
                    matchesKey(data, "l")
                ) {
                    currentTab = (currentTab + 1) % totalTabs;
                    optionIndex = -1;
                    refresh();
                    return;
                }
                if (
                    matchesKey(data, Key.shift("tab")) ||
                    matchesKey(data, Key.left) ||
                    matchesKey(data, "h")
                ) {
                    currentTab = (currentTab - 1 + totalTabs) % totalTabs;
                    optionIndex = -1;
                    refresh();
                    return;
                }
            }

            if (currentTab === questions.length) {
                if (matchesKey(data, Key.enter) && allAnswered()) {
                    submit(false);
                } else if (matchesKey(data, Key.escape)) {
                    submit(true);
                }
                return;
            }

            if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
                optionIndex = Math.max(0, optionIndex - 1);
                refresh();
                return;
            }
            if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
                optionIndex = Math.min(opts.length - 1, optionIndex + 1);
                refresh();
                return;
            }

            if (matchesKey(data, Key.enter) && q) {
                const opt = opts[optionIndex];
                if (opt.isOther) {
                    inputMode = true;
                    inputQuestionId = q.id;
                    editor.setText("");
                    refresh();
                    return;
                }
                saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
                advanceAfterAnswer();
                return;
            }

            if (matchesKey(data, Key.escape)) {
                submit(true);
            }
        }

        function render(width: number): string[] {
            if (cachedLines) return cachedLines;

            const lines: string[] = [];
            const q = currentQuestion();
            const opts = currentOptions();
            ensureOptionIndex(opts);

            const add = (s: string) => lines.push(truncateToWidth(s, width));

            add(theme.fg("accent", "\u2500".repeat(width)));

            if (isMulti) {
                const tabs: string[] = ["\u2190 "];
                for (let i = 0; i < questions.length; i++) {
                    const isActive = i === currentTab;
                    const isAnswered = answers.has(questions[i].id);
                    const lbl = questions[i].label;
                    const box = isAnswered ? "\u25A0" : "\u25A1";
                    const color = isAnswered ? "success" : "muted";
                    const text = ` ${box} ${lbl} `;
                    const styled = isActive
                        ? theme.bg("selectedBg", theme.fg("text", text))
                        : theme.fg(color, text);
                    tabs.push(`${styled} `);
                }
                const canSubmit = allAnswered();
                const isSubmitTab = currentTab === questions.length;
                const submitText = " \u2713 Submit ";
                const submitStyled = isSubmitTab
                    ? theme.bg("selectedBg", theme.fg("text", submitText))
                    : theme.fg(canSubmit ? "success" : "dim", submitText);
                tabs.push(`${submitStyled} \u2192`);
                add(` ${tabs.join("")}`);
                lines.push("");
            }

            function renderOptions() {
                for (let i = 0; i < opts.length; i++) {
                    const opt = opts[i];
                    const selected = i === optionIndex;
                    const isOther = opt.isOther === true;
                    const prefix = selected ? theme.fg("accent", "> ") : "  ";
                    const color = selected ? "accent" : "text";
                    const recBadge = opt.recommended
                        ? theme.fg("success", " [recommended]")
                        : "";
                    if (isOther && inputMode) {
                        add(
                            prefix +
                                theme.fg("accent", `${i + 1}. ${opt.label} \u270E`),
                        );
                    } else {
                        add(
                            prefix +
                                theme.fg(color, `${i + 1}. ${opt.label}`) +
                                recBadge,
                        );
                    }
                    if (opt.description) {
                        const indent = "     ";
                        const maxW = Math.max(10, width - indent.length);
                        for (const line of wrapText(opt.description, maxW)) {
                            add(`${indent}${theme.fg("muted", line)}`);
                        }
                    }
                }
            }

            if (inputMode && q) {
                add(theme.fg("text", ` ${q.prompt}`));
                lines.push("");
                renderOptions();
                lines.push("");
                add(theme.fg("muted", " Your answer:"));
                for (const line of editor.render(width - 2)) {
                    add(` ${line}`);
                }
                lines.push("");
                add(theme.fg("dim", " Enter to submit \u2022 Esc to cancel"));
            } else if (currentTab === questions.length) {
                add(theme.fg("accent", theme.bold(" Ready to submit")));
                lines.push("");
                for (const question of questions) {
                    const answer = answers.get(question.id);
                    if (answer) {
                        const prefix = answer.wasCustom ? "(wrote) " : "";
                        add(
                            `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`,
                        );
                    }
                }
                lines.push("");
                if (allAnswered()) {
                    add(theme.fg("success", " Press Enter to submit"));
                } else {
                    const missing = questions
                        .filter((q) => !answers.has(q.id))
                        .map((q) => q.label)
                        .join(", ");
                    add(theme.fg("warning", ` Unanswered: ${missing}`));
                }
            } else if (q) {
                add(theme.fg("text", ` ${q.prompt}`));
                lines.push("");
                renderOptions();
            }

            lines.push("");
            if (!inputMode) {
                const help = isMulti
                    ? " Tab/\u2190\u2192/hl navigate \u2022 \u2191\u2193/jk select \u2022 Enter confirm \u2022 Esc cancel"
                    : " \u2191\u2193/jk select \u2022 Enter confirm \u2022 Esc cancel";
                add(theme.fg("dim", help));
            }
            add(theme.fg("accent", "\u2500".repeat(width)));

            cachedLines = lines;
            return lines;
        }

        return {
            render,
            invalidate: () => {
                cachedLines = undefined;
            },
            handleInput,
        };
    };
}

function showQuestionnaireUI(
    ui: ExtensionUIContext,
    questions: Question[],
): Promise<QuestionnaireResult> {
    return ui.custom<QuestionnaireResult>(createQuestionnaireUI(questions));
}

function resolveModel(registry: ModelRegistry): Model<Api> | undefined {
    const envModel = process.env.PI_ANSWER_MODEL;
    const modelId = envModel?.trim() || DEFAULT_ANSWER_MODEL;
    const available = registry.getAvailable();
    return available.find((m) => m.id === modelId) ?? available[0];
}

function extractAssistantText(ctx: ExtensionCommandContext): string | undefined {
    const branch = ctx.sessionManager.getBranch();
    const sctx = buildSessionContext(branch);
    for (let i = sctx.messages.length - 1; i >= 0; i--) {
        const msg = sctx.messages[i];
        if (msg.role === "assistant") {
            const texts = msg.content
                .filter(
                    (c): c is { type: "text"; text: string } => c.type === "text",
                )
                .map((c) => c.text);
            if (texts.length > 0) return texts.join("\n");
        }
    }
    return undefined;
}

function parseExtractedQuestions(json: string): Question[] {
    const cleaned = json
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/```\s*$/m, "")
        .trim();
    const parsed = JSON.parse(cleaned);
    const raw = Array.isArray(parsed?.questions) ? parsed.questions : [];
    return (raw as unknown[])
        .filter(
            (q): q is Record<string, unknown> => typeof q === "object" && q !== null,
        )
        .map((q, i) => {
            const options: QuestionOption[] = Array.isArray(q.options)
                ? (q.options as unknown[])
                      .filter(
                          (o): o is Record<string, unknown> =>
                              typeof o === "object" && o !== null,
                      )
                      .map((o) => ({
                          value: String(o.value ?? ""),
                          label: String(o.label ?? ""),
                          description: o.description
                              ? String(o.description)
                              : undefined,
                          recommended: o.recommended === true ? true : undefined,
                      }))
                : [];
            return {
                id: `q${i + 1}`,
                label: String(q.label ?? `Q${i + 1}`),
                prompt: String(q.prompt ?? ""),
                options,
                allowOther: true,
            };
        })
        .filter((q) => q.prompt.length > 0);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠴", "⠦", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function extractQuestionsWithOverlay(
    ui: ExtensionUIContext,
    doExtract: (signal: AbortSignal) => Promise<Question[]>,
): Promise<Question[] | null> {
    return ui.custom<Question[] | null>((tui, theme, _kb, done) => {
        const abort = new AbortController();
        let frame = 0;
        let error: string | undefined;

        const timer = setInterval(() => {
            frame = (frame + 1) % SPINNER_FRAMES.length;
            tui.requestRender();
        }, SPINNER_INTERVAL_MS);

        doExtract(abort.signal)
            .then((questions) => {
                clearInterval(timer);
                done(questions);
            })
            .catch((err) => {
                clearInterval(timer);
                if (abort.signal.aborted) return;
                error = err instanceof Error ? err.message : String(err);
                tui.requestRender();
            });

        return {
            render(width: number): string[] {
                const lines: string[] = [];
                const add = (s: string) => lines.push(truncateToWidth(s, width));
                add(theme.fg("accent", "\u2500".repeat(width)));
                if (error) {
                    add(`  ${theme.fg("error", `Failed: ${error}`)}`);
                    add(`  ${theme.fg("dim", "Press Esc to dismiss")}`);
                } else {
                    const spin = SPINNER_FRAMES[frame];
                    add(
                        `  ${theme.fg("accent", spin)} ${theme.fg("text", "Parsing questions...")}`,
                    );
                    add(`  ${theme.fg("dim", "Esc to cancel")}`);
                }
                add(theme.fg("accent", "\u2500".repeat(width)));
                return lines;
            },
            invalidate() {},
            handleInput(data: string) {
                if (matchesKey(data, Key.escape)) {
                    clearInterval(timer);
                    abort.abort();
                    done(null);
                }
            },
        };
    });
}

function formatAnswers(questions: Question[], answers: Answer[]): string {
    return answers
        .map((a) => {
            const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
            if (a.wasCustom) {
                return `${qLabel}: ${a.label}`;
            }
            return `${qLabel}: ${a.index}. ${a.label}`;
        })
        .join("\n");
}

// Extension entry point
export default function questionnaire(pi: ExtensionAPI) {
    pi.registerTool({
        name: "questionnaire",
        label: "Questionnaire",
        description:
            "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
        parameters: QuestionnaireParams,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!ctx.hasUI) {
                return errorResult(
                    "Error: UI not available (running in non-interactive mode)",
                );
            }
            if (params.questions.length === 0) {
                return errorResult("Error: No questions provided");
            }

            const questions: Question[] = params.questions.map((q, i) => ({
                ...q,
                label: q.label || `Q${i + 1}`,
                allowOther: q.allowOther !== false,
            }));

            const result = await showQuestionnaireUI(ctx.ui, questions);

            if (result.cancelled) {
                return {
                    content: [
                        { type: "text", text: "User cancelled the questionnaire" },
                    ],
                    details: result,
                };
            }

            const answerLines = result.answers.map((a) => {
                const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
                if (a.wasCustom) {
                    return `${qLabel}: user wrote: ${a.label}`;
                }
                return `${qLabel}: user selected: ${a.index}. ${a.label}`;
            });

            return {
                content: [{ type: "text", text: answerLines.join("\n") }],
                details: result,
            };
        },

        renderCall(args, theme) {
            const qs = (args.questions as Question[]) || [];
            const count = qs.length;
            const labels = qs.map((q) => q.label || q.id).join(", ");
            let text = theme.fg("toolTitle", theme.bold("questionnaire "));
            text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
            if (labels) {
                text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, _options, theme) {
            const details = result.details as QuestionnaireResult | undefined;
            if (!details) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "", 0, 0);
            }
            if (details.cancelled) {
                return new Text(theme.fg("warning", "Cancelled"), 0, 0);
            }
            const lines = details.answers.map((a) => {
                if (a.wasCustom) {
                    return `${theme.fg("success", "\u2713 ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
                }
                const display = a.index ? `${a.index}. ${a.label}` : a.label;
                return `${theme.fg("success", "\u2713 ")}${theme.fg("accent", a.id)}: ${display}`;
            });
            return new Text(lines.join("\n"), 0, 0);
        },
    });

    // /answer command
    pi.registerCommand("answer", {
        description:
            "Parse questions from the last assistant message and answer them interactively",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("/answer requires interactive mode", "error");
                return;
            }

            const assistantText = extractAssistantText(ctx);
            if (!assistantText) {
                ctx.ui.notify("No assistant message found", "error");
                return;
            }

            const model = resolveModel(ctx.modelRegistry);
            if (!model) {
                const envHint = process.env.PI_ANSWER_MODEL
                    ? ` (PI_ANSWER_MODEL=${process.env.PI_ANSWER_MODEL})`
                    : ` (${DEFAULT_ANSWER_MODEL})`;
                ctx.ui.notify(
                    `Model not available${envHint}. Check auth or set PI_ANSWER_MODEL.`,
                    "error",
                );
                return;
            }

            const questions = await extractQuestionsWithOverlay(
                ctx.ui,
                async (signal) => {
                    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
                    if (!auth.ok) {
                        throw new Error(
                            `Auth failed for ${model.id}: ${auth.error}`,
                        );
                    }

                    const response = await completeSimple(
                        model,
                        {
                            systemPrompt: EXTRACTION_PROMPT,
                            messages: [
                                {
                                    role: "user",
                                    content: [
                                        {
                                            type: "text",
                                            text: assistantText,
                                        },
                                    ],
                                    timestamp: Date.now(),
                                },
                            ],
                        },
                        {
                            apiKey: auth.apiKey,
                            headers: auth.headers,
                            signal,
                        },
                    );

                    const responseText = response.content
                        .filter(
                            (c): c is { type: "text"; text: string } =>
                                c.type === "text",
                        )
                        .map((c) => c.text)
                        .join("");

                    return parseExtractedQuestions(responseText);
                },
            );

            if (!questions) {
                return;
            }

            if (questions.length === 0) {
                ctx.ui.notify(
                    "No questions found in the last assistant message",
                    "warning",
                );
                return;
            }

            const result = await showQuestionnaireUI(ctx.ui, questions);

            if (result.cancelled) {
                ctx.ui.notify("Cancelled", "warning");
                return;
            }

            const text = formatAnswers(questions, result.answers);
            pi.sendUserMessage(text);
        },
    });
}
