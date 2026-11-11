/**
 * Mixed published/unpublished staging tests for publish cleanup (TECH-8191 review finding 2).
 * Verifies cleanupUnpublishedDroppedStaging retains published rows/dedupe and removes unpublished.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";
import { cleanupUnpublishedDroppedStaging } from "../../server/src/services/company-memory-upgrade/publish.js";
import {
  seedLedgerRow,
  seedStagedMemory,
  setupPublishTestEnvironment,
} from "./memory-upgrade-publish-helpers.js";

test("publish orchestrator: cleanupUnpublishedDroppedStaging preserves published rows and removes unpublished rows", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-fence-mixed");
  t.after(async () => {
    await env.cleanup();
  });

  const upgradeId = randomUUID();
  const sourceId = randomUUID();

  // Setup fence row in tenant
  await env.tenantSql.unsafe(
    `INSERT INTO paperclip_memory_upgrade_fence (upgrade_id, fence_epoch, lease_token, lease_owner, claimed_at)
     VALUES ($1::uuid, 1, 'token-1', 'worker-1', now());`,
    [upgradeId],
  );

  const validFence = {
    upgradeId,
    fenceEpoch: "1",
    leaseToken: "token-1",
    leaseOwner: "worker-1",
  };

  // Seed 1 published staging row and 1 unpublished staging row
  const pubStaged = await seedStagedMemory(env.tenantSql, { upgradeId, sourceId, agentId: env.agent.id, publishedAt: new Date() });
  const unpubStaged = await seedStagedMemory(env.tenantSql, { upgradeId, sourceId, agentId: env.agent.id });

  await env.tenantSql.unsafe(
    `INSERT INTO paperclip_memory_upgrade_dedupe (upgrade_id, agent_id, data_sha256, output_id, created_at)
     VALUES ($1::uuid, $2::uuid, 'sha-pub', $3::uuid, now()),
            ($1::uuid, $2::uuid, 'sha-unpub', $4::uuid, now());`,
    [upgradeId, env.agent.id, pubStaged.outputId, unpubStaged.outputId],
  );

  await seedLedgerRow(env.tenantSql, {
    upgradeId,
    sourceId,
    agentId: env.agent.id,
    outcome: "dropped_noise",
    outputIds: [pubStaged.outputId, unpubStaged.outputId],
  });

  const res = await cleanupUnpublishedDroppedStaging(env.tenantWorkerSql, { upgradeId, sourceId }, validFence);
  assert.equal(res.deletedStagingCount, 1);
  assert.equal(res.deletedDedupeCount, 1);

  // Published row must still exist in staging and dedupe
  const pubStaging = (await env.tenantSql.unsafe(
    "SELECT output_id FROM paperclip_memory_upgrade_staging WHERE output_id = $1::uuid",
    [pubStaged.outputId],
  )) as any[];
  assert.equal(pubStaging.length, 1, "Published staging row must be retained");

  const pubDedupe = (await env.tenantSql.unsafe(
    "SELECT output_id FROM paperclip_memory_upgrade_dedupe WHERE output_id = $1::uuid",
    [pubStaged.outputId],
  )) as any[];
  assert.equal(pubDedupe.length, 1, "Published dedupe row must be retained");

  // Unpublished row must be removed from staging and dedupe
  const unpubStaging = (await env.tenantSql.unsafe(
    "SELECT output_id FROM paperclip_memory_upgrade_staging WHERE output_id = $1::uuid",
    [unpubStaged.outputId],
  )) as any[];
  assert.equal(unpubStaging.length, 0, "Unpublished staging row must be removed");

  const unpubDedupe = (await env.tenantSql.unsafe(
    "SELECT output_id FROM paperclip_memory_upgrade_dedupe WHERE output_id = $1::uuid",
    [unpubStaged.outputId],
  )) as any[];
  assert.equal(unpubDedupe.length, 0, "Unpublished dedupe row must be removed");

  // Ledger output_ids recomputed to only include published row
  const [led] = (await env.tenantSql.unsafe(
    "SELECT output_ids FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = $1::uuid AND source_id = $2::uuid",
    [upgradeId, sourceId],
  )) as Array<{ output_ids: string[] }>;
  assert.deepEqual(led.output_ids, [pubStaged.outputId]);
});
