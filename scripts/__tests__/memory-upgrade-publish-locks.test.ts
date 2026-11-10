/**
 * Reconcile semantics: tombstone L1 advisory locking via unnest (TECH-8191).
 * Test 23 from §7.3.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ensureUpgradeTables,
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

test("tombstone L1 advisory locking (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("publish-locks-");
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

  // Test 23: Tombstone batches now take ascending L1 advisory locks
  await t.test("Test 23: Tombstone batches take ascending L1 advisory locks via unnest (blocks concurrent holder)", async () => {
    const sourceId = randomUUID();
    const sql2 = openTenantClient(fixture.connectionString);

    t.after(async () => {
      await sql2.end();
    });

    // Mark sourceId in ledger
    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids, created_at, updated_at
      ) VALUES (${upgradeId}::uuid, ${sourceId}::uuid, 'h', ${agentId}::uuid, 'published', '{}', now(), now());
    `;

    // Connection 2 takes the per-source advisory lock
    const lockKey = `paperclip:memory-upgrade-source:${upgradeId.toLowerCase()}:${sourceId.toLowerCase()}`;
    await sql2.unsafe(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${lockKey}', 0));`);

    // Connection 1 attempts reconcileTombstones with lock_timeout set. It MUST block and time out (55P03)
    await sql.unsafe(`SET lock_timeout = '200ms';`);
    let threw55P03 = false;
    try {
      await reconcileTombstones(sql, upgradeId, { tombstoneSourceIds: [sourceId] }, fence);
    } catch (err: any) {
      // Postgres error code 55P03 is lock_not_available
      if (err?.code === "55P03" || String(err?.message).includes("lock timeout")) {
        threw55P03 = true;
      }
    } finally {
      await sql.unsafe(`SET lock_timeout = '5s';`);
    }

    assert.ok(threw55P03, "reconcileTombstones must take L1 advisory lock and block when held by another connection");

    // Release connection 2 lock
    await sql2.unsafe(`ROLLBACK;`);

    // Now reconcileTombstones must succeed
    const res = await reconcileTombstones(sql, upgradeId, { tombstoneSourceIds: [sourceId] }, fence);
    assert.equal(res.tombstonesCount, 1);
  });
});
