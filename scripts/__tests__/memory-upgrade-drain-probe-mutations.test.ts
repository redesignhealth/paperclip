/**
 * Drain probe mutations and superseded outcome tests (TECH-8191 §Q3, PR5.5).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runDrainProbe } from "../../server/src/services/company-memory-upgrade/drain-probe.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { ensureUpgradeTables } from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("late writes, content changes, and superseded outcomes block probe (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-mut-");
  const tenantSql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await fixture.cleanup();
  });

  const tableName = "mem0_memories";
  await setupTenantMem0Table(tenantSql, tableName);
  await ensureUpgradeTables(tenantSql, "text");

  const upgradeId = randomUUID();
  const agent1Id = randomUUID();
  const agent2Id = randomUUID();
  const cpAgentMap = new Map([
    [agent1Id.toLowerCase(), { id: agent1Id, name: "Agent 1", adapterType: "hermes_local", status: "active", pausedAt: null }],
    [agent2Id.toLowerCase(), { id: agent2Id, name: "Agent 2", adapterType: "hermes_local", status: "active", pausedAt: null }],
  ]);

  const sourceId = randomUUID();
  const data = "Base memory fact";
  const hash = computeSourceContentSha256(data);
  const outId = randomUUID();

  await insertTenantMemoryRow(tenantSql, { id: sourceId, tableName, agentId: agent1Id, userId: "company", data });
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at)
    VALUES (${upgradeId}::uuid, ${sourceId}::uuid, ${hash}, ${agent1Id}::uuid, 'published', NULL, ARRAY[${outId}::uuid], now(), now());
  `;
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, content_sha256, payload, embedding, published_at, created_at)
    VALUES (${upgradeId}::uuid, ${sourceId}::uuid, ${outId}::uuid, ${agent1Id}::uuid, ${hash}, '{"data":"x"}'::jsonb, 'vec', now(), now());
  `;

  // 1. Clean probe baseline
  const baseProbe = await runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap });
  assert.equal(baseProbe.blockingSources, 0);

  // 2. Late company write blocks
  const lateId = randomUUID();
  await insertTenantMemoryRow(tenantSql, { id: lateId, tableName, agentId: agent1Id, userId: "company", data: "Late write" });
  assert.equal((await runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap })).blockingSources, 1);
  await tenantSql`DELETE FROM mem0_memories WHERE id = ${lateId}::uuid`;

  // 3. Content change blocks
  await tenantSql`UPDATE mem0_memories SET payload = jsonb_set(payload, '{data}', to_jsonb('Edited data.'::text)) WHERE id = ${sourceId}::uuid;`;
  assert.equal((await runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap })).blockingSources, 1);
  await tenantSql`UPDATE mem0_memories SET payload = jsonb_set(payload, '{data}', to_jsonb('Base memory fact'::text)) WHERE id = ${sourceId}::uuid;`;

  // 4. Agent reassignment blocks
  await tenantSql`UPDATE mem0_memories SET payload = jsonb_set(payload, '{agent_id}', to_jsonb(${agent2Id}::text)) WHERE id = ${sourceId}::uuid;`;
  assert.equal((await runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap })).blockingSources, 1);
  await tenantSql`UPDATE mem0_memories SET payload = jsonb_set(payload, '{agent_id}', to_jsonb(${agent1Id}::text)) WHERE id = ${sourceId}::uuid;`;

  // 5. Superseded outcome blocks even when hash matches
  await tenantSql`UPDATE paperclip_memory_upgrade_ledger SET outcome = 'superseded' WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;`;
  assert.equal((await runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap })).blockingSources, 1);
  await tenantSql`UPDATE paperclip_memory_upgrade_ledger SET outcome = 'published' WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;`;
});
