// Walk upstream's first-parent history forward from the sync point, one upstream PR per step.
import { commitTree, gitOut, mergeTree } from "./git.mjs";
import { onlyLockfileConflicts, restoreLockfiles } from "./mechanical.mjs";

/** Upstream first-parent commits after the sync point, oldest first. `limit` keeps the oldest N. */
export function listSteps(cwd, base, upstream, limit = Infinity) {
  const shas = gitOut(cwd, ["rev-list", "--first-parent", "--reverse", upstream, `^${base}`])
    .split("\n")
    .filter(Boolean);
  const total = shas.length;
  const wanted = Number.isFinite(limit) ? shas.slice(0, limit) : shas;
  const steps = wanted.map((sha) => {
    const subject = gitOut(cwd, ["log", "-1", "--format=%s", sha]);
    const pr = subject.match(/\(#(\d+)\)\s*$/);
    return { sha, subject, pr: pr ? Number(pr[1]) : null };
  });
  return { total, steps };
}

export const shortSha = (sha) => sha.slice(0, 10);

/**
 * Merge upstream steps into `head` in memory (commit objects only; the work tree is untouched) until one
 * conflicts for real or `maxSteps` is reached. A step whose only conflicts are lockfiles settles to master's lockfile.
 */
export function walkCleanStretch(cwd, { head, master, steps, maxSteps = Infinity }) {
  let tip = head;
  const clean = [];
  for (const step of steps) {
    if (clean.length >= maxSteps) return { clean, tip, stoppedBy: "limit", conflict: null };
    const merged = mergeTree(cwd, tip, step.sha);
    if (!merged.clean && !onlyLockfileConflicts(merged.files)) {
      return { clean, tip, stoppedBy: "conflict", conflict: { step, files: merged.files, tree: merged.tree } };
    }
    const { tree, restored } = restoreLockfiles(cwd, merged.tree, master);
    tip = commitTree(cwd, tree, [tip, step.sha], mergeMessage(step));
    clean.push({ ...step, merge: tip, restoredLockfiles: restored });
  }
  return { clean, tip, stoppedBy: "end", conflict: null };
}

export function mergeMessage(step) {
  return `Merge upstream ${shortSha(step.sha)}: ${step.subject}\n\nUpstream commit ${step.sha}\n`;
}

