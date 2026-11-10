/**
 * Reconcile semantics: ledger referential integrity and correlated subquery (TECH-8191).
 * Tests 21 and 22 from §7.3.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  commitSourceOutcome,
  ensureUpgradeTables,
  loadLedgerForSources,
  openTenantClient,
  stageSourceRecords,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("ledger correlated subquery and all-duplicate retention (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("publish-ledger-");
  const sql = openTenantClient(fixture.connectionString);
  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(sql, "mem0_memories");
  await ensureUpgradeTables(sql, "text");

  const upgradeId = randomUUID(), agentId = randomUUID();
  const fence = await claimTenantFenceForTestSetup(sql, upgradeId);

  // Test 21: commitSourceOutcome correlated subquery preserves references to live rows
  await t.test("Test 21: commitSourceOutcome preserves references to live rows in INSERT and ON CONFLICT", async () => {
    const sourceId = randomUUID(), pubId1 = randomUUID(), pubId2 = randomUUID();
    const sortedPublishedIds = [pubId1, pubId2].sort();

    for (const outId of sortedPublishedIds) {
      await sql`
        INSERT INTO paperclip_memory_upgrade_staging (
          upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
        ) VALUES (${upgradeId}::uuid, ${sourceId}::uuid, ${outId}::uuid, ${agentId}::uuid, '{"text":"live"}'::jsonb, 'vec'::text, 'h1', now(), now());
      `;
    }

    // Branch A: INSERT path
    await commitSourceOutcome(
      sql,
      { upgradeId, sourceId, sourceContentSha256: "h1", agentId, outcome: "unroutable", reasonCode: "terminated" },
      fence,
    );

    let ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    let ledger = ledgerMap.get(sourceId.toLowerCase())!;
    assert.equal(ledger.outcome, "unroutable");
    assert.deepEqual(ledger.outputIds, sortedPublishedIds, "INSERT branch must recompute output_ids from staging");

    // Branch B: ON CONFLICT DO UPDATE path
    await commitSourceOutcome(
      sql,
      { upgradeId, sourceId, sourceContentSha256: "h1", agentId, outcome: "dropped_noise", reasonCode: "empty" },
      fence,
    );

    ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    ledger = ledgerMap.get(sourceId.toLowerCase())!;
    assert.equal(ledger.outcome, "dropped_noise");
    assert.deepEqual(ledger.outputIds, sortedPublishedIds, "ON CONFLICT branch MUST preserve output_ids via subquery");
  });

  // Test 22: All-duplicate with retained published rows
  await t.test("Test 22: All-duplicate with retained published rows -> outcome deduplicated, output_ids non-empty", async () => {
    const sourceA = randomUUID(), pubIdA = randomUUID(), wonRecId = randomUUID();

    // Source A has published staging row
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
      ) VALUES (${upgradeId}::uuid, ${sourceA}::uuid, ${pubIdA}::uuid, ${agentId}::uuid, '{"text":"a"}'::jsonb, 'vec'::text, 'hashA', now(), now());
    `;

    // Another source B already won dedupe slot for data_sha256 'common_slot'
    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id, created_at
      ) VALUES (${upgradeId}::uuid, ${agentId}::uuid, 'common_slot', ${wonRecId}::uuid, now());
    `;

    // Now Source A converts with records that collide with common_slot (all duplicate)
    const stageRes = await stageSourceRecords(
      sql,
      {
        upgradeId,
        sourceId: sourceA,
        sourceContentSha256: "hashA",
        agentId,
        records: [{ outputId: randomUUID(), dataSha256: "common_slot", payload: { data: "common" }, embedding: [0.1] }],
        vectorType: "text",
      },
      fence,
    );

    assert.equal(stageRes.outcome, "deduplicated");
    assert.equal(stageRes.stagedCount, 0);
    assert.equal(stageRes.deduplicatedCount, 1);

    // Ledger for Source A must have outcome 'deduplicated' AND output_ids referencing its pre-existing published row
    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceA]);
    const ledger = ledgerMap.get(sourceA.toLowerCase())!;
    assert.equal(ledger.outcome, "deduplicated");
    assert.deepEqual(ledger.outputIds, [pubIdA]);
  });
});
