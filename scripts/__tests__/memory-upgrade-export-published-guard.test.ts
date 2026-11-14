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

test("export published-guard and re-swept generation accuracy (embedded postgres) (TECH-8573)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("export-pubg");
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

  const exportParams = () => ({
    companyId: company.id, agentId: agent.id, tenantDatabaseUrl: env.tenantUrl, controlPlaneDatabaseUrl: env.cpUrl,
  });

  await t.test("published_at NOT NULL fails closed with EXPORT_UPGRADE_ALREADY_PUBLISHED", async () => {
    const sId = randomUUID(), oId = randomUUID();
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids) VALUES ($1, $2, 'h', $3, 'published', $4);`,
      [upgrade.id, sId, agent.id, [oId]],
    );
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at) VALUES ($1, $2, $3, $4, $5, 'v', 's', now());`,
      [upgrade.id, sId, oId, agent.id, { data: "Published fact", user_id: agent.id, confidence: 0.9 }],
    );

    await assert.rejects(
      () => runExport(exportParams(), { cpDb, tenantSql }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "EXPORT_UPGRADE_ALREADY_PUBLISHED" && sanitizeCliErrorMessage(err).includes("[EXPORT_UPGRADE_ALREADY_PUBLISHED]"),
    );
  });

  await t.test("content-changed re-swept source exports current generation without stale outputs", async () => {
    const sId = randomUUID(), cId = randomUUID();
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids) VALUES ($1, $2, 'new', $3, 'published', $4);`,
      [upgrade.id, sId, agent.id, [cId]],
    );
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256) VALUES ($1, $2, $3, $4, $5, 'v', 's');`,
      [upgrade.id, sId, cId, agent.id, { data: "Current fact", user_id: agent.id, confidence: 0.95 }],
    );

    const report = await runExport(exportParams(), { cpDb, tenantSql });
    assert.equal(report.recordCount, 1);
  });

  await t.test("superseded and deduplicated ledger outcomes are excluded", async () => {
    const s1 = randomUUID(), o1 = randomUUID();
    const s2 = randomUUID(), s3 = randomUUID(), o3 = randomUUID();

    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids) VALUES ($1, $2, 'h1', $4, 'superseded', $5), ($1, $3, 'h2', $4, 'deduplicated', '{}'), ($1, $6, 'h3', $4, 'published', $7);`,
      [upgrade.id, s1, s2, agent.id, [o1], s3, [o3]],
    );
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256) VALUES ($1, $2, $3, $4, $5, 'v', 's'), ($1, $6, $7, $4, $8, 'v', 's');`,
      [upgrade.id, s1, o1, agent.id, { data: "Superseded", user_id: agent.id, confidence: 0.9 }, s3, o3, { data: "Published", user_id: agent.id, confidence: 0.9 }],
    );

    const report = await runExport(exportParams(), { cpDb, tenantSql });
    assert.equal(report.recordCount, 1);
    assert.equal(report.skippedCountsByOutcome.superseded, 1);
    assert.equal(report.skippedCountsByOutcome.deduplicated, 1);
  });
});
