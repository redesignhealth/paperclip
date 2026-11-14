import assert from "node:assert/strict";
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

test("export preconditions and lifecycle states (embedded postgres) (TECH-8573)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("export-prec");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const tenantSql = env.tenantWorkerSql;
  const company = env.company;
  const agent = env.agent;

  async function createUpgrade(state = "sweeping") {
    const [row] = await cpDb.insert(companyMemoryUpgrades).values({
      companyId: company.id,
      state,
      converterId: "test-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    }).returning();
    return row;
  }

  await t.test("missing tables refused with allowlisted message", async () => {
    const upgrade = await createUpgrade();
    await tenantSql.unsafe(`DROP TABLE IF EXISTS paperclip_memory_upgrade_staging CASCADE;`);

    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "UPGRADE_TABLES_MISSING");
        assert.equal(
          sanitizeCliErrorMessage(err),
          "[UPGRADE_TABLES_MISSING] Upgrade staging or ledger table does not exist in target database. Run 'pnpm memory:upgrade sweep' first.",
        );
        return true;
      },
    );

    const { ensureUpgradeTables } = await import("../../server/src/services/company-memory-upgrade/sweep-tenant.js");
    await ensureUpgradeTables(tenantSql, "text");
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });

  await t.test("needs_recovery state refused with allowlisted message verbatim", async () => {
    const upgrade = await createUpgrade("needs_recovery");
    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "STATE_MISMATCH");
        assert.equal(
          sanitizeCliErrorMessage(err),
          "[STATE_MISMATCH] Upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' first.",
        );
        return true;
      },
    );
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });

  await t.test("aborted state refused with allowlisted message", async () => {
    const upgrade = await createUpgrade("aborted");
    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "STATE_MISMATCH");
        assert.equal(
          sanitizeCliErrorMessage(err),
          "[STATE_MISMATCH] Cannot run export: active upgrade is in aborted state.",
        );
        return true;
      },
    );
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });
});
