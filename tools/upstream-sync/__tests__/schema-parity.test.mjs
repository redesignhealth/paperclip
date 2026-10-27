// Schema-parity guard (TECH-7978).
//
// The ledger's production schema is owned by Paperclip's Drizzle chain
// (packages/db/src/schema/upstream_sync.ts + migration 0379). schema.sql is
// kept only as the fixture for db.test.mjs, because that test needs a bare
// scratch database without a full Paperclip migration run. Two copies of one
// schema only stay honest if something compares them, so this test applies
// each to its own Postgres schema and diffs the result.
//
// Needs a scratch Postgres: UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://...
// Both schemas created here are dropped again; the fixture/migration tables
// never touch the default `public` schema, so this can share a database with
// db.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.UPSTREAM_SYNC_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = url ? false : "UPSTREAM_SYNC_TEST_DATABASE_URL not set";

const FIXTURE_SCHEMA = "upstream_sync_fixture";
const MIGRATION_SCHEMA = "upstream_sync_migration";
const MIGRATION_FILE = "0379_upstream_sync_ledger.sql";
const TABLES = ["upstream_sync_log", "upstream_sync_state", "upstream_sync_alerts"];

const migrationSql = fs.readFileSync(
  path.join(here, "../../../packages/db/src/migrations", MIGRATION_FILE),
  "utf8",
);

async function resetSchema(client, schema) {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
}

// Postgres renders schema-qualified names into defaults, indexes and constraint
// definitions whenever the object is not on the current search_path. Both
// schemas are deliberately named differently, so strip the schema prefix before
// comparing.
function stripSchema(value, schema) {
  return typeof value === "string"
    ? value.replace(new RegExp(`(^|[^a-zA-Z0-9_])${schema}\\.`, "g"), "$1")
    : value;
}

// Column shape as the fixture writes it: name, type, nullability, default.
async function readColumns(client, schema) {
  const { rows } = await client.query(
    `SELECT table_name, column_name, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2::text[])
      ORDER BY table_name, ordinal_position`,
    [schema, TABLES],
  );
  return rows.map((row) => ({ ...row, column_default: stripSchema(row.column_default, schema) }));
}

// Every constraint (p/u/c) with its rendered definition, so a renamed CHECK, a
// changed membership list or a different UNIQUE column all show up as a diff.
async function readConstraints(client, schema) {
  const { rows } = await client.query(
    `SELECT c.relname AS table_name,
            con.conname AS constraint_name,
            con.contype AS constraint_type,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
      ORDER BY c.relname, con.conname`,
    [schema, TABLES],
  );
  return rows.map((row) => ({ ...row, definition: stripSchema(row.definition, schema) }));
}

async function readIndexes(client, schema) {
  const { rows } = await client.query(
    `SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
       FROM pg_indexes
      WHERE schemaname = $1 AND tablename = ANY($2::text[])
        AND indexname NOT IN (SELECT conname FROM pg_constraint con
                                JOIN pg_class c ON c.oid = con.conrelid
                                JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = $1)
      ORDER BY tablename, indexname`,
    [schema, TABLES],
  );
  return rows.map((row) => ({ ...row, definition: stripSchema(row.definition, schema) }));
}

async function applyToSchema(client, schema, sql) {
  await resetSchema(client, schema);
  await client.query(`SET search_path TO ${schema}`);
  try {
    // 0379 carries drizzle's statement separators; schema.sql executes whole.
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await client.query(statement);
    }
  } finally {
    await client.query(`SET search_path TO public`);
  }
}

test("schema.sql fixture matches migration 0379 on columns, constraints and indexes", { skip }, async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await applyToSchema(client, FIXTURE_SCHEMA, fs.readFileSync(path.join(here, "../schema.sql"), "utf8"));
    await applyToSchema(client, MIGRATION_SCHEMA, migrationSql);

    assert.deepEqual(
      await readColumns(client, MIGRATION_SCHEMA),
      await readColumns(client, FIXTURE_SCHEMA),
      "columns differ between 0379 and tools/upstream-sync/schema.sql",
    );
    assert.deepEqual(
      await readConstraints(client, MIGRATION_SCHEMA),
      await readConstraints(client, FIXTURE_SCHEMA),
      "constraints differ between 0379 and tools/upstream-sync/schema.sql",
    );
    assert.deepEqual(
      await readIndexes(client, MIGRATION_SCHEMA),
      await readIndexes(client, FIXTURE_SCHEMA),
      "indexes differ between 0379 and tools/upstream-sync/schema.sql",
    );

    // The hand-appended view is not modelled by Drizzle, so nothing but this
    // assertion can catch it drifting from the fixture.
    const viewColumns = async (schema) => {
      const { rows } = await client.query(
        `SELECT column_name, udt_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'upstream_sync_log_view'
          ORDER BY ordinal_position`,
        [schema],
      );
      return rows;
    };
    const migrationView = await viewColumns(MIGRATION_SCHEMA);
    assert.ok(migrationView.length > 0, "0379 must create upstream_sync_log_view");
    assert.deepEqual(migrationView, await viewColumns(FIXTURE_SCHEMA));

    // Column names/types alone would not notice a changed expression (a
    // different status list, a dropped CASE branch, a different ORDER BY), so
    // compare the rendered definition too. `pg_get_viewdef` pretty-prints and
    // schema-qualifies names, so normalise both before comparing.
    const normalizeViewDef = (sql, schema) =>
      stripSchema(sql, schema).replace(/\s+/g, " ").trim();
    const viewDef = async (schema) => {
      const { rows } = await client.query(
        `SELECT pg_get_viewdef(c.oid, true) AS definition
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'upstream_sync_log_view'`,
        [schema],
      );
      assert.equal(rows.length, 1, `${schema} must define upstream_sync_log_view`);
      return normalizeViewDef(rows[0].definition, schema);
    };
    const migrationViewDef = await viewDef(MIGRATION_SCHEMA);
    assert.ok(migrationViewDef.length > 0, "0379 must create upstream_sync_log_view");
    assert.equal(
      migrationViewDef,
      await viewDef(FIXTURE_SCHEMA),
      "view definition differs between 0379 and tools/upstream-sync/schema.sql",
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`).catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${MIGRATION_SCHEMA} CASCADE`).catch(() => {});
    await client.end();
  }
});
