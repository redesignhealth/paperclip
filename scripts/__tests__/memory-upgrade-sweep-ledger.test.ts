/**
 * Ledger and tenant table operations test for company memory upgrade sweep (TECH-8191).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  commitSourceOutcome,
  ensureUpgradeTables,
  loadLedgerForSources,
  openTenantClient,
  reconcileChangedContent,
  reconcileTombstones,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import { UPGRADE_LEDGER_OUTCOMES } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("sweep-tenant ledger operations", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("sweep-ledger-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(sql, "mem0_memories");

  await t.test("ensureUpgradeTables creates tables and indexes idempotently", async () => {
    // First run creates tables
    await ensureUpgradeTables(sql, "text");

    // Second run is a clean no-op
    await ensureUpgradeTables(sql, "text");

    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'paperclip_memory_upgrade_staging',
          'paperclip_memory_upgrade_ledger',
          'paperclip_memory_upgrade_dedupe',
          'paperclip_memory_upgrade_fence'
        )
      ORDER BY table_name;
    `;
    assert.deepEqual(
      tables.map((t) => t.table_name),
      [
        "paperclip_memory_upgrade_dedupe",
        "paperclip_memory_upgrade_fence",
        "paperclip_memory_upgrade_ledger",
        "paperclip_memory_upgrade_staging",
      ],
    );
  });

  await t.test("commitSourceOutcome upserts ledger records correctly", async () => {
    const upgradeId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const initialHash = computeSourceContentSha256("Initial text");

    // Initial insert
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: initialHash,
      agentId,
      outcome: "unroutable",
      reasonCode: "missing_agent_id",
    }, fence);

    let ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    assert.equal(ledgerMap.size, 1);
    const row1 = ledgerMap.get(sourceId)!;
    assert.equal(row1.outcome, "unroutable");
    assert.equal(row1.reasonCode, "missing_agent_id");
    assert.equal(row1.sourceContentSha256, initialHash);

    // Update via conflict
    const updatedHash = computeSourceContentSha256("Updated text");
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: updatedHash,
      agentId,
      outcome: "dropped_noise",
      reasonCode: "exact_placeholder_or_greeting",
    }, fence);

    ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    assert.equal(ledgerMap.size, 1);
    const row2 = ledgerMap.get(sourceId)!;
    assert.equal(row2.outcome, "dropped_noise");
    assert.equal(row2.reasonCode, "exact_placeholder_or_greeting");
    assert.equal(row2.sourceContentSha256, updatedHash);
  });

  await t.test("outcome CHECK constraint rejects junk outcome", async () => {
    const upgradeId = randomUUID();
    const sourceId = randomUUID();

    await assert.rejects(
      async () => {
        await sql`
          INSERT INTO paperclip_memory_upgrade_ledger (
            upgrade_id, source_id, source_content_sha256, outcome
          ) VALUES (
            ${upgradeId}::uuid, ${sourceId}::uuid, 'hash123', 'junk_outcome'
          );
        `;
      },
      (err: any) => {
        assert.equal(err.code, "23514"); // check_violation
        return true;
      },
    );

    // Conforms to UPGRADE_LEDGER_OUTCOMES vocabulary
    for (const validOutcome of UPGRADE_LEDGER_OUTCOMES) {
      const srcId = randomUUID();
      await sql`
        INSERT INTO paperclip_memory_upgrade_ledger (
          upgrade_id, source_id, source_content_sha256, outcome
        ) VALUES (
          ${upgradeId}::uuid, ${srcId}::uuid, 'hash123', ${validOutcome}
        );
      `;
    }
  });

  await t.test("tombstone -> source_deleted with unpublished staging removed and published staging retained", async () => {
    const upgradeId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
    const liveSourceId = randomUUID();
    const tombstoneSourceId = randomUUID();
    const agentId = randomUUID();

    const outputPublished = randomUUID();
    const outputUnpublished = randomUUID();

    // 1. Seed live source in mem0_memories
    await sql`
      INSERT INTO mem0_memories (id, payload, vector)
      VALUES (${liveSourceId}::uuid, '{"data": "still here"}'::jsonb, 'v1');
    `;

    // 2. Seed ledger rows for both
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId: liveSourceId,
      sourceContentSha256: "hash-live",
      agentId,
      outcome: "published",
    }, fence);

    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId: tombstoneSourceId,
      sourceContentSha256: "hash-tombstone",
      agentId,
      outcome: "published",
    }, fence);

    // 3. Seed staging and dedupe rows for tombstone source: one published, one unpublished
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at
      ) VALUES
        (${upgradeId}::uuid, ${tombstoneSourceId}::uuid, ${outputPublished}::uuid, ${agentId}::uuid, '{"data": "pub"}'::jsonb, 'vec', 'h1', now()),
        (${upgradeId}::uuid, ${tombstoneSourceId}::uuid, ${outputUnpublished}::uuid, ${agentId}::uuid, '{"data": "unpub"}'::jsonb, 'vec', 'h2', null);
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id
      ) VALUES
        (${upgradeId}::uuid, ${agentId}::uuid, 'data-hash-pub', ${outputPublished}::uuid),
        (${upgradeId}::uuid, ${agentId}::uuid, 'data-hash-unpub', ${outputUnpublished}::uuid);
    `;

    // 4. Reconcile tombstones
    const result = await reconcileTombstones(sql, upgradeId, {
      liveTableName: "mem0_memories",
    }, fence);

    assert.equal(result.tombstonesCount, 1);
    assert.deepEqual(result.tombstoneSourceIds, [tombstoneSourceId]);
    assert.equal(result.deletedStagingCount, 1);
    assert.equal(result.deletedDedupeCount, 1);

    // Ledger for tombstone source is now source_deleted
    const [tombstoneLedger] = await sql`
      SELECT outcome, output_ids FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${tombstoneSourceId}::uuid;
    `;
    assert.equal(tombstoneLedger.outcome, "source_deleted");
    // LEDGER INVARIANT: output_ids is recomputed from staging, not left stale -- it must
    // retain ONLY the still-published output id, never the deleted unpublished one.
    assert.deepEqual(tombstoneLedger.output_ids, [outputPublished]);

    // Published staging row is retained!
    const stagingRows = await sql`
      SELECT output_id, published_at FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${tombstoneSourceId}::uuid;
    `;
    assert.equal(stagingRows.length, 1);
    assert.equal(stagingRows[0].output_id, outputPublished);
    assert.ok(stagingRows[0].published_at !== null);

    // Dedupe row for published output is retained, unpublished was deleted
    const dedupeRows = await sql`
      SELECT output_id FROM paperclip_memory_upgrade_dedupe
      WHERE upgrade_id = ${upgradeId}::uuid;
    `;
    assert.equal(dedupeRows.length, 1);
    assert.equal(dedupeRows[0].output_id, outputPublished);

    // Second reconcile call skips already source_deleted row
    const secondResult = await reconcileTombstones(sql, upgradeId, {
      liveTableName: "mem0_memories",
    }, fence);
    assert.equal(secondResult.tombstonesCount, 0);
  });

  await t.test("content change with NO published rows -> stale ledger row deleted, clears unpublished staging and dedupe", async () => {
    const upgradeId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const outputId = randomUUID();

    // Seed ledger row
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: "old-hash",
      agentId,
      outcome: "published",
    }, fence);

    // Seed unpublished staging and dedupe
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at
      ) VALUES
        (${upgradeId}::uuid, ${sourceId}::uuid, ${outputId}::uuid, ${agentId}::uuid, '{"data": "content"}'::jsonb, 'vec', 'old-hash', null);
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id
      ) VALUES
        (${upgradeId}::uuid, ${agentId}::uuid, 'old-data-hash', ${outputId}::uuid);
    `;

    // Reconcile changed content: no published rows remain -> ledger row deleted
    const res = await reconcileChangedContent(sql, upgradeId, sourceId, fence);
    assert.equal(res.deletedStagingCount, 1);
    assert.equal(res.deletedDedupeCount, 1);
    assert.deepEqual(res.retainedOutputIds, []);

    const [ledgerRow] = await sql`
      SELECT outcome FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(ledgerRow, undefined, "Stale ledger row is deleted to allow clean reclassification");

    const stagingCount = await sql`
      SELECT count(*)::int AS count FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(stagingCount[0].count, 0);

    const dedupeCount = await sql`
      SELECT count(*)::int AS count FROM paperclip_memory_upgrade_dedupe
      WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${outputId}::uuid;
    `;
    assert.equal(dedupeCount[0].count, 0);
  });

  await t.test("content change WITH a still-published row -> superseded (not deleted), retaining exactly the published id", async () => {
    const upgradeId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const outputPublished = randomUUID();
    const outputUnpublished = randomUUID();

    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: "old-hash",
      agentId,
      outcome: "published",
    }, fence);

    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at
      ) VALUES
        (${upgradeId}::uuid, ${sourceId}::uuid, ${outputPublished}::uuid, ${agentId}::uuid, '{"data": "pub"}'::jsonb, 'vec', 'h-pub', now()),
        (${upgradeId}::uuid, ${sourceId}::uuid, ${outputUnpublished}::uuid, ${agentId}::uuid, '{"data": "unpub"}'::jsonb, 'vec', 'h-unpub', null);
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id
      ) VALUES
        (${upgradeId}::uuid, ${agentId}::uuid, 'h-pub', ${outputPublished}::uuid),
        (${upgradeId}::uuid, ${agentId}::uuid, 'h-unpub', ${outputUnpublished}::uuid);
    `;

    const res = await reconcileChangedContent(sql, upgradeId, sourceId, fence);
    assert.equal(res.deletedStagingCount, 1);
    assert.deepEqual(res.retainedOutputIds, [outputPublished]);

    const dedupeRows = await sql`
      SELECT output_id, data_sha256 FROM paperclip_memory_upgrade_dedupe
      WHERE upgrade_id = ${upgradeId}::uuid;
    `;
    assert.equal(dedupeRows.length, 1);
    assert.equal(dedupeRows[0].output_id, outputPublished);

    const [ledgerRow] = await sql`
      SELECT outcome, reason_code, output_ids FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.ok(ledgerRow, "Ledger row must NOT be deleted while a published row remains");
    assert.equal(ledgerRow.outcome, "superseded");
    assert.equal(ledgerRow.reason_code, null);
    assert.deepEqual(ledgerRow.output_ids, [outputPublished]);

    const [stillStaged] = await sql`
      SELECT output_id FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${outputPublished}::uuid;
    `;
    assert.ok(stillStaged, "Published staging row must remain intact");
  });

  await t.test("loadLedgerForSources identifies matching hashes for resume skip", async () => {
    const upgradeId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
    const sourceId = randomUUID();
    const hash = computeSourceContentSha256("Unchanged text");

    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: hash,
      agentId: null,
      outcome: "dropped_noise",
      reasonCode: "empty",
    }, fence);

    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    const row = ledgerMap.get(sourceId);
    assert.ok(row);
    assert.equal(row.sourceContentSha256, hash);
  });

});
