// Thin git/gh helpers for the upstream-sync scripts. Node built-ins only: a builder pod can run these with no
// package install. Git is the only state; nothing here reads or writes a database.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

// Nothing to change in the environment: the digest is pinned by `-c` flags, which beat every config file. The global
// and system config must stay readable, because that is where `safe.directory` lives on a pod or a CI runner.
export const PINNED_ENV = undefined;

export class GitError extends Error {
  constructor(args, result) {
    super(`git ${args.join(" ")} failed (${result.status}): ${String(result.stderr).trim()}`);
    this.name = "GitError";
    this.status = result.status;
    this.stderr = result.stderr;
  }
}

/** Run git in `cwd`. Returns { stdout, stderr, status }. Throws GitError on a non-zero exit unless allowFail. */
export function git(cwd, args, { input, allowFail = false, env } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) throw new GitError(args, result);
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

export const gitOut = (cwd, args, opts) => git(cwd, args, opts).stdout.trim();

export function revParse(cwd, rev) {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function blobAt(cwd, rev, path) {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}:${path}`], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function isWorkingTreeClean(cwd) {
  return gitOut(cwd, ["status", "--porcelain", "--untracked-files=no"]) === "";
}

/**
 * Resolve the two refs every command works from. Options win over the environment, which wins over the default.
 * `fetch` (default true) fetches both remotes' branches first so the sync point is current.
 */
export function resolveRefs(cwd, opts = {}) {
  const masterRef = opts.master || process.env.UPSTREAM_SYNC_MASTER_REF || "origin/master";
  const upstreamRef = opts.upstream || process.env.UPSTREAM_SYNC_UPSTREAM_REF || "upstream/master";
  if (opts.fetch !== false) {
    for (const ref of [masterRef, upstreamRef]) {
      const slash = ref.indexOf("/");
      if (slash < 0) continue;
      const remote = ref.slice(0, slash);
      const branch = ref.slice(slash + 1);
      const known = git(cwd, ["remote"]).stdout.split("\n").includes(remote);
      if (!known) throw new Error(`git remote "${remote}" is not configured (needed to fetch ${ref})`);
      git(cwd, ["fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    }
  }
  const master = revParse(cwd, masterRef);
  const upstream = revParse(cwd, upstreamRef);
  if (!master) throw new Error(`cannot resolve ${masterRef}`);
  if (!upstream) throw new Error(`cannot resolve ${upstreamRef}`);
  return { masterRef, upstreamRef, master, upstream };
}

/** The sync point is the merge-base of fork master and upstream master. */
export function syncPoint(cwd, master, upstream) {
  const base = gitOut(cwd, ["merge-base", master, upstream], { allowFail: true });
  if (!base) throw new Error("fork master and upstream master share no history");
  return base;
}

/**
 * `git merge-tree --write-tree` of two commits without touching the work tree or index. A conflicted merge still
 * yields a tree (conflict markers inside the blobs), which is the "marker tree" the resolution diff is measured from.
 */
export function mergeTree(cwd, ours, theirs, { pin = false } = {}) {
  // `pin` fixes the merge settings that change the marker tree, so every machine builds the same one.
  const config = pin
    ? ["-c", "merge.conflictStyle=merge", "-c", "merge.renormalize=false", "-c", "merge.renames=true", "-c", "diff.algorithm=default", "-c", "diff.renames=true"]
    : [];
  const r = git(cwd, [...config, "merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", ours, theirs], {
    allowFail: true,
    env: pin ? PINNED_ENV : undefined,
  });
  if (r.status !== 0 && r.status !== 1) {
    throw new GitError(["merge-tree", ours, theirs], r);
  }
  const parts = r.stdout.split("\0");
  const tree = parts.shift();
  const files = [];
  for (const part of parts) {
    if (part === "") break;
    if (!files.includes(part)) files.push(part);
  }
  return { tree, clean: r.status === 0, files };
}

/** `date` (ISO) pins author and committer time, so the same merge always yields the same commit id. */
export function commitTree(cwd, tree, parents, message, { date } = {}) {
  const args = ["commit-tree", tree];
  for (const p of parents) args.push("-p", p);
  return gitOut(cwd, args, {
    input: message,
    env: {
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "upstream-sync",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "upstream-sync@localhost",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "upstream-sync",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "upstream-sync@localhost",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

/** Replace blobs in a tree via a throwaway index. `changes` maps path -> blob sha (or null to remove the path). */
export function patchTree(cwd, tree, changes) {
  const entries = Object.entries(changes);
  if (entries.length === 0) return tree;
  const gitDir = resolve(cwd, gitOut(cwd, ["rev-parse", "--git-dir"]));
  const indexFile = resolve(gitDir, `upstream-sync-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    git(cwd, ["read-tree", tree], { env });
    for (const [path, blob] of entries) {
      if (blob === null) git(cwd, ["update-index", "--force-remove", "--", path], { env });
      else git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
    return gitOut(cwd, ["write-tree"], { env });
  } finally {
    rmSync(indexFile, { force: true });
  }
}
