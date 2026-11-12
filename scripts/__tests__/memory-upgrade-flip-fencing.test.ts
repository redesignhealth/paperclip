/**
 * Flip orchestrator lease fencing and resource cleanup tests
 * (TECH-8191 review findings 1 and 3).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createDb,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";
import { runFlip } from "../../server/src/services/company-memory-upgrade/flip.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("flip orchestrator lease fencing and resource leak safety (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("flip-fencing");
  t.after(async () => {
    await env.cleanup();
  });

  // 1. Regression for finding 1: simulate lease taken over between E and F
  await t.test("finding 1: lease takeover between E (flipping) and F (marker) throws LEASE_FENCED_OUT and leaves marker NULL", async () => {
    const [active] = await env.cpDb
      .insert(companyMemoryUpgrades)
      .values({
        companyId: env.company.id,
        state: "sweeping",
        converterId: "paperclip.memory-upgrade.atomic-converter",
        converterVersion: 1,
        collectionName: "mem0_memories",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
      })
      .returning();

    await assert.rejects(
      () =>
        runFlip(
          {
            companyId: env.company.id,
            confirm: env.company.id,
            controlPlaneDatabaseUrl: "postgres://unused",
            tenantDatabaseUrl: "postgres://unused",
            ackAgentScopeFlag: true,
          },
          {
            cpDb: env.cpWorkerDb,
            tenantSql: env.tenantWorkerSql,
            _internalSkipVectorIdentityCheck: true,
            _internalStepHook: async (step) => {
              if (step === "E") {
                // Another actor takes the lease after transition to flipping
                await env.cpDb
                  .update(companyMemoryUpgrades)
                  .set({
                    leaseToken: "rogue-worker-stole-lease",
                    leaseExpiresAt: new Date(Date.now() + 120_000),
                  })
                  .where(eq(companyMemoryUpgrades.id, active.id));
              }
            },
          },
        ),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
    );

    // Verify ZERO marker writes: scope_migration_completed_at is still NULL
    const [dbRow] = await env.cpDb
      .select({
        completedAt: companyMemoryDatabases.scopeMigrationCompletedAt,
        mode: companyMemoryDatabases.scopeMigrationMode,
      })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));

    assert.equal(dbRow.completedAt, null, "scope_migration_completed_at must remain NULL after fenced rejection");
    assert.equal(dbRow.mode, null, "scope_migration_mode must remain NULL after fenced rejection");

    // Clean up upgrade row
    await env.cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, active.id));
  });

  // 2. Finding 3: tenant client construction failure after CP pool is created does not leak
  await t.test("finding 3: tenant client construction failure closes owned CP pool", async () => {
    let endCalled = false;
    const wrappedCreateDb = (url: string, opts?: any) => {
      const db = createDb(url, opts);
      const origEnd = db.$client.end.bind(db.$client);
      db.$client.end = async (...args: any[]) => {
        endCalled = true;
        return await origEnd(...args);
      };
      return db;
    };

    await assert.rejects(
      () =>
        runFlip(
          {
            companyId: env.company.id,
            confirm: env.company.id,
            controlPlaneDatabaseUrl: env.cpUrl,
            tenantDatabaseUrl: "postgres://user:pass@127.0.0.1:1/nonexistent",
            ackAgentScopeFlag: true,
          },
          {
            _internalSkipVectorIdentityCheck: true,
            _internalCreateCpDb: wrappedCreateDb,
            _internalOpenTenantClient: () => {
              throw new Error("Simulated tenant client construction failure");
            },
          },
        ),
      /Simulated tenant client construction failure/,
    );

    assert.equal(endCalled, true, "Owned CP client $client.end() must be called when tenant client fails");
  });
});
