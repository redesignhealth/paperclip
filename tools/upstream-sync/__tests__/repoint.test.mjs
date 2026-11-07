// Audited re-point of upstream_sync_log.integration_sha (RED-874, migration 0387), against the
// real migrations 0380-0382 + 0387 in a scratch schema, driven as a restricted non-superuser
// login (a superuser is implicitly a member of upstream_sync_human and would bypass the guard).
// Needs a scratch Postgres on which the login may CREATE ROLE:
//   UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://...   (superuser, e.g. embedded Postgres)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { repoint } from "../lib/handle.mjs";
import { makeFixture } from "./fixture-repo.mjs";

const url = process.env.UPSTREAM_SYNC_TEST_DATABASE_URL;
const skip = url ? false : "UPSTREAM_SYNC_TEST_DATABASE_URL not set";
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(here, "../../../packages/db/src/migrations");
const SCHEMA = "upstream_sync_repoint_test";
const LOGIN = "upstream_sync_repoint_test_login";
const PASSWORD = "scratch-only";
const FILES = [
  "0380_upstream_sync_ledger.sql",
  "0381_upstream_sync_events.sql",
  "0382_upstream_sync_worker_state.sql",
  "0387_upstream_sync_integration_repoint.sql",
];

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

test("repoint: descendant accepted, non-descendant rejected, audited, guard still blocks plain updates", { skip }, async () => {
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
    for (const f of FILES) await applyMigration(admin, f);
    await admin.query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD '${PASSWORD}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${LOGIN}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON upstream_sync_log TO ${LOGIN}`);
    await admin.query(`GRANT SELECT ON upstream_sync_events, upstream_sync_integration_repoints TO ${LOGIN}`);
    await admin.query(`GRANT USAGE, SELECT ON SEQUENCE upstream_sync_log_id_seq TO ${LOGIN}`);
    // What the migration grants the real upstream_sync_runner login.
    await admin.query(`GRANT EXECUTE ON FUNCTION upstream_sync_repoint_integration_sha(bigint, text, text, text) TO ${LOGIN}`);

    // Rows as the worker leaves them: integrated at the pre-merge commit (`fx.integration`,
    // which does not contain the upstream sha, so verify would fail), via the admin owner.
    const OLD = fx.integration;
    const integrate = async (sha, integrationSha, extra = "") => {
      await admin.query(`INSERT INTO upstream_sync_log (upstream_sha, title, category) VALUES ($1, 't', 'fix')`, [sha]);
      await admin.query(
        `UPDATE upstream_sync_log SET status='integrated', path='clean', integration_sha=$2 ${extra} WHERE upstream_sha=$1`,
        [sha, integrationSha],
      ).catch(async () => {
        // The guard is not bypassed for the owner: walk the legal edges.
        await admin.query(`UPDATE upstream_sync_log SET status='claimed', claimed_by='r', claimed_at=now(), lease_expires_at=now()+interval '1 hour', attempt=1 WHERE upstream_sha=$1`, [sha]);
        await admin.query(`UPDATE upstream_sync_log SET status='assessed', path='clean', lease_expires_at=NULL WHERE upstream_sha=$1`, [sha]);
        await admin.query(`UPDATE upstream_sync_log SET status='integrated', integration_sha=$2 WHERE upstream_sha=$1`, [sha, integrationSha]);
      });
    };
    await integrate(fx.U1, OLD);
    await integrate(fx.U2, OLD);
    const rowOf = async (sha) => (await admin.query(`SELECT * FROM upstream_sync_log WHERE upstream_sha = $1`, [sha])).rows[0];
    const audits = async () => (await admin.query(`SELECT * FROM upstream_sync_integration_repoints ORDER BY id`)).rows;

    const u = new URL(url);
    u.username = LOGIN;
    u.password = PASSWORD;
    u.searchParams.set("options", `-c search_path=${SCHEMA}`);
    pool = new pg.Pool({ connectionString: u.toString(), max: 1 });
    const refs = { integrationRef: "refs/heads/integration", masterRef: "refs/heads/master" };
    const base = { runId: "RED-874-test", ...refs };

    // ---- the guard still blocks a plain update ------------------------------------------------
    const M = fx.merge("integration", fx.U1); // descends from OLD, contains U1
    await assert.rejects(pool.query(`UPDATE upstream_sync_log SET integration_sha=$2 WHERE upstream_sha=$1`, [fx.U1, M]), /write-once/);
    // Nor can the runner forge the audit row that would unlock it, or edit one.
    await assert.rejects(
      pool.query(`INSERT INTO upstream_sync_integration_repoints (log_id, upstream_sha, old_integration_sha, new_integration_sha, actor, reason) VALUES (1, $1, $2, $3, 'x', 'forged')`, [fx.U1, OLD, M]),
      /permission denied/,
    );
    assert.equal((await rowOf(fx.U1)).integration_sha, OLD);
    assert.deepEqual(await audits(), []);

    // ---- non-descendant rejected --------------------------------------------------------------
    // U2 contains U1 but is on the upstream line, not a descendant of OLD (the fork's tip).
    await assert.rejects(repoint(pool, fx.dir, { ...base, sha: fx.U1, newSha: fx.U2, expectOld: OLD, reason: "x" }), /does not descend from/);
    // A descendant that does not contain the upstream sha (M contains U1, not U2).
    await assert.rejects(repoint(pool, fx.dir, { ...base, sha: fx.U2, newSha: M, expectOld: OLD, reason: "x" }), /does not contain upstream sha/);
    // Not on integration or master.
    fx.git("checkout", "-q", "-b", "side", M);
    fx.git("commit", "-q", "--allow-empty", "-m", "side");
    const side = fx.git("rev-parse", "HEAD");
    await assert.rejects(repoint(pool, fx.dir, { ...base, sha: fx.U1, newSha: side, expectOld: OLD, reason: "x" }), /neither integration nor master/);
    // Same sha, missing reason, stale expectation.
    await assert.rejects(repoint(pool, fx.dir, { ...base, sha: fx.U1, newSha: OLD, expectOld: OLD, reason: "x" }), /nothing to re-point/);
    await assert.rejects(repoint(pool, fx.dir, { ...base, sha: fx.U1, newSha: M, expectOld: OLD, reason: "  " }), /reason is required/);
    await assert.rejects(repoint(pool, fx.dir, { ...base, sha: fx.U1, newSha: M, expectOld: fx.base, reason: "x" }), /integration_sha is .*not the expected/);
    assert.equal((await rowOf(fx.U1)).integration_sha, OLD, "every refusal left the row alone");
    assert.deepEqual(await audits(), [], "and wrote no audit row");

    // ---- descendant accepted, audit row written -----------------------------------------------
    const before = Date.now();
    const r = await repoint(pool, fx.dir, { ...base, sha: fx.U1, newSha: M, expectOld: OLD, reason: "#288 merged as a merge commit; ancestry now holds" });
    assert.deepEqual(r.repointed, { from: OLD, to: M });
    const row = await rowOf(fx.U1);
    assert.equal(row.integration_sha, M);
    assert.equal(row.status, "integrated");
    const [audit, ...rest] = await audits();
    assert.equal(rest.length, 0);
    assert.equal(Number(audit.log_id), Number(row.id));
    assert.equal(audit.upstream_sha, fx.U1);
    assert.equal(audit.old_integration_sha, OLD);
    assert.equal(audit.new_integration_sha, M);
    assert.equal(audit.actor, LOGIN, "actor is the connected login, not the definer");
    assert.equal(audit.reason, "#288 merged as a merge commit; ancestry now holds");
    assert.equal(audit.run_ref, "RED-874-test");
    assert.ok(new Date(audit.created_at).getTime() >= before - 5000);
    // The ledger audit trail records the same change, attributed to the same run.
    const ev = (await admin.query(`SELECT * FROM upstream_sync_events WHERE upstream_sha=$1 AND operation='update' AND 'integration_sha' = ANY(changed_columns)`, [fx.U1])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].new_values.integration_sha, M);
    assert.equal(ev[0].actor, LOGIN);
    // Only integration_sha moved.
    assert.equal(row.upstream_sha, fx.U1);

    // The audit row is append-only, even for the owner.
    await assert.rejects(admin.query(`UPDATE upstream_sync_integration_repoints SET reason='edited'`), /append-only/);
    await assert.rejects(admin.query(`DELETE FROM upstream_sync_integration_repoints`), /append-only/);
    await assert.rejects(admin.query(`TRUNCATE upstream_sync_integration_repoints`), /append-only/);

    // ---- it is not a general bypass ------------------------------------------------------------
    // The write-once guard is intact after a re-point...
    await assert.rejects(pool.query(`UPDATE upstream_sync_log SET integration_sha=$2 WHERE upstream_sha=$1`, [fx.U1, OLD]), /write-once/);
    // ...an audit row from an earlier transaction does not unlock a replay...
    await assert.rejects(pool.query(`UPDATE upstream_sync_log SET integration_sha=$2 WHERE upstream_sha=$1`, [fx.U1, fx.U2]), /write-once/);
    // ...and inside the same transaction only the audited old -> new change is allowed.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const M2 = fx.merge("integration", fx.U2);
      await c.query(`SELECT upstream_sync_repoint_integration_sha($1, $2, $3, 'second hop')`, [(await rowOf(fx.U2)).id, OLD, M2]);
      await assert.rejects(c.query(`UPDATE upstream_sync_log SET integration_sha=$2 WHERE upstream_sha=$1`, [fx.U2, M]), /write-once/);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    assert.equal((await rowOf(fx.U2)).integration_sha, OLD, "rolled back with its audit row");
    assert.equal((await audits()).length, 1);

    // The function itself refuses what the tool would never send: a non-integrated row, a
    // conflict resolution, a malformed sha, a stale expectation.
    const id1 = (await rowOf(fx.U1)).id;
    await assert.rejects(pool.query(`SELECT upstream_sync_repoint_integration_sha($1, $2, $3, 'r')`, [id1, M, "nothex"]), /40-hex/);
    await assert.rejects(pool.query(`SELECT upstream_sync_repoint_integration_sha($1, $2, $3, 'r')`, [id1, OLD, M]), /not the expected/);
    await assert.rejects(pool.query(`SELECT upstream_sync_repoint_integration_sha(999999, $1, $2, 'r')`, [OLD, M]), /no ledger row/);
    await admin.query(`INSERT INTO upstream_sync_log (upstream_sha, title, category) VALUES ($1, 't', 'fix')`, [fx.U3]);
    await assert.rejects(pool.query(`SELECT upstream_sync_repoint_integration_sha($1, $2, $3, 'r')`, [(await rowOf(fx.U3)).id, OLD, M]), /only an integrated row/);
    // A caller without EXECUTE cannot use it at all.
    await admin.query(`REVOKE EXECUTE ON FUNCTION upstream_sync_repoint_integration_sha(bigint, text, text, text) FROM ${LOGIN}`);
    await assert.rejects(pool.query(`SELECT upstream_sync_repoint_integration_sha($1, $2, $3, 'r')`, [id1, M, fx.U2]), /permission denied/);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await admin.query(`DROP OWNED BY ${LOGIN}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${LOGIN}`).catch(() => {});
    await admin.end();
    fx.cleanup();
  }
});
