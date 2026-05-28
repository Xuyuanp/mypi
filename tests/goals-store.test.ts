/**
 * Unit tests for the goal store and the empty-progress helper.
 *
 * The store is wired to `SessionManager.inMemory()` via a stub `pi`
 * exposing only `appendEntry`. `reconstruct` reads through a stub
 * `ExtensionContext` exposing only `sessionManager`. Those are the only
 * surfaces the store touches, so the casts are safe.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { nextEmptyProgressCount } from "../extensions/goals/index.js";
import {
    createGoalStore,
    type GoalEntryData,
    type GoalStore,
    type GoalStoreOptions,
} from "../extensions/goals/store.js";
import { GOAL_ENTRY_TYPE, type SessionGoal } from "../extensions/goals/types.js";

interface TestRig {
    store: GoalStore;
    sm: SessionManager;
}

function makeStubPi(sm: SessionManager): ExtensionAPI {
    return {
        appendEntry: (customType: string, data: unknown) => {
            sm.appendCustomEntry(customType, data);
        },
    } as unknown as ExtensionAPI;
}

function makeTestRig(
    sessionId = "test-session",
    options: GoalStoreOptions = {},
): TestRig {
    const sm = SessionManager.inMemory();
    sm.newSession({ id: sessionId });
    return { store: createGoalStore(makeStubPi(sm), options), sm };
}

function ctxOf(sm: SessionManager): ExtensionContext {
    return { sessionManager: sm } as unknown as ExtensionContext;
}

function countGoalEntries(sm: SessionManager): number {
    let n = 0;
    for (const entry of sm.getBranch()) {
        if (entry.type === "custom" && entry.customType === GOAL_ENTRY_TYPE) {
            n++;
        }
    }
    return n;
}

describe("GoalStore", () => {
    it("test_store_create_and_get: createGoal returns and getGoal exposes it", () => {
        const { store } = makeTestRig();
        const created = store.createGoal("obj", null);
        expect(created).not.toBeNull();
        expect(created!.objective).toBe("obj");
        expect(created!.status).toBe("active");
        expect(store.getGoal()).toEqual(created);
    });

    it("test_store_create_no_force_rejects_duplicate: second create returns null", () => {
        const { store } = makeTestRig();
        store.createGoal("first", null);
        const second = store.createGoal("second", null);
        expect(second).toBeNull();
        expect(store.getGoal()!.objective).toBe("first");
    });

    it("test_store_create_force_replaces: force=true overwrites with reset counters", () => {
        const { store } = makeTestRig();
        store.createGoal("first", 100);
        // Forcibly mutate counters via accountTokens so we can verify reset.
        store.accountTokens(50, 5);
        store.persist();

        const replaced = store.createGoal("second", 200, true);
        expect(replaced).not.toBeNull();
        expect(replaced!.objective).toBe("second");
        expect(replaced!.token_budget).toBe(200);
        expect(replaced!.tokens_used).toBe(0);
        expect(replaced!.iters_used).toBe(0);
    });

    it("test_store_update_status_succeeds: updateStatus mutates and returns the goal", () => {
        const { store } = makeTestRig();
        store.createGoal("obj", null);
        const result = store.updateStatus("paused");
        expect(result).not.toBeNull();
        expect(result!.status).toBe("paused");
        expect(store.getGoal()!.status).toBe("paused");
    });

    it("test_store_account_tokens_no_persist: accumulates in memory but no entry written", () => {
        const { store, sm } = makeTestRig();
        store.createGoal("obj", null);
        const entriesAfterCreate = countGoalEntries(sm);
        store.accountTokens(123, 4);
        store.incrementIters();

        // In-memory mutation visible immediately.
        const goal = store.getGoal();
        expect(goal!.tokens_used).toBe(123);
        expect(goal!.time_used_seconds).toBe(4);
        expect(goal!.iters_used).toBe(1);

        // No new entry appended.
        expect(countGoalEntries(sm)).toBe(entriesAfterCreate);
    });

    it("test_store_persist_writes_entry: persist() appends a new snapshot with bumped updated_at", () => {
        // Drive the clock manually via the injected `now` so we don't
        // need to wait on wall-clock seconds to tick.
        let clock = 1_000_000;
        const { store, sm } = makeTestRig("test-session", {
            now: () => clock,
        });
        store.createGoal("obj", null);
        const before = countGoalEntries(sm);
        const beforeUpdated = store.getGoal()!.updated_at;

        store.accountTokens(10, 0);
        clock += 1;
        store.persist();

        expect(countGoalEntries(sm)).toBe(before + 1);
        expect(store.getGoal()!.updated_at).toBe(beforeUpdated + 1);
    });

    it("test_store_skips_persist_when_session_inactive: appendEntry is gated", () => {
        let active = true;
        const sm = SessionManager.inMemory();
        sm.newSession({ id: "inactive-test" });
        const store = createGoalStore(makeStubPi(sm), {
            isSessionActive: () => active,
        });
        store.createGoal("obj", null);
        const baseline = countGoalEntries(sm);

        active = false;
        store.updateStatus("paused");
        // In-memory state still mutated even when persistence is gated.
        expect(store.getGoal()!.status).toBe("paused");
        // No new entry appended while inactive.
        expect(countGoalEntries(sm)).toBe(baseline);
    });

    it("test_store_reconstruct_finds_latest: scans branch and loads last entry", () => {
        const { store, sm } = makeTestRig();
        store.createGoal("first", null);
        store.updateStatus("paused");
        store.updateObjective("second");

        // Spin up a fresh store and reconstruct from the same SM.
        const store2 = createGoalStore(makeStubPi(sm));
        store2.reconstruct(ctxOf(sm));

        const goal = store2.getGoal();
        expect(goal).not.toBeNull();
        expect(goal!.objective).toBe("second");
        expect(goal!.status).toBe("paused");
    });

    it("test_store_reconstruct_cleared: deleteGoal sentinel clears state on rebuild", () => {
        const { store, sm } = makeTestRig();
        store.createGoal("obj", null);
        store.deleteGoal();

        const store2 = createGoalStore(makeStubPi(sm));
        store2.reconstruct(ctxOf(sm));

        expect(store2.getGoal()).toBeNull();
    });

    it("test_store_reconstruct_branch_aware: reconstruct rehydrates from branch contents", () => {
        // Build a branch with a sequence: create, mutate, append a custom
        // entry of an unrelated type, then ensure reconstruct ignores the
        // unrelated entry and picks the last goal entry.
        const { store, sm } = makeTestRig();
        store.createGoal("obj", null);
        store.updateStatus("paused");
        sm.appendCustomEntry("some-other-type", { hello: "world" });

        const store2 = createGoalStore(makeStubPi(sm));
        store2.reconstruct(ctxOf(sm));

        expect(store2.getGoal()!.status).toBe("paused");
    });

    it("test_store_reconstruct_migrates_turns_used: old persisted turns_used is migrated to iters_used", () => {
        // Simulate a persisted entry from before the rename: the goal
        // has `turns_used` but no `iters_used` field.
        const sm = SessionManager.inMemory();
        sm.newSession({ id: "migration-test" });
        const oldGoal = {
            objective: "legacy goal",
            status: "active",
            token_budget: null,
            tokens_used: 500,
            time_used_seconds: 30,
            turns_used: 7, // old field name
            created_at: 1_000_000,
            updated_at: 1_000_001,
        };
        sm.appendCustomEntry(GOAL_ENTRY_TYPE, {
            kind: "snapshot",
            goal: oldGoal,
        });

        const store = createGoalStore(makeStubPi(sm));
        store.reconstruct(ctxOf(sm));

        const goal = store.getGoal();
        expect(goal).not.toBeNull();
        expect(goal!.iters_used).toBe(7);
        // Ensure incrementIters works correctly after migration.
        store.incrementIters();
        expect(store.getGoal()!.iters_used).toBe(8);
    });

    it("test_store_reconstruct_after_clear_then_create: latest goal entry wins over earlier sentinel", () => {
        const { store, sm } = makeTestRig();
        store.createGoal("first", null);
        store.deleteGoal();
        store.createGoal("second", null);

        const store2 = createGoalStore(makeStubPi(sm));
        store2.reconstruct(ctxOf(sm));

        const goal = store2.getGoal();
        expect(goal).not.toBeNull();
        expect(goal!.objective).toBe("second");
    });

    it("test_store_persisted_data_shape: entry data round-trips as GoalEntryData", () => {
        const { store, sm } = makeTestRig();
        store.createGoal("obj", 1000);

        const entries = sm.getBranch().filter(
            (e) => e.type === "custom" && e.customType === GOAL_ENTRY_TYPE,
        );
        expect(entries.length).toBe(1);
        const data = (entries[0] as { data: GoalEntryData }).data;
        expect(data.kind).toBe("snapshot");
        if (data.kind !== "snapshot") throw new Error("expected snapshot");
        expect(data.goal.objective).toBe("obj");
        expect(data.goal.token_budget).toBe(1000);
    });
});

describe("nextEmptyProgressCount", () => {
    it("test_empty_progress_user_intervention_resets: user run resets even with no tools", () => {
        expect(nextEmptyProgressCount(3, false, false)).toBe(0);
    });

    it("test_empty_progress_user_run_with_tools_also_resets", () => {
        expect(nextEmptyProgressCount(3, false, true)).toBe(0);
    });

    it("test_empty_progress_autonomous_no_tools_increments", () => {
        expect(nextEmptyProgressCount(2, true, false)).toBe(3);
    });

    it("test_empty_progress_autonomous_with_tools_resets: tool calls = progress", () => {
        expect(nextEmptyProgressCount(2, true, true)).toBe(0);
    });

    it("test_empty_progress_starts_from_zero_autonomous", () => {
        expect(nextEmptyProgressCount(0, true, false)).toBe(1);
    });
});
