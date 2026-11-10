/**
 * Multi-page cost accounting end-to-end integration test (TECH-8191 finding COST).
 *
 * Pure unit coverage for cost.ts (rounding, preflight projection, budget tracker semantics)
 * lives in memory-upgrade-sweep-cost-unit.test.ts (branch A). This file keeps only the
 * embedded-postgres end-to-end test, which exercises the real runSweep() multi-page flush
 * path and therefore belongs alongside the rest of the orchestrator integration tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createDb,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  ManualClock,
  setupTenantMem0Table,
  sql,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";

test("multi-page sweep: exact nontriangular per-page cost accounting (end-to-end)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("sweep-cost-cp-");
  const cpDb = createDb(cpFixture.connectionString);

  const tenantFixture = await startEmbeddedPostgresTestDatabase("sweep-cost-tenant-");
  const tenantSql = openTenantClient(tenantFixture.connectionString);

  await tenantSql.unsafe(`CREATE ROLE cost_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await tenantSql.unsafe(`GRANT ALL ON SCHEMA public TO cost_tenant;`);
  await tenantSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO cost_tenant;`);
  await tenantSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO cost_tenant;`);

  await cpDb.execute(sql`CREATE ROLE cost_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await cpDb.execute(sql`GRANT ALL ON SCHEMA public TO cost_cp;`);
  await cpDb.execute(sql`GRANT ALL ON ALL TABLES IN SCHEMA public TO cost_cp;`);
  await cpDb.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO cost_cp;`);

  const tenantWorkerUrl = new URL(tenantFixture.connectionString);
  tenantWorkerUrl.username = "cost_tenant";
  tenantWorkerUrl.password = "pass123";

  const cpWorkerUrl = new URL(cpFixture.connectionString);
  cpWorkerUrl.username = "cost_cp";
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

  const [company] = await cpDb.insert(companies).values({
    name: "Cost Accounting Co",
    issuePrefix: "CA",
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

  const [agent] = await cpDb.insert(agents).values({
    companyId: company.id,
    name: "Cost Agent",
    adapterType: "hermes_local",
    status: "active",
  }).returning();

  await setupTenantMem0Table(tenantSql, "mem0_memories");

  // 3 sources, pageSize=1 -> 3 separate pages, each independently flushed.
  for (let i = 0; i < 3; i++) {
    await insertTenantMemoryRow(tenantSql, {
      agentId: agent.id,
      data: `Substantive durable fact number ${i} for cost accounting.`,
    });
  }

  // Fixed per-source token counts (deterministic regardless of input text) and round
  // USD/M prices (1 USD/M tokens => 1000 nanodollars/token exactly, no fractional ceiling
  // remainder) so the expected total is exact and trivially checkable.
  const FIXED_INPUT_TOKENS = 100;
  const FIXED_OUTPUT_TOKENS = 50;
  const FIXED_EMBEDDING_TOKENS = 10;
  const conversionClient = {
    async convert(text: string) {
      return {
        status: "convert" as const,
        records: [
          {
            data: `Converted: ${text}`.slice(0, 100),
            type: "fact" as const,
            subject: "cost accounting subject",
            confidence: 0.9,
          },
        ],
        inputTokens: FIXED_INPUT_TOKENS,
        outputTokens: FIXED_OUTPUT_TOKENS,
      };
    },
  };
  const embeddingClient = {
    async embed() {
      return { embedding: new Array(1536).fill(0.01), tokens: FIXED_EMBEDDING_TOKENS };
    },
  };

  const expectedPerSourceNano =
    FIXED_INPUT_TOKENS * 1000 + FIXED_OUTPUT_TOKENS * 1000 + FIXED_EMBEDDING_TOKENS * 1000;
  const expectedTotalNano = BigInt(expectedPerSourceNano * 3);

  const clock = new ManualClock();
  const report = await runSweep(
    {
      databaseUrl: tenantWorkerUrl.toString(),
      controlPlaneUrl: cpWorkerUrl.toString(),
      companyId: company.id,
      pageSize: 1,
      pauseWhenActiveRuns: 0,
      chatInputUsdPerMillion: 1,
      chatOutputUsdPerMillion: 1,
      embeddingUsdPerMillion: 1,
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

  assert.equal(report.counts.estimatedCostNanodollars, Number(expectedTotalNano));

  const [upgrade] = await cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.companyId, company.id));

  // THE regression this test exists to catch: if the control-plane flush ever wrote the
  // CUMULATIVE total as a per-page "delta" (double-counting already-flushed pages), this
  // stored total would be MUCH larger than expectedTotalNano (triangular growth across 3
  // pages: 1x + 2x + 3x = 6x instead of 3x). It must be EXACTLY the sum of 3 equal deltas.
  assert.equal(BigInt(upgrade.estimatedCostNanodollars), expectedTotalNano);
  assert.equal(upgrade.publishedCount, 0, "COUNTER finding: publishedCount must stay zero");
});
