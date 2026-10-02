import { mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUN_HOME_MARKER, createRunHome, isRegisteredRunHome, sweepStaleRunHomes } from "./run-home.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tech7095-run-home-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createRunHome (TECH-7095)", () => {
  it("creates an owner-only tree and binds HOME/XDG/TMPDIR inside it", async () => {
    const home = await createRunHome({ root });
    try {
      expect(path.dirname(home.path)).toBe(root);
      expect((await stat(home.path)).mode & 0o777).toBe(0o700);
      for (const dir of ["config", "data", "cache", "state", "tmp", "runtime", "provider"]) {
        expect((await stat(path.join(home.path, dir))).mode & 0o777, dir).toBe(0o700);
      }
      for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) {
        expect(home.env[key].startsWith(home.path), key).toBe(true);
      }
      expect(home.providerDir).toBe(path.join(home.path, "provider"));
      expect(isRegisteredRunHome(home.path)).toBe(true);
      expect(isRegisteredRunHome(path.join(home.path, "config"))).toBe(true);
      expect(isRegisteredRunHome(os.homedir())).toBe(false);
      expect(isRegisteredRunHome(undefined)).toBe(false);
    } finally {
      await home.cleanup();
    }
  });

  it("never maps any variable to the server user's home", async () => {
    const home = await createRunHome({ root });
    try {
      for (const value of Object.values(home.env)) expect(value.startsWith(os.homedir() + path.sep) && !value.startsWith(root)).toBe(false);
    } finally {
      await home.cleanup();
    }
  });

  it("cleanup removes the tree, is idempotent, and deregisters", async () => {
    const home = await createRunHome({ root });
    await writeFile(path.join(home.providerDir, "auth.json"), "tech7095-sentinel");
    await home.cleanup();
    await home.cleanup();
    await expect(stat(home.path)).rejects.toThrow();
    expect(isRegisteredRunHome(home.path)).toBe(false);
  });

  it("cleanup still runs when the run failed (caller uses finally)", async () => {
    const home = await createRunHome({ root });
    await expect(
      (async () => {
        try {
          throw new Error("run failed");
        } finally {
          await home.cleanup();
        }
      })(),
    ).rejects.toThrow("run failed");
    await expect(stat(home.path)).rejects.toThrow();
  });
});

describe("run home remote env (TECH-7095)", () => {
  it("remoteEnv carries only HOME and XDG config/data (no controller-local temp/cache/runtime paths)", async () => {
    const home = await createRunHome({ root });
    try {
      expect(Object.keys(home.remoteEnv).sort()).toEqual(["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]);
      expect(home.remoteEnv.HOME).toBe(home.env.HOME);
    } finally {
      await home.cleanup();
    }
  });
});

describe("sweepStaleRunHomes (TECH-7095)", () => {
  const UUID_A = "11111111-2222-4333-8444-555555555555";
  const UUID_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
  const old = () => new Date(Date.now() - 3 * 3_600_000);

  async function markedRunHome(name: string, when: Date) {
    const dir = path.join(root, name);
    await mkdir(dir);
    const marker = path.join(dir, RUN_HOME_MARKER);
    await writeFile(marker, "");
    await utimes(marker, when, when);
    await utimes(dir, when, when);
    return dir;
  }

  it("removes stale marked run homes and managed AI homes, keeps fresh, live, unmarked and unrelated ones", async () => {
    const stale = await markedRunHome("paperclip-run-home-stale", old());
    const fresh = await markedRunHome("paperclip-run-home-fresh", new Date());
    const staleAi = path.join(root, `paperclip-ai-${UUID_A}-${UUID_B}-abc123`);
    await mkdir(staleAi);
    await utimes(staleAi, old(), old());
    const unmarkedCollision = path.join(root, "paperclip-run-home-123-scratch");
    await mkdir(unmarkedCollision);
    await utimes(unmarkedCollision, old(), old());
    const lookalikeAi = path.join(root, "paperclip-ai-company-grant-stale");
    await mkdir(lookalikeAi);
    await utimes(lookalikeAi, old(), old());
    const unrelated = path.join(root, "someone-elses-dir");
    await mkdir(unrelated);
    await utimes(unrelated, old(), old());
    const live = await createRunHome({ root });
    await utimes(path.join(live.path, RUN_HOME_MARKER), old(), old());
    try {
      const result = await sweepStaleRunHomes({ root, maxAgeMs: 3_600_000 });
      expect(result.removed).toBe(2);
      await expect(stat(stale)).rejects.toThrow();
      await expect(stat(staleAi)).rejects.toThrow();
      for (const kept of [fresh, unmarkedCollision, lookalikeAi, unrelated, live.path]) {
        await expect(stat(kept), kept).resolves.toBeTruthy();
      }
    } finally {
      await live.cleanup();
    }
  });

  it("measures age from the marker, not the directory mtime", async () => {
    const dir = await markedRunHome("paperclip-run-home-active", old());
    await utimes(dir, new Date(), new Date());
    expect((await sweepStaleRunHomes({ root, maxAgeMs: 3_600_000 })).removed).toBe(1);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("never follows a symlink with a Paperclip-looking name", async () => {
    const target = path.join(root, "real-target");
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "x");
    const link = path.join(root, "paperclip-run-home-link");
    await symlink(target, link);
    expect((await sweepStaleRunHomes({ root, maxAgeMs: 0 })).removed).toBe(0);
    await expect(stat(path.join(target, "keep.txt"))).resolves.toBeTruthy();
  });

  it("does not remove a non-directory with a Paperclip prefix", async () => {
    const file = path.join(root, "paperclip-run-home-file");
    await writeFile(file, "x");
    await utimes(file, old(), old());
    expect((await sweepStaleRunHomes({ root, maxAgeMs: 1000 })).removed).toBe(0);
    await expect(stat(file)).resolves.toBeTruthy();
  });

  it("tolerates a missing root", async () => {
    expect(await sweepStaleRunHomes({ root: path.join(root, "nope"), maxAgeMs: 1 })).toEqual({ removed: 0 });
  });
});
