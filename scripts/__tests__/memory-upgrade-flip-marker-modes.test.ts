/**
 * Flip precondition marker mode matching and confirm validation tests
 * (TECH-8191 review findings 2 and 4).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { assertFlipPreconditions } from "../../server/src/services/company-memory-upgrade/flip-preconditions.js";
import { runFlip } from "../../server/src/services/company-memory-upgrade/flip.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { ensureUpgradeTables } from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  companyMemoryUpgrades,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("flip preconditions marker mode matching and confirm arg (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("flip-marker-modes-");
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
    state: "flipping",
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  };

  // finding 2: existing marker with different mode refuses in flipping state
  await t.test("finding 2: existing marker with different mode refuses", async () => {
    await assert.rejects(
      () =>
        assertFlipPreconditions({
          upgrade: baseUpgrade,
          marker: { completedAt: new Date(), mode: "dual", agentScopeObservedAt: null },
          tenantSql,
          tableName: "mem0_memories",
          cpAgentMap,
        }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "FLIP_PRECONDITION_FAILED",
    );
  });

  // finding 2: existing marker with NULL mode refuses in flipping state
  await t.test("finding 2: existing marker with NULL mode refuses", async () => {
    await assert.rejects(
      () =>
        assertFlipPreconditions({
          upgrade: baseUpgrade,
          marker: { completedAt: new Date(), mode: null, agentScopeObservedAt: null },
          tenantSql,
          tableName: "mem0_memories",
          cpAgentMap,
        }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "FLIP_PRECONDITION_FAILED",
    );
  });

  // finding 4: mismatched --confirm throws INVALID_ARGUMENT; absent --confirm stays dry run
  await t.test("finding 4: mismatched --confirm throws INVALID_ARGUMENT", async () => {
    const env = await setupPublishTestEnvironment("flip-confirm-arg");
    t.after(async () => {
      await env.cleanup();
    });

    await assert.rejects(
      () =>
        runFlip(
          {
            companyId: env.company.id,
            confirm: randomUUID(),
            controlPlaneDatabaseUrl: "postgres://unused",
            tenantDatabaseUrl: "postgres://unused",
            ackAgentScopeFlag: true,
          },
          { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "INVALID_ARGUMENT" &&
        err.message.includes("Confirmation company ID does not match target company ID"),
    );

    const [active] = await env.cpDb
      .insert(companyMemoryUpgrades)
      .values({
        companyId: env.company.id,
        state: "sweeping",
        converterId: "paperclip.memory-upgrade.atomic-converter",
        converterVersion: 1,
        collectionName: "mem0_memories",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
      })
      .returning();

    const dryReport = await runFlip(
      {
        companyId: env.company.id,
        controlPlaneDatabaseUrl: "postgres://unused",
        tenantDatabaseUrl: "postgres://unused",
      },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );
    assert.equal(dryReport.isDryRun, true);
  });
});
