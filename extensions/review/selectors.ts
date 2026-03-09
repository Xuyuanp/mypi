/**
 * UI selector functions for choosing review targets.
 *
 * Each selector shows a TUI component and returns a ReviewTarget
 * (or null if the user cancels). They are extracted from the main
 * extension closure and receive their dependencies as parameters.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
    Container,
    type SelectItem,
    SelectList,
    Text,
} from "@mariozechner/pi-tui";
import type { ReviewTarget, ReviewPresetValue } from "./types.js";
import { REVIEW_PRESETS, TOGGLE_LOOP_FIXING_VALUE } from "./types.js";
import {
    getLocalBranches,
    getRecentCommits,
    hasUncommittedChanges,
    hasPendingChanges,
    getCurrentBranch,
    getDefaultBranch,
    parsePrReference,
    getPrInfo,
    checkoutPr,
    parseMrReference,
    getMrInfo,
    checkoutMr,
} from "./git.js";

type SelectorDeps = {
    pi: ExtensionAPI;
    getLoopFixingEnabled: () => boolean;
    setLoopFixingEnabled: (enabled: boolean) => void;
};

async function getSmartDefault(
    pi: ExtensionAPI,
): Promise<"uncommitted" | "baseBranch" | "commit"> {
    if (await hasUncommittedChanges(pi)) {
        return "uncommitted";
    }

    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);
    if (currentBranch && currentBranch !== defaultBranch) {
        return "baseBranch";
    }

    return "commit";
}

export async function showReviewSelector(
    ctx: ExtensionContext,
    deps: SelectorDeps,
): Promise<ReviewTarget | null> {
    const smartDefault = await getSmartDefault(deps.pi);
    const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
        value: preset.value,
        label: preset.label,
        description: preset.description,
    }));
    const smartDefaultIndex = presetItems.findIndex(
        (item) => item.value === smartDefault,
    );

    while (true) {
        const loopEnabled = deps.getLoopFixingEnabled();
        const loopToggleLabel = loopEnabled
            ? "Disable Loop Fixing"
            : "Enable Loop Fixing";
        const loopToggleDescription = loopEnabled
            ? "(currently on)"
            : "(currently off)";
        const items: SelectItem[] = [
            ...presetItems,
            {
                value: TOGGLE_LOOP_FIXING_VALUE,
                label: loopToggleLabel,
                description: loopToggleDescription,
            },
        ];

        const result = await ctx.ui.custom<ReviewPresetValue | null>(
            (tui, theme, _kb, done) => {
                const container = new Container();
                container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
                container.addChild(
                    new Text(theme.fg("accent", theme.bold("Select a review preset"))),
                );

                const selectList = new SelectList(items, Math.min(items.length, 10), {
                    selectedPrefix: (text) => theme.fg("accent", text),
                    selectedText: (text) => theme.fg("accent", text),
                    description: (text) => theme.fg("muted", text),
                    scrollInfo: (text) => theme.fg("dim", text),
                    noMatch: (text) => theme.fg("warning", text),
                });

                if (smartDefaultIndex >= 0) {
                    selectList.setSelectedIndex(smartDefaultIndex);
                }

                selectList.onSelect = (item) => done(item.value as ReviewPresetValue);
                selectList.onCancel = () => done(null);

                container.addChild(selectList);
                container.addChild(
                    new Text(theme.fg("dim", "Press enter to confirm or esc to go back")),
                );
                container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

                return {
                    render(width: number) {
                        return container.render(width);
                    },
                    invalidate() {
                        container.invalidate();
                    },
                    handleInput(data: string) {
                        selectList.handleInput(data);
                        tui.requestRender();
                    },
                };
            },
        );

        if (!result) return null;

        if (result === TOGGLE_LOOP_FIXING_VALUE) {
            const nextEnabled = !deps.getLoopFixingEnabled();
            deps.setLoopFixingEnabled(nextEnabled);
            ctx.ui.notify(
                nextEnabled ? "Loop fixing enabled" : "Loop fixing disabled",
                "info",
            );
            continue;
        }

        switch (result) {
            case "uncommitted":
                return { type: "uncommitted" };

            case "baseBranch": {
                const target = await showBranchSelector(ctx, deps.pi);
                if (target) return target;
                break;
            }

            case "commit": {
                if (deps.getLoopFixingEnabled()) {
                    ctx.ui.notify("Loop mode does not work with commit review.", "error");
                    break;
                }
                const target = await showCommitSelector(ctx, deps.pi);
                if (target) return target;
                break;
            }

            case "custom": {
                const target = await showCustomInput(ctx);
                if (target) return target;
                break;
            }

            case "folder": {
                const target = await showFolderInput(ctx);
                if (target) return target;
                break;
            }

            case "pullRequest": {
                const target = await showPrInput(ctx, deps.pi);
                if (target) return target;
                break;
            }

            case "mergeRequest": {
                const target = await showMrInput(ctx, deps.pi);
                if (target) return target;
                break;
            }

            default:
                return null;
        }
    }
}

export async function showBranchSelector(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
): Promise<ReviewTarget | null> {
    const branches = await getLocalBranches(pi);
    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);

    const candidateBranches = currentBranch
        ? branches.filter((b) => b !== currentBranch)
        : branches;

    if (candidateBranches.length === 0) {
        ctx.ui.notify(
            currentBranch
                ? `No other branches found (current branch: ${currentBranch})`
                : "No branches found",
            "error",
        );
        return null;
    }

    const sortedBranches = candidateBranches.sort((a, b) => {
        if (a === defaultBranch) return -1;
        if (b === defaultBranch) return 1;
        return a.localeCompare(b);
    });

    const items: SelectItem[] = sortedBranches.map((branch) => ({
        value: branch,
        label: branch,
        description: branch === defaultBranch ? "(default)" : "",
    }));

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(
            new Text(theme.fg("accent", theme.bold("Select base branch"))),
        );

        const selectList = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
        });

        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);

        container.addChild(selectList);
        container.addChild(
            new Text(
                theme.fg("dim", "Type to filter • enter to select • esc to cancel"),
            ),
        );
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        return {
            render(width: number) {
                return container.render(width);
            },
            invalidate() {
                container.invalidate();
            },
            handleInput(data: string) {
                selectList.handleInput(data);
                tui.requestRender();
            },
        };
    });

    if (!result) return null;
    return { type: "baseBranch", branch: result };
}

export async function showCommitSelector(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
): Promise<ReviewTarget | null> {
    const commits = await getRecentCommits(pi, 20);

    if (commits.length === 0) {
        ctx.ui.notify("No commits found", "error");
        return null;
    }

    const items: SelectItem[] = commits.map((commit) => ({
        value: commit.sha,
        label: `${commit.sha.slice(0, 7)} ${commit.title}`,
        description: "",
    }));

    const result = await ctx.ui.custom<{ sha: string; title: string } | null>(
        (tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
            container.addChild(
                new Text(theme.fg("accent", theme.bold("Select commit to review"))),
            );

            const selectList = new SelectList(items, Math.min(items.length, 10), {
                selectedPrefix: (text) => theme.fg("accent", text),
                selectedText: (text) => theme.fg("accent", text),
                description: (text) => theme.fg("muted", text),
                scrollInfo: (text) => theme.fg("dim", text),
                noMatch: (text) => theme.fg("warning", text),
            });

            selectList.onSelect = (item) => {
                const commit = commits.find((c) => c.sha === item.value);
                if (commit) {
                    done(commit);
                } else {
                    done(null);
                }
            };
            selectList.onCancel = () => done(null);

            container.addChild(selectList);
            container.addChild(
                new Text(
                    theme.fg("dim", "Type to filter • enter to select • esc to cancel"),
                ),
            );
            container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

            return {
                render(width: number) {
                    return container.render(width);
                },
                invalidate() {
                    container.invalidate();
                },
                handleInput(data: string) {
                    selectList.handleInput(data);
                    tui.requestRender();
                },
            };
        },
    );

    if (!result) return null;
    return { type: "commit", sha: result.sha, title: result.title };
}

export async function showCustomInput(
    ctx: ExtensionContext,
): Promise<ReviewTarget | null> {
    const result = await ctx.ui.editor(
        "Enter review instructions:",
        "Review the code for security vulnerabilities and potential bugs...",
    );

    if (!result?.trim()) return null;
    return { type: "custom", instructions: result.trim() };
}

export function parseReviewPaths(value: string): string[] {
    return value
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

export async function showFolderInput(
    ctx: ExtensionContext,
): Promise<ReviewTarget | null> {
    const result = await ctx.ui.editor(
        "Enter folders/files to review (space-separated or one per line):",
        ".",
    );

    if (!result?.trim()) return null;
    const paths = parseReviewPaths(result);
    if (paths.length === 0) return null;

    return { type: "folder", paths };
}

export async function showPrInput(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
): Promise<ReviewTarget | null> {
    if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
            "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.",
            "error",
        );
        return null;
    }

    const prRef = await ctx.ui.editor(
        "Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):",
        "",
    );

    if (!prRef?.trim()) return null;

    const prNumber = parsePrReference(prRef);
    if (!prNumber) {
        ctx.ui.notify(
            "Invalid PR reference. Enter a number or GitHub PR URL.",
            "error",
        );
        return null;
    }

    ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
    const prInfo = await getPrInfo(pi, prNumber);

    if (!prInfo) {
        ctx.ui.notify(
            `Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`,
            "error",
        );
        return null;
    }

    if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
            "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.",
            "error",
        );
        return null;
    }

    ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
    const checkoutResult = await checkoutPr(pi, prNumber);

    if (!checkoutResult.success) {
        ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, "error");
        return null;
    }

    ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");

    return {
        type: "pullRequest",
        prNumber,
        baseBranch: prInfo.baseBranch,
        title: prInfo.title,
    };
}

export async function handlePrCheckout(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    ref: string,
): Promise<ReviewTarget | null> {
    if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
            "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.",
            "error",
        );
        return null;
    }

    const prNumber = parsePrReference(ref);
    if (!prNumber) {
        ctx.ui.notify(
            "Invalid PR reference. Enter a number or GitHub PR URL.",
            "error",
        );
        return null;
    }

    ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
    const prInfo = await getPrInfo(pi, prNumber);

    if (!prInfo) {
        ctx.ui.notify(
            `Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`,
            "error",
        );
        return null;
    }

    ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
    const checkoutResult = await checkoutPr(pi, prNumber);

    if (!checkoutResult.success) {
        ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, "error");
        return null;
    }

    ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");

    return {
        type: "pullRequest",
        prNumber,
        baseBranch: prInfo.baseBranch,
        title: prInfo.title,
    };
}

export async function showMrInput(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
): Promise<ReviewTarget | null> {
    if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
            "Cannot checkout MR: you have uncommitted changes. Please commit or stash them first.",
            "error",
        );
        return null;
    }

    const mrRef = await ctx.ui.editor(
        "Enter MR number or URL (e.g. 123 or https://gitlab.com/owner/repo/-/merge_requests/123):",
        "",
    );

    if (!mrRef?.trim()) return null;

    const mrNumber = parseMrReference(mrRef);
    if (!mrNumber) {
        ctx.ui.notify(
            "Invalid MR reference. Enter a number or GitLab MR URL.",
            "error",
        );
        return null;
    }

    ctx.ui.notify(`Fetching MR !${mrNumber} info...`, "info");
    const mrInfo = await getMrInfo(pi, mrNumber);

    if (!mrInfo) {
        ctx.ui.notify(
            `Could not find MR !${mrNumber}. Make sure glab is authenticated and the MR exists.`,
            "error",
        );
        return null;
    }

    if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
            "Cannot checkout MR: you have uncommitted changes. Please commit or stash them first.",
            "error",
        );
        return null;
    }

    ctx.ui.notify(`Checking out MR !${mrNumber}...`, "info");
    const checkoutResult = await checkoutMr(pi, mrNumber);

    if (!checkoutResult.success) {
        ctx.ui.notify(`Failed to checkout MR: ${checkoutResult.error}`, "error");
        return null;
    }

    ctx.ui.notify(`Checked out MR !${mrNumber} (${mrInfo.headBranch})`, "info");

    return {
        type: "mergeRequest",
        mrNumber,
        baseBranch: mrInfo.baseBranch,
        title: mrInfo.title,
    };
}

export async function handleMrCheckout(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    ref: string,
): Promise<ReviewTarget | null> {
    if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
            "Cannot checkout MR: you have uncommitted changes. Please commit or stash them first.",
            "error",
        );
        return null;
    }

    const mrNumber = parseMrReference(ref);
    if (!mrNumber) {
        ctx.ui.notify(
            "Invalid MR reference. Enter a number or GitLab MR URL.",
            "error",
        );
        return null;
    }

    ctx.ui.notify(`Fetching MR !${mrNumber} info...`, "info");
    const mrInfo = await getMrInfo(pi, mrNumber);

    if (!mrInfo) {
        ctx.ui.notify(
            `Could not find MR !${mrNumber}. Make sure glab is authenticated and the MR exists.`,
            "error",
        );
        return null;
    }

    ctx.ui.notify(`Checking out MR !${mrNumber}...`, "info");
    const checkoutResult = await checkoutMr(pi, mrNumber);

    if (!checkoutResult.success) {
        ctx.ui.notify(`Failed to checkout MR: ${checkoutResult.error}`, "error");
        return null;
    }

    ctx.ui.notify(`Checked out MR !${mrNumber} (${mrInfo.headBranch})`, "info");

    return {
        type: "mergeRequest",
        mrNumber,
        baseBranch: mrInfo.baseBranch,
        title: mrInfo.title,
    };
}
