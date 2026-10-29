// Worker state guard for upstream_sync_log (RED-583, migration 0382).
//
// Applies the real migrations (0380, 0381, 0382) into a throwaway Postgres schema and then
// drives the ledger as the roles that matter in production:
//   - the schema owner (what the migration runs as; owns both tables),
//   - `upstream_sync_runner` (the restricted worker login; owns nothing),
//   - a member of `upstream_sync_human` (explicit human override).
// The runner is a real LOGIN here, on its own connection, so privilege checks are the
// database's, not assertions about SQL text.
//
// Needs a scratch Postgres on which the test login may CREATE ROLE:
//   UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://...   (superuser, e.g. embedded Postgres)
// The schemas created here are dropped again and never touch `public`. The cluster-wide
// roles are created and dropped by the test, so run it on a scratch cluster only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { classifyPending } from "../lib/classify.mjs";
import { loadConfig } from "../lib/config.mjs";

const url = process.env.UPSTREAM_SYNC_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = url ? false : "UPSTREAM_SYNC_TEST_DATABASE_URL not set";
const SCHEMA = "upstream_sync_worker_test";
const OWNED_SCHEMA = "upstream_sync_worker_owned_test";
const MIGRATIONS = path.join(here, "../../../packages/db/src/migrations");
const FILES = [
  "0380_upstream_sync_ledger.sql",
  "0381_upstream_sync_events.sql",
  "0382_upstream_sync_worker_state.sql",
];
const RUNNER = "upstream_sync_runner";
const HUMAN_ROLE = "upstream_sync_human";
const HUMAN_LOGIN = "upstream_sync_test_human";
const PASSWORD = "scratch-only";

const sha40 = (c) => c.repeat(40);
const sha64 = (c) => c.repeat(64);

async function applyMigration(db, file) {
  const statements = fs
    .readFileSync(path.join(MIGRATIONS, file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  // Drizzle applies a migration inside one transaction; so does this, so a refused
  // migration leaves nothing behind.
  await db.query("BEGIN");
  try {
    for (const statement of statements) await db.query(statement);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

function loginUrl(user, schema) {
  const u = new URL(url);
  u.username = user;
  u.password = PASSWORD;
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
}

async function connect(user, schema) {
  const c = new pg.Client({ connectionString: loginUrl(user, schema) });
  await c.connect();
  return c;
}

async function dropRoles(admin) {
  for (const r of [HUMAN_LOGIN, RUNNER, HUMAN_ROLE]) {
    await admin.query(`DROP OWNED BY ${r}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
  }
}

const state = async (admin, sha) =>
  (await admin.query(`SELECT * FROM ${SCHEMA}.upstream_sync_log WHERE upstream_sha = $1`, [sha])).rows[0];

// Same single statement the worker will use to claim (plan RED-580 section 1).
const CLAIM = `
  UPDATE upstream_sync_log
     SET status = 'claimed', claimed_by = $1, claimed_at = now(),
         lease_expires_at = now() + interval '15 minutes', attempt = attempt + 1, updated_at = now()
   WHERE id = (SELECT id FROM upstream_sync_log
                WHERE status = 'pending' OR (status = 'claimed' AND lease_expires_at < now())
                ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING id, upstream_sha, status, claimed_by, attempt`;

async function denied(client, sql, params, pattern, label = sql) {
  await assert.rejects(client.query(sql, params), pattern, label);
}

test("worker state: transitions, lease, evidence, human override, runner privileges", { skip }, async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  let runner;
  let human;
  let runner2;
  try {
    await dropRoles(admin);
    for (const s of [SCHEMA, OWNED_SCHEMA]) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.query(`CREATE ROLE ${RUNNER} LOGIN PASSWORD '${PASSWORD}'`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${RUNNER}`);
    await admin.query(`SET search_path TO ${SCHEMA}`);

    await applyMigration(admin, FILES[0]);
    // Rows that exist before the migrations: the legacy vocabulary must be remapped, not lost.
    await admin.query(
      `INSERT INTO upstream_sync_log (upstream_sha, title, status, skip_reason)
       VALUES ('legacy_inprogress', 't', 'in_progress', NULL),
              ('legacy_conflict', 't', 'conflict', NULL),
              ('legacy_needs', 't', 'needs-human', NULL),
              ('legacy_skipped', 't', 'skipped', NULL),
              ('legacy_pending', 't', 'pending', NULL)`,
    );
    await applyMigration(admin, FILES[1]);
    await applyMigration(admin, FILES[2]);

    const legacy = Object.fromEntries(
      (await admin.query(`SELECT upstream_sha, status, skip_reason FROM upstream_sync_log WHERE upstream_sha LIKE 'legacy_%'`))
        .rows.map((r) => [r.upstream_sha, r]),
    );
    assert.equal(legacy.legacy_inprogress.status, "pending");
    assert.equal(legacy.legacy_conflict.status, "needs_human");
    assert.equal(legacy.legacy_needs.status, "needs_human");
    assert.equal(legacy.legacy_skipped.status, "skipped");
    assert.equal(legacy.legacy_skipped.skip_reason, "legacy_status");
    assert.equal(legacy.legacy_pending.status, "pending");
    await admin.query(`DELETE FROM upstream_sync_log WHERE upstream_sha LIKE 'legacy_%'`);
    // The remap itself is audited: legacy_* rows each have baseline + update + delete events.
    const remapEvents = (await admin.query(
      `SELECT count(*)::int n FROM upstream_sync_events WHERE upstream_sha = 'legacy_inprogress'`,
    )).rows[0].n;
    assert.ok(remapEvents >= 2, "baseline then remap");

    // The migration created the human override role and applied the runner grants.
    assert.equal((await admin.query(`SELECT to_regrole('${HUMAN_ROLE}') IS NOT NULL AS ok`)).rows[0].ok, true);
    await admin.query(`CREATE ROLE ${HUMAN_LOGIN} LOGIN PASSWORD '${PASSWORD}' IN ROLE ${HUMAN_ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${HUMAN_LOGIN}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON upstream_sync_log TO ${HUMAN_LOGIN}`);
    await admin.query(`GRANT USAGE, SELECT ON SEQUENCE upstream_sync_log_id_seq TO ${HUMAN_LOGIN}`);

    runner = await connect(RUNNER, SCHEMA);
    runner2 = await connect(RUNNER, SCHEMA);
    human = await connect(HUMAN_LOGIN, SCHEMA);

    const privilege = async (table, priv) =>
      (await admin.query(`SELECT has_table_privilege('${RUNNER}', '${SCHEMA}.${table}', '${priv}') AS ok`)).rows[0].ok;
    for (const priv of ["SELECT", "INSERT", "UPDATE"]) assert.equal(await privilege("upstream_sync_log", priv), true, `log ${priv}`);
    for (const priv of ["DELETE", "TRUNCATE", "TRIGGER", "REFERENCES"]) assert.equal(await privilege("upstream_sync_log", priv), false, `log ${priv}`);
    assert.equal(await privilege("upstream_sync_events", "SELECT"), true);
    for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES"]) {
      assert.equal(await privilege("upstream_sync_events", priv), false, `events ${priv}`);
    }
    const owners = (await admin.query(
      `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'upstream_sync%'`,
      [SCHEMA],
    )).rows;
    assert.ok(owners.length >= 4);
    for (const o of owners) assert.notEqual(o.tableowner, RUNNER, `runner must not own ${o.tablename}`);

    // ---- inserts -----------------------------------------------------------------------
    await denied(runner, `INSERT INTO upstream_sync_log (upstream_sha, title, status) VALUES ('x1', 't', 'assessed')`, [], /new row must be pending/);
    await denied(runner, `INSERT INTO upstream_sync_log (upstream_sha, title, attempt) VALUES ('x2', 't', 3)`, [], /new row must be pending/);
    // Insert-time evidence is refused too, not just the status/attempt/claim columns.
    for (const [col, val] of [
      ["resolution_delta_sha256", `'${sha64("1")}'`],
      ["review_pr", "5"],
      ["argus_rounds", `'[{"round":1,"sha":"${sha40("1")}","verdict":"approve"}]'::jsonb`],
      ["integration_sha", `'${sha40("1")}'`],
      ["promote_pr", "5"],
      ["master_sha", `'${sha40("1")}'`],
    ]) {
      await assert.rejects(
        runner.query(`INSERT INTO upstream_sync_log (upstream_sha, title, ${col}) VALUES ('x3', 't', ${val})`),
        /new row must be pending|violates check constraint/,
        `insert with ${col}`,
      );
    }
    for (const n of ["a", "b", "c", "d", "e", "f"]) {
      await runner.query(`INSERT INTO upstream_sync_log (upstream_sha, title) VALUES ($1, 't')`, [n.repeat(40)]);
    }
    await runner.query("SELECT set_config('upstream_sync.run_ref', 'RED-TEST', false)");

    // ---- claim: one race-free statement; concurrent claimers get different rows --------
    await runner.query("BEGIN");
    const first = (await runner.query(CLAIM, ["run-1"])).rows;
    assert.equal(first.length, 1);
    assert.equal(first[0].upstream_sha, sha40("a"));
    const second = (await runner2.query(CLAIM, ["run-2"])).rows; // SKIP LOCKED: row a is locked
    assert.equal(second[0].upstream_sha, sha40("b"));
    await runner.query("COMMIT");
    assert.equal((await state(admin, sha40("a"))).attempt, 1);

    // The claim and its holder are in the audit trail with the run reference.
    const claimEv = (await admin.query(
      `SELECT * FROM upstream_sync_events WHERE upstream_sha = $1 AND new_status = 'claimed'`, [sha40("a")])).rows;
    assert.equal(claimEv.length, 1);
    assert.equal(claimEv[0].actor, RUNNER);
    assert.equal(claimEv[0].run_ref, "RED-TEST");
    assert.equal(claimEv[0].new_values.claimed_by, "run-1");

    // A malformed claim is refused: no attempt bump, past lease, someone else's live lease.
    await denied(runner, `UPDATE upstream_sync_log SET status='claimed', claimed_by='r', claimed_at=now(), lease_expires_at=now()+interval '1 min' WHERE upstream_sha=$1`, [sha40("c")], /must be attempt 1/);
    await denied(runner, `UPDATE upstream_sync_log SET status='claimed', claimed_by='r', claimed_at=now(), lease_expires_at=now()-interval '1 min', attempt=1 WHERE upstream_sha=$1`, [sha40("c")], /future lease/);
    await denied(runner, `UPDATE upstream_sync_log SET claimed_by='thief', lease_expires_at=now()+interval '1 hour' WHERE upstream_sha=$1`, [sha40("a")], /leased to run-1/);
    await denied(runner, `UPDATE upstream_sync_log SET attempt = attempt + 1 WHERE upstream_sha=$1`, [sha40("c")], /attempt only changes when a row is claimed/);
    await denied(runner, `UPDATE upstream_sync_log SET status='pending' WHERE upstream_sha=$1`, [sha40("a")], /check|claim/i, "release must clear the lease (claim check)");

    // The holder may extend its lease, never shorten it.
    await runner.query(`UPDATE upstream_sync_log SET lease_expires_at = lease_expires_at + interval '10 minutes' WHERE upstream_sha=$1`, [sha40("a")]);
    await denied(runner, `UPDATE upstream_sync_log SET lease_expires_at = now() + interval '1 second' WHERE upstream_sha=$1`, [sha40("a")], /leased to run-1/);

    // An expired lease is reclaimable (new attempt, new holder) by the same statement.
    await admin.query(`UPDATE upstream_sync_log SET lease_expires_at = now() - interval '1 minute' WHERE upstream_sha=$1`, [sha40("a")]);
    const reclaimed = (await runner.query(CLAIM, ["run-3"])).rows;
    assert.equal(reclaimed[0].upstream_sha, sha40("a"), "expired lease comes before later pending rows");
    assert.equal(reclaimed[0].attempt, 2);
    assert.equal(reclaimed[0].claimed_by, "run-3");
    // Reclaiming an expired lease without bumping attempt is refused.
    await admin.query(`UPDATE upstream_sync_log SET lease_expires_at = now() - interval '1 minute' WHERE upstream_sha=$1`, [sha40("a")]);
    await denied(runner, `UPDATE upstream_sync_log SET claimed_by='r', claimed_at=now(), lease_expires_at=now()+interval '1 min' WHERE upstream_sha=$1`, [sha40("a")], /must be attempt 3/);
    // Release: back to pending with the lease cleared.
    await runner.query(`UPDATE upstream_sync_log SET status='pending', lease_expires_at=NULL WHERE upstream_sha=$1`, [sha40("a")]);
    assert.equal((await state(admin, sha40("a"))).status, "pending");

    // ---- illegal edges ------------------------------------------------------------------
    const illegal = async (sha, set, label) =>
      denied(runner, `UPDATE upstream_sync_log SET ${set} WHERE upstream_sha=$1`, [sha], /upstream_sync_log:|violates check constraint/, label);
    await illegal(sha40("c"), `status='assessed', path='clean'`, "pending -> assessed");
    await illegal(sha40("c"), `status='integrated', path='clean', integration_sha='${sha40("1")}'`, "pending -> integrated");
    await illegal(sha40("c"), `status='promoted', path='clean'`, "pending -> promoted");
    await denied(runner, `UPDATE upstream_sync_log SET status='bogus' WHERE upstream_sha=$1`, [sha40("c")], /status_check|illegal transition/);

    // ---- clean path: claimed -> assessed -> integrated -> promoted ----------------------
    const row = sha40("b"); // claimed by run-2 above
    await denied(runner, `UPDATE upstream_sync_log SET status='assessed', lease_expires_at=NULL WHERE upstream_sha=$1`, [row], /state_path_check/, "assessed needs a path");
    await runner.query(`UPDATE upstream_sync_log SET status='assessed', path='clean', lease_expires_at=NULL WHERE upstream_sha=$1`, [row]);
    await illegal(row, `status='promoted', integration_sha='${sha40("1")}'`, "assessed -> promoted");
    await illegal(row, `status='in_review', review_pr=1`, "a clean path never goes to in_review");
    await denied(runner, `UPDATE upstream_sync_log SET status='integrated' WHERE upstream_sha=$1`, [row], /state_integrated_check/, "integrated needs integration_sha");
    await denied(runner, `UPDATE upstream_sync_log SET status='integrated', integration_sha='nothex' WHERE upstream_sha=$1`, [row], /integration_sha_check/);
    await denied(runner, `UPDATE upstream_sync_log SET status='integrated', integration_sha=$2, resolution_delta_sha256=$3 WHERE upstream_sha=$1`, [row, sha40("1"), sha64("2")], /state_integrated_check|approving Argus verdict/, "a clean merge has no resolution delta");
    await runner.query(`UPDATE upstream_sync_log SET status='integrated', integration_sha=$2 WHERE upstream_sha=$1`, [row, sha40("1")]);
    await denied(runner, `UPDATE upstream_sync_log SET integration_sha=$2 WHERE upstream_sha=$1`, [row, sha40("9")], /write-once/);
    await denied(runner, `UPDATE upstream_sync_log SET status='promoted', promote_pr=5 WHERE upstream_sha=$1`, [row], /state_promoted_check/, "promoted needs promote_pr and master_sha");
    await denied(runner, `UPDATE upstream_sync_log SET status='assessed' WHERE upstream_sha=$1`, [row], /illegal transition/, "integrated cannot go backwards");
    await runner.query(`UPDATE upstream_sync_log SET status='promoted', promote_pr=5, master_sha=$2 WHERE upstream_sha=$1`, [row, sha40("2")]);
    // Nothing leaves promoted; alert bookkeeping and the prod pin time are the only edits.
    await denied(runner, `UPDATE upstream_sync_log SET status='needs_human' WHERE upstream_sha=$1`, [row], /illegal transition/);
    await denied(runner, `UPDATE upstream_sync_log SET title='rewritten' WHERE upstream_sha=$1`, [row], /is final/);
    await denied(runner, `UPDATE upstream_sync_log SET master_sha=$2 WHERE upstream_sha=$1`, [row, sha40("3")], /write-once/);
    await runner.query(`UPDATE upstream_sync_log SET alert_state='sent', alerted_at=now(), prod_pinned_at=now() WHERE upstream_sha=$1`, [row]);

    // ---- skipped ------------------------------------------------------------------------
    const skipRow = sha40("c");
    await runner.query(CLAIM, ["run-4"]); // c is the oldest pending row now (a was released, so a first)
    const claimedNow = (await admin.query(`SELECT upstream_sha FROM upstream_sync_log WHERE claimed_by = 'run-4'`)).rows[0].upstream_sha;
    await denied(runner, `UPDATE upstream_sync_log SET status='skipped', lease_expires_at=NULL WHERE upstream_sha=$1`, [claimedNow], /state_skipped_check/, "skipped needs a reason");
    await runner.query(`UPDATE upstream_sync_log SET status='skipped', skip_reason='already_present', lease_expires_at=NULL WHERE upstream_sha=$1`, [claimedNow]);
    await denied(runner, `UPDATE upstream_sync_log SET status='pending' WHERE upstream_sha=$1`, [claimedNow], /illegal transition/);
    await denied(runner, `UPDATE upstream_sync_log SET skip_reason='changed my mind' WHERE upstream_sha=$1`, [claimedNow], /is final/);
    assert.ok([sha40("a"), skipRow].includes(claimedNow));

    // The classifier selects `category IS NULL`; a final (skipped) row with no category must not
    // abort it (Argus round 1). It leaves the final row alone and still classifies the rest.
    const stats = await classifyPending(runner, loadConfig({ UPSTREAM_SYNC_LLM_API_KEY: "" }), { log() {} });
    assert.ok(stats.classified >= 1, "classifier still runs with a skipped, unclassified row present");
    assert.equal((await state(admin, claimedNow)).category, null, "final row untouched by the classifier");

    // ---- conflict path: needs an approving Argus verdict bound to integration_sha -------
    const conflict = sha40("d");
    // Make sure d is claimable by the runner path: use the real claim statement until d is ours.
    for (let i = 0; i < 6; i++) {
      const { rows } = await runner.query(CLAIM, ["run-5"]);
      if (!rows.length || rows[0].upstream_sha === conflict) break;
      await runner.query(
        `UPDATE upstream_sync_log SET status='skipped', skip_reason='fixture', lease_expires_at=NULL WHERE upstream_sha=$1`,
        [rows[0].upstream_sha],
      );
    }
    assert.equal((await state(admin, conflict)).status, "claimed");
    await runner.query(`UPDATE upstream_sync_log SET status='assessed', path='conflict', lease_expires_at=NULL WHERE upstream_sha=$1`, [conflict]);
    await illegal(conflict, `status='integrated', integration_sha='${sha40("f")}', resolution_delta_sha256='${sha64("5")}'`, "a conflict never skips in_review");
    await denied(runner, `UPDATE upstream_sync_log SET status='in_review' WHERE upstream_sha=$1`, [conflict], /state_review_check/);
    await runner.query(`UPDATE upstream_sync_log SET status='in_review', review_pr=77 WHERE upstream_sha=$1`, [conflict]);

    const integrate = (verdict, rounds) => runner.query(
      `UPDATE upstream_sync_log SET status='integrated', integration_sha=$2, resolution_delta_sha256=$3,
              argus_verdict=$4, argus_rounds=$5::jsonb WHERE upstream_sha=$1`,
      [conflict, sha40("f"), sha64("5"), verdict, JSON.stringify(rounds)],
    );
    await denied(runner, `UPDATE upstream_sync_log SET status='integrated', integration_sha=$2, resolution_delta_sha256=$3 WHERE upstream_sha=$1`, [conflict, sha40("f"), sha64("5")], /needs an approving Argus verdict/);
    await assert.rejects(integrate("approve", [{ round: 1, sha: sha40("9"), verdict: "approve" }]), /approving Argus verdict on integration_sha/, "approval for a different sha");
    await assert.rejects(integrate("approve", [{ round: 1, sha: sha40("f"), verdict: "request_changes" }]), /approving Argus verdict/, "last round must approve");
    await assert.rejects(integrate("request_changes", [{ round: 1, sha: sha40("f"), verdict: "approve" }]), /approving Argus verdict/, "column verdict must approve");
    // argus_rounds is append-only: record two rounds first, then rewriting history is refused.
    await runner.query(
      `UPDATE upstream_sync_log SET argus_rounds = $2::jsonb WHERE upstream_sha=$1`,
      [conflict, JSON.stringify([{ round: 1, sha: sha40("3"), verdict: "request_changes" }])],
    );
    await denied(runner, `UPDATE upstream_sync_log SET argus_rounds = '[]'::jsonb WHERE upstream_sha=$1`, [conflict], /append-only/, "truncating rounds");
    await denied(runner, `UPDATE upstream_sync_log SET argus_rounds = $2::jsonb WHERE upstream_sha=$1`, [conflict, JSON.stringify([{ round: 1, sha: sha40("3"), verdict: "approve" }])], /append-only/, "rewriting a round");
    await integrate("approve", [
      { round: 1, sha: sha40("3"), verdict: "request_changes" },
      { round: 2, sha: sha40("f").toUpperCase(), verdict: "APPROVE" }, // case-insensitive match on both
    ]);
    const done = await state(admin, conflict);
    assert.equal(done.status, "integrated");
    assert.equal(done.review_pr, 77);
    assert.equal(done.argus_rounds.length, 2);
    await denied(runner, `UPDATE upstream_sync_log SET resolution_delta_sha256=$2 WHERE upstream_sha=$1`, [conflict, sha64("6")], /write-once/);

    // ---- failure states ------------------------------------------------------------------
    const failing = sha40("e");
    for (let i = 0; i < 6; i++) {
      const { rows } = await runner.query(CLAIM, ["run-6"]);
      if (!rows.length || rows[0].upstream_sha === failing) break;
      await runner.query(`UPDATE upstream_sync_log SET status='skipped', skip_reason='fixture', lease_expires_at=NULL WHERE upstream_sha=$1`, [rows[0].upstream_sha]);
    }
    await runner.query(`UPDATE upstream_sync_log SET status='needs_human', lease_expires_at=NULL WHERE upstream_sha=$1`, [failing]);
    // Workers do not retry a needs_human/failed row by themselves.
    await denied(runner, `UPDATE upstream_sync_log SET status='pending' WHERE upstream_sha=$1`, [failing], /illegal transition needs_human -> pending/);
    await denied(runner, `UPDATE upstream_sync_log SET status='claimed', claimed_by='r', claimed_at=now(), lease_expires_at=now()+interval '1 min', attempt=attempt+1 WHERE upstream_sha=$1`, [failing], /illegal transition/);
    // id / upstream_sha are immutable.
    await denied(runner, `UPDATE upstream_sync_log SET upstream_sha=$2 WHERE upstream_sha=$1`, [failing, sha40("7")], /immutable/);

    // ---- human override ------------------------------------------------------------------
    await human.query(`UPDATE upstream_sync_log SET status='pending', claimed_by=NULL, claimed_at=NULL, attempt=0 WHERE upstream_sha=$1`, [failing]);
    assert.equal((await state(admin, failing)).status, "pending");
    await human.query(`UPDATE upstream_sync_log SET status='needs_human' WHERE upstream_sha=$1`, [row]); // promoted -> needs_human
    assert.equal((await state(admin, row)).status, "needs_human");
    // ... and the override is in the audit trail under the human's login.
    const overrideEv = (await admin.query(
      `SELECT actor, old_status, new_status FROM upstream_sync_events WHERE upstream_sha=$1 ORDER BY id DESC LIMIT 1`, [row])).rows[0];
    assert.deepEqual(overrideEv, { actor: HUMAN_LOGIN, old_status: "promoted", new_status: "needs_human" });

    // ---- the runner cannot touch events, truncate/delete the log, or defeat the triggers -
    assert.ok((await runner.query(`SELECT count(*)::int n FROM upstream_sync_events`)).rows[0].n > 0, "runner can read events");
    for (const sql of [
      `INSERT INTO upstream_sync_events (log_id, upstream_sha, operation, changed_columns, actor) VALUES (1, 'x', 'insert', '{}', 'forged')`,
      `UPDATE upstream_sync_events SET actor = 'forged'`,
      `DELETE FROM upstream_sync_events`,
      `TRUNCATE upstream_sync_events`,
      `DELETE FROM upstream_sync_log`,
      `TRUNCATE upstream_sync_log`,
      `TRUNCATE upstream_sync_log, upstream_sync_events`,
    ]) await denied(runner, sql, [], /permission denied/, sql);
    for (const sql of [
      `ALTER TABLE upstream_sync_log DISABLE TRIGGER upstream_sync_log_guard_trg`,
      `ALTER TABLE upstream_sync_log DISABLE TRIGGER upstream_sync_log_audit_trg`,
      `ALTER TABLE upstream_sync_log DISABLE TRIGGER ALL`,
      `ALTER TABLE upstream_sync_log DISABLE TRIGGER USER`,
      `ALTER TABLE upstream_sync_events DISABLE TRIGGER upstream_sync_events_immutable_trg`,
      `ALTER TABLE upstream_sync_events DISABLE TRIGGER upstream_sync_events_no_truncate_trg`,
      `DROP TRIGGER upstream_sync_log_guard_trg ON upstream_sync_log`,
      `DROP TRIGGER upstream_sync_log_audit_trg ON upstream_sync_log`,
      `DROP TRIGGER upstream_sync_log_no_truncate_trg ON upstream_sync_log`,
      `DROP TRIGGER upstream_sync_events_immutable_trg ON upstream_sync_events`,
      `ALTER TABLE upstream_sync_log OWNER TO ${RUNNER}`,
      `ALTER TABLE upstream_sync_events OWNER TO ${RUNNER}`,
      `DROP TABLE upstream_sync_log`,
      `DROP TABLE upstream_sync_events`,
      `CREATE OR REPLACE FUNCTION upstream_sync_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE FUNCTION upstream_sync_log_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      `ALTER TABLE upstream_sync_log ENABLE REPLICA TRIGGER upstream_sync_log_guard_trg`,
      `SET ROLE ${HUMAN_ROLE}`,
      `SET session_replication_role = replica`,
      `ALTER TABLE upstream_sync_log DROP CONSTRAINT upstream_sync_log_claim_check`,
    ]) await denied(runner, sql, [], /must be owner|permission denied|not a member|permission to set|must be superuser/i, sql);
    // The runner cannot make itself a human either.
    await denied(runner, `GRANT ${HUMAN_ROLE} TO ${RUNNER}`, [], /permission|must have/i);

    // Even the owner cannot edit/delete events, or truncate the log or events.
    for (const sql of [
      `UPDATE upstream_sync_events SET actor = 'x'`,
      `DELETE FROM upstream_sync_events`,
      `TRUNCATE upstream_sync_events`,
    ]) await denied(admin, sql, [], /append-only/, sql);
    await denied(admin, `TRUNCATE upstream_sync_log`, [], /cannot be truncated/);
    await denied(human, `TRUNCATE upstream_sync_log`, [], /permission denied/);

    // The guard and audit functions are not callable by arbitrary roles.
    await denied(runner, `SELECT upstream_sync_log_audit()`, [], /permission denied for function/);
    await denied(runner, `SELECT upstream_sync_log_guard()`, [], /permission denied for function/);

    // Every event from the runner is attributed to the runner login; none came from anyone else
    // except the owner's setup writes and the human override.
    const adminLogin = (await admin.query("SELECT session_user AS u")).rows[0].u;
    const actors = (await admin.query(`SELECT DISTINCT actor FROM upstream_sync_events ORDER BY 1`)).rows.map((r) => r.actor);
    assert.ok(actors.includes(RUNNER) && actors.includes(HUMAN_LOGIN));
    assert.ok(actors.every((a) => [RUNNER, HUMAN_LOGIN, "migration:0381_baseline", adminLogin].includes(a)), actors.join(","));

    // ---- the migration refuses to run when the runner owns a ledger table ----------------
    await admin.query(`CREATE SCHEMA ${OWNED_SCHEMA}`);
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA ${OWNED_SCHEMA} TO ${RUNNER}`);
    await admin.query(`SET search_path TO ${OWNED_SCHEMA}`);
    await applyMigration(admin, FILES[0]);
    await applyMigration(admin, FILES[1]);
    await admin.query(`ALTER TABLE upstream_sync_events OWNER TO ${RUNNER}`);
    await assert.rejects(applyMigration(admin, FILES[2]), /upstream_sync_runner owns/);
  } finally {
    for (const c of [runner, runner2, human]) await c?.end().catch(() => {});
    await admin.query("RESET search_path").catch(() => {});
    for (const s of [SCHEMA, OWNED_SCHEMA]) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
    await dropRoles(admin);
    await admin.end();
  }
});

test("worker state: migration is a no-op for grants when the runner login does not exist, and refuses unmapped legacy rows", { skip }, async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const S = "upstream_sync_worker_norunner_test";
  try {
    await dropRoles(admin);
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin.query(`CREATE SCHEMA ${S}`);
    await admin.query(`SET search_path TO ${S}`);
    await applyMigration(admin, FILES[0]);
    await admin.query(`INSERT INTO upstream_sync_log (upstream_sha, title, status) VALUES ('m1', 't', 'merged')`);
    await applyMigration(admin, FILES[1]);
    // 'merged' has no safe successor: refuse rather than guess.
    await assert.rejects(applyMigration(admin, FILES[2]), /merged\/reverted/);
    await admin.query(`UPDATE upstream_sync_log SET status = 'pending'`);
    await applyMigration(admin, FILES[2]); // no runner role in this cluster: grants block returns early
    assert.equal((await admin.query(`SELECT to_regrole('${RUNNER}') IS NULL AS none`)).rows[0].none, true);
  } finally {
    await admin.query("RESET search_path").catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => {});
    await dropRoles(admin);
    await admin.end();
  }
});
