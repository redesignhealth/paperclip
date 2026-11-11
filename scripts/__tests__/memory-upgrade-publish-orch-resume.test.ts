/**
 * Orchestrator resume and maxRows source-granularity tests (TECH-8191 PR 4b).
 * Tests 29 & 30 from plan §7.5.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
} from "./memory-upgrade-sweep-helpers.js";
import { runPublish } from "../../server/src/services/company-memory-upgrade/publish.js";
import {
  seedLedgerRow,
  seedStagedMemory,
  setupPublishTestEnvironment,
} from "./memory-upgrade-publish-helpers.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";

test("publish orchestrator: resume and max-rows source granularity", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-resume");
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
      publishedCount: 0,
    })
    .returning();

  // Test 30: 3 sources x 2 records each, maxRows: 3 -> publishes exactly 2 rows (1 source)
  const sIds = [randomUUID(), randomUUID(), randomUUID()].sort();
  for (let i = 0; i < sIds.length; i++) {
    const sId = sIds[i];
    const text = `Memory source content ${i}`;
    const sha = computeSourceContentSha256(text);
    await insertTenantMemoryRow(env.tenantSql, { id: sId, agentId: env.agent.id, data: text });

    const r1 = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: sId, agentId: env.agent.id });
    const r2 = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: sId, agentId: env.agent.id });
    await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId: sId, agentId: env.agent.id, outcome: "published", outputIds: [r1.outputId, r2.outputId], sourceContentSha256: sha });
  }

  // First run with maxRows: 3 (bounds at source granularity)
  const rep1 = await runPublish(
    { companyId: env.company.id, confirm: env.company.id, maxRows: 3 },
    { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
  );

  // Exactly 2 rows published (never split source), <= 3
  assert.equal(rep1.counts.publishedCount, 2);
  const [upg1] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  assert.equal(upg1.publishedCount, 2);

  // Test 29: Resume unbounded
  const rep2 = await runPublish(
    { companyId: env.company.id, confirm: env.company.id },
    { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
  );

  // Remaining 4 rows published
  assert.equal(rep2.counts.publishedCount, 4);

  const [upg2] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  assert.equal(upg2.publishedCount, 6);

  // Assert exactly 6 live rows created (no duplicates)
  const [{ count }] = (await env.tenantSql.unsafe("SELECT count(*)::int as count FROM mem0_memories")) as any[];
  assert.equal(count, 3 + 6); // 3 original live sources + 6 published records
});
