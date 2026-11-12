import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { assertFlipPreconditions } from "../../server/src/services/company-memory-upgrade/flip-preconditions.js";
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

test("flip preconditions P6/P7 regressions (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("f-pre-reg-");
  const tenantSql = openTenantClient(fixture.connectionString);
  t.after(async () => {
    await tenantSql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(tenantSql, "mem0_memories");
  await ensureUpgradeTables(tenantSql, "text");

  const companyId = randomUUID();
  const upgradeId = randomUUID();
  const agentId = randomUUID();
  const cpAgentMap = new Map([[agentId.toLowerCase(), { id: agentId, adapterType: "hermes_local" } as any]]);

  const baseUpgrade: any = {
    id: upgradeId, companyId, state: "sweeping",
    converterId: "paperclip.memory-upgrade.atomic-converter", converterVersion: 1, collectionName: "mem0_memories",
  };

  await t.test("mandated regression: flip refuses with pending publishable rows", async () => {
    const sId = randomUUID(), outId = randomUUID(), hash = computeSourceContentSha256("P");
    await insertTenantMemoryRow(tenantSql, { id: sId, agentId, userId: "company", data: "P" });
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids) VALUES ('${upgradeId}', '${sId}', '${hash}', '${agentId}', 'published', 'converted', ARRAY['${outId}'::uuid]);` +
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, content_sha256, payload, embedding) VALUES ('${upgradeId}', '${sId}', '${outId}', '${agentId}', '${hash}', '{"data":"y"}', 'vec');`
    );

    await assert.rejects(
      () => assertFlipPreconditions({ upgrade: baseUpgrade, marker: null, tenantSql, tableName: "mem0_memories", cpAgentMap }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "FLIP_PRECONDITION_FAILED",
    );
    await tenantSql`UPDATE paperclip_memory_upgrade_staging SET published_at = now() WHERE output_id = ${outId}::uuid;`;
  });

  await t.test("mandated regression: flip passes when unpublished staging rows belong to quarantined", async () => {
    const qSourceId = randomUUID(), qOutId = randomUUID(), qHash = computeSourceContentSha256("Q");
    await insertTenantMemoryRow(tenantSql, { id: qSourceId, agentId, userId: "company", data: "Q" });
    await tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids) VALUES ('${upgradeId}', '${qSourceId}', '${qHash}', '${agentId}', 'quarantined', 'sensitive_data', ARRAY['${qOutId}'::uuid]);` +
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, content_sha256, payload, embedding) VALUES ('${upgradeId}', '${qSourceId}', '${qOutId}', '${agentId}', '${qHash}', '{"data":"q"}', 'vec');`
    );

    const res = await assertFlipPreconditions({ upgrade: baseUpgrade, marker: null, tenantSql, tableName: "mem0_memories", cpAgentMap });
    assert.equal(res.pending.pendingRows, 0);
    assert.equal(res.probe.blockingSources, 0);
  });

  await t.test("refuses on non-empty drain probe when unledgered company source exists", async () => {
    const uId = randomUUID();
    await insertTenantMemoryRow(tenantSql, { id: uId, agentId, userId: "company", data: "Late row" });

    await assert.rejects(
      () => assertFlipPreconditions({ upgrade: baseUpgrade, marker: null, tenantSql, tableName: "mem0_memories", cpAgentMap }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "FLIP_PRECONDITION_FAILED",
    );
  });
});
