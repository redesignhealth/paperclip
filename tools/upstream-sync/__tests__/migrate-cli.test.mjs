// `cli.mjs migrate` is verify-only (the ledger schema is owned by Paperclip's
// Drizzle chain), so these tests assert the two things that matter: it passes
// when the objects are there, it fails with a pointer at Paperclip migrations
// when they are not, and it never writes DDL either way.
//
// Needs a scratch Postgres: UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://...
// Each test works in its own throwaway schema, reached by pinning search_path
// on the child's connection string, so it never touches public/the real ledger
// and can share a database with the other DB tests.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.UPSTREAM_SYNC_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = url ? false : "UPSTREAM_SYNC_TEST_DATABASE_URL not set";

const CLI = path.join(here, "../cli.mjs");
const FIXTURE = fs.readFileSync(path.join(here, "../schema.sql"), "utf8");
const SCHEMA = "upstream_sync_migrate_cli";

// search_path is set on the connection itself, so `migrate`'s
// `current_schema()` checks resolve inside the throwaway schema.
function withSearchPath(connectionString, schema) {
  const parsed = new URL(connectionString);
  parsed.searchParams.set("options", `-csearch_path=${schema}`);
  return parsed.toString();
}

async function withScratchSchema(fn) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const schema = SCHEMA;
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    return await fn({ admin, schema, dsn: withSearchPath(url, schema) });
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
}

function runMigrate(dsn) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "migrate"], {
      env: { ...process.env, UPSTREAM_SYNC_DATABASE_URL: dsn, DATABASE_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Every relation the schema contains: tables, views, sequences, indexes.
async function relations(admin, schema) {
  const { rows } = await admin.query(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      ORDER BY c.relname`,
    [schema],
  );
  return rows.map((r) => r.relname);
}

test("migrate exits 0 when the ledger tables and view exist", { skip }, async () => {
  await withScratchSchema(async ({ admin, schema, dsn }) => {
    await admin.query(`SET search_path TO ${schema}`);
    try {
      await admin.query(FIXTURE);
    } finally {
      await admin.query(`SET search_path TO public`);
    }

    const { code, stderr } = await runMigrate(dsn);
    assert.equal(code, 0, `expected success, got exit ${code}: ${stderr}`);
    assert.match(stderr, /schema present: upstream_sync_log, upstream_sync_state, upstream_sync_alerts/);
    assert.match(stderr, /upstream_sync_log_view/);
  });
});

test("migrate exits 1 and points at Paperclip migrations when objects are missing", { skip }, async () => {
  await withScratchSchema(async ({ dsn }) => {
    const { code, stdout, stderr } = await runMigrate(dsn);
    assert.equal(code, 1, `expected failure, got exit ${code}: ${stdout}${stderr}`);
    assert.match(stderr, /schema is incomplete/);
    assert.match(stderr, /upstream_sync_log/);
    assert.match(stderr, /Paperclip migrations/);
    assert.match(stderr, /0380_upstream_sync_ledger\.sql/);
  });
});

test("migrate performs no DDL", { skip }, async () => {
  await withScratchSchema(async ({ admin, schema, dsn }) => {
    const before = await relations(admin, schema);
    assert.deepEqual(before, [], "scratch schema must start empty");

    const { code } = await runMigrate(dsn);
    assert.equal(code, 1, "nothing to verify, so migrate must fail");

    // The failure message alone is not proof: verify nothing was created.
    assert.deepEqual(await relations(admin, schema), [], "migrate must not create any objects");
  });
});
