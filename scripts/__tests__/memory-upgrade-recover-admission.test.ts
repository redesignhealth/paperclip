/**
 * Memory upgrade recover admission and state refusal tests (TECH-8191 §Q6, PR5.11).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runRecover } from "../../server/src/services/company-memory-upgrade/index.js";
import { CompanyMemoryUpgradeError, type UpgradeState } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  companies,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertRecoverUpgrade,
  setupPublishTestEnvironment,
} from "./memory-upgrade-recover-helpers.js";

test("recover admission parity and state guard (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("recover-admission");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const company = env.company;

  t.beforeEach(async () => {
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, company.id));
  });

  await t.test(
    "refuses from any non-needs_recovery state (sweeping/draining/verified/pruning/completed/rolled_back/aborted)",
    async () => {
      const nonRecoveryStates: UpgradeState[] = [
        "sweeping", "draining", "verified", "pruning", "completed", "rolled_back", "aborted",
      ];

      for (const st of nonRecoveryStates) {
        const upgrade = await insertRecoverUpgrade(cpDb, company.id, { state: st });

        await assert.rejects(
          () => runRecover({ companyId: company.id, confirm: company.id }, { cpDb }),
          (err: any) => {
            assert.ok(err instanceof CompanyMemoryUpgradeError);
            assert.equal(err.code, (st === "completed" || st === "rolled_back" || st === "aborted") ? "STATE_MISMATCH" : "INVALID_RECOVERY");
            return true;
          },
        );

        const [row] = await cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
        assert.equal(row.state, st);
        await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
      }
    },
  );

  await t.test("refuses while company deletion is in progress without changing state", async () => {
    const upgrade = await insertRecoverUpgrade(cpDb, company.id, {
      state: "needs_recovery",
      recoverToState: "sweeping",
      lastError: "heartbeat_lost",
    });

    await cpDb.update(companies).set({ deletionStartedAt: new Date() }).where(eq(companies.id, company.id));

    try {
      await assert.rejects(
        () => runRecover({ companyId: company.id, confirm: company.id }, { cpDb }),
        (err: any) => {
          assert.ok(err instanceof CompanyMemoryUpgradeError);
          assert.equal(err.code, "COMPANY_DELETION_IN_PROGRESS");
          return true;
        },
      );

      const [row] = await cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(row.state, "needs_recovery");
      assert.equal(row.recoverToState, "sweeping");
      assert.equal(row.lastError, "heartbeat_lost");
    } finally {
      await cpDb.update(companies).set({ deletionStartedAt: null }).where(eq(companies.id, company.id));
    }
  });

  await t.test("dry run changes nothing", async () => {
    const upgrade = await insertRecoverUpgrade(cpDb, company.id, {
      state: "needs_recovery",
      recoverToState: "sweeping",
      lastError: "unhandled_crash",
    });

    const rep1 = await runRecover({ companyId: company.id }, { cpDb });
    assert.equal(rep1.isDryRun, true);
    assert.equal(rep1.leaseReleased, false);

    const rep2 = await runRecover({ companyId: company.id, confirm: company.id, dryRun: true }, { cpDb });
    assert.equal(rep2.isDryRun, true);

    const [row] = await cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "needs_recovery");
    assert.equal(row.recoverToState, "sweeping");
    assert.equal(row.lastError, "unhandled_crash");
    assert.equal(row.leaseToken, null);
  });
});
