/**
 * Regressions for durable streak invalidation by mutators across loop, restart, and post-confirmation (TECH-8191 §Q3, PR5.7 RC-1 & RC-2 Change A).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runDrain } from "../../server/src/services/company-memory-upgrade/drain.js";
import { runPublish } from "../../server/src/services/company-memory-upgrade/publish.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
import {
  seedLedgerRow,
  seedStagedMemory,
  setupPublishTestEnvironment,
} from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createFakeConversionClient,
  createFakeEmbeddingClient,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("drain streak invalidation by mutator regressions (Change A)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-streak-inv");
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

  const sweepParams = {
    databaseUrl: env.tenantUrl,
    controlPlaneUrl: env.cpUrl,
    companyId: env.company.id,
    confirm: env.company.id,
  };
  const sweepDeps = {
    tenantSql: env.tenantWorkerSql,
    controlPlaneDb: env.cpWorkerDb,
    _internalSkipVectorIdentityCheck: true,
    conversionClient: createFakeConversionClient(() => ({ status: "convert" })),
    embeddingClient: createFakeEmbeddingClient(),
  };

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

  // 1. Same-loop: drain starts a streak in iteration 1; during sleep, a real catch-up sweep runs;
  // streak is cleared; iteration 2 does NOT confirm and writes a fresh streak > sweep time.
  await t.test("same-loop: catch-up sweep during sleep clears streak; iteration 2 writes fresh streak", async () => {
    let sleepCount = 0;
    let sweepFinishedAt: Date | null = null;

    const mockSleep = async () => {
      sleepCount++;
      if (sleepCount === 1) {
        // Assert streak was set by iteration 1
        const [duringSleep] = await env.cpDb
          .select()
          .from(companyMemoryUpgrades)
          .where(eq(companyMemoryUpgrades.id, upgrade.id));
        assert.ok(duringSleep.drainProbeStreakStartedAt instanceof Date);

        // Run real sweep in draining
        await runSweep(sweepParams, sweepDeps);
        const [nowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
        sweepFinishedAt = nowRow.t instanceof Date ? nowRow.t : new Date(nowRow.t);

        // Assert streak is immediately NULL after sweep
        const [afterSweep] = await env.cpDb
          .select()
          .from(companyMemoryUpgrades)
          .where(eq(companyMemoryUpgrades.id, upgrade.id));
        assert.equal(afterSweep.drainProbeStreakStartedAt, null);
        assert.equal(afterSweep.drainConfirmedAt, null);
      } else if (sleepCount === 2) {
        // Iteration 2 finished without confirming, wrote a fresh streak
        const [afterIter2] = await env.cpDb
          .select()
          .from(companyMemoryUpgrades)
          .where(eq(companyMemoryUpgrades.id, upgrade.id));
        assert.ok(afterIter2.drainProbeStreakStartedAt instanceof Date);
        assert.ok(sweepFinishedAt instanceof Date);
        assert.ok(
          afterIter2.drainProbeStreakStartedAt.getTime() >= sweepFinishedAt.getTime(),
          `Fresh streak ${afterIter2.drainProbeStreakStartedAt.toISOString()} must be >= sweep time ${sweepFinishedAt.toISOString()}`,
        );
        assert.equal(afterIter2.drainConfirmedAt, null);

        // Back-date streak by 11 minutes so iteration 3 confirms and completes the loop
        await env.cpDb.execute(
          sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '11 minutes' WHERE id = ${upgrade.id}`,
        );
      }
    };

    const loopReport = await runDrain(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        once: false,
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

    assert.equal(loopReport.confirmed, true);
    assert.equal(sleepCount, 2);
  });

  // 2. Restart: drain --once -> real sweep -> back-date marked_at only -> second drain --once:
  // confirmed === false, drain_confirmed_at IS NULL, new streak start > sweep time
  await t.test("restart: sweep between --once runs clears streak and prevents confirmation on restart", async () => {
    // Reset upgrade state
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = null, drain_confirmed_at = null WHERE id = ${upgrade.id}`,
    );

    // Iteration 1: drain --once starts streak
    const report1 = await drainOnce();
    assert.equal(report1.confirmed, false);
    assert.ok(report1.streakStartedAt instanceof Date);

    // Real catch-up sweep runs
    await runSweep(sweepParams, sweepDeps);
    const [nowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
    const sweepTime = nowRow.t instanceof Date ? nowRow.t : new Date(nowRow.t);

    const [afterSweep] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(afterSweep.drainProbeStreakStartedAt, null);
    assert.equal(afterSweep.drainConfirmedAt, null);

    // Back-date the upgrade's marked_at and marker completedAt
    const [backdateRow] = (await env.cpDb.execute(
      sql`SELECT (clock_timestamp() - interval '2 hours') AS t`,
    )) as unknown as Array<{ t: Date | string }>;
    const backdate = backdateRow.t instanceof Date ? backdateRow.t : new Date(backdateRow.t);

    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({ markedAt: backdate })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    await env.cpDb
      .update(companyMemoryDatabases)
      .set({ scopeMigrationCompletedAt: backdate })
      .where(eq(companyMemoryDatabases.companyId, env.company.id));

    // Iteration 2: second drain --once
    const report2 = await drainOnce();
    assert.equal(report2.confirmed, false);
    assert.equal(report2.confirmedAt, null);

    const [afterRestart] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.ok(afterRestart.drainProbeStreakStartedAt instanceof Date);
    assert.ok(
      afterRestart.drainProbeStreakStartedAt.getTime() >= sweepTime.getTime(),
      `New streak start must be >= sweep time`,
    );
    assert.equal(afterRestart.drainConfirmedAt, null);
  });

  // 3. Negative control: drain --once -> back-date streak to 11 min with NO sweep in between ->
  // second drain --once confirms
  await t.test("negative control: 11-minute streak without intervening sweep confirms cleanly", async () => {
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '11 minutes', drain_confirmed_at = null WHERE id = ${upgrade.id}`,
    );

    const report = await drainOnce();
    assert.equal(report.confirmed, true);
    assert.equal(report.counts, true);
    assert.ok(report.confirmedAt instanceof Date);

    const [finalRow] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.ok(finalRow.drainConfirmedAt instanceof Date);

    const [dbNowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
    const dbNow = dbNowRow.t instanceof Date ? dbNowRow.t : new Date(dbNowRow.t);
    const deltaMs = Math.abs(finalRow.drainConfirmedAt.getTime() - dbNow.getTime());
    assert.ok(deltaMs < 5_000, `Confirmed at should be within 5s of clock_timestamp, got ${deltaMs}ms`);
  });

  // 4. Post-confirmation (§2.3): a real catch-up sweep clears BOTH drainConfirmedAt and drainProbeStreakStartedAt
  await t.test("post-confirmation: catch-up sweep clears confirmedAt and restarts the clock", async () => {
    // Assert upgrade is currently confirmed
    const [before] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.ok(before.drainConfirmedAt instanceof Date);

    // Real catch-up sweep
    await runSweep(sweepParams, sweepDeps);

    const [after] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(after.drainProbeStreakStartedAt, null);
    assert.equal(after.drainConfirmedAt, null);

    // Next drain --once reports not confirmed
    const report = await drainOnce();
    assert.equal(report.confirmed, false);
    assert.equal(report.confirmedAt, null);
  });

  // 5. Publish parity: runPublish also clears both fields when draining
  await t.test("publish parity: runPublish clears streak and confirmed when draining", async () => {
    // Re-set streak and confirmed
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '11 minutes', drain_confirmed_at = clock_timestamp() WHERE id = ${upgrade.id}`,
    );

    // Stage a memory to publish
    const sourceId = randomUUID();
    const outputId = randomUUID();
    const text = "Parity memory for publish test";
    const sha = computeSourceContentSha256(text);
    await insertTenantMemoryRow(env.tenantSql, { id: sourceId, agentId: env.agent.id, data: text });
    await seedStagedMemory(env.tenantSql, {
      upgradeId: upgrade.id,
      sourceId,
      outputId,
      agentId: env.agent.id,
      contentSha256: sha,
      payload: { data: text, user_id: env.agent.id },
    });
    await seedLedgerRow(env.tenantSql, {
      upgradeId: upgrade.id,
      sourceId,
      agentId: env.agent.id,
      outcome: "published",
      outputIds: [outputId],
      sourceContentSha256: sha,
    });

    // Run publish
    const pubReport = await runPublish(
      { companyId: env.company.id, confirm: env.company.id },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );
    assert.equal(pubReport.counts.publishedCount, 1);

    // Both fields must be cleared
    const [afterPub] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(afterPub.drainProbeStreakStartedAt, null);
    assert.equal(afterPub.drainConfirmedAt, null);

    // Drain --once reports not confirmed
    const drainReport = await drainOnce();
    assert.equal(drainReport.confirmed, false);
    assert.equal(drainReport.confirmedAt, null);
  });
});
