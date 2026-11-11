/**
 * Tenant publish ledger consistency & untouched memories tests (TECH-8191 PR 4b).
 * Tests 12 & 13 from plan §7.2.
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

test("publish-tenant: ledger inconsistency and pre-existing live rows", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("pub-safety-");
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

  // Test 12: Ledger inconsistency (3 cases)
  const upgradeId = randomUUID();
  const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
  const agentId = randomUUID();

  // (a) Delete ledger row
  const srcA = randomUUID();
  await seedStagedMemory(sql, { upgradeId, sourceId: srcA, agentId });
  await assert.rejects(
    () => publishSourceBatch(sql, { upgradeId, sourceIds: [srcA], tableName: liveTable, shape, vectorCast }, fence),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "PUBLISH_LEDGER_INCONSISTENT",
  );

  // (b) Outcome !== 'published' (superseded)
  const srcB = randomUUID();
  const rB = await seedStagedMemory(sql, { upgradeId, sourceId: srcB, agentId });
  await seedLedgerRow(sql, { upgradeId, sourceId: srcB, agentId, outcome: "superseded", outputIds: [rB.outputId] });
  await assert.rejects(
    () => publishSourceBatch(sql, { upgradeId, sourceIds: [srcB], tableName: liveTable, shape, vectorCast }, fence),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "PUBLISH_LEDGER_INCONSISTENT",
  );

  // (c) Ledger agentId mismatch
  const srcC = randomUUID();
  const rC = await seedStagedMemory(sql, { upgradeId, sourceId: srcC, agentId });
  await seedLedgerRow(sql, { upgradeId, sourceId: srcC, agentId: randomUUID(), outcome: "published", outputIds: [rC.outputId] });
  await assert.rejects(
    () => publishSourceBatch(sql, { upgradeId, sourceIds: [srcC], tableName: liveTable, shape, vectorCast }, fence),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "PUBLISH_LEDGER_INCONSISTENT",
  );

  // Test 13: Pre-existing live rows untouched
  const preExisting = [
    { id: randomUUID(), payload: { text: "mem 1", unmanaged: true } },
    { id: randomUUID(), payload: { text: "mem 2", unmanaged: true } },
    { id: randomUUID(), payload: { text: "mem 3", unmanaged: true } },
  ];
  for (const p of preExisting) {
    await sql.unsafe(`INSERT INTO ${liveTable} (id, payload, vector) VALUES ($1::uuid, $2, $3)`, [
      p.id,
      p.payload,
      JSON.stringify(new Array(1536).fill(0.01)),
    ]);
  }

  const upgradeId2 = randomUUID();
  const fence2 = await claimTenantFenceForTestSetup(sql, upgradeId2);
  const agentId2 = randomUUID();
  const sourceId2 = randomUUID();
  const r2 = await seedStagedMemory(sql, { upgradeId: upgradeId2, sourceId: sourceId2, agentId: agentId2 });
  await seedLedgerRow(sql, { upgradeId: upgradeId2, sourceId: sourceId2, agentId: agentId2, outcome: "published", outputIds: [r2.outputId] });

  const [{ count: countBefore }] = (await sql.unsafe(`SELECT count(*)::int as count FROM ${liveTable}`)) as any[];

  await publishSourceBatch(sql, { upgradeId: upgradeId2, sourceIds: [sourceId2], tableName: liveTable, shape, vectorCast }, fence2);

  const [{ count: countAfter }] = (await sql.unsafe(`SELECT count(*)::int as count FROM ${liveTable}`)) as any[];
  assert.equal(countAfter, countBefore + 1);

  for (const p of preExisting) {
    const [row] = (await sql.unsafe(`SELECT payload FROM ${liveTable} WHERE id = $1::uuid`, [p.id])) as any[];
    const parsed = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    assert.deepEqual(parsed, p.payload);
  }
});
