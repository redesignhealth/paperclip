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
import { runExport } from "../../server/src/services/company-memory-upgrade/export.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("export path refusal rules and collision guard (embedded postgres) (TECH-8573)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("export-paths");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const tenantSql = env.tenantWorkerSql;
  const company = env.company;
  const agent = env.agent;

  let upgrade: any;

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

  async function seedMemory() {
    const sourceId = randomUUID();
    const outputId = randomUUID();
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids)
       VALUES ($1, $2, 'hash', $3, 'published', $4);`,
      [upgrade.id, sourceId, agent.id, [outputId]],
    );
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256)
       VALUES ($1, $2, $3, $4, $5, 'vec', 'sha');`,
      [upgrade.id, sourceId, outputId, agent.id, {
        data: "Sample text",
        user_id: agent.id,
        type: "preference",
        confidence: 0.9,
      }],
    );
  }

  await t.test("refuses existing files, in-repo path, symlink parent, and missing parent", async () => {
    await seedMemory();

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-err-"));
    t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

    // 1. Refuses existing file (EEXIST)
    const existingFile = path.join(outDir, `export-${agent.id}.jsonl`);
    fs.writeFileSync(existingFile, "preexisting");
    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        confirm: company.id,
        outputDir: outDir,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => err.code === "EEXIST",
    );
    fs.unlinkSync(existingFile);

    // 2. Refuses inside repo
    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        confirm: company.id,
        outputDir: path.join(process.cwd(), "scripts"),
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "OUTPUT_PATH_REJECTED",
    );

    // 3. Refuses missing parent directory
    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        confirm: company.id,
        outputDir: path.join(outDir, "nonexistent-sub", "dir"),
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "OUTPUT_PATH_REJECTED",
    );

    // 4. Refuses symlinked parent pointing into repo
    const symlinkDir = path.join(outDir, "symlink-to-repo");
    fs.symlinkSync(process.cwd(), symlinkDir);
    await assert.rejects(
      () => runExport({
        companyId: company.id,
        agentId: agent.id,
        confirm: company.id,
        outputDir: symlinkDir,
        tenantDatabaseUrl: env.tenantUrl,
        controlPlaneDatabaseUrl: env.cpUrl,
      }, { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "OUTPUT_PATH_REJECTED",
    );
  });
});
