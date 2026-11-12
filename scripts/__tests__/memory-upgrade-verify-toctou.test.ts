/**
 * TOCTOU under-lease revalidation regressions (TECH-8191 Finding 1).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runVerify } from "../../server/src/services/company-memory-upgrade/verify.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("verify TOCTOU and under-lease revalidation regressions", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("v-toctou");
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

  // 1. Catch-up work between preliminary probe and claim invalidates confirmation
  await t.test("catch-up work between probe and claim clears confirmation -> verify refuses", async () => {
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
            _internalPreClaimHook: async () => {
              // Real-DB catch-up sweep/publish claims fence and clears confirmation
              await env.cpDb
                .update(companyMemoryUpgrades)
                .set({
                  drainConfirmedAt: null,
                  drainProbeStreakStartedAt: null,
                })
                .where(eq(companyMemoryUpgrades.id, upgrade.id));
            },
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "DRAIN_NOT_CONFIRMED" &&
        err.message.includes("drain has not been confirmed"),
    );

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "draining");
    assert.equal(row.verifiedAt, null);
    assert.equal(row.leaseToken, null);
  });

  // 2. Evidence changed in marker under claim
  await t.test("marker mode changed under claim -> verify refuses and fails closed", async () => {
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
              await env.cpDb
                .update(companyMemoryDatabases)
                .set({ scopeMigrationMode: "direct" })
                .where(eq(companyMemoryDatabases.companyId, env.company.id));
            },
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        (err.code === "FLIP_MARKER_MISSING" || err.code === "VERIFICATION_FAILED"),
    );

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "draining");
    assert.equal(row.verifiedAt, null);
    assert.equal(row.leaseToken, null);
  });

  // 3. Evidence changed in confirmation timestamp under claim
  await t.test("drain_confirmed_at changed under claim -> verify refuses and fails closed", async () => {
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
              await env.cpDb
                .update(companyMemoryUpgrades)
                .set({ drainConfirmedAt: new Date(t0.getTime() - 1000) })
                .where(eq(companyMemoryUpgrades.id, upgrade.id));
            },
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "VERIFICATION_FAILED" &&
        err.message.includes("drain confirmation changed between probe and claim"),
    );

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "draining");
    assert.equal(row.verifiedAt, null);
    assert.equal(row.leaseToken, null);
  });

  // 4. Fresh preflip blocker appears under claim
  await t.test("fresh pre-flip blocking run appears under claim -> verify refuses", async () => {
    await resetUpgrade();

    let freshRunId: string | null = null;
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
              const [r] = await env.cpDb
                .insert(heartbeatRuns)
                .values({
                  companyId: env.company.id,
                  agentId: env.agent.id,
                  status: "running",
                  startedAt: new Date(markedAt.getTime() - 10_000),
                  createdAt: new Date(markedAt.getTime() - 20_000),
                })
                .returning();
              freshRunId = r.id;
            },
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "VERIFICATION_FAILED" &&
        err.message.includes("active pre-flip heartbeat runs are still running") &&
        err.message.includes(freshRunId!),
    );

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "draining");
    assert.equal(row.verifiedAt, null);
    assert.equal(row.leaseToken, null);
  });
});
