/**
 * Drain probe published output exclusion tests (TECH-8191 §Q3, PR5.5).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runDrainProbe } from "../../server/src/services/company-memory-upgrade/drain-probe.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { ensureUpgradeTables } from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("published-output exclusion ignores upgrade outputs in live collection (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-probe-out-");
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

  // An upgrade-published output exists in the live table (even with legacy company user_id)
  const publishedOutputId = randomUUID();
  await insertTenantMemoryRow(tenantSql, { id: publishedOutputId, agentId, userId: "company", data: "Converted output memory" });
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, content_sha256, payload, embedding, published_at, created_at)
    VALUES (${upgradeId}::uuid, ${randomUUID()}::uuid, ${publishedOutputId}::uuid, ${agentId}::uuid, 'outhash', '{"data":"out"}'::jsonb, 'vec', now(), now());
  `;

  // Must NOT be counted as an unledgered source
  const result = await runDrainProbe(tenantSql, { upgradeId, tableName: "mem0_memories", cpAgentMap });
  assert.equal(result.blockingSources, 0);
  assert.equal(result.missingScopeBlockingSources, 0);
});
