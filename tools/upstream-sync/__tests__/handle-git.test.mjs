// handle.mjs git half: merge-plan and delta against a fixture repository (no database).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { delta, isAncestor, mergePlan, mergeTree, needsWholeDiffReview } from "../lib/handle.mjs";
import { makeFixture } from "./fixture-repo.mjs";

test("merge-plan: longest clean prefix, flagged commits stand alone, conflict planned alone", async () => {
  const fx = makeFixture();
  try {
    const all = [fx.U1, fx.U2, fx.U3, fx.U4];
    const ref = "refs/heads/integration";

    const plan = await mergePlan(fx.dir, all, { integrationRef: ref });
    assert.equal(plan.kind, "clean");
    assert.deepEqual(plan.shas, [fx.U1, fx.U2], "stops before U3, which conflicts with the fork edit of a.txt");
    assert.equal(plan.upTo, fx.U2);
    assert.equal((await mergeTree(fx.dir, fx.integration, plan.upTo)).clean, true);

    // A flagged commit is never batched with others.
    const flagU2 = await mergePlan(fx.dir, all, { integrationRef: ref, isFlagged: (s) => s === fx.U2 });
    assert.deepEqual(flagU2.shas, [fx.U1]);
    const flagFirst = await mergePlan(fx.dir, all, { integrationRef: ref, isFlagged: (s) => s === fx.U1 });
    assert.deepEqual(flagFirst.shas, [fx.U1], "a flagged first commit is merged alone");

    assert.deepEqual((await mergePlan(fx.dir, all, { integrationRef: ref, maxBatch: 1 })).shas, [fx.U1]);

    const conflict = await mergePlan(fx.dir, [fx.U3, fx.U4], { integrationRef: ref });
    assert.equal(conflict.kind, "conflict");
    assert.deepEqual(conflict.shas, [fx.U3]);

    assert.deepEqual(await mergePlan(fx.dir, [], { integrationRef: ref }), { kind: "empty", shas: [] });
    await assert.rejects(mergePlan(fx.dir, ["abc"], { integrationRef: ref }), /not a full sha/);
    await assert.rejects(mergePlan(fx.dir, all, { integrationRef: "refs/heads/nope" }), /does not resolve/);
  } finally {
    fx.cleanup();
  }
});

test("needsWholeDiffReview: fork-owned hits or migrations", () => {
  assert.equal(needsWholeDiffReview({ touches_migrations: false, fork_owned_hits: [] }), false);
  assert.equal(needsWholeDiffReview({ touches_migrations: true, fork_owned_hits: [] }), true);
  assert.equal(needsWholeDiffReview({ touches_migrations: false, fork_owned_hits: ["a.ts"] }), true);
});

test("delta: empty for a clean merge, stable hash for a resolution, verifies parents and expected hash", async () => {
  const fx = makeFixture();
  try {
    const clean = fx.merge("integration", fx.U2);
    const d0 = await delta(fx.dir, { base: fx.integration, upstreamSha: fx.U2, mergeCommit: clean });
    assert.equal(d0.empty, true);
    assert.equal(d0.sha256, null);
    assert.equal(d0.autoClean, true);
    assert.deepEqual(d0.files, []);

    // Conflicted merge of U3, resolved by hand: the delta is the resolution and nothing else.
    const base = clean;
    const resolved = fx.mergeResolved("integration", fx.U3, { "a.txt": "resolved line\nsecond\nthird\n" });
    const d1 = await delta(fx.dir, { base, upstreamSha: fx.U3, mergeCommit: resolved });
    assert.equal(d1.empty, false);
    assert.equal(d1.autoClean, false);
    assert.match(d1.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(d1.files, ["a.txt"], "only the conflicted file differs from the auto-merge");

    const again = await delta(fx.dir, { base, upstreamSha: fx.U3, mergeCommit: resolved, expectSha256: d1.sha256 });
    assert.equal(again.sha256, d1.sha256, "deterministic");

    await assert.rejects(
      delta(fx.dir, { base, upstreamSha: fx.U3, mergeCommit: resolved, expectSha256: "0".repeat(64) }),
      /resolution delta mismatch/,
    );
    await assert.rejects(delta(fx.dir, { base: fx.integration, upstreamSha: fx.U3, mergeCommit: resolved }), /is not a merge of/);
    await assert.rejects(delta(fx.dir, { base, upstreamSha: fx.U4, mergeCommit: resolved }), /is not a merge of/);

    assert.equal(await isAncestor(fx.dir, fx.U3, resolved), true);
    assert.equal(await isAncestor(fx.dir, fx.U4, resolved), false);
  } finally {
    fx.cleanup();
  }
});

test("delta/merge-plan do not modify refs or the work tree", async () => {
  const fx = makeFixture();
  try {
    const before = execFileSync("git", ["-C", fx.dir, "for-each-ref"], { encoding: "utf8" });
    await mergePlan(fx.dir, [fx.U1, fx.U2, fx.U3], { integrationRef: "refs/heads/integration" });
    assert.equal(execFileSync("git", ["-C", fx.dir, "for-each-ref"], { encoding: "utf8" }), before);
    assert.equal(execFileSync("git", ["-C", fx.dir, "status", "--porcelain"], { encoding: "utf8" }), "");
  } finally {
    fx.cleanup();
  }
});
