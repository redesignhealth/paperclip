import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  companyMemoryUpgrades,
  agents,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  eq,
} from "./memory-upgrade-sweep-helpers.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import { runExport } from "../../server/src/services/company-memory-upgrade/export.js";

test("export selection filtering and outcome exclusion (embedded postgres) (TECH-8573)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("export-sel");
  t.after(async () => { await env.cleanup(); });

  const cpDb = env.cpWorkerDb;
  const tenantSql = env.tenantWorkerSql;
  const company = env.company;
  const agent = env.agent;

  const [otherAgent] = await cpDb.insert(agents).values({
    companyId: company.id,
    name: "Other Hermes Agent",
    adapterType: "hermes_local",
    status: "active",
  }).returning();

  let upgrade: any;

  t.beforeEach(async () => {
    await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_staging;`);
    await tenantSql.unsafe(`DELETE FROM paperclip_memory_upgrade_ledger;`);
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, company.id));

    [upgrade] = await cpDb.insert(companyMemoryUpgrades).values({
      companyId: company.id,
      state: "sweeping",
      converterId: "test-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    }).returning();
  });

  async function insertStagingAndLedger(params: {
    sourceId?: string;
    outputId?: string;
    agentId?: string;
    outcome?: string;
    payload?: any;
    publishedAt?: Date | null;
  }) {
    const sourceId = params.sourceId ?? randomUUID();
    const outputId = params.outputId ?? randomUUID();
    const agentId = params.agentId ?? agent.id;
    const outcome = params.outcome ?? "published";
    const payload = params.payload ?? {
      data: "Valid substantive fact",
      user_id: agentId,
      type: "fact",
      subject: "test preference",
      confidence: 0.9,
      created_at: new Date().toISOString(),
    };

    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids)
       VALUES ($1, $2, 'mockhash', $3, $4, $5);`,
      [upgrade.id, sourceId, agentId, outcome, outcome === "published" ? [outputId] : []],
    );

    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at)
       VALUES ($1, $2, $3, $4, $5, 'mockvec', 'mocksha', $6);`,
      [upgrade.id, sourceId, outputId, agentId, payload, params.publishedAt ?? null],
    );

    return { sourceId, outputId };
  }

  await t.test("exports only published rows for named agent and excludes other agents", async () => {
    // 2 published rows for target agent (both with published_at null)
    await insertStagingAndLedger({ agentId: agent.id, outcome: "published", publishedAt: null });
    await insertStagingAndLedger({ agentId: agent.id, outcome: "published", publishedAt: null });

    // 1 published row for other agent -> must be excluded
    await insertStagingAndLedger({ agentId: otherAgent.id, outcome: "published" });

    // Staging rows exist for quarantined, dropped_noise, dropped_sensitive, unroutable -> must NOT be exported
    await insertStagingAndLedger({ agentId: agent.id, outcome: "quarantined" });
    await insertStagingAndLedger({ agentId: agent.id, outcome: "dropped_noise" });
    await insertStagingAndLedger({ agentId: agent.id, outcome: "dropped_sensitive" });
    await insertStagingAndLedger({ agentId: agent.id, outcome: "unroutable" });

    const report = await runExport({
      companyId: company.id,
      agentId: agent.id,
      tenantDatabaseUrl: env.tenantUrl,
      controlPlaneDatabaseUrl: env.cpUrl,
    }, { cpDb, tenantSql });

    assert.equal(report.recordCount, 2);
    assert.equal(report.skippedCountsByOutcome.quarantined, 1);
    assert.equal(report.skippedCountsByOutcome.dropped_noise, 1);
    assert.equal(report.skippedCountsByOutcome.dropped_sensitive, 1);
    assert.equal(report.skippedCountsByOutcome.unroutable, 1);
  });
});
