// merge-plan candidate selection (planCandidates) and the CLI's merge-plan wiring, against the real
// ledger migrations in a scratch schema. Needs a scratch Postgres:
//   UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://...   (superuser, e.g. embedded Postgres)
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { planCandidates } from "../lib/handle.mjs";
import { makeFixture } from "./fixture-repo.mjs";

const url = process.env.UPSTREAM_SYNC_TEST_DATABASE_URL;
const skip = url ? false : "UPSTREAM_SYNC_TEST_DATABASE_URL not set";
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(here, "../../../packages/db/src/migrations");
const CLI = path.join(here, "../cli.mjs");
const SCHEMA = "upstream_sync_plan_test";

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

async function withLedger(fn) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const fx = makeFixture();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(`SET search_path TO ${SCHEMA}`);
    for (const f of ["0380_upstream_sync_ledger.sql", "0381_upstream_sync_events.sql", "0382_upstream_sync_worker_state.sql"]) {
      await applyMigration(admin, f);
    }
    const seed = async (sha, status, extra = {}) => {
      const cols = { upstream_sha: sha, title: "t", category: "fix", status, ...extra };
      if (status === "assessed") cols.path ??= "clean";
      if (status === "claimed") Object.assign(cols, { claimed_by: "run-X", claimed_at: new Date(), lease_expires_at: new Date(Date.now() + 600_000) });
      if (status === "skipped") cols.skip_reason ??= "already_present";
      const keys = Object.keys(cols);
      await admin.query(`INSERT INTO upstream_sync_log (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, keys.map((k) => cols[k]));
    };
    await fn({ admin, fx, seed });
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await admin.end();
  }
}

for (const [status, extra] of [["pending", {}], ["claimed", {}], ["in_review", { path: "conflict", review_pr: 5 }], ["needs_human", {}], ["failed", {}]]) {
  test(`planCandidates default: a ${status} row ends the run, so later assessed rows are not planned`, { skip }, async () => {
    await withLedger(async ({ admin, fx, seed }) => {
      await seed(fx.U0, "skipped");
      await seed(fx.U1, "assessed");
      await seed(fx.U2, status, extra);
      await seed(fx.U3, "assessed");
      const plan = await planCandidates(admin);
      assert.deepEqual(plan.shas, [fx.U1], "merging U3 would sweep U2 in");
      assert.deepEqual(plan.blockedBy, { sha: fx.U2, status });
    });
  });
}

test("planCandidates default: pending first row means an empty plan with the blocker named", { skip }, async () => {
  await withLedger(async ({ admin, fx, seed }) => {
    await seed(fx.U0, "pending");
    await seed(fx.U1, "assessed");
    assert.deepEqual(await planCandidates(admin), { shas: [], flagged: new Set(), blockedBy: { sha: fx.U0, status: "pending" } });
  });
});

test("planCandidates default: flagged rows are reported", { skip }, async () => {
  await withLedger(async ({ admin, fx, seed }) => {
    await seed(fx.U1, "assessed");
    await seed(fx.U2, "assessed", { touches_migrations: true });
    await seed(fx.U3, "assessed", { fork_owned_hits: ["server/src/x.ts"] });
    const plan = await planCandidates(admin);
    assert.deepEqual(plan.shas, [fx.U1, fx.U2, fx.U3]);
    assert.deepEqual([...plan.flagged].sort(), [fx.U2, fx.U3].sort());
    assert.equal(plan.blockedBy, null);
  });
});

test("planCandidates --shas: refuses unknown, unassessed and gap-leaving selections", { skip }, async () => {
  await withLedger(async ({ admin, fx, seed }) => {
    await seed(fx.U0, "integrated", { path: "clean", integration_sha: "a".repeat(40) });
    await seed(fx.U1, "assessed");
    await seed(fx.U2, "pending");
    await seed(fx.U3, "assessed");
    await assert.rejects(planCandidates(admin, { shas: [fx.U4] }), /no unresolved ledger row/);
    await assert.rejects(planCandidates(admin, { shas: [fx.U0] }), /no unresolved ledger row/, "already integrated rows are not plannable");
    await assert.rejects(planCandidates(admin, { shas: [fx.U2] }), /pending, not assessed/);
    await assert.rejects(planCandidates(admin, { shas: [fx.U3] }), /would also merge .* \(assessed\)|would also merge/, "U1 and U2 sit before U3");
    await assert.rejects(planCandidates(admin, { shas: [fx.U1, fx.U3] }), new RegExp(`${fx.U2}.*pending`));
    const ok = await planCandidates(admin, { shas: [fx.U1] });
    assert.deepEqual(ok.shas, [fx.U1]);
  });
});

test("cli merge-plan: plans assessed rows, names the blocker, and exits cleanly (pool is closed after the awaited command)", { skip }, async () => {
  await withLedger(async ({ admin, fx, seed }) => {
    await seed(fx.U1, "assessed");
    await seed(fx.U2, "assessed");
    await seed(fx.U3, "pending");
    const u = new URL(url);
    u.searchParams.set("options", `-c search_path=${SCHEMA}`);
    const run = () => promisify(execFile)(process.execPath, [CLI, "merge-plan", "--repo", fx.dir, "--integration-ref", "refs/heads/integration"], {
      env: { ...process.env, UPSTREAM_SYNC_DATABASE_URL: u.toString() },
    });
    const { stdout } = await run();
    const out = JSON.parse(stdout);
    assert.equal(out.kind, "clean");
    assert.deepEqual(out.shas, [fx.U1, fx.U2]);
    assert.deepEqual(out.blockedBy, { sha: fx.U3, status: "pending" });
  });
});
