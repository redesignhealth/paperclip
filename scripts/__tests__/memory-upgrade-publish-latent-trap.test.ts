/**
 * Latent-trap handling tests (TECH-8191 PR 4b).
 * Covers commitSourceOutcome paths (unroutable/dropped/quarantined).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  companyMemoryUpgrades,
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

test("publish orchestrator: latent-trap handling for quarantined, dropped, and unroutable staging rows", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-latent");
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

  // 1. Quarantined source with staged rows
  const srcQuarantine = randomUUID();
  const qStaged = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: srcQuarantine, agentId: env.agent.id });
  await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId: srcQuarantine, agentId: env.agent.id, outcome: "quarantined", outputIds: [qStaged.outputId] });

  // 2. Dropped-noise source with staged rows
  const srcNoise = randomUUID();
  const nStaged = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: srcNoise, agentId: env.agent.id });
  await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId: srcNoise, agentId: env.agent.id, outcome: "dropped_noise", outputIds: [nStaged.outputId] });

  // 3. Unroutable source with staged rows
  const srcUnroutable = randomUUID();
  const uStaged = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: srcUnroutable, agentId: env.agent.id });
  await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId: srcUnroutable, agentId: env.agent.id, outcome: "unroutable", outputIds: [uStaged.outputId] });

  // 4. Valid published source with staged rows
  const srcValid = randomUUID();
  const textValid = "Valid publishable memory content";
  await insertTenantMemoryRow(env.tenantSql, { id: srcValid, agentId: env.agent.id, data: textValid });
  const vStaged = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: srcValid, agentId: env.agent.id });
  await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId: srcValid, agentId: env.agent.id, outcome: "published", outputIds: [vStaged.outputId], sourceContentSha256: computeSourceContentSha256(textValid) });

  // Run publish
  const report = await runPublish(
    { companyId: env.company.id, confirm: env.company.id },
    { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
  );

  // Exactly 1 memory was published (srcValid)
  assert.equal(report.counts.publishedCount, 1);

  // Quarantined source MUST retain its staging rows (never pruned)
  const qRows = (await env.tenantSql.unsafe(
    "SELECT output_id, published_at FROM paperclip_memory_upgrade_staging WHERE source_id = $1::uuid",
    [srcQuarantine],
  )) as Array<{ output_id: string; published_at: Date | null }>;
  assert.equal(qRows.length, 1);
  assert.equal(qRows[0].published_at, null); // Still unpublished

  // Quarantined source MUST NOT be in live collection
  const liveQ = (await env.tenantSql.unsafe(
    "SELECT id FROM mem0_memories WHERE id = $1::uuid",
    [qStaged.outputId],
  )) as any[];
  assert.equal(liveQ.length, 0);

  // Dropped noise source: unpublished staging rows were CLEARED
  const nRows = (await env.tenantSql.unsafe(
    "SELECT output_id FROM paperclip_memory_upgrade_staging WHERE source_id = $1::uuid",
    [srcNoise],
  )) as any[];
  assert.equal(nRows.length, 0);

  // Unroutable source: unpublished staging rows were CLEARED
  const uRows = (await env.tenantSql.unsafe(
    "SELECT output_id FROM paperclip_memory_upgrade_staging WHERE source_id = $1::uuid",
    [srcUnroutable],
  )) as any[];
  assert.equal(uRows.length, 0);

  // Valid source was published to live collection
  const liveV = (await env.tenantSql.unsafe(
    "SELECT id FROM mem0_memories WHERE id = $1::uuid",
    [vStaged.outputId],
  )) as any[];
  assert.equal(liveV.length, 1);
});
