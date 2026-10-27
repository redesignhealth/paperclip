import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = (mirror, args, opts = {}) =>
  run("git", ["--git-dir", mirror, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts }).then((r) => r.stdout);

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

const RS = "\x1e";
const US = "\x1f";

// Commits strictly after `marker` up to `tip`, oldest first, first-parent (upstream master order).
export async function listCommitsAfter(mirror, marker, tip) {
  const fmt = `${RS}%H${US}%an${US}%cI${US}%B${US}`;
  const out = await git(mirror, [
    "log", "--first-parent", "--reverse", "-m", "--name-only", "--no-renames",
    `--format=${fmt}`, `${marker}..${tip}`,
  ]);
  return parseLog(out);
}

export function parseLog(out) {
  const commits = [];
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const [sha, author, committedAt, message, filesBlock = ""] = rec.split(US);
    const files = [...new Set(filesBlock.split("\n").map((l) => l.trim()).filter(Boolean))].sort();
    const [title, ...rest] = message.trim().split("\n");
    commits.push({
      sha: sha.trim(),
      author,
      mergedAt: committedAt,
      title: title.trim(),
      body: rest.join("\n").trim(),
      files,
      pr: extractPr(title),
      revertsSha: extractRevertSha(message),
    });
  }
  return commits;
}

export function extractPr(title) {
  const m = title.match(/\(#(\d+)\)\s*$/) || title.match(/^Merge pull request #(\d+)\b/);
  return m ? Number.parseInt(m[1], 10) : null;
}

export function extractRevertSha(message) {
  const m = message.match(/This reverts commit ([0-9a-f]{40})/);
  return m ? m[1] : null;
}
