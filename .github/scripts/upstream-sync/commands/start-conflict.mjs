// `start-conflict`: start the merge of the one conflicting upstream commit and settle the mechanical files, so the
// model is left only the real conflicts. Also exports `regenerate`, which the model runs after resolving them.
//
// Settled by script, never by the model (condition 1 of the sync go decision):
//   lockfiles          the fork's copy (a PR must not edit pnpm-lock.yaml)
//   migrations         upstream's new ones renumbered after the fork's last; journal and snapshots rebuilt
//   generated files    the fork's copy as a placeholder, then the generator writes the real output
// A generated file that no generator is registered for is reported, set to the fork's copy, and never left to the model.
import { parseArgs } from "../lib/args.mjs";
import { changedAgainst, runGenerators } from "../lib/generate.mjs";
import { blobAt, git, gitOut, isWorkingTreeClean, resolveRefs, syncPoint } from "../lib/git.mjs";
import { GENERATORS, LOCKFILE_RE, classifyFile, generatorIsAffected, splitConflicts } from "../lib/mechanical.mjs";
import { settleMigrations } from "../lib/migrations.mjs";
import { listSteps, shortSha } from "../lib/walk.mjs";
import { computeNext, NEXT_FLAGS, branchName } from "./next.mjs";

export const START_FLAGS = { boolean: [...NEXT_FLAGS.boolean, "allowClean", "allowOutOfOrder", "commit"], number: NEXT_FLAGS.number };

const unmergedPaths = (cwd) =>
  gitOut(cwd, ["diff", "--name-only", "-z", "--diff-filter=U"], { allowFail: true }).split("\0").filter(Boolean);

function restoreFromMaster(cwd, master, path) {
  const blob = blobAt(cwd, master, path);
  if (blob) {
    git(cwd, ["checkout", master, "--", path]);
  } else {
    git(cwd, ["rm", "-f", "-q", "--", path], { allowFail: true });
  }
}

/** Exit codes: 0 started, 1 error, 6 nothing to start (not conflicting / wrong order). */
export async function startConflict(cwd, opts, positional) {
  if (!isWorkingTreeClean(cwd)) throw new Error("tracked files have uncommitted changes; commit or stash them first");
  const refs = resolveRefs(cwd, opts);
  const base = syncPoint(cwd, refs.master, refs.upstream);
  let sha = positional;
  if (!sha) {
    const next = computeNext(cwd, { ...opts, fetch: false });
    if (!next.next) throw new Error("no conflicting upstream commit found; run `next`");
    sha = next.next.sha;
  }
  const { steps } = listSteps(cwd, base, refs.upstream, 1);
  if (!steps.length) throw new Error("fork is up to date with upstream");
  if (!opts.allowOutOfOrder && steps[0].sha !== sha) {
    throw new Error(
      `${shortSha(sha)} is not the next upstream commit (${shortSha(steps[0].sha)} is). Land the commits before it first (merge-clean).`,
    );
  }

  const branch = branchName(sha);
  git(cwd, ["checkout", "-q", "-B", branch, refs.master]);
  const merge = git(cwd, ["merge", "--no-commit", "--no-ff", sha], { allowFail: true });
  const unmerged = unmergedPaths(cwd);
  if (merge.status === 0 && !opts.allowClean) {
    git(cwd, ["merge", "--abort"], { allowFail: true });
    throw new Error(`${shortSha(sha)} merges cleanly; use merge-clean (or --allow-clean to start it anyway)`);
  }

  const settled = [];
  const attention = [];
  const pendingGenerators = new Set();

  // Lockfiles: every lockfile the merge touched goes back to the fork's copy.
  for (const path of changedAgainst(cwd, refs.master).filter((p) => LOCKFILE_RE.test(p))) {
    restoreFromMaster(cwd, refs.master, path);
    settled.push({ path, rule: "lockfile", action: "kept the fork's copy" });
  }

  // Migrations: always plan when upstream adds any, since colliding numbers do not conflict in git.
  const migrationPaths = unmerged.filter((p) => classifyFile(p).rule?.startsWith("migration-"));
  const migrationResult = settleMigrations(cwd, { master: refs.master, base: gitOut(cwd, ["merge-base", refs.master, sha]), theirs: sha });
  if (migrationResult.plan.length > 0 || migrationPaths.length > 0) {
    for (const path of migrationPaths) settled.push({ path, rule: classifyFile(path).rule, action: "migration numbering settled" });
    for (const action of migrationResult.actions) settled.push({ path: "(migrations)", rule: "migration", action });
  }

  // Generated files: the fork's copy as a placeholder; the generators write the real output below.
  for (const path of unmerged) {
    const c = classifyFile(path);
    if (c.action === "regenerate") {
      restoreFromMaster(cwd, refs.master, path);
      pendingGenerators.add(c.generator);
      settled.push({ path, rule: c.rule, action: "placeholder; regenerated after the real conflicts are resolved" });
    } else if (c.action === "needs-generator") {
      restoreFromMaster(cwd, refs.master, path);
      attention.push(`${path} looks generated but no generator is registered for it; kept the fork's copy. Register its generator in lib/mechanical.mjs.`);
    }
  }

  const stillUnmerged = unmergedPaths(cwd);
  const { real } = splitConflicts(stillUnmerged);
  const realPaths = real.map((r) => r.path);
  const done = (kind) => ({ kind, branch, sha, settled, attention, real: realPaths, regenerated: false });

  if (realPaths.length > 0) {
    return done("real-conflicts");
  }

  // Nothing left for the model: write generated outputs, commit the merge.
  const outcome = regenerate(cwd, opts, refs.master, pendingGenerators);
  const result = { ...done("mechanical-only"), regenerated: outcome.ok, regenerateProblems: outcome.problems };
  if (outcome.ok && opts.commit !== false) {
    git(cwd, ["add", "-A", "--", "."]);
    git(cwd, ["commit", "-q", "-m", `Merge upstream ${shortSha(sha)}`, "-m", `Upstream commit ${sha}`]);
    result.kind = "committed";
  }
  return result;
}

/** Run the generators affected by the change, plus any in `pending`, and stage their output. */
export function regenerate(cwd, opts, master, pending = new Set()) {
  const changed = changedAgainst(cwd, master);
  const generators = GENERATORS.filter((g) => pending.has(g.id) || generatorIsAffected(g, changed));
  const results = runGenerators(cwd, generators, { buildCmd: opts.buildCmd });
  const problems = results.filter((r) => !r.ok).map((r) => r.output);
  if (problems.length === 0) git(cwd, ["add", "-A", "--", "."]);
  return { ok: problems.length === 0, problems, generators: generators.map((g) => g.id) };
}

export function formatStart(r) {
  const lines = [`${r.kind === "committed" ? "merged" : "started"} ${shortSha(r.sha)} on ${r.branch}`];
  for (const s of r.settled) lines.push(`  settled by script (${s.rule}): ${s.path}: ${s.action}`);
  for (const a of r.attention) lines.push(`  ATTENTION ${a}`);
  if (r.real.length) {
    lines.push(`${r.real.length} real conflict(s) left for the model:`);
    for (const p of r.real) lines.push(`  ${p}`);
    lines.push("next: resolve them, git add, then `regenerate`, commit, `check`, `resolution-diff`");
  } else if (r.kind === "committed") lines.push("no real conflicts: the merge is committed; next: `check`");
  else lines.push(`generators did not finish:\n${(r.regenerateProblems ?? []).join("\n")}`);
  return lines.join("\n");
}

export async function run(argv, { cwd = process.cwd(), stdout = process.stdout } = {}) {
  const { opts, rest } = parseArgs(argv, START_FLAGS);
  const result = await startConflict(cwd, opts, rest[0]);
  stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatStart(result)}\n`);
  return result.kind === "real-conflicts" || result.kind === "committed" ? 0 : 1;
}

/** `regenerate`: after the real conflicts are resolved, write generated files with their generators and stage them. */
export async function runRegenerate(argv, { cwd = process.cwd(), stdout = process.stdout } = {}) {
  const { opts } = parseArgs(argv, { boolean: ["json", "fetch"] });
  const refs = resolveRefs(cwd, { ...opts, fetch: false });
  const out = regenerate(cwd, opts, refs.master);
  stdout.write(
    opts.json
      ? `${JSON.stringify(out, null, 2)}\n`
      : out.ok
        ? `regenerated and staged: ${out.generators.join(", ") || "nothing affected"}\n`
        : `${out.problems.join("\n")}\n`,
  );
  return out.ok ? 0 : 1;
}

