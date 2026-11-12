/**
 * Memory upgrade recover atomic lease release, failure recovery, and retry tests (TECH-8191 §Q6, PR5.11).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  claimUpgradeLease,
  reconcileLapsedUpgradeLeases,
  runRecover,
} from "../../server/src/services/company-memory-upgrade/index.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertRecoverUpgrade,
  setupPublishTestEnvironment,
} from "./memory-upgrade-recover-helpers.js";

test("recover lease release discipline and atomic transaction semantics (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("recover-lease");
  t.after(async () => {
    await env.cleanup();
  });

  const cpDb = env.cpWorkerDb;
  const company = env.company;

  t.beforeEach(async () => {
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, company.id));
  });

  await t.test("before_update failure throws RECOVER_NOT_APPLIED and leaves row untouched", async () => {
    const upgrade = await insertRecoverUpgrade(cpDb, company.id, {
      state: "needs_recovery",
      recoverToState: "sweeping",
      lastError: "tenant_fence_claim_failed",
    });

    await assert.rejects(
      () =>
        runRecover(
          { companyId: company.id, confirm: company.id },
          {
            cpDb,
            _internalTxHook: async (phase) => {
              if (phase === "before_update") {
                throw new Error("simulated before_update network drop");
              }
            },
          },
        ),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "RECOVER_NOT_APPLIED");
        assert.ok(err.cause instanceof Error);
        assert.equal(err.cause.message, "simulated before_update network drop");
        return true;
      },
    );

    const [row] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "needs_recovery");
    assert.equal(row.recoverToState, "sweeping");
    assert.equal(row.lastError, "tenant_fence_claim_failed");
    assert.equal(row.leaseToken, null);
    assert.equal(row.leaseOwner, null);
  });

  await t.test(
    "after_update failure throws RECOVER_NOT_APPLIED, leaves row untouched, then plain re-run succeeds",
    async () => {
      const upgrade = await insertRecoverUpgrade(cpDb, company.id, {
        state: "needs_recovery",
        recoverToState: "sweeping",
        lastError: "tenant_fence_claim_failed",
      });

      await assert.rejects(
        () =>
          runRecover(
            { companyId: company.id, confirm: company.id },
            {
              cpDb,
              _internalTxHook: async (phase) => {
                if (phase === "after_update") {
                  throw new Error("simulated after_update failure");
                }
              },
            },
          ),
        (err: any) => {
          assert.ok(err instanceof CompanyMemoryUpgradeError);
          assert.equal(err.code, "RECOVER_NOT_APPLIED");
          assert.ok(err.cause instanceof Error);
          assert.equal(err.cause.message, "simulated after_update failure");
          return true;
        },
      );

      const [row] = await cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(row.state, "needs_recovery");
      assert.equal(row.recoverToState, "sweeping");

      // Plain re-run without hook succeeds
      const report = await runRecover({ companyId: company.id, confirm: company.id }, { cpDb });
      assert.equal(report.state, "sweeping");
      assert.equal(report.recoveryConfirmedByReadback, false);
      assert.equal(report.claimableNow, true);

      const [recoveredRow] = await cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(recoveredRow.state, "sweeping");
      assert.equal(recoveredRow.recoverToState, null);
      assert.equal(recoveredRow.lastError, null);
    },
  );

  await t.test("post-commit failure resolves with recoveryConfirmedByReadback true and claimable", async () => {
    const upgrade = await insertRecoverUpgrade(cpDb, company.id, {
      state: "needs_recovery",
      recoverToState: "sweeping",
    });

    const report = await runRecover(
      { companyId: company.id, confirm: company.id },
      {
        cpDb,
        _internalPostCommitHook: async () => {
          throw new Error("simulated post-commit disconnect");
        },
      },
    );

    assert.equal(report.state, "sweeping");
    assert.equal(report.recoveryConfirmedByReadback, true);
    assert.equal(report.leaseReleased, true);
    assert.equal(report.claimableNow, true);
    assert.equal(report.leaseOwner, null);
    assert.ok(
      report.actionRequired.includes(
        "The recover command lost its connection before it could confirm the result",
      ),
    );

    const [row] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "sweeping");
    assert.equal(row.recoverToState, null);
    assert.equal(row.leaseToken, null);
  });

  await t.test(
    "concurrent claimant in post-commit hook resolves with claimableNow false and other worker's lease intact",
    async () => {
      const upgrade = await insertRecoverUpgrade(cpDb, company.id, {
        state: "needs_recovery",
        recoverToState: "sweeping",
      });

      let claimToken: string | null = null;
      const report = await runRecover(
        { companyId: company.id, confirm: company.id },
        {
          cpDb,
          _internalPostCommitHook: async () => {
            const claim = await claimUpgradeLease(cpDb, {
              upgradeId: upgrade.id,
              leaseOwner: "concurrent_fast_worker",
              ttlMs: 60_000,
              now: new Date(Date.now() + 1000),
            });
            assert.equal(claim.acquired, true);
            claimToken = claim.leaseToken;
            throw new Error("simulated post-commit client disconnect");
          },
        },
      );

      assert.equal(report.recoveryConfirmedByReadback, true);
      assert.equal(report.leaseReleased, true);
      assert.equal(report.claimableNow, false);
      assert.equal(report.leaseOwner, null);

      const [row] = await cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(row.state, "sweeping");
      assert.equal(row.leaseOwner, "concurrent_fast_worker");
      assert.equal(row.leaseToken, claimToken);
    },
  );

  await t.test(
    "needs_recovery row already holding a lease throws RECOVER_LEASE_PRESENT and leaves row unchanged",
    async () => {
      const upgrade = await insertRecoverUpgrade(cpDb, company.id, {
        state: "needs_recovery",
        recoverToState: "sweeping",
        leaseToken: "rogue-lease-token",
        leaseOwner: "rogue-worker",
      });

      await assert.rejects(
        () => runRecover({ companyId: company.id, confirm: company.id }, { cpDb }),
        (err: any) => {
          assert.ok(err instanceof CompanyMemoryUpgradeError);
          assert.equal(err.code, "RECOVER_LEASE_PRESENT");
          assert.equal(err.message, "Cannot recover upgrade: the upgrade row still holds a lease.");
          return true;
        },
      );

      const [row] = await cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(row.state, "needs_recovery");
      assert.equal(row.leaseToken, "rogue-lease-token");
      assert.equal(row.leaseOwner, "rogue-worker");
    },
  );

  await t.test("readback failure throws RECOVER_OUTCOME_UNKNOWN", async () => {
    await insertRecoverUpgrade(cpDb, company.id, {
      state: "needs_recovery",
      recoverToState: "sweeping",
    });

    await assert.rejects(
      () =>
        runRecover(
          { companyId: company.id, confirm: company.id },
          {
            cpDb,
            _internalPostCommitHook: async () => {
              throw new Error("simulated post-commit disconnect");
            },
            _internalReadbackHook: async () => {
              throw new Error("simulated database unreachable on readback");
            },
          },
        ),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "RECOVER_OUTCOME_UNKNOWN");
        assert.ok(err.cause instanceof Error);
        assert.equal(err.cause.message, "simulated post-commit disconnect");
        return true;
      },
    );
  });

  await t.test(
    "happy path is immediately claimable and reconcileLapsedUpgradeLeases does not re-lapse freshly recovered row",
    async () => {
      const oneHourAgo = new Date(Date.now() - 3600_000);
      const upgrade = await insertRecoverUpgrade(cpDb, company.id, {
        state: "needs_recovery",
        recoverToState: "sweeping",
        createdAt: oneHourAgo,
        updatedAt: oneHourAgo,
      });

      const report = await runRecover({ companyId: company.id, confirm: company.id }, { cpDb });
      assert.equal(report.isDryRun, false);
      assert.equal(report.state, "sweeping");
      assert.equal(report.leaseReleased, true);
      assert.equal(report.claimableNow, true);
      assert.equal(report.recoveryConfirmedByReadback, false);

      const lapsedCount = await reconcileLapsedUpgradeLeases(cpDb, {
        staleCreatedAt: new Date(Date.now() + 60_000),
      });
      assert.equal(lapsedCount, 0);

      const [rowAfterReconcile] = await cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(rowAfterReconcile.state, "sweeping");
      assert.equal(rowAfterReconcile.leaseToken, null);

      const claim = await claimUpgradeLease(cpDb, {
        upgradeId: upgrade.id,
        leaseOwner: "followup_sweep_worker",
        now: new Date(Date.now() + 1000),
      });
      assert.equal(claim.acquired, true);
      assert.ok(claim.leaseToken !== null);
      assert.equal(claim.leaseOwner, "followup_sweep_worker");
    },
  );
});
