/**
 * Reconcile semantics and vector cast parameterisation tests (TECH-8191 PR 4a).
 * Tests 16-23 from §7.3, plus safe catalog type unit tests.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  commitSourceOutcome,
  ensureUpgradeTables,
  introspectCollection,
  loadLedgerForSources,
  openTenantClient,
  reconcileChangedContent,
  reconcileTombstones,
  stageSourceRecords,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import {
  assertSafeCatalogTypeCast,
  introspectStagingEmbeddingType,
} from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import {
  runSweep,
  RECONVERTIBLE_LEDGER_OUTCOMES,
} from "../../server/src/services/company-memory-upgrade/sweep.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
  createFakeConversionClient,
  createFakeEmbeddingClient,
  ManualClock,
} from "./memory-upgrade-sweep-helpers.js";
import { createDb, companies, companyMemoryDatabases, agents } from "../../packages/db/src/index.js";

test("safe catalog type cast validation (unit)", () => {
  // Valid types
  const valid = [
    "vector(1536)",
    '"vector(1536)"',
    "extensions.vector(1536)",
    'public."vector"(1536)',
    "numeric(10,2)",
    "text",
    "jsonb",
    "uuid",
    "custom_type",
    '"my_schema"."my_type"',
  ];
  for (const t of valid) {
    assert.doesNotThrow(() => assertSafeCatalogTypeCast(t), `Expected "${t}" to be valid`);
  }

  // Invalid types
  const invalid = [
    "vector(1536); DROP TABLE t",
    "text) --",
    '"unclosed_quote',
    "",
    "   ",
    "a".repeat(129), // > 128 chars
    "type with spaces",
    "vector(1536) /* comment */",
  ];
  for (const t of invalid) {
    assert.throws(
      () => assertSafeCatalogTypeCast(t),
      (err: any) => err?.code === "UNSAFE_CATALOG_TYPE",
      `Expected "${t}" to be rejected with UNSAFE_CATALOG_TYPE`,
    );
  }
});

test("reconcile semantics and ledger integrity (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("publish-reconcile-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(sql, "mem0_memories");
  await ensureUpgradeTables(sql, "text");

  const upgradeId = randomUUID();
  const agentId = randomUUID();
  const fence = await claimTenantFenceForTestSetup(sql, upgradeId);

  await t.test("introspectStagingEmbeddingType returns unstripped type and validates safe catalog cast", async () => {
    const stagingType = await introspectStagingEmbeddingType(sql);
    assert.equal(stagingType, "text");
  });

  // Test 16: Source deleted between sweep and publish
  await t.test("Test 16: Source deleted between sweep and publish -> ledger source_deleted, unpublished staging gone, published retained", async () => {
    const sourceId = randomUUID();
    const publishedOutputId = randomUUID();
    const unpublishedOutputId = randomUUID();

    // 1 published staging row + 1 unpublished staging row
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
      ) VALUES
        (${upgradeId}::uuid, ${sourceId}::uuid, ${publishedOutputId}::uuid, ${agentId}::uuid, '{"text":"pub"}'::jsonb, 'vec'::text, 'hash1', now(), now()),
        (${upgradeId}::uuid, ${sourceId}::uuid, ${unpublishedOutputId}::uuid, ${agentId}::uuid, '{"text":"unpub"}'::jsonb, 'vec'::text, 'hash1', NULL, now());
    `;

    // Dedupe row for unpublished output
    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id, created_at
      ) VALUES (${upgradeId}::uuid, ${agentId}::uuid, 'dedupe_hash_1', ${unpublishedOutputId}::uuid, now());
    `;

    // Ledger row with outcome 'published' referencing both output IDs
    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at
      ) VALUES (
        ${upgradeId}::uuid, ${sourceId}::uuid, 'hash1', ${agentId}::uuid, 'published', NULL,
        ${[publishedOutputId, unpublishedOutputId]}::uuid[], now(), now()
      );
    `;

    // Reconcile tombstone for this source
    const result = await reconcileTombstones(sql, upgradeId, { tombstoneSourceIds: [sourceId] }, fence);
    assert.equal(result.tombstonesCount, 1);
    assert.equal(result.deletedStagingCount, 1);
    assert.equal(result.deletedDedupeCount, 1);

    // Assert: ledger outcome is source_deleted and output_ids references exactly the retained published row
    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    const ledger = ledgerMap.get(sourceId.toLowerCase())!;
    assert.equal(ledger.outcome, "source_deleted");
    assert.deepEqual(ledger.outputIds, [publishedOutputId]);

    // Assert: unpublished staging row is deleted, published staging row remains
    const stagingRows = await sql`
      SELECT output_id, published_at FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(stagingRows.length, 1);
    assert.equal(stagingRows[0].output_id, publishedOutputId);
    assert.ok(stagingRows[0].published_at !== null);
  });

  // Test 17: Source content changed, no published rows remain
  await t.test("Test 17: Source content changed, no published rows remain -> unpublished staging gone, ledger row deleted", async () => {
    const sourceId = randomUUID();
    const unpublishedOutputId = randomUUID();

    // Only unpublished staging row
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
      ) VALUES
        (${upgradeId}::uuid, ${sourceId}::uuid, ${unpublishedOutputId}::uuid, ${agentId}::uuid, '{"text":"unpub"}'::jsonb, 'vec'::text, 'hash_old', NULL, now());
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id, created_at
      ) VALUES (${upgradeId}::uuid, ${agentId}::uuid, 'dedupe_hash_2', ${unpublishedOutputId}::uuid, now());
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at
      ) VALUES (
        ${upgradeId}::uuid, ${sourceId}::uuid, 'hash_old', ${agentId}::uuid, 'published', NULL,
        ${[unpublishedOutputId]}::uuid[], now(), now()
      );
    `;

    const changeRes = await reconcileChangedContent(
      sql,
      { upgradeId, sourceId, sourceContentSha256: "hash_new", agentId },
      fence,
    );
    assert.equal(changeRes.deletedStagingCount, 1);
    assert.equal(changeRes.deletedDedupeCount, 1);
    assert.deepEqual(changeRes.retainedOutputIds, []);

    // Ledger row must be DELETED entirely
    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    assert.equal(ledgerMap.get(sourceId.toLowerCase()), undefined);

    // Staging must be empty for this source
    const staging = await sql`
      SELECT count(*)::int AS count FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(staging[0].count, 0);
  });

  // Test 18: Source content changed, published rows remain
  await t.test("Test 18: Source content changed, published rows remain -> ledger superseded with NEW hash and NEW agent, output_ids retained", async () => {
    const sourceId = randomUUID();
    const publishedOutputId = randomUUID();
    const unpublishedOutputId = randomUUID();
    const newAgentId = randomUUID();
    const newSha = "hash_v2_new";

    // 1 published + 1 unpublished staging row
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
      ) VALUES
        (${upgradeId}::uuid, ${sourceId}::uuid, ${publishedOutputId}::uuid, ${agentId}::uuid, '{"text":"pub"}'::jsonb, 'vec'::text, 'hash_v1', now(), now()),
        (${upgradeId}::uuid, ${sourceId}::uuid, ${unpublishedOutputId}::uuid, ${agentId}::uuid, '{"text":"unpub"}'::jsonb, 'vec'::text, 'hash_v1', NULL, now());
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids, created_at, updated_at
      ) VALUES (
        ${upgradeId}::uuid, ${sourceId}::uuid, 'hash_v1', ${agentId}::uuid, 'published', NULL,
        ${[publishedOutputId, unpublishedOutputId]}::uuid[], now(), now()
      );
    `;

    const changeRes = await reconcileChangedContent(
      sql,
      { upgradeId, sourceId, sourceContentSha256: newSha, agentId: newAgentId },
      fence,
    );
    assert.equal(changeRes.deletedStagingCount, 1);
    assert.deepEqual(changeRes.retainedOutputIds, [publishedOutputId]);

    // Ledger row must be superseded with NEW hash and NEW agent
    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    const ledger = ledgerMap.get(sourceId.toLowerCase())!;
    assert.equal(ledger.outcome, "superseded");
    assert.equal(ledger.sourceContentSha256, newSha);
    assert.equal(ledger.agentId, newAgentId);
    assert.deepEqual(ledger.outputIds, [publishedOutputId]);
  });

  // Test 21: commitSourceOutcome preserves references to live rows
  await t.test("Test 21: commitSourceOutcome preserves references to live rows in both INSERT and ON CONFLICT (correlated subquery)", async () => {
    const sourceId = randomUUID();
    const publishedId1 = randomUUID();
    const publishedId2 = randomUUID();
    const sortedPublishedIds = [publishedId1, publishedId2].sort();

    // Pre-populate published staging rows
    for (const outId of sortedPublishedIds) {
      await sql`
        INSERT INTO paperclip_memory_upgrade_staging (
          upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
        ) VALUES (
          ${upgradeId}::uuid, ${sourceId}::uuid, ${outId}::uuid, ${agentId}::uuid, '{"text":"live"}'::jsonb, 'vec'::text, 'h1', now(), now()
        );
      `;
    }

    // Branch A: INSERT path when ledger row does not exist yet
    await commitSourceOutcome(
      sql,
      {
        upgradeId,
        sourceId,
        sourceContentSha256: "h1",
        agentId,
        outcome: "unroutable",
        reasonCode: "terminated",
      },
      fence,
    );

    let ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    let ledger = ledgerMap.get(sourceId.toLowerCase())!;
    assert.equal(ledger.outcome, "unroutable");
    assert.deepEqual(ledger.outputIds, sortedPublishedIds, "INSERT branch must recompute output_ids from staging");

    // Branch B: ON CONFLICT DO UPDATE path
    // Re-commit outcome as dropped_noise. If EXCLUDED.output_ids were used, output_ids would be wiped to '{}'
    await commitSourceOutcome(
      sql,
      {
        upgradeId,
        sourceId,
        sourceContentSha256: "h1",
        agentId,
        outcome: "dropped_noise",
        reasonCode: "empty",
      },
      fence,
    );

    ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    ledger = ledgerMap.get(sourceId.toLowerCase())!;
    assert.equal(ledger.outcome, "dropped_noise");
    assert.deepEqual(ledger.outputIds, sortedPublishedIds, "ON CONFLICT branch MUST preserve output_ids via subquery, never EXCLUDED");
  });

  // Test 22: All-duplicate with retained published rows
  await t.test("Test 22: All-duplicate with retained published rows -> outcome deduplicated AND output_ids non-empty", async () => {
    const sourceA = randomUUID();
    const sourceB = randomUUID();
    const pubIdA = randomUUID();
    const wonRecId = randomUUID();

    // Source A has published staging row
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
      ) VALUES (
        ${upgradeId}::uuid, ${sourceA}::uuid, ${pubIdA}::uuid, ${agentId}::uuid, '{"text":"a"}'::jsonb, 'vec'::text, 'hashA', now(), now()
      );
    `;

    // Another source B already won dedupe slot for data_sha256 'common_slot'
    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id, created_at
      ) VALUES (${upgradeId}::uuid, ${agentId}::uuid, 'common_slot', ${wonRecId}::uuid, now());
    `;

    // Now Source A converts with records that collide with common_slot (all duplicate)
    const stageRes = await stageSourceRecords(
      sql,
      {
        upgradeId,
        sourceId: sourceA,
        sourceContentSha256: "hashA",
        agentId,
        records: [
          {
            outputId: randomUUID(),
            dataSha256: "common_slot",
            payload: { data: "common" },
            embedding: [0.1],
          },
        ],
        vectorType: "text",
      },
      fence,
    );

    assert.equal(stageRes.outcome, "deduplicated");
    assert.equal(stageRes.stagedCount, 0);
    assert.equal(stageRes.deduplicatedCount, 1);

    // Ledger for Source A must have outcome 'deduplicated' AND output_ids referencing its pre-existing published row
    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceA]);
    const ledger = ledgerMap.get(sourceA.toLowerCase())!;
    assert.equal(ledger.outcome, "deduplicated");
    assert.deepEqual(ledger.outputIds, [pubIdA], "deduplicated outcome must retain pre-existing published output_ids");
  });

  // Test 23: Tombstone batches now take ascending L1 advisory locks
  await t.test("Test 23: Tombstone batches take ascending L1 advisory locks via unnest (blocks concurrent holder)", async () => {
    const sourceId = randomUUID();
    const sql2 = openTenantClient(fixture.connectionString);

    t.after(async () => {
      await sql2.end();
    });

    // Mark sourceId in ledger
    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, output_ids, created_at, updated_at
      ) VALUES (${upgradeId}::uuid, ${sourceId}::uuid, 'h', ${agentId}::uuid, 'published', '{}', now(), now());
    `;

    // Connection 2 takes the per-source advisory lock
    const lockKey = `paperclip:memory-upgrade-source:${upgradeId.toLowerCase()}:${sourceId.toLowerCase()}`;
    await sql2.unsafe(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${lockKey}', 0));`);

    // Connection 1 attempts reconcileTombstones with lock_timeout set. It MUST block and time out (55P03)
    await sql.unsafe(`SET lock_timeout = '200ms';`);
    let threw55P03 = false;
    try {
      await reconcileTombstones(sql, upgradeId, { tombstoneSourceIds: [sourceId] }, fence);
    } catch (err: any) {
      // Postgres error code 55P03 is lock_not_available
      if (err?.code === "55P03" || String(err?.message).includes("lock timeout")) {
        threw55P03 = true;
      }
    } finally {
      await sql.unsafe(`SET lock_timeout = '5s';`);
    }

    assert.ok(threw55P03, "reconcileTombstones must take L1 advisory lock and block when held by another connection");

    // Release connection 2 lock
    await sql2.unsafe(`ROLLBACK;`);

    // Now reconcileTombstones must succeed
    const res = await reconcileTombstones(sql, upgradeId, { tombstoneSourceIds: [sourceId] }, fence);
    assert.equal(res.tombstonesCount, 1);
  });
});

test("superseded skip-check and re-conversion integration (embedded postgres + runSweep)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("publish-reconcile-sweep-");
  const cpDb = createDb(fixture.connectionString);
  const tenantSql = openTenantClient(fixture.connectionString);

  await setupTenantMem0Table(tenantSql, "mem0_memories");

  // Create non-superuser roles for tenant and control-plane preflights
  await tenantSql.unsafe(`CREATE ROLE recon_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await tenantSql.unsafe(`GRANT ALL ON SCHEMA public TO recon_tenant;`);
  await tenantSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO recon_tenant;`);
  await tenantSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO recon_tenant;`);

  await tenantSql.unsafe(`CREATE ROLE recon_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await tenantSql.unsafe(`GRANT ALL ON SCHEMA public TO recon_cp;`);
  await tenantSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO recon_cp;`);
  await tenantSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO recon_cp;`);

  const tenantWorkerUrl = new URL(fixture.connectionString);
  tenantWorkerUrl.username = "recon_tenant";
  tenantWorkerUrl.password = "pass123";

  const cpWorkerUrl = new URL(fixture.connectionString);
  cpWorkerUrl.username = "recon_cp";
  cpWorkerUrl.password = "pass123";

  const tenantWorkerSql = openTenantClient(tenantWorkerUrl.toString());
  const cpWorkerDb = createDb(cpWorkerUrl.toString());

  t.after(async () => {
    await tenantWorkerSql.end();
    await cpWorkerDb.$client.end({ timeout: 1 });
    await tenantSql.end();
    await cpDb.$client.end({ timeout: 1 });
    await fixture.cleanup();
  });

  const companyId = randomUUID();
  const agentId = randomUUID();
  const sourceId = randomUUID();

  const [tenantInfo] = await tenantWorkerSql`
    SELECT current_database()::text AS db, current_user::text AS usr;
  `;

  // Setup CP tables & binding
  await cpDb.insert(companies).values({ id: companyId, name: "Reconcile Co", issuePrefix: "RC" });
  await cpDb.insert(companyMemoryDatabases).values({
    id: randomUUID(),
    companyId,
    databaseName: tenantInfo.db,
    databaseRole: tenantInfo.usr,
    host: "localhost",
    port: 5432,
    status: "ready",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  });
  await cpDb.insert(agents).values({
    id: agentId,
    companyId,
    name: "Agent Alpha",
    adapterType: "hermes_local",
    status: "active",
  });

  // Insert live memory row
  await insertTenantMemoryRow(tenantWorkerSql, {
    id: sourceId,
    agentId,
    data: "Initial content that will be converted",
    tableName: "mem0_memories",
  });

  const fakeConv = createFakeConversionClient();
  const fakeEmb = createFakeEmbeddingClient();

  // Run 1: sweep converts the source
  const report1 = await runSweep(
    {
      databaseUrl: tenantWorkerUrl.toString(),
      controlPlaneUrl: cpWorkerUrl.toString(),
      companyId,
      confirm: companyId,
      tableName: "mem0_memories",
    } as any,
    {
      tenantSql: tenantWorkerSql,
      controlPlaneDb: cpWorkerDb,
      _internalSkipVectorIdentityCheck: true,
      conversionClient: fakeConv,
      embeddingClient: fakeEmb,
    },
  );

  assert.equal(report1.counts.stagedPendingPublishCount, 1);
  assert.equal(report1.counts.supersededCount, 0);

  const upgradeId = report1.upgradeId;
  const ledgerMap1 = await loadLedgerForSources(tenantWorkerSql, upgradeId, [sourceId]);
  const ledger1 = ledgerMap1.get(sourceId.toLowerCase())!;
  assert.equal(ledger1.outcome, "published");

  // Simulate publish: mark staging rows published
  await tenantWorkerSql`
    UPDATE paperclip_memory_upgrade_staging
    SET published_at = now()
    WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
  `;

  // Simulate content update on the live source row
  const updatedContent = "Updated content after initial publish";
  await tenantWorkerSql`
    UPDATE mem0_memories
    SET payload = jsonb_set(payload, '{data}', to_jsonb(${updatedContent}::text))
    WHERE id = ${sourceId}::uuid;
  `;

  // Tests 19 & 20: Run sweep again -> detects change, supersedes, re-converts in same sweep!
  const report2 = await runSweep(
    {
      databaseUrl: tenantWorkerUrl.toString(),
      controlPlaneUrl: cpWorkerUrl.toString(),
      companyId,
      confirm: companyId,
      tableName: "mem0_memories",
    } as any,
    {
      tenantSql: tenantWorkerSql,
      controlPlaneDb: cpWorkerDb,
      _internalSkipVectorIdentityCheck: true,
      conversionClient: fakeConv,
      embeddingClient: fakeEmb,
    },
  );

  assert.equal(report2.counts.supersededCount, 1, "supersededCount increments on content change");
  assert.equal(report2.counts.stagedPendingPublishCount, 1, "re-converts in same sweep");

  // Run sweep a third time with no content change: MUST NOT re-increment supersededCount!
  const report3 = await runSweep(
    {
      databaseUrl: tenantWorkerUrl.toString(),
      controlPlaneUrl: cpWorkerUrl.toString(),
      companyId,
      confirm: companyId,
      tableName: "mem0_memories",
    } as any,
    {
      tenantSql: tenantWorkerSql,
      controlPlaneDb: cpWorkerDb,
      _internalSkipVectorIdentityCheck: true,
      conversionClient: fakeConv,
      embeddingClient: fakeEmb,
    },
  );

  assert.equal(report3.counts.supersededCount, 0, "Test 19: supersededCount must NOT re-increment on repeated sweeps");
  assert.equal(report3.counts.skippedUnchangedCount, 1, "stable content is skipped unchanged");

  // Test 20: If source was superseded (e.g. by publish reconcile) with the current hash,
  // the next sweep MUST take the conversion path, not skippedUnchanged.
  await tenantWorkerSql`
    UPDATE paperclip_memory_upgrade_ledger
    SET outcome = 'superseded'
    WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
  `;

  assert.ok(RECONVERTIBLE_LEDGER_OUTCOMES.has("superseded"), "superseded is in RECONVERTIBLE_LEDGER_OUTCOMES");

  const report4 = await runSweep(
    {
      databaseUrl: tenantWorkerUrl.toString(),
      controlPlaneUrl: cpWorkerUrl.toString(),
      companyId,
      confirm: companyId,
      tableName: "mem0_memories",
    } as any,
    {
      tenantSql: tenantWorkerSql,
      controlPlaneDb: cpWorkerDb,
      _internalSkipVectorIdentityCheck: true,
      conversionClient: fakeConv,
      embeddingClient: fakeEmb,
    },
  );

  assert.equal(report4.counts.skippedUnchangedCount, 0, "Test 20: superseded row is NOT skipped as unchanged");
  assert.equal(report4.counts.supersededCount, 0, "supersededCount is not incremented when hash was already matching");
  assert.equal(report4.counts.stagedPendingPublishCount, 1, "superseded row took the conversion path");
});
