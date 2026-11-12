/**
 * Draining state acceptance and state refusal tests for publish (TECH-8191 §5.2).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runPublish } from "../../server/src/services/company-memory-upgrade/publish.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
} from "./memory-upgrade-sweep-helpers.js";
import {
  seedLedgerRow,
  seedStagedMemory,
  setupPublishTestEnvironment,
} from "./memory-upgrade-publish-helpers.js";

test("publish accepts draining state and publishes pending rows (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-pub");
  t.after(async () => {
    await env.cleanup();
  });

  const [upgrade] = await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id,
      state: "draining",
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    })
    .returning();

  const sourceId = randomUUID();
  const outputId = randomUUID();
  const text = "Catch-up memory during draining";
  const sha = computeSourceContentSha256(text);

  await insertTenantMemoryRow(env.tenantSql, { id: sourceId, agentId: env.agent.id, data: text });

  const { payload } = await seedStagedMemory(env.tenantSql, {
    upgradeId: upgrade.id,
    sourceId,
    outputId,
    agentId: env.agent.id,
    contentSha256: sha,
    payload: { data: text, user_id: env.agent.id, agent_id: env.agent.id },
  });

  await seedLedgerRow(env.tenantSql, {
    upgradeId: upgrade.id,
    sourceId,
    agentId: env.agent.id,
    outcome: "published",
    outputIds: [outputId],
    sourceContentSha256: sha,
  });

  const workerDeps = {
    cpDb: env.cpWorkerDb,
    tenantSql: env.tenantWorkerSql,
    _internalSkipVectorIdentityCheck: true,
  };

  // 1. Dry run succeeds against draining upgrade
  const dryReport = await runPublish({ companyId: env.company.id }, workerDeps);
  assert.equal(dryReport.isDryRun, true);
  assert.equal(dryReport.state, "draining");
  assert.equal(dryReport.counts.pendingRows, 1);

  // 2. Confirmed publish succeeds against draining upgrade
  await env.cpDb
    .update(companyMemoryUpgrades)
    .set({
      drainProbeStreakStartedAt: new Date(),
      drainConfirmedAt: new Date(),
    })
    .where(eq(companyMemoryUpgrades.id, upgrade.id));

  const report = await runPublish({ companyId: env.company.id, confirm: env.company.id }, workerDeps);
  assert.equal(report.isDryRun, false);
  assert.equal(report.state, "draining");
  assert.equal(report.counts.publishedCount, 1);

  const [upgradeAfterPub] = await env.cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));
  assert.equal(upgradeAfterPub.drainProbeStreakStartedAt, null);
  assert.equal(upgradeAfterPub.drainConfirmedAt, null);

  // Verify row published to live collection
  const liveRows = await env.tenantSql`
    SELECT id::text, payload, jsonb_typeof(payload) as payload_type
    FROM mem0_memories WHERE id = ${outputId}::uuid
  `;
  assert.equal(liveRows.length, 1);
  assert.equal(liveRows[0].payload_type, "object");
  assert.equal(typeof liveRows[0].payload, "object");
  assert.notEqual(liveRows[0].payload, null);
  assert.equal(liveRows[0].payload.data, payload.data);
  assert.equal(liveRows[0].payload.user_id, env.agent.id);

  // 3. Refuses non-work active states with STATE_MISMATCH
  for (const st of ["flipping", "verified", "pruning", "needs_recovery"] as const) {
    await env.cpDb.update(companyMemoryUpgrades).set({ state: st }).where(eq(companyMemoryUpgrades.id, upgrade.id));
    await assert.rejects(
      () => runPublish({ companyId: env.company.id, confirm: env.company.id }, workerDeps),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STATE_MISMATCH",
    );
  }

  // 4. Terminal states refuse as inactive
  for (const st of ["completed", "aborted", "rolled_back"] as const) {
    await env.cpDb.update(companyMemoryUpgrades).set({ state: st }).where(eq(companyMemoryUpgrades.id, upgrade.id));
    await assert.rejects(
      () => runPublish({ companyId: env.company.id, confirm: env.company.id }, workerDeps),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STATE_MISMATCH",
    );
  }
});

test("publish: state change between findActiveUpgrade read and fence claim fences worker out (TECH-8191)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-pub-race");
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
    })
    .returning();

  const sourceId = randomUUID();
  const outputId = randomUUID();
  const text = "Memory staged during sweeping";
  const sha = computeSourceContentSha256(text);

  await insertTenantMemoryRow(env.tenantSql, { id: sourceId, agentId: env.agent.id, data: text });

  await seedStagedMemory(env.tenantSql, {
    upgradeId: upgrade.id,
    sourceId,
    outputId,
    agentId: env.agent.id,
    contentSha256: sha,
    payload: { data: text, user_id: env.agent.id, agent_id: env.agent.id },
  });

  await seedLedgerRow(env.tenantSql, {
    upgradeId: upgrade.id,
    sourceId,
    agentId: env.agent.id,
    outcome: "published",
    outputIds: [outputId],
    sourceContentSha256: sha,
  });

  // Intercept ensureUpgradeTables (which runs after findActiveUpgrade/read & lease claim, right before claimTenantFenceGuarded)
  // to simulate a concurrent worker transitioning the upgrade sweeping -> flipping -> draining
  const origBegin = env.tenantWorkerSql.begin.bind(env.tenantWorkerSql);
  let stateTransitioned = false;
  env.tenantWorkerSql.begin = (async (...args: any[]) => {
    const res = await (origBegin as any)(...args);
    if (!stateTransitioned) {
      stateTransitioned = true;
      // Concurrent transition occurs while Worker A read 'sweeping'
      await env.cpDb
        .update(companyMemoryUpgrades)
        .set({ state: "draining" })
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
    }
    return res;
  }) as any;

  const workerDeps = {
    cpDb: env.cpWorkerDb,
    tenantSql: env.tenantWorkerSql,
    _internalSkipVectorIdentityCheck: true,
  };

  await assert.rejects(
    () => runPublish({ companyId: env.company.id, confirm: env.company.id }, workerDeps),
    (err: any) => {
      assert.equal(err instanceof CompanyMemoryUpgradeError, true);
      assert.equal(err.code, "LEASE_FENCED_OUT");
      return true;
    },
  );

  assert.equal(stateTransitioned, true);

  // Assert no live writes: outputId not in live collection
  const liveRows = await env.tenantSql`SELECT id::text FROM mem0_memories WHERE id = ${outputId}::uuid`;
  assert.equal(liveRows.length, 0);

  // Staged memory was not marked published
  const stagedRows = await env.tenantSql`SELECT published_at FROM paperclip_memory_upgrade_staging WHERE output_id = ${outputId}::uuid`;
  assert.equal(stagedRows.length, 1);
  assert.equal(stagedRows[0].published_at, null);
});
