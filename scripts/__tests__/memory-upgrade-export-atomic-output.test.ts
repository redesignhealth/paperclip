import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

test("export atomic output and schema (embedded postgres) (TECH-8573)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("export-atom");
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
      companyId: company.id, state: "sweeping", converterId: "conv", converterVersion: 2,
      collectionName: "mem0_memories", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536,
    }).returning();
  });

  async function seed(outputId: string, text: string) {
    const sId = randomUUID();
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids) VALUES ($1, $2, 'h', $3, 'published', $4);`,
      [upgrade.id, sId, agent.id, [outputId]],
    );
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256) VALUES ($1, $2, $3, $4, $5, 'v', 's');`,
      [upgrade.id, sId, outputId, agent.id, {
        data: text, user_id: agent.id, type: "preference", subject: "s", confidence: 0.98, created_at: "2026-11-13T10:00:00Z",
      }],
    );
  }

  await t.test("manifest write failure unlinks temp files and leaves no files", async () => {
    await seed("00000000-0000-4000-8000-000000000010", "Test text");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-fail-"));
    t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

    await assert.rejects(
      () => runExport({
        companyId: company.id, agentId: agent.id, confirm: company.id, outputDir: outDir,
        tenantDatabaseUrl: env.tenantUrl, controlPlaneDatabaseUrl: env.cpUrl,
      }, {
        cpDb, tenantSql,
        _internalManifestWriteFailureHook: () => { throw new Error("Simulated manifest write crash"); },
      }),
      (err: any) => err.message === "Simulated manifest write crash",
    );

    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  await t.test("confirmed run writes mode 0600 files, exact line schema, matching sha256", async () => {
    const idB = "00000000-0000-4000-8000-000000000020";
    const idA = "00000000-0000-4000-8000-000000000010";
    await seed(idB, "Second fact");
    await seed(idA, "First fact");

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-conf-"));
    t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

    const report = await runExport({
      companyId: company.id, agentId: agent.id, confirm: company.id, outputDir: outDir,
      tenantDatabaseUrl: env.tenantUrl, controlPlaneDatabaseUrl: env.cpUrl,
    }, { cpDb, tenantSql });

    assert.equal(report.isDryRun, false);
    assert.equal(report.recordCount, 2);

    const jp = path.join(outDir, `export-${agent.id}.jsonl`);
    const mp = path.join(outDir, `export-${agent.id}.manifest.json`);

    assert.equal(fs.statSync(jp).mode & 0o777, 0o600);
    assert.equal(fs.statSync(mp).mode & 0o777, 0o600);

    const jBytes = fs.readFileSync(jp);
    const computedSha = createHash("sha256").update(jBytes).digest("hex");
    assert.equal(report.jsonlSha256, computedSha);

    const lines = jBytes.toString("utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].import_key, idA);
    assert.equal(lines[1].import_key, idB);

    assert.deepEqual(Object.keys(lines[0]), [
      "import_key", "company_id", "agent_id", "text", "created_at",
      "type", "subject", "confidence", "migrated_from", "migration_id",
      "converter_id", "converter_version",
    ]);

    const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
    assert.equal(manifest.format_version, 1);
    assert.equal(manifest.record_count, 2);
    assert.equal(manifest.jsonl_sha256, computedSha);
    assert.equal(manifest.tool, "paperclip memory:upgrade export");
  });
});
