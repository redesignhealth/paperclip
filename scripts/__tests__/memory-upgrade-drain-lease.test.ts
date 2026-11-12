/**
 * Lease discipline and reconciler safety tests for drain (TECH-8191 §Q3, PR5.7).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
} from "./memory-upgrade-sweep-helpers.js";
import { runDrain } from "../../server/src/services/company-memory-upgrade/drain.js";
import {
  claimUpgradeLease,
  reconcileLapsedUpgradeLeases,
  releaseUpgradeLease,
} from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("drain lease discipline and reconciler safety (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-lease-disc");
  t.after(async () => {
    await env.cleanup();
  });

  const [t0Row] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
  const t0 = t0Row.t instanceof Date ? t0Row.t : new Date(t0Row.t);
  const markedAt = new Date(t0.getTime() - 30 * 60_000);
  const observedAt = new Date(t0.getTime() - 25 * 60_000);

  await env.cpDb
    .update(companyMemoryDatabases)
    .set({
      scopeMigrationCompletedAt: markedAt,
      scopeMigrationMode: "copy",
      scopeMigrationAgentScopeObservedAt: observedAt,
      updatedAt: markedAt,
    })
    .where(eq(companyMemoryDatabases.companyId, env.company.id));

  const [upgrade] = await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id,
      state: "draining",
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      markedAt,
      drainProbeStreakStartedAt: null,
      drainConfirmedAt: null,
    })
    .returning();

  await t.test("lease is released during sleep between probes; concurrent sweep can claim mid-drain", async () => {
    let sleepCalled = false;
    let leaseHeldDuringSleep: boolean | null = null;
    let concurrentClaimSucceeded: boolean | null = null;

    const mockSleep = async () => {
      sleepCalled = true;
      // 1. Assert no lease held while sleeping
      const [current] = await env.cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      leaseHeldDuringSleep = Boolean(current.leaseToken);

      // 2. Assert concurrent sweep can claim the lease mid-drain
      const [nowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
      const dbNow = nowRow.t instanceof Date ? nowRow.t : new Date(nowRow.t);
      const claim = await claimUpgradeLease(env.cpDb, {
        upgradeId: upgrade.id,
        leaseOwner: "concurrent_catchup_sweep",
        now: dbNow,
        ttlMs: 60_000,
      });
      concurrentClaimSucceeded = claim.acquired;

      // Release concurrent sweep claim before continuing
      if (claim.acquired && claim.leaseToken) {
        await releaseUpgradeLease(env.cpDb, upgrade.id, claim.leaseToken);
      }

      // Back-date streak start by 11 minutes so probe 2 confirms
      await env.cpDb.execute(
        sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '11 minutes' WHERE id = ${upgrade.id}`,
      );
    };

    const report = await runDrain(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        once: false, // will loop until confirmed
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        sleep: mockSleep,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    assert.equal(sleepCalled, true);
    assert.equal(leaseHeldDuringSleep, false);
    assert.equal(concurrentClaimSucceeded, true);
    assert.equal(report.confirmed, true);

    // Final state of upgrade: cleanly released, no lease token
    const [finalUpgrade] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(finalUpgrade.leaseToken, null);
    assert.equal(finalUpgrade.state, "draining");
    assert.ok(finalUpgrade.drainConfirmedAt instanceof Date);
  });

  await t.test("a cleanly released draining upgrade is NOT dragged to needs_recovery by reconcileLapsedUpgradeLeases", async () => {
    // Reconciler runs against all upgrades
    const lapsedCount = await reconcileLapsedUpgradeLeases(env.cpDb);
    assert.equal(lapsedCount, 0);

    const [current] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(current.state, "draining");
    assert.notEqual(current.state, "needs_recovery");
  });
});
