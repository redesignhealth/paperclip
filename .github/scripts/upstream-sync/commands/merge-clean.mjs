// `merge-clean`: merge the clean stretch, push, open the PR. No model call.
// Each upstream commit becomes one merge commit. `check` runs after every one (condition 3 of the sync go decision),
// so a commit that merges clean but breaks the build or a test ends the stretch there and is reported for a model fix.
import { parseArgs } from "../lib/args.mjs";
import { git, gitOut, isWorkingTreeClean } from "../lib/git.mjs";
import { computeNext, NEXT_FLAGS } from "./next.mjs";
import { runCheck, formatCheck } from "./check.mjs";
import { buildCleanStretchBody, buildCleanStretchTitle } from "../lib/prbody.mjs";
import { runArgv } from "../lib/shell.mjs";
import { shortSha } from "../lib/walk.mjs";

export const MERGE_CLEAN_FLAGS = { boolean: [...NEXT_FLAGS.boolean, "push", "pr", "json"], number: NEXT_FLAGS.number };

/** Exit codes: 0 done or nothing to do, 1 error, 5 the first clean-merging commit fails its checks (needs a model fix). */
export async function run(argv, { cwd = process.cwd(), stdout = process.stdout, check = runCheck } = {}) {
  const { opts } = parseArgs(argv, MERGE_CLEAN_FLAGS);
  const say = (line) => (opts.json ? null : stdout.write(`${line}\n`));
  if (!isWorkingTreeClean(cwd)) throw new Error("tracked files have uncommitted changes; commit or stash them first");

  const report = computeNext(cwd, opts);
  if (!report.stretch) {
    const result = { kind: report.kind, merged: [], note: "no clean stretch to merge" };
    stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `nothing to merge cleanly (${report.kind})\n`);
    return 0;
  }

  // Re-walk to get each step's merge commit (computeNext reports only the final one).
  const { listSteps, walkCleanStretch } = await import("../lib/walk.mjs");
  const { steps } = listSteps(cwd, report.base, report.upstream, opts.window ?? Math.max((opts.maxSteps ?? 50) + 1, 200));
  const walk = walkCleanStretch(cwd, { head: report.master, master: report.master, steps, maxSteps: opts.maxSteps ?? 50 });

  const original = gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const originalRef = original === "HEAD" ? gitOut(cwd, ["rev-parse", "HEAD"]) : original;
  const passed = [];
  const risks = [];
  let failed = null;
  let lastGood = report.master;
  try {
    for (const merged of walk.clean) {
      git(cwd, ["checkout", "-q", "--detach", merged.merge]);
      const result = check(cwd, { since: lastGood, master: report.master, typecheckCmd: opts.typecheckCmd, testCmd: opts.testCmd, buildCmd: opts.buildCmd });
      if (!result.ok) {
        failed = { step: merged, result };
        break;
      }
      passed.push(merged);
      for (const risk of result.risks) risks.push(`${shortSha(merged.sha)}: ${risk}`);
      lastGood = merged.merge;
      say(`step ${passed.length}/${walk.clean.length} ${shortSha(merged.sha)} ${merged.subject}: checks pass`);
    }
  } finally {
    git(cwd, ["checkout", "-q", originalRef]);
  }

  const summary = {
    kind: passed.length ? "merged" : "blocked",
    branch: null,
    merged: passed.map(({ sha, pr, subject }) => ({ sha, pr, subject })),
    failedStep: failed ? { sha: failed.step.sha, pr: failed.step.pr, subject: failed.step.subject, steps: failed.result.steps, risks: failed.result.risks } : null,
    pr: null,
  };

  if (passed.length === 0) {
    stdout.write(opts.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatBlocked(failed)}\n`);
    return failed ? 5 : 0;
  }

  const last = passed[passed.length - 1];
  const branch = `factory/upstream-sync/${last.sha}`;
  summary.branch = branch;
  git(cwd, ["branch", "-f", branch, last.merge]);
  say(`branch ${branch} at ${shortSha(last.merge)} (${passed.length} step(s))`);

  const conflictEntries = [...new Set(passed.flatMap((s) => s.restoredLockfiles ?? []))].map((path) => ({
    path,
    kind: "mechanical",
    rule: "lockfile",
    resolution: "kept the fork's copy (CI owns lockfile updates)",
  }));
  const checkSummary = [
    "Typecheck and the changed tests ran after every merged step, and the generators and lockfile were checked.",
    ...(risks.length ? ["", "Both sides made the same numeric edit in these places; their tests ran, but a person should confirm the value:", ...risks.map((r) => `- ${r}`)] : []),
  ].join("\n");
  const body = buildCleanStretchBody({ steps: passed, base: report.base, conflictEntries, checkSummary });
  const title = buildCleanStretchTitle(passed);

  if (opts.push !== false) {
    git(cwd, ["push", "origin", `${branch}:refs/heads/${branch}`]);
    say(`pushed ${branch}`);
    if (opts.pr !== false) {
      const created = runArgv(cwd, ["gh", "pr", "create", "--base", "master", "--head", branch, "--title", title, "--body", body]);
      if (!created.ok) throw new Error(`gh pr create failed: ${created.output.trim()}`);
      summary.pr = created.output.split("\n").map((l) => l.trim()).filter((l) => /^https:\/\/\S+\/pull\/\d+$/.test(l)).pop() ?? created.output.trim();
      say(`opened ${summary.pr}`);
    }
  }
  if (failed) say(`\n${formatBlocked(failed)}`);
  stdout.write(opts.json ? `${JSON.stringify(summary, null, 2)}\n` : "");
  return 0;
}

function formatBlocked(failed) {
  if (!failed) return "nothing merged";
  return [
    `${shortSha(failed.step.sha)} ${failed.step.subject} merges cleanly but fails its checks; it needs a model fix, not a merge-clean:`,
    formatCheck(failed.result),
  ].join("\n");
}
