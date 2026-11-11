/**
 * Tenant publish conflict and fence safety tests (TECH-8191 PR 4b).
 * Tests 10 & 11 from plan §7.2: foreign ID collision and stale fence rejection.
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
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { seedLedgerRow, seedStagedMemory } from "./memory-upgrade-publish-helpers.js";

test("publish-tenant: foreign ID collisions and fence violations", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("pub-conflicts-");
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

  // Test 10: Foreign id collision
  const upgradeId = randomUUID();
  const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
  const agentId = randomUUID();
  const sourceId = randomUUID();

  const r = await seedStagedMemory(sql, { upgradeId, sourceId, agentId });
  await seedLedgerRow(sql, { upgradeId, sourceId, agentId, outcome: "published", outputIds: [r.outputId] });

  // Pre-insert foreign row with SAME id but DIFFERENT migration_id
  const foreignPayload = { data: "foreign memory", migration_id: randomUUID(), migrated_from: sourceId };
  await sql.unsafe(`INSERT INTO ${liveTable} (id, payload, vector) VALUES ($1::uuid, $2, $3)`, [
    r.outputId,
    foreignPayload,
    JSON.stringify(new Array(1536).fill(0.01)),
  ]);

  await assert.rejects(
    () => publishSourceBatch(sql, { upgradeId, sourceIds: [sourceId], tableName: liveTable, shape, vectorCast }, fence),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "PUBLISH_CONFLICT_UNEXPECTED",
  );

  const [{ count }] = (await sql`
    SELECT count(*)::int as count FROM paperclip_memory_upgrade_staging
    WHERE upgrade_id = ${upgradeId}::uuid AND published_at IS NULL;
  `) as Array<{ count: number }>;
  assert.equal(count, 1);

  const [liveRow] = (await sql.unsafe(`SELECT payload FROM ${liveTable} WHERE id = $1::uuid`, [r.outputId])) as any[];
  const parsed = typeof liveRow.payload === "string" ? JSON.parse(liveRow.payload) : liveRow.payload;
  assert.deepEqual(parsed, foreignPayload);

  // Test 11: Stale fence rejection
  const upgradeId2 = randomUUID();
  const staleFence = await claimTenantFenceForTestSetup(sql, upgradeId2);
  await claimTenantFenceForTestSetup(sql, upgradeId2); // Bump epoch

  const sourceId2 = randomUUID();
  const r2 = await seedStagedMemory(sql, { upgradeId: upgradeId2, sourceId: sourceId2, agentId });
  await seedLedgerRow(sql, { upgradeId: upgradeId2, sourceId: sourceId2, agentId, outcome: "published", outputIds: [r2.outputId] });

  await assert.rejects(
    () => publishSourceBatch(sql, { upgradeId: upgradeId2, sourceIds: [sourceId2], tableName: liveTable, shape, vectorCast }, staleFence),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );

  const liveRows = (await sql.unsafe(`SELECT id FROM ${liveTable} WHERE id = $1::uuid`, [r2.outputId])) as any[];
  assert.equal(liveRows.length, 0);
});
