/**
 * Fencing validation tests for publish cleanup (TECH-8191 review finding 1).
 * Verifies cleanupUnpublishedDroppedStaging enforces tenant fence and advisory locks.
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
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";

test("publish orchestrator: cleanupUnpublishedDroppedStaging validates tenant fence before any mutations", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-fence-clean");
  t.after(async () => {
    await env.cleanup();
  });

  const upgradeId = randomUUID();
  const sourceId = randomUUID();

  // Setup fence row in tenant
  await env.tenantSql.unsafe(
    `INSERT INTO paperclip_memory_upgrade_fence (upgrade_id, fence_epoch, lease_token, lease_owner, claimed_at)
     VALUES ($1::uuid, 1, 'valid-token', 'worker-1', now());`,
    [upgradeId],
  );

  const staged = await seedStagedMemory(env.tenantSql, { upgradeId, sourceId, agentId: env.agent.id });
  await env.tenantSql.unsafe(
    `INSERT INTO paperclip_memory_upgrade_dedupe (upgrade_id, agent_id, data_sha256, output_id, created_at)
     VALUES ($1::uuid, $2::uuid, 'sha-test', $3::uuid, now());`,
    [upgradeId, env.agent.id, staged.outputId],
  );
  await seedLedgerRow(env.tenantSql, { upgradeId, sourceId, agentId: env.agent.id, outcome: "dropped_noise", outputIds: [staged.outputId] });

  // Stale fence with mismatched lease_token
  const staleFence = {
    upgradeId,
    fenceEpoch: "1",
    leaseToken: "stale-token",
    leaseOwner: "worker-0",
  };

  await assert.rejects(
    () => cleanupUnpublishedDroppedStaging(env.tenantWorkerSql, { upgradeId, sourceId }, staleFence),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );

  // Assert nothing was mutated
  const stagingRemaining = (await env.tenantSql.unsafe(
    "SELECT output_id FROM paperclip_memory_upgrade_staging WHERE output_id = $1::uuid",
    [staged.outputId],
  )) as any[];
  assert.equal(stagingRemaining.length, 1, "Staging row must NOT be deleted when fenced out");

  const dedupeRemaining = (await env.tenantSql.unsafe(
    "SELECT output_id FROM paperclip_memory_upgrade_dedupe WHERE output_id = $1::uuid",
    [staged.outputId],
  )) as any[];
  assert.equal(dedupeRemaining.length, 1, "Dedupe row must NOT be deleted when fenced out");
});
