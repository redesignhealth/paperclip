// Condition 2 of the sync go decision (TECH-9825): a module extraction such as `tool-access.ts` is a large
// structural step. Git cannot follow code that moved across files, so each such step costs more than the last
// (338, 728, 1,752, then about 3,900 lines of resolution diff in the trial). `next` detects one and says so, so
// the planner lands it as its own stacked, split PRs instead of one model step.
import { git, gitOut } from "./git.mjs";
import { isMechanicalPath } from "./mechanical.mjs";

export const DEFAULT_THRESHOLDS = {
  // Lines inside conflict markers across the real conflicted files of the marker tree.
  markerLines: 800,
  // An extraction: new files carry this many added lines while one existing file loses this many...
  extractionAddedLines: 300,
  extractionRemovedLines: 300,
  // ...and the fork has edited that file by at least this many lines since the sync point.
  forkEditLines: 50,
};

/** Count lines that sit inside `<<<<<<<` ... `>>>>>>>` blocks of a text blob. */
export function countMarkerLines(text) {
  let inside = false;
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("<<<<<<< ")) {
      inside = true;
      count++;
    } else if (inside) {
      count++;
      if (line.startsWith(">>>>>>> ")) inside = false;
    }
  }
  return count;
}

function numstat(cwd, args) {
  const rows = new Map();
  const raw = gitOut(cwd, ["diff", "--numstat", "-z", "--no-renames", ...args], { allowFail: true });
  for (const line of raw.split("\0")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (m) rows.set(m[3], { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return rows;
}

/**
 * Decide whether one conflicting upstream step is structural.
 * `markerTree` is the tree `merge-tree` wrote for the step (conflict markers inside the blobs); `base` is the sync
 * point and `head` the fork side of the merge.
 */
export function analyzeStep(cwd, { step, base, head, markerTree, files, thresholds = {} }) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const realFiles = files.filter((f) => !isMechanicalPath(f));

  let markerLines = 0;
  for (const file of realFiles) {
    const blob = git(cwd, ["cat-file", "-p", `${markerTree}:${file}`], { allowFail: true });
    if (blob.status === 0) markerLines += countMarkerLines(blob.stdout);
  }

  // What the upstream step itself changed: new files, and existing files that shrank.
  const parent = `${step.sha}^1`;
  const stepStat = numstat(cwd, [parent, step.sha]);
  const created = new Set(
    gitOut(cwd, ["diff", "--diff-filter=A", "--name-only", "-z", parent, step.sha], { allowFail: true })
      .split("\0")
      .filter(Boolean),
  );
  const newFiles = [...created].filter((f) => !isMechanicalPath(f));
  const addedInNew = newFiles.reduce((sum, f) => sum + (stepStat.get(f)?.added ?? 0), 0);
  const forkStat = numstat(cwd, [base, head]);

  const extractions = [];
  if (addedInNew >= t.extractionAddedLines) {
    for (const [file, row] of stepStat) {
      if (created.has(file) || isMechanicalPath(file)) continue;
      if (row.removed < t.extractionRemovedLines) continue;
      const fork = forkStat.get(file);
      const forkEditLines = fork ? fork.added + fork.removed : 0;
      if (forkEditLines < t.forkEditLines) continue;
      extractions.push({
        file,
        removedLines: row.removed,
        forkEditLines,
        newFiles: newFiles.slice(0, 20),
        addedInNewFiles: addedInNew,
      });
    }
  }

  const reasons = [];
  if (extractions.length > 0) {
    reasons.push(
      `module extraction: ${extractions.map((e) => e.file).join(", ")} lost code that now lives in ${newFiles.length} new file(s), and the fork has edited it`,
    );
  }
  if (markerLines >= t.markerLines) {
    reasons.push(`${markerLines} lines inside conflict markers (limit ${t.markerLines} for a single model step)`);
  }
  const structural = reasons.length > 0;
  return {
    structural,
    reasons,
    markerLines,
    extractions,
    guidance: structural
      ? "Large structural step. Land it as its own stacked, split PRs. Do not resolve it together with other steps. Expect its resolution diff to approach or exceed one Argus review."
      : null,
  };
}
