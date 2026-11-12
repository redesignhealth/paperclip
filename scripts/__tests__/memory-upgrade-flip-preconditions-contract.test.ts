/**
 * Flip precondition assertions: P4 state, P5 converter contract, P8 marker (TECH-8191 §Q2, PR5.6).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { assertFlipPreconditions } from "../../server/src/services/company-memory-upgrade/flip-preconditions.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { ensureUpgradeTables } from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("flip preconditions state, contract, and marker (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("flip-pre-con-");
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
  const cpAgentMap = new Map([
    [agentId.toLowerCase(), { id: agentId, name: "Hermes", adapterType: "hermes_local", status: "active", pausedAt: null }],
  ]);

  const baseUpgrade: any = {
    id: upgradeId,
    companyId,
    state: "sweeping",
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  };

  // 1. Refuses on converter contract mismatch (P5)
  await t.test("refuses on converter contract mismatch", async () => {
    await assert.rejects(
      () => assertFlipPreconditions({ upgrade: { ...baseUpgrade, converterId: "wrong" }, marker: null, tenantSql, tableName: "mem0_memories", cpAgentMap }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "CONVERTER_CONTRACT_MISMATCH",
    );
    await assert.rejects(
      () => assertFlipPreconditions({ upgrade: { ...baseUpgrade, collectionName: "other" }, marker: null, tenantSql, tableName: "mem0_memories", cpAgentMap }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "CONVERTER_CONTRACT_MISMATCH",
    );
  });

  // 2. Refuses when marker is already set while state is sweeping (P8)
  await t.test("refuses when marker is already set while state is sweeping", async () => {
    await assert.rejects(
      () => assertFlipPreconditions({
        upgrade: { ...baseUpgrade, state: "sweeping" },
        marker: { completedAt: new Date(), mode: "copy", agentScopeObservedAt: null },
        tenantSql, tableName: "mem0_memories", cpAgentMap,
      }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "FLIP_PRECONDITION_FAILED",
    );
  });

  // 3. Passes when state is flipping even if marker is already set (crash resume)
  await t.test("passes when state is flipping and marker is set (resumable)", async () => {
    const res = await assertFlipPreconditions({
      upgrade: { ...baseUpgrade, state: "flipping" },
      marker: { completedAt: new Date(), mode: "copy", agentScopeObservedAt: null },
      tenantSql, tableName: "mem0_memories", cpAgentMap,
    });
    assert.equal(res.pending.pendingRows, 0);
  });

  // 4. Refuses when state is not sweeping or flipping (P4)
  await t.test("refuses when state is draining or needs_recovery", async () => {
    await assert.rejects(
      () => assertFlipPreconditions({ upgrade: { ...baseUpgrade, state: "draining" }, marker: null, tenantSql, tableName: "mem0_memories", cpAgentMap }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STATE_MISMATCH" && err.message.includes("Cannot run flip"),
    );
  });
});
