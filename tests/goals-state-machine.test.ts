/**
 * Unit tests for goal status transitions.
 *
 * The state machine encodes the spec authority matrix: model can only complete
 * (from Active or BudgetLimited); user can do most things; system handles
 * abort/error/empty-progress/stale by pausing and the budget-limited transition.
 */

import { describe, expect, it } from "vitest";
import {
    canTransition,
    validateModelTransition,
} from "../extensions/goals/state-machine.js";

describe("goal state machine", () => {
    it("test_active_to_paused_by_user: allowed", () => {
        expect(canTransition("active", "paused", "user")).toBe(true);
    });

    it("test_active_to_paused_by_system: allowed (abort/error/empty/stale)", () => {
        expect(canTransition("active", "paused", "system")).toBe(true);
    });

    it("test_active_to_complete_by_model: allowed", () => {
        expect(canTransition("active", "complete", "model")).toBe(true);
    });

    it("test_active_to_complete_by_user: allowed (manual override)", () => {
        expect(canTransition("active", "complete", "user")).toBe(true);
    });

    it("test_active_to_budget_limited_by_system: allowed", () => {
        expect(canTransition("active", "budget_limited", "system")).toBe(true);
    });

    it("test_active_to_budget_limited_by_model: rejected", () => {
        expect(canTransition("active", "budget_limited", "model")).toBe(false);
    });

    it("test_paused_to_active_by_user: allowed", () => {
        expect(canTransition("paused", "active", "user")).toBe(true);
    });

    it("test_paused_to_active_by_model: rejected", () => {
        expect(canTransition("paused", "active", "model")).toBe(false);
    });

    it("test_model_cannot_pause: rejected from Active", () => {
        expect(canTransition("active", "paused", "model")).toBe(false);
    });

    it("test_model_cannot_resume: rejected from Paused", () => {
        expect(canTransition("paused", "active", "model")).toBe(false);
    });

    it("test_system_cannot_complete: rejected", () => {
        expect(canTransition("active", "complete", "system")).toBe(false);
        expect(canTransition("budget_limited", "complete", "system")).toBe(false);
    });

    it("test_budget_limited_to_complete_by_model: allowed (wrap-up)", () => {
        expect(canTransition("budget_limited", "complete", "model")).toBe(true);
    });

    it("test_budget_limited_to_active_by_user: allowed (resume after raise)", () => {
        expect(canTransition("budget_limited", "active", "user")).toBe(true);
    });

    it("test_budget_limited_to_paused_by_user: allowed", () => {
        expect(canTransition("budget_limited", "paused", "user")).toBe(true);
    });

    it("test_complete_is_terminal: no transitions out of Complete", () => {
        for (const actor of ["model", "system", "user"] as const) {
            for (const to of ["active", "paused", "budget_limited"] as const) {
                expect(canTransition("complete", to, actor)).toBe(false);
            }
            expect(canTransition("complete", "complete", actor)).toBe(false);
        }
    });

    it("test_paused_to_complete_by_model: rejected (model cannot complete a paused goal)", () => {
        expect(canTransition("paused", "complete", "model")).toBe(false);
    });

    it("test_paused_to_complete_by_user: allowed (manual override)", () => {
        expect(canTransition("paused", "complete", "user")).toBe(true);
    });

    it("test_same_state_transition_rejected: from===to is never valid", () => {
        for (const actor of ["model", "system", "user"] as const) {
            expect(canTransition("active", "active", actor)).toBe(false);
            expect(canTransition("paused", "paused", actor)).toBe(false);
            expect(canTransition("budget_limited", "budget_limited", actor)).toBe(
                false,
            );
        }
    });

    describe("validateModelTransition", () => {
        it("approves Active -> Complete", () => {
            const r = validateModelTransition("active", "complete");
            expect(r.valid).toBe(true);
        });
        it("approves BudgetLimited -> Complete", () => {
            const r = validateModelTransition("budget_limited", "complete");
            expect(r.valid).toBe(true);
        });
        it("rejects Paused -> Complete with explanatory error", () => {
            const r = validateModelTransition("paused", "complete");
            expect(r.valid).toBe(false);
            expect(r.error).toContain("paused");
        });
        it("rejects same-state with 'already' wording", () => {
            const r = validateModelTransition("active", "active");
            expect(r.valid).toBe(false);
            expect(r.error).toMatch(/already/);
        });
    });
});
