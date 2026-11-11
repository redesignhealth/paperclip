/**
 * Drain probe staging and limit tests (TECH-8191 §Q3, PR5.5).
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

test("drain probe staging and limit (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-probe-stg-");
  const tenantSql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(tenantSql, "mem0_memories");
  await ensureUpgradeTables(tenantSql, "text");

  const upgradeId = randomUUID();
  const agentId = randomUUID();
  const cpAgentMap = new Map([[agentId.toLowerCase(), { id: agentId, name: "A", adapterType: "hermes_local", status: "active", pausedAt: null }]]);

  // 1. Pending publishable staging blocks
  const sId = randomUUID();
  const data = "Staged source";
  const hash = computeSourceContentSha256(data);
  const outId = randomUUID();

  await insertTenantMemoryRow(tenantSql, { id: sId, agentId, userId: "company", data });
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at)
    VALUES (${upgradeId}::uuid, ${sId}::uuid, ${hash}, ${agentId}::uuid, 'published', 'converted', ARRAY[${outId}::uuid], now(), now());
  `;
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, content_sha256, payload, embedding, published_at, created_at)
    VALUES (${upgradeId}::uuid, ${sId}::uuid, ${outId}::uuid, ${agentId}::uuid, ${hash}, '{"data":"y"}'::jsonb, 'vec', NULL, now());
  `;

  const rBlocked = await runDrainProbe(tenantSql, { upgradeId, tableName: "mem0_memories", cpAgentMap });
  assert.equal(rBlocked.blockingSources, 1);
  assert.equal(rBlocked.pendingPublishableRows, 1);

  // Mark published -> clean
  await tenantSql`UPDATE paperclip_memory_upgrade_staging SET published_at = now() WHERE output_id = ${outId}::uuid;`;
  const rClean = await runDrainProbe(tenantSql, { upgradeId, tableName: "mem0_memories", cpAgentMap });
  assert.equal(rClean.blockingSources, 0);
  assert.equal(rClean.pendingPublishableRows, 0);

  // 2. Quarantined staging with published_at = NULL must NOT block
  const qSourceId = randomUUID();
  const qOutId = randomUUID();
  const qData = "Quarantined row";
  const qHash = computeSourceContentSha256(qData);
  await insertTenantMemoryRow(tenantSql, { id: qSourceId, agentId, userId: "company", data: qData });
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at)
    VALUES (${upgradeId}::uuid, ${qSourceId}::uuid, ${qHash}, ${agentId}::uuid, 'quarantined', 'sensitive_data', ARRAY[${qOutId}::uuid], now(), now());
  `;
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, content_sha256, payload, embedding, published_at, created_at)
    VALUES (${upgradeId}::uuid, ${qSourceId}::uuid, ${qOutId}::uuid, ${agentId}::uuid, ${qHash}, '{"data":"q"}'::jsonb, 'vec', NULL, now());
  `;

  const rQuarantine = await runDrainProbe(tenantSql, { upgradeId, tableName: "mem0_memories", cpAgentMap });
  assert.equal(rQuarantine.blockingSources, 0);
  assert.equal(rQuarantine.pendingPublishableRows, 0);

  // 3. Limit is honoured
  const id1 = randomUUID();
  const id2 = randomUUID();
  await insertTenantMemoryRow(tenantSql, { id: id1, agentId, userId: "company", data: "Row 1" });
  await insertTenantMemoryRow(tenantSql, { id: id2, agentId, userId: "company", data: "Row 2" });

  const res = await runDrainProbe(tenantSql, { upgradeId, tableName: "mem0_memories", cpAgentMap, limit: 1 });
  assert.equal(res.blockingSources, 1);
  assert.equal(res.limitReached, true);
});
