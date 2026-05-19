/**
 * State machine for goal status transitions.
 *
 * The model has minimal authority: it can only mark goals complete (from
 * Active or BudgetLimited). The system can pause goals (for abort, error,
 * empty progress, stale detection) and budget-limit them. The user can do
 * anything reasonable.
 */

import type { GoalStatus } from "./types.js";

export type TransitionActor = "model" | "system" | "user";

interface TransitionRule {
    from: GoalStatus;
    to: GoalStatus;
    actors: ReadonlySet<TransitionActor>;
}

const RULES: readonly TransitionRule[] = [
    // Active -> Paused: user pause/Ctrl+C, or system on abort/error/empty/stale.
    {
        from: "active",
        to: "paused",
        actors: new Set<TransitionActor>(["user", "system"]),
    },
    // Active -> BudgetLimited: only the system, when tokens or turn cap hit.
    {
        from: "active",
        to: "budget_limited",
        actors: new Set<TransitionActor>(["system"]),
    },
    // Active -> Complete: model finishes the work, or user override.
    {
        from: "active",
        to: "complete",
        actors: new Set<TransitionActor>(["model", "user"]),
    },
    // Paused -> Active: user resumes.
    {
        from: "paused",
        to: "active",
        actors: new Set<TransitionActor>(["user"]),
    },
    // Paused -> Complete: user override only. Model cannot complete a paused goal.
    {
        from: "paused",
        to: "complete",
        actors: new Set<TransitionActor>(["user"]),
    },
    // BudgetLimited -> Active: user resumes (typically after raising budget).
    {
        from: "budget_limited",
        to: "active",
        actors: new Set<TransitionActor>(["user"]),
    },
    // BudgetLimited -> Complete: model wraps up cleanly, or user override.
    {
        from: "budget_limited",
        to: "complete",
        actors: new Set<TransitionActor>(["model", "user"]),
    },
    // BudgetLimited -> Paused: user wants to manually intervene before resuming.
    {
        from: "budget_limited",
        to: "paused",
        actors: new Set<TransitionActor>(["user"]),
    },
];

/** Returns true when this transition is allowed for the given actor. */
export function canTransition(
    from: GoalStatus,
    to: GoalStatus,
    actor: TransitionActor,
): boolean {
    if (from === to) return false;
    for (const rule of RULES) {
        if (rule.from === from && rule.to === to && rule.actors.has(actor)) {
            return true;
        }
    }
    return false;
}

export interface ModelTransitionResult {
    valid: boolean;
    error?: string;
}

/**
 * Validate a model-initiated status transition. Used to check tool calls
 * before mutating the database.
 */
export function validateModelTransition(
    from: GoalStatus,
    to: GoalStatus,
): ModelTransitionResult {
    if (from === to) {
        return { valid: false, error: `Goal is already ${from}.` };
    }
    if (canTransition(from, to, "model")) {
        return { valid: true };
    }
    return {
        valid: false,
        error: `Model cannot transition goal from ${from} to ${to}.`,
    };
}
