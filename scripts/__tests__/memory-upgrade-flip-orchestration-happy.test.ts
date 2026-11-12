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
import { claimUpgradeLease, CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("flip orchestrator happy path and fencing (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("flip-orch-hp");
  t.after(async () => { await env.cleanup(); });

  await t.test("happy path: advances sweeping -> flipping -> draining and sets marker", async () => {
    const [upgrade] = await env.cpDb
      .insert(companyMemoryUpgrades)
      .values({
        companyId: env.company.id, state: "sweeping",
        converterId: "paperclip.memory-upgrade.atomic-converter", converterVersion: 1, collectionName: "mem0_memories",
        embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536,
      })
      .returning();

    const report = await runFlip(
      { companyId: env.company.id, confirm: env.company.id, ackAgentScopeFlag: true, tenantDatabaseUrl: "p://u", controlPlaneDatabaseUrl: "p://u" },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );

    assert.equal(report.isDryRun, false);
    assert.equal(report.state, "draining");
    assert.equal(report.priorState, "flipping");
    assert.ok(report.markedAt instanceof Date);
    assert.equal(report.alreadySet, false);

    const [updatedUpgrade] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(updatedUpgrade.state, "draining");
    assert.equal(updatedUpgrade.leaseToken, null);

    const [updatedDb] = await env.cpDb.select().from(companyMemoryDatabases).where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.ok(updatedDb.scopeMigrationCompletedAt);
    assert.equal(updatedDb.scopeMigrationMode, "copy");
  });

  await t.test("refuses when another worker holds lease (LEASE_FENCED_OUT)", async () => {
    const [active] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, env.company.id));
    await env.cpDb.update(companyMemoryUpgrades).set({ state: "sweeping", markedAt: null, updatedAt: new Date() }).where(eq(companyMemoryUpgrades.id, active.id));
    await env.cpDb.update(companyMemoryDatabases).set({ scopeMigrationCompletedAt: null, scopeMigrationMode: null, updatedAt: new Date() }).where(eq(companyMemoryDatabases.companyId, env.company.id));

    const claim = await claimUpgradeLease(env.cpDb, { upgradeId: active.id, leaseOwner: "concurrent_sweep_worker", ttlMs: 60000 });
    assert.equal(claim.acquired, true);

    await assert.rejects(
      () => runFlip(
        { companyId: env.company.id, confirm: env.company.id, ackAgentScopeFlag: true, tenantDatabaseUrl: "postgres://unused", controlPlaneDatabaseUrl: "postgres://unused" },
        { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
      ),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
    );
  });

  await t.test("dry run without confirm takes no lease and makes zero mutations", async () => {
    const [active] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, env.company.id));
    await env.cpDb.update(companyMemoryUpgrades).set({ state: "sweeping", leaseToken: null, leaseOwner: null, leaseExpiresAt: null, markedAt: null, updatedAt: new Date() }).where(eq(companyMemoryUpgrades.id, active.id));

    const report = await runFlip(
      { companyId: env.company.id, tenantDatabaseUrl: "postgres://unused", controlPlaneDatabaseUrl: "postgres://unused" },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );

    assert.equal(report.isDryRun, true);
    assert.equal(report.state, "sweeping");
    assert.equal(report.markedAt, null);

    const [after] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, active.id));
    assert.equal(after.state, "sweeping");
    assert.equal(after.leaseToken, null);
  });
});
