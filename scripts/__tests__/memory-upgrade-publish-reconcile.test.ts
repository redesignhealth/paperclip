/**
 * Reconcile semantics: source deletion and tombstone reconciliation (TECH-8191).
 * Test 16 from §7.3.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ensureUpgradeTables,
  loadLedgerForSources,
  openTenantClient,
  reconcileTombstones,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("reconcile source deletion and cleanup (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("publish-reconcile-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(sql, "mem0_memories");
  await ensureUpgradeTables(sql, "text");

  const upgradeId = randomUUID();
  const agentId = randomUUID();
  const fence = await claimTenantFenceForTestSetup(sql, upgradeId);

  // Test 16: Source deleted between sweep and publish
  await t.test("Test 16: Source deleted between sweep and publish -> ledger source_deleted, unpublished staging gone, published retained", async () => {
    const sourceId = randomUUID();
    const publishedOutputId = randomUUID();
    const unpublishedOutputId = randomUUID();

    // 1 published staging row + 1 unpublished staging row
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
      ) VALUES
        (${upgradeId}::uuid, ${sourceId}::uuid, ${publishedOutputId}::uuid, ${agentId}::uuid, '{"text":"pub"}'::jsonb, 'vec'::text, 'hash1', now(), now()),
        (${upgradeId}::uuid, ${sourceId}::uuid, ${unpublishedOutputId}::uuid, ${agentId}::uuid, '{"text":"unpub"}'::jsonb, 'vec'::text, 'hash1', NULL, now());
    `;

    // Dedupe row for unpublished output
    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id, created_at
      ) VALUES (${upgradeId}::uuid, ${agentId}::uuid, 'dedupe_hash_1', ${unpublishedOutputId}::uuid, now());
    `;

    // Ledger row with outcome 'published' referencing both output IDs
    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at
      ) VALUES (
        ${upgradeId}::uuid, ${sourceId}::uuid, 'hash1', ${agentId}::uuid, 'published', NULL,
        ${[publishedOutputId, unpublishedOutputId]}::uuid[], now(), now()
      );
    `;

    // Reconcile tombstone for this source
    const result = await reconcileTombstones(sql, upgradeId, { tombstoneSourceIds: [sourceId] }, fence);
    assert.equal(result.tombstonesCount, 1);
    assert.equal(result.deletedStagingCount, 1);
    assert.equal(result.deletedDedupeCount, 1);

    // Assert: ledger outcome is source_deleted and output_ids references exactly the retained published row
    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    const ledger = ledgerMap.get(sourceId.toLowerCase())!;
    assert.equal(ledger.outcome, "source_deleted");
    assert.deepEqual(ledger.outputIds, [publishedOutputId]);

    // Assert: unpublished staging row is deleted, published staging row remains
    const stagingRows = await sql`
      SELECT output_id, published_at FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(stagingRows.length, 1);
    assert.equal(stagingRows[0].output_id, publishedOutputId);
    assert.ok(stagingRows[0].published_at !== null);
  });
});
