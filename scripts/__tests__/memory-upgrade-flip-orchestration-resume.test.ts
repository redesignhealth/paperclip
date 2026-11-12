/**
 * Flip orchestrator crash resumption and idempotent resume tests (TECH-8191 §Q2, PR5.6).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";
import { runFlip } from "../../server/src/services/company-memory-upgrade/flip.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("flip orchestrator crash-resumption (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("flip-orch-res");
  t.after(async () => {
    await env.cleanup();
  });

  const [upgrade] = await env.cpDb
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

  // 1. Crash after advancing to flipping: resumes at marker write
  await t.test("crash after advancing to flipping resumes at marker write", async () => {
    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({ state: "flipping", leaseToken: null, leaseOwner: null, leaseExpiresAt: null, markedAt: null, updatedAt: new Date() })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    await env.cpDb
      .update(companyMemoryDatabases)
      .set({ scopeMigrationCompletedAt: null, scopeMigrationMode: null, updatedAt: new Date() })
      .where(eq(companyMemoryDatabases.companyId, env.company.id));

    const report = await runFlip(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        ackAgentScopeFlag: true,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );

    assert.equal(report.state, "draining");
    assert.ok(report.markedAt);
    assert.equal(report.alreadySet, false);

    const [updated] = await env.cpDb
      .select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(updated.state, "draining");
    assert.equal(updated.leaseToken, null);
  });

  // 2. Crash after marker write: sets marked_at from marker read-back
  await t.test("crash after marker write sets marked_at from marker read-back", async () => {
    const originalFlipTime = new Date("2026-10-15T12:00:00.000Z");
    await env.cpDb
      .update(companyMemoryDatabases)
      .set({ scopeMigrationCompletedAt: originalFlipTime, scopeMigrationMode: "copy", updatedAt: originalFlipTime })
      .where(eq(companyMemoryDatabases.companyId, env.company.id));

    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({ state: "flipping", leaseToken: null, leaseOwner: null, leaseExpiresAt: null, markedAt: null, updatedAt: new Date() })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    const report = await runFlip(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        ackAgentScopeFlag: true,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );

    assert.equal(report.state, "draining");
    assert.equal(report.alreadySet, true);
    assert.equal(report.markedAt?.getTime(), originalFlipTime.getTime());

    const [updated] = await env.cpDb
      .select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(updated.state, "draining");
    assert.equal(updated.markedAt?.getTime(), originalFlipTime.getTime());
    assert.equal(updated.leaseToken, null);
  });
});
