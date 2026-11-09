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
  createFakeConversionClient,
  createFakeEmbeddingClient,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  insertTenantMemoryRow,
  ManualClock,
  setupTenantMem0Table,
  sql,
  startEmbeddedPostgresTestDatabase,
  type Db,
} from "./memory-upgrade-sweep-helpers.js";
import { runSweep, type SweepReport } from "../../server/src/services/company-memory-upgrade/sweep.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

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
    let llmCalls = 0;
    let embCalls = 0;
    const conversionClient = createFakeConversionClient(() => {
      llmCalls++;
      return { status: "convert" };
    });
    const embeddingClient = createFakeEmbeddingClient();
    const origEmbed = embeddingClient.embed;
    embeddingClient.embed = async (txt: string) => {
      embCalls++;
      return origEmbed(txt);
    };

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
        conversionClient,
        embeddingClient,
      },
    );

    // Assert counts
    assert.equal(report.status, "completed");
    assert.equal(report.counts.sourceSeenCount, 10);
    assert.equal(report.counts.stagedPendingPublishCount, 2); // substantiveId + pausedSubstantiveId
    assert.equal(report.counts.droppedNoiseCount, 2); // empty + greeting
    assert.equal(report.counts.droppedSensitiveCount, 1); // sensitive
    assert.equal(report.counts.unroutableCount, 5); // missing, malformed, unknown, terminated, nonMemory
    assert.equal(report.counts.supersededCount, 0);
    assert.equal(report.counts.sourceDeletedCount, 0);

    // Verify routable non-noise non-sensitive rows get ledger rows with published and output_ids!
    const substantiveLedger = await tenantWorkerSql`
      SELECT * FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report.upgradeId}::uuid
        AND source_id = ANY(${[substantiveId, pausedSubstantiveId]}::uuid[]);
    `;
    assert.equal(substantiveLedger.length, 2);
    assert.equal(substantiveLedger[0].outcome, "published");
    assert.equal(substantiveLedger[1].outcome, "published");

    const stagedRows = await tenantWorkerSql`
      SELECT * FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${report.upgradeId}::uuid
        AND source_id = ANY(${[substantiveId, pausedSubstantiveId]}::uuid[]);
    `;
    assert.equal(stagedRows.length, 2);
    assert.equal(stagedRows[0].published_at, null);
    assert.equal(stagedRows[1].published_at, null);

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

    // Control plane upgrade counters track cumulative activity (transitions + classifications),
    // while the tenant upgrade ledger records the authoritative current partition.
    // On a clean first sweep without prior edits or superseded rows, initial classification activity
    // matches the initial ledger partition.
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
    assert.equal(upgradeRow.publishedCount, ledgerMap.get("published"));
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

    // Idempotent re-run test: makes ZERO new LLM calls and ZERO embedding calls
    const prevLlmCalls = llmCalls;
    const prevEmbCalls = embCalls;
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
        conversionClient,
        embeddingClient,
      },
    );

    const ledgerRowsAfterRerun = await tenantWorkerSql`SELECT count(*)::int AS count FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${report.upgradeId}::uuid`;
    assert.equal(ledgerRowsAfterRerun[0].count, ledgerRowsBeforeRerun[0].count);
    assert.equal(rerunReport.counts.skippedUnchangedCount, 10); // All 10 rows skipped!
    assert.equal(rerunReport.counts.stagedPendingPublishCount, 0);
    assert.equal(llmCalls, prevLlmCalls, "Completed re-run makes ZERO LLM calls");
    assert.equal(embCalls, prevEmbCalls, "Completed re-run makes ZERO embedding calls");

    // Verify unchanged rerun does NOT duplicate outcome increments on control plane
    const [upgradeRowRerun] = await cpWorkerDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, report.upgradeId));
    assert.equal(upgradeRowRerun.sweepCount, 2);
    assert.equal(upgradeRowRerun.unroutableCount, upgradeRow.unroutableCount);
    assert.equal(upgradeRowRerun.droppedNoiseCount, upgradeRow.droppedNoiseCount);
    assert.equal(upgradeRowRerun.droppedSensitiveCount, upgradeRow.droppedSensitiveCount);
    assert.equal(upgradeRowRerun.publishedCount, upgradeRow.publishedCount);
    assert.equal(upgradeRowRerun.supersededCount, 0);
    assert.equal(upgradeRowRerun.sourceDeletedCount, 0);
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

    let readsAfterLoss = 0;
    let writesAfterLoss = 0;
    let leaseLost = false;

    const recordQuery = (queryStr: string) => {
      if (leaseLost) {
        if (queryStr.includes("SELECT")) readsAfterLoss++;
        if (queryStr.includes("INSERT") || queryStr.includes("UPDATE") || queryStr.includes("DELETE")) {
          writesAfterLoss++;
        }
      }
      if (queryStr.includes("SELECT") && queryStr.includes("mem0_memories")) {
        pageCount++;
        if (pageCount >= 2) {
          // Simulate time jumping forward by 15 minutes, expiring lease
          clock.advance(900_000);
          leaseLost = true;
        }
      }
    };

    function wrapSqlProxy(baseSql: any): any {
      return new Proxy(baseSql, {
        apply(target, thisArg, argArray) {
          const template = argArray[0];
          const queryStr = Array.isArray(template) ? template.join("?") : String(template ?? "");
          recordQuery(queryStr);
          return Reflect.apply(target, thisArg, argArray);
        },
        get(target, prop, receiver) {
          if (prop === "unsafe") {
            return async (...args: any[]) => {
              recordQuery(String(args[0] ?? ""));
              return target.unsafe(...args);
            };
          }
          if (prop === "begin") {
            return async (cb: any) => {
              return target.begin(async (tx: any) => {
                const txProxy = wrapSqlProxy(tx);
                return cb(txProxy);
              });
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }

    const tenantSqlProxy = wrapSqlProxy(tenantWorkerSql);

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

    assert.equal(readsAfterLoss, 0, "No next read occurs after lease loss");
    assert.equal(writesAfterLoss, 0, "No next write occurs after lease loss");
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

  await t.test("repeated edits count superseded transitions and reclassifications in cumulative counters while ledger is authoritative current partition", async () => {
    const clock = new ManualClock(3_000_000);
    const [compEdit] = await cpDb.insert(companies).values({ name: "Comp Edit", issuePrefix: "CE" }).returning();
    const dbNameEdit = `tenant_db_${compEdit.id.slice(0, 8)}`;
    const roleEdit = `${tenantInfo.usr}_edit`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: compEdit.id,
      databaseName: dbNameEdit,
      databaseRole: roleEdit,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    const [editAgent] = await cpDb.insert(agents).values({
      companyId: compEdit.id,
      name: "Edit Agent",
      adapterType: "hermes_local",
      status: "active",
    }).returning();

    await setupTenantMem0Table(tenantWorkerSql, "mem0_edits");

    // 1. Insert a row that is noise
    const memoryRowId = await insertTenantMemoryRow(tenantWorkerSql, {
      tableName: "mem0_edits",
      agentId: editAgent.id,
      data: "hello",
    });

    // Run sweep 1: classifies as dropped_noise
    const report1 = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: compEdit.id,
        tableName: "mem0_edits",
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbNameEdit, user: roleEdit },
      },
    );
    assert.equal(report1.counts.droppedNoiseCount, 1);
    assert.equal(report1.counts.supersededCount, 0);

    const [ledger1] = await tenantWorkerSql`
      SELECT outcome, reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report1.upgradeId}::uuid AND source_id = ${memoryRowId}::uuid;
    `;
    assert.equal(ledger1.outcome, "dropped_noise");

    // 2. Edit memory text in live table to contain a sensitive API key
    await tenantWorkerSql.unsafe(
      `UPDATE mem0_edits SET payload = jsonb_set(payload, '{data}', '"Updated content with API key: sk-abcdef1234567890abcdef1234567890"') WHERE id = $1::uuid;`,
      [memoryRowId],
    );

    // Run sweep 2: detects content change, increments supersededCount (+1 transition),
    // and re-classifies as dropped_sensitive (+1 reclassification)
    const report2 = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: compEdit.id,
        tableName: "mem0_edits",
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbNameEdit, user: roleEdit },
      },
    );
    assert.equal(report2.counts.supersededCount, 1);
    assert.equal(report2.counts.droppedSensitiveCount, 1);

    // Ledger has authoritative current partition: outcome is dropped_sensitive, NOT superseded
    const [ledger2] = await tenantWorkerSql`
      SELECT outcome, reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report1.upgradeId}::uuid AND source_id = ${memoryRowId}::uuid;
    `;
    assert.equal(ledger2.outcome, "dropped_sensitive");

    const totalLedgerRows = await tenantWorkerSql`
      SELECT count(*)::int AS count FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report1.upgradeId}::uuid;
    `;
    assert.equal(totalLedgerRows[0].count, 1, "Ledger has exactly 1 current row");

    // Control plane counters record cumulative activity:
    // droppedNoiseCount (1) + supersededCount (1) + droppedSensitiveCount (1)
    const [cpRow] = await cpWorkerDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, report1.upgradeId));
    assert.equal(cpRow.droppedNoiseCount, 1, "Cumulative noise count preserved");
    assert.equal(cpRow.supersededCount, 1, "Cumulative superseded transition counted");
    assert.equal(cpRow.droppedSensitiveCount, 1, "Cumulative sensitive classification counted");
    assert.equal(cpRow.sweepCount, 2, "Cumulative sweep count incremented");

    // Cumulative activity sum (3) exceeds ledger current partition count (1) by design
    assert.ok(cpRow.droppedNoiseCount + cpRow.supersededCount + cpRow.droppedSensitiveCount > totalLedgerRows[0].count);
  });

  await t.test("live table with text ID column: classifies valid UUIDs and rejects non-UUID IDs upfront", async () => {
    const clock = new ManualClock(4_000_000);
    const [compText] = await cpDb.insert(companies).values({ name: "Comp Text ID", issuePrefix: "CT" }).returning();
    const dbNameText = `tenant_db_${compText.id.slice(0, 8)}`;
    const roleText = `${tenantInfo.usr}_text`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: compText.id,
      databaseName: dbNameText,
      databaseRole: roleText,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    const [textAgent] = await cpDb.insert(agents).values({
      companyId: compText.id,
      name: "Text Agent",
      adapterType: "hermes_local",
      status: "active",
    }).returning();

    // Create a live table with id TEXT
    await tenantWorkerSql.unsafe(`
      CREATE TABLE IF NOT EXISTS mem0_text_ids (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        vector "vector(1536)"
      );
    `);

    // 1. Seed with a valid UUID formatted as text
    const validTextUuid = randomUUID();
    const textPayload = {
      agent_id: textAgent.id,
      user_id: "company",
      data: "hello",
      created_at: new Date().toISOString(),
    };
    await tenantWorkerSql.unsafe(
      `INSERT INTO mem0_text_ids (id, payload, vector) VALUES ($1, $2, 'vec');`,
      [validTextUuid, textPayload],
    );

    const report = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: compText.id,
        tableName: "mem0_text_ids",
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbNameText, user: roleText },
      },
    );

    assert.equal(report.status, "completed");
    assert.equal(report.counts.droppedNoiseCount, 1);

    const [ledgerRow] = await tenantWorkerSql`
      SELECT outcome FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report.upgradeId}::uuid AND source_id = ${validTextUuid}::uuid;
    `;
    assert.equal(ledgerRow.outcome, "dropped_noise");

    // 2. Insert an unsupported non-UUID text ID
    await tenantWorkerSql.unsafe(
      `INSERT INTO mem0_text_ids (id, payload, vector) VALUES ('non-uuid-custom-id-999', $1, 'vec');`,
      [textPayload],
    );

    await assert.rejects(
      async () => {
        await runSweep(
          {
            databaseUrl: tenantWorkerUrl.toString(),
            controlPlaneUrl: cpWorkerUrl.toString(),
            companyId: compText.id,
            tableName: "mem0_text_ids",
            pauseWhenActiveRuns: 0,
          },
          {
            controlPlaneDb: cpWorkerDb,
            tenantSql: tenantWorkerSql,
            clock,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbNameText, user: roleText },
          },
        );
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNSUPPORTED_SOURCE_ID",
    );
  });
});
