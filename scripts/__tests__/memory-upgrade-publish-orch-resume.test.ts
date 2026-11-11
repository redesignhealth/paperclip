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
import {
  formatPublishTextReport,
  runPublish,
} from "../../server/src/services/company-memory-upgrade/publish.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";
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

test("publish orchestrator: multi-page budget exhaustion, truthful reporting, and resume", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-budget-exhausted");
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

  // 4 sorted UUID sources: S1: 1 row, S2: 3 rows, S3: 1 row, S4: 1 row
  const sIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
  const [s1, s2, s3, s4] = sIds;
  const configs = [
    { id: s1, count: 1 },
    { id: s2, count: 3 },
    { id: s3, count: 1 },
    { id: s4, count: 1 },
  ];

  for (const { id: sId, count } of configs) {
    const text = `Memory content for ${sId}`;
    const sha = computeSourceContentSha256(text);
    await insertTenantMemoryRow(env.tenantSql, { id: sId, agentId: env.agent.id, data: text });

    const outputIds: string[] = [];
    for (let j = 0; j < count; j++) {
      const mem = await seedStagedMemory(env.tenantSql, {
        upgradeId: upgrade.id,
        sourceId: sId,
        agentId: env.agent.id,
      });
      outputIds.push(mem.outputId);
    }

    await seedLedgerRow(env.tenantSql, {
      upgradeId: upgrade.id,
      sourceId: sId,
      agentId: env.agent.id,
      outcome: "published",
      outputIds,
      sourceContentSha256: sha,
    });
  }

  // PageSize: 2, MaxRows: 2
  // Page 1 has S1 (1 row) and S2 (3 rows). S1 takes 1 row. S2 needs 3 (1+3 > 2), exceeding budget!
  // S2 triggers budgetExhausted. S1 published. Outer loop stops and does NOT page to Page 2 (S3, S4).
  const rep1 = await runPublish(
    { companyId: env.company.id, confirm: env.company.id, pageSize: 2, maxRows: 2 },
    { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
  );

  assert.equal(rep1.counts.publishedCount, 1);
  assert.equal(rep1.counts.pendingRows, 5); // 3 (S2) + 1 (S3) + 1 (S4)
  assert.equal(rep1.counts.pendingSources, 3);
  assert.equal(rep1.counts.alreadyPublishedRows, 1);

  // Truthful text report when pending work remains
  const text1 = formatPublishTextReport(rep1);
  assert.match(text1, /Publish batch complete; pending work remains\./);
  assert.doesNotMatch(text1, /Publish complete\./);

  // Verify S3 and S4 were NOT published out of order
  const unpublished = (await env.tenantSql.unsafe(
    `SELECT DISTINCT source_id FROM paperclip_memory_upgrade_staging WHERE published_at IS NULL ORDER BY source_id;`,
  )) as Array<{ source_id: string }>;
  assert.deepEqual(
    unpublished.map((r) => String(r.source_id).toLowerCase()),
    [s2.toLowerCase(), s3.toLowerCase(), s4.toLowerCase()],
  );

  // Next run resumes at S2 and completes all pending rows
  const rep2 = await runPublish(
    { companyId: env.company.id, confirm: env.company.id, pageSize: 2, maxRows: 10 },
    { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
  );

  assert.equal(rep2.counts.publishedCount, 5);
  assert.equal(rep2.counts.pendingRows, 0);
  assert.equal(rep2.counts.pendingSources, 0);
  assert.equal(rep2.counts.alreadyPublishedRows, 6);

  // Truthful text report when complete
  const text2 = formatPublishTextReport(rep2);
  assert.match(text2, /Publish complete\./);
  assert.doesNotMatch(text2, /pending work remains/);
});

test("publish orchestrator: first oversized source refuses instead of stalling silently", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-first-oversized");
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

  // Single source with 3 staging rows; maxRows is smaller than the source's row count.
  // The source is the first (and only) eligible candidate, and no rows have been
  // consumed/published yet in this run, so bounding would publish nothing and a
  // repeat run would hit the exact same wall: refuse instead of silently stalling.
  const sId = randomUUID();
  const text = `Memory content for ${sId}`;
  const sha = computeSourceContentSha256(text);
  await insertTenantMemoryRow(env.tenantSql, { id: sId, agentId: env.agent.id, data: text });

  const outputIds: string[] = [];
  for (let j = 0; j < 3; j++) {
    const mem = await seedStagedMemory(env.tenantSql, {
      upgradeId: upgrade.id,
      sourceId: sId,
      agentId: env.agent.id,
    });
    outputIds.push(mem.outputId);
  }
  await seedLedgerRow(env.tenantSql, {
    upgradeId: upgrade.id,
    sourceId: sId,
    agentId: env.agent.id,
    outcome: "published",
    outputIds,
    sourceContentSha256: sha,
  });

  await assert.rejects(
    () =>
      runPublish(
        { companyId: env.company.id, confirm: env.company.id, maxRows: 2 },
        { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
      ),
    (err: unknown) => {
      assert.ok(err instanceof CompanyMemoryUpgradeError);
      assert.equal(err.code, "INVALID_ARGUMENT");
      assert.equal(
        err.message,
        "Source exceeds --max-rows and cannot be split; increase --max-rows to at least the source's row count.",
      );
      return true;
    },
  );

  // Nothing was published; the source's staging rows remain untouched for a resumed run.
  const [{ count: publishedRows }] = (await env.tenantSql.unsafe(
    `SELECT count(*)::int as count FROM paperclip_memory_upgrade_staging WHERE published_at IS NOT NULL;`,
  )) as Array<{ count: number }>;
  assert.equal(publishedRows, 0);

  const [upg] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  assert.equal(upg.publishedCount, 0);

  // A follow-up run with a sufficient --max-rows succeeds and publishes the source whole.
  const rep = await runPublish(
    { companyId: env.company.id, confirm: env.company.id, maxRows: 10 },
    { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
  );
  assert.equal(rep.counts.publishedCount, 3);
  assert.equal(rep.counts.pendingRows, 0);
});
