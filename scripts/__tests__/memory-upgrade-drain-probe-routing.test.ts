/**
 * Drain probe routing dynamics and missing-scope isolation tests (TECH-8191 §Q3, PR5.5).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runDrainProbe } from "../../server/src/services/company-memory-upgrade/drain-probe.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { ensureUpgradeTables } from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("routing dynamics, newly known agent blocking, and missing-scope isolation (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-rot-");
  const tenantSql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await fixture.cleanup();
  });

  const tableName = "mem0_memories";
  await setupTenantMem0Table(tenantSql, tableName);
  await ensureUpgradeTables(tenantSql, "text");

  const upgradeId = randomUUID();
  const unknownAgentId = randomUUID();
  const data = "Routing dynamic fact";
  const hash = computeSourceContentSha256(data);
  const sourceId = randomUUID();

  // 1. Source initially has unknown agent: ledger outcome is unroutable with agent_id = NULL
  await insertTenantMemoryRow(tenantSql, { id: sourceId, tableName, agentId: unknownAgentId, userId: "company", data });
  await tenantSql`
    INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at)
    VALUES (${upgradeId}::uuid, ${sourceId}::uuid, ${hash}, NULL, 'unroutable', 'unknown_agent', '{}', now(), now());
  `;

  // Without agent in map: probe considers agent unroutable -> matches ledger null -> 0 blocking
  const emptyAgentMap = new Map();
  const probeUnmapped = await runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap: emptyAgentMap });
  assert.equal(probeUnmapped.blockingSources, 0);

  // REGRESSION: Agent becomes known in CP map -> probe sees matchedAgentId != NULL while ledger has NULL -> BLOCKS
  const updatedAgentMap = new Map([
    [unknownAgentId.toLowerCase(), { id: unknownAgentId, name: "Now Known", adapterType: "hermes_local", status: "active", pausedAt: null }],
  ]);
  const probeNowKnown = await runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap: updatedAgentMap });
  assert.equal(probeNowKnown.blockingSources, 1);

  // Mandatory map requirement: omitting map throws INVALID_ARGUMENT
  await assert.rejects(
    async () => runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap: undefined as any }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );

  // 2. Missing-scope unledgered row increments only separate missingScopeBlockingSources
  const missingScopeId = randomUUID();
  await tenantSql`
    INSERT INTO mem0_memories (id, payload, vector) VALUES (
      ${missingScopeId}::uuid,
      jsonb_build_object('agent_id', ${unknownAgentId}::text, 'data', 'Missing user_id legacy memory'),
      'vec'
    );
  `;
  const probeMissing = await runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap: emptyAgentMap });
  assert.equal(probeMissing.blockingSources, 0);
  assert.equal(probeMissing.missingScopeBlockingSources, 1);

  // 3. Native post-flip agent writes do not block
  const postFlipId = randomUUID();
  await insertTenantMemoryRow(tenantSql, { id: postFlipId, tableName, agentId: unknownAgentId, userId: unknownAgentId, data: "Post-flip write" });
  const probeNative = await runDrainProbe(tenantSql, { upgradeId, tableName, cpAgentMap: emptyAgentMap });
  assert.equal(probeNative.blockingSources, 0);
  assert.equal(probeNative.missingScopeBlockingSources, 1); // only missingScopeId from above
});
