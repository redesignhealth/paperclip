/**
 * Orchestrator counter-flush honesty on batch error (TECH-8191 PR 4b).
 * Test 34 from plan §7.5: committed deltas are preserved, failed deltas never flushed.
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
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";

test("publish orchestrator: counter flush honesty on failure", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-flush");
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

  // Seed two distinct sources
  const src1 = randomUUID();
  const src2 = randomUUID();
  const text1 = "Batch 1 content";
  const text2 = "Batch 2 content";
  await insertTenantMemoryRow(env.tenantSql, { id: src1, agentId: env.agent.id, data: text1 });
  await insertTenantMemoryRow(env.tenantSql, { id: src2, agentId: env.agent.id, data: text2 });

  const r1 = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: src1, agentId: env.agent.id });
  const r2 = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: src2, agentId: env.agent.id });

  await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId: src1, agentId: env.agent.id, outcome: "published", outputIds: [r1.outputId], sourceContentSha256: computeSourceContentSha256(text1) });
  await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId: src2, agentId: env.agent.id, outcome: "published", outputIds: [r2.outputId], sourceContentSha256: computeSourceContentSha256(text2) });

  // Wrap tenantWorkerSql to fail on the second publish batch transaction (call 4)
  let publishBatchCount = 0;
  const originalBegin = env.tenantWorkerSql.begin.bind(env.tenantWorkerSql);
  env.tenantWorkerSql.begin = (async (cb: any) => {
    return await originalBegin(async (tx: any) => {
      publishBatchCount++;
      // Call 1 is ensureUpgradeTables, Call 2 is fence claim, Call 3 is batch 1, Call 4 is batch 2
      if (publishBatchCount === 4) {
        throw new CompanyMemoryUpgradeError("Simulated batch 2 failure", "PUBLISH_FAILED");
      }
      return await cb(tx);
    });
  }) as any;

  await assert.rejects(
    () =>
      runPublish(
        { companyId: env.company.id, confirm: env.company.id, batchSources: 1 },
        { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
      ),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "PUBLISH_FAILED",
  );

  // Assert publishedCount reflects exactly batch 1 (1 row) and lastError is publish_failed
  const [upg] = await env.cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));

  assert.equal(upg.publishedCount, 1);
  assert.equal(upg.lastError, "publish_failed");
});
