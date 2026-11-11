/**
 * Tenant reconciliation survival test (TECH-8191 PR 4b).
 * Test 15 from plan §7.2: published rows survive reconcileTombstones & reconcileChangedContent.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ensureUpgradeTables,
  introspectCollection,
  openTenantClient,
  reconcileChangedContent,
  reconcileTombstones,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import {
  publishSourceBatch,
  resolveLiveVectorCast,
} from "../../server/src/services/company-memory-upgrade/publish-tenant.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { seedLedgerRow, seedStagedMemory } from "./memory-upgrade-publish-helpers.js";

test("publish-tenant: published rows survive reconciliation", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("pub-survival-");
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
  const sourceId = randomUUID();

  const r = await seedStagedMemory(sql, { upgradeId, sourceId, agentId });
  await seedLedgerRow(sql, { upgradeId, sourceId, agentId, outcome: "published", outputIds: [r.outputId] });

  await publishSourceBatch(sql, { upgradeId, sourceIds: [sourceId], tableName: liveTable, shape, vectorCast }, fence);

  // Live row and published staging row are present
  const [{ count: liveCount }] = (await sql.unsafe(`SELECT count(*)::int as count FROM ${liveTable} WHERE id = $1::uuid`, [
    r.outputId,
  ])) as any[];
  assert.equal(liveCount, 1);

  // Run reconcileChangedContent
  await reconcileChangedContent(
    sql,
    { upgradeId, sourceId, sourceContentSha256: "new-hash", agentId },
    fence,
  );

  // Staging row still present (published rows are never deleted by reconcileChangedContent)
  const [{ count: stagedAfterChange }] = (await sql`
    SELECT count(*)::int as count FROM paperclip_memory_upgrade_staging
    WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${r.outputId}::uuid AND published_at IS NOT NULL;
  `) as any[];
  assert.equal(stagedAfterChange, 1);

  // Live row still present
  const [{ count: liveAfterChange }] = (await sql.unsafe(`SELECT count(*)::int as count FROM ${liveTable} WHERE id = $1::uuid`, [
    r.outputId,
  ])) as any[];
  assert.equal(liveAfterChange, 1);

  // Run reconcileTombstones
  await reconcileTombstones(sql, upgradeId, { tombstoneSourceIds: [sourceId], batchSize: 200 }, fence);

  // Staging and live rows still present
  const [{ count: stagedAfterTomb }] = (await sql`
    SELECT count(*)::int as count FROM paperclip_memory_upgrade_staging
    WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${r.outputId}::uuid AND published_at IS NOT NULL;
  `) as any[];
  assert.equal(stagedAfterTomb, 1);

  const [{ count: liveAfterTomb }] = (await sql.unsafe(`SELECT count(*)::int as count FROM ${liveTable} WHERE id = $1::uuid`, [
    r.outputId,
  ])) as any[];
  assert.equal(liveAfterTomb, 1);
});
