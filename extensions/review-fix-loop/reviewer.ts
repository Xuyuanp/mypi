/**
 * Runs the review using a dedicated SDK sub-session. The sub-session
 * is fully isolated: no extensions, no skills, no prompt templates.
 * The system prompt is the review rubric + project-specific guidelines.
 * The reviewer gets read-only tools and a pre-collected diff file.
 *
 * isCleanVerdict() checks the binary verdict for the loop exit.
 */

import { execSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
    AuthStorage,
    createAgentSession,
    createReadOnlyTools,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
} from "@mariozechner/pi-coding-agent";

import { buildReviewSystemPrompt, buildReviewUserPrompt } from "./prompts.js";
import type { ReviewEventCallback, ReviewFixConfig } from "./types.js";

export interface ReviewDeps {
    model?: Model<Api>;
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
}

// -- Diff collection --

function git(cwd: string, args: string): string {
    return execSync(`git ${args}`, {
        cwd,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
    });
}

/**
 * Collect git diff info and write it to a temp file.
 * Returns the absolute path to the temp file.
 * Caller is responsible for cleanup.
 */
export function collectDiffToFile(cwd: string): string {
    let parts: string[];
    try {
        parts = collectDiffParts(cwd);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to collect git diff in ${cwd}: ${msg}`);
    }

    const content = parts.length > 0 ? parts.join("\n\n") : "(no changes detected)";

    const diffPath = join(tmpdir(), `pi-review-diff-${Date.now()}.md`);
    writeFileSync(diffPath, content, "utf-8");
    return diffPath;
}

function collectDiffParts(cwd: string): string[] {
    const parts: string[] = [];

    const status = git(cwd, "status --porcelain").trim();
    if (status) {
        parts.push(`## Git Status\n\`\`\`\n${status}\n\`\`\``);
    }

    const staged = git(cwd, "diff --staged").trim();
    if (staged) {
        parts.push(`## Staged Changes\n\`\`\`diff\n${staged}\n\`\`\``);
    }

    const unstaged = git(cwd, "diff").trim();
    if (unstaged) {
        parts.push(`## Unstaged Changes\n\`\`\`diff\n${unstaged}\n\`\`\``);
    }

    const untracked = git(cwd, "ls-files --others --exclude-standard").trim();
    if (untracked) {
        parts.push(
            `## Untracked Files\n\nUse the \`read\` tool to inspect these files:\n\`\`\`\n${untracked}\n\`\`\``,
        );
    }

    return parts;
}

function removeDiffFile(diffPath: string): void {
    try {
        unlinkSync(diffPath);
    } catch {}
}

/**
 * Construct a cancellation error with `name === "AbortError"` so that
 * callers can branch on `err.name` without depending on the DOM
 * `DOMException` global.
 */
function makeAbortError(message = "Reviewer aborted"): Error {
    const err = new Error(message);
    err.name = "AbortError";
    return err;
}

/** Minimal session-shape used by the abort-wiring helper. */
interface AbortableSession {
    abort(): Promise<void>;
}

export interface SessionAbortWiring {
    /** Detach the listener. Safe to call multiple times. */
    detach(): void;
    /**
     * Error captured from a failed `session.abort()` call, if any.
     * Callers should surface this instead of treating the run as
     * successfully cancelled. Only reliable after `settled()` resolves
     * -- otherwise a late-rejecting `session.abort()` can slip through.
     */
    abortError(): unknown | undefined;
    /** True if the abort path was ever triggered. */
    wasAborted(): boolean;
    /**
     * Resolves once any in-flight `session.abort()` call kicked off by
     * this wiring has settled (fulfilled or rejected). Resolves
     * immediately if `abort()` was never triggered. Callers MUST await
     * this before reading `abortError()` to avoid the race where
     * `session.prompt(...)` settles before the `.catch()` handler runs
     * and a real abort failure gets misclassified as cancellation.
     */
    settled(): Promise<void>;
}

/**
 * Wire an external `AbortSignal` to a session's `abort()` method.
 *
 * Handles two races that a naive `signal.addEventListener("abort", ...)`
 * implementation misses:
 *
 *   1. **Aborted-before-wire.** `AbortSignal` does NOT replay `abort`
 *      events to listeners attached after the signal already fired, so
 *      a signal that aborts between a prior `signal.aborted` check and
 *      the `addEventListener` call would never trigger `session.abort()`.
 *      We re-check `signal.aborted` after attaching and trigger
 *      manually if needed.
 *
 *   2. **Swallowed abort errors.** A rejected `session.abort()` used
 *      to be silently dropped, leaving callers waiting on a prompt
 *      that may never honor the cancellation. We capture the error
 *      so the caller can surface it once the prompt settles.
 *
 * The listener runs synchronously on the signal's `abort` event, so
 * `session.abort()` itself is awaited via `.catch()` and its rejection
 * is stashed for retrieval via `abortError()`.
 */
export function wireSessionAbort(
    session: AbortableSession,
    signal: AbortSignal,
): SessionAbortWiring {
    let aborted = false;
    let capturedError: unknown;
    let detached = false;
    // Tracks the in-flight `session.abort()` promise so callers can
    // await its settlement before reading `abortError()`. Without this,
    // an `abort()` that rejects on a later tick (async transport
    // failure, etc.) would be invisible to the caller.
    let abortPromise: Promise<void> | undefined;

    const trigger = () => {
        if (aborted) return;
        aborted = true;
        abortPromise = session.abort().catch((err) => {
            capturedError = err;
        });
    };

    signal.addEventListener("abort", trigger);

    // Close the race: the signal may have aborted between the caller's
    // earlier check and our listener registration. AbortSignal does not
    // replay events for late listeners, so we must check explicitly.
    if (signal.aborted) {
        trigger();
    }

    return {
        detach() {
            if (detached) return;
            detached = true;
            signal.removeEventListener("abort", trigger);
        },
        abortError() {
            return capturedError;
        },
        wasAborted() {
            return aborted;
        },
        async settled() {
            if (abortPromise) await abortPromise;
        },
    };
}

/**
 * Run a code review using a dedicated SDK sub-session.
 *
 * Collects the git diff to a temp file, creates an isolated
 * AgentSession with the review model + read-only tools, sends
 * the review prompt, collects the response, and cleans up.
 *
 * If `config.signal` is provided and fires while the reviewer is
 * running, the underlying AgentSession is aborted and this function
 * throws an `AbortError` (`err.name === "AbortError"`). The caller is
 * responsible for treating that as a cancellation rather than a
 * reviewer failure.
 *
 * Throws on failure (model not found, API error, etc.).
 */
export async function runReview(
    config: ReviewFixConfig & {
        cwd: string;
        onEvent?: ReviewEventCallback;
        signal?: AbortSignal;
    },
    deps?: ReviewDeps,
): Promise<string> {
    if (config.signal?.aborted) {
        throw makeAbortError();
    }
    const authStorage = deps?.authStorage ?? AuthStorage.create();
    const modelRegistry = deps?.modelRegistry ?? ModelRegistry.create(authStorage);
    const model =
        deps?.model ?? modelRegistry.find(config.modelProvider, config.modelId);
    if (!model) {
        throw new Error(
            `Review model not found: ${config.modelProvider}/${config.modelId}`,
        );
    }

    const diffPath = collectDiffToFile(config.cwd);

    try {
        const systemPrompt = await buildReviewSystemPrompt(config.cwd);

        const loader = new DefaultResourceLoader({
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPromptOverride: () => systemPrompt,
            appendSystemPromptOverride: () => [],
        });
        await loader.reload();

        const { session } = await createAgentSession({
            model,
            thinkingLevel: config.thinkingLevel,
            cwd: config.cwd,
            tools: createReadOnlyTools(config.cwd),
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(),
            authStorage,
            modelRegistry,
        });

        // If the caller already cancelled before the session was
        // constructed, dispose and bail out before we issue a prompt.
        if (config.signal?.aborted) {
            session.dispose();
            throw makeAbortError();
        }

        // Wire the external abort signal to the sub-session. When the
        // signal fires, `session.abort()` aborts the in-flight agent
        // turn and waits for idle internally; we still await the
        // pending `session.prompt(...)` below so that the stream fully
        // unwinds before we throw, and then detach the listener in the
        // outer `finally` to avoid leaks if the prompt settles first.
        //
        // `wireSessionAbort` closes two races that a naive listener
        // would miss: (a) signal aborted between the earlier check and
        // listener registration, and (b) rejections from `session.abort()`
        // that must be surfaced rather than swallowed.
        const wiring = config.signal
            ? wireSessionAbort(session, config.signal)
            : undefined;

        try {
            let fullText = "";
            const unsubscribe = session.subscribe((event) => {
                if (event.type === "message_update") {
                    const ae = event.assistantMessageEvent;
                    if (ae.type === "text_delta") {
                        fullText += ae.delta;
                        config.onEvent?.({
                            type: "text_delta",
                            delta: ae.delta,
                        });
                    } else if (ae.type === "thinking_delta") {
                        config.onEvent?.({
                            type: "thinking_delta",
                            delta: ae.delta,
                        });
                    } else if (ae.type === "thinking_end") {
                        config.onEvent?.({ type: "thinking_end" });
                    }
                } else if (event.type === "tool_execution_start") {
                    config.onEvent?.({
                        type: "tool_start",
                        toolName: event.toolName,
                        args: (event.args as Record<string, unknown>) ?? {},
                    });
                } else if (event.type === "tool_execution_end") {
                    config.onEvent?.({
                        type: "tool_end",
                        toolName: event.toolName,
                        isError: event.isError,
                    });
                }
            });

            const userPrompt = buildReviewUserPrompt(diffPath, config.extraFocus);
            await session.prompt(userPrompt);
            unsubscribe();

            // Wait for any in-flight `session.abort()` to fully settle
            // BEFORE inspecting `abortError()`. `session.prompt(...)`
            // can resolve before the abort promise's `.catch()` handler
            // fires (e.g., transport failure rejects on a later tick),
            // and without this await a real abort failure would be
            // misclassified as a plain user cancellation a few lines
            // down.
            if (wiring) await wiring.settled();

            // If `session.abort()` itself rejected, surface that error
            // so the caller sees a real failure instead of a silently
            // degraded "successful" run.
            const abortErr = wiring?.abortError();
            if (abortErr !== undefined) {
                throw abortErr instanceof Error
                    ? abortErr
                    : new Error(`Reviewer abort failed: ${String(abortErr)}`);
            }

            if (config.signal?.aborted) {
                throw makeAbortError();
            }

            if (!fullText.trim()) {
                throw new Error("Review session produced no output");
            }

            return fullText;
        } finally {
            wiring?.detach();
            session.dispose();
        }
    } finally {
        removeDiffFile(diffPath);
    }
}

/**
 * Check whether the review verdict is "correct" (no blocking issues).
 *
 * The verdict format is defined by the review rubric:
 *   "provide an overall verdict: 'correct' (no blocking issues)
 *    or 'needs attention' (has blocking issues)"
 *
 * Returns true only when the verdict clearly says "correct".
 * Returns false for "needs attention", ambiguous, or missing verdict.
 */
export function isCleanVerdict(reviewOutput: string): boolean {
    const lines = reviewOutput.split(/\r?\n/);
    const LOOKAHEAD = 4;

    for (let i = 0; i < lines.length; i++) {
        if (!/verdict/i.test(lines[i])) continue;

        const afterVerdict = lines[i].replace(/^.*?verdict/i, "");
        const window = [afterVerdict, ...lines.slice(i + 1, i + 1 + LOOKAHEAD)]
            .join("\n")
            .toLowerCase();

        if (window.includes("needs attention")) return false;
        if (
            /\bcorrect\b/.test(window) &&
            !/\bnot\s+correct\b/.test(window) &&
            !/\bincorrect\b/.test(window) &&
            !/\bpartially\s+correct\b/.test(window)
        ) {
            return true;
        }
    }

    return false;
}
