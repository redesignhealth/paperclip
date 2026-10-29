// Deterministic worker commands (plan RED-580 sections 3-5, step 2).
//
// Everything here is mechanical: claim a row, compute its merge path, plan a clean
// batch, compute and verify a resolution delta, record state, detect a human-merged
// promotion, and cross-check the ledger against git ancestry. Judgment (resolving a
// conflict, driving Argus) stays with the agent.
//
// Git work uses plumbing only (`merge-tree --write-tree`, `merge-base --is-ancestor`,
// `diff`) against a repository directory, so nothing is checked out or modified in the
// working tree. Needs git >= 2.38 for `merge-tree --write-tree`.
//
// Ledger writes go through `inTransaction`, which does `SET LOCAL upstream_sync.run_ref`
// so the audit trigger (migration 0381) ties every change to the run that made it, and
// leaves the state machine (migration 0382 guard trigger) as the final authority.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
const SHA_RE = /^[0-9a-f]{40}$/;

// ---- git helpers ---------------------------------------------------------------------

async function git(repo, args, { allowExit = [] } = {}) {
  try {
    const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: 512 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (e) {
    if (typeof e.code === "number" && allowExit.includes(e.code)) return { code: e.code, stdout: e.stdout ?? "" };
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`, { cause: e });
  }
}

export async function resolveSha(repo, rev) {
  try {
    return (await git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).stdout.trim();
  } catch {
    return null;
  }
}

async function requireSha(repo, rev, label) {
  const sha = await resolveSha(repo, rev);
  if (!sha) throw new Error(`${label} ${rev} does not resolve to a commit in ${repo}`);
  return sha;
}

export async function isAncestor(repo, ancestor, descendant) {
  const { code } = await git(repo, ["merge-base", "--is-ancestor", ancestor, descendant], { allowExit: [1] });
  return code === 0;
}

// Result of merging `theirs` into `ours` without touching any ref or work tree. A
// conflicted merge still yields a tree (conflict markers committed), which is what the
// resolution delta is measured against.
export async function mergeTree(repo, ours, theirs) {
  const { code, stdout } = await git(repo, ["merge-tree", "--write-tree", "--no-messages", ours, theirs], { allowExit: [1] });
  const tree = stdout.split("\n")[0].trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`git merge-tree gave no tree for ${ours}..${theirs}`);
  return { clean: code === 0, tree };
}

// ---- transactions ----------------------------------------------------------------------

// `db` is a pg.Pool (a dedicated client is checked out) or a single pg.Client.
async function inTransaction(db, runRef, fn) {
  const client = typeof db.totalCount === "number" ? await db.connect() : db;
  const release = client === db ? () => {} : () => client.release();
  try {
    await client.query("BEGIN");
    try {
      // is_local = true: SET LOCAL semantics, gone at COMMIT/ROLLBACK.
      await client.query("SELECT set_config('upstream_sync.run_ref', $1, true)", [String(runRef ?? "")]);
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    release();
  }
}

function requireRun(runId) {
  if (!runId) throw new Error("a run id is required (the Paperclip run id, recorded as claimed_by and run_ref)");
  return String(runId);
}

// ---- claim -----------------------------------------------------------------------------

// One race-free statement: the oldest pending row, or a claimed row whose lease expired.
// Returns the row, or null when the queue is empty.
export async function claim(db, { runId, leaseMinutes = 15 } = {}) {
  runId = requireRun(runId);
  if (!Number.isFinite(leaseMinutes) || leaseMinutes <= 0) throw new Error("leaseMinutes must be > 0");
  return inTransaction(db, runId, async (c) => {
    const { rows } = await c.query(
      `UPDATE upstream_sync_log
          SET status = 'claimed', claimed_by = $1, claimed_at = now(),
              lease_expires_at = now() + make_interval(mins => $2::int), attempt = attempt + 1, updated_at = now()
        WHERE id = (SELECT id FROM upstream_sync_log
                     WHERE status = 'pending' OR (status = 'claimed' AND lease_expires_at < now())
                     ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`,
      [runId, Math.ceil(leaseMinutes)],
    );
    return rows[0] ?? null;
  });
}

async function loadRow(c, sha, { lock = false } = {}) {
  const { rows } = await c.query(`SELECT * FROM upstream_sync_log WHERE upstream_sha = $1${lock ? " FOR UPDATE" : ""}`, [sha]);
  if (!rows[0]) throw new Error(`no ledger row for ${sha}`);
  return rows[0];
}

// ---- assess ----------------------------------------------------------------------------

// A clean commit still gets whole-diff Argus review when it touches fork-owned paths or
// a Drizzle migration/schema (plan hole 1). The ledger already holds both flags.
export const needsWholeDiffReview = (row) => row.touches_migrations === true || (row.fork_owned_hits ?? []).length > 0;

// Decide where a claimed row goes: skipped (already in integration/master), or assessed
// with path clean/conflict. Moves the row out of `claimed`.
export async function assess(db, repo, { sha, runId, integrationRef, masterRef }) {
  runId = requireRun(runId);
  const integration = await requireSha(repo, integrationRef, "integration ref");
  const master = masterRef ? await requireSha(repo, masterRef, "master ref") : null;
  const upstream = await requireSha(repo, sha, "upstream sha");
  const present = (await isAncestor(repo, upstream, integration)) || (master !== null && (await isAncestor(repo, upstream, master)));
  const merge = present ? null : await mergeTree(repo, integration, upstream);

  return inTransaction(db, runId, async (c) => {
    const row = await loadRow(c, upstream, { lock: true });
    if (row.status !== "claimed" || row.claimed_by !== runId) {
      throw new Error(`row ${upstream} is ${row.status}${row.claimed_by ? ` (held by ${row.claimed_by})` : ""}, not claimed by ${runId}`);
    }
    if (present) {
      await c.query(
        `UPDATE upstream_sync_log SET status = 'skipped', skip_reason = 'already_present', lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
        [row.id],
      );
      return { sha: upstream, status: "skipped", reason: "already_present" };
    }
    const pathKind = merge.clean ? "clean" : "conflict";
    await c.query(
      `UPDATE upstream_sync_log SET status = 'assessed', path = $2, lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [row.id, pathKind],
    );
    return {
      sha: upstream,
      status: "assessed",
      path: pathKind,
      wholeDiffReview: pathKind === "clean" && needsWholeDiffReview(row),
      integration,
    };
  });
}

// ---- merge-plan ------------------------------------------------------------------------

// Longest run of `shas` (oldest first, upstream first-parent order) that merges cleanly
// into `integrationRef`, found by bisect on "merging shas[k-1] is clean": merging a sha
// brings in every earlier one, so the prefix is exactly what one merge of its last sha
// covers. A flagged commit (`isFlagged`) is never batched with others: the prefix stops
// before it, and when it is first it is planned alone. A conflicting first commit is also
// planned alone, as a conflict.
//
// Cleanliness need not be monotone in k, so the bisect only guarantees a boundary
// (clean at k, conflict at k+1), which is all that is needed: the returned plan is
// verified clean, and the next commit is merged on its own next round.
export async function mergePlan(repo, shas, { integrationRef, isFlagged = () => false, maxBatch = Infinity } = {}) {
  if (!shas.length) return { kind: "empty", shas: [] };
  const integration = await requireSha(repo, integrationRef, "integration ref");
  for (const s of shas) if (!SHA_RE.test(s)) throw new Error(`not a full sha: ${s}`);

  let limit = Math.min(shas.length, maxBatch);
  if (isFlagged(shas[0])) limit = 1;
  else {
    const flaggedAt = shas.findIndex((s, i) => i > 0 && i < limit && isFlagged(s));
    if (flaggedAt > 0) limit = flaggedAt;
  }
  const cand = shas.slice(0, limit);

  const cleanAt = new Map();
  const isClean = async (k) => {
    if (!cleanAt.has(k)) cleanAt.set(k, (await mergeTree(repo, integration, cand[k - 1])).clean);
    return cleanAt.get(k);
  };

  if (!(await isClean(1))) return { kind: "conflict", shas: [cand[0]], upTo: cand[0], integration };
  let lo = 1; // known clean
  let hi = cand.length + 1; // known conflict (virtual sentinel past the end)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await isClean(mid)) lo = mid;
    else hi = mid;
  }
  return { kind: "clean", shas: cand.slice(0, lo), upTo: cand[lo - 1], integration };
}

// ---- delta -----------------------------------------------------------------------------

// Resolution delta of `mergeCommit`: diff(auto-merge tree, merge commit tree). Verifies the
// commit really is a merge of `upstreamSha` into `base`, so a delta can never be computed
// against the wrong parents. Empty delta (sha256 null) = clean merge.
export async function delta(repo, { base, upstreamSha, mergeCommit, expectSha256 = null }) {
  const baseSha = await requireSha(repo, base, "base");
  const upstream = await requireSha(repo, upstreamSha, "upstream sha");
  const merge = await requireSha(repo, mergeCommit, "merge commit");
  const parents = (await git(repo, ["rev-list", "--parents", "-n", "1", merge])).stdout.trim().split(" ").slice(1);
  if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== upstream) {
    throw new Error(`${merge} is not a merge of ${upstream} into ${baseSha} (parents: ${parents.join(", ") || "none"})`);
  }
  const auto = await mergeTree(repo, baseSha, upstream);
  const resolvedTree = (await git(repo, ["rev-parse", `${merge}^{tree}`])).stdout.trim();
  // Fixed flags so the bytes (and the hash) do not depend on user git config.
  const diffArgs = ["-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-color", "--binary", "--full-index", "--no-renames"];
  const patch = (await git(repo, [...diffArgs, auto.tree, resolvedTree])).stdout;
  const files = (await git(repo, ["diff", "--no-renames", "--name-only", "-z", auto.tree, resolvedTree])).stdout
    .split("\0").filter(Boolean).sort();
  const sha256 = patch === "" ? null : crypto.createHash("sha256").update(patch).digest("hex");
  const out = { mergeCommit: merge, base: baseSha, upstreamSha: upstream, autoClean: auto.clean, autoTree: auto.tree, empty: sha256 === null, sha256, files };
  if (expectSha256 !== null && expectSha256 !== sha256) {
    throw Object.assign(new Error(`resolution delta mismatch: expected ${expectSha256}, got ${sha256}`), { delta: out });
  }
  return out;
}

// ---- record ----------------------------------------------------------------------------

// Columns a record call may set, per target status. The guard trigger enforces legality;
// this whitelist keeps a typo or a prompt-injected field name from touching anything else.
const SETTABLE = {
  assessed: ["path"],
  skipped: ["skip_reason"],
  in_review: ["path", "review_pr"],
  integrated: ["path", "integration_sha", "resolution_delta_sha256", "review_pr", "argus_verdict"],
  promoted: ["promote_pr", "master_sha"],
  needs_human: ["skip_reason", "review_pr", "argus_verdict"],
  failed: ["skip_reason"],
};

// Move rows (by upstream sha) to `status`, atomically: all rows or none. `argusRound`
// is appended to argus_rounds (never rewritten). A non-approving round that reaches
// `argusRoundCap` moves the row to needs_human instead of `status`.
export async function record(db, { shas, status, runId, fields = {}, argusRound = null, argusRoundCap = 10 }) {
  runId = requireRun(runId);
  if (!shas?.length) throw new Error("record needs at least one sha");
  if (!Object.hasOwn(SETTABLE, status)) throw new Error(`cannot record status ${status}`);
  for (const k of Object.keys(fields)) {
    if (!SETTABLE[status].includes(k)) throw new Error(`field ${k} cannot be set when recording ${status}`);
  }
  if (argusRound && shas.length !== 1) throw new Error("an Argus round belongs to exactly one row");
  if (!Number.isSafeInteger(argusRoundCap) || argusRoundCap < 1) throw new Error("argusRoundCap must be a positive integer");

  return inTransaction(db, runId, async (c) => {
    const results = [];
    for (const sha of shas) {
      const row = await loadRow(c, sha, { lock: true });
      let target = status;
      const sets = { ...fields };
      let capReached = false;
      let rounds = row.argus_rounds;
      if (argusRound) {
        rounds = [...row.argus_rounds, argusRound];
        const approved = String(argusRound.verdict ?? "").toLowerCase() === "approve";
        if (status === "integrated" && !approved) {
          throw new Error("a non-approving Argus round cannot be recorded with integrated");
        }
        if (!approved && rounds.length >= argusRoundCap) {
          capReached = true;
          target = "needs_human";
          sets.skip_reason = `argus_round_cap_${argusRoundCap}`;
        }
      }
      const cols = Object.keys(sets);
      const params = [row.id, target];
      const assigns = ["status = $2", "updated_at = now()"];
      // A row leaving `claimed` must drop its lease (claim_check constraint).
      if (row.status === "claimed") assigns.push("lease_expires_at = NULL");
      for (const col of cols) {
        params.push(sets[col]);
        assigns.push(`${col} = $${params.length}`);
      }
      if (argusRound) {
        params.push(JSON.stringify(rounds));
        assigns.push(`argus_rounds = $${params.length}::jsonb`);
        if (argusRound.verdict) {
          params.push(String(argusRound.verdict));
          assigns.push(`argus_verdict = $${params.length}`);
        }
      }
      const { rows } = await c.query(`UPDATE upstream_sync_log SET ${assigns.join(", ")} WHERE id = $1 RETURNING upstream_sha, status`, params);
      results.push({ sha: rows[0].upstream_sha, status: rows[0].status, capReached });
    }
    return results;
  });
}

// ---- promote ---------------------------------------------------------------------------

// Detect a human-merged promotion and record it. The worker never merges to master; this
// marks every `integrated` row whose merge commit is now an ancestor of `masterRef` as
// `promoted`, all in one transaction. `masterSha` defaults to the master tip observed.
export async function promote(db, repo, { runId, promotePr, masterRef, masterSha = null }) {
  runId = requireRun(runId);
  if (!Number.isSafeInteger(promotePr) || promotePr < 1) throw new Error("promotePr (the merged PR number) is required");
  const master = await requireSha(repo, masterSha ?? masterRef, "master");
  const { rows } = await db.query(
    `SELECT upstream_sha, integration_sha FROM upstream_sync_log WHERE status = 'integrated' ORDER BY id`,
  );
  const merged = [];
  const pending = [];
  const cache = new Map();
  for (const r of rows) {
    if (!cache.has(r.integration_sha)) cache.set(r.integration_sha, await isAncestor(repo, r.integration_sha, master));
    (cache.get(r.integration_sha) ? merged : pending).push(r.upstream_sha);
  }
  if (merged.length) {
    await record(db, { shas: merged, status: "promoted", runId, fields: { promote_pr: promotePr, master_sha: master } });
  }
  return { promoted: merged, stillIntegrated: pending, masterSha: master };
}

// ---- verify ----------------------------------------------------------------------------

// Cross-check ledger rows against git ancestry. Returns mismatches (empty = consistent):
//   integrated: upstream_sha and integration_sha must be in `integration` (or already in
//               master, if promoted since), and integration_sha must contain upstream_sha.
//   promoted:   upstream_sha and integration_sha must be in `master`; a squash or rebase
//               promotion drops them and shows up here.
export async function verify(db, repo, { integrationRef, masterRef }) {
  const integration = await requireSha(repo, integrationRef, "integration ref");
  const master = await requireSha(repo, masterRef, "master ref");
  const { rows } = await db.query(
    `SELECT upstream_sha, integration_sha, master_sha, status FROM upstream_sync_log WHERE status IN ('integrated', 'promoted') ORDER BY id`,
  );
  const problems = [];
  const known = async (sha) => (await resolveSha(repo, sha)) !== null;
  for (const r of rows) {
    const bad = (problem) => problems.push({ sha: r.upstream_sha, status: r.status, problem });
    if (!(await known(r.upstream_sha))) { bad("upstream sha not present in repository"); continue; }
    if (!(await known(r.integration_sha))) { bad("integration_sha not present in repository"); continue; }
    if (!(await isAncestor(repo, r.upstream_sha, r.integration_sha))) bad("upstream sha is not an ancestor of integration_sha");
    if (r.status === "integrated") {
      if (!(await isAncestor(repo, r.integration_sha, integration)) && !(await isAncestor(repo, r.integration_sha, master))) {
        bad("integration_sha is in neither integration nor master");
      }
    } else {
      if (!(await isAncestor(repo, r.upstream_sha, master))) bad("upstream sha is not in master (squash/rebase promotion?)");
      if (!(await isAncestor(repo, r.integration_sha, master))) bad("integration_sha is not in master");
      if (r.master_sha && !(await isAncestor(repo, r.master_sha, master))) bad("master_sha is not an ancestor of master");
    }
  }
  return { ok: problems.length === 0, checked: rows.length, problems };
}
