/**
 * Multi-page UUID scan tests for company-scope filter and output exclusion (TECH-8191 §5.2).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { iterateSourcePages, openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { ensureUpgradeTables } from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("iterateSourcePages with onlyCompanyScope: UUID ID path multi-page keyset pagination", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("scan-scope-uuid-");
  const tenantSql = openTenantClient(fixture.connectionString);
  await setupTenantMem0Table(tenantSql, "mem0_memories");
  await ensureUpgradeTables(tenantSql, "text");

  t.after(async () => {
    await tenantSql.end();
    await fixture.cleanup();
  });

  const upgradeId = randomUUID();
  const agentId = randomUUID();

  // Create 4 company-scoped UUID rows
  const companyIds = Array.from({ length: 4 }, (_, i) => `${i + 1}0000000-0000-4000-8000-00000000000${i + 1}`);
  for (const id of companyIds) {
    await insertTenantMemoryRow(tenantSql, { id, agentId, userId: "company", data: `data-${id}` });
  }

  // Create agent-scoped rows (interleaved IDs)
  for (const id of ["15000000-0000-4000-8000-000000000001", "25000000-0000-4000-8000-000000000002"]) {
    await insertTenantMemoryRow(tenantSql, { id, agentId, userId: agentId, data: "agent" });
  }

  // Create rows with null user_id and missing payload (fail closed)
  await tenantSql`
    INSERT INTO mem0_memories (id, vector, payload)
    VALUES ('50000000-0000-4000-8000-000000000001'::uuid, '[]', '{"data": "missing"}'::jsonb),
           ('50000000-0000-4000-8000-000000000002'::uuid, '[]', '{"user_id": null}'::jsonb);
  `;

  // Create published output row
  const pubOutputId = "35000000-0000-4000-8000-000000000001";
  await insertTenantMemoryRow(tenantSql, { id: pubOutputId, agentId, userId: "company", data: "pub" });
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at)
    VALUES (${upgradeId}::uuid, ${randomUUID()}::uuid, ${pubOutputId}::uuid, ${agentId}::uuid, '{"data": "pub"}'::jsonb, 'vec', 'sha', now());
  `;

  // Keyset iterate with small page size (pageSize = 2) to force multi-page continuation
  const yielded: string[] = [];
  let pageCount = 0;
  for await (const page of iterateSourcePages(tenantSql, "mem0_memories", { pageSize: 2, isUuidId: true, onlyCompanyScope: true })) {
    pageCount++;
    for (const row of page) yielded.push(row.id);
  }

  assert.ok(pageCount >= 2);
  assert.deepEqual(yielded, companyIds, "Only company-scoped rows yielded in order");
});

test("generated-SQL shape: all three keyset branches include company scope filter", async () => {
  const executed: Array<{ query: string; params?: any[] }> = [];
  const fakeSql = {
    unsafe: async (query: string, params?: any[]) => {
      executed.push({ query, params });
      return [];
    },
  };

  // Branch 1: initial page (lastId === null), UUID id
  await iterateSourcePages(fakeSql as any, "mem0_memories", { pageSize: 50, isUuidId: true, onlyCompanyScope: true }).next();
  assert.ok(executed[0].query.includes("t.payload->>'user_id' = 'company'"));

  // Branch 2: continuation page (lastId !== null), UUID id
  executed.length = 0;
  await iterateSourcePages(fakeSql as any, "mem0_memories", {
    pageSize: 25, isUuidId: true, startAfterId: "11111111-1111-4111-8111-111111111111", onlyCompanyScope: true,
  }).next();
  assert.ok(executed[0].query.includes("t.payload->>'user_id' = 'company'"));
  assert.ok(executed[0].query.includes("WHERE t.id > $1::uuid"));

  // Branch 3: continuation page (lastId !== null), text id with COLLATE "C"
  executed.length = 0;
  await iterateSourcePages(fakeSql as any, "mem0_memories", {
    pageSize: 10, isUuidId: false, startAfterId: "legacy-source-042", onlyCompanyScope: true,
  }).next();
  assert.ok(executed[0].query.includes("t.payload->>'user_id' = 'company'"));
  assert.ok(executed[0].query.includes('WHERE lower(t.id::text) COLLATE "C" > $1::text COLLATE "C"'));
});
