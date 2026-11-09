/**
 * Staging, deduplication, quarantine halt, and budget guard integration tests (TECH-8191).
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
  insertTenantMemoryRow,
  ManualClock,
  setupTenantMem0Table,
  sql,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { runSweep, shouldHaltOnQuarantine } from "../../server/src/services/company-memory-upgrade/sweep.js";
import {
  ensureUpgradeTables,
  openTenantClient,
  reconcileChangedContent,
  reconcileTombstones,
  stageSourceRecords,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { computeRecordDataSha256 } from "../../server/src/services/company-memory-upgrade/converter-contract.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("shouldHaltOnQuarantine pure rule validation", () => {
  // Rule 1: quarantined > 50
  assert.equal(shouldHaltOnQuarantine(50, 100), false);
  assert.equal(shouldHaltOnQuarantine(51, 100), true);

  // Rule 2: considered >= 200 && quarantined / considered > 0.02
  assert.equal(shouldHaltOnQuarantine(4, 199), false, "considered < 200 must not trigger 2% halt");
  assert.equal(shouldHaltOnQuarantine(4, 200), false, "4/200 = 0.02 is not > 0.02");
  assert.equal(shouldHaltOnQuarantine(5, 200), true, "5/200 = 0.025 is > 0.02");
  assert.equal(shouldHaltOnQuarantine(6, 250), true, "6/250 = 0.024 is > 0.02");
  assert.equal(shouldHaltOnQuarantine(5, 250), false, "5/250 = 0.020 is not > 0.02");
});

test("staging, deduplication, and published_at invariants", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const tenantFixture = await startEmbeddedPostgresTestDatabase("sweep-staging-tenant-");
  const tenantSql = openTenantClient(tenantFixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await tenantFixture.cleanup();
  });

  await ensureUpgradeTables(tenantSql, "text");

  const upgradeId = randomUUID();
  const agent1 = randomUUID();
  const agent2 = randomUUID();

  await t.test("dedupe is scoped per agent: same content for agent 1 and agent 2 both stage", async () => {
    const memoryData = "The client prefers email notifications over SMS alerts.";
    const dataSha256 = computeRecordDataSha256(memoryData);
    const dummyVector = new Array(1536).fill(0.01);

    const source1 = randomUUID();
    const source2 = randomUUID();

    // Agent 1 stages memory
    const resAgent1 = await stageSourceRecords(tenantSql, {
      upgradeId,
      sourceId: source1,
      sourceContentSha256: "sha-src-1",
      agentId: agent1,
      records: [
        {
          outputId: randomUUID(),
          dataSha256,
          payload: { data: memoryData, agent_id: agent1 },
          embedding: dummyVector,
        },
      ],
      vectorType: "text",
    });

    assert.equal(resAgent1.outcome, "published");
    assert.equal(resAgent1.stagedCount, 1);
    assert.equal(resAgent1.deduplicatedCount, 0);

    // Agent 2 stages IDENTICAL content: wins its own dedupe slot!
    const resAgent2 = await stageSourceRecords(tenantSql, {
      upgradeId,
      sourceId: source2,
      sourceContentSha256: "sha-src-2",
      agentId: agent2,
      records: [
        {
          outputId: randomUUID(),
          dataSha256,
          payload: { data: memoryData, agent_id: agent2 },
          embedding: dummyVector,
        },
      ],
      vectorType: "text",
    });

    assert.equal(resAgent2.outcome, "published");
    assert.equal(resAgent2.stagedCount, 1);
    assert.equal(resAgent2.deduplicatedCount, 0);

    // Staging table must have 2 rows, both with published_at NULL (unambiguously not live)
    const stagingRows = await tenantSql`
      SELECT agent_id, output_id, published_at
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid
      ORDER BY agent_id ASC;
    `;
    assert.equal(stagingRows.length, 2);
    assert.equal(stagingRows[0].published_at, null);
    assert.equal(stagingRows[1].published_at, null);
  });

  await t.test("duplicate content for the SAME agent resolves to deduplicated outcome", async () => {
    const memoryData = "The client prefers email notifications over SMS alerts.";
    const dataSha256 = computeRecordDataSha256(memoryData);
    const source3 = randomUUID();

    const resAgent1Dup = await stageSourceRecords(tenantSql, {
      upgradeId,
      sourceId: source3,
      sourceContentSha256: "sha-src-3",
      agentId: agent1, // same agent!
      records: [
        {
          outputId: randomUUID(),
          dataSha256,
          payload: { data: memoryData, agent_id: agent1 },
          embedding: new Array(1536).fill(0.01),
        },
      ],
      vectorType: "text",
    });

    assert.equal(resAgent1Dup.outcome, "deduplicated");
    assert.equal(resAgent1Dup.stagedCount, 0);
    assert.equal(resAgent1Dup.deduplicatedCount, 1);
    assert.deepEqual(resAgent1Dup.outputIds, []);

    // Ledger row records deduplicated with empty output_ids
    const [ledgerRow] = await tenantSql`
      SELECT outcome, output_ids
      FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${source3}::uuid;
    `;
    assert.equal(ledgerRow.outcome, "deduplicated");
    assert.deepEqual(ledgerRow.output_ids, []);
  });

  await t.test("published staging rows are NEVER deleted by tombstones or superseding", async () => {
    const sourcePub = randomUUID();
    const outputPub = randomUUID();

    // Stage record and simulate publishing (published_at NOT NULL)
    await stageSourceRecords(tenantSql, {
      upgradeId,
      sourceId: sourcePub,
      sourceContentSha256: "sha-src-pub",
      agentId: agent1,
      records: [
        {
          outputId: outputPub,
          dataSha256: "unique-sha-published-record",
          payload: { data: "Published fact" },
          embedding: new Array(1536).fill(0.01),
        },
      ],
      vectorType: "text",
    });

    // Mark published
    await tenantSql`
      UPDATE paperclip_memory_upgrade_staging
      SET published_at = now()
      WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${outputPub}::uuid;
    `;

    // Attempt tombstone reconciliation
    const tombResult = await reconcileTombstones(tenantSql, upgradeId, {
      tombstoneSourceIds: [sourcePub],
    });
    assert.equal(tombResult.deletedStagingCount, 0, "Published staging rows must NEVER be deleted");

    // Attempt reconcileChangedContent
    const changeResult = await reconcileChangedContent(tenantSql, upgradeId, sourcePub);
    assert.equal(changeResult.deletedStagingCount, 0, "Published staging rows must NEVER be deleted");

    const [stillExists] = await tenantSql`
      SELECT output_id FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${outputPub}::uuid;
    `;
    assert.ok(stillExists, "Published staging row must remain intact");
  });
});

test("quarantine halt and budget guard in sweep orchestrator", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("sweep-guard-cp-");
  const cpDb = createDb(cpFixture.connectionString);

  const tenantFixture = await startEmbeddedPostgresTestDatabase("sweep-guard-tenant-");
  const tenantSql = openTenantClient(tenantFixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await cpDb.$client?.end();
    await tenantFixture.cleanup();
    await cpFixture.cleanup();
  });

  await tenantSql.unsafe(`CREATE ROLE guard_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await tenantSql.unsafe(`GRANT ALL ON SCHEMA public TO guard_tenant;`);
  await tenantSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO guard_tenant;`);
  await tenantSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO guard_tenant;`);

  await cpDb.execute(sql`CREATE ROLE guard_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await cpDb.execute(sql`GRANT ALL ON SCHEMA public TO guard_cp;`);
  await cpDb.execute(sql`GRANT ALL ON ALL TABLES IN SCHEMA public TO guard_cp;`);
  await cpDb.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO guard_cp;`);

  const tenantUserUrl = new URL(tenantFixture.connectionString);
  tenantUserUrl.username = "guard_tenant";
  tenantUserUrl.password = "pass123";

  const cpUserUrl = new URL(cpFixture.connectionString);
  cpUserUrl.username = "guard_cp";
  cpUserUrl.password = "pass123";

  const tenantWorkerSql = openTenantClient(tenantUserUrl.toString());
  const cpWorkerDb = createDb(cpUserUrl.toString());

  t.after(async () => {
    await tenantWorkerSql.end();
    await cpWorkerDb.$client?.end();
  });

  await setupTenantMem0Table(tenantSql, "mem0_memories");

  const [company] = await cpDb.insert(companies).values({
    name: "Guard Test Co",
    issuePrefix: "GT",
  }).returning();

  const [tInfo] = await tenantSql`
    SELECT current_database()::text AS db;
  `;

  await cpDb.insert(companyMemoryDatabases).values({
    companyId: company.id,
    databaseName: tInfo.db,
    databaseRole: "guard_tenant",
    host: "localhost",
    port: 5432,
    status: "ready",
  });

  const [agent] = await cpDb.insert(agents).values({
    companyId: company.id,
    name: "Guard Agent",
    adapterType: "hermes_local",
    status: "active",
  }).returning();

  await t.test("quarantine halt halts execution, flushes counters, releases lease, and preserves state sweeping", async () => {
    // Seed 55 memories that will all quarantine (> 50 rule)
    for (let i = 0; i < 55; i++) {
      await insertTenantMemoryRow(tenantSql, {
        agentId: agent.id,
        data: `Substantive memory to be quarantined ${i}`,
      });
    }

    const clock = new ManualClock();
    const failingConversionClient = createFakeConversionClient(() => ({
      status: "quarantined",
      rejectCode: "too_many_records",
    }));

    await assert.rejects(
      () =>
        runSweep(
          {
            databaseUrl: tenantUserUrl.toString(),
            controlPlaneUrl: cpUserUrl.toString(),
            companyId: company.id,
            pageSize: 100,
            pauseWhenActiveRuns: 0,
          },
          {
            controlPlaneDb: cpWorkerDb,
            tenantSql: tenantWorkerSql,
            clock,
            _internalSkipVectorIdentityCheck: true,
            conversionClient: failingConversionClient,
            embeddingClient: createFakeEmbeddingClient(),
          },
        ),
      (err: any) => {
        assert.equal(err.code, "CONVERSION_FAILED");
        assert.ok(err.message.includes("Quarantine threshold exceeded"));
        return true;
      },
    );

    // Verify upgrade record state:
    // - state remains 'sweeping' (never needs_recovery)
    // - lastError is 'conversion_failed'
    // - lease is released (leaseToken is null or leaseExpiresAt <= now)
    const [upgrade] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.companyId, company.id));

    assert.equal(upgrade.state, "sweeping");
    assert.equal(upgrade.lastError, "conversion_failed");
    assert.equal(upgrade.leaseToken, null, "Lease must be cleanly released on quarantine halt");
    assert.ok(upgrade.quarantinedCount >= 51);
  });

  await t.test("budget guard (--max-cost-usd) aborts and releases lease", async () => {
    // Create new company for budget test
    const [compBudget] = await cpDb.insert(companies).values({
      name: "Budget Guard Co",
      issuePrefix: "BG",
    }).returning();

    const dbName2 = `tenant_db_${compBudget.id.slice(0, 8)}`;
    const roleName2 = `guard_r_${compBudget.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: compBudget.id,
      databaseName: dbName2,
      databaseRole: roleName2,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    const [budgetAgent] = await cpDb.insert(agents).values({
      companyId: compBudget.id,
      name: "Budget Agent",
      adapterType: "hermes_local",
      status: "active",
    }).returning();

    await insertTenantMemoryRow(tenantSql, {
      agentId: budgetAgent.id,
      data: "Memory for budget cap testing.",
    });

    const clock = new ManualClock();

    // Set maxCostUsd extremely low: $0.000000001
    await assert.rejects(
      () =>
        runSweep(
          {
            databaseUrl: tenantUserUrl.toString(),
            controlPlaneUrl: cpUserUrl.toString(),
            companyId: compBudget.id,
            maxCostUsd: 0.000000001,
            pauseWhenActiveRuns: 0,
          },
          {
            controlPlaneDb: cpWorkerDb,
            tenantSql: tenantWorkerSql,
            clock,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbName2, user: roleName2 },
            conversionClient: createFakeConversionClient(),
            embeddingClient: createFakeEmbeddingClient(),
          },
        ),
      (err: any) => {
        assert.equal(err.code, "ABORTED_BY_OPERATOR");
        return true;
      },
    );

    // Verify lease was released
    const [upgrade] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.companyId, compBudget.id));
    assert.equal(upgrade.leaseToken, null, "Lease must be released when budget cap exceeded");
    assert.equal(upgrade.lastError, "aborted_by_operator");
  });
});
