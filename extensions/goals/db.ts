/**
 * SQLite persistence for session goals.
 *
 * One goal per session (session_id is the primary key). All mutations refresh
 * `updated_at`. Status mutations carry an optimistic `expectedGoalId` lock so
 * a goal that was replaced between a model's read and write fails the write
 * gracefully.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GoalStatus, SessionGoal } from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_goals (
    session_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'budget_limited', 'complete')),
    token_budget INTEGER CHECK(token_budget IS NULL OR token_budget > 0),
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    turns_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
`;

interface GoalRow {
    session_id: string;
    goal_id: string;
    objective: string;
    status: string;
    token_budget: number | null;
    tokens_used: number;
    time_used_seconds: number;
    turns_used: number;
    created_at: number;
    updated_at: number;
}

function rowToGoal(row: GoalRow): SessionGoal {
    return {
        session_id: row.session_id,
        goal_id: row.goal_id,
        objective: row.objective,
        status: row.status as GoalStatus,
        token_budget: row.token_budget,
        tokens_used: row.tokens_used,
        time_used_seconds: row.time_used_seconds,
        turns_used: row.turns_used,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

export class GoalDatabase {
    private db: DatabaseSync;

    constructor(dbPath: string) {
        if (dbPath !== ":memory:") {
            mkdirSync(dirname(dbPath), { recursive: true });
        }
        this.db = new DatabaseSync(dbPath);
        this.db.exec(SCHEMA_SQL);
    }

    close(): void {
        this.db.close();
    }

    getGoal(sessionId: string): SessionGoal | null {
        const stmt = this.db.prepare(
            "SELECT * FROM session_goals WHERE session_id = ?",
        );
        const row = stmt.get(sessionId) as GoalRow | undefined;
        return row ? rowToGoal(row) : null;
    }

    /**
     * Create a goal for the session.
     *
     * - `force=false` (default, used by model tools): returns null if a goal
     *   already exists.
     * - `force=true` (used by /goal create command): replaces any existing
     *   goal with a new goal_id and zeroed counters.
     */
    createGoal(
        sessionId: string,
        objective: string,
        tokenBudget: number | null,
        force = false,
    ): SessionGoal | null {
        const existing = this.getGoal(sessionId);
        if (existing && !force) return null;

        const now = nowSeconds();
        const goalId = randomUUID();

        if (existing) {
            const stmt = this.db.prepare(
                `UPDATE session_goals
                 SET goal_id = ?, objective = ?, status = 'active',
                     token_budget = ?, tokens_used = 0, time_used_seconds = 0,
                     turns_used = 0, created_at = ?, updated_at = ?
                 WHERE session_id = ?`,
            );
            stmt.run(goalId, objective, tokenBudget, now, now, sessionId);
        } else {
            const stmt = this.db.prepare(
                `INSERT INTO session_goals
                 (session_id, goal_id, objective, status, token_budget,
                  tokens_used, time_used_seconds, turns_used, created_at, updated_at)
                 VALUES (?, ?, ?, 'active', ?, 0, 0, 0, ?, ?)`,
            );
            stmt.run(sessionId, goalId, objective, tokenBudget, now, now);
        }

        return this.getGoal(sessionId);
    }

    /**
     * Update status. When `expectedGoalId` is provided, the update fails (returns
     * null) if the stored goal_id has been replaced. Pass null to skip the lock
     * (used by system-level transitions where the caller already holds the goal).
     */
    updateStatus(
        sessionId: string,
        expectedGoalId: string | null,
        status: GoalStatus,
    ): SessionGoal | null {
        const now = nowSeconds();
        let changes: number;
        if (expectedGoalId === null) {
            const stmt = this.db.prepare(
                `UPDATE session_goals SET status = ?, updated_at = ?
                 WHERE session_id = ?`,
            );
            const res = stmt.run(status, now, sessionId);
            changes = Number(res.changes);
        } else {
            const stmt = this.db.prepare(
                `UPDATE session_goals SET status = ?, updated_at = ?
                 WHERE session_id = ? AND goal_id = ?`,
            );
            const res = stmt.run(status, now, sessionId, expectedGoalId);
            changes = Number(res.changes);
        }
        if (changes === 0) return null;
        return this.getGoal(sessionId);
    }

    updateObjective(
        sessionId: string,
        expectedGoalId: string | null,
        objective: string,
    ): SessionGoal | null {
        const now = nowSeconds();
        let changes: number;
        if (expectedGoalId === null) {
            const stmt = this.db.prepare(
                `UPDATE session_goals SET objective = ?, updated_at = ?
                 WHERE session_id = ?`,
            );
            changes = Number(stmt.run(objective, now, sessionId).changes);
        } else {
            const stmt = this.db.prepare(
                `UPDATE session_goals SET objective = ?, updated_at = ?
                 WHERE session_id = ? AND goal_id = ?`,
            );
            changes = Number(
                stmt.run(objective, now, sessionId, expectedGoalId).changes,
            );
        }
        if (changes === 0) return null;
        return this.getGoal(sessionId);
    }

    updateBudget(
        sessionId: string,
        expectedGoalId: string | null,
        budget: number,
    ): SessionGoal | null {
        const now = nowSeconds();
        let changes: number;
        if (expectedGoalId === null) {
            const stmt = this.db.prepare(
                `UPDATE session_goals SET token_budget = ?, updated_at = ?
                 WHERE session_id = ?`,
            );
            changes = Number(stmt.run(budget, now, sessionId).changes);
        } else {
            const stmt = this.db.prepare(
                `UPDATE session_goals SET token_budget = ?, updated_at = ?
                 WHERE session_id = ? AND goal_id = ?`,
            );
            changes = Number(
                stmt.run(budget, now, sessionId, expectedGoalId).changes,
            );
        }
        if (changes === 0) return null;
        return this.getGoal(sessionId);
    }

    /**
     * Add `tokenDelta` and `timeDelta` to the running counters. No optimistic
     * lock: token accounting is system-driven and applies to whichever goal
     * currently owns the session.
     */
    accountTokens(
        sessionId: string,
        tokenDelta: number,
        timeDelta: number,
    ): SessionGoal | null {
        const now = nowSeconds();
        const stmt = this.db.prepare(
            `UPDATE session_goals
             SET tokens_used = tokens_used + ?,
                 time_used_seconds = time_used_seconds + ?,
                 updated_at = ?
             WHERE session_id = ?`,
        );
        const res = stmt.run(tokenDelta, timeDelta, now, sessionId);
        if (Number(res.changes) === 0) return null;
        return this.getGoal(sessionId);
    }

    incrementTurns(sessionId: string): SessionGoal | null {
        const now = nowSeconds();
        const stmt = this.db.prepare(
            `UPDATE session_goals
             SET turns_used = turns_used + 1, updated_at = ?
             WHERE session_id = ?`,
        );
        const res = stmt.run(now, sessionId);
        if (Number(res.changes) === 0) return null;
        return this.getGoal(sessionId);
    }

    deleteGoal(sessionId: string): boolean {
        const stmt = this.db.prepare(
            "DELETE FROM session_goals WHERE session_id = ?",
        );
        const res = stmt.run(sessionId);
        return Number(res.changes) > 0;
    }

    /**
     * Test-only helper: forcibly set updated_at. Used to simulate stale goals
     * without sleeping for hours. Not exposed to extension runtime code.
     */
    _setUpdatedAt(sessionId: string, updatedAt: number): void {
        const stmt = this.db.prepare(
            "UPDATE session_goals SET updated_at = ? WHERE session_id = ?",
        );
        stmt.run(updatedAt, sessionId);
    }
}
