/**
 * Reconcile semantics: changed content and superseded ledger rows (TECH-8191).
 * Tests 17 and 18 from §7.3.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ensureUpgradeTables,
  loadLedgerForSources,
  openTenantClient,
  reconcileChangedContent,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("reconcile changed content and superseded rows (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("publish-superseded-");
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

  // Test 17: Source content changed, no published rows remain
  await t.test("Test 17: Source content changed, no published rows remain -> unpublished staging gone, ledger row deleted", async () => {
    const sourceId = randomUUID();
    const unpublishedOutputId = randomUUID();

    // Only unpublished staging row
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
      ) VALUES (${upgradeId}::uuid, ${sourceId}::uuid, ${unpublishedOutputId}::uuid, ${agentId}::uuid, '{"text":"unpub"}'::jsonb, 'vec'::text, 'hash_old', NULL, now());
    `;
    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (upgrade_id, agent_id, data_sha256, output_id, created_at)
      VALUES (${upgradeId}::uuid, ${agentId}::uuid, 'dedupe_hash_2', ${unpublishedOutputId}::uuid, now());
    `;
    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at
      ) VALUES (${upgradeId}::uuid, ${sourceId}::uuid, 'hash_old', ${agentId}::uuid, 'published', NULL, ${[unpublishedOutputId]}::uuid[], now(), now());
    `;

    const changeRes = await reconcileChangedContent(
      sql,
      { upgradeId, sourceId, sourceContentSha256: "hash_new", agentId },
      fence,
    );
    assert.equal(changeRes.deletedStagingCount, 1);
    assert.equal(changeRes.deletedDedupeCount, 1);
    assert.deepEqual(changeRes.retainedOutputIds, []);

    // Ledger row must be DELETED entirely
    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    assert.equal(ledgerMap.get(sourceId.toLowerCase()), undefined);

    // Staging must be empty for this source
    const staging = await sql`
      SELECT count(*)::int AS count FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(staging[0].count, 0);
  });

  // Test 18: Source content changed, published rows remain
  await t.test("Test 18: Source content changed, published rows remain -> ledger superseded with NEW hash and NEW agent, output_ids retained", async () => {
    const sourceId = randomUUID();
    const publishedOutputId = randomUUID();
    const unpublishedOutputId = randomUUID();
    const newAgentId = randomUUID();
    const newSha = "hash_v2_new";

    // 1 published + 1 unpublished staging row
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
      ) VALUES
        (${upgradeId}::uuid, ${sourceId}::uuid, ${publishedOutputId}::uuid, ${agentId}::uuid, '{"text":"pub"}'::jsonb, 'vec'::text, 'hash_v1', now(), now()),
        (${upgradeId}::uuid, ${sourceId}::uuid, ${unpublishedOutputId}::uuid, ${agentId}::uuid, '{"text":"unpub"}'::jsonb, 'vec'::text, 'hash_v1', NULL, now());
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at
      ) VALUES (${upgradeId}::uuid, ${sourceId}::uuid, 'hash_v1', ${agentId}::uuid, 'published', NULL, ${[publishedOutputId, unpublishedOutputId]}::uuid[], now(), now());
    `;

    const changeRes = await reconcileChangedContent(
      sql,
      { upgradeId, sourceId, sourceContentSha256: newSha, agentId: newAgentId },
      fence,
    );
    assert.equal(changeRes.deletedStagingCount, 1);
    assert.deepEqual(changeRes.retainedOutputIds, [publishedOutputId]);

    // Ledger row must be superseded with NEW hash and NEW agent
    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    const ledger = ledgerMap.get(sourceId.toLowerCase())!;
    assert.equal(ledger.outcome, "superseded");
    assert.equal(ledger.sourceContentSha256, newSha);
    assert.equal(ledger.agentId, newAgentId);
    assert.deepEqual(ledger.outputIds, [publishedOutputId]);
  });
});
