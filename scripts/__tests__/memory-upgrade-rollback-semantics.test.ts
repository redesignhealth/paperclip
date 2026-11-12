/**
 * Rollback state semantics, step ordering, lease fencing, and crash-resumption (TECH-8191 §Q5, PR5.9).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runRollback } from "../../server/src/services/company-memory-upgrade/rollback.js";
import { claimUpgradeLease } from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("rollback semantics, ordering, and lease fencing (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("rb-semantics");
  t.after(async () => { await env.cleanup(); });

  const [t0Row] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
  const t0 = t0Row.t instanceof Date ? t0Row.t : new Date(t0Row.t);
  const markedAt = new Date(t0.getTime() - 15 * 60_000);
  const observedAt = new Date(t0.getTime() - 10 * 60_000);

  // Setup marker
  await env.cpDb.update(companyMemoryDatabases).set({
    scopeMigrationCompletedAt: markedAt,
    scopeMigrationMode: "copy",
    scopeMigrationAgentScopeObservedAt: observedAt,
    updatedAt: markedAt,
  }).where(eq(companyMemoryDatabases.companyId, env.company.id));

  const [upgrade] = await env.cpDb.insert(companyMemoryUpgrades).values({
    companyId: env.company.id,
    state: "flipping",
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
    markedAt,
  }).returning();

  await t.test("flipping -> sweeping: marker cleared, lease released, state sweeping", async () => {
    const report = await runRollback(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    assert.equal(report.state, "sweeping");
    assert.equal(report.priorState, "flipping");
    assert.equal(report.markerCleared, true);

    const [dbRow] = await env.cpDb
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(dbRow.scopeMigrationCompletedAt, null);
    assert.equal(dbRow.scopeMigrationMode, null);
    // observedAt must be preserved
    assert.equal(dbRow.scopeMigrationAgentScopeObservedAt?.getTime(), observedAt.getTime());

    const [upgRow] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(upgRow.state, "sweeping");
    assert.equal(upgRow.leaseToken, null);
  });

  await t.test("draining -> rolled_back: marker cleared first, rolled_back_at set, lease cleared", async () => {
    // Re-set marker and move to draining
    await env.cpDb.update(companyMemoryDatabases).set({
      scopeMigrationCompletedAt: markedAt,
      scopeMigrationMode: "copy",
    }).where(eq(companyMemoryDatabases.companyId, env.company.id));

    await env.cpDb.update(companyMemoryUpgrades).set({
      state: "draining",
    }).where(eq(companyMemoryUpgrades.id, upgrade.id));

    const stepOrder: string[] = [];
    const report = await runRollback(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
        _internalStepHook: async (step) => {
          stepOrder.push(step);
        },
      },
    );

    assert.deepEqual(stepOrder, ["clear_marker", "advance_state"]);
    assert.equal(report.state, "rolled_back");
    assert.equal(report.priorState, "draining");
    assert.ok(report.rolledBackAt !== null);

    const [dbRow] = await env.cpDb
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(dbRow.scopeMigrationCompletedAt, null);
    assert.equal(dbRow.scopeMigrationMode, null);
    assert.equal(dbRow.scopeMigrationAgentScopeObservedAt?.getTime(), observedAt.getTime());

    const [upgRow] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(upgRow.state, "rolled_back");
    assert.ok(upgRow.rolledBackAt !== null);
    assert.equal(upgRow.leaseToken, null);
  });

  await t.test("verified -> rolled_back: transitions cleanly", async () => {
    // Move to verified with marker set
    await env.cpDb.update(companyMemoryDatabases).set({
      scopeMigrationCompletedAt: markedAt,
      scopeMigrationMode: "copy",
    }).where(eq(companyMemoryDatabases.companyId, env.company.id));

    await env.cpDb.update(companyMemoryUpgrades).set({
      state: "verified",
      rolledBackAt: null,
    }).where(eq(companyMemoryUpgrades.id, upgrade.id));

    const report = await runRollback(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    assert.equal(report.state, "rolled_back");
    assert.equal(report.priorState, "verified");

    const [dbRow] = await env.cpDb
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(dbRow.scopeMigrationCompletedAt, null);
  });

  await t.test("crash between marker clear and advance is resumable", async () => {
    // Simulate crash: reset state to draining with marker set
    await env.cpDb.update(companyMemoryDatabases).set({
      scopeMigrationCompletedAt: markedAt,
      scopeMigrationMode: "copy",
    }).where(eq(companyMemoryDatabases.companyId, env.company.id));

    await env.cpDb.update(companyMemoryUpgrades).set({
      state: "draining",
      rolledBackAt: null,
    }).where(eq(companyMemoryUpgrades.id, upgrade.id));

    // First attempt: simulate crash during advance_state
    await assert.rejects(
      () =>
        runRollback(
          {
            companyId: env.company.id,
            confirm: env.company.id,
            tenantDatabaseUrl: "postgres://unused",
            controlPlaneDatabaseUrl: "postgres://unused",
          },
          {
            cpDb: env.cpWorkerDb,
            tenantSql: env.tenantWorkerSql,
            _internalSkipVectorIdentityCheck: true,
            _internalStepHook: async (step) => {
              if (step === "advance_state") {
                throw new Error("simulated_crash_after_marker_clear");
              }
            },
          },
        ),
      /simulated_crash_after_marker_clear/,
    );

    // Marker was already cleared in DB, state is still draining
    const [crashDbRow] = await env.cpDb
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(crashDbRow.scopeMigrationCompletedAt, null);

    const [crashUpgRow] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(crashUpgRow.state, "draining");

    // Second attempt: resumes and completes advance to rolled_back
    const resumeReport = await runRollback(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    assert.equal(resumeReport.state, "rolled_back");
    const [finalUpgRow] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(finalUpgRow.state, "rolled_back");
  });

  await t.test("lease-fenced clear: lease taken by another worker throws LEASE_FENCED_OUT and leaves marker intact", async () => {
    // Reset marker and state to draining
    await env.cpDb.update(companyMemoryDatabases).set({
      scopeMigrationCompletedAt: markedAt,
      scopeMigrationMode: "copy",
    }).where(eq(companyMemoryDatabases.companyId, env.company.id));

    await env.cpDb.update(companyMemoryUpgrades).set({
      state: "draining",
      rolledBackAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    }).where(eq(companyMemoryUpgrades.id, upgrade.id));

    await assert.rejects(
      () =>
        runRollback(
          {
            companyId: env.company.id,
            confirm: env.company.id,
            tenantDatabaseUrl: "postgres://unused",
            controlPlaneDatabaseUrl: "postgres://unused",
          },
          {
            cpDb: env.cpWorkerDb,
            tenantSql: env.tenantWorkerSql,
            _internalSkipVectorIdentityCheck: true,
            _internalPostClaimHook: async () => {
              // Intervene after rollback claims lease: another worker takes over the lease
              await env.cpDb.update(companyMemoryUpgrades).set({
                leaseToken: "rogue-token-takeover",
                leaseOwner: "rogue-worker",
              }).where(eq(companyMemoryUpgrades.id, upgrade.id));
            },
          },
        ),
      (err: any) => err?.code === "LEASE_FENCED_OUT",
    );

    // Marker must remain untouched!
    const [dbRow] = await env.cpDb
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(dbRow.scopeMigrationCompletedAt?.getTime(), markedAt.getTime());
    assert.equal(dbRow.scopeMigrationMode, "copy");
  });
});
