// handle.mjs ledger half, against real migrations 0380-0382 in a scratch schema, driven as a
// restricted non-superuser login (a superuser is implicitly a member of upstream_sync_human and
// would bypass the guard trigger). Needs a scratch Postgres on which the login may CREATE ROLE:
//   UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://...   (superuser, e.g. embedded Postgres)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../lib/config.mjs";
import { assess, claim, delta, mergePlan, promote, record, verify } from "../lib/handle.mjs";
import { makeFixture } from "./fixture-repo.mjs";

const url = process.env.UPSTREAM_SYNC_TEST_DATABASE_URL;
const skip = url ? false : "UPSTREAM_SYNC_TEST_DATABASE_URL not set";
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(here, "../../../packages/db/src/migrations");
const SCHEMA = "upstream_sync_handle_test";
const LOGIN = "upstream_sync_handle_test_login";
const PASSWORD = "scratch-only";

async function applyMigration(db, file) {
  const statements = fs.readFileSync(path.join(MIGRATIONS, file), "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  await db.query("BEGIN");
  try {
    for (const s of statements) await db.query(s);
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

const events = async (admin, sha, newStatus) =>
  (await admin.query(`SELECT * FROM upstream_sync_events WHERE upstream_sha = $1 AND new_status = $2 ORDER BY id`, [sha, newStatus])).rows;

test("handle config: Argus round cap defaults to 10 and is configurable", () => {
  assert.equal(loadConfig({}).worker.argusRoundCap, 10);
  assert.equal(loadConfig({ UPSTREAM_SYNC_ARGUS_ROUND_CAP: "4" }).worker.argusRoundCap, 4);
  assert.equal(loadConfig({ UPSTREAM_SYNC_ARGUS_ROUND_CAP: "0" }, () => {}).worker.argusRoundCap, 10, "invalid value falls back");
});

test("handle: claim -> assess -> merge -> record -> promote -> verify", { skip }, async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const fx = makeFixture();
  let pool;
  try {
    await admin.query(`DROP OWNED BY ${LOGIN}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${LOGIN}`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(`SET search_path TO ${SCHEMA}`);
    for (const f of ["0380_upstream_sync_ledger.sql", "0381_upstream_sync_events.sql", "0382_upstream_sync_worker_state.sql"]) {
      await applyMigration(admin, f);
    }
    await admin.query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD '${PASSWORD}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${LOGIN}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON upstream_sync_log TO ${LOGIN}`);
    await admin.query(`GRANT SELECT ON upstream_sync_events TO ${LOGIN}`);
    await admin.query(`GRANT USAGE, SELECT ON SEQUENCE upstream_sync_log_id_seq TO ${LOGIN}`);
    for (const sha of [fx.U0, fx.U1, fx.U2, fx.U3, fx.U4]) {
      await admin.query(`INSERT INTO upstream_sync_log (upstream_sha, title) VALUES ($1, 't')`, [sha]);
    }

    const u = new URL(url);
    u.username = LOGIN;
    u.password = PASSWORD;
    u.searchParams.set("options", `-c search_path=${SCHEMA}`);
    // One connection: a leaked session-level run_ref would be visible to the next statement.
    pool = new pg.Pool({ connectionString: u.toString(), max: 1 });
    const refs = { integrationRef: "refs/heads/integration", masterRef: "refs/heads/master" };
    const rowOf = async (sha) => (await admin.query(`SELECT * FROM upstream_sync_log WHERE upstream_sha = $1`, [sha])).rows[0];

    // ---- claim: oldest first, attributed to the run; run_ref is transaction-local ----------
    const c0 = await claim(pool, { runId: "run-A" });
    assert.equal(c0.upstream_sha, fx.U0);
    assert.equal(c0.status, "claimed");
    assert.equal(c0.claimed_by, "run-A");
    assert.equal(c0.attempt, 1);
    const claimEvent = (await events(admin, fx.U0, "claimed"))[0];
    assert.equal(claimEvent.run_ref, "run-A");
    assert.equal((await pool.query(`SELECT nullif(current_setting('upstream_sync.run_ref', true), '') AS v`)).rows[0].v, null, "SET LOCAL: nothing leaks past the transaction");
    await assert.rejects(claim(pool, {}), /run id is required/);

    // ---- assess: U0 is already in integration -> skipped -------------------------------------
    await assert.rejects(assess(pool, fx.dir, { sha: fx.U0, runId: "run-B", ...refs }), /not claimed by run-B/);
    const a0 = await assess(pool, fx.dir, { sha: fx.U0, runId: "run-A", ...refs });
    assert.deepEqual([a0.status, a0.reason], ["skipped", "already_present"]);
    assert.equal((await rowOf(fx.U0)).skip_reason, "already_present");
    assert.equal((await rowOf(fx.U0)).lease_expires_at, null);

    // ---- assess: clean and conflict ------------------------------------------------------------
    for (const [sha, want] of [[fx.U1, "clean"], [fx.U2, "clean"], [fx.U3, "conflict"], [fx.U4, "conflict"]]) {
      const row = await claim(pool, { runId: "run-A" });
      assert.equal(row.upstream_sha, sha);
      const a = await assess(pool, fx.dir, { sha, runId: "run-A", ...refs });
      assert.equal(a.status, "assessed");
      assert.equal(a.path, want);
    }
    assert.equal(await claim(pool, { runId: "run-A" }), null, "queue is empty");
    assert.equal((await events(admin, fx.U1, "assessed"))[0].run_ref, "run-A");

    // ---- merge-plan -> merge -> record integrated (one commit covers both rows) -----------
    const plan = await mergePlan(fx.dir, [fx.U1, fx.U2, fx.U3, fx.U4], { integrationRef: refs.integrationRef });
    assert.deepEqual(plan.shas, [fx.U1, fx.U2]);
    const M = fx.merge("integration", plan.upTo);
    await record(pool, { shas: plan.shas, status: "integrated", runId: "run-A", fields: { integration_sha: M } });
    for (const sha of plan.shas) {
      const r = await rowOf(sha);
      assert.equal(r.status, "integrated");
      assert.equal(r.integration_sha, M);
      assert.equal((await events(admin, sha, "integrated"))[0].run_ref, "run-A");
    }

    // ---- atomic: one illegal row rolls the whole record back; unknown fields are refused -----
    await assert.rejects(record(pool, { shas: [fx.U3, fx.U1], status: "in_review", runId: "run-A", fields: { review_pr: 7 } }), /illegal transition/);
    assert.equal((await rowOf(fx.U3)).status, "assessed", "U3 untouched when U1 is refused");
    await assert.rejects(record(pool, { shas: [fx.U3], status: "in_review", runId: "run-A", fields: { title: "x" } }), /cannot be set/);
    await assert.rejects(record(pool, { shas: [fx.U3], status: "pending", runId: "run-A" }), /cannot record status/);
    await assert.rejects(record(pool, { shas: ["0".repeat(40)], status: "failed", runId: "run-A" }), /no ledger row/);

    // ---- conflict path: in_review, Argus rounds, delta bound to the approved sha -------------
    await record(pool, { shas: [fx.U3], status: "in_review", runId: "run-A", fields: { review_pr: 7 } });
    const R = fx.mergeResolved("integration", fx.U3, { "a.txt": "resolved line\nsecond\nthird\n" });
    const d = await delta(fx.dir, { base: M, upstreamSha: fx.U3, mergeCommit: R });
    assert.equal(d.empty, false);
    // An integrated resolution without an approving verdict on exactly R is refused by the guard.
    await assert.rejects(
      record(pool, { shas: [fx.U3], status: "integrated", runId: "run-A", fields: { integration_sha: R, resolution_delta_sha256: d.sha256, path: "conflict" } }),
      /approving Argus verdict/,
    );
    await record(pool, { shas: [fx.U3], status: "in_review", runId: "run-A", argusRound: { round: 1, sha: R, verdict: "changes" } });
    await assert.rejects(
      record(pool, { shas: [fx.U3], status: "integrated", runId: "run-A", fields: { integration_sha: R, resolution_delta_sha256: d.sha256 }, argusRound: { round: 2, sha: R, verdict: "changes" } }),
      /non-approving/,
    );
    await record(pool, {
      shas: [fx.U3], status: "integrated", runId: "run-A",
      fields: { integration_sha: R, resolution_delta_sha256: d.sha256 },
      argusRound: { round: 2, sha: R, verdict: "approve" },
    });
    const r3 = await rowOf(fx.U3);
    assert.equal(r3.status, "integrated");
    assert.equal(r3.argus_verdict, "approve");
    assert.deepEqual(r3.argus_rounds.map((x) => x.verdict), ["changes", "approve"], "rounds are appended, never rewritten");

    // ---- Argus round cap: default 10, needs_human only after 10 failed rounds -----------------
    await record(pool, { shas: [fx.U4], status: "in_review", runId: "run-A", fields: { review_pr: 8 } });
    for (let round = 1; round <= 9; round++) {
      const [res] = await record(pool, { shas: [fx.U4], status: "in_review", runId: "run-A", argusRound: { round, sha: fx.U4, verdict: "changes" } });
      assert.equal(res.status, "in_review", `round ${round} keeps the row in review`);
      assert.equal(res.capReached, false);
    }
    const [tenth] = await record(pool, { shas: [fx.U4], status: "in_review", runId: "run-A", argusRound: { round: 10, sha: fx.U4, verdict: "changes" } });
    assert.deepEqual([tenth.status, tenth.capReached], ["needs_human", true]);
    const r4 = await rowOf(fx.U4);
    assert.equal(r4.status, "needs_human");
    assert.equal(r4.skip_reason, "argus_round_cap_10");
    assert.equal(r4.argus_rounds.length, 10);

    // ---- promote: nothing until a human merges; then every covered row at once ----------------
    const none = await promote(pool, fx.dir, { runId: "run-C", promotePr: 99, ...refs });
    assert.deepEqual(none.promoted, []);
    assert.equal(none.stillIntegrated.length, 3);
    const oldMaster = fx.git("rev-parse", "master");
    fx.git("checkout", "-q", "master");
    fx.git("merge", "-q", "--no-ff", "-m", "promote integration", "integration");
    const promoted = await promote(pool, fx.dir, { runId: "run-C", promotePr: 99, ...refs });
    assert.deepEqual(promoted.promoted.sort(), [fx.U1, fx.U2, fx.U3].sort());
    assert.deepEqual(promoted.stillIntegrated, []);
    for (const sha of promoted.promoted) {
      const r = await rowOf(sha);
      assert.equal(r.status, "promoted");
      assert.equal(r.promote_pr, 99);
      assert.equal(r.master_sha, promoted.masterSha);
      assert.equal((await events(admin, sha, "promoted"))[0].run_ref, "run-C");
    }
    assert.equal((await rowOf(fx.U4)).status, "needs_human", "unrelated rows are untouched");
    await assert.rejects(promote(pool, fx.dir, { runId: "run-C", promotePr: 0, ...refs }), /promotePr/);

    // ---- verify: consistent, then a promotion that is not in master is reported -------------
    const ok = await verify(pool, fx.dir, refs);
    assert.deepEqual(ok, { ok: true, checked: 3, problems: [] });
    fx.git("branch", "old-master", oldMaster);
    const bad = await verify(pool, fx.dir, { integrationRef: refs.integrationRef, masterRef: "refs/heads/old-master" });
    assert.equal(bad.ok, false);
    assert.deepEqual([...new Set(bad.problems.map((p) => p.sha))].sort(), [fx.U1, fx.U2, fx.U3].sort());
    assert.ok(bad.problems.every((p) => p.status === "promoted"));
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await admin.query(`DROP OWNED BY ${LOGIN}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${LOGIN}`).catch(() => {});
    await admin.end();
    fx.cleanup();
  }
});
