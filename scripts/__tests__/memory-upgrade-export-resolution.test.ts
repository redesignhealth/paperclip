import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  companyMemoryUpgrades,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  eq,
} from "./memory-upgrade-sweep-helpers.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import { runExport } from "../../server/src/services/company-memory-upgrade/export.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { sanitizeCliErrorMessage } from "../memory-upgrade.js";

test("export upgrade resolution zero/one/many (embedded postgres) (TECH-8573)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("export-res");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const tenantSql = env.tenantWorkerSql;
  const company = env.company;
  const agent = env.agent;

  t.beforeEach(async () => {
    await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_staging;`);
    await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_ledger;`);
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, company.id));
  });

  await t.test("zero upgrades throws UPGRADE_NOT_FOUND", async () => {
    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UPGRADE_NOT_FOUND",
    );
  });

  await t.test("single upgrade resolves cleanly without --upgrade-id", async () => {
    const [upgrade] = await cpDb.insert(companyMemoryUpgrades).values({
      companyId: company.id,
      state: "sweeping",
      converterId: "test-conv",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    }).returning();

    const report = await runExport({
      companyId: company.id,
      agentId: agent.id,
      tenantDatabaseUrl: env.tenantUrl,
      controlPlaneDatabaseUrl: env.cpUrl,
    }, { cpDb, tenantSql });

    assert.equal(report.upgradeId, upgrade.id);
  });

  await t.test("multiple upgrades without --upgrade-id throws AMBIGUOUS_UPGRADE with candidate list", async () => {
    const [u1] = await cpDb.insert(companyMemoryUpgrades).values({
      companyId: company.id,
      state: "completed",
      converterId: "test-conv",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      createdAt: new Date("2026-11-10T12:00:00Z"),
    }).returning();

    const [u2] = await cpDb.insert(companyMemoryUpgrades).values({
      companyId: company.id,
      state: "sweeping",
      converterId: "test-conv",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      createdAt: new Date("2026-11-12T12:00:00Z"),
    }).returning();

    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "AMBIGUOUS_UPGRADE");
        assert.ok(err.message.includes("Multiple upgrade records exist for company (2 candidates:"));
        assert.ok(err.message.includes(u1.id));
        assert.ok(err.message.includes(u2.id));
        const sanitized = sanitizeCliErrorMessage(err);
        assert.ok(sanitized.includes("[AMBIGUOUS_UPGRADE] Multiple upgrade records exist for company"));
        return true;
      },
    );

    // Supplying --upgrade-id explicitly succeeds
    const report = await runExport({
      companyId: company.id,
      agentId: agent.id,
      upgradeId: u2.id,
      tenantDatabaseUrl: env.tenantUrl,
      controlPlaneDatabaseUrl: env.cpUrl,
    }, { cpDb, tenantSql });

    assert.equal(report.upgradeId, u2.id);
  });
});
