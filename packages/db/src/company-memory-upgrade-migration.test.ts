import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("company memory upgrade migration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()?.();
    }
  });

  async function setup() {
    const database = await startEmbeddedPostgresTestDatabase("company-memory-upgrade-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await sql.end();
    });
    return { sql, connectionString: database.connectionString };
  }

  it("creates company_memory_upgrades with all expected columns, constraints, and defaults", async () => {
    const { sql } = await setup();

    const columns = await sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'company_memory_upgrades'
      ORDER BY ordinal_position
    `;

    const columnMap = new Map(columns.map((c) => [c.column_name, c]));

    const expectedColumns = [
      "id",
      "company_id",
      "state",
      "recover_to_state",
      "converter_id",
      "converter_version",
      "collection_name",
      "embedding_model",
      "embedding_dimensions",
      "sweep_count",
      "source_seen_count",
      "published_count",
      "dropped_noise_count",
      "dropped_sensitive_count",
      "deduplicated_count",
      "unroutable_count",
      "quarantined_count",
      "superseded_count",
      "source_deleted_count",
      "llm_input_tokens",
      "llm_output_tokens",
      "embedding_tokens",
      "estimated_cost_nanodollars",
      "marked_at",
      "drain_confirmed_at",
      "verified_at",
      "pruned_at",
      "rolled_back_at",
      "completed_at",
      "last_error",
      "operator_label",
      "lease_token",
      "lease_owner",
      "lease_acquired_at",
      "lease_expires_at",
      "created_at",
      "updated_at",
    ];

    for (const col of expectedColumns) {
      expect(columnMap.has(col), `Column ${col} must exist`).toBe(true);
    }

    expect(columnMap.get("state")?.column_default).toContain("'sweeping'");
    expect(columnMap.get("sweep_count")?.column_default).toContain("0");
    expect(columnMap.get("llm_input_tokens")?.column_default).toContain("0");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("enforces state check constraint, rejecting invalid states", async () => {
    const { sql } = await setup();
    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Test Co', 'TC') RETURNING id`;

    await expect(
      sql`
        INSERT INTO company_memory_upgrades (
          company_id, state, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
        ) VALUES (
          ${company.id}, 'invalid_state', 'mem0-v1', 1, 'mem0_memories', 'text-embedding-3-small', 1536
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("enforces recover_to_state check constraint, rejecting invalid states", async () => {
    const { sql } = await setup();
    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Test Co', 'TC') RETURNING id`;

    await expect(
      sql`
        INSERT INTO company_memory_upgrades (
          company_id, state, recover_to_state, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
        ) VALUES (
          ${company.id}, 'needs_recovery', 'completed', 'mem0-v1', 1, 'mem0_memories', 'text-embedding-3-small', 1536
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("enforces foreign key constraint on company_id with ON DELETE RESTRICT", async () => {
    const { sql } = await setup();
    const fakeCompanyId = randomUUID();

    await expect(
      sql`
        INSERT INTO company_memory_upgrades (
          company_id, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
        ) VALUES (
          ${fakeCompanyId}, 'mem0-v1', 1, 'mem0_memories', 'text-embedding-3-small', 1536
        )
      `,
    ).rejects.toMatchObject({ code: "23503" });

    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Test FK', 'TFK') RETURNING id`;
    await sql`
      INSERT INTO company_memory_upgrades (
        company_id, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
      ) VALUES (
        ${company.id}, 'mem0-v1', 1, 'mem0_memories', 'text-embedding-3-small', 1536
      )
    `;

    await expect(sql`DELETE FROM companies WHERE id = ${company.id}`).rejects.toMatchObject({
      code: expect.stringMatching(/^(23503|23001)$/),
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("enforces partial unique index for active upgrades per company, allowing a new one once terminal", async () => {
    const { sql } = await setup();
    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Active UQ Co', 'AUQ') RETURNING id`;

    const [first] = await sql`
      INSERT INTO company_memory_upgrades (
        company_id, state, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
      ) VALUES (
        ${company.id}, 'sweeping', 'mem0-v1', 1, 'mem0_memories', 'text-embedding-3-small', 1536
      ) RETURNING id
    `;

    // Attempting a second active upgrade for the same company fails
    await expect(
      sql`
        INSERT INTO company_memory_upgrades (
          company_id, state, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
        ) VALUES (
          ${company.id}, 'flipping', 'mem0-v1', 1, 'mem0_memories', 'text-embedding-3-small', 1536
        )
      `,
    ).rejects.toMatchObject({ code: "23505" });

    // Transition first to completed (terminal)
    await sql`UPDATE company_memory_upgrades SET state = 'completed' WHERE id = ${first.id}`;

    // Now inserting another active upgrade succeeds
    const [second] = await sql`
      INSERT INTO company_memory_upgrades (
        company_id, state, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
      ) VALUES (
        ${company.id}, 'sweeping', 'mem0-v1', 2, 'mem0_memories', 'text-embedding-3-small', 1536
      ) RETURNING id
    `;
    expect(second.id).toBeDefined();

    // Transition second to aborted (terminal)
    await sql`UPDATE company_memory_upgrades SET state = 'aborted' WHERE id = ${second.id}`;

    // Third active upgrade succeeds
    const [third] = await sql`
      INSERT INTO company_memory_upgrades (
        company_id, state, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
      ) VALUES (
        ${company.id}, 'sweeping', 'mem0-v1', 3, 'mem0_memories', 'text-embedding-3-small', 1536
      ) RETURNING id
    `;
    expect(third.id).toBeDefined();

    // Transition third to rolled_back (terminal)
    await sql`UPDATE company_memory_upgrades SET state = 'rolled_back' WHERE id = ${third.id}`;

    // Fourth active upgrade succeeds
    const [fourth] = await sql`
      INSERT INTO company_memory_upgrades (
        company_id, state, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
      ) VALUES (
        ${company.id}, 'sweeping', 'mem0-v1', 4, 'mem0_memories', 'text-embedding-3-small', 1536
      ) RETURNING id
    `;
    expect(fourth.id).toBeDefined();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("has row-level security enabled, forced, and tenant_isolation policy active", async () => {
    const { sql, connectionString } = await setup();

    const [tableInfo] = await sql`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = 'company_memory_upgrades' AND relnamespace = 'public'::regnamespace
    `;
    expect(tableInfo.relrowsecurity).toBe(true);
    expect(tableInfo.relforcerowsecurity).toBe(true);

    const [policy] = await sql`
      SELECT policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
      WHERE tablename = 'company_memory_upgrades' AND policyname = 'tenant_isolation'
    `;
    expect(policy).toBeDefined();
    expect(policy.policyname).toBe("tenant_isolation");

    // Test tenant isolation filtering under RLS with a non-superuser role (superusers bypass RLS in Postgres)
    const testRole = "test_rls_tenant_user";
    const testPass = "test_rls_tenant_pass";
    await sql.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${testRole}') THEN
          CREATE ROLE ${testRole} LOGIN PASSWORD '${testPass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${testRole}`);
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${testRole}`);

    const [companyA] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Company A', 'CA') RETURNING id`;
    const [companyB] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Company B', 'CB') RETURNING id`;

    const [upgradeA] = await sql`
      INSERT INTO company_memory_upgrades (
        company_id, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
      ) VALUES (
        ${companyA.id}, 'mem0-v1', 1, 'mem0_memories', 'text-embedding-3-small', 1536
      ) RETURNING id
    `;
    const [upgradeB] = await sql`
      INSERT INTO company_memory_upgrades (
        company_id, converter_id, converter_version, collection_name, embedding_model, embedding_dimensions
      ) VALUES (
        ${companyB.id}, 'mem0-v1', 1, 'mem0_memories', 'text-embedding-3-small', 1536
      ) RETURNING id
    `;

    // Connect as non-superuser
    const appUrl = new URL(connectionString);
    appUrl.username = testRole;
    appUrl.password = testPass;
    const appSql = postgres(appUrl.toString(), { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await appSql.end();
    });

    // Without tenant context (unset), both rows visible
    const allRows = await appSql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.current_company_id', '', true)`);
      return await tx`SELECT id FROM company_memory_upgrades WHERE id IN (${upgradeA.id}, ${upgradeB.id})`;
    });
    expect(allRows).toHaveLength(2);

    // With Company A context, only upgradeA visible
    const rowsA = await appSql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.current_company_id', $1, true)`, [companyA.id]);
      return await tx`SELECT id FROM company_memory_upgrades WHERE id IN (${upgradeA.id}, ${upgradeB.id})`;
    });
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].id).toBe(upgradeA.id);

    // With Company B context, only upgradeB visible
    const rowsB = await appSql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.current_company_id', $1, true)`, [companyB.id]);
      return await tx`SELECT id FROM company_memory_upgrades WHERE id IN (${upgradeA.id}, ${upgradeB.id})`;
    });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].id).toBe(upgradeB.id);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
