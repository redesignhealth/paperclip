import { randomUUID } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0379_slack_configuration_credentials.sql";
const migrationSql = fs.readFileSync(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Slack configuration credential migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("Slack configuration credential migration (TECH-7981)", () => {
  it("creates the table, its check constraint and its unique indexes", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-slack-configuration-credentials-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const columns = await sql<{ column_name: string; is_nullable: string; data_type: string }[]>`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
      WHERE table_name = 'chat_slack_configuration_credentials'
      ORDER BY column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      "access_expires_at",
      "access_secret_id",
      "chain_generation",
      "company_id",
      "created_at",
      "id",
      "last_rotated_at",
      "refresh_secret_id",
      "revision",
      "rotation_started_at",
      "slack_user_id",
      "status",
      "updated_at",
      "user_id",
      "workspace_id",
    ]);

    const statusColumn = columns.find((row) => row.column_name === "status");
    expect(statusColumn).toMatchObject({ is_nullable: "NO", data_type: "text" });

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'chat_slack_configuration_credentials' ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "chat_slack_configuration_credentials_company_id_idx",
      "chat_slack_configuration_credentials_owner_idx",
      "chat_slack_configuration_credentials_pkey",
    ]);

    const companyId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Slack credential migration', 'SCM')`;
    const insert = (status = "active") => sql`
      INSERT INTO "chat_slack_configuration_credentials" ("company_id", "user_id", "slack_user_id", "workspace_id", "status")
      VALUES (${companyId}, 'owner-user', 'USLACK', 'TWORKSPACE', ${status})
      RETURNING "id", "revision", "chain_generation"
    `;
    const [row] = await insert();
    expect(row).toMatchObject({ revision: 0, chain_generation: 0 });

    // The status check is enforced (SQLSTATE 23514).
    await expect(insert("expired")).rejects.toMatchObject({ code: "23514" });

    // The owner index permits exactly one credential per (company, user, workspace).
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
  }, 90_000);

  it("applies twice cleanly against an already-migrated database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-slack-configuration-credentials-idempotent-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // The harness already applied the migration once; replay it twice more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        if (statement.trim()) await sql.unsafe(statement);
      }
    }

    const constraints = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'chat_slack_configuration_credentials'::regclass
        AND conname IN (
          'chat_slack_configuration_credentials_status_check',
          'chat_slack_configuration_credentials_company_id_companies_id_fk'
        )
      ORDER BY conname
    `;
    expect(constraints.map((row) => row.conname)).toEqual([
      "chat_slack_configuration_credentials_company_id_companies_id_fk",
      "chat_slack_configuration_credentials_status_check",
    ]);

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'chat_slack_configuration_credentials'
        AND indexname LIKE '%_idx' ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "chat_slack_configuration_credentials_company_id_idx",
      "chat_slack_configuration_credentials_owner_idx",
    ]);

    const security = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'public.chat_slack_configuration_credentials'::regclass
    `;
    expect(security).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const policies = await sql<{ policyname: string; permissive: string }[]>`
      SELECT policyname, permissive FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'chat_slack_configuration_credentials'
    `;
    expect(policies).toEqual([{ policyname: "tenant_isolation", permissive: "PERMISSIVE" }]);
  }, 90_000);
});
