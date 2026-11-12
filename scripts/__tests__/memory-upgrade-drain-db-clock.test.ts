/**
 * Regressions proving database clock authority in drain decisions (TECH-8191 §Q3, PR5.7 RC-3).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runDrain } from "../../server/src/services/company-memory-upgrade/drain.js";
import {
  claimUpgradeLease,
  DEFAULT_LEASE_TTL_MS,
} from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("drain db-clock authority regressions (RC-3)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-db-clock");
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

  const skewedFutureClock = {
    now: () => new Date(Date.now() + 2 * 3600_000), // 2 hours fast
  };

  // 1. Skewed host clock does NOT affect written streak start timestamp
  await t.test("host clock fast by 2 hours changes nothing: streak start is written from DB clock", async () => {
    const report = await runDrain(
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
        clock: skewedFutureClock, // ignored by DrainDependencies
        _internalSkipVectorIdentityCheck: true,
      } as any,
    );

    assert.equal(report.confirmed, false);
    assert.ok(report.streakStartedAt instanceof Date);

    const [dbNowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
    const dbNow = dbNowRow.t instanceof Date ? dbNowRow.t : new Date(dbNowRow.t);

    const skewMs = Math.abs(report.streakStartedAt.getTime() - dbNow.getTime());
    assert.ok(skewMs < 5_000, `Expected streak start within 5s of DB clock, got ${skewMs}ms`);
  });

  // 2. No early confirmation across invocations with skewed clock
  await t.test("no early confirmation across invocations with skewed clock", async () => {
    // Back-date streak by only 4 minutes
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '4 minutes', drain_confirmed_at = null WHERE id = ${upgrade.id}`,
    );

    const report = await runDrain(
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
        clock: skewedFutureClock,
        _internalSkipVectorIdentityCheck: true,
      } as any,
    );

    assert.equal(report.confirmed, false);
    assert.equal(report.counts, false);

    const [current] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(current.drainConfirmedAt, null);
  });

  // 3. No lease theft: pre-set lease_token = 'other', lease_expires_at = clock_timestamp() + 5 min
  await t.test("no lease theft: skewed clock cannot steal a live lease", async () => {
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET lease_token = 'other_token', lease_owner = 'other_worker', lease_expires_at = clock_timestamp() + interval '5 minutes' WHERE id = ${upgrade.id}`,
    );

    const report = await runDrain(
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
        clock: skewedFutureClock,
        _internalSkipVectorIdentityCheck: true,
      } as any,
    );

    assert.equal(report.leaseHeldByOther, true);
    assert.equal(report.confirmed, false);

    const [current] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(current.leaseToken, "other_token");
    assert.equal(current.leaseOwner, "other_worker");
  });

  // 4. Deadline is DB-relative: marked_at = clock_timestamp() - 25 h => DRAIN_TIMEOUT regardless of host time
  await t.test("deadline comparison uses DB clock: times out based on DB time", async () => {
    const [backdateRow] = (await env.cpDb.execute(
      sql`SELECT (clock_timestamp() - interval '25 hours') AS t`,
    )) as unknown as Array<{ t: Date | string }>;
    const backdate = backdateRow.t instanceof Date ? backdateRow.t : new Date(backdateRow.t);

    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        markedAt: backdate,
      })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    await env.cpDb
      .update(companyMemoryDatabases)
      .set({
        scopeMigrationCompletedAt: backdate,
      })
      .where(eq(companyMemoryDatabases.companyId, env.company.id));

    // Even with a clock 100 hours in the past
    const skewedPastClock = {
      now: () => new Date(Date.now() - 100 * 3600_000),
    };

    await assert.rejects(
      () =>
        runDrain(
          {
            companyId: env.company.id,
            confirm: env.company.id,
            once: true,
            maxDrainHours: 24,
            tenantDatabaseUrl: "postgres://unused",
            controlPlaneDatabaseUrl: "postgres://unused",
          },
          {
            cpDb: env.cpWorkerDb,
            tenantSql: env.tenantWorkerSql,
            clock: skewedPastClock,
            _internalSkipVectorIdentityCheck: true,
          } as any,
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "DRAIN_TIMEOUT",
    );
  });

  // 5. TTL sanity: after a successful write-claim, lease_expires_at - lease_acquired_at is within a second of DEFAULT_LEASE_TTL_MS
  await t.test("TTL sanity: claimUpgradeLease with DB clock grants DEFAULT_LEASE_TTL_MS", async () => {
    const [dbNowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
    const dbNow = dbNowRow.t instanceof Date ? dbNowRow.t : new Date(dbNowRow.t);

    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET lease_token = null, lease_owner = null, lease_expires_at = null WHERE id = ${upgrade.id}`,
    );

    const claim = await claimUpgradeLease(env.cpDb, {
      upgradeId: upgrade.id,
      leaseOwner: "ttl_sanity_worker",
      now: dbNow,
    });
    assert.ok(claim.acquired);
    assert.ok(claim.leaseExpiresAt);
    assert.ok(claim.leaseAcquiredAt);

    const ttlDelta = claim.leaseExpiresAt.getTime() - claim.leaseAcquiredAt.getTime();
    assert.ok(
      Math.abs(ttlDelta - DEFAULT_LEASE_TTL_MS) <= 1000,
      `Expected TTL delta ~${DEFAULT_LEASE_TTL_MS}, got ${ttlDelta}`,
    );
  });
});
