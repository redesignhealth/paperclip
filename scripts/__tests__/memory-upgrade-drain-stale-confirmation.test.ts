/**
 * Regressions for invalidating stale drain confirmation on blocked probes (TECH-8191 R1 blocker).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runDrain } from "../../server/src/services/company-memory-upgrade/drain.js";
import {
  claimUpgradeLease,
  releaseUpgradeLease,
} from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  agents,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  insertTenantMemoryRow,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("stale drain confirmation invalidation regressions (TECH-8191 R1)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-stale-conf");
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
      name: "Hermes Agent Stale Conf",
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

  const drainOnce = (isDryRun = false) =>
    runDrain(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        once: true,
        dryRun: isDryRun,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

  // 1. Confirm drain, then introduce a blocking source -> rerun drain reports false and CP drain_confirmed_at NULL
  await t.test("confirm -> introduce blocking source -> rerun reports false and clears drainConfirmedAt", async () => {
    // Seed streak to 11m ago so drain confirms
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '11 minutes', drain_confirmed_at = NULL WHERE id = ${upgrade.id}`,
    );

    const initialReport = await drainOnce();
    assert.equal(initialReport.confirmed, true);
    assert.ok(initialReport.confirmedAt instanceof Date);

    const [confirmedRow] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.ok(confirmedRow.drainConfirmedAt instanceof Date);

    // Introduce a blocking source in tenant database created before markedAt
    const blockingSourceId = randomUUID();
    await insertTenantMemoryRow(env.tenantSql, {
      id: blockingSourceId,
      agentId: env.agent.id,
      data: "unmigrated blocking memory",
      createdAt: new Date(markedAt.getTime() - 60_000),
    });

    try {
      // Re-run drain: probe discovers blocking source; must clear confirmation and report false
      const rerunReport = await drainOnce();
      assert.equal(rerunReport.confirmed, false);
      assert.equal(rerunReport.confirmedAt, null);
      assert.ok(rerunReport.blockedBy.includes("blocking_sources"));

      const [afterRerun] = await env.cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(afterRerun.drainConfirmedAt, null);
      assert.equal(afterRerun.drainProbeStreakStartedAt, null);
    } finally {
      await env.tenantSql`DELETE FROM mem0_memories WHERE id = ${blockingSourceId}`;
    }
  });

  // 2. Confirm drain, then introduce pre-flip active run -> rerun drain reports false and CP drain_confirmed_at NULL
  await t.test("confirm -> introduce pre-flip active run -> rerun reports false and clears drainConfirmedAt", async () => {
    // Re-confirm drain
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '11 minutes', drain_confirmed_at = NULL WHERE id = ${upgrade.id}`,
    );

    const initialReport = await drainOnce();
    assert.equal(initialReport.confirmed, true);
    assert.ok(initialReport.confirmedAt instanceof Date);

    const [confirmedRow] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.ok(confirmedRow.drainConfirmedAt instanceof Date);

    // Introduce an active run started before markedAt
    const [blockingRun] = await env.cpDb
      .insert(heartbeatRuns)
      .values({
        companyId: env.company.id,
        agentId: hermesAgent.id,
        status: "running",
        startedAt: new Date(markedAt.getTime() - 60_000),
        createdAt: new Date(markedAt.getTime() - 60_000),
      })
      .returning();

    try {
      // Re-run drain: probe discovers active run; must clear confirmation and report false
      const rerunReport = await drainOnce();
      assert.equal(rerunReport.confirmed, false);
      assert.equal(rerunReport.confirmedAt, null);
      assert.ok(rerunReport.blockedBy.includes("blocking_runs"));

      const [afterRerun] = await env.cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(afterRerun.drainConfirmedAt, null);
      assert.equal(afterRerun.drainProbeStreakStartedAt, null);
    } finally {
      await env.cpDb
        .update(heartbeatRuns)
        .set({ status: "completed" })
        .where(eq(heartbeatRuns.id, blockingRun.id));
    }
  });

  // 3. Held-lease case: report false without stealing or clearing other worker's lease
  await t.test("held-lease case: reports false without stealing or clearing other lease", async () => {
    // Seed confirmed timestamp on upgrade row
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_confirmed_at = clock_timestamp() WHERE id = ${upgrade.id}`,
    );

    const [nowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
    const dbNow = nowRow.t instanceof Date ? nowRow.t : new Date(nowRow.t);

    const otherWorkerClaim = await claimUpgradeLease(env.cpDb, {
      upgradeId: upgrade.id,
      leaseOwner: "other_worker_drain_test",
      now: dbNow,
      ttlMs: 60_000,
    });
    assert.ok(otherWorkerClaim.acquired && otherWorkerClaim.leaseToken);

    try {
      const report = await drainOnce();
      assert.equal(report.confirmed, false);
      assert.equal(report.confirmedAt, null);
      assert.equal(report.leaseHeldByOther, true);
      assert.ok(report.blockedBy.includes("a sweep or publish is in flight"));

      // Verify other worker's lease was not stolen or cleared
      const [current] = await env.cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(current.leaseToken, otherWorkerClaim.leaseToken);
      assert.equal(current.leaseOwner, "other_worker_drain_test");
    } finally {
      await releaseUpgradeLease(env.cpDb, upgrade.id, otherWorkerClaim.leaseToken);
    }
  });

  // 4. Dry-run blocked must report false without mutation
  await t.test("dry-run blocked case: reports false without mutation", async () => {
    // Seed stale confirmed timestamp on upgrade row
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_confirmed_at = clock_timestamp() - interval '1 hour', drain_probe_streak_started_at = NULL WHERE id = ${upgrade.id}`,
    );

    const [before] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.ok(before.drainConfirmedAt instanceof Date);

    // Introduce an active run to block drain
    const [blockingRun] = await env.cpDb
      .insert(heartbeatRuns)
      .values({
        companyId: env.company.id,
        agentId: hermesAgent.id,
        status: "running",
        startedAt: new Date(markedAt.getTime() - 60_000),
        createdAt: new Date(markedAt.getTime() - 60_000),
      })
      .returning();

    try {
      const dryReport = await drainOnce(true);
      assert.equal(dryReport.confirmed, false);
      assert.equal(dryReport.confirmedAt, null);
      assert.equal(dryReport.isDryRun, true);
      assert.ok(dryReport.blockedBy.includes("blocking_runs"));

      // Verify CP database was NOT mutated
      const [after] = await env.cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(after.drainConfirmedAt?.toISOString(), before.drainConfirmedAt?.toISOString());
      assert.equal(after.drainProbeStreakStartedAt, null);
    } finally {
      await env.cpDb
        .update(heartbeatRuns)
        .set({ status: "completed" })
        .where(eq(heartbeatRuns.id, blockingRun.id));
    }
  });

  // 5. Continuous mode does not exit as confirmed from stale timestamp
  await t.test("continuous mode: does not exit as confirmed from stale timestamp", async () => {
    // Seed stale confirmed timestamp on upgrade row
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_confirmed_at = clock_timestamp() - interval '30 minutes', drain_probe_streak_started_at = NULL WHERE id = ${upgrade.id}`,
    );

    // Introduce an active run to block drain
    const [blockingRun] = await env.cpDb
      .insert(heartbeatRuns)
      .values({
        companyId: env.company.id,
        agentId: hermesAgent.id,
        status: "running",
        startedAt: new Date(markedAt.getTime() - 60_000),
        createdAt: new Date(markedAt.getTime() - 60_000),
      })
      .returning();

    let sleepInvoked = false;
    const mockSleep = async () => {
      sleepInvoked = true;
      // When sleep is called, verify that drain invalidated the stale confirmation in the database
      const [current] = await env.cpDb
        .select()
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
      assert.equal(current.drainConfirmedAt, null);
      assert.equal(current.drainProbeStreakStartedAt, null);
      throw new Error("TERMINATE_CONTINUOUS_LOOP");
    };

    try {
      await runDrain(
        {
          companyId: env.company.id,
          confirm: env.company.id,
          once: false, // continuous mode
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
      assert.fail("Continuous mode should not have exited cleanly with stale confirmation");
    } catch (err: unknown) {
      assert.equal((err as Error).message, "TERMINATE_CONTINUOUS_LOOP");
    } finally {
      await env.cpDb
        .update(heartbeatRuns)
        .set({ status: "completed" })
        .where(eq(heartbeatRuns.id, blockingRun.id));
    }

    assert.equal(sleepInvoked, true, "Continuous mode entered sleep instead of exiting as confirmed");
  });
});
