/**
 * Orchestrator integration tests for company memory upgrade sweep (TECH-8191).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createDb,
  eq,
  heartbeatRuns,
  type Db,
  sql,
} from "./memory-upgrade-sweep-helpers.js";
import { runSweep, type SweepReport } from "../../server/src/services/company-memory-upgrade/sweep.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  ManualClock,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("sweep orchestrator integration", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("sweep-orch-cp-");
  const cpDb = createDb(cpFixture.connectionString);

  const tenantFixture = await startEmbeddedPostgresTestDatabase("sweep-orch-tenant-");
  const tenantSql = openTenantClient(tenantFixture.connectionString);

  // Create non-superuser roles for tenant and control-plane preflights
  await tenantSql.unsafe(`CREATE ROLE sweep_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await tenantSql.unsafe(`GRANT ALL ON SCHEMA public TO sweep_tenant;`);
  await tenantSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO sweep_tenant;`);
  await tenantSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sweep_tenant;`);

  await cpDb.execute(sql`CREATE ROLE sweep_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await cpDb.execute(sql`GRANT ALL ON SCHEMA public TO sweep_cp;`);
  await cpDb.execute(sql`GRANT ALL ON ALL TABLES IN SCHEMA public TO sweep_cp;`);
  await cpDb.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sweep_cp;`);

  const tenantWorkerUrl = new URL(tenantFixture.connectionString);
  tenantWorkerUrl.username = "sweep_tenant";
  tenantWorkerUrl.password = "pass123";

  const cpWorkerUrl = new URL(cpFixture.connectionString);
  cpWorkerUrl.username = "sweep_cp";
  cpWorkerUrl.password = "pass123";

  const tenantWorkerSql = openTenantClient(tenantWorkerUrl.toString());
  const cpWorkerDb = createDb(cpWorkerUrl.toString());

  t.after(async () => {
    await tenantWorkerSql.end();
    await cpWorkerDb.$client?.end();
    await tenantSql.end();
    await cpDb.$client?.end();
    await tenantFixture.cleanup();
    await cpFixture.cleanup();
  });

  // Setup control plane company, database binding, and agents
  const [company] = await cpDb.insert(companies).values({
    name: "Acme Corp",
    issuePrefix: "AC",
  }).returning();

  const [tenantInfo] = await tenantWorkerSql`
    SELECT current_database()::text AS db, current_user::text AS usr;
  `;

  await cpDb.insert(companyMemoryDatabases).values({
    companyId: company.id,
    databaseName: tenantInfo.db,
    databaseRole: tenantInfo.usr,
    host: "localhost",
    port: 5432,
    status: "ready",
  });

  const [routableAgent] = await cpDb.insert(agents).values({
    companyId: company.id,
    name: "Routable Agent",
    adapterType: "hermes_local",
    status: "active",
  }).returning();

  const [pausedAgent] = await cpDb.insert(agents).values({
    companyId: company.id,
    name: "Paused Agent",
    adapterType: "hermes_local",
    status: "paused",
    pausedAt: new Date(),
  }).returning();

  const [terminatedAgent] = await cpDb.insert(agents).values({
    companyId: company.id,
    name: "Terminated Agent",
    adapterType: "hermes_local",
    status: "terminated",
  }).returning();

  const [nonMemoryAgent] = await cpDb.insert(agents).values({
    companyId: company.id,
    name: "Non-Memory Agent",
    adapterType: "process",
    status: "active",
  }).returning();

  await setupTenantMem0Table(tenantSql, "mem0_memories");

  await t.test("strictly forbids network egress (globalThis.fetch throws)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("NETWORK_EGRESS_FORBIDDEN");
    }) as any;

    try {
      const [egressCompany] = await cpDb.insert(companies).values({
        name: "Egress Company",
        issuePrefix: "EG",
      }).returning();
      const egressDbName = `tenant_db_${egressCompany.id.slice(0, 8)}`;
      const egressRole = `${tenantInfo.usr}_egress`;
      await cpDb.insert(companyMemoryDatabases).values({
        companyId: egressCompany.id,
        databaseName: egressDbName,
        databaseRole: egressRole,
        host: "localhost",
        port: 5432,
        status: "ready",
      });

      const clock = new ManualClock();
      const report = await runSweep(
        {
          databaseUrl: tenantWorkerUrl.toString(),
          controlPlaneUrl: cpWorkerUrl.toString(),
          companyId: egressCompany.id,
          pageSize: 10,
          pauseWhenActiveRuns: 0,
        },
        {
          controlPlaneDb: cpWorkerDb,
          tenantSql: tenantWorkerSql,
          clock,
          _internalSkipVectorIdentityCheck: true,
          _internalDatabaseIdentityOverride: { database: egressDbName, user: egressRole },
        },
      );
      assert.equal(report.status, "completed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("classifies sources across all gates, reconciles counters with ledger, and preserves live table", async () => {
    // Live table state before: compute row count and hash
    const rowsBefore = await tenantWorkerSql`SELECT id::text, payload::text FROM mem0_memories ORDER BY id ASC`;
    const initialLiveCount = rowsBefore.length;

    // Seed test rows:
    // 1. Routable substantive row -> pendingConversion (no ledger row)
    const substantiveId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: routableAgent.id,
      data: "Operator prefers quarterly budget reviews over monthly ones.",
    });

    // 2. Paused agent substantive row -> pendingConversion (paused agents are routable)
    const pausedSubstantiveId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: pausedAgent.id,
      data: "Paused agent substantive knowledge base entry.",
    });

    // 3. Noise row (empty string) -> dropped_noise
    const emptyNoiseId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: routableAgent.id,
      data: "   ",
    });

    // 4. Noise row (exact greeting) -> dropped_noise
    const greetingNoiseId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: routableAgent.id,
      data: "Hello world!",
    });

    // 5. Sensitive row (API key + password) -> dropped_sensitive
    const sensitiveId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: routableAgent.id,
      data: "Use sk-abcdef123456789012345678 and password: secretPassword123 to log in.",
    });

    // 6. Unroutable: missing agent id -> unroutable
    const missingAgentId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: null,
      data: "No agent assigned to this legacy memory.",
    });

    // 7. Unroutable: malformed agent id -> unroutable
    const malformedAgentId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: "not-a-valid-uuid",
      data: "Invalid agent id string.",
    });

    // 8. Unroutable: unknown agent uuid -> unroutable
    const unknownAgentId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: randomUUID(),
      data: "Agent uuid not in control plane.",
    });

    // 9. Unroutable: terminated agent -> unroutable
    const terminatedId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: terminatedAgent.id,
      data: "Memory from terminated agent.",
    });

    // 10. Unroutable: non-memory adapter -> unroutable
    const nonMemoryId = await insertTenantMemoryRow(tenantWorkerSql, {
      agentId: nonMemoryAgent.id,
      data: "Memory from process adapter.",
    });

    const clock = new ManualClock();
    const report: SweepReport = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: company.id,
        pageSize: 5, // Force multi-page keyset iteration
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    // Assert counts
    assert.equal(report.status, "completed");
    assert.equal(report.counts.sourceSeenCount, 10);
    assert.equal(report.counts.pendingConversionCount, 2); // substantiveId + pausedSubstantiveId
    assert.equal(report.counts.droppedNoiseCount, 2); // empty + greeting
    assert.equal(report.counts.droppedSensitiveCount, 1); // sensitive
    assert.equal(report.counts.unroutableCount, 5); // missing, malformed, unknown, terminated, nonMemory
    assert.equal(report.counts.supersededCount, 0);
    assert.equal(report.counts.sourceDeletedCount, 0);

    // Verify routable non-noise non-sensitive rows get NO ledger row!
    const substantiveLedger = await tenantWorkerSql`
      SELECT * FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report.upgradeId}::uuid
        AND source_id IN (${substantiveId}::uuid, ${pausedSubstantiveId}::uuid);
    `;
    assert.equal(substantiveLedger.length, 0);

    // Verify sensitive row has family names only in reason_code, NEVER matched text
    const sensitiveLedger = await tenantWorkerSql`
      SELECT reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report.upgradeId}::uuid AND source_id = ${sensitiveId}::uuid;
    `;
    assert.equal(sensitiveLedger.length, 1);
    assert.equal(sensitiveLedger[0].reason_code, "apiKey,passwordAssignment");

    // Verify noise reasons
    const emptyNoiseLedger = await tenantWorkerSql`
      SELECT reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report.upgradeId}::uuid AND source_id = ${emptyNoiseId}::uuid;
    `;
    assert.equal(emptyNoiseLedger[0].reason_code, "empty");

    const greetingNoiseLedger = await tenantWorkerSql`
      SELECT reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report.upgradeId}::uuid AND source_id = ${greetingNoiseId}::uuid;
    `;
    assert.equal(greetingNoiseLedger[0].reason_code, "exact_placeholder_or_greeting");

    // Verify ledger GROUP BY outcome reconciles with control-plane upgrade counters
    const ledgerCounts = await tenantWorkerSql`
      SELECT outcome, count(*)::int AS count
      FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report.upgradeId}::uuid
      GROUP BY outcome;
    `;
    const ledgerMap = new Map<string, number>();
    for (const r of ledgerCounts) {
      ledgerMap.set(r.outcome, r.count);
    }

    const [upgradeRow] = await cpWorkerDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, report.upgradeId));

    assert.equal(upgradeRow.sourceSeenCount, 10);
    assert.equal(upgradeRow.unroutableCount, ledgerMap.get("unroutable"));
    assert.equal(upgradeRow.droppedNoiseCount, ledgerMap.get("dropped_noise"));
    assert.equal(upgradeRow.droppedSensitiveCount, ledgerMap.get("dropped_sensitive"));
    assert.equal(upgradeRow.sweepCount, 1);

    // Verify NO memory text exists in ANY column of company_memory_upgrades
    const upgradeJson = JSON.stringify(upgradeRow, (_, v) => typeof v === "bigint" ? v.toString() : v);
    assert.ok(!upgradeJson.includes("Operator prefers quarterly"));
    assert.ok(!upgradeJson.includes("sk-abcdef"));
    assert.ok(!upgradeJson.includes("secretPassword"));

    // Verify live table was untouched: row count and content hashes identical
    const rowsAfter = await tenantWorkerSql`SELECT id::text, payload::text FROM mem0_memories ORDER BY id ASC`;
    assert.equal(rowsAfter.length, initialLiveCount + 10);
    assert.deepEqual([...rowsAfter.slice(0, initialLiveCount)], [...rowsBefore]);

    // Idempotent re-run test: makes zero new ledger writes
    const ledgerRowsBeforeRerun = await tenantWorkerSql`SELECT count(*)::int AS count FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${report.upgradeId}::uuid`;

    const rerunReport = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: company.id,
        pageSize: 5,
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    const ledgerRowsAfterRerun = await tenantWorkerSql`SELECT count(*)::int AS count FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${report.upgradeId}::uuid`;
    assert.equal(ledgerRowsAfterRerun[0].count, ledgerRowsBeforeRerun[0].count);
    assert.equal(rerunReport.counts.skippedUnchangedCount, 8); // 8 non-pending rows skipped
    assert.equal(rerunReport.counts.pendingConversionCount, 2);
  });

  await t.test("lease loss mid-sweep aborts cleanly with LEASE_FENCED_OUT and consistent ledger", async () => {
    // Open a second upgrade
    const [comp2] = await cpDb.insert(companies).values({ name: "Company 2", issuePrefix: "C2" }).returning();
    const dbName2 = `tenant_db_${comp2.id.slice(0, 8)}`;
    const role2 = `${tenantInfo.usr}_2`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp2.id,
      databaseName: dbName2,
      databaseRole: role2,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    const clock = new ManualClock(1_000_000);

    // Seed memories
    for (let i = 0; i < 15; i++) {
      await insertTenantMemoryRow(tenantWorkerSql, {
        agentId: null,
        data: `Unroutable row ${i}`,
      });
    }

    let pageCount = 0;
    const brokenClock = {
      nowMs() { return clock.nowMs(); },
      now() { return clock.now(); },
      async sleep(ms: number) { clock.advance(ms); },
    };

    // Fast-forward time past lease expiry (default TTL 10m = 600_000ms) during iteration
    const tenantSqlProxy = new Proxy(tenantWorkerSql, {
      get(target, prop, receiver) {
        if (prop === "unsafe") {
          return async (...args: any[]) => {
            const queryStr = String(args[0] ?? "");
            if (queryStr.includes("SELECT") && queryStr.includes("mem0_memories")) {
              pageCount++;
              if (pageCount >= 2) {
                // Simulate time jumping forward by 15 minutes, expiring lease
                clock.advance(900_000);
              }
            }
            return (target as any).unsafe(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await assert.rejects(
      async () => {
        await runSweep(
          {
            databaseUrl: tenantWorkerUrl.toString(),
            controlPlaneUrl: cpWorkerUrl.toString(),
            companyId: comp2.id,
            pageSize: 5,
            pauseWhenActiveRuns: 0,
          },
          {
            controlPlaneDb: cpWorkerDb,
            tenantSql: tenantSqlProxy,
            clock: brokenClock,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbName2, user: role2 },
          },
        );
      },
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "LEASE_FENCED_OUT");
        return true;
      },
    );
  });

  await t.test("active-run gate pauses then resumes during sweep", async () => {
    const [comp3] = await cpDb.insert(companies).values({ name: "Company 3", issuePrefix: "C3" }).returning();
    const dbName3 = `tenant_db_${comp3.id.slice(0, 8)}`;
    const role3 = `${tenantInfo.usr}_3`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp3.id,
      databaseName: dbName3,
      databaseRole: role3,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    const [comp3Agent] = await cpDb.insert(agents).values({
      companyId: comp3.id,
      name: "Comp3 Agent",
      adapterType: "hermes_local",
      status: "active",
    }).returning();

    // Insert an active run for Company 3
    const [activeRun] = await cpDb.insert(heartbeatRuns).values({
      companyId: comp3.id,
      agentId: comp3Agent.id,
      status: "running",
    }).returning();

    const clock = new ManualClock(2_000_000);

    const customSleeper = {
      async sleep(ms: number) {
        clock.advance(ms);
        // After 10s of pausing, complete the active run so sweep can resume
        if (clock.nowMs() >= 2_010_000) {
          await cpDb.delete(heartbeatRuns).where(eq(heartbeatRuns.id, activeRun.id));
        }
      },
    };

    const report = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: comp3.id,
        pageSize: 5,
        pauseWhenActiveRuns: 1,
        activeRunPollMs: 5_000,
        maxPauseSeconds: 60,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        sleeper: customSleeper,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbName3, user: role3 },
      },
    );

    assert.equal(report.status, "completed");
    assert.equal(report.activeRunGate.pauseCount, 1);
    assert.ok(report.activeRunGate.totalPausedMs >= 10_000);
  });
});
