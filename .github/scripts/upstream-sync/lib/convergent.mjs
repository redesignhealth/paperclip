// The trial's hidden failure: steps 3 and 10 merged clean but were wrong. Both sides bumped the same test count
// from N to N+1, git saw identical edits and merged them to N+1, and the right answer was N+2. A text merge cannot
// see this, so find it: hunks that both sides made identically and that only change numbers.
import { git, gitOut } from "./git.mjs";

const NUMBER_RE = /\d+(?:\.\d+)?/g;

/** Parse `git diff -U0` output into hunks of { removed: string[], added: string[], newStart }. */
export function parseHunks(diffText) {
  const hunks = [];
  let current = null;
  for (const line of diffText.split("\n")) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      current = { removed: [], added: [], newStart: Number(header[1]) };
      hunks.push(current);
    } else if (current && line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
    else if (current && line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
  }
  return hunks;
}

const numbers = (lines) => lines.join("\n").match(NUMBER_RE) ?? [];
const stripNumbers = (lines) => lines.join("\n").replace(NUMBER_RE, "#");

/** A hunk that changes only numbers (same text once digits are blanked, different digits). */
export function isNumericBump(hunk) {
  if (hunk.removed.length === 0 || hunk.added.length === 0) return false;
  if (stripNumbers(hunk.removed) !== stripNumbers(hunk.added)) return false;
  return numbers(hunk.removed).join(",") !== numbers(hunk.added).join(",");
}

const key = (h) => `${h.removed.join("\n")}\u0000${h.added.join("\n")}`;

/** For one merge commit, list files where both sides made the same numeric edit. */
export function convergentNumericEdits(cwd, mergeCommit) {
  const parents = gitOut(cwd, ["rev-list", "--parents", "-n", "1", mergeCommit]).split(" ").slice(1);
  if (parents.length !== 2) return [];
  const [ours, theirs] = parents;
  const base = gitOut(cwd, ["merge-base", ours, theirs], { allowFail: true });
  if (!base) return [];
  const sideFiles = (side) =>
    new Set(gitOut(cwd, ["diff", "--name-only", "-z", base, side], { allowFail: true }).split("\0").filter(Boolean));
  const theirsFiles = sideFiles(theirs);
  const both = [...sideFiles(ours)].filter((f) => theirsFiles.has(f));
  const found = [];
  for (const file of both) {
    const diffOf = (side) =>
      git(cwd, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", base, side, "--", file], { allowFail: true })
        .stdout;
    const oursHunks = parseHunks(diffOf(ours)).filter(isNumericBump);
    if (oursHunks.length === 0) continue;
    const theirKeys = new Set(parseHunks(diffOf(theirs)).filter(isNumericBump).map(key));
    for (const h of oursHunks) {
      if (theirKeys.has(key(h))) {
        found.push({ file, line: h.newStart, from: h.removed.join("\n").trim(), to: h.added.join("\n").trim(), merge: mergeCommit });
      }
    }
  }
  return found;
}
