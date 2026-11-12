/**
 * Database clock authority and lease expiry regressions (TECH-8191 Finding 2).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runVerify } from "../../server/src/services/company-memory-upgrade/verify.js";
import { claimUpgradeLease } from "../../server/src/services/company-memory-upgrade/state-machine.js";
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

test("verify database clock authority regressions", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("v-clock");
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
      drainConfirmedAt: new Date(t0.getTime() - 10 * 60_000),
    })
    .returning();

  const resetUpgrade = async () => {
    await env.cpDb
      .update(companyMemoryDatabases)
      .set({
        scopeMigrationCompletedAt: markedAt,
        scopeMigrationMode: "copy",
        scopeMigrationAgentScopeObservedAt: observedAt,
      })
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({
        state: "draining",
        markedAt,
        drainConfirmedAt: new Date(t0.getTime() - 10 * 60_000),
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        verifiedAt: null,
      })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
  };

  // 1. Skewed host clock cannot steal valid lease
  await t.test("host clock skew cannot steal valid lease held by another worker", async () => {
    await resetUpgrade();

    // Another worker holds a valid lease according to DB clock
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades
          SET lease_token = 'other_worker_token',
              lease_owner = 'other_worker',
              lease_expires_at = clock_timestamp() + interval '5 minutes'
          WHERE id = ${upgrade.id}`,
    );

    await assert.rejects(
      () =>
        runVerify(
          {
            companyId: env.company.id,
            confirm: env.company.id,
            tenantDatabaseUrl: "postgres://unused",
            controlPlaneDatabaseUrl: "postgres://unused",
          },
          {
            cpDb: env.cpWorkerDb,
            tenantSql: env.tenantWorkerSql,
            _internalSkipVectorIdentityCheck: true,
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "LEASE_FENCED_OUT",
    );

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.leaseToken, "other_worker_token");
    assert.equal(row.state, "draining");
    assert.equal(row.verifiedAt, null);
  });

  // 2. Cannot transition using expired lease
  await t.test("transition using expired lease fails closed via DB clock", async () => {
    await resetUpgrade();

    await assert.rejects(
      () =>
        runVerify(
          {
            companyId: env.company.id,
            confirm: env.company.id,
            tenantDatabaseUrl: "postgres://unused",
            controlPlaneDatabaseUrl: "postgres://unused",
          },
          {
            cpDb: env.cpWorkerDb,
            tenantSql: env.tenantWorkerSql,
            _internalSkipVectorIdentityCheck: true,
            _internalPostClaimHook: async () => {
              // Expire lease by DB clock before advanceState runs
              await env.cpDb.execute(
                sql`UPDATE company_memory_upgrades
                    SET lease_expires_at = clock_timestamp() - interval '1 second'
                    WHERE id = ${upgrade.id}`,
              );
            },
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "LEASE_EXPIRED",
    );

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "draining");
    assert.equal(row.verifiedAt, null);
  });

  // 3. Cannot backdate verified_at: verified_at is derived strictly from DB clock_timestamp
  await t.test("verified_at is derived strictly from DB clock_timestamp", async () => {
    await resetUpgrade();

    const rep = await runVerify(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    assert.equal(rep.state, "verified");
    assert.ok(rep.verifiedAt instanceof Date);

    const [dbNowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
    const dbNow = dbNowRow.t instanceof Date ? dbNowRow.t : new Date(dbNowRow.t);

    const skewMs = Math.abs(rep.verifiedAt.getTime() - dbNow.getTime());
    assert.ok(skewMs < 5_000, `Expected verified_at within 5s of DB clock, got ${skewMs}ms`);

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "verified");
    assert.ok(row.verifiedAt instanceof Date);
    const rowSkewMs = Math.abs(row.verifiedAt.getTime() - dbNow.getTime());
    assert.ok(rowSkewMs < 5_000, `Expected row verified_at within 5s of DB clock, got ${rowSkewMs}ms`);
  });
});
