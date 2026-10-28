import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = (mirror, args, opts = {}) =>
  run("git", ["--git-dir", mirror, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts }).then((r) => r.stdout);

// git with a piped stdin. Exported so the early-exit path can be tested.
export function gitInput(mirror, args, input) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const child = execFile(
      "git",
      ["--git-dir", mirror, ...args],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return fail(err);
        settled = true;
        resolve(stdout);
      },
    );
    // git can exit before it has drained stdin (bad revision, early fatal).
    // An unhandled stdin 'error' would crash the process, so handle it here.
    // EPIPE is the expected consequence of that early exit: ignore it and let
    // the execFile callback reject with git's own, more useful error. Any other
    // stream error is a real failure and rejects on its own.
    child.stdin.on("error", (e) => {
      if (e.code !== "EPIPE") fail(e);
    });
    child.stdin.end(input);
  });
}

export async function ensureMirror(cfg) {
  if (!fs.existsSync(path.join(cfg.mirrorDir, "HEAD"))) {
    fs.mkdirSync(cfg.mirrorDir, { recursive: true });
    await run("git", ["init", "--bare", cfg.mirrorDir]);
    await git(cfg.mirrorDir, ["remote", "add", "origin", cfg.upstreamRepo]);
  } else {
    await git(cfg.mirrorDir, ["remote", "set-url", "origin", cfg.upstreamRepo]);
  }
  // Blobless: we only need commits + trees (file names), not file contents.
  await git(cfg.mirrorDir, [
    "fetch", "--no-tags", "--filter=blob:none", "origin",
    `+refs/heads/${cfg.upstreamBranch}:refs/upstream/${cfg.upstreamBranch}`,
  ]);
  return `refs/upstream/${cfg.upstreamBranch}`;
}

export async function resolveCommit(mirror, rev) {
  try {
    return (await git(mirror, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
  } catch {
    return null;
  }
}

export async function isAncestor(mirror, a, b) {
  try {
    await git(mirror, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

const SHA_RE = /^[0-9a-f]{40}$/;

// Metadata is fetched with NUL separators: a git commit message can contain any
// byte except NUL, so "%x00"-framed records cannot be forged or broken by
// untrusted message text (unlike the old \x1e/\x1f delimiters). A message that
// does move a record boundary produces a structurally invalid record, which
// parseLog now rejects by throwing rather than skipping.
const METADATA_FORMAT = "%H%x00%an%x00%cI%x00%B";

// Commits strictly after `marker` up to `tip`, oldest first, first-parent (upstream master order).
//
// `deps.diffTree(mirror, sha)` is injectable so the failure path can be tested.
//
// Fail closed: if the changed-file list cannot be read this throws. The caller
// inserts rows only after this returns, and the marker does not advance, so the
// next hourly run retries the same range. We must NOT fall back to empty file
// lists: rows are inserted with ON CONFLICT DO NOTHING, so a row stored with
// empty fork-owned / migration flags would never be corrected and the safety
// detection for that commit would be permanently suppressed.
export async function listCommitsAfter(mirror, marker, tip, log = console.error, deps = {}) {
  const diffTree = deps.diffTree ?? defaultDiffTree;
  const out = await git(mirror, [
    "log", "--first-parent", "--reverse", "-z", `--format=${METADATA_FORMAT}`, `${marker}..${tip}`,
  ]);
  const commits = parseLog(out, log);
  if (commits.length === 0) return commits;

  // The changed-file list is fetched one commit at a time, out of band from the
  // metadata stream, so neither a crafted message nor a crafted path can shift
  // a file list onto the wrong commit (see defaultDiffTree).
  for (const c of commits) {
    try {
      c.files = await diffTree(mirror, c.sha);
    } catch (e) {
      throw new Error(`upstreamGit: could not list changed files for ${commits.length} commit(s) at ${c.sha}: ${e.message}`, { cause: e });
    }
  }
  return commits;
}

// One `diff-tree` per commit, with `--no-commit-id`. That matters twice over:
//
//  * Attribution is out of band. The only thing tying this output to `sha` is
//    which child process produced it, so no in-band token can forge a header.
//    The previous `--stdin --format=\x1e%H` stream embedded the sha in the data
//    and had to guess which tokens were headers; a tracked file literally named
//    "\x1e<40-hex>" could re-attribute the files that followed it and suppress
//    its own fork-owned/migration flag.
//  * `--diff-merges=first-parent` diffs a merge against its first parent only.
//    `-m` prints one diff per parent, so a merge's 2nd-parent diff (everything
//    since the branch point) leaked into the file list and raised false
//    fork-owned / migration / infra flags. Needs git >= 2.31.
const defaultDiffTree = async (mirror, sha) => {
  const out = await git(mirror, [
    "diff-tree", "--no-commit-id", "-r", "--root", "--name-only", "-z", "--no-renames",
    "--diff-merges=first-parent", sha,
  ]);
  return parseNameList(out);
};

// NUL-terminated path list -> sorted unique paths. With -z a path is raw bytes:
// the only safe check is emptiness (a path can never be empty). Never trim, or a
// path with leading/trailing whitespace is silently rewritten and stops matching
// FORK_OWNED.md.
export function parseNameList(out) {
  const names = new Set();
  for (const token of out.split("\0")) {
    if (token !== "") names.add(token);
  }
  return [...names].sort();
}

// NUL-delimited metadata stream -> commits. A malformed record throws: the marker
// only moves forward via `marker set`, so skipping a record would silently drop a
// commit (possibly a security fix) from the ledger forever. Throwing fails the run
// before anything is inserted, and the next run retries the same range; an operator
// can step over a genuinely bad range deliberately with `marker set`.
export function parseLog(out, log = console.error) {
  const tokens = out.split("\0");
  if (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();
  const commits = [];
  for (let i = 0; i < tokens.length; i += 4) {
    const [rawSha, author, committedAt, message = ""] = tokens.slice(i, i + 4);
    const sha = rawSha ?? "";
    if (!SHA_RE.test(sha) || author === undefined || committedAt === undefined || tokens.length - i < 4) {
      const near = String(rawSha ?? "").slice(0, 60).replace(/[^\x20-\x7e]/g, "?");
      const msg = `upstreamGit: malformed git log record at token ${i} (sha=${JSON.stringify(near)}); refusing to continue`;
      log(msg);
      throw new Error(msg);
    }
    const lines = message.trim().split("\n");
    const title = (lines.shift() ?? "").trim();
    commits.push({
      sha,
      author,
      mergedAt: committedAt,
      title,
      body: lines.join("\n").trim(),
      files: [],
      pr: extractPr(title),
      revertsSha: extractRevertSha(message),
    });
  }
  return commits;
}

export function extractPr(title) {
  const m = title.match(/\(#(\d+)\)\s*$/) || title.match(/^Merge pull request #(\d+)\b/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  // upstream_pr is a Postgres integer; anything outside int32 would fail the insert.
  return Number.isSafeInteger(n) && n >= 1 && n <= 2147483647 ? n : null;
}

export function extractRevertSha(message) {
  const m = message.match(/This reverts commit ([0-9a-f]{40})/);
  return m ? m[1] : null;
}
