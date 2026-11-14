import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  companyMemoryUpgrades,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  eq,
} from "./memory-upgrade-sweep-helpers.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import { formatExportTextReport, runExport } from "../../server/src/services/company-memory-upgrade/export.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("export dry run behavior and report privacy (embedded postgres) (TECH-8573)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("export-dry");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const tenantSql = env.tenantWorkerSql;
  const company = env.company;
  const agent = env.agent;

  let upgrade: any;
  const SENTINEL_MEMORY_TEXT = "SECRET_SENTINEL_MEMORY_DO_NOT_LEAK_IN_REPORT_12345";

  t.beforeEach(async () => {
    await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_staging;`);
    await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_ledger;`);
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, company.id));

    [upgrade] = await cpDb.insert(companyMemoryUpgrades).values({
      companyId: company.id,
      state: "sweeping",
      converterId: "test-converter",
      converterVersion: 2,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    }).returning();
  });

  async function seed(outputId: string, text: string, confidence = 0.98) {
    const sId = randomUUID();
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids)
       VALUES ($1, $2, 'hash', $3, 'published', $4);`,
      [upgrade.id, sId, agent.id, [outputId]],
    );
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256)
       VALUES ($1, $2, $3, $4, $5, 'vec', 'sha');`,
      [upgrade.id, sId, outputId, agent.id, {
        data: text,
        user_id: agent.id,
        type: "preference",
        subject: "sentinel subject",
        confidence,
        created_at: "2026-11-13T10:00:00.000Z",
      }],
    );
  }

  await t.test("dry run writes no files, makes no DB changes, and leaks no memory text", async () => {
    await seed("00000000-0000-4000-8000-000000000010", SENTINEL_MEMORY_TEXT);

    const sBefore = (await tenantSql`SELECT count(*)::int as c FROM paperclip_memory_upgrade_staging`)[0].c;
    const lBefore = (await tenantSql`SELECT count(*)::int as c FROM paperclip_memory_upgrade_ledger`)[0].c;

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-dry-"));
    t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

    const report = await runExport({
      companyId: company.id,
      agentId: agent.id,
      outputDir: outDir,
      tenantDatabaseUrl: env.tenantUrl,
      controlPlaneDatabaseUrl: env.cpUrl,
    }, { cpDb, tenantSql });

    assert.equal(report.isDryRun, true);
    assert.equal(report.recordCount, 1);
    assert.equal(report.jsonlPath, null);
    assert.equal(fs.readdirSync(outDir).length, 0);

    const sAfter = (await tenantSql`SELECT count(*)::int as c FROM paperclip_memory_upgrade_staging`)[0].c;
    const lAfter = (await tenantSql`SELECT count(*)::int as c FROM paperclip_memory_upgrade_ledger`)[0].c;
    assert.equal(sAfter, sBefore);
    assert.equal(lAfter, lBefore);

    const textReport = formatExportTextReport(report);
    assert.equal(textReport.includes(SENTINEL_MEMORY_TEXT), false);
    assert.equal(JSON.stringify(report).includes(SENTINEL_MEMORY_TEXT), false);
  });

  await t.test("dry run fails closed with same counts on contract violations", async () => {
    await seed("00000000-0000-4000-8000-000000000010", "Valid text", 1.5);
    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.message.includes("confidence_invalid: 1"),
    );
  });
});
