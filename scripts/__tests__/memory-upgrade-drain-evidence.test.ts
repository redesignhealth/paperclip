/**
 * Mandated regressions for drain evidence and blocking runs (TECH-8191 §Q3, PR5.7).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  agents,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  sql,
} from "./memory-upgrade-sweep-helpers.js";
import { runDrain } from "../../server/src/services/company-memory-upgrade/drain.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("drain blocking pre-flip runs regression (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-ev-reg");
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

  const [hermesAgent] = await env.cpDb
    .insert(agents)
    .values({
      companyId: env.company.id,
      name: "Hermes Agent 1",
      adapterType: "hermes_local",
    })
    .returning();

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

  const [preFlipRun] = await env.cpDb
    .insert(heartbeatRuns)
    .values({
      companyId: env.company.id,
      agentId: hermesAgent.id,
      status: "running",
      startedAt: new Date(t0.getTime() - 35 * 60_000),
      createdAt: new Date(t0.getTime() - 35 * 60_000),
    })
    .returning();

  const drainOnce = () =>
    runDrain(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        once: true,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

  // Iteration 1 while run is running: does NOT confirm, streak remains null
  const report1 = await drainOnce();
  assert.equal(report1.confirmed, false);
  assert.equal(report1.counts, false);
  assert.equal(report1.blockingRuns.length, 1);
  assert.equal(report1.blockingRuns[0].id, preFlipRun.id);
  assert.ok(report1.blockedBy.includes("blocking_runs"));

  // Complete pre-flip run
  await env.cpDb
    .update(heartbeatRuns)
    .set({ status: "completed" })
    .where(eq(heartbeatRuns.id, preFlipRun.id));

  // Iteration 2: now quiescent, first probe starts streak
  const report2 = await drainOnce();
  assert.equal(report2.confirmed, false);
  assert.equal(report2.counts, false);
  assert.equal(report2.blockingRuns.length, 0);
  assert.ok(report2.streakStartedAt instanceof Date);

  // Verify streak start was saved in database
  const [upgradeAfterStreak] = await env.cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));
  assert.ok(upgradeAfterStreak.drainProbeStreakStartedAt instanceof Date);
  assert.equal(upgradeAfterStreak.drainConfirmedAt, null);

  // Iteration 3: 5 minutes later, still does not confirm
  await env.cpDb.execute(
    sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '5 minutes' WHERE id = ${upgrade.id}`,
  );
  const report3 = await drainOnce();
  assert.equal(report3.confirmed, false);
  assert.equal(report3.counts, false);

  // Iteration 4: 11 minutes after streak start, confirms!
  await env.cpDb.execute(
    sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '11 minutes' WHERE id = ${upgrade.id}`,
  );
  const report4 = await drainOnce();
  assert.equal(report4.confirmed, true);
  assert.equal(report4.counts, true);
  assert.ok(report4.confirmedAt instanceof Date);

  const [finalUpgrade] = await env.cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));
  assert.ok(finalUpgrade.drainConfirmedAt instanceof Date);
  assert.equal(finalUpgrade.state, "draining");
});
