// Text-only git fixtures for the upstream-sync tests: a throwaway repo whose `origin/master` and `upstream/master`
// remote-tracking refs point at a fork line and an upstream line that share a base commit. No network, no binaries.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class Fixture {
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "upstream-sync-test-"));
    this.git("init", "-q", "-b", "master");
    this.git("config", "user.name", "Test");
    this.git("config", "user.email", "test@example.com");
    this.git("config", "commit.gpgsign", "false");
    this.git("config", "merge.conflictStyle", "merge");
  }

  git(...args) {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
  }

  write(path, content) {
    const abs = join(this.dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  read(path) {
    return readFileSync(join(this.dir, path), "utf8");
  }

  exists(path) {
    return existsSync(join(this.dir, path));
  }

  /** Write `files` (path -> content, null deletes) and commit on the current branch. Returns the sha. */
  commit(files, message) {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) this.git("rm", "-q", "-f", path);
      else {
        this.write(path, content);
        this.git("add", path);
      }
    }
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  /** Build base -> fork line (origin/master) and base -> upstream line (upstream/master). */
  static scenario({ base, fork = [], upstream = [] }) {
    const f = new Fixture();
    f.commit(base, "base");
    const baseSha = f.git("rev-parse", "HEAD");
    f.git("checkout", "-q", "-b", "upstream");
    const upstreamShas = upstream.map(([files, message]) => f.commit(files, message));
    f.git("checkout", "-q", "master");
    const forkShas = fork.map(([files, message]) => f.commit(files, message));
    f.git("update-ref", "refs/remotes/origin/master", f.git("rev-parse", "master"));
    f.git("update-ref", "refs/remotes/upstream/master", f.git("rev-parse", "upstream"));
    return { fx: f, baseSha, upstreamShas, forkShas };
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export const lines = (n, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
