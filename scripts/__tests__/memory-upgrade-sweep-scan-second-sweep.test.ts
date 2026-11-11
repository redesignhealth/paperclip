/**
 * Regression test: second sweep after publish excludes published rows (TECH-8191 §5.1).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  iterateSourcePages,
  openTenantClient,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { ensureUpgradeTables } from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
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

test("second sweep after publish excludes published rows (embedded postgres + runSweep)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("sw-ex-pub-");
  const cpDb = createDb(fixture.connectionString);
  const tenantSql = openTenantClient(fixture.connectionString);
  await setupTenantMem0Table(tenantSql, "mem0_memories");

  await tenantSql.unsafe(`
    CREATE ROLE st_r WITH LOGIN PASSWORD 'p' NOSUPERUSER NOBYPASSRLS;
    GRANT ALL ON SCHEMA public TO st_r;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO st_r;
    CREATE ROLE sc_r WITH LOGIN PASSWORD 'p' NOSUPERUSER NOBYPASSRLS;
    GRANT ALL ON SCHEMA public TO sc_r;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO sc_r;
  `);

  const tUrl = new URL(fixture.connectionString);
  tUrl.username = "st_r";
  tUrl.password = "p";
  const cUrl = new URL(fixture.connectionString);
  cUrl.username = "sc_r";
  cUrl.password = "p";

  const workerSql = openTenantClient(tUrl.toString());
  const workerCp = createDb(cUrl.toString());

  t.after(async () => {
    await workerSql.end();
    await workerCp.$client.end({ timeout: 1 });
    await tenantSql.end();
    await cpDb.$client.end({ timeout: 1 });
    await fixture.cleanup();
  });

  const companyId = randomUUID();
  const agentId = randomUUID();
  const source1 = randomUUID();

  const [info] = await workerSql`SELECT current_database()::text AS db, current_user::text AS usr;`;
  await cpDb.insert(companies).values({ id: companyId, name: "EP Co", issuePrefix: "EP" });
  await cpDb.insert(companyMemoryDatabases).values({
    id: randomUUID(),
    companyId,
    databaseName: info.db,
    databaseRole: info.usr,
    host: "localhost",
    port: 5432,
    status: "ready",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  });
  await cpDb.insert(agents).values({ id: agentId, companyId, name: "A1", adapterType: "hermes_local", status: "active" });
  await insertTenantMemoryRow(workerSql, { id: source1, agentId, data: "legacy 1" });

  let convCalls = 0;
  const fakeConv = createFakeConversionClient(() => {
    convCalls++;
    return { status: "convert" };
  });

  const params = { databaseUrl: tUrl.toString(), controlPlaneUrl: cUrl.toString(), companyId, confirm: companyId } as any;
  const deps = { tenantSql: workerSql, controlPlaneDb: workerCp, _internalSkipVectorIdentityCheck: true, conversionClient: fakeConv, embeddingClient: createFakeEmbeddingClient() };

  const r1 = await runSweep(params, deps);
  assert.equal(r1.counts.stagedPendingPublishCount, 1);
  assert.equal(convCalls, 1);

  // Simulate publish
  const staged = await workerSql`SELECT output_id FROM paperclip_memory_upgrade_staging WHERE upgrade_id = ${r1.upgradeId}::uuid;`;
  const pubOutputId = staged[0].output_id;
  await insertTenantMemoryRow(workerSql, { id: pubOutputId, agentId, userId: agentId, data: "c" });
  await workerSql`UPDATE paperclip_memory_upgrade_staging SET published_at = now() WHERE upgrade_id = ${r1.upgradeId}::uuid;`;

  // Simulate a partial crash during publish:
  // Live row was inserted, but publish crashed before setting published_at (remains NULL).
  // Correctness invariant: this row is already an upgrade output and must be excluded.
  const crashOutputId = randomUUID();
  await workerSql`
    INSERT INTO paperclip_memory_upgrade_staging (
      upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at
    ) VALUES (
      ${r1.upgradeId}::uuid, ${source1}::uuid, ${crashOutputId}::uuid, ${agentId}::uuid,
      '{"data": "crash-sim"}'::jsonb, 'mock-vec', 'crash-sha', NULL
    );
  `;
  await insertTenantMemoryRow(workerSql, { id: crashOutputId, agentId, userId: agentId, data: "crash-sim" });

  // New legacy row post-publish
  const source2 = randomUUID();
  await insertTenantMemoryRow(workerSql, { id: source2, agentId, data: "legacy 2" });

  // Sweep 2 ignores BOTH pubOutputId AND crashOutputId (partial-crash window), discovers only source2
  const r2 = await runSweep(params, deps);
  assert.equal(convCalls, 2);
  assert.equal(r2.counts.stagedPendingPublishCount, 1);

  const ledgerPub = await workerSql`SELECT 1 FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${r1.upgradeId}::uuid AND source_id = ${pubOutputId}::uuid;`;
  assert.equal(ledgerPub.length, 0);
  const ledgerCrash = await workerSql`SELECT 1 FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${r1.upgradeId}::uuid AND source_id = ${crashOutputId}::uuid;`;
  assert.equal(ledgerCrash.length, 0);

  // Verify UUID exclusion query uses output_id index
  await workerSql.unsafe("SET enable_hashjoin = off; SET enable_mergejoin = off; SET enable_seqscan = off;");
  const planUuid = await workerSql.unsafe(`
    EXPLAIN SELECT lower(t.id::text) AS id FROM mem0_memories t
    WHERE NOT EXISTS (SELECT 1 FROM paperclip_memory_upgrade_staging s WHERE s.output_id = t.id)
  `) as Array<Record<string, string>>;
  const planUuidStr = planUuid.map((r) => Object.values(r)[0]).join("\n");
  assert.ok(
    planUuidStr.includes("pmu_staging_output_id_idx") || planUuidStr.includes("paperclip_memory_upgrade_staging_pkey"),
    `UUID query plan must use output_id index: ${planUuidStr}`,
  );
  await workerSql.unsafe("SET enable_hashjoin = on; SET enable_mergejoin = on; SET enable_seqscan = on;");
});
