/**
 * Shared types and constants for the goals extension.
 */

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

export interface SessionGoal {
    objective: string;
    status: GoalStatus;
    token_budget: number | null;
    tokens_used: number;
    time_used_seconds: number;
    iters_used: number;
    created_at: number;
    updated_at: number;
}

/** Hard cap on consecutive autonomous continuation runs without user input. */
export const MAX_AUTONOMOUS_ITERS = 100;

/**
 * Number of consecutive autonomous continuation runs producing no tool calls
 * before the goal is auto-paused.
 */
export const EMPTY_PROGRESS_LIMIT = 3;

/**
 * Active goals not updated within this many seconds are considered stale on
 * startup and auto-paused.
 */
export const STALE_GOAL_SECONDS = 86400;

/** Status key used for the footer status indicator. */
export const STATUS_KEY = "goal";

/** Custom entry type for persisted goal state snapshots. */
export const GOAL_ENTRY_TYPE = "session-goal";

/** Custom message type for hidden goal continuation prompts. */
export const CONTINUATION_MESSAGE_TYPE = "goal-continuation";

/** Custom message type for budget-limit steering prompts. */
export const BUDGET_LIMIT_MESSAGE_TYPE = "goal-budget-limit";

/** Custom message type for objective-updated steering prompts. */
export const OBJECTIVE_UPDATED_MESSAGE_TYPE = "goal-objective-updated";

/** EventBus channel names. */
export const EVT_GOAL_CREATED = "goal.created";
export const EVT_GOAL_UPDATED = "goal.updated";
export const EVT_GOAL_CLEARED = "goal.cleared";
export const EVT_GOAL_CONTINUATION = "goal.continuation";
