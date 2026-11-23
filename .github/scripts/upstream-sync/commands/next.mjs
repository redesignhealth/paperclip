// `next`: fetch upstream, walk forward from the sync point, and report how far the walk merges cleanly and which
// upstream commit conflicts next. It writes commit objects (and a throwaway index file) to the git directory and
// refreshes the remote-tracking refs when it fetches; the work tree, index and local branches are never touched.
import { parseArgs } from "../lib/args.mjs";
import { resolveRefs, syncPoint } from "../lib/git.mjs";
import { splitConflicts } from "../lib/mechanical.mjs";
import { analyzeStep } from "../lib/structural.mjs";
import { listSteps, shortSha, walkCleanStretch } from "../lib/walk.mjs";

export const branchName = (upstreamSha) => `factory/upstream-sync/${upstreamSha}`;

export const NEXT_FLAGS = { boolean: ["json", "fetch"], number: ["maxSteps", "window"] };

/** Pure-ish core, exported for tests: returns the report object. */
export function computeNext(cwd, opts = {}) {
  const refs = resolveRefs(cwd, opts);
  const base = syncPoint(cwd, refs.master, refs.upstream);
  const maxSteps = opts.maxSteps ?? 50;
  const { total, steps } = listSteps(cwd, base, refs.upstream, opts.window ?? Math.max(maxSteps + 1, 200));

  const report = {
    kind: "up-to-date",
    base,
    master: refs.master,
    upstream: refs.upstream,
    behind: total,
    stretch: null,
    next: null,
    branch: null,
  };
  if (total === 0) return report;

  const walk = walkCleanStretch(cwd, { head: refs.master, master: refs.master, steps, maxSteps });
  if (walk.clean.length > 0) {
    const last = walk.clean[walk.clean.length - 1];
    // A walk that ran out of steps while upstream is still ahead stopped on the window or the step limit, not on the end.
    const stoppedBy = walk.stoppedBy === "end" && total > walk.clean.length ? "limit" : walk.stoppedBy;
    report.kind = "clean-stretch";
    report.branch = branchName(last.sha);
    report.stretch = {
      count: walk.clean.length,
      limitedBy: stoppedBy, // conflict | limit | end
      from: walk.clean[0].sha,
      to: last.sha,
      result: walk.tip,
      steps: walk.clean.map(({ sha, pr, subject, restoredLockfiles }) => ({ sha, pr, subject, restoredLockfiles })),
    };
  }

  if (walk.conflict) {
    const { step, files, tree } = walk.conflict;
    const { mechanical, real } = splitConflicts(files);
    // Fork edits are measured against fork master: the clean stretch ahead of this step is upstream code.
    const structure = analyzeStep(cwd, { step, base, head: refs.master, markerTree: tree, files });
    report.next = {
      sha: step.sha,
      pr: step.pr,
      subject: step.subject,
      files: [...mechanical, ...real],
      mechanicalOnly: real.length === 0,
      realFileCount: real.length,
      structural: structure,
      action: structure.structural ? "split-structural" : "start-conflict",
    };
    if (report.kind === "up-to-date") {
      report.kind = structure.structural ? "structural-conflict" : "conflict";
      report.branch = branchName(step.sha);
    }
  }
  return report;
}

export function formatNext(report) {
  const lines = [];
  lines.push(`sync point ${shortSha(report.base)}; upstream is ${report.behind} first-parent commit(s) ahead`);
  if (report.kind === "up-to-date") {
    lines.push("up to date: nothing to merge");
    return lines.join("\n");
  }
  if (report.stretch) {
    const s = report.stretch;
    lines.push(`clean stretch: ${s.count} commit(s), ${shortSha(s.from)}..${shortSha(s.to)} (stopped by ${s.limitedBy})`);
    for (const step of s.steps) lines.push(`  ${shortSha(step.sha)} ${step.pr ? `#${step.pr} ` : ""}${step.subject}`);
    lines.push(`  next action: merge-clean (branch ${report.branch})`);
  }
  if (report.next) {
    const n = report.next;
    lines.push(`${report.stretch ? "then " : ""}conflict at ${shortSha(n.sha)} ${n.pr ? `#${n.pr} ` : ""}${n.subject}`);
    for (const f of n.files) lines.push(`  ${f.kind === "real" ? "REAL" : `mech(${f.rule})`}  ${f.path}`);
    if (n.mechanicalOnly) lines.push("  every conflicted file is mechanical: start-conflict leaves nothing for the model");
    if (n.structural.structural) {
      lines.push("  STRUCTURAL STEP");
      for (const reason of n.structural.reasons) lines.push(`    - ${reason}`);
      lines.push(`    ${n.structural.guidance}`);
    } else {
      lines.push(`  next action: start-conflict ${n.sha}`);
    }
  }
  return lines.join("\n");
}

export async function run(argv, { cwd = process.cwd(), stdout = process.stdout } = {}) {
  const { opts } = parseArgs(argv, NEXT_FLAGS);
  const report = computeNext(cwd, opts);
  stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatNext(report)}\n`);
  return 0;
}
