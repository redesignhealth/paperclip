/**
 * Reconcile semantics: sweep superseded skip-check and re-conversion integration (TECH-8191).
 * Tests 19 and 20 from §7.3.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  loadLedgerForSources,
  openTenantClient,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
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
} from "./memory-upgrade-sweep-helpers.js";
import { createDb, companies, companyMemoryDatabases, agents } from "../../packages/db/src/index.js";
import "./memory-upgrade-sweep-scan-excludes-outputs.test.js";
import "./memory-upgrade-sweep-scan-excludes-fake.test.js";
import "./memory-upgrade-sweep-scan-second-sweep.test.js";
import "./memory-upgrade-sweep-scan-text-id.test.js";

test("superseded skip-check and re-conversion integration (embedded postgres + runSweep)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("publish-reconcile-sweep-");
  const cpDb = createDb(fixture.connectionString);
  const tenantSql = openTenantClient(fixture.connectionString);

  await setupTenantMem0Table(tenantSql, "mem0_memories");

  // Create non-superuser roles for tenant and control-plane preflights
  await tenantSql.unsafe(`
    CREATE ROLE recon_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;
    GRANT ALL ON SCHEMA public TO recon_tenant;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO recon_tenant;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO recon_tenant;
    CREATE ROLE recon_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;
    GRANT ALL ON SCHEMA public TO recon_cp;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO recon_cp;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO recon_cp;
  `);

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
  const sweepParams = {
    databaseUrl: tenantWorkerUrl.toString(),
    controlPlaneUrl: cpWorkerUrl.toString(),
    companyId,
    confirm: companyId,
    tableName: "mem0_memories",
  } as any;
  const sweepDeps = {
    tenantSql: tenantWorkerSql,
    controlPlaneDb: cpWorkerDb,
    _internalSkipVectorIdentityCheck: true,
    conversionClient: fakeConv,
    embeddingClient: fakeEmb,
  };

  // Run 1: sweep converts the source
  const report1 = await runSweep(sweepParams, sweepDeps);
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
  const report2 = await runSweep(sweepParams, sweepDeps);
  assert.equal(report2.counts.supersededCount, 1, "supersededCount increments on content change");
  assert.equal(report2.counts.stagedPendingPublishCount, 1, "re-converts in same sweep");

  // Run sweep a third time with no content change: MUST NOT re-increment supersededCount!
  const report3 = await runSweep(sweepParams, sweepDeps);
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

  const report4 = await runSweep(sweepParams, sweepDeps);
  assert.equal(report4.counts.skippedUnchangedCount, 0, "Test 20: superseded row is NOT skipped as unchanged");
  assert.equal(report4.counts.supersededCount, 0, "supersededCount is not incremented when hash was already matching");
  assert.equal(report4.counts.stagedPendingPublishCount, 1, "superseded row took the conversion path");
});
