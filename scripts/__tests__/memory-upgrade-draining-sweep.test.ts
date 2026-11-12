/**
 * Draining state acceptance and state refusal tests for sweep (TECH-8191 §5.2).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
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
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("sweep accepts draining state and restricts to company scope (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-sw-");
  const cpDb = createDb(fixture.connectionString);
  const tenantSql = openTenantClient(fixture.connectionString);
  await setupTenantMem0Table(tenantSql, "mem0_memories");

  await tenantSql.unsafe(`
    CREATE ROLE sw_r WITH LOGIN PASSWORD 'p' NOSUPERUSER NOBYPASSRLS;
    GRANT ALL ON SCHEMA public TO sw_r; GRANT ALL ON ALL TABLES IN SCHEMA public TO sw_r;
  `);

  const workerUrl = new URL(fixture.connectionString);
  workerUrl.username = "sw_r"; workerUrl.password = "p";

  const workerSql = openTenantClient(workerUrl.toString());
  const workerCp = createDb(workerUrl.toString());

  t.after(async () => {
    await workerSql.end(); await tenantSql.end();
    await cpDb.$client.end({ timeout: 1 });
    await fixture.cleanup();
  });

  const companyId = randomUUID();
  const agentId = randomUUID();

  const [info] = await workerSql`SELECT current_database()::text AS db, current_user::text AS usr;`;
  await cpDb.insert(companies).values({ id: companyId, name: "DS Co", issuePrefix: "DS" });
  await cpDb.insert(companyMemoryDatabases).values({
    id: randomUUID(), companyId, databaseName: info.db, databaseRole: info.usr,
    host: "localhost", port: 5432, status: "ready", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536,
  });
  await cpDb.insert(agents).values({ id: agentId, companyId, name: "A1", adapterType: "hermes_local", status: "active" });

  const [upgrade] = await cpDb.insert(companyMemoryUpgrades).values({
    companyId, state: "draining", converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1, collectionName: "mem0_memories", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536,
    drainProbeStreakStartedAt: new Date(),
    drainConfirmedAt: new Date(),
  }).returning();

  const legacySourceId = randomUUID();
  const agentSourceId = randomUUID();
  await insertTenantMemoryRow(workerSql, { id: legacySourceId, agentId, userId: "company", data: "Legacy" });
  await insertTenantMemoryRow(workerSql, { id: agentSourceId, agentId, userId: agentId, data: "Agent" });

  let convCalls = 0;
  const fakeConv = createFakeConversionClient(() => (++convCalls, { status: "convert" }));

  const params = { databaseUrl: workerUrl.toString(), controlPlaneUrl: workerUrl.toString(), companyId, confirm: companyId } as any;
  const deps = {
    tenantSql: workerSql,
    controlPlaneDb: workerCp,
    _internalSkipVectorIdentityCheck: true,
    conversionClient: fakeConv,
    embeddingClient: createFakeEmbeddingClient(),
  };

  const report = await runSweep(params, deps);
  assert.equal(report.upgradeId, upgrade.id);
  assert.equal(report.counts.stagedPendingPublishCount, 1);
  assert.equal(convCalls, 1);

  const [upgradeAfterSweep] = await cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, upgrade.id));
  assert.equal(upgradeAfterSweep.drainProbeStreakStartedAt, null);
  assert.equal(upgradeAfterSweep.drainConfirmedAt, null);

  const [staged] = await workerSql`SELECT source_id::text FROM paperclip_memory_upgrade_staging WHERE upgrade_id = ${upgrade.id}::uuid;`;
  assert.equal(staged.source_id.toLowerCase(), legacySourceId.toLowerCase());

  const ledgerAgent = await workerSql`SELECT 1 FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${upgrade.id}::uuid AND source_id = ${agentSourceId}::uuid;`;
  assert.equal(ledgerAgent.length, 0);

  // Refusals
  await cpDb.update(companyMemoryUpgrades).set({ state: "needs_recovery" }).where(eq(companyMemoryUpgrades.id, upgrade.id));
  await assert.rejects(() => runSweep(params, deps), (err: any) => err.code === "STATE_MISMATCH");

  for (const st of ["flipping", "verified", "pruning"] as const) {
    await cpDb.update(companyMemoryUpgrades).set({ state: st }).where(eq(companyMemoryUpgrades.id, upgrade.id));
    await assert.rejects(() => runSweep(params, deps), (err: any) => err.code === "STATE_MISMATCH");
  }
});

test("sweep: state change between findActiveUpgrade read and fence claim fences worker out (TECH-8191)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("drain-sw-race-");
  const cpDb = createDb(fixture.connectionString);
  const tenantSql = openTenantClient(fixture.connectionString);
  await setupTenantMem0Table(tenantSql, "mem0_memories");

  await tenantSql.unsafe(`
    CREATE ROLE sw_r2 WITH LOGIN PASSWORD 'p' NOSUPERUSER NOBYPASSRLS;
    GRANT ALL ON SCHEMA public TO sw_r2; GRANT ALL ON ALL TABLES IN SCHEMA public TO sw_r2;
  `);

  const workerUrl = new URL(fixture.connectionString);
  workerUrl.username = "sw_r2"; workerUrl.password = "p";

  const workerSql = openTenantClient(workerUrl.toString());
  const workerCp = createDb(workerUrl.toString());

  t.after(async () => {
    await workerSql.end(); await tenantSql.end();
    await cpDb.$client.end({ timeout: 1 });
    await fixture.cleanup();
  });

  const companyId = randomUUID();
  const agentId = randomUUID();

  const [info] = await workerSql`SELECT current_database()::text AS db, current_user::text AS usr;`;
  await cpDb.insert(companies).values({ id: companyId, name: "Race Sweep Co", issuePrefix: "RS" });
  await cpDb.insert(companyMemoryDatabases).values({
    id: randomUUID(), companyId, databaseName: info.db, databaseRole: info.usr,
    host: "localhost", port: 5432, status: "ready", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536,
  });
  await cpDb.insert(agents).values({ id: agentId, companyId, name: "A1", adapterType: "hermes_local", status: "active" });

  // 1. Upgrade starts in 'sweeping' state
  const [upgrade] = await cpDb.insert(companyMemoryUpgrades).values({
    companyId, state: "sweeping", converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1, collectionName: "mem0_memories", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536,
  }).returning();

  const legacySourceId = randomUUID();
  const agentSourceId = randomUUID();
  await insertTenantMemoryRow(workerSql, { id: legacySourceId, agentId, userId: "company", data: "Legacy memory before flip" });
  await insertTenantMemoryRow(workerSql, { id: agentSourceId, agentId, userId: agentId, data: "Native agent memory post flip" });

  let convCalls = 0;
  const fakeConv = createFakeConversionClient(() => (++convCalls, { status: "convert" }));

  // Intercept ensureUpgradeTables (which runs after findActiveUpgrade/read & lease claim, right before claimTenantFenceGuarded)
  // to simulate a concurrent worker transitioning the upgrade sweeping -> flipping -> draining
  const origBegin = workerSql.begin.bind(workerSql);
  let stateTransitioned = false;
  workerSql.begin = (async (...args: any[]) => {
    const res = await (origBegin as any)(...args);
    if (!stateTransitioned) {
      stateTransitioned = true;
      // Concurrent transition occurs while Worker A read 'sweeping'
      await cpDb
        .update(companyMemoryUpgrades)
        .set({ state: "draining" })
        .where(eq(companyMemoryUpgrades.id, upgrade.id));
    }
    return res;
  }) as any;

  const params = { databaseUrl: workerUrl.toString(), controlPlaneUrl: workerUrl.toString(), companyId, confirm: companyId } as any;
  const deps = {
    tenantSql: workerSql,
    controlPlaneDb: workerCp,
    _internalSkipVectorIdentityCheck: true,
    conversionClient: fakeConv,
    embeddingClient: createFakeEmbeddingClient(),
  };

  await assert.rejects(
    () => runSweep(params, deps),
    (err: any) => {
      assert.equal(err instanceof CompanyMemoryUpgradeError, true);
      assert.equal(err.code, "LEASE_FENCED_OUT");
      return true;
    },
  );

  assert.equal(stateTransitioned, true);
  // Zero source conversion calls
  assert.equal(convCalls, 0);

  // Zero rows staged
  const staged = await tenantSql`SELECT count(*)::int AS count FROM paperclip_memory_upgrade_staging WHERE upgrade_id = ${upgrade.id}::uuid;`;
  assert.equal(staged[0].count, 0);

  // Zero ledger rows
  const ledger = await tenantSql`SELECT count(*)::int AS count FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${upgrade.id}::uuid;`;
  assert.equal(ledger[0].count, 0);

  // Live source memories untouched
  const liveRows = await tenantSql`SELECT count(*)::int AS count FROM mem0_memories;`;
  assert.equal(liveRows[0].count, 2);
});
