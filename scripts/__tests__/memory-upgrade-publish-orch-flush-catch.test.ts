/**
 * Counter flush honesty on catch path (TECH-8191 review finding 3).
 * Verifies that when a CP flush fails after a successful tenant commit,
 * the catch path records the committed-but-unflushed counts exactly once along with lastError.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
} from "./memory-upgrade-sweep-helpers.js";
import { runPublish } from "../../server/src/services/company-memory-upgrade/publish.js";
import {
  seedLedgerRow,
  seedStagedMemory,
  setupPublishTestEnvironment,
} from "./memory-upgrade-publish-helpers.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";

test("publish orchestrator: CP flush failure once after tenant commit preserves committed deltas on catch path", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-flush-catch");
  t.after(async () => {
    await env.cleanup();
  });

  const [upgrade] = await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id,
      state: "sweeping",
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      publishedCount: 0,
    })
    .returning();

  const src1 = randomUUID();
  const text1 = "Committed memory content";
  await insertTenantMemoryRow(env.tenantSql, { id: src1, agentId: env.agent.id, data: text1 });
  const r1 = await seedStagedMemory(env.tenantSql, { upgradeId: upgrade.id, sourceId: src1, agentId: env.agent.id });
  await seedLedgerRow(env.tenantSql, {
    upgradeId: upgrade.id,
    sourceId: src1,
    agentId: env.agent.id,
    outcome: "published",
    outputIds: [r1.outputId],
    sourceContentSha256: computeSourceContentSha256(text1),
  });

  // Intercept cpWorkerDb.update to fail the first flushPending call after tenant commit,
  // then allow the subsequent call (in catch block) to succeed.
  let updateAttempts = 0;
  const originalUpdate = env.cpWorkerDb.update.bind(env.cpWorkerDb);
  (env.cpWorkerDb as any).update = (table: any) => {
    const builder = originalUpdate(table);
    if (table === companyMemoryUpgrades) {
      const originalSet = builder.set.bind(builder);
      builder.set = (values: any) => {
        const setBuilder = originalSet(values);
        const originalReturning = setBuilder.returning.bind(setBuilder);
        setBuilder.returning = async (...args: any[]) => {
          // If this update contains publishedCount delta, intercept the first one
          if (values.publishedCount !== undefined) {
            updateAttempts++;
            if (updateAttempts === 1) {
              throw new CompanyMemoryUpgradeError(
                "Simulated CP flush failure after tenant commit",
                "UNEXPECTED_FAILURE",
              );
            }
          }
          return await originalReturning(...args);
        };
        return setBuilder;
      };
    }
    return builder;
  };

  await assert.rejects(
    () =>
      runPublish(
        { companyId: env.company.id, confirm: env.company.id, batchSources: 1 },
        { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
      ),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNEXPECTED_FAILURE",
  );

  // Assert:
  // 1. Tenant commit succeeded (live memory row was inserted)
  const [liveMem] = (await env.tenantSql.unsafe(
    "SELECT id FROM mem0_memories WHERE id = $1::uuid",
    [r1.outputId],
  )) as any[];
  assert.ok(liveMem, "Tenant work was committed");

  // 2. CP update occurred on catch path with committedCount exactly once and mapped lastError
  const [upg] = await env.cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));

  assert.equal(upg.publishedCount, 1, "Committed delta recorded exactly once on catch path");
  assert.equal(upg.lastError, "unexpected_failure", "lastError recorded on catch path");
  assert.equal(updateAttempts, 2, "First flush failed, second flush in catch succeeded");
});
