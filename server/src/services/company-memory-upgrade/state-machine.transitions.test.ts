import { describe, expect, it } from "vitest";
import {
  CompanyMemoryUpgradeError,
  assertValidTransition,
  isValidTransition,
  VALID_TRANSITIONS,
} from "./state-machine.js";
import { UPGRADE_STATES, type UpgradeState } from "./types.js";

describe("state-machine transitions", () => {
  it("allows all explicitly documented valid transitions", () => {
    const validPairs: Array<[UpgradeState, UpgradeState]> = [
      // Sweeping
      ["sweeping", "flipping"],
      ["sweeping", "aborted"],
      ["sweeping", "needs_recovery"],

      // Flipping
      ["flipping", "draining"],
      ["flipping", "sweeping"],
      ["flipping", "needs_recovery"],

      // Draining
      ["draining", "verified"],
      ["draining", "rolled_back"],
      ["draining", "needs_recovery"],

      // Verified
      ["verified", "pruning"],
      ["verified", "rolled_back"],
      ["verified", "needs_recovery"],

      // Pruning
      ["pruning", "completed"],
      ["pruning", "needs_recovery"],

      // Needs recovery
      ["needs_recovery", "sweeping"],
      ["needs_recovery", "flipping"],
      ["needs_recovery", "draining"],
      ["needs_recovery", "verified"],
      ["needs_recovery", "pruning"],
    ];

    for (const [from, to] of validPairs) {
      expect(isValidTransition(from, to), `Transition from ${from} to ${to} should be valid`).toBe(true);
      expect(() => assertValidTransition(from, to)).not.toThrow();
    }
  });

  it("strictly refuses rollback at/after pruning with code ROLLBACK_REFUSED", () => {
    // At pruning
    expect(isValidTransition("pruning", "rolled_back")).toBe(false);
    expect(() => assertValidTransition("pruning", "rolled_back")).toThrowError(
      expect.objectContaining({
        name: "CompanyMemoryUpgradeError",
        code: "ROLLBACK_REFUSED",
      }),
    );

    // After pruning (completed)
    expect(isValidTransition("completed", "rolled_back")).toBe(false);
    expect(() => assertValidTransition("completed", "rolled_back")).toThrowError(
      expect.objectContaining({
        name: "CompanyMemoryUpgradeError",
        code: "ROLLBACK_REFUSED",
      }),
    );
  });

  it("disallows illegal rollback before draining with code ILLEGAL_TRANSITION", () => {
    expect(isValidTransition("sweeping", "rolled_back")).toBe(false);
    expect(() => assertValidTransition("sweeping", "rolled_back")).toThrowError(
      expect.objectContaining({
        name: "CompanyMemoryUpgradeError",
        code: "ILLEGAL_TRANSITION",
      }),
    );

    expect(isValidTransition("flipping", "rolled_back")).toBe(false);
    expect(() => assertValidTransition("flipping", "rolled_back")).toThrowError(
      expect.objectContaining({
        name: "CompanyMemoryUpgradeError",
        code: "ILLEGAL_TRANSITION",
      }),
    );
  });

  it("prohibits any transitions out of terminal states", () => {
    const terminalStates: UpgradeState[] = ["completed", "rolled_back", "aborted"];

    for (const terminal of terminalStates) {
      for (const target of UPGRADE_STATES) {
        expect(
          isValidTransition(terminal, target),
          `Terminal state ${terminal} must not transition to ${target}`,
        ).toBe(false);

        expect(() => assertValidTransition(terminal, target)).toThrowError(
          CompanyMemoryUpgradeError,
        );
      }
    }
  });

  it("enforces recovery to the recorded prior state", () => {
    const priorState: UpgradeState = "draining";

    // Matching prior state succeeds
    expect(isValidTransition("needs_recovery", "draining", priorState)).toBe(true);
    expect(() => assertValidTransition("needs_recovery", "draining", priorState)).not.toThrow();

    // Mismatched state fails
    expect(isValidTransition("needs_recovery", "sweeping", priorState)).toBe(false);
    expect(() => assertValidTransition("needs_recovery", "sweeping", priorState)).toThrowError(
      expect.objectContaining({
        code: "ILLEGAL_TRANSITION",
      }),
    );
  });

  it("exhaustively tests all state pairs against the transition table", () => {
    for (const from of UPGRADE_STATES) {
      for (const to of UPGRADE_STATES) {
        const allowed = VALID_TRANSITIONS[from]?.has(to) ?? false;
        if (to === "rolled_back" && (from === "pruning" || from === "completed")) {
          expect(isValidTransition(from, to)).toBe(false);
          expect(() => assertValidTransition(from, to)).toThrowError(
            expect.objectContaining({ code: "ROLLBACK_REFUSED" }),
          );
        } else if (allowed) {
          expect(isValidTransition(from, to)).toBe(true);
          expect(() => assertValidTransition(from, to)).not.toThrow();
        } else {
          expect(isValidTransition(from, to)).toBe(false);
          expect(() => assertValidTransition(from, to)).toThrowError(
            expect.objectContaining({ code: "ILLEGAL_TRANSITION" }),
          );
        }
      }
    }
  });
});
