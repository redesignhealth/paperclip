/**
 * Orchestrator active-run gate pause tests (TECH-8191 PR 4b).
 * Test 31 from plan §7.5: active-run gate pauses publish and resumes when quiet.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  insertTenantMemoryRow,
  ManualClock,
} from "./memory-upgrade-sweep-helpers.js";
import { runPublish } from "../../server/src/services/company-memory-upgrade/publish.js";
import {
  seedLedgerRow,
  seedStagedMemory,
  setupPublishTestEnvironment,
} from "./memory-upgrade-publish-helpers.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";

test("publish orchestrator: active-run gate pauses publish", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-gate");
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

  const sourceId = randomUUID();
  const text = "Active gate test text";
  const sha = computeSourceContentSha256(text);
  await insertTenantMemoryRow(env.tenantSql, { id: sourceId, agentId: env.agent.id, data: text });

  const r = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId, agentId: env.agent.id });
  await seedLedgerRow(env.tenantSql, { upgradeId: upgrade.id, sourceId, agentId: env.agent.id, outcome: "published", outputIds: [r.outputId], sourceContentSha256: sha });

  // Insert active heartbeat run to trigger gate pause
  const [activeRun] = await env.cpDb.insert(heartbeatRuns).values({
    companyId: env.company.id,
    agentId: env.agent.id,
    status: "running",
  }).returning();

  const clock = new ManualClock(Date.now());
  let sleepCount = 0;
  const sleeper = {
    sleep: async (ms: number) => {
      sleepCount++;
      clock.sleep(ms);
      // Clear active run after 1 sleep to let gate unpause
      await env.cpDb
        .update(heartbeatRuns)
        .set({ status: "completed" })
        .where(eq(heartbeatRuns.id, activeRun.id));
    },
  };

  const report = await runPublish(
    {
      companyId: env.company.id,
      confirm: env.company.id,
      pauseWhenActiveRuns: 1,
      activeRunPollMs: 100,
    },
    {
      cpDb: env.cpWorkerDb,
      tenantSql: env.tenantWorkerSql,
      clock,
      sleeper,
      _internalSkipVectorIdentityCheck: true,
    },
  );

  assert.ok(report.activeRunGate.pauseCount > 0, "Expected gate pauseCount > 0");
  assert.equal(report.counts.publishedCount, 1);
});
