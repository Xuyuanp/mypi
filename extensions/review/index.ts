/**
 * Code Review Extension (inspired by Codex's review feature)
 *
 * Provides a `/review` command that prompts the agent to review code changes.
 * Supports multiple review modes:
 * - Review a GitHub pull request (checks out the PR locally)
 * - Review a GitLab merge request (checks out the MR locally)
 * - Review against a base branch (PR style)
 * - Review uncommitted changes
 * - Review a specific commit
 * - Custom review instructions
 *
 * Usage:
 * - `/review` - show interactive selector
 * - `/review pr 123` - review PR #123 (checks out locally via gh)
 * - `/review pr https://github.com/owner/repo/pull/123` - review PR from URL
 * - `/review mr 123` - review MR !123 (checks out locally via glab)
 * - `/review mr https://gitlab.com/owner/repo/-/merge_requests/123` - review MR from URL
 * - `/review uncommitted` - review uncommitted changes directly
 * - `/review branch main` - review against main branch
 * - `/review commit abc123` - review specific commit
 * - `/review folder src docs` - review specific folders/files (snapshot, not diff)
 * - `/review custom "check for security issues"` - custom instructions
 *
 * Project-specific review guidelines:
 * - If a REVIEW_GUIDELINES.md file exists in the same directory as .pi,
 *   its contents are appended to the review prompt.
 *
 * Note: PR review requires a clean working tree (no uncommitted changes to tracked files).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
    executeEndReviewAction,
    executeReview,
    type ReviewRuntime,
    runLoopFixingReview,
} from "./lifecycle.js";
import {
    handleMrCheckout,
    handlePrCheckout,
    parseReviewPaths,
    showReviewSelector,
} from "./selectors.js";
import { getReviewSettings, getReviewState } from "./state.js";
import type { EndReviewAction, ReviewTarget } from "./types.js";
import { REVIEW_SETTINGS_TYPE, REVIEW_STATE_TYPE } from "./types.js";

function parseArgs(
    args: string | undefined,
): ReviewTarget | { type: "pr"; ref: string } | { type: "mr"; ref: string } | null {
    if (!args?.trim()) return null;

    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    switch (subcommand) {
        case "uncommitted":
            return { type: "uncommitted" };

        case "branch": {
            const branch = parts[1];
            if (!branch) return null;
            return { type: "baseBranch", branch };
        }

        case "commit": {
            const sha = parts[1];
            if (!sha) return null;
            const title = parts.slice(2).join(" ") || undefined;
            return { type: "commit", sha, title };
        }

        case "custom": {
            const instructions = parts.slice(1).join(" ");
            if (!instructions) return null;
            return { type: "custom", instructions };
        }

        case "folder": {
            const paths = parseReviewPaths(parts.slice(1).join(" "));
            if (paths.length === 0) return null;
            return { type: "folder", paths };
        }

        case "pr": {
            const ref = parts[1];
            if (!ref) return null;
            return { type: "pr", ref };
        }

        case "mr": {
            const ref = parts[1];
            if (!ref) return null;
            return { type: "mr", ref };
        }

        default:
            return null;
    }
}

function isLoopCompatibleTarget(target: ReviewTarget): boolean {
    return target.type !== "commit";
}

export default function reviewExtension(pi: ExtensionAPI) {
    let reviewOriginId: string | undefined;
    let endReviewInProgress = false;
    let reviewLoopFixingEnabled = false;
    let reviewLoopInProgress = false;

    // -- Review runtime passed to lifecycle functions --

    const rt: ReviewRuntime = {
        pi,
        getOriginId: () => reviewOriginId,
        setOriginId: (id) => {
            reviewOriginId = id;
        },
        isLoopInProgress: () => reviewLoopInProgress,
        setLoopInProgress: (v) => {
            reviewLoopInProgress = v;
        },
        setReviewWidget,
        clearReviewState,
    };

    // -- Widget and state helpers --

    function setReviewWidget(ctx: ExtensionContext, active: boolean) {
        if (!ctx.hasUI) return;
        if (!active) {
            ctx.ui.setWidget("review", undefined);
            return;
        }

        ctx.ui.setWidget("review", (_tui, theme) => {
            const message = reviewLoopInProgress
                ? "Review session active (loop fixing running)"
                : reviewLoopFixingEnabled
                  ? "Review session active (loop fixing enabled), return with /end-review"
                  : "Review session active, return with /end-review";
            const text = new Text(theme.fg("warning", message), 0, 0);
            return {
                render(width: number) {
                    return text.render(width);
                },
                invalidate() {
                    text.invalidate();
                },
            };
        });
    }

    function applyReviewState(ctx: ExtensionContext) {
        const state = getReviewState(ctx);

        if (state?.active && state.originId) {
            reviewOriginId = state.originId;
            setReviewWidget(ctx, true);
            return;
        }

        reviewOriginId = undefined;
        setReviewWidget(ctx, false);
    }

    function applyReviewSettings(ctx: ExtensionContext) {
        const state = getReviewSettings(ctx);
        reviewLoopFixingEnabled = state.loopFixingEnabled === true;
    }

    function setReviewLoopFixingEnabled(enabled: boolean) {
        reviewLoopFixingEnabled = enabled;
        pi.appendEntry(REVIEW_SETTINGS_TYPE, { loopFixingEnabled: enabled });
    }

    function clearReviewState(ctx: ExtensionContext) {
        setReviewWidget(ctx, false);
        reviewOriginId = undefined;
        pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
    }

    function applyAllReviewState(ctx: ExtensionContext) {
        applyReviewSettings(ctx);
        applyReviewState(ctx);
    }

    // -- Session event listeners --

    pi.on("session_start", (_event, ctx) => {
        applyAllReviewState(ctx);
    });

    pi.on("session_switch", (_event, ctx) => {
        applyAllReviewState(ctx);
    });

    pi.on("session_tree", (_event, ctx) => {
        applyAllReviewState(ctx);
    });

    // -- Register commands --

    pi.registerCommand("review", {
        description:
            "Review code changes (PR, uncommitted, branch, commit, folder, or custom)",
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("Review requires interactive mode", "error");
                return;
            }

            if (reviewLoopInProgress) {
                ctx.ui.notify("Loop fixing review is already running.", "warning");
                return;
            }

            if (reviewOriginId) {
                ctx.ui.notify(
                    "Already in a review. Use /end-review to finish first.",
                    "warning",
                );
                return;
            }

            const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
            if (code !== 0) {
                ctx.ui.notify("Not a git repository", "error");
                return;
            }

            let target: ReviewTarget | null = null;
            let fromSelector = false;
            const parsed = parseArgs(args);

            if (parsed) {
                if (parsed.type === "pr") {
                    target = await handlePrCheckout(ctx, pi, parsed.ref);
                    if (!target) {
                        ctx.ui.notify(
                            "PR review failed. Returning to review menu.",
                            "warning",
                        );
                    }
                } else if (parsed.type === "mr") {
                    target = await handleMrCheckout(ctx, pi, parsed.ref);
                    if (!target) {
                        ctx.ui.notify(
                            "MR review failed. Returning to review menu.",
                            "warning",
                        );
                    }
                } else {
                    target = parsed;
                }
            }

            if (!target) {
                fromSelector = true;
            }

            const selectorDeps = {
                pi,
                getLoopFixingEnabled: () => reviewLoopFixingEnabled,
                setLoopFixingEnabled: setReviewLoopFixingEnabled,
            };

            while (true) {
                if (!target && fromSelector) {
                    target = await showReviewSelector(ctx, selectorDeps);
                }

                if (!target) {
                    ctx.ui.notify("Review cancelled", "info");
                    return;
                }

                if (reviewLoopFixingEnabled && !isLoopCompatibleTarget(target)) {
                    ctx.ui.notify(
                        "Loop mode does not work with commit review.",
                        "error",
                    );
                    if (fromSelector) {
                        target = null;
                        continue;
                    }
                    return;
                }

                if (reviewLoopFixingEnabled) {
                    await runLoopFixingReview(rt, ctx, target);
                    return;
                }

                const entries = ctx.sessionManager.getEntries();
                const messageCount = entries.filter(
                    (e) => e.type === "message",
                ).length;

                let useFreshSession = messageCount === 0;

                if (messageCount > 0) {
                    const choice = await ctx.ui.select("Start review in:", [
                        "Empty branch",
                        "Current session",
                    ]);

                    if (choice === undefined) {
                        if (fromSelector) {
                            target = null;
                            continue;
                        }
                        ctx.ui.notify("Review cancelled", "info");
                        return;
                    }

                    useFreshSession = choice === "Empty branch";
                }

                await executeReview(rt, ctx, target, useFreshSession);
                return;
            }
        },
    });

    pi.registerCommand("end-review", {
        description: "Complete review and return to original position",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("End-review requires interactive mode", "error");
                return;
            }

            if (reviewLoopInProgress) {
                ctx.ui.notify(
                    "Loop fixing review is running. Wait for it to finish.",
                    "info",
                );
                return;
            }

            if (endReviewInProgress) {
                ctx.ui.notify("/end-review is already running", "info");
                return;
            }

            endReviewInProgress = true;
            try {
                const choice = await ctx.ui.select("Finish review:", [
                    "Return only",
                    "Return and fix findings",
                    "Return and summarize",
                ]);

                if (choice === undefined) {
                    ctx.ui.notify(
                        "Cancelled. Use /end-review to try again.",
                        "info",
                    );
                    return;
                }

                const action: EndReviewAction =
                    choice === "Return and fix findings"
                        ? "returnAndFix"
                        : choice === "Return and summarize"
                          ? "returnAndSummarize"
                          : "returnOnly";

                await executeEndReviewAction(rt, ctx, action, {
                    showSummaryLoader: true,
                    notifySuccess: true,
                });
            } finally {
                endReviewInProgress = false;
            }
        },
    });
}
