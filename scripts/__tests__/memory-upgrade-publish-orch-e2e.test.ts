/**
 * Orchestrator E2E publish tests (TECH-8191 PR 4b).
 * Tests 28, 35, 36, 37 from plan §7.5: E2E happy path, sweep counters untouched,
 * zero network egress, and lease release.
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

test("publish orchestrator: E2E happy path, honesty, and lease release", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-e2e");
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
      sweepCount: 1,
      sourceSeenCount: 10,
      stagedCount: 4,
      publishedCount: 0,
      deduplicatedCount: 0,
    })
    .returning();

  const source1 = randomUUID();
  const source2 = randomUUID();
  const text1 = "Live memory content 1";
  const text2 = "Live memory content 2";
  const sha1 = computeSourceContentSha256(text1);
  const sha2 = computeSourceContentSha256(text2);

  // Seed live rows
  await insertTenantMemoryRow(env.tenantSql, { id: source1, agentId: env.agent.id, data: text1 });
  await insertTenantMemoryRow(env.tenantSql, { id: source2, agentId: env.agent.id, data: text2 });

  // Seed staging memories
  const s1 = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: source1, agentId: env.agent.id });
  const s2 = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: source2, agentId: env.agent.id });

  await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId: source1, agentId: env.agent.id, outcome: "published", outputIds: [s1.outputId], sourceContentSha256: sha1 });
  await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId: source2, agentId: env.agent.id, outcome: "published", outputIds: [s2.outputId], sourceContentSha256: sha2 });

  // Test 36: Zero network egress guard
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("No network egress allowed during publish");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Snapshot counters before run
  const [beforeUpgrade] = await env.cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));

  // Run confirmed publish
  const report = await runPublish(
    { companyId: env.company.id, confirm: env.company.id },
    { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
  );

  assert.equal(report.isDryRun, false);
  assert.equal(report.counts.publishedCount, 2);

  // Test 28 & 35: Counters verified
  const [afterUpgrade] = await env.cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));

  assert.equal(afterUpgrade.publishedCount, 2);
  assert.equal(afterUpgrade.sweepCount, beforeUpgrade.sweepCount);
  assert.equal(afterUpgrade.sourceSeenCount, beforeUpgrade.sourceSeenCount);
  assert.equal(afterUpgrade.stagedCount, beforeUpgrade.stagedCount);
  assert.equal(afterUpgrade.deduplicatedCount, beforeUpgrade.deduplicatedCount);
  assert.equal(afterUpgrade.state, "sweeping");

  // Test 37: Lease release verified
  assert.equal(afterUpgrade.leaseToken, null);

  // Live memories inserted
  const liveRows = (await env.tenantSql.unsafe(
    `SELECT id FROM mem0_memories WHERE id = ANY($1::uuid[])`,
    [[s1.outputId, s2.outputId]],
  )) as any[];
  assert.equal(liveRows.length, 2);
});
