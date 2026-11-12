/**
 * Lease release retry, persistent failure surfacing, and client closure invariants (TECH-8191 Finding 3).
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
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("verify cleanup and lease release resilience", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("v-cleanup");
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

  // 1. Release fails once => retry succeeds, token cleared, verify succeeds
  await t.test("release fails once => retry succeeds and lease token is cleared", async () => {
    await resetUpgrade();

    let attemptsSeen = 0;
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
        _internalReleaseHook: async (attempt: number) => {
          attemptsSeen++;
          if (attempt === 0) {
            throw new Error("transient network drop on first release attempt");
          }
        },
      },
    );

    assert.equal(attemptsSeen, 2, "Expected initial release attempt + 1 retry");
    assert.equal(rep.state, "verified");

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "verified");
    assert.equal(row.leaseToken, null, "Lease token must be cleared after retry succeeds");
  });

  // 2. Persistent release failure must be surfaced, not silently reported as success
  await t.test("persistent release failure is surfaced and does not return success report", async () => {
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
            _internalReleaseHook: async () => {
              throw new Error("persistent database outage on release");
            },
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.message.includes("Failed to release upgrade lease after verify"),
    );

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    // The lease is leaked because release failed persistently, so token is still present on DB
    assert.ok(typeof row.leaseToken === "string" && row.leaseToken.length > 0);
  });

  // 3. Primary error preserved if cleanup also fails
  await t.test("primary error preserved when cleanup release also fails", async () => {
    await resetUpgrade();

    // Cause a gate failure under claim (e.g. marker mode changed)
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
                .set({ scopeMigrationMode: "invalid_mode" })
                .where(eq(companyMemoryDatabases.companyId, env.company.id));
            },
            _internalReleaseHook: async () => {
              throw new Error("cleanup release failed as well");
            },
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "FLIP_MARKER_MISSING",
    );
  });

  // 4. Injected clients not closed
  await t.test("injected clients are not closed after runVerify completes", async () => {
    await resetUpgrade();

    await runVerify(
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

    // Injected clients must still be alive and responsive
    const [probe] = (await env.cpWorkerDb.execute(sql`SELECT 1 AS alive`)) as unknown as Array<{ alive: number }>;
    assert.equal(probe.alive, 1);

    const tenantProbe = await env.tenantWorkerSql`SELECT 1 AS alive`;
    assert.equal(tenantProbe[0].alive, 1);
  });
});
