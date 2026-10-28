import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = (mirror, args, opts = {}) =>
  run("git", ["--git-dir", mirror, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts }).then((r) => r.stdout);
const gitInput = (mirror, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["--git-dir", mirror, ...args],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin.end(input);
  });

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
// untrusted message text (unlike the old \x1e/\x1f delimiters).
const METADATA_FORMAT = "%H%x00%an%x00%cI%x00%B";

// Commits strictly after `marker` up to `tip`, oldest first, first-parent (upstream master order).
export async function listCommitsAfter(mirror, marker, tip, log = console.error) {
  const out = await git(mirror, [
    "log", "--first-parent", "--reverse", "-z", `--format=${METADATA_FORMAT}`, `${marker}..${tip}`,
  ]);
  const commits = parseLog(out, log);
  if (commits.length === 0) return commits;

  // File names are fetched separately so that a message containing NUL-adjacent
  // control bytes can never shift the file list into the wrong commit.
  try {
    const names = await gitInput(
      mirror,
      ["diff-tree", "--stdin", "-r", "-m", "--root", "--name-only", "-z", "--no-renames", "--format=\x1e%H"],
      `${commits.map((c) => c.sha).join("\n")}\n`,
    );
    const filesBySha = parseNameStream(names, new Set(commits.map((c) => c.sha)));
    for (const c of commits) c.files = filesBySha.get(c.sha) ?? c.files;
  } catch (e) {
    log(`upstreamGit: could not list changed files (${e.message}); continuing with empty file lists`);
  }
  return commits;
}

// NUL-delimited metadata stream -> commits. A malformed record is skipped with a
// warning; it must never throw out of an hourly run.
export function parseLog(out, log = console.error) {
  const tokens = out.split("\0");
  if (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();
  const commits = [];
  for (let i = 0; i < tokens.length; i += 4) {
    const [rawSha, author, committedAt, message = ""] = tokens.slice(i, i + 4);
    const sha = (rawSha ?? "").trim();
    if (!SHA_RE.test(sha) || author === undefined || committedAt === undefined || tokens.length - i < 4) {
      log(`upstreamGit: skipping malformed git log record near token ${i}`);
      continue;
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

// `diff-tree --stdin --format=\x1e%H --name-only -z` stream -> sha -> files.
// The stream is NUL tokens: a header token "\x1e<sha>", the literal "\n" that -z
// splits off the format, then one token per changed path (union across merge
// parents, since -m prints the header once per parent). Paths are NUL-delimited
// and cannot contain NUL, so only a header token can start a record — a token is
// treated as a header only when it names a commit in this batch, which keeps an
// odd file name from being mistaken for one.
export function parseNameStream(out, shas) {
  const filesBySha = new Map();
  let current = null;
  let afterHeader = false;
  for (const token of out.split("\0")) {
    if (token.startsWith("\x1e")) {
      const candidate = token.slice(1).trim();
      if (SHA_RE.test(candidate) && shas.has(candidate)) {
        current = candidate;
        if (!filesBySha.has(current)) filesBySha.set(current, new Set());
        afterHeader = true;
        continue;
      }
    }
    if (afterHeader && token === "\n") {
      afterHeader = false;
      continue;
    }
    afterHeader = false;
    if (current === null) continue;
    const name = token.trim();
    if (name) filesBySha.get(current).add(name);
  }
  const result = new Map();
  for (const [sha, files] of filesBySha) result.set(sha, [...files].sort());
  return result;
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
