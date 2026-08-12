/**
 * /clarify -- Rewrite a rough prompt into a precise one and fill the editor.
 *
 * Spawns a headless `pi -p` process with a dedicated rewriter system prompt.
 * The child runs with no session, no skills, no extensions, no tools, no
 * context files, and no startup network operations. The rewritten prompt is
 * loaded into the editor for review and editing before submission.
 *
 * Usage:
 *   /clarify make the thumbnail grow into the big image so it feels continuous
 *   /clarify wait until the user stops typing before searching
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────

const REWRITER_PROMPT = `You rewrite rough, plain-language user prompts into clear, precise prompts for a coding agent.

Your job is terminology compression and clarity, not invention. Do not add features, constraints, stack choices, or preferences the user did not state.

Rules:
1. Keep the user's intent exactly. Change nothing the user stated, and add nothing the user implied but did not state.
2. When a standard technical term names what the user described, use that term instead of the description. Apply this in any domain: patterns, algorithms, UX moves, architecture choices, protocols, and processes. Do not force a term that does not fit. Examples of the wanted compression:
   - "remember old card positions, measure new ones, animate between them" → "FLIP animation"
   - "thumbnail grows into the large image on the next screen so it feels like the same image" → "shared-element transition"
   - "one small part working end-to-end from UI through backend and database" → "vertical slice"
   - "show the new state right away, then fix it if the server fails" → "optimistic update"
   - "wait until the user stops typing before searching" → "debounce the search input"
3. Prefer short, exact terms over long explanations.
4. Preserve all concrete details: product names, file names, paths, numbers, constraints, UI copy, error text, and acceptance criteria. Copy them verbatim.
5. Keep the rewrite ready to send as a user prompt. Do not wrap it in quotes. Do not add a preamble such as "Here is the rewritten prompt".
6. Use the same language the user wrote in. If the input mixes languages, keep the mix.
7. If the input is already precise, make only light cleanup. Do not invent jargon.
8. Structure multi-part asks with short bullets or numbered steps when that makes the ask clearer.
9. Do not answer the request. Only rewrite the prompt.
10. Match the user's register. If the input is casual, stay casual. If it is formal, stay formal. Do not add politeness or urgency.
11. Preserve commands, flags, and shell syntax verbatim. Do not paraphrase them.
12. If the input is one word or too vague to rewrite, return it unchanged. Never invent meaning.
13. Output only the rewritten prompt text. No headings, no explanations, no markdown outside the prompt text. End with one trailing newline. Keep the rewrite under 300 words unless the input requires more.`;

const BASE_ARGS = [
    "--no-session",
    "--no-skills",
    "--no-extensions",
    "--no-tools",
    "--offline",
    // Keep AGENTS.md (global and project) out of the child's system prompt.
    "--no-context-files",
];

// ── Types ────────────────────────────────────────────────────────────

export interface ModelIdentity {
    provider: string;
    name: string;
    thinkingLevel?: string;
}

type ClarifyResult =
    | { status: "ok"; text: string }
    | { status: "error"; message: string };

// ── Pure helpers ─────────────────────────────────────────────────────

export function formatModelString(model: ModelIdentity): string {
    return `${model.provider}/${model.name}${model.thinkingLevel ? `:${model.thinkingLevel}` : ""}`;
}

/**
 * Build the full argument list for the clarify subprocess.
 *
 * The task is passed as the positional message: pi print mode merges
 * positional messages into the initial prompt.
 */
export function buildClarifyArgs(
    model: ModelIdentity | undefined,
    task: string,
): string[] {
    const args = ["-p", ...BASE_ARGS, "--system-prompt", REWRITER_PROMPT];
    if (model) {
        args.push("--model", formatModelString(model));
    }
    args.push(task);
    return args;
}

/**
 * Determine the command/args to invoke the pi binary.
 *
 * Handles bun virtual scripts, generic runtimes (node/bun where pi is
 * the main script), and direct pi executables.
 */
function getPiInvocation(): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return {
            command: process.execPath,
            args: [currentScript],
        };
    }

    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: process.execPath, args: [] };
    }

    return { command: "pi", args: [] };
}

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    // Cooperatively bail out if the session ends while the child runs.
    let sessionActive = true;
    pi.on("session_shutdown", () => {
        sessionActive = false;
    });

    pi.registerCommand("clarify", {
        description: "Rewrite a rough prompt into a precise one and fill the editor",
        handler: async (args, ctx) => {
            const task = args.trim();
            if (!task) {
                ctx.ui.notify("Usage: /clarify <task>", "warning");
                return;
            }
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/clarify requires interactive mode", "error");
                return;
            }

            const { command, args: invocationArgs } = getPiInvocation();
            const clarifyArgs = buildClarifyArgs(ctx.model, task);

            const result = await ctx.ui.custom<ClarifyResult | null>(
                (tui, theme, _kb, done) => {
                    const label = ctx.model
                        ? formatModelString(ctx.model)
                        : "default model";
                    const loader = new BorderedLoader(
                        tui,
                        theme,
                        `Clarifying with ${label}...`,
                    );
                    let child: ChildProcess | null = null;

                    loader.onAbort = () => {
                        child?.kill();
                        done(null);
                    };

                    const run = async (): Promise<ClarifyResult | null> => {
                        child = spawn(command, [...invocationArgs, ...clarifyArgs], {
                            stdio: ["ignore", "pipe", "pipe"],
                        });
                        let stdout = "";
                        let stderr = "";
                        child.stdout?.on("data", (chunk: Buffer) => {
                            stdout += chunk.toString("utf8");
                        });
                        child.stderr?.on("data", (chunk: Buffer) => {
                            stderr += chunk.toString("utf8");
                        });
                        const exitCode = await new Promise<number | null>(
                            (resolve) => {
                                child!.on("close", (code) => resolve(code));
                                child!.on("error", () => resolve(null));
                            },
                        );
                        if (exitCode !== 0) {
                            const detail = stderr.trim() || `exit code ${exitCode}`;
                            return {
                                status: "error",
                                message: `clarify failed (${detail})`,
                            };
                        }
                        const text = stdout.trim();
                        if (!text) {
                            return {
                                status: "error",
                                message: "clarify returned no output",
                            };
                        }
                        return { status: "ok", text };
                    };

                    run()
                        .then(done)
                        .catch(() => done(null));
                    return loader;
                },
            );

            if (!sessionActive) return;
            if (result === null) {
                ctx.ui.notify("Cancelled", "info");
                return;
            }
            if (result.status === "error") {
                ctx.ui.notify(result.message, "error");
                return;
            }
            ctx.ui.setEditorText(result.text);
            ctx.ui.notify(
                "Rewritten prompt loaded. Edit and submit when ready.",
                "info",
            );
        },
    });
}
