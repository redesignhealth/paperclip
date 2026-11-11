/**
 * Tenant publish crash convergence test (TECH-8191 PR 4b).
 * Test 9 from plan §7.2: partial-crash convergence.
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
} from "../../server/src/services/company-memory-upgrade/publish-tenant.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { seedLedgerRow, seedStagedMemory } from "./memory-upgrade-publish-helpers.js";

test("publish-tenant: partial-crash convergence", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("pub-crash-");
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

  const r1 = await seedStagedMemory(sql, { upgradeId, sourceId, agentId });
  const r2 = await seedStagedMemory(sql, { upgradeId, sourceId, agentId });
  await seedLedgerRow(sql, { upgradeId, sourceId, agentId, outcome: "published", outputIds: [r1.outputId, r2.outputId] });

  // Simulate partial crash: r1 was inserted into live table before crash, but published_at was not committed
  await sql.unsafe(
    `INSERT INTO ${liveTable} (id, payload, vector) VALUES ($1::uuid, $2, $3);`,
    [r1.outputId, r1.payload, JSON.stringify(new Array(1536).fill(0.01))],
  );

  const res = await publishSourceBatch(
    sql,
    { upgradeId, sourceIds: [sourceId], tableName: liveTable, shape, vectorCast },
    fence,
  );

  assert.equal(res.insertedCount, 1);
  assert.equal(res.alreadyPresentCount, 1);
  assert.equal(res.publishedCount, 2);

  // Both staging rows marked published
  const remainingPending = await sql`
    SELECT count(*)::int as count FROM paperclip_memory_upgrade_staging
    WHERE upgrade_id = ${upgradeId}::uuid AND published_at IS NULL;
  `;
  assert.equal(remainingPending[0].count, 0);
});
