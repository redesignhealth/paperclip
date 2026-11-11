/**
 * Tenant publish happy path & idempotency (TECH-8191 PR 4b).
 * Tests 7 & 8 from plan §7.2.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ensureUpgradeTables,
  introspectCollection,
  openTenantClient,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import {
  publishSourceBatch,
  resolveLiveVectorCast,
  selectUnpublishedSourcePage,
} from "../../server/src/services/company-memory-upgrade/publish-tenant.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { seedLedgerRow, seedStagedMemory } from "./memory-upgrade-publish-helpers.js";

test("publish-tenant: happy path and idempotency", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("pub-happy-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  const liveTable = "mem0_memories";
  await setupTenantMem0Table(sql, liveTable);
  await ensureUpgradeTables(sql, "text");

  const shape = await introspectCollection(sql, liveTable, { skipVectorIdentityCheck: true });
  const vectorCast = resolveLiveVectorCast(shape, "text");

  const upgradeId = randomUUID();
  const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
  const agentId = randomUUID();
  const source1 = randomUUID();
  const source2 = randomUUID();

  const s1r1 = await seedStagedMemory(sql, { upgradeId, sourceId: source1, agentId });
  const s1r2 = await seedStagedMemory(sql, { upgradeId, sourceId: source1, agentId });
  const s2r1 = await seedStagedMemory(sql, { upgradeId, sourceId: source2, agentId });
  const s2r2 = await seedStagedMemory(sql, { upgradeId, sourceId: source2, agentId });

  await seedLedgerRow(sql, { upgradeId, sourceId: source1, agentId, outcome: "published", outputIds: [s1r1.outputId, s1r2.outputId] });
  await seedLedgerRow(sql, { upgradeId, sourceId: source2, agentId, outcome: "published", outputIds: [s2r1.outputId, s2r2.outputId] });

  // Test 7: Happy path
  const page = await selectUnpublishedSourcePage(sql, upgradeId, { limit: 10 });
  assert.equal(page.sourceIds.length, 2);

  const res = await publishSourceBatch(
    sql,
    { upgradeId, sourceIds: [source1, source2], tableName: liveTable, shape, vectorCast },
    fence,
  );

  assert.equal(res.insertedCount, 4);
  assert.equal(res.alreadyPresentCount, 0);
  assert.equal(res.publishedCount, 4);

  const liveRows = (await sql.unsafe(
    `SELECT lower(id::text) as id, payload FROM ${liveTable} WHERE lower(id::text) = ANY($1::text[])`,
    [[s1r1.outputId, s1r2.outputId, s2r1.outputId, s2r2.outputId]],
  )) as Array<{ id: string; payload: Record<string, unknown> | string }>;

  assert.equal(liveRows.length, 4);
  const liveMap = new Map(
    liveRows.map((r) => [r.id, typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload]),
  );
  assert.deepEqual(liveMap.get(s1r1.outputId.toLowerCase()), s1r1.payload);
  assert.deepEqual(liveMap.get(s1r2.outputId.toLowerCase()), s1r2.payload);

  const pendingRows = await sql`
    SELECT count(*)::int as count FROM paperclip_memory_upgrade_staging
    WHERE upgrade_id = ${upgradeId}::uuid AND published_at IS NULL;
  `;
  assert.equal(pendingRows[0].count, 0);

  // Test 8: Idempotency
  const pageAfter = await selectUnpublishedSourcePage(sql, upgradeId, { limit: 10 });
  assert.equal(pageAfter.sourceIds.length, 0);

  const res2 = await publishSourceBatch(
    sql,
    { upgradeId, sourceIds: [source1, source2], tableName: liveTable, shape, vectorCast },
    fence,
  );
  assert.equal(res2.insertedCount, 0);
  assert.equal(res2.publishedCount, 0);
});
