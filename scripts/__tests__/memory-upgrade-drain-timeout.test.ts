/**
 * Mandated regressions for drain deadline timeout and lastError recording (TECH-8191 §Q3, PR5.7).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  agents,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  sql,
} from "./memory-upgrade-sweep-helpers.js";
import { runDrain } from "../../server/src/services/company-memory-upgrade/drain.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";

test("drain timeout regression (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-timeout-reg");
  t.after(async () => {
    await env.cleanup();
  });

  const [t0Row] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
  const t0 = t0Row.t instanceof Date ? t0Row.t : new Date(t0Row.t);
  const markedAt = new Date(t0.getTime() - 25 * 3600_000); // 25 hours ago -> past 24h deadline
  const observedAt = new Date(t0.getTime() - 24 * 3600_000);

  await env.cpDb
    .update(companyMemoryDatabases)
    .set({
      scopeMigrationCompletedAt: markedAt,
      scopeMigrationMode: "copy",
      scopeMigrationAgentScopeObservedAt: observedAt,
      updatedAt: markedAt,
    })
    .where(eq(companyMemoryDatabases.companyId, env.company.id));

  const [hermesAgent] = await env.cpDb
    .insert(agents)
    .values({
      companyId: env.company.id,
      name: "Hermes Agent Timeout",
      adapterType: "hermes_local",
    })
    .returning();

  const [upgrade] = await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id,
      state: "draining",
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      markedAt,
      drainProbeStreakStartedAt: null,
      drainConfirmedAt: null,
    })
    .returning();

  const [blockingRun] = await env.cpDb
    .insert(heartbeatRuns)
    .values({
      companyId: env.company.id,
      agentId: hermesAgent.id,
      status: "running",
      startedAt: new Date(t0.getTime() - 26 * 3600_000),
      createdAt: new Date(t0.getTime() - 26 * 3600_000),
    })
    .returning();

  let errorLogs = "";
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errorLogs += args.map(String).join(" ") + "\n";
    origError(...args);
  };

  try {
    await assert.rejects(
      () =>
        runDrain(
          {
            companyId: env.company.id,
            confirm: env.company.id,
            once: true,
            maxDrainHours: 24,
            tenantDatabaseUrl: "postgres://unused",
            controlPlaneDatabaseUrl: "postgres://unused",
          },
          {
            cpDb: env.cpWorkerDb,
            tenantSql: env.tenantWorkerSql,
            _internalSkipVectorIdentityCheck: true,
          },
        ),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "DRAIN_TIMEOUT" &&
        err.message.includes("Drain deadline expired"),
    );
  } finally {
    console.error = origError;
  }

  // Assert blocking run IDs are printed
  assert.ok(errorLogs.includes(blockingRun.id));
  assert.ok(errorLogs.includes("[drain_timeout]"));

  // Verify upgrade state stays draining and lastError is drain_timeout
  const [afterTimeout] = await env.cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));
  assert.equal(afterTimeout.state, "draining");
  assert.equal(afterTimeout.lastError, "drain_timeout");

  // L1: another owner holds a live lease at the deadline; assert last_error is NOT written,
  // lease_token is unchanged (no theft), DRAIN_TIMEOUT is still thrown, and console.error
  // says persistence was not possible.
  await t.test("L1: another owner holds lease at deadline, never steal it", async () => {
    // Clear last_error and set a foreign lease
    const foreignLeaseToken = "foreign_lease_token_12345";
    await env.cpDb
      .update(companyMemoryUpgrades)
      .set({
        lastError: null,
        leaseToken: foreignLeaseToken,
        leaseOwner: "concurrent_worker",
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    let l1ErrorLogs = "";
    console.error = (...args: unknown[]) => {
      l1ErrorLogs += args.map(String).join(" ") + "\n";
      origError(...args);
    };

    try {
      await assert.rejects(
        () =>
          runDrain(
            {
              companyId: env.company.id,
              confirm: env.company.id,
              once: true,
              maxDrainHours: 24,
              tenantDatabaseUrl: "postgres://unused",
              controlPlaneDatabaseUrl: "postgres://unused",
            },
            {
              cpDb: env.cpWorkerDb,
              tenantSql: env.tenantWorkerSql,
              _internalSkipVectorIdentityCheck: true,
            },
          ),
        (err: any) =>
          err instanceof CompanyMemoryUpgradeError &&
          err.code === "DRAIN_TIMEOUT",
      );
    } finally {
      console.error = origError;
    }

    // lease_token remains untouched (no theft)
    const [upgradeAfterL1] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(upgradeAfterL1.leaseToken, foreignLeaseToken);
    assert.equal(upgradeAfterL1.lastError, null);

    // Diagnostic message emitted
    assert.ok(l1ErrorLogs.includes("[drain_timeout] last_error was NOT persisted"));
    assert.ok(l1ErrorLogs.includes("another worker holds the upgrade lease"));
  });
});
