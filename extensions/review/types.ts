/**
 * Shared types, constants, and review presets for the review extension.
 */

// Session entry custom types
export const REVIEW_STATE_TYPE = "review-session";
export const REVIEW_ANCHOR_TYPE = "review-anchor";
export const REVIEW_SETTINGS_TYPE = "review-settings";

// Loop fixing constants
export const REVIEW_LOOP_MAX_ITERATIONS = 10;
export const REVIEW_LOOP_START_TIMEOUT_MS = 15000;
export const REVIEW_LOOP_START_POLL_MS = 50;

export type ReviewSessionState = {
    active: boolean;
    originId?: string;
};

export type ReviewSettingsState = {
    loopFixingEnabled?: boolean;
};

export type ReviewTarget =
    | { type: "uncommitted" }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title?: string }
    | { type: "custom"; instructions: string }
    | { type: "pullRequest"; prNumber: number; baseBranch: string; title: string }
    | {
        type: "mergeRequest";
        mrNumber: number;
        baseBranch: string;
        title: string;
    }
    | { type: "folder"; paths: string[] };

export type AssistantSnapshot = {
    id: string;
    text: string;
    stopReason?: string;
};

export type EndReviewAction =
    | "returnOnly"
    | "returnAndFix"
    | "returnAndSummarize";
export type EndReviewActionResult = "ok" | "cancelled" | "error";
export type EndReviewActionOptions = {
    showSummaryLoader?: boolean;
    notifySuccess?: boolean;
};

// Review preset options for the selector (keep this order stable)
export const REVIEW_PRESETS = [
    {
        value: "uncommitted",
        label: "Review uncommitted changes",
        description: "",
    },
    {
        value: "baseBranch",
        label: "Review against a base branch",
        description: "(local)",
    },
    { value: "commit", label: "Review a commit", description: "" },
    {
        value: "pullRequest",
        label: "Review a pull request",
        description: "(GitHub PR)",
    },
    {
        value: "mergeRequest",
        label: "Review a merge request",
        description: "(GitLab MR)",
    },
    {
        value: "folder",
        label: "Review a folder (or more)",
        description: "(snapshot, not diff)",
    },
    { value: "custom", label: "Custom review instructions", description: "" },
] as const;

export const TOGGLE_LOOP_FIXING_VALUE = "toggleLoopFixing" as const;

export type ReviewPresetValue =
    | (typeof REVIEW_PRESETS)[number]["value"]
    | typeof TOGGLE_LOOP_FIXING_VALUE;
