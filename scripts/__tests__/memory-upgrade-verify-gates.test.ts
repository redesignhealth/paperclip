/**
 * Verification gate refusals V1, V2, V3, V7 and state mismatch (TECH-8191 §Q4).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runVerify } from "../../server/src/services/company-memory-upgrade/verify.js";
import { claimUpgradeLease } from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("verify CP gate refusals (V1, V2, V3, V7, state)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("v-gates");
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
    embeddingDimensions: 1536, markedAt, drainConfirmedAt: t0,
  }).returning();

  const verifyCall = (isDryRun = true) =>
    runVerify(
      { companyId: env.company.id, confirm: isDryRun ? undefined : env.company.id, dryRun: isDryRun, tenantDatabaseUrl: "postgres://unused", controlPlaneDatabaseUrl: "postgres://unused" },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );

  await t.test("refuses when upgrade state is neither draining nor verified", async () => {
    await env.cpDb.update(companyMemoryUpgrades).set({ state: "sweeping" }).where(eq(companyMemoryUpgrades.id, upgrade.id));
    await assert.rejects(() => verifyCall(), (err: any) => err?.code === "STATE_MISMATCH" && err?.message.includes("not in draining or verified state"));
    await env.cpDb.update(companyMemoryUpgrades).set({ state: "draining" }).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });

  await t.test("V1 refusal: drain_confirmed_at IS NULL", async () => {
    await env.cpDb.update(companyMemoryUpgrades).set({ drainConfirmedAt: null }).where(eq(companyMemoryUpgrades.id, upgrade.id));
    await assert.rejects(() => verifyCall(), (err: any) => err?.code === "DRAIN_NOT_CONFIRMED" && err?.message.includes("drain has not been confirmed"));
    await env.cpDb.update(companyMemoryUpgrades).set({ drainConfirmedAt: new Date(t0.getTime() - 10 * 60_000) }).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });

  await t.test("V2 refusal: agent scope not observed after flip", async () => {
    await env.cpDb.update(companyMemoryDatabases).set({ scopeMigrationAgentScopeObservedAt: null }).where(eq(companyMemoryDatabases.companyId, env.company.id));
    await assert.rejects(() => verifyCall(), (err: any) => err?.code === "AGENT_SCOPE_NOT_OBSERVED");
    await env.cpDb.update(companyMemoryDatabases).set({ scopeMigrationAgentScopeObservedAt: observedAt }).where(eq(companyMemoryDatabases.companyId, env.company.id));
  });

  await t.test("V3 refusal: scope migration marker mode changed", async () => {
    await env.cpDb.update(companyMemoryDatabases).set({ scopeMigrationMode: "invalid" }).where(eq(companyMemoryDatabases.companyId, env.company.id));
    await assert.rejects(() => verifyCall(), (err: any) => err?.code === "FLIP_MARKER_MISSING");
    await env.cpDb.update(companyMemoryDatabases).set({ scopeMigrationMode: "copy" }).where(eq(companyMemoryDatabases.companyId, env.company.id));
  });

  await t.test("V7 refusal: lease held by another worker on confirmed run", async () => {
    await claimUpgradeLease(env.cpDb, { upgradeId: upgrade.id, leaseOwner: "worker_b", ttlMs: 60_000 });
    await assert.rejects(() => verifyCall(false), (err: any) => err?.code === "LEASE_FENCED_OUT");
  });
});
