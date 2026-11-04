// A small git repository modelling upstream + the fork, for handle.mjs tests.
//
//   upstream chain:  U0 -> U1 (b.txt) -> U2 (c.txt) -> U3 (a.txt line 1) -> U4 (e.txt added)
//   fork:            base + U0 merged, plus F1 (a.txt line 1) and F2 (e.txt added) on master;
//                    `integration` starts at master.
//   So U1, U2 merge cleanly, U3 conflicts with F1 in a.txt, U4 conflicts with F2 (add/add).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-fx-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  const write = (file, content) => fs.writeFileSync(path.join(dir, file), content);
  const commit = (msg) => { git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };

  git("init", "-q", "-b", "master");
  write("a.txt", "first\nsecond\nthird\n");
  write("b.txt", "b1\nb2\nb3\n");
  write("c.txt", "c1\nc2\nc3\n");
  const base = commit("base");

  git("checkout", "-q", "-b", "upstream");
  write("d.txt", "d\n");
  const U0 = commit("U0");
  write("b.txt", "b1\nb2 upstream\nb3\n");
  const U1 = commit("U1");
  write("c.txt", "c1\nc2 upstream\nc3\n");
  const U2 = commit("U2");
  write("a.txt", "upstream first\nsecond\nthird\n");
  const U3 = commit("U3");
  write("e.txt", "upstream e\n");
  const U4 = commit("U4");

  git("checkout", "-q", "master");
  git("merge", "-q", "--no-ff", "-m", "merge U0", U0);
  write("a.txt", "fork first\nsecond\nthird\n");
  commit("F1");
  write("e.txt", "fork e\n");
  commit("F2");
  git("branch", "integration");
  const integration = git("rev-parse", "integration");

  return {
    dir, base, U0, U1, U2, U3, U4, integration, git,
    // Real merge of `sha` into `branch` (must be clean); returns the merge commit.
    merge(branch, sha) {
      git("checkout", "-q", branch);
      git("merge", "-q", "--no-ff", "-m", `merge ${sha.slice(0, 7)}`, sha);
      return git("rev-parse", "HEAD");
    },
    // Merge `sha` into `branch`, expecting conflicts; write `files` as the resolution.
    mergeResolved(branch, sha, files) {
      git("checkout", "-q", branch);
      try { git("merge", "--no-ff", "-m", `resolve ${sha.slice(0, 7)}`, sha); } catch { /* conflicts expected */ }
      for (const [f, content] of Object.entries(files)) write(f, content);
      git("add", "-A");
      git("commit", "-q", "--no-edit");
      return git("rev-parse", "HEAD");
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
