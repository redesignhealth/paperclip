/**
 * Drain probe preflight, missing table refusal, and read-only property (TECH-8191 §Q3, PR5.5).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  countPublishPending,
  runDrainProbe,
} from "../../server/src/services/company-memory-upgrade/drain-probe.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { ensureUpgradeTables } from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("drain probe preflight, table refusal, and read-only property (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-probe-pfl-");
  const tenantSql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await fixture.cleanup();
  });

  const upgradeId = randomUUID();
  const cpAgentMap = new Map();

  // 1. Live table does not exist -> LIVE_TABLE_MISSING
  await assert.rejects(
    async () => runDrainProbe(tenantSql, { upgradeId, tableName: "missing_memories", cpAgentMap }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LIVE_TABLE_MISSING",
  );

  await setupTenantMem0Table(tenantSql, "mem0_memories");

  // 2. Ledger and staging tables do not exist -> TABLE_NOT_FOUND without DDL
  await assert.rejects(
    async () => runDrainProbe(tenantSql, { upgradeId, tableName: "mem0_memories", cpAgentMap }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "TABLE_NOT_FOUND",
  );

  const [check] = await tenantSql`
    SELECT to_regclass('paperclip_memory_upgrade_ledger') AS ledger_rel,
           to_regclass('paperclip_memory_upgrade_staging') AS staging_rel;
  `;
  assert.equal(check.ledger_rel, null);
  assert.equal(check.staging_rel, null);

  // 3. Read-only property in read-only transaction
  await ensureUpgradeTables(tenantSql, "text");
  await tenantSql.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY;");
    const result = await runDrainProbe(tx as any, { upgradeId, tableName: "mem0_memories", cpAgentMap });
    assert.equal(result.blockingSources, 0);
    assert.equal(result.missingScopeBlockingSources, 0);
    assert.equal(result.pendingPublishableRows, 0);
    assert.equal(result.limitReached, false);
    assert.ok(result.probedAt instanceof Date);
  });

  // 4. Argument validation
  await assert.rejects(
    async () => runDrainProbe(tenantSql, { upgradeId: "not-a-uuid", tableName: "mem0_memories", cpAgentMap }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    async () => runDrainProbe(tenantSql, { upgradeId, tableName: "mem0_memories", cpAgentMap: undefined as any }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    async () => runDrainProbe(tenantSql, { upgradeId, tableName: "bad--ident;drop", cpAgentMap }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    async () => countPublishPending(tenantSql, "not-a-uuid"),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
});
