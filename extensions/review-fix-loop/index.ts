/**
 * Review-Fix Loop Extension
 *
 * Mechanically orchestrates a review-fix loop:
 * 1. Runs an external reviewer (SDK sub-session)
 * 2. Feeds findings inline to the fixer agent
 * 3. Repeats until the reviewer returns a clean verdict or max iterations
 *
 * Each fix iteration runs in a disposable session branch. After the fixer
 * finishes, navigateTree returns to the origin point. Code changes and
 * DECISIONS.md persist on disk; conversation context does not carry over.
 *
 * While the loop is active, a dedicated overlay replaces the input
 * editor. It shows the streaming reviewer output (during review) or the
 * static review feedback (during fix). The user interacts with the loop
 * only through that overlay; `q`/`Esc` pressed twice within 1.5s aborts
 * the loop.
 *
 * Usage:
 *   /review-fix                          -- start loop (uncommitted, max 5)
 *   /review-fix --max 3                  -- override max iterations
 *   /review-fix --model sonnet:high      -- override review model + thinking
 *   /review-fix --model openai/gpt-4o    -- override review model
 *   /review-fix --thinking medium        -- override thinking level only
 *   /review-fix "focus on error handling" -- extra focus for reviewer
 *   /review-fix --max 8 "focus on auth"  -- combined
 *
 * Model resolution order:
 *   1. --model flag (supports "provider/id:thinkingLevel" format)
 *   2. PI_REVIEW_FIX_MODEL env var (same format)
 *   3. Default: github-copilot/gpt-5.3-codex, thinking: medium
 *
 * Thinking level resolution (highest priority first):
 *   1. --thinking flag
 *   2. :suffix on --model flag
 *   3. :suffix on PI_REVIEW_FIX_MODEL env var
 *   4. Default: medium
 */

import { parseArgs as nodeParseArgs } from "node:util";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { buildFixPrompt } from "./prompts.js";
import { isCleanVerdict, runReview } from "./reviewer.js";
import type {
    AssistantSnapshot,
    LoopExitReason,
    LoopResult,
    ReviewFixConfig,
    ThinkingLevel,
} from "./types.js";
import {
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_THINKING_LEVEL,
    LOOP_START_POLL_MS,
    LOOP_START_TIMEOUT_MS,
    RESULT_MESSAGE_TYPE,
    REVIEW_MODEL_ENV,
    REVIEW_MODEL_ID,
    REVIEW_MODEL_PROVIDER,
} from "./types.js";
import {
    buildResultMessage,
    type ResultMessageDetails,
    ReviewFixOverlay,
    renderResultMessage,
} from "./ui.js";

// -- Helpers (pure / stateless) --

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect the cancellation error shape produced by `runReview` when its
 * `signal` fires. Matching on `err.name` avoids a dependency on the
 * DOM `DOMException` global and also accepts any `AbortSignal`-style
 * error that downstream code may raise in the future.
 */
function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
}

/**
 * Classify a thrown error from `runReview`.
 *
 * Returns `"aborted"` ONLY when the error is itself an `AbortError`.
 * Any other error -- including ones surfaced while the external abort
 * signal also happens to be fired (e.g., a rejected `session.abort()`
 * that `runReview` re-throws) -- is a real reviewer failure and must
 * be reported as `"error"`. The abort-signal state is deliberately
 * NOT consulted here: letting it short-circuit to `"aborted"` would
 * silently drop real failures whenever the user pressed abort around
 * the same time.
 */
export function classifyReviewError(err: unknown): "aborted" | "error" {
    return isAbortError(err) ? "aborted" : "error";
}

function extractAssistantText(content: unknown): string {
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";

    const parts = content
        .filter((p): p is { type: "text"; text: string } =>
            Boolean(
                p &&
                    typeof p === "object" &&
                    "type" in p &&
                    p.type === "text" &&
                    "text" in p,
            ),
        )
        .map((p) => p.text);
    return parts.join("\n").trim();
}

function getLastAssistantSnapshot(ctx: ExtensionContext): AssistantSnapshot | null {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }
        const msg = entry.message as {
            content?: unknown;
            stopReason?: string;
        };
        return {
            id: entry.id,
            text: extractAssistantText(msg.content),
            stopReason: msg.stopReason,
        };
    }
    return null;
}

async function waitForTurnToStart(
    ctx: ExtensionContext,
    previousAssistantId: string | undefined,
    signal: AbortSignal,
): Promise<boolean> {
    const deadline = Date.now() + LOOP_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (signal.aborted) return false;
        const lastId = getLastAssistantSnapshot(ctx)?.id;
        if (
            !ctx.isIdle() ||
            ctx.hasPendingMessages() ||
            (lastId && lastId !== previousAssistantId)
        ) {
            return true;
        }
        await sleep(LOOP_START_POLL_MS);
    }
    return false;
}

interface ParsedArgs {
    maxIterations: number | undefined;
    model: string | undefined;
    thinking: string | undefined;
    extraFocus: string | undefined;
}

function parseArgs(args: string): ParsedArgs {
    // Tokenize: split on whitespace, but keep quoted strings intact.
    const tokens: string[] = [];
    const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (let m = tokenPattern.exec(args); m; m = tokenPattern.exec(args)) {
        tokens.push(m[1] ?? m[2] ?? m[3]);
    }

    const { values, positionals } = nodeParseArgs({
        args: tokens,
        options: {
            max: { type: "string" },
            model: { type: "string" },
            thinking: { type: "string" },
        },
        allowPositionals: true,
        strict: false,
    });

    const maxStr = typeof values.max === "string" ? values.max : undefined;
    let maxIterations: number | undefined;
    if (maxStr) {
        const n = Number.parseInt(maxStr, 10);
        if (n >= 1) maxIterations = n;
    }

    const extraFocus = positionals.length > 0 ? positionals.join(" ") : undefined;

    const model = typeof values.model === "string" ? values.model : undefined;
    const thinking =
        typeof values.thinking === "string" ? values.thinking : undefined;

    return { maxIterations, model, thinking, extraFocus };
}

// -- Model resolution --

interface ParsedModelSpec {
    provider: string | undefined;
    modelId: string | undefined;
    thinkingLevel: ThinkingLevel | undefined;
}

/**
 * Parse a model spec string in the format used by `pi --model`:
 *   "provider/modelId:thinkingLevel"
 *   "provider/modelId"
 *   "modelId:thinkingLevel"
 *   "modelId"
 *   ":thinkingLevel"  (thinking level only)
 *
 * The colon suffix is split off unconditionally. No compile-time
 * coupling to the set of valid thinking levels -- invalid values
 * propagate to createAgentSession which will surface a clear error.
 */
function parseModelSpec(spec: string | undefined): ParsedModelSpec {
    const result: ParsedModelSpec = {
        provider: undefined,
        modelId: undefined,
        thinkingLevel: undefined,
    };
    if (!spec) return result;

    let base = spec;

    // Split on the last colon for a thinking level suffix.
    const lastColon = spec.lastIndexOf(":");
    if (lastColon >= 0) {
        const suffix = spec.slice(lastColon + 1);
        if (suffix) {
            result.thinkingLevel = suffix as ThinkingLevel;
            base = spec.slice(0, lastColon);
        }
    }

    if (base) {
        const slashIdx = base.indexOf("/");
        if (slashIdx >= 0) {
            result.provider = base.slice(0, slashIdx) || undefined;
            result.modelId = base.slice(slashIdx + 1) || undefined;
        } else {
            result.modelId = base;
        }
    }

    return result;
}

/**
 * Find a model in the registry by spec. Supports:
 * - Exact "provider/id" match
 * - Bare "id" match (exact id, then substring on id, then substring on name)
 * - Ambiguous bare id (multiple providers) returns undefined
 */
function findModel(
    registry: ModelRegistry,
    spec: ParsedModelSpec,
): Model<Api> | undefined {
    if (!spec.modelId) return undefined;

    // Exact provider + id lookup
    if (spec.provider) {
        return registry.find(spec.provider, spec.modelId);
    }

    const all = registry.getAll();
    const id = spec.modelId;

    // Exact id match
    const exactById = all.filter((m) => m.id === id);
    if (exactById.length === 1) return exactById[0];
    if (exactById.length > 1) return undefined; // ambiguous

    // Substring match on id
    const partialById = all.filter((m) => m.id.includes(id));
    if (partialById.length === 1) return partialById[0];
    if (partialById.length > 1) return undefined; // ambiguous

    // Substring match on name
    const lower = id.toLowerCase();
    const partialByName = all.filter((m) => m.name.toLowerCase().includes(lower));
    if (partialByName.length === 1) return partialByName[0];

    return undefined;
}

interface ResolvedModel {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
}

interface ResolveResult {
    resolved?: ResolvedModel;
    error?: string;
}

/**
 * Resolve model configuration from the 3-tier chain:
 *   1. CLI flags (--model, --thinking)
 *   2. Environment variable (PI_REVIEW_FIX_MODEL)
 *   3. Defaults (REVIEW_MODEL_PROVIDER/REVIEW_MODEL_ID, DEFAULT_THINKING_LEVEL)
 *
 * --thinking flag takes highest priority for thinking level,
 * followed by :suffix on --model, then :suffix on env, then default.
 */
function resolveReviewModel(
    registry: ModelRegistry,
    cliModel: string | undefined,
    cliThinking: string | undefined,
): ResolveResult {
    const cliSpec = parseModelSpec(cliModel);
    const envSpec = parseModelSpec(process.env[REVIEW_MODEL_ENV] || undefined);

    // Resolve model: CLI spec -> env spec -> defaults
    let provider: string;
    let modelId: string;

    const hasCliModel = cliSpec.provider || cliSpec.modelId;
    const hasEnvModel = envSpec.provider || envSpec.modelId;

    if (hasCliModel) {
        const model = findModel(registry, cliSpec);
        if (!model) {
            const ref = cliSpec.provider
                ? `${cliSpec.provider}/${cliSpec.modelId}`
                : cliSpec.modelId;
            return {
                error: `Model not found: ${ref}`,
            };
        }
        provider = model.provider;
        modelId = model.id;
    } else if (hasEnvModel) {
        const model = findModel(registry, envSpec);
        if (!model) {
            const ref = envSpec.provider
                ? `${envSpec.provider}/${envSpec.modelId}`
                : envSpec.modelId;
            return {
                error: `Model from ${REVIEW_MODEL_ENV} not found: ${ref}`,
            };
        }
        provider = model.provider;
        modelId = model.id;
    } else {
        provider = REVIEW_MODEL_PROVIDER;
        modelId = REVIEW_MODEL_ID;
    }

    // Resolve thinking level: --thinking > CLI :suffix > env :suffix > default
    // No validation here -- invalid values will fail at createAgentSession.
    const thinkingLevel: ThinkingLevel =
        (cliThinking as ThinkingLevel) ??
        cliSpec.thinkingLevel ??
        envSpec.thinkingLevel ??
        DEFAULT_THINKING_LEVEL;

    return {
        resolved: { provider, modelId, thinkingLevel },
    };
}

// -- Extension entry point --

export default function reviewFixLoop(pi: ExtensionAPI) {
    // Module-level state is now minimal: just a reentry guard. Per-run
    // state lives in the overlay and in the command-handler closure.
    let loopActive = false;

    pi.on("session_start", async (_event, _ctx) => {
        loopActive = false;
    });

    // -- Navigation helper --

    type ReturnToOriginResult = "ok" | "cancelled" | "error";

    async function returnToOrigin(
        ctx: ExtensionCommandContext,
        originId: string,
    ): Promise<ReturnToOriginResult> {
        try {
            const result = await ctx.navigateTree(originId, {
                summarize: false,
            });
            return result.cancelled ? "cancelled" : "ok";
        } catch {
            return "error";
        }
    }

    // -- Main loop --

    async function runLoop(
        ctx: ExtensionCommandContext,
        config: ReviewFixConfig,
        overlay: ReviewFixOverlay,
        originId: string,
    ): Promise<LoopResult> {
        const maxIterations = config.maxIterations;

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            if (overlay.signal.aborted) {
                return { iterations: iteration, exitReason: "aborted" };
            }

            // [1] Run review (SDK sub-session, no session impact).
            overlay.setPhase("reviewing", iteration, maxIterations);

            let reviewOutput: string;
            try {
                reviewOutput = await runReview({
                    ...config,
                    cwd: ctx.cwd,
                    signal: overlay.signal,
                    onEvent: (event) => {
                        if (event.type === "text_delta") {
                            overlay.appendReviewDelta(event.delta);
                        }
                    },
                });
            } catch (err) {
                // A confirmed abort during the reviewer phase surfaces
                // as an AbortError thrown from `runReview`. Treat it as
                // a user-initiated cancellation rather than a reviewer
                // failure so the overlay does not flash an error banner
                // and the final result reads as "aborted".
                //
                // Crucially, DO NOT use `overlay.signal.aborted` as a
                // fallback classifier: `runReview` may throw a real
                // failure (e.g., a surfaced `session.abort()` rejection)
                // while the user has also pressed abort, and masking
                // that as "aborted" would silently drop the failure.
                if (classifyReviewError(err) === "aborted") {
                    return {
                        iterations: iteration + 1,
                        exitReason: "aborted",
                    };
                }
                const msg = err instanceof Error ? err.message : String(err);
                const errorMessage = `Review failed: ${msg}`;
                overlay.setError(errorMessage);
                return {
                    iterations: iteration + 1,
                    exitReason: "error",
                    errorMessage,
                };
            }

            if (overlay.signal.aborted) {
                return { iterations: iteration + 1, exitReason: "aborted" };
            }

            // Empty reviewer output indicates a transient failure.
            // Exit with error instead of feeding an empty prompt into a
            // fix pass, which would otherwise repeat until max iterations.
            if (reviewOutput.trim().length === 0) {
                const errorMessage = "Reviewer produced no output";
                overlay.setError(errorMessage);
                return {
                    iterations: iteration + 1,
                    exitReason: "error",
                    errorMessage,
                };
            }

            // [2] Check verdict.
            if (isCleanVerdict(reviewOutput)) {
                overlay.setClean();
                return { iterations: iteration + 1, exitReason: "clean" };
            }

            // [3] Prepare fixing phase. Canonicalise the body to the
            // reviewer's final string, then flip phase (which resets
            // elapsed clock and scroll without touching bodyText).
            overlay.setFixingBody(reviewOutput);
            overlay.setPhase("fixing", iteration, maxIterations);

            const baselineId = getLastAssistantSnapshot(ctx)?.id;
            pi.sendUserMessage(
                buildFixPrompt(reviewOutput, iteration, maxIterations),
            );

            // [4] Wait for fixer to finish, racing against the overlay's
            // abort signal so confirmed-abort kills the turn immediately.
            // The abort listener is installed BEFORE waitForTurnToStart so
            // that a confirmed abort during the turn-start wait also
            // triggers ctx.abort() and exits as "aborted" rather than
            // falling through to the timeout error path.
            //
            // The listener is scoped to this single fixing iteration: it
            // is always detached before the loop moves on (via
            // detachAbortListener below), so later phases (reviewing,
            // post-loop cleanup, overlay.dispose()) cannot accidentally
            // re-trigger ctx.abort() through a leaked listener.
            let abortListener: (() => void) | undefined;
            let detached = false;
            const detachAbortListener = () => {
                if (detached) return;
                detached = true;
                if (abortListener) {
                    overlay.signal.removeEventListener("abort", abortListener);
                }
            };
            const abortPromise = new Promise<void>((resolve) => {
                if (overlay.signal.aborted) {
                    ctx.abort();
                    resolve();
                    return;
                }
                abortListener = () => {
                    ctx.abort();
                    resolve();
                };
                overlay.signal.addEventListener("abort", abortListener, {
                    once: true,
                });
            });

            try {
                const started = await waitForTurnToStart(
                    ctx,
                    baselineId,
                    overlay.signal,
                );
                if (overlay.signal.aborted) {
                    // Let any in-flight turn unwind before returning.
                    await ctx.waitForIdle();
                    return {
                        iterations: iteration + 1,
                        exitReason: "aborted",
                    };
                }
                if (!started) {
                    const errorMessage = "Fix pass did not start in time.";
                    overlay.setError(errorMessage);
                    return {
                        iterations: iteration + 1,
                        exitReason: "error",
                        errorMessage,
                    };
                }

                await Promise.race([ctx.waitForIdle(), abortPromise]);

                // If aborted mid-fix, still wait for the in-flight turn to
                // fully unwind before reading its stop reason.
                if (overlay.signal.aborted) {
                    await ctx.waitForIdle();
                }
            } finally {
                detachAbortListener();
            }

            // [5] Inspect stop reason.
            const snapshot = getLastAssistantSnapshot(ctx);
            let exitReason: LoopExitReason | undefined;
            let errorMessage: string | undefined;

            if (!snapshot || snapshot.id === baselineId) {
                errorMessage = "Could not read fix pass result.";
                overlay.setError(errorMessage);
                exitReason = "error";
            } else if (snapshot.stopReason === "aborted") {
                exitReason = "aborted";
            } else if (snapshot.stopReason === "error") {
                errorMessage = "Fix pass ended with error.";
                overlay.setError(errorMessage);
                exitReason = "error";
            }

            if (overlay.signal.aborted) {
                exitReason = "aborted";
                // Abort takes precedence over any error we just recorded;
                // clear the error message so the final result reads as an
                // abort, not an error.
                errorMessage = undefined;
            }

            // [6] Navigate back to origin (discard fix branch).
            const navResult = await returnToOrigin(ctx, originId);

            if (exitReason) {
                return {
                    iterations: iteration + 1,
                    exitReason,
                    errorMessage,
                };
            }

            if (navResult !== "ok") {
                const reason: LoopExitReason =
                    navResult === "cancelled" ? "aborted" : "error";
                const navErrorMessage =
                    navResult === "cancelled"
                        ? "Navigation back to origin was cancelled; aborting loop."
                        : "Failed to navigate back to origin; aborting loop to prevent context drift.";
                overlay.setError(navErrorMessage);
                return {
                    iterations: iteration + 1,
                    exitReason: reason,
                    errorMessage: reason === "error" ? navErrorMessage : undefined,
                };
            }
        }

        return {
            iterations: maxIterations,
            exitReason: "max-iterations",
        };
    }

    // -- Commands --

    pi.registerCommand("review-fix", {
        description: "Start a review-fix loop (external reviewer + fixer agent)",
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("review-fix requires interactive mode", "error");
                return;
            }

            if (loopActive) {
                ctx.ui.notify(
                    "Review-fix loop is already active. Press Esc to abort.",
                    "warning",
                );
                return;
            }

            const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
            if (code !== 0) {
                ctx.ui.notify("Not a git repository", "error");
                return;
            }

            const parsed = parseArgs(args);

            const { resolved, error } = resolveReviewModel(
                ctx.modelRegistry,
                parsed.model,
                parsed.thinking,
            );
            if (error || !resolved) {
                ctx.ui.notify(error ?? "Failed to resolve model", "error");
                return;
            }

            const config: ReviewFixConfig = {
                target: "uncommitted",
                maxIterations: parsed.maxIterations ?? DEFAULT_MAX_ITERATIONS,
                extraFocus: parsed.extraFocus,
                modelProvider: resolved.provider,
                modelId: resolved.modelId,
                thinkingLevel: resolved.thinkingLevel,
            };

            loopActive = true;

            // Mark origin: the point we return to after each fix.
            let originId = ctx.sessionManager.getLeafId() ?? undefined;
            if (!originId) {
                pi.appendEntry("review-fix-anchor", {
                    createdAt: new Date().toISOString(),
                });
                originId = ctx.sessionManager.getLeafId() ?? undefined;
            }
            if (!originId) {
                ctx.ui.notify("Failed to determine session origin.", "error");
                loopActive = false;
                return;
            }

            const pinnedOriginId: string = originId;

            let loopResult: LoopResult | undefined;
            let resultWarning: string | undefined;

            try {
                loopResult = await ctx.ui.custom<LoopResult>(
                    (tui, theme, _kb, done) => {
                        const overlay = new ReviewFixOverlay(tui, theme);

                        runLoop(ctx, config, overlay, pinnedOriginId)
                            .then((result) => {
                                done(result);
                            })
                            .catch((err) => {
                                const msg =
                                    err instanceof Error ? err.message : String(err);
                                const errorMessage = `Loop error: ${msg}`;
                                overlay.setError(errorMessage);
                                done({
                                    iterations: 0,
                                    exitReason: "error",
                                    errorMessage,
                                });
                            });

                        return overlay;
                    },
                    {},
                );

                // Final sweep: ensure we are back at origin even if the
                // last loop iteration skipped navigation (e.g. immediate
                // error or clean verdict on iteration 0).
                const navResult = await returnToOrigin(ctx, pinnedOriginId);
                if (navResult !== "ok") {
                    resultWarning =
                        navResult === "cancelled"
                            ? "Return to origin was cancelled."
                            : "Failed to return to origin.";
                }
            } finally {
                loopActive = false;
                // Best-effort return to origin on unexpected errors.
                try {
                    await ctx.navigateTree(pinnedOriginId, {
                        summarize: false,
                    });
                } catch {}
            }

            // Send result message AFTER the finally's navigateTree so it
            // is not discarded by the navigation.
            if (loopResult) {
                const msg = buildResultMessage(loopResult, resultWarning);
                pi.sendMessage(
                    {
                        customType: RESULT_MESSAGE_TYPE,
                        content: msg.content,
                        display: true,
                        details: msg.details,
                    },
                    { triggerTurn: false },
                );
            }
        },
    });

    pi.registerMessageRenderer<ResultMessageDetails>(
        RESULT_MESSAGE_TYPE,
        (message, options, theme) => {
            if (typeof message.content !== "string") return undefined;
            return renderResultMessage(
                { content: message.content, details: message.details },
                options,
                theme,
            );
        },
    );
}
