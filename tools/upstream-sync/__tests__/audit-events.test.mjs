// Audit-trail guard for upstream_sync_log (TECH-7978 follow-up, migration 0381).
//
// Applies the real migrations (0380, then 0381 after a few pre-existing rows, to
// exercise the baseline) into a throwaway Postgres schema and checks what the
// trigger writes and what it refuses. Needs a scratch Postgres:
// UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://...  The schema created here is dropped
// again and never touches `public`, so this can share a database with the other
// tests.
//
// What a single connection cannot prove: that a *different*, restricted login only
// has SELECT on the events table (the grant lives in the rh-paperclip bootstrap
// script, which has its own test). Here `actor` is asserted to be session_user.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.UPSTREAM_SYNC_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = url ? false : "UPSTREAM_SYNC_TEST_DATABASE_URL not set";
const SCHEMA = "upstream_sync_audit_test";
const MIGRATIONS = path.join(here, "../../../packages/db/src/migrations");

async function applyMigration(db, file) {
  const statements = fs
    .readFileSync(path.join(MIGRATIONS, file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.query(statement);
}

const events = async (db, sha) =>
  (await db.query(`SELECT * FROM upstream_sync_events WHERE upstream_sha = $1 ORDER BY id`, [sha])).rows;

test("audit trail: baseline, insert/update/delete events, no-op skipping, append-only", { skip }, async () => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);

    await applyMigration(db, "0380_upstream_sync_ledger.sql");
    // Rows that exist BEFORE 0381 must get one synthetic baseline event each.
    await db.query(
      `INSERT INTO upstream_sync_log (upstream_sha, title, category, status)
       VALUES ('base1', 'old one', 'fix', 'pending'), ('base2', 'old two', 'perf', 'skipped')`,
    );
    await applyMigration(db, "0381_upstream_sync_events.sql");

    const base = await events(db, "base2");
    assert.equal(base.length, 1, "one baseline event per pre-existing row");
    assert.equal(base[0].operation, "insert");
    assert.equal(base[0].actor, "migration:0381_baseline");
    assert.equal(base[0].new_status, "skipped");
    assert.equal(base[0].new_values.title, "old two");

    // INSERT -> full-row event, actor is the connected login.
    const login = (await db.query("SELECT session_user AS u")).rows[0].u;
    await db.query(`INSERT INTO upstream_sync_log (upstream_sha, title) VALUES ('aaa', 'new commit')`);
    let ev = await events(db, "aaa");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].operation, "insert");
    assert.equal(ev[0].old_status, null);
    assert.equal(ev[0].new_status, "pending");
    assert.equal(ev[0].actor, login);
    assert.ok(ev[0].changed_columns.includes("title"));
    assert.equal(ev[0].new_values.title, "new commit");

    // UPDATE -> only the changed columns, with status transition columns and run_ref.
    await db.query(`SET upstream_sync.run_ref = 'RED-999'`);
    await db.query(`UPDATE upstream_sync_log SET status = 'in_progress', fork_pr = 'https://x/pr/1' WHERE upstream_sha = 'aaa'`);
    ev = await events(db, "aaa");
    assert.equal(ev.length, 2);
    const upd = ev[1];
    assert.equal(upd.operation, "update");
    assert.deepEqual(upd.changed_columns, ["fork_pr", "status"]);
    assert.deepEqual(upd.old_values, { fork_pr: null, status: "pending" });
    assert.deepEqual(upd.new_values, { fork_pr: "https://x/pr/1", status: "in_progress" });
    assert.equal(upd.old_status, "pending");
    assert.equal(upd.new_status, "in_progress");
    assert.equal(upd.run_ref, "RED-999");
    await db.query(`RESET upstream_sync.run_ref`);

    // A no-op update and an updated_at-only update are not events.
    await db.query(`UPDATE upstream_sync_log SET status = 'in_progress' WHERE upstream_sha = 'aaa'`);
    await db.query(`UPDATE upstream_sync_log SET updated_at = now() + interval '1 minute' WHERE upstream_sha = 'aaa'`);
    assert.equal((await events(db, "aaa")).length, 2, "no event for no-op / updated_at-only updates");

    // A non-status change keeps old_status/new_status as the unchanged status.
    await db.query(`UPDATE upstream_sync_log SET skip_reason = 'because' WHERE upstream_sha = 'aaa'`);
    ev = await events(db, "aaa");
    assert.equal(ev.length, 3);
    assert.equal(ev[2].old_status, "in_progress");
    assert.equal(ev[2].new_status, "in_progress");
    assert.deepEqual(ev[2].changed_columns, ["skip_reason"]);

    // DELETE -> an event with the old row, even though the row is gone.
    await db.query(`DELETE FROM upstream_sync_log WHERE upstream_sha = 'aaa'`);
    ev = await events(db, "aaa");
    assert.equal(ev.length, 4);
    assert.equal(ev[3].operation, "delete");
    assert.equal(ev[3].old_status, "in_progress");
    assert.equal(ev[3].new_status, null);

    // Append-only: not even the owner can edit, delete or truncate events.
    for (const sql of [
      `UPDATE upstream_sync_events SET actor = 'x'`,
      `DELETE FROM upstream_sync_events`,
      `TRUNCATE upstream_sync_events`,
    ]) {
      await assert.rejects(db.query(sql), /append-only/, sql);
    }

    // The three read patterns the indexes are for.
    const idx = (await db.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'upstream_sync_events' ORDER BY 1`,
      [SCHEMA],
    )).rows.map((r) => r.indexname);
    assert.deepEqual(idx, [
      "upstream_sync_events_created_idx",
      "upstream_sync_events_pkey",
      "upstream_sync_events_sha_idx",
      "upstream_sync_events_status_idx",
    ]);
  } finally {
    await db.query("RESET search_path").catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await db.end();
  }
});
