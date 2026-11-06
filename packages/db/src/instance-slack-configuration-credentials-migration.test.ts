import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0383_instance_slack_configuration_credentials.sql";
const migrationSql = fs.readFileSync(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres instance Slack configuration credential migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("Instance Slack configuration credential migration", () => {
  it("creates a table with no company, a status check and one row per workspace", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-instance-slack-configuration-credentials-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const columns = await sql<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'instance_slack_configuration_credentials'
      ORDER BY column_name
    `;
    // No company_id: the credential is instance-wide, so no tenant policy applies to it.
    expect(columns.map((row) => row.column_name)).toEqual([
      "access_expires_at",
      "access_material",
      "chain_generation",
      "created_at",
      "id",
      "last_rotated_at",
      "refresh_material",
      "revision",
      "rotation_started_at",
      "saved_by_user_id",
      "slack_user_id",
      "status",
      "updated_at",
      "workspace_id",
    ]);
    // A forgotten credential keeps its row but clears its material.
    expect(columns.filter((row) => ["access_material", "refresh_material"].includes(row.column_name)).map((row) => row.is_nullable)).toEqual(["YES", "YES"]);

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'instance_slack_configuration_credentials' ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "instance_slack_configuration_credentials_pkey",
      "instance_slack_configuration_credentials_workspace_idx",
    ]);

    const insert = (workspaceId = "TWORKSPACE", status = "active") => sql`
      INSERT INTO "instance_slack_configuration_credentials" ("workspace_id", "slack_user_id", "saved_by_user_id", "status")
      VALUES (${workspaceId}, 'USLACK', 'admin-user', ${status})
      RETURNING "revision", "chain_generation"
    `;
    expect((await insert())[0]).toMatchObject({ revision: 0, chain_generation: 0 });
    // The status check is enforced (SQLSTATE 23514).
    await expect(insert("TOTHER", "expired")).rejects.toMatchObject({ code: "23514" });
    // One credential per Slack workspace (SQLSTATE 23505), and other workspaces are independent.
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await insert("TOTHER");

    const policies = await sql`
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'instance_slack_configuration_credentials'
    `;
    expect(policies).toEqual([]);
  }, 90_000);

  it("applies twice cleanly against an already-migrated database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-instance-slack-configuration-credentials-idempotent-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // The harness already applied the migration once; replay it twice more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        if (statement.trim()) await sql.unsafe(statement);
      }
    }

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'instance_slack_configuration_credentials' ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "instance_slack_configuration_credentials_pkey",
      "instance_slack_configuration_credentials_workspace_idx",
    ]);
  }, 90_000);
});
