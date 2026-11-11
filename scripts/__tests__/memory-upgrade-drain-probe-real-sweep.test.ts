/**
 * Drain probe integration test with real sweep execution (TECH-8191 §Q3, PR5.5).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runDrainProbe } from "../../server/src/services/company-memory-upgrade/drain-probe.js";
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import {
  agents,
  companies,
  companyMemoryDatabases,
  createDb,
  createFakeConversionClient,
  createFakeEmbeddingClient,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("drain probe returns 0 after real sweep over all gate classifications (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-real-sw-");
  const cpDb = createDb(fixture.connectionString);
  const tenantSql = openTenantClient(fixture.connectionString);

  await tenantSql.unsafe(`
    CREATE ROLE sw_probe_r WITH LOGIN PASSWORD 'p' NOSUPERUSER NOBYPASSRLS;
    GRANT ALL ON SCHEMA public TO sw_probe_r;
  `);

  const workerUrl = new URL(fixture.connectionString);
  workerUrl.username = "sw_probe_r";
  workerUrl.password = "p";

  const workerSql = openTenantClient(workerUrl.toString());
  const workerCp = createDb(workerUrl.toString());

  t.after(async () => {
    await workerSql.end();
    await tenantSql.end();
    await workerCp.$client.end({ timeout: 1 });
    await cpDb.$client.end({ timeout: 1 });
    await fixture.cleanup();
  });

  const [company] = await cpDb.insert(companies).values({ name: "Probe Sweep Co", issuePrefix: "PSWP" }).returning();
  const [tInfo] = await workerSql`SELECT current_database()::text AS db, current_user::text AS usr;`;

  await cpDb.insert(companyMemoryDatabases).values({
    companyId: company.id, status: "ready", bindingVerifiedAt: new Date(),
    databaseName: tInfo.db, databaseRole: tInfo.usr, host: "localhost", port: 5432,
  });

  const [hermesAgent] = await cpDb.insert(agents).values({
    companyId: company.id, name: "Hermes Agent", adapterType: "hermes_local", status: "active",
  }).returning();

  const [nonHermesAgent] = await cpDb.insert(agents).values({
    companyId: company.id, name: "Process Agent", adapterType: "process", status: "active",
  }).returning();

  const cpAgentMap = new Map([
    [hermesAgent.id.trim().toLowerCase(), hermesAgent],
    [nonHermesAgent.id.trim().toLowerCase(), nonHermesAgent],
  ]);

  const tableName = "mem0_memories";
  await setupTenantMem0Table(tenantSql, tableName);
  await tenantSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO sw_probe_r;`);

  // Fixture rows: routable, unroutable (missing/malformed/unknown/non-hermes), whitespace, noise, sensitive
  const ins = (agentId: any, data: string) => insertTenantMemoryRow(workerSql, { tableName, agentId, userId: "company", data });
  await ins(hermesAgent.id, "Durable preference for Postgres.");
  await ins(null, "Preference without agent id.");
  await ins("not-a-valid-uuid", "Preference with malformed agent.");
  await ins(randomUUID(), "Preference with unknown agent.");
  await ins(nonHermesAgent.id, "Preference with process adapter.");
  await ins(`  ${hermesAgent.id.toUpperCase()}  `, "Preference with uppercase spaces.");
  await ins(hermesAgent.id, "hello");
  await ins(hermesAgent.id, "Secret key is AKIAIOSFODNN7EXAMPLE");

  const report = await runSweep(
    {
      databaseUrl: workerUrl.toString(), controlPlaneUrl: workerUrl.toString(),
      companyId: company.id, tableName, pauseWhenActiveRuns: 0,
    },
    {
      controlPlaneDb: workerCp, tenantSql: workerSql,
      conversionClient: createFakeConversionClient(), embeddingClient: createFakeEmbeddingClient(),
      _internalSkipVectorIdentityCheck: true,
      _internalDatabaseIdentityOverride: { database: tInfo.db, user: tInfo.usr },
    },
  );

  assert.ok(report.upgradeId);
  await workerSql`UPDATE paperclip_memory_upgrade_staging SET published_at = now() WHERE upgrade_id = ${report.upgradeId}::uuid;`;

  // Initial probe after real sweep + publish MUST return 0 blocking
  const probe = await runDrainProbe(workerSql, { upgradeId: report.upgradeId, tableName, cpAgentMap });
  assert.equal(probe.blockingSources, 0);
  assert.equal(probe.missingScopeBlockingSources, 0);
  assert.equal(probe.pendingPublishableRows, 0);
});
