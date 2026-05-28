/**
 * In-memory goal store backed by session entries.
 *
 * State lives in a closure variable; mutations append a snapshot via
 * `pi.appendEntry(GOAL_ENTRY_TYPE, ...)` so the goal travels with the
 * session branch. On `session_start` / `session_tree`, `reconstruct` walks
 * the current branch and rehydrates from the latest matching entry.
 *
 * Mutations split into two groups:
 *  - Status / objective / budget mutations and createGoal/deleteGoal
 *    persist immediately (they are user- or model-visible state changes).
 *  - Token/time accounting and iteration increments only mutate memory; the
 *    caller batches them and calls `persist()` once when ready (matching
 *    the agent_end flow's persist points).
 *
 * Lifecycle: `pi.appendEntry` is gated by an injected `isSessionActive`
 * predicate (per AGENTS.md, lifecycle flags express intent rather than
 * try/catch hiding stale-`pi` access). When the session is inactive, the
 * in-memory snapshot is still updated; persistence is skipped.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { GOAL_ENTRY_TYPE, type GoalStatus, type SessionGoal } from "./types.js";

/** Persisted entry shape: either a goal snapshot or a cleared sentinel. */
export type GoalEntryData =
    | { kind: "snapshot"; goal: SessionGoal }
    | { kind: "cleared" };

export interface GoalStore {
    getGoal(): SessionGoal | null;
    createGoal(
        objective: string,
        tokenBudget: number | null,
        force?: boolean,
    ): SessionGoal | null;
    updateStatus(status: GoalStatus): SessionGoal | null;
    updateObjective(objective: string): SessionGoal | null;
    updateBudget(budget: number): SessionGoal | null;
    /** Accumulate token/time in memory. Call persist() afterward when ready. */
    accountTokens(tokenDelta: number, timeDelta: number): void;
    /** Increment iteration counter in memory. Call persist() afterward when ready. */
    incrementIters(): void;
    /** Persist current in-memory snapshot to session entry. */
    persist(): void;
    deleteGoal(): void;
    /** Reconstruct in-memory state from session branch entries. */
    reconstruct(ctx: ExtensionContext): void;
}

export interface GoalStoreOptions {
    /**
     * Returns true while the session is alive. Persistence is skipped
     * when this returns false (cooperative bail-out per AGENTS.md).
     * Defaults to always-active (suitable for tests).
     */
    isSessionActive?: () => boolean;
    /** Clock injection for deterministic tests. Defaults to wall clock. */
    now?: () => number;
}

function defaultNow(): number {
    return Math.floor(Date.now() / 1000);
}

export function createGoalStore(
    pi: ExtensionAPI,
    options: GoalStoreOptions = {},
): GoalStore {
    const isSessionActive = options.isSessionActive ?? (() => true);
    const now = options.now ?? defaultNow;
    let goal: SessionGoal | null = null;

    function persistSnapshot(): void {
        if (!goal) return;
        if (!isSessionActive()) return;
        pi.appendEntry(GOAL_ENTRY_TYPE, {
            kind: "snapshot",
            goal,
        } satisfies GoalEntryData);
    }

    return {
        getGoal(): SessionGoal | null {
            return goal;
        },

        createGoal(
            objective: string,
            tokenBudget: number | null,
            force?: boolean,
        ): SessionGoal | null {
            if (goal && !force) return null;
            const ts = now();
            goal = {
                objective,
                status: "active",
                token_budget: tokenBudget ?? null,
                tokens_used: 0,
                time_used_seconds: 0,
                iters_used: 0,
                created_at: ts,
                updated_at: ts,
            };
            persistSnapshot();
            return goal;
        },

        updateStatus(status: GoalStatus): SessionGoal | null {
            if (!goal) return null;
            goal = { ...goal, status, updated_at: now() };
            persistSnapshot();
            return goal;
        },

        updateObjective(objective: string): SessionGoal | null {
            if (!goal) return null;
            goal = { ...goal, objective, updated_at: now() };
            persistSnapshot();
            return goal;
        },

        updateBudget(budget: number): SessionGoal | null {
            if (!goal) return null;
            goal = { ...goal, token_budget: budget, updated_at: now() };
            persistSnapshot();
            return goal;
        },

        accountTokens(tokenDelta: number, timeDelta: number): void {
            if (!goal) return;
            goal = {
                ...goal,
                tokens_used: goal.tokens_used + tokenDelta,
                time_used_seconds: goal.time_used_seconds + timeDelta,
            };
        },

        incrementIters(): void {
            if (!goal) return;
            goal = { ...goal, iters_used: goal.iters_used + 1 };
        },

        persist(): void {
            if (!goal) return;
            goal = { ...goal, updated_at: now() };
            persistSnapshot();
        },

        deleteGoal(): void {
            if (!goal) return;
            goal = null;
            if (!isSessionActive()) return;
            pi.appendEntry(GOAL_ENTRY_TYPE, {
                kind: "cleared",
            } satisfies GoalEntryData);
        },

        /**
         * Scan the branch in reverse for the most recent goal entry and
         * hydrate in-memory state. The latest matching entry wins, so
         * reverse iteration lets us short-circuit on the first hit.
         */
        reconstruct(ctx: ExtensionContext): void {
            const branch = ctx.sessionManager.getBranch();
            for (let i = branch.length - 1; i >= 0; i--) {
                const entry = branch[i];
                if (
                    entry.type === "custom" &&
                    entry.customType === GOAL_ENTRY_TYPE
                ) {
                    const data = entry.data as GoalEntryData;
                    if (data.kind === "cleared") {
                        goal = null;
                    } else {
                        const raw = data.goal as SessionGoal & {
                            turns_used?: number;
                        };
                        goal = {
                            ...raw,
                            iters_used: raw.iters_used ?? raw.turns_used ?? 0,
                        };
                    }
                    return;
                }
            }
            goal = null;
        },
    };
}
