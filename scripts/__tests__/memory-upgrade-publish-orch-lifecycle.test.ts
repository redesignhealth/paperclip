/**
 * Orchestrator lifecycle & state validation tests (TECH-8191 PR 4b).
 * Tests 32 & 33 from plan §7.5: never calls openUpgrade, rejects invalid state.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  companyMemoryUpgrades,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";
import { runPublish } from "../../server/src/services/company-memory-upgrade/publish.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("publish orchestrator: lifecycle state and admission checks", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-lifecycle");
  t.after(async () => {
    await env.cleanup();
  });

  // Test 32: No active upgrade -> STATE_MISMATCH and zero upgrades created
  await t.test("Test 32: no active upgrade throws STATE_MISMATCH and never creates upgrade row", async () => {
    await assert.rejects(
      () =>
        runPublish(
          { companyId: env.company.id, confirm: env.company.id },
          { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "STATE_MISMATCH" &&
        err.message.includes("No active memory upgrade for this company"),
    );

    // Verify publish never created an upgrade record
    const upgrades = await env.cpDb.select().from(companyMemoryUpgrades);
    assert.equal(upgrades.length, 0);
  });

  // Test 33: State needs_recovery or non-sweeping state -> STATE_MISMATCH, zero live rows
  await t.test("Test 33: state needs_recovery or non-sweeping throws STATE_MISMATCH", async () => {
    // Seed an upgrade in needs_recovery
    const [upgrade] = await env.cpDb
      .insert(companyMemoryUpgrades)
      .values({
        companyId: env.company.id,
        state: "needs_recovery",
        converterId: "paperclip.memory-upgrade.atomic-converter",
        converterVersion: 1,
        collectionName: "mem0_memories",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
      })
      .returning();

    await assert.rejects(
      () =>
        runPublish(
          { companyId: env.company.id, confirm: env.company.id },
          { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "STATE_MISMATCH" &&
        err.message.includes("active upgrade is not in sweeping state"),
    );

    // Verify zero live rows
    const [{ count }] = (await env.tenantSql.unsafe("SELECT count(*)::int as count FROM mem0_memories")) as any[];
    assert.equal(count, 0);
  });
});
