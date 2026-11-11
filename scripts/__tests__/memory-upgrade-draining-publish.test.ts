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
  const report = await runPublish({ companyId: env.company.id, confirm: env.company.id }, workerDeps);
  assert.equal(report.isDryRun, false);
  assert.equal(report.state, "draining");
  assert.equal(report.counts.publishedCount, 1);

  // Verify row published to live collection
  const liveRows = await env.tenantSql`SELECT id::text, payload FROM mem0_memories WHERE id = ${outputId}::uuid`;
  assert.equal(liveRows.length, 1);
  const parsed = typeof liveRows[0].payload === "string" ? JSON.parse(liveRows[0].payload) : liveRows[0].payload;
  assert.equal(parsed.data, payload.data);
  assert.equal(parsed.user_id, env.agent.id);

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
