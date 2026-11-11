/**
 * Shared test helpers for company memory upgrade publish tests (TECH-8191).
 */

import { randomUUID } from "node:crypto";
import type postgres from "postgres";

export interface SeedStagedMemoryParams {
  upgradeId: string;
  sourceId: string;
  outputId?: string;
  agentId?: string;
  payload?: Record<string, unknown>;
  publishedAt?: Date | null;
  contentSha256?: string;
  vector?: string;
}

export async function seedStagedMemory(
  sql: postgres.Sql,
  params: SeedStagedMemoryParams,
): Promise<{ outputId: string; payload: Record<string, unknown> }> {
  const outputId = params.outputId ?? randomUUID();
  const agentId = params.agentId ?? randomUUID();
  const payload = params.payload ?? {
    data: "test staged memory payload",
    agent_id: agentId,
    migration_id: params.upgradeId,
    migrated_from: params.sourceId,
  };
  const contentSha256 = params.contentSha256 ?? "test-sha256";
  const vector = params.vector ?? JSON.stringify(new Array(1536).fill(0.01));
  const publishedAtSql = params.publishedAt ? sql`${params.publishedAt}` : null;

  await sql`
    INSERT INTO paperclip_memory_upgrade_staging (
      upgrade_id,
      source_id,
      output_id,
      agent_id,
      payload,
      embedding,
      content_sha256,
      published_at,
      created_at
    ) VALUES (
      ${params.upgradeId}::uuid,
      ${params.sourceId}::uuid,
      ${outputId}::uuid,
      ${agentId}::uuid,
      ${JSON.stringify(payload)}::jsonb,
      ${vector},
      ${contentSha256},
      ${publishedAtSql},
      now()
    );
  `;

  return { outputId, payload };
}

export async function seedLedgerRow(
  sql: postgres.Sql,
  params: {
    upgradeId: string;
    sourceId: string;
    agentId?: string;
    outcome?: string;
    outputIds?: string[];
    sourceContentSha256?: string;
  },
): Promise<void> {
  const agentId = params.agentId ?? randomUUID();
  const outcome = params.outcome ?? "published";
  const outputIds = params.outputIds ?? [];
  const sha = params.sourceContentSha256 ?? "source-content-sha";

  await sql`
    INSERT INTO paperclip_memory_upgrade_ledger (
      upgrade_id,
      source_id,
      source_content_sha256,
      agent_id,
      outcome,
      output_ids,
      created_at,
      updated_at
    ) VALUES (
      ${params.upgradeId}::uuid,
      ${params.sourceId}::uuid,
      ${sha},
      ${agentId}::uuid,
      ${outcome},
      ${outputIds}::uuid[],
      now(),
      now()
    )
    ON CONFLICT (upgrade_id, source_id) DO UPDATE SET
      outcome = EXCLUDED.outcome,
      output_ids = EXCLUDED.output_ids,
      updated_at = now();
  `;
}

export async function setupPublishTestEnvironment(prefix: string) {
  const {
    startEmbeddedPostgresTestDatabase,
    createDb,
    companies,
    companyMemoryDatabases,
    agents,
    setupTenantMem0Table,
    sql: drizzleSql,
  } = await import("./memory-upgrade-sweep-helpers.js");
  const { openTenantClient, ensureUpgradeTables } = await import(
    "../../server/src/services/company-memory-upgrade/sweep-tenant.js"
  );

  const tenantFixture = await startEmbeddedPostgresTestDatabase(`${prefix}-tenant-`);
  const cpFixture = await startEmbeddedPostgresTestDatabase(`${prefix}-cp-`);

  const tenantSql = openTenantClient(tenantFixture.connectionString);
  const cpDb = createDb(cpFixture.connectionString);

  // Setup dedicated non-superuser worker roles
  await tenantSql.unsafe(`
    DO $$ BEGIN
      CREATE ROLE pub_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
    GRANT ALL ON SCHEMA public TO pub_tenant;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO pub_tenant;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO pub_tenant;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO pub_tenant;
  `);

  await cpDb.execute(drizzleSql`
    DO $$ BEGIN
      CREATE ROLE pub_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
    GRANT ALL ON SCHEMA public TO pub_cp;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO pub_cp;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO pub_cp;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO pub_cp;
  `);

  const tenantUrl = new URL(tenantFixture.connectionString);
  tenantUrl.username = "pub_tenant";
  tenantUrl.password = "pass123";

  const cpUrl = new URL(cpFixture.connectionString);
  cpUrl.username = "pub_cp";
  cpUrl.password = "pass123";

  const tenantWorkerSql = openTenantClient(tenantUrl.toString());
  const cpWorkerDb = createDb(cpUrl.toString());

  await setupTenantMem0Table(tenantSql, "mem0_memories");
  await tenantSql.unsafe(`ALTER TABLE "mem0_memories" OWNER TO pub_tenant;`);
  await ensureUpgradeTables(tenantWorkerSql, "text");

  const [company] = await cpDb.insert(companies).values({
    name: "Publish Test Co",
    issuePrefix: "PT",
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
    name: "Hermes Agent",
    adapterType: "hermes_local",
    status: "active",
  }).returning();

  return {
    company,
    agent,
    tenantSql,
    cpDb,
    tenantWorkerSql,
    cpWorkerDb,
    async cleanup() {
      await tenantWorkerSql.end().catch(() => {});
      await cpWorkerDb.$client?.end().catch(() => {});
      await tenantSql.end().catch(() => {});
      await cpDb.$client?.end().catch(() => {});
      await tenantFixture.cleanup().catch(() => {});
      await cpFixture.cleanup().catch(() => {});
    },
  };
}
