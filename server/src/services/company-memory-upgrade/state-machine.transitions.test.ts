import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companyMemoryUpgrades,
  createDb,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  claimUpgradeLease,
  CompanyMemoryUpgradeError,
  assertUpgradeErrorCode,
  assertValidTransition,
  isUpgradeErrorCode,
  isValidTransition,
  openUpgrade,
  releaseUpgradeLease,
  VALID_TRANSITIONS,
} from "./state-machine.js";
import { UPGRADE_STATES, type UpgradeState } from "./types.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describe("state-machine transitions", () => {
  it("allows all explicitly documented valid transitions", () => {
    const validPairs: Array<[UpgradeState, UpgradeState]> = [
      // Sweeping
      ["sweeping", "flipping"],
      ["sweeping", "aborted"],

      // Flipping
      ["flipping", "draining"],
      ["flipping", "sweeping"],

      // Draining
      ["draining", "verified"],
      ["draining", "rolled_back"],

      // Verified
      ["verified", "pruning"],
      ["verified", "rolled_back"],

      // Pruning
      ["pruning", "completed"],
    ];

    for (const [from, to] of validPairs) {
      expect(isValidTransition(from, to), `Transition from ${from} to ${to} should be valid`).toBe(true);
      expect(() => assertValidTransition(from, to)).not.toThrow();
    }
  });

  it("rejects generic transitions into and out of needs_recovery", () => {
    const activeStates: UpgradeState[] = ["sweeping", "flipping", "draining", "verified", "pruning"];

    for (const state of activeStates) {
      // Entry to needs_recovery is reserved for dedicated lapse helpers
      expect(isValidTransition(state, "needs_recovery")).toBe(false);
      expect(() => assertValidTransition(state, "needs_recovery")).toThrowError(
        expect.objectContaining({
          name: "CompanyMemoryUpgradeError",
          code: "ILLEGAL_TRANSITION",
        }),
      );

      // Generic exit from needs_recovery is reserved for recoverUpgrade
      expect(isValidTransition("needs_recovery", state)).toBe(false);
      expect(() => assertValidTransition("needs_recovery", state)).toThrowError(
        expect.objectContaining({
          name: "CompanyMemoryUpgradeError",
          code: "ILLEGAL_TRANSITION",
        }),
      );
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

  it("never echoes from, to, or recoverToState in transition error messages", () => {
    let err1: Error | undefined;
    try {
      assertValidTransition("sweeping", "rolled_back");
    } catch (e: any) {
      err1 = e;
    }
    expect(err1?.message).not.toContain("sweeping");
    expect(err1?.message).not.toContain("rolled_back");

    let err2: Error | undefined;
    try {
      assertValidTransition("pruning", "rolled_back");
    } catch (e: any) {
      err2 = e;
    }
    expect(err2?.message).not.toContain("pruning");
    expect(err2?.message).not.toContain("rolled_back");

    let err3: Error | undefined;
    try {
      assertValidTransition("needs_recovery", "sweeping", "draining");
    } catch (e: any) {
      err3 = e;
    }
    expect(err3?.message).not.toContain("sweeping");
    expect(err3?.message).not.toContain("draining");
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

  describe("isUpgradeErrorCode", () => {
    it("returns true for all valid error codes and false for invalid", () => {
      expect(isUpgradeErrorCode("lease_lapsed")).toBe(true);
      expect(isUpgradeErrorCode("conversion_failed")).toBe(true);
      expect(isUpgradeErrorCode("not_a_code")).toBe(false);
      expect(isUpgradeErrorCode(null)).toBe(false);
      expect(isUpgradeErrorCode(123)).toBe(false);
      expect(isUpgradeErrorCode(undefined)).toBe(false);
    });
  });

  describe("assertUpgradeErrorCode", () => {
    it("never echoes rejected secret-bearing string in error message", () => {
      const dsnSecret = "postgres://u:s3cret@h/db";
      let caught: Error | undefined;
      try {
        assertUpgradeErrorCode(dsnSecret);
      } catch (err: any) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught).toBeInstanceOf(CompanyMemoryUpgradeError);
      expect((caught as CompanyMemoryUpgradeError).code).toBe("INVALID_ARGUMENT");
      expect(caught!.message).not.toContain("s3cret");
      expect(caught!.message).toContain("string");
    });
  });

  describeEmbeddedPostgres("releaseUpgradeLease", () => {
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let db!: Db;
    let companyId: string;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("release-lease-test-");
      db = createDb(tempDb.connectionString);
      const [company] = await db
        .insert(companies)
        .values({ name: "Lease Co", issuePrefix: "LC" })
        .returning();
      companyId = company.id;
    }, 20_000);

    afterAll(async () => {
      await db?.$client?.end();
      await tempDb?.cleanup();
    });

    it("releases an active lease via CAS success", async () => {
      const upgrade = await openUpgrade(db, {
        companyId,
        converterId: "test-converter",
        converterVersion: 1,
        collectionName: "mem0_memories",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
      });

      const claim = await claimUpgradeLease(db, {
        upgradeId: upgrade.id,
        leaseOwner: "owner-1",
        ttlMs: 60_000,
      });
      expect(claim.acquired).toBe(true);

      const releaseResult = await releaseUpgradeLease(db, upgrade.id, claim.leaseToken!);
      expect(releaseResult).toEqual({ released: true });

      const [after] = await db
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      expect(after.leaseToken).toBeNull();
      expect(after.leaseOwner).toBeNull();
      expect(after.leaseAcquiredAt).toBeNull();
      expect(after.leaseExpiresAt).toBeNull();
      expect(after.state).toBe("sweeping");
    });

    it("is a no-op when called with wrong token", async () => {
      const [current] = await db
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.companyId, companyId));

      const claim = await claimUpgradeLease(db, {
        upgradeId: current.id,
        leaseOwner: "owner-2",
        ttlMs: 60_000,
      });
      expect(claim.acquired).toBe(true);

      const releaseResult = await releaseUpgradeLease(db, current.id, "wrong-token-12345");
      expect(releaseResult).toEqual({ released: false });

      const [after] = await db
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, current.id));
      expect(after.leaseToken).toBe(claim.leaseToken);
      expect(after.leaseOwner).toBe("owner-2");
      expect(after.state).toBe("sweeping");
    });
  });
});
