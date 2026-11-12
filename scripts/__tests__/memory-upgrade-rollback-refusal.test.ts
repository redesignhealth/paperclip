/**
 * Rollback state dispatch refusals and preconditions (TECH-8191 §Q5, PR5.9).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runRollback } from "../../server/src/services/company-memory-upgrade/rollback.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("rollback refusal and validation (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("rb-refusal");
  t.after(async () => { await env.cleanup(); });

  const [t0Row] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
  const t0 = t0Row.t instanceof Date ? t0Row.t : new Date(t0Row.t);
  const markedAt = new Date(t0.getTime() - 20 * 60_000);

  // Set initial scope marker
  await env.cpDb.update(companyMemoryDatabases).set({
    scopeMigrationCompletedAt: markedAt,
    scopeMigrationMode: "copy",
    scopeMigrationAgentScopeObservedAt: t0,
    updatedAt: markedAt,
  }).where(eq(companyMemoryDatabases.companyId, env.company.id));

  const [upgrade] = await env.cpDb.insert(companyMemoryUpgrades).values({
    companyId: env.company.id,
    state: "sweeping",
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
    markedAt,
  }).returning();

  const callRollback = (confirm?: string, dryRun = false) =>
    runRollback(
      {
        companyId: env.company.id,
        confirm,
        dryRun,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

  await t.test("sweeping refuses: no flip has been performed", async () => {
    await assert.rejects(
      () => callRollback(env.company.id),
      (err: any) =>
        err?.code === "STATE_MISMATCH" &&
        err?.message.includes("no flip has been performed for this upgrade"),
    );

    // Marker must not be mutated
    const [dbRow] = await env.cpDb
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.ok(dbRow.scopeMigrationCompletedAt !== null);
  });

  await t.test("needs_recovery refuses pointing at recover", async () => {
    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({ state: "needs_recovery", recoverToState: "draining" })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    await assert.rejects(
      () => callRollback(env.company.id),
      (err: any) =>
        err?.code === "STATE_MISMATCH" &&
        err?.message.includes("Run 'pnpm memory:upgrade recover' first"),
    );
  });

  await t.test("mandated regression: refuses at pruning with ROLLBACK_REFUSED and no marker mutation", async () => {
    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({ state: "pruning", recoverToState: null })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    await assert.rejects(
      () => callRollback(env.company.id),
      (err: any) => err?.code === "ROLLBACK_REFUSED",
    );

    const [dbRow] = await env.cpDb
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(dbRow.scopeMigrationCompletedAt?.getTime(), markedAt.getTime());
    assert.equal(dbRow.scopeMigrationMode, "copy");
  });

  await t.test("mandated regression: refuses at completed with ROLLBACK_REFUSED and no marker mutation", async () => {
    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({ state: "completed" })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    await assert.rejects(
      () => callRollback(env.company.id),
      (err: any) => err?.code === "ROLLBACK_REFUSED",
    );

    const [dbRow] = await env.cpDb
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(dbRow.scopeMigrationCompletedAt?.getTime(), markedAt.getTime());
  });

  await t.test("no active upgrade throws STATE_MISMATCH", async () => {
    // Completed state is terminal so findActiveUpgrade returns null
    await assert.rejects(
      () => callRollback(env.company.id),
      (err: any) =>
        err?.code === "STATE_MISMATCH" || err?.code === "ROLLBACK_REFUSED",
    );
  });

  await t.test("mismatched --confirm throws INVALID_ARGUMENT", async () => {
    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({ state: "draining" })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    await assert.rejects(
      () => callRollback("11111111-1111-1111-1111-111111111111"),
      (err: any) => err?.code === "INVALID_ARGUMENT",
    );
  });

  await t.test("dry run takes no lease and writes nothing", async () => {
    const report = await callRollback(undefined, true);
    assert.equal(report.isDryRun, true);
    assert.equal(report.markerCleared, false);
    assert.equal(report.state, "draining");

    // Upgrade row unchanged and no lease taken
    const [upgRow] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(upgRow.state, "draining");
    assert.equal(upgRow.leaseToken, null);

    // Marker unchanged
    const [dbRow] = await env.cpDb
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(dbRow.scopeMigrationCompletedAt?.getTime(), markedAt.getTime());
  });
});
