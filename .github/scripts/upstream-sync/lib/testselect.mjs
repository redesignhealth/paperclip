// Pick the tests `check` runs after a step: every test file the step changed, the sibling test of every source file
// it changed, and the tests that mention a file where both sides made the same numeric edit.
import { gitOut, git } from "./git.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_RE = /\.[cm]?[jt]sx?$/;

export function siblingTests(path) {
  const m = path.match(/^(.*)\.([cm]?[jt]sx?)$/);
  if (!m || TEST_FILE_RE.test(path)) return [];
  return [`${m[1]}.test.${m[2]}`, `${m[1]}.spec.${m[2]}`];
}

/** Tracked test files that mention a module's base name (word match), capped so a hub file cannot select the repo. */
export function testsMentioning(cwd, file, cap = 40) {
  const base = file.replace(/^.*\//, "").replace(/\.[cm]?[jt]sx?$/, "");
  if (base.length < 4) return [];
  const r = git(cwd, ["grep", "-l", "-w", "--fixed-strings", base, "--", "*.test.*", "*.spec.*"], { allowFail: true });
  return r.stdout.split("\n").filter(Boolean).slice(0, cap);
}

/** `changed` is a list of repo-relative paths; `convergent` the files from convergentNumericEdits. */
export function selectTests(cwd, changed, convergent = []) {
  const selected = new Set();
  for (const path of changed) {
    if (TEST_FILE_RE.test(path)) selected.add(path);
    else if (SOURCE_RE.test(path)) for (const s of siblingTests(path)) selected.add(s);
  }
  for (const c of convergent) {
    if (TEST_FILE_RE.test(c.file)) selected.add(c.file);
    else {
      for (const s of siblingTests(c.file)) selected.add(s);
      for (const t of testsMentioning(cwd, c.file)) selected.add(t);
    }
  }
  const existing = [...selected].filter((p) => existsSync(join(cwd, p))).sort();
  const nodeTest = [];
  const vitest = [];
  for (const p of existing) {
    let text = "";
    try {
      text = readFileSync(join(cwd, p), "utf8");
    } catch {
      /* unreadable: leave to vitest */
    }
    (/from ['"]node:test['"]|require\(['"]node:test['"]\)/.test(text) ? nodeTest : vitest).push(p);
  }
  return { nodeTest, vitest };
}

/** Files the step changed: for a merge commit, the diff from its fork-side parent; otherwise from `since`. */
export function changedInStep(cwd, head, since) {
  const parent = since ?? `${head}^1`;
  return gitOut(cwd, ["diff", "--name-only", "-z", "--no-renames", parent, head], { allowFail: true })
    .split("\0")
    .filter(Boolean);
}
