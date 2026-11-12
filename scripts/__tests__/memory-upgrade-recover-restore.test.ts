/**
 * Memory upgrade recover state restoration tests (TECH-8191 §Q6, PR5.11).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatRecoverReport, runRecover } from "../../server/src/services/company-memory-upgrade/index.js";
import { readScopeMigrationMarker } from "../../server/src/services/company-memory-upgrade/scope-marker.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertRecoverUpgrade,
  setupPublishTestEnvironment,
} from "./memory-upgrade-recover-helpers.js";

test("recover state restoration and operator guidance (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("recover-restore");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const company = env.company;

  t.beforeEach(async () => {
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, company.id));
  });

  await t.test("restores recover_to_state and clears lastError", async () => {
    const upgrade = await insertRecoverUpgrade(cpDb, company.id, {
      state: "needs_recovery",
      recoverToState: "sweeping",
      lastError: "tenant_fence_claim_failed",
    });

    const report = await runRecover({ companyId: company.id, confirm: company.id }, { cpDb });
    assert.equal(report.isDryRun, false);
    assert.equal(report.state, "sweeping");
    assert.equal(report.priorState, "needs_recovery");
    assert.equal(report.recoverToState, "sweeping");
    assert.equal(report.clearedLastError, "tenant_fence_claim_failed");
    assert.equal(report.leaseReleased, true);
    assert.equal(report.claimableNow, true);
    assert.ok(report.actionRequired.includes("pnpm memory:upgrade sweep"));

    const [row] = await cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "sweeping");
    assert.equal(row.recoverToState, null);
    assert.equal(row.lastError, null);
    assert.equal(row.leaseToken, null);
  });

  await t.test("recover_to_state = flipping tells operator to re-run flip", async () => {
    await insertRecoverUpgrade(cpDb, company.id, { state: "needs_recovery", recoverToState: "flipping" });
    const report = await runRecover({ companyId: company.id, confirm: company.id }, { cpDb });

    assert.equal(report.state, "flipping");
    assert.ok(report.actionRequired.includes("Run 'pnpm memory:upgrade flip' to finish the flip (flip is idempotent)."));

    const formatted = formatRecoverReport(report, "text");
    assert.ok(formatted.includes("Restored State: flipping"));
    assert.ok(formatted.includes("Run 'pnpm memory:upgrade flip'"));
    assert.ok(formatted.includes("flip is idempotent"));
  });

  await t.test("recover_to_state = verified tells operator to re-run verify or rollback", async () => {
    await insertRecoverUpgrade(cpDb, company.id, { state: "needs_recovery", recoverToState: "verified" });
    const report = await runRecover({ companyId: company.id, confirm: company.id }, { cpDb });

    assert.equal(report.state, "verified");
    assert.ok(report.actionRequired.includes("verify"));
    assert.ok(report.actionRequired.includes("rollback"));

    const formatted = formatRecoverReport(report, "text");
    assert.ok(formatted.includes("Restored State: verified"));
    assert.ok(formatted.includes("Re-run 'pnpm memory:upgrade verify'"));
  });

  await t.test("recover_to_state = pruning reports tooling unavailable and rollback refused", async () => {
    await insertRecoverUpgrade(cpDb, company.id, { state: "needs_recovery", recoverToState: "pruning" });
    const report = await runRecover({ companyId: company.id, confirm: company.id }, { cpDb });

    assert.equal(report.state, "pruning");
    assert.ok(report.actionRequired.includes("Pruning tooling is not yet available"));
    assert.ok(report.actionRequired.includes("rollback is refused once pruning has started"));
    assert.ok(report.actionRequired.includes("manual database cleanup should not be attempted"));

    const formatted = formatRecoverReport(report, "text");
    assert.ok(formatted.includes("Restored State: pruning"));
    assert.ok(formatted.includes("Pruning tooling is not yet available"));
  });

  await t.test("scope migration marker is untouched by dry-run and confirmed recover", async () => {
    await insertRecoverUpgrade(cpDb, company.id, { state: "needs_recovery", recoverToState: "flipping" });

    const testCompletedAt = new Date("2026-06-01T12:00:00Z");
    await cpDb
      .update(companyMemoryDatabases)
      .set({
        scopeMigrationCompletedAt: testCompletedAt,
        scopeMigrationMode: "copy",
        scopeMigrationAgentScopeObservedAt: testCompletedAt,
      })
      .where(eq(companyMemoryDatabases.companyId, company.id));

    const markerBefore = await readScopeMigrationMarker(cpDb, company.id);
    assert.deepEqual(markerBefore, {
      completedAt: testCompletedAt,
      mode: "copy",
      agentScopeObservedAt: testCompletedAt,
    });

    await runRecover({ companyId: company.id, dryRun: true }, { cpDb });
    const markerAfterDryRun = await readScopeMigrationMarker(cpDb, company.id);
    assert.deepEqual(markerAfterDryRun, markerBefore);

    await runRecover({ companyId: company.id, confirm: company.id }, { cpDb });
    const markerAfterConfirmed = await readScopeMigrationMarker(cpDb, company.id);
    assert.deepEqual(markerAfterConfirmed, markerBefore);
  });
});
