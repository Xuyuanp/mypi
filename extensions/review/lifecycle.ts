/**
 * Review lifecycle operations: executing reviews, ending reviews,
 * and the loop-fixing review cycle.
 *
 * Functions here receive a ReviewRuntime object that provides
 * access to the shared mutable state managed by the main extension.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
    ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type {
    ReviewTarget,
    EndReviewAction,
    EndReviewActionResult,
    EndReviewActionOptions,
} from "./types.js";
import {
    REVIEW_STATE_TYPE,
    REVIEW_ANCHOR_TYPE,
    REVIEW_LOOP_MAX_ITERATIONS,
} from "./types.js";
import { hasBlockingReviewFindings } from "./parsing.js";
import {
    REVIEW_RUBRIC,
    REVIEW_SUMMARY_PROMPT,
    REVIEW_FIX_FINDINGS_PROMPT,
    buildReviewPrompt,
    getUserFacingHint,
    loadProjectReviewGuidelines,
} from "./prompts.js";
import {
    getReviewState,
    getLastAssistantSnapshot,
    waitForLoopTurnToStart,
} from "./state.js";

export type ReviewRuntime = {
    pi: ExtensionAPI;
    getOriginId: () => string | undefined;
    setOriginId: (id: string | undefined) => void;
    isLoopInProgress: () => boolean;
    setLoopInProgress: (v: boolean) => void;
    setReviewWidget: (ctx: ExtensionContext, active: boolean) => void;
    clearReviewState: (ctx: ExtensionContext) => void;
};

export async function executeReview(
    rt: ReviewRuntime,
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    useFreshSession: boolean,
    options?: { includeLocalChanges?: boolean },
): Promise<boolean> {
    if (rt.getOriginId()) {
        ctx.ui.notify(
            "Already in a review. Use /end-review to finish first.",
            "warning",
        );
        return false;
    }

    if (useFreshSession) {
        let originId = ctx.sessionManager.getLeafId() ?? undefined;
        if (!originId) {
            rt.pi.appendEntry(REVIEW_ANCHOR_TYPE, {
                createdAt: new Date().toISOString(),
            });
            originId = ctx.sessionManager.getLeafId() ?? undefined;
        }
        if (!originId) {
            ctx.ui.notify("Failed to determine review origin.", "error");
            return false;
        }
        rt.setOriginId(originId);

        const lockedOriginId = originId;

        const entries = ctx.sessionManager.getEntries();
        const firstUserMessage = entries.find(
            (e) => e.type === "message" && e.message.role === "user",
        );

        if (firstUserMessage) {
            try {
                const result = await ctx.navigateTree(firstUserMessage.id, {
                    summarize: false,
                    label: "code-review",
                });
                if (result.cancelled) {
                    rt.setOriginId(undefined);
                    return false;
                }
            } catch (error) {
                rt.setOriginId(undefined);
                ctx.ui.notify(
                    `Failed to start review: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
                return false;
            }

            ctx.ui.setEditorText("");
        }

        rt.setOriginId(lockedOriginId);
        rt.setReviewWidget(ctx, true);
        rt.pi.appendEntry(REVIEW_STATE_TYPE, {
            active: true,
            originId: lockedOriginId,
        });
    }

    const prompt = await buildReviewPrompt(rt.pi, target, {
        includeLocalChanges: options?.includeLocalChanges === true,
    });
    const hint = getUserFacingHint(target);
    const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

    let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

    if (projectGuidelines) {
        fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`;
    }

    const modeHint = useFreshSession ? " (fresh session)" : "";
    ctx.ui.notify(`Starting review: ${hint}${modeHint}`, "info");

    rt.pi.sendUserMessage(fullPrompt);
    return true;
}

function getActiveReviewOrigin(
    rt: ReviewRuntime,
    ctx: ExtensionContext,
): string | undefined {
    const currentOrigin = rt.getOriginId();
    if (currentOrigin) {
        return currentOrigin;
    }

    const state = getReviewState(ctx);
    if (state?.active && state.originId) {
        rt.setOriginId(state.originId);
        return state.originId;
    }

    if (state?.active) {
        rt.setReviewWidget(ctx, false);
        rt.pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
        ctx.ui.notify(
            "Review state was missing origin info; cleared review status.",
            "warning",
        );
    }

    return undefined;
}

async function navigateWithSummary(
    ctx: ExtensionCommandContext,
    originId: string,
    showLoader: boolean,
): Promise<{ cancelled: boolean; error?: string } | null> {
    if (showLoader && ctx.hasUI) {
        return ctx.ui.custom<{ cancelled: boolean; error?: string } | null>(
            (tui, theme, _kb, done) => {
                const loader = new BorderedLoader(
                    tui,
                    theme,
                    "Returning and summarizing review branch...",
                );
                loader.onAbort = () => done(null);

                ctx
                    .navigateTree(originId, {
                        summarize: true,
                        customInstructions: REVIEW_SUMMARY_PROMPT,
                        replaceInstructions: true,
                    })
                    .then(done)
                    .catch((err) =>
                        done({
                            cancelled: false,
                            error: err instanceof Error ? err.message : String(err),
                        }),
                    );

                return loader;
            },
        );
    }

    try {
        return await ctx.navigateTree(originId, {
            summarize: true,
            customInstructions: REVIEW_SUMMARY_PROMPT,
            replaceInstructions: true,
        });
    } catch (error) {
        return {
            cancelled: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function executeEndReviewAction(
    rt: ReviewRuntime,
    ctx: ExtensionCommandContext,
    action: EndReviewAction,
    options: EndReviewActionOptions = {},
): Promise<EndReviewActionResult> {
    const originId = getActiveReviewOrigin(rt, ctx);
    if (!originId) {
        if (!getReviewState(ctx)?.active) {
            ctx.ui.notify(
                "Not in a review branch (use /review first, or review was started in current session mode)",
                "info",
            );
        }
        return "error";
    }

    const notifySuccess = options.notifySuccess ?? true;

    if (action === "returnOnly") {
        try {
            const result = await ctx.navigateTree(originId, { summarize: false });
            if (result.cancelled) {
                ctx.ui.notify(
                    "Navigation cancelled. Use /end-review to try again.",
                    "info",
                );
                return "cancelled";
            }
        } catch (error) {
            ctx.ui.notify(
                `Failed to return: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
            return "error";
        }

        rt.clearReviewState(ctx);
        if (notifySuccess) {
            ctx.ui.notify("Review complete! Returned to original position.", "info");
        }
        return "ok";
    }

    const summaryResult = await navigateWithSummary(
        ctx,
        originId,
        options.showSummaryLoader ?? false,
    );
    if (summaryResult === null) {
        ctx.ui.notify(
            "Summarization cancelled. Use /end-review to try again.",
            "info",
        );
        return "cancelled";
    }

    if (summaryResult.error) {
        ctx.ui.notify(`Summarization failed: ${summaryResult.error}`, "error");
        return "error";
    }

    if (summaryResult.cancelled) {
        ctx.ui.notify(
            "Navigation cancelled. Use /end-review to try again.",
            "info",
        );
        return "cancelled";
    }

    rt.clearReviewState(ctx);

    if (action === "returnAndSummarize") {
        if (!ctx.ui.getEditorText().trim()) {
            ctx.ui.setEditorText("Act on the review findings");
        }
        if (notifySuccess) {
            ctx.ui.notify("Review complete! Returned and summarized.", "info");
        }
        return "ok";
    }

    rt.pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: "followUp" });
    if (notifySuccess) {
        ctx.ui.notify(
            "Review complete! Returned and queued a follow-up to fix findings.",
            "info",
        );
    }
    return "ok";
}

export async function runLoopFixingReview(
    rt: ReviewRuntime,
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
): Promise<void> {
    if (rt.isLoopInProgress()) {
        ctx.ui.notify("Loop fixing review is already running.", "warning");
        return;
    }

    rt.setLoopInProgress(true);
    rt.setReviewWidget(ctx, Boolean(rt.getOriginId()));
    try {
        ctx.ui.notify(
            "Loop fixing enabled: using Empty branch mode and cycling until no blocking findings remain.",
            "info",
        );

        for (let pass = 1; pass <= REVIEW_LOOP_MAX_ITERATIONS; pass++) {
            const reviewBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
            const started = await executeReview(rt, ctx, target, true, {
                includeLocalChanges: true,
            });
            if (!started) {
                ctx.ui.notify(
                    "Loop fixing stopped before starting the review pass.",
                    "warning",
                );
                return;
            }

            const reviewTurnStarted = await waitForLoopTurnToStart(
                ctx,
                reviewBaselineAssistantId,
            );
            if (!reviewTurnStarted) {
                ctx.ui.notify(
                    "Loop fixing stopped: review pass did not start in time.",
                    "error",
                );
                return;
            }

            await ctx.waitForIdle();

            const reviewSnapshot = getLastAssistantSnapshot(ctx);
            if (!reviewSnapshot || reviewSnapshot.id === reviewBaselineAssistantId) {
                ctx.ui.notify(
                    "Loop fixing stopped: could not read the review result.",
                    "warning",
                );
                return;
            }

            if (reviewSnapshot.stopReason === "aborted") {
                ctx.ui.notify("Loop fixing stopped: review was aborted.", "warning");
                return;
            }

            if (reviewSnapshot.stopReason === "error") {
                ctx.ui.notify(
                    "Loop fixing stopped: review failed with an error.",
                    "error",
                );
                return;
            }

            if (reviewSnapshot.stopReason === "length") {
                ctx.ui.notify(
                    "Loop fixing stopped: review output was truncated (stopReason=length).",
                    "warning",
                );
                return;
            }

            if (!hasBlockingReviewFindings(reviewSnapshot.text)) {
                const finalized = await executeEndReviewAction(
                    rt,
                    ctx,
                    "returnAndSummarize",
                    {
                        showSummaryLoader: true,
                        notifySuccess: false,
                    },
                );
                if (finalized !== "ok") {
                    return;
                }

                ctx.ui.notify(
                    "Loop fixing complete: no blocking findings remain.",
                    "info",
                );
                return;
            }

            ctx.ui.notify(
                `Loop fixing pass ${pass}: found blocking findings, returning to fix them...`,
                "info",
            );

            const fixBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
            const sentFixPrompt = await executeEndReviewAction(
                rt,
                ctx,
                "returnAndFix",
                {
                    showSummaryLoader: true,
                    notifySuccess: false,
                },
            );
            if (sentFixPrompt !== "ok") {
                return;
            }

            const fixTurnStarted = await waitForLoopTurnToStart(
                ctx,
                fixBaselineAssistantId,
            );
            if (!fixTurnStarted) {
                ctx.ui.notify(
                    "Loop fixing stopped: fix pass did not start in time.",
                    "error",
                );
                return;
            }

            await ctx.waitForIdle();

            const fixSnapshot = getLastAssistantSnapshot(ctx);
            if (!fixSnapshot || fixSnapshot.id === fixBaselineAssistantId) {
                ctx.ui.notify(
                    "Loop fixing stopped: could not read the fix pass result.",
                    "warning",
                );
                return;
            }
            if (fixSnapshot.stopReason === "aborted") {
                ctx.ui.notify("Loop fixing stopped: fix pass was aborted.", "warning");
                return;
            }
            if (fixSnapshot.stopReason === "error") {
                ctx.ui.notify(
                    "Loop fixing stopped: fix pass failed with an error.",
                    "error",
                );
                return;
            }
            if (fixSnapshot.stopReason === "length") {
                ctx.ui.notify(
                    "Loop fixing stopped: fix pass output was truncated (stopReason=length).",
                    "warning",
                );
                return;
            }
        }

        ctx.ui.notify(
            `Loop fixing stopped after ${REVIEW_LOOP_MAX_ITERATIONS} passes (safety limit reached).`,
            "warning",
        );
    } finally {
        rt.setLoopInProgress(false);
        rt.setReviewWidget(ctx, Boolean(rt.getOriginId()));
    }
}
