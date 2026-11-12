/**
 * V1 stale-confirmation refusal with active pre-flip runs (TECH-8191 Argus addition).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runVerify } from "../../server/src/services/company-memory-upgrade/verify.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("V1 stale-confirmation check refuses when pre-flip runs active", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("v-stale");
  t.after(async () => { await env.cleanup(); });

  const [t0Row] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
  const t0 = t0Row.t instanceof Date ? t0Row.t : new Date(t0Row.t);
  const markedAt = new Date(t0.getTime() - 30 * 60_000);
  const observedAt = new Date(t0.getTime() - 25 * 60_000);

  await env.cpDb.update(companyMemoryDatabases).set({
    scopeMigrationCompletedAt: markedAt, scopeMigrationMode: "copy", scopeMigrationAgentScopeObservedAt: observedAt, updatedAt: markedAt,
  }).where(eq(companyMemoryDatabases.companyId, env.company.id));

  const [upgrade] = await env.cpDb.insert(companyMemoryUpgrades).values({
    companyId: env.company.id, state: "draining", converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1, collectionName: "mem0_memories", embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536, markedAt, drainConfirmedAt: new Date(t0.getTime() - 10 * 60_000),
  }).returning();

  const [blockingRun] = await env.cpDb.insert(heartbeatRuns).values({
    companyId: env.company.id,
    agentId: env.agent.id,
    status: "running",
    startedAt: new Date(markedAt.getTime() - 10_000),
    createdAt: new Date(markedAt.getTime() - 20_000),
  }).returning();

  const verifyCall = () =>
    runVerify(
      { companyId: env.company.id, dryRun: true, tenantDatabaseUrl: "postgres://unused", controlPlaneDatabaseUrl: "postgres://unused" },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );

  await t.test("mandated check: active pre-flip run refuses despite drain_confirmed_at", async () => {
    await assert.rejects(
      () => verifyCall(),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "VERIFICATION_FAILED" &&
        err.message.includes("active pre-flip heartbeat runs are still running") &&
        err.message.includes(blockingRun.id) &&
        err.message.includes("running") &&
        err.message.includes("Drain confirmation is stale"),
    );
  });

  await t.test("once pre-flip run transitions to completed, verify succeeds", async () => {
    await env.cpDb.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, blockingRun.id));
    const rep = await verifyCall();
    assert.equal(rep.blockingRunsCount, 0);
    assert.equal(rep.state, "draining");
  });
});
