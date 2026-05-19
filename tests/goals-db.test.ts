/**
 * Unit tests for the goals SQLite layer.
 *
 * Each test gets a fresh in-memory database. The DB does not require any
 * filesystem state; we use `:memory:` to keep tests hermetic.
 */

import { describe, expect, it } from "vitest";
import { GoalDatabase } from "../extensions/goals/db.js";

const SESSION = "session-aaa";

function freshDb(): GoalDatabase {
    return new GoalDatabase(":memory:");
}

describe("GoalDatabase", () => {
    it("test_create_goal: inserts a goal with correct structure", () => {
        const db = freshDb();
        const goal = db.createGoal(SESSION, "Refactor auth", 1000);
        expect(goal).not.toBeNull();
        expect(goal!.session_id).toBe(SESSION);
        expect(goal!.objective).toBe("Refactor auth");
        expect(goal!.status).toBe("active");
        expect(goal!.token_budget).toBe(1000);
        expect(goal!.tokens_used).toBe(0);
        expect(goal!.time_used_seconds).toBe(0);
        expect(goal!.turns_used).toBe(0);
        expect(typeof goal!.goal_id).toBe("string");
        expect(goal!.goal_id.length).toBeGreaterThan(0);
        expect(typeof goal!.created_at).toBe("number");
        expect(typeof goal!.updated_at).toBe("number");
    });

    it("test_create_goal_no_force_fails_if_exists: returns null for model tool path", () => {
        const db = freshDb();
        const first = db.createGoal(SESSION, "First objective", null);
        expect(first).not.toBeNull();
        const second = db.createGoal(SESSION, "Second objective", null);
        expect(second).toBeNull();
        // First goal still intact.
        const persisted = db.getGoal(SESSION);
        expect(persisted!.objective).toBe("First objective");
        expect(persisted!.goal_id).toBe(first!.goal_id);
    });

    it("test_create_goal_force_replaces_existing: force=true replaces with new goal_id", () => {
        const db = freshDb();
        const first = db.createGoal(SESSION, "First objective", 500);
        // Mutate counters so we can verify reset.
        db.accountTokens(SESSION, 100, 30);
        db.incrementTurns(SESSION);

        const replaced = db.createGoal(SESSION, "Second objective", 2000, true);
        expect(replaced).not.toBeNull();
        expect(replaced!.objective).toBe("Second objective");
        expect(replaced!.goal_id).not.toBe(first!.goal_id);
        expect(replaced!.token_budget).toBe(2000);
        expect(replaced!.tokens_used).toBe(0);
        expect(replaced!.time_used_seconds).toBe(0);
        expect(replaced!.turns_used).toBe(0);
        expect(replaced!.status).toBe("active");
    });

    it("test_get_goal_empty: returns null for unseen session", () => {
        const db = freshDb();
        expect(db.getGoal("unknown-session")).toBeNull();
    });

    it("test_account_tokens: increments tokens_used and time_used_seconds", () => {
        const db = freshDb();
        db.createGoal(SESSION, "Track usage", null);
        const after = db.accountTokens(SESSION, 250, 12);
        expect(after).not.toBeNull();
        expect(after!.tokens_used).toBe(250);
        expect(after!.time_used_seconds).toBe(12);
        const after2 = db.accountTokens(SESSION, 100, 5);
        expect(after2!.tokens_used).toBe(350);
        expect(after2!.time_used_seconds).toBe(17);
    });

    it("test_account_tokens_no_goal: returns null", () => {
        const db = freshDb();
        const result = db.accountTokens(SESSION, 100, 10);
        expect(result).toBeNull();
    });

    it("test_increment_turns: increments turns_used", () => {
        const db = freshDb();
        db.createGoal(SESSION, "obj", null);
        db.incrementTurns(SESSION);
        db.incrementTurns(SESSION);
        const after = db.incrementTurns(SESSION);
        expect(after!.turns_used).toBe(3);
    });

    it("test_update_status_optimistic_lock: fails when expectedGoalId mismatches", () => {
        const db = freshDb();
        const goal = db.createGoal(SESSION, "obj", null);
        const stale = db.updateStatus(SESSION, "wrong-goal-id", "complete");
        expect(stale).toBeNull();
        // Status unchanged.
        const persisted = db.getGoal(SESSION);
        expect(persisted!.status).toBe("active");
        // Lock with correct goal_id succeeds.
        const ok = db.updateStatus(SESSION, goal!.goal_id, "complete");
        expect(ok!.status).toBe("complete");
    });

    it("test_update_status_no_lock: null expectedGoalId always applies", () => {
        const db = freshDb();
        db.createGoal(SESSION, "obj", null);
        const updated = db.updateStatus(SESSION, null, "paused");
        expect(updated!.status).toBe("paused");
    });

    it("test_delete_goal: removes goal and subsequent get returns null", () => {
        const db = freshDb();
        db.createGoal(SESSION, "obj", null);
        expect(db.deleteGoal(SESSION)).toBe(true);
        expect(db.getGoal(SESSION)).toBeNull();
        // Second delete returns false.
        expect(db.deleteGoal(SESSION)).toBe(false);
    });

    it("test_update_objective: changes objective and updates updated_at", async () => {
        const db = freshDb();
        const goal = db.createGoal(SESSION, "old", null);
        // Force updated_at to an older value, verify update_objective bumps it forward.
        db._setUpdatedAt(SESSION, goal!.updated_at - 100);
        const stale = db.getGoal(SESSION)!;
        const after = db.updateObjective(SESSION, null, "new");
        expect(after!.objective).toBe("new");
        expect(after!.updated_at).toBeGreaterThanOrEqual(stale.updated_at);
    });

    it("test_update_objective_lock: rejects mismatched goal_id", () => {
        const db = freshDb();
        db.createGoal(SESSION, "old", null);
        const result = db.updateObjective(SESSION, "wrong-id", "new");
        expect(result).toBeNull();
        expect(db.getGoal(SESSION)!.objective).toBe("old");
    });

    it("test_update_budget: changes token_budget", () => {
        const db = freshDb();
        db.createGoal(SESSION, "obj", null);
        const after = db.updateBudget(SESSION, null, 5000);
        expect(after!.token_budget).toBe(5000);
        // Reduce.
        const after2 = db.updateBudget(SESSION, null, 1000);
        expect(after2!.token_budget).toBe(1000);
    });

    it("test_persistence_across_instances: a file-backed DB survives reopen", async () => {
        const { mkdtemp, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = await mkdtemp(join(tmpdir(), "goals-db-"));
        try {
            const dbPath = join(dir, "goals.db");
            const a = new GoalDatabase(dbPath);
            const goal = a.createGoal(SESSION, "persist me", 100);
            a.close();
            const b = new GoalDatabase(dbPath);
            const reread = b.getGoal(SESSION);
            expect(reread!.goal_id).toBe(goal!.goal_id);
            expect(reread!.objective).toBe("persist me");
            b.close();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("test_create_goal_rejects_invalid_budget: negative budget is rejected by CHECK constraint", () => {
        const db = freshDb();
        // The CHECK constraint requires token_budget IS NULL OR > 0.
        expect(() => db.createGoal(SESSION, "obj", -5)).toThrow();
    });
});
