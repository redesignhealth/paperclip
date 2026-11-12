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

  // (d) Malformed non-object staging payload (json string root) rejects fail-closed with PUBLISH_LEDGER_INCONSISTENT
  const srcD = randomUUID();
  const outD = randomUUID();
  await sql.unsafe(`
    INSERT INTO paperclip_memory_upgrade_staging (
      upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, '"{\\"data\\":\\"malformed\\"}"'::jsonb, 'vec', 'shaD', NULL, now()
    );
  `, [upgradeId, srcD, outD, agentId]);
  await seedLedgerRow(sql, { upgradeId, sourceId: srcD, agentId, outcome: "published", outputIds: [outD] });

  const [{ count: liveBeforeD }] = (await sql.unsafe(`SELECT count(*)::int as count FROM ${liveTable}`)) as any[];

  await assert.rejects(
    () => publishSourceBatch(sql, { upgradeId, sourceIds: [srcD], tableName: liveTable, shape, vectorCast }, fence),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "PUBLISH_LEDGER_INCONSISTENT",
  );

  const [{ count: liveAfterD }] = (await sql.unsafe(`SELECT count(*)::int as count FROM ${liveTable}`)) as any[];
  assert.equal(liveAfterD, liveBeforeD);

  const [stagedD] = (await sql`
    SELECT published_at FROM paperclip_memory_upgrade_staging WHERE output_id = ${outD}::uuid;
  `) as Array<{ published_at: Date | null }>;
  assert.equal(stagedD.published_at, null);

  // (e) Multi-source batch with one valid and one malformed source rolls back atomically
  const srcValid = randomUUID();
  const rValid = await seedStagedMemory(sql, { upgradeId, sourceId: srcValid, agentId });
  await seedLedgerRow(sql, { upgradeId, sourceId: srcValid, agentId, outcome: "published", outputIds: [rValid.outputId] });

  const srcMalformed = randomUUID();
  const outMalformed = randomUUID();
  await sql.unsafe(`
    INSERT INTO paperclip_memory_upgrade_staging (
      upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, '"{\\"data\\":\\"bad\\"}"'::jsonb, 'vec', 'shaBad', NULL, now()
    );
  `, [upgradeId, srcMalformed, outMalformed, agentId]);
  await seedLedgerRow(sql, { upgradeId, sourceId: srcMalformed, agentId, outcome: "published", outputIds: [outMalformed] });

  const [{ count: liveBeforeMulti }] = (await sql.unsafe(`SELECT count(*)::int as count FROM ${liveTable}`)) as any[];

  await assert.rejects(
    () => publishSourceBatch(sql, { upgradeId, sourceIds: [srcValid, srcMalformed], tableName: liveTable, shape, vectorCast }, fence),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "PUBLISH_LEDGER_INCONSISTENT",
  );

  const [{ count: liveAfterMulti }] = (await sql.unsafe(`SELECT count(*)::int as count FROM ${liveTable}`)) as any[];
  assert.equal(liveAfterMulti, liveBeforeMulti);

  const liveMatches = (await sql.unsafe(
    `SELECT id FROM ${liveTable} WHERE id = ANY($1::uuid[])`,
    [[rValid.outputId, outMalformed]],
  )) as any[];
  assert.equal(liveMatches.length, 0);

  const unpubRows = (await sql`
    SELECT output_id, published_at
    FROM paperclip_memory_upgrade_staging
    WHERE output_id IN (${rValid.outputId}::uuid, ${outMalformed}::uuid);
  `) as Array<{ output_id: string; published_at: Date | null }>;
  assert.equal(unpubRows.length, 2);
  for (const row of unpubRows) {
    assert.equal(row.published_at, null);
  }

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
    const [row] = (await sql.unsafe(
      `SELECT payload, jsonb_typeof(payload) as payload_type FROM ${liveTable} WHERE id = $1::uuid`,
      [p.id],
    )) as any[];
    assert.equal(row.payload_type, "object");
    assert.equal(typeof row.payload, "object");
    assert.notEqual(row.payload, null);
    assert.deepEqual(row.payload, p.payload);
  }

  const [row2] = (await sql.unsafe(
    `SELECT payload, jsonb_typeof(payload) as payload_type FROM ${liveTable} WHERE id = $1::uuid`,
    [r2.outputId],
  )) as any[];
  assert.equal(row2.payload_type, "object");
  assert.equal(typeof row2.payload, "object");
  assert.notEqual(row2.payload, null);
  assert.deepEqual(row2.payload, r2.payload);
});
