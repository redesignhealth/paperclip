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

test("export importer contract boundary enforcement (embedded postgres) (TECH-8573)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("export-ic");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const tenantSql = env.tenantWorkerSql;
  const company = env.company;
  const agent = env.agent;

  let upgrade: any;

  t.beforeEach(async () => {
    await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_staging; DELETE FROM paperclip_memory_upgrade_ledger;`);
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, company.id));

    [upgrade] = await cpDb.insert(companyMemoryUpgrades).values({
      companyId: company.id, state: "sweeping", converterId: "conv", converterVersion: 1,
      collectionName: "mem0_memories", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536,
    }).returning();
  });

  async function seed(payload: any) {
    const sId = randomUUID(), oId = randomUUID();
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids) VALUES ($1, $2, 'h', $3, 'published', $4);`,
      [upgrade.id, sId, agent.id, [oId]],
    );
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at) VALUES ($1, $2, $3, $4, $5, 'v', 's', NULL);`,
      [upgrade.id, sId, oId, agent.id, payload],
    );
  }

  const exportParams = () => ({
    companyId: company.id, agentId: agent.id, tenantDatabaseUrl: env.tenantUrl, controlPlaneDatabaseUrl: env.cpUrl,
  });

  await t.test("text boundary: 2000 chars ok, 2001 chars rejected", async () => {
    await seed({ data: "a".repeat(2000), user_id: agent.id, confidence: 0.9 });
    const ok = await runExport(exportParams(), { cpDb, tenantSql });
    assert.equal(ok.recordCount, 1);

    await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_staging;`);
    await seed({ data: "a".repeat(2001), user_id: agent.id, confidence: 0.9 });
    await assert.rejects(
      () => runExport(exportParams(), { cpDb, tenantSql }),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError && err.code === "IMPORTER_CONTRACT_VIOLATION");
        assert.ok(err.message.includes("text_too_long: 1"));
        assert.ok(sanitizeCliErrorMessage(err).includes("[IMPORTER_CONTRACT_VIOLATION]"));
        return true;
      },
    );
  });

  await t.test("confidence boundary: finite [0, 1] ok, rejects -0.01, 1.01, NaN, true, string", async () => {
    for (const bad of [-0.01, 1.01, NaN, true, "0.5"]) {
      await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_staging;`);
      await seed({ data: "Valid text", user_id: agent.id, confidence: bad });
      await assert.rejects(
        () => runExport(exportParams(), { cpDb, tenantSql }),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "IMPORTER_CONTRACT_VIOLATION",
      );
    }
  });

  await t.test("created_at boundary: UTC ISO ok, null ok, naive timestamp rejected", async () => {
    await seed({ data: "Valid text", user_id: agent.id, confidence: 0.5, created_at: "2026-11-13T10:00:00" });
    await assert.rejects(
      () => runExport(exportParams(), { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.message.includes("created_at_invalid: 1"),
    );

    await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_staging;`);
    await seed({ data: "Valid text", user_id: agent.id, confidence: 0.5, created_at: "2026-11-13T10:00:00.000Z" });
    const ok = await runExport(exportParams(), { cpDb, tenantSql });
    assert.equal(ok.recordCount, 1);
  });

  await t.test("type and subject boundary: 200 chars ok, 201 chars rejected", async () => {
    await seed({
      data: "Valid text",
      user_id: agent.id,
      confidence: 0.5,
      type: "t".repeat(201),
      subject: "s".repeat(201),
    });
    await assert.rejects(
      () => runExport(exportParams(), { cpDb, tenantSql }),
      (err: any) => err.message.includes("type_invalid: 1") && err.message.includes("subject_invalid: 1"),
    );
  });
});
