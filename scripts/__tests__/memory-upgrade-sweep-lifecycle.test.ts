/**
 * Lifecycle, resilience, and error-recovery integration tests for memory upgrade sweep (TECH-8191).
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
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import {
  CompanyMemoryUpgradeError,
  mapSweepErrorCode,
  SWEEP_ERROR_CODE_MAP,
  UPGRADE_ERROR_CODES,
} from "../../server/src/services/company-memory-upgrade/types.js";

test("sweep lifecycle, resilience, and edge cases", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("sweep-life-cp-");
  const cpDb = createDb(cpFixture.connectionString);

  const tenantFixture = await startEmbeddedPostgresTestDatabase("sweep-life-tn-");
  const tenantSql = openTenantClient(tenantFixture.connectionString);

  // Set up non-superuser tenant and control-plane roles
  await tenantSql.unsafe(`CREATE ROLE sweep_life_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await tenantSql.unsafe(`GRANT ALL ON SCHEMA public TO sweep_life_tenant;`);
  await tenantSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO sweep_life_tenant;`);
  await tenantSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sweep_life_tenant;`);

  await cpDb.execute(sql`CREATE ROLE sweep_life_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await cpDb.execute(sql`GRANT ALL ON SCHEMA public TO sweep_life_cp;`);
  await cpDb.execute(sql`GRANT ALL ON ALL TABLES IN SCHEMA public TO sweep_life_cp;`);
  await cpDb.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sweep_life_cp;`);

  const tenantWorkerUrl = new URL(tenantFixture.connectionString);
  tenantWorkerUrl.username = "sweep_life_tenant";
  tenantWorkerUrl.password = "pass123";

  const cpWorkerUrl = new URL(cpFixture.connectionString);
  cpWorkerUrl.username = "sweep_life_cp";
  cpWorkerUrl.password = "pass123";

  const tenantWorkerSql = openTenantClient(tenantWorkerUrl.toString());
  const cpWorkerDb = createDb(cpWorkerUrl.toString());

  t.after(async () => {
    await tenantWorkerSql.end();
    await cpWorkerDb?.$client?.end();
    await tenantSql.end();
    await cpDb?.$client?.end();
    await tenantFixture?.cleanup();
    await cpFixture?.cleanup();
  });

  await t.test("Item 1: noise-to-pending source reclassifies, deletes stale ledger row, and unchanged re-run causes 0 increments", async () => {
    const clock = new ManualClock(Date.now());
    const [comp] = await cpDb.insert(companies).values({ name: "NoiseToPending Co", issuePrefix: "NP" }).returning();
    const dbName = `tn_db_${comp.id.slice(0, 8)}`;
    const role = `role_${comp.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp.id,
      databaseName: dbName,
      databaseRole: role,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    const [agent] = await cpDb.insert(agents).values({
      companyId: comp.id,
      name: "NP Agent",
      adapterType: "hermes_local",
      status: "active",
    }).returning();

    await setupTenantMem0Table(tenantWorkerSql, "mem0_np");

    // 1. Insert a memory row that is noise
    const memoryId = await insertTenantMemoryRow(tenantWorkerSql, {
      tableName: "mem0_np",
      agentId: agent.id,
      data: "hello",
    });

    // Sweep 1: classifies as dropped_noise
    const report1 = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: comp.id,
        tableName: "mem0_np",
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbName, user: role },
      },
    );
    assert.equal(report1.counts.droppedNoiseCount, 1);
    assert.equal(report1.counts.supersededCount, 0);

    // 2. Edit memory text to be substantive (pendingConversion)
    await tenantWorkerSql.unsafe(
      `UPDATE mem0_np SET payload = jsonb_set(payload, '{data}', '"The user prefers PostgreSQL for data storage."') WHERE id = $1::uuid;`,
      [memoryId],
    );

    // Sweep 2: detects change, supersedes (+1 transition), deletes stale ledger row, and converts to staging
    const report2 = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: comp.id,
        tableName: "mem0_np",
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbName, user: role },
        conversionClient: createFakeConversionClient(),
        embeddingClient: createFakeEmbeddingClient(),
      },
    );
    assert.equal(report2.counts.supersededCount, 1);
    assert.equal(report2.counts.stagedPendingPublishCount, 1);

    // Verify ledger row was updated to published with output_ids
    const [staleLedger] = await tenantWorkerSql`
      SELECT outcome, output_ids FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report1.upgradeId}::uuid AND source_id = ${memoryId}::uuid;
    `;
    assert.ok(staleLedger, "Superseded row reclassifies and commits new ledger row");
    assert.equal(staleLedger.outcome, "published");

    // Sweep 3: UNCHANGED re-run on unchanged data: zero superseded increments!
    const report3 = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: comp.id,
        tableName: "mem0_np",
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbName, user: role },
        conversionClient: createFakeConversionClient(),
        embeddingClient: createFakeEmbeddingClient(),
      },
    );
    assert.equal(report3.counts.supersededCount, 0, "Unchanged re-run must cause zero superseded increments");
    assert.equal(report3.counts.skippedUnchangedCount, 1, "Unchanged row is skipped");

    // Cumulative check on control plane: supersededCount remains exactly 1 from sweep 2
    const [cpRow] = await cpWorkerDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, report1.upgradeId));
    assert.equal(cpRow.supersededCount, 1, "Cumulative supersededCount was not inflated by unchanged re-run");
  });

  await t.test("Item 18: agent reassignment with identical content is detected and reclassified", async () => {
    const clock = new ManualClock(Date.now());
    const [comp] = await cpDb.insert(companies).values({ name: "Reassign Co", issuePrefix: "RA" }).returning();
    const dbName = `tn_db_${comp.id.slice(0, 8)}`;
    const role = `role_${comp.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp.id,
      databaseName: dbName,
      databaseRole: role,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    const [agent1] = await cpDb.insert(agents).values({
      companyId: comp.id,
      name: "Agent 1",
      adapterType: "hermes_local",
      status: "active",
    }).returning();

    const [agent2] = await cpDb.insert(agents).values({
      companyId: comp.id,
      name: "Agent 2",
      adapterType: "hermes_local",
      status: "active",
    }).returning();

    await setupTenantMem0Table(tenantWorkerSql, "mem0_reassign");

    const memoryId = await insertTenantMemoryRow(tenantWorkerSql, {
      tableName: "mem0_reassign",
      agentId: agent1.id,
      data: "hello",
    });

    // Sweep 1: classified as dropped_noise under agent 1
    const report1 = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: comp.id,
        tableName: "mem0_reassign",
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbName, user: role },
      },
    );
    assert.equal(report1.counts.droppedNoiseCount, 1);

    const [l1] = await tenantWorkerSql`
      SELECT agent_id FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report1.upgradeId}::uuid AND source_id = ${memoryId}::uuid;
    `;
    assert.equal(l1.agent_id, agent1.id);

    // Reassign agent in live table with IDENTICAL memory text
    await tenantWorkerSql.unsafe(
      `UPDATE mem0_reassign SET payload = jsonb_set(payload, '{agent_id}', to_jsonb($1::text)) WHERE id = $2::uuid;`,
      [agent2.id, memoryId],
    );

    // Sweep 2: detects agent change, supersedes, and reclassifies under agent 2
    const report2 = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: comp.id,
        tableName: "mem0_reassign",
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbName, user: role },
      },
    );
    assert.equal(report2.counts.supersededCount, 1, "Agent reassignment triggered supersede transition");
    assert.equal(report2.counts.droppedNoiseCount, 1, "Reclassified under agent 2");

    const [l2] = await tenantWorkerSql`
      SELECT agent_id FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${report1.upgradeId}::uuid AND source_id = ${memoryId}::uuid;
    `;
    assert.equal(l2.agent_id, agent2.id, "Ledger now records new agent ID");
  });

  await t.test("Item 4: uppercase text-UUID collection across multiple pages and tombstones", async () => {
    const clock = new ManualClock(Date.now());
    const [comp] = await cpDb.insert(companies).values({ name: "Upper UUID Co", issuePrefix: "UU" }).returning();
    const dbName = `tn_db_${comp.id.slice(0, 8)}`;
    const role = `role_${comp.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp.id,
      databaseName: dbName,
      databaseRole: role,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    const [agent] = await cpDb.insert(agents).values({
      companyId: comp.id,
      name: "Upper Agent",
      adapterType: "hermes_local",
      status: "active",
    }).returning();

    // Create table with text-typed id column and mock vector(1536) domain
    await tenantWorkerSql.unsafe(`
      DO $$ BEGIN
        CREATE DOMAIN "vector(1536)" AS text;
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    await tenantWorkerSql.unsafe(`
      CREATE TABLE IF NOT EXISTS mem0_upper_text (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        vector "vector(1536)" NOT NULL
      );
    `);

    // Insert 12 rows with uppercase UUIDs
    const upperIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const idUpper = randomUUID().toUpperCase();
      upperIds.push(idUpper);
      await tenantWorkerSql.unsafe(
        `INSERT INTO mem0_upper_text (id, payload, vector) VALUES ($1, $2, 'dummy-vec');`,
        [idUpper, { agent_id: agent.id, data: "hello" }],
      );
    }

    // Sweep 1 with small page size (4) to cross multiple page boundaries
    const report1 = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: comp.id,
        tableName: "mem0_upper_text",
        pageSize: 4,
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbName, user: role },
      },
    );
    assert.equal(report1.counts.sourceSeenCount, 12);
    assert.equal(report1.counts.droppedNoiseCount, 12);
    assert.equal(report1.counts.sourceDeletedCount, 0, "No live uppercase UUIDs marked source_deleted");

    // Delete 3 rows from the live collection table
    const toDelete = upperIds.slice(0, 3);
    for (const id of toDelete) {
      await tenantWorkerSql.unsafe(`DELETE FROM mem0_upper_text WHERE id = $1;`, [id]);
    }

    // Sweep 2: tombstone reconciliation accurately marks deleted rows without false positives
    const report2 = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: comp.id,
        tableName: "mem0_upper_text",
        pageSize: 4,
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbName, user: role },
      },
    );
    assert.equal(report2.counts.sourceDeletedCount, 3, "Exactly 3 tombstones detected and marked source_deleted");
    assert.equal(report2.counts.sourceSeenCount, 9, "Remaining 9 live rows seen");
  });

  await t.test("Item 20: lease release on success and failure paths", async () => {
    const clock = new ManualClock(Date.now());
    const [comp] = await cpDb.insert(companies).values({ name: "Lease Release Co", issuePrefix: "LR" }).returning();
    const dbName = `tn_db_${comp.id.slice(0, 8)}`;
    const role = `role_${comp.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp.id,
      databaseName: dbName,
      databaseRole: role,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    await cpDb.insert(agents).values({
      companyId: comp.id,
      name: "LR Agent",
      adapterType: "hermes_local",
      status: "active",
    });

    await setupTenantMem0Table(tenantWorkerSql, "mem0_lr");

    // 1. Success path: lease is released after completion
    const repSuccess = await runSweep(
      {
        databaseUrl: tenantWorkerUrl.toString(),
        controlPlaneUrl: cpWorkerUrl.toString(),
        companyId: comp.id,
        tableName: "mem0_lr",
        pauseWhenActiveRuns: 0,
      },
      {
        controlPlaneDb: cpWorkerDb,
        tenantSql: tenantWorkerSql,
        clock,
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: dbName, user: role },
      },
    );

    const [upgradeAfterSuccess] = await cpWorkerDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, repSuccess.upgradeId));
    assert.equal(upgradeAfterSuccess.leaseToken, null, "Lease token must be cleared on success");
    assert.ok(upgradeAfterSuccess.leaseExpiresAt !== null, "leaseExpiresAt is stamped on release");

    // 2. Failure path: error thrown mid-sweep, lease is released in finally block
    const brokenSql = new Proxy(tenantWorkerSql, {
      get(target, prop, receiver) {
        if (prop === "unsafe") {
          return async (...args: any[]) => {
            const queryStr = String(args[0] ?? "");
            if (queryStr.includes("mem0_lr")) {
              throw new CompanyMemoryUpgradeError("Simulated tenant read error", "SOURCE_READ_FAILED");
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
            companyId: comp.id,
            tableName: "mem0_lr",
            pauseWhenActiveRuns: 0,
          },
          {
            controlPlaneDb: cpWorkerDb,
            tenantSql: brokenSql,
            clock,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbName, user: role },
          },
        );
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "SOURCE_READ_FAILED",
    );

    const [upgradeAfterFail] = await cpWorkerDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, repSuccess.upgradeId));
    assert.equal(upgradeAfterFail.leaseToken, null, "Lease token must be cleared on failure path in finally");
  });

  await t.test("Item 20: injected cleanup error code='marker_secret_cleanup' absent output, primary failure retained", async () => {
    const clock = new ManualClock(Date.now());
    const [comp] = await cpDb.insert(companies).values({ name: "Cleanup Error Co", issuePrefix: "CE" }).returning();
    const dbName = `tn_db_${comp.id.slice(0, 8)}`;
    const role = `role_${comp.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp.id,
      databaseName: dbName,
      databaseRole: role,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    await cpDb.insert(agents).values({
      companyId: comp.id,
      name: "CE Agent",
      adapterType: "hermes_local",
      status: "active",
    });

    await setupTenantMem0Table(tenantWorkerSql, "mem0_ce");
    await insertTenantMemoryRow(tenantWorkerSql, {
      id: randomUUID(),
      agentId: "agent_ce",
      userId: "user_ce",
      data: "Memory to read before simulated failure",
      tableName: "mem0_ce",
    });

    let failCleanup = false;
    const brokenSql = new Proxy(tenantWorkerSql, {
      get(target, prop, receiver) {
        if (prop === "unsafe") {
          return async (...args: any[]) => {
            const queryStr = String(args[0] ?? "");
            if (queryStr.includes("mem0_ce") && (queryStr.includes("t.payload") || queryStr.includes("ORDER BY"))) {
              failCleanup = true;
              throw new CompanyMemoryUpgradeError("Primary tenant read error", "SOURCE_READ_FAILED");
            }
            return (target as any).unsafe(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const proxyCpDb = new Proxy(cpWorkerDb, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return (...args: any[]) => {
            if (failCleanup) {
              const cleanupErr = new Error("secret cleanup internal exception");
              (cleanupErr as any).code = "marker_secret_cleanup";
              throw cleanupErr;
            }
            return (target as any).update(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    let stderrOutput = "";
    const origError = console.error;
    console.error = (...args: any[]) => {
      stderrOutput += `${args.join(" ")}\n`;
    };

    try {
      await assert.rejects(
        async () => {
          await runSweep(
            {
              databaseUrl: tenantWorkerUrl.toString(),
              controlPlaneUrl: cpWorkerUrl.toString(),
              companyId: comp.id,
              tableName: "mem0_ce",
              pauseWhenActiveRuns: 0,
            },
            {
              controlPlaneDb: proxyCpDb,
              tenantSql: brokenSql,
              clock,
              _internalSkipVectorIdentityCheck: true,
              _internalDatabaseIdentityOverride: { database: dbName, user: role },
            },
          );
        },
        (err: any) => {
          assert.ok(err instanceof CompanyMemoryUpgradeError);
          assert.equal(err.code, "SOURCE_READ_FAILED");
          assert.equal(err.message, "Primary tenant read error");
          return true;
        },
      );

      // Verify the injected cleanup error code is ABSENT from console.error output
      assert.ok(
        !stderrOutput.includes("marker_secret_cleanup"),
        "Cleanup error code 'marker_secret_cleanup' must never appear in output",
      );
      assert.ok(
        !stderrOutput.includes("secret cleanup internal exception"),
        "Cleanup error message must never appear in output",
      );
      // Verify bounded guarded error code is printed instead
      assert.ok(
        stderrOutput.includes("unexpected_failure"),
        "Guarded code unexpected_failure should be output for unmapped cleanup error",
      );
    } finally {
      console.error = origError;
    }
  });

  await t.test("Item 20: CONVERTER_CONTRACT_MISMATCH and needs_recovery refusal", async () => {
    const clock = new ManualClock(Date.now());
    const [comp] = await cpDb.insert(companies).values({ name: "Contract Refusal Co", issuePrefix: "CR" }).returning();
    const dbName = `tn_db_${comp.id.slice(0, 8)}`;
    const role = `role_${comp.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp.id,
      databaseName: dbName,
      databaseRole: role,
      host: "localhost",
      port: 5432,
      status: "ready",
    });
    await cpDb.insert(agents).values({
      companyId: comp.id,
      name: "CR Agent",
      adapterType: "hermes_local",
      status: "active",
    });
    await setupTenantMem0Table(tenantWorkerSql, "mem0_cr");

    // 1. Manually insert upgrade row with mismatched converterVersion
    const [mismatchedUpgrade] = await cpWorkerDb.insert(companyMemoryUpgrades).values({
      companyId: comp.id,
      state: "sweeping",
      converterId: "hermes_mem0_atomic_v1",
      converterVersion: 99, // Mismatched version
      collectionName: "mem0_cr",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    }).returning();

    await assert.rejects(
      async () => {
        await runSweep(
          {
            databaseUrl: tenantWorkerUrl.toString(),
            controlPlaneUrl: cpWorkerUrl.toString(),
            companyId: comp.id,
            tableName: "mem0_cr",
            pauseWhenActiveRuns: 0,
          },
          {
            controlPlaneDb: cpWorkerDb,
            tenantSql: tenantWorkerSql,
            clock,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbName, user: role },
          },
        );
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "CONVERTER_CONTRACT_MISMATCH",
    );

    // 2. Put upgrade in needs_recovery state
    await cpWorkerDb
      .update(companyMemoryUpgrades)
      .set({ state: "needs_recovery", converterVersion: 1 })
      .where(eq(companyMemoryUpgrades.id, mismatchedUpgrade.id));

    await assert.rejects(
      async () => {
        await runSweep(
          {
            databaseUrl: tenantWorkerUrl.toString(),
            controlPlaneUrl: cpWorkerUrl.toString(),
            companyId: comp.id,
            tableName: "mem0_cr",
            pauseWhenActiveRuns: 0,
          },
          {
            controlPlaneDb: cpWorkerDb,
            tenantSql: tenantWorkerSql,
            clock,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbName, user: role },
          },
        );
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STATE_MISMATCH",
    );
  });

  await t.test("Item 2: mapSweepErrorCode maps codes to bounded UPGRADE_ERROR_CODES", () => {
    assert.equal(mapSweepErrorCode("LEASE_FENCED_OUT"), "lease_fenced_out");
    assert.equal(mapSweepErrorCode("paused_too_long"), "paused_too_long");
    assert.equal(mapSweepErrorCode("ACTIVE_RUNS_PAUSED_TOO_LONG"), "paused_too_long");
    assert.equal(mapSweepErrorCode("CONVERTER_CONTRACT_MISMATCH"), "state_mismatch");
    assert.equal(mapSweepErrorCode("COMPANY_NOT_FOUND"), "source_read_failed");
    assert.equal(mapSweepErrorCode("unknown_garbage_code"), "unexpected_failure");
    assert.equal(mapSweepErrorCode(null), "unexpected_failure");

    // Mapping table assertions for conversion and key errors
    assert.equal(mapSweepErrorCode("COMPANY_OPENAI_KEY_MISSING"), "conversion_failed");
    assert.equal(mapSweepErrorCode("company_openai_key_missing"), "conversion_failed");
    assert.equal(mapSweepErrorCode("COMPANY_OPENAI_KEY_PROVIDER_UNSUPPORTED"), "conversion_failed");
    assert.equal(mapSweepErrorCode("company_openai_key_provider_unsupported"), "conversion_failed");
    assert.equal(mapSweepErrorCode("COMPANY_OPENAI_KEY_REJECTED"), "conversion_failed");
    assert.equal(mapSweepErrorCode("company_openai_key_rejected"), "conversion_failed");
    assert.equal(mapSweepErrorCode("COMPANY_OPENAI_QUOTA_EXHAUSTED"), "conversion_failed");
    assert.equal(mapSweepErrorCode("company_openai_quota_exhausted"), "conversion_failed");
    assert.equal(mapSweepErrorCode("LLM_REQUEST_REJECTED"), "conversion_failed");
    assert.equal(mapSweepErrorCode("llm_request_rejected"), "conversion_failed");

    // All mapped values belong to UPGRADE_ERROR_CODES
    for (const code of Object.values(SWEEP_ERROR_CODE_MAP)) {
      assert.ok(UPGRADE_ERROR_CODES.includes(code));
    }
  });
});
