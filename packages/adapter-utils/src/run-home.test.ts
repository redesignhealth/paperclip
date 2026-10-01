import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunHome, isRegisteredRunHome, sweepStaleRunHomes } from "./run-home.js";

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

describe("sweepStaleRunHomes (TECH-7095)", () => {
  it("removes stale Paperclip-prefixed directories and keeps fresh, live and unrelated ones", async () => {
    const stale = path.join(root, "paperclip-run-home-stale");
    const staleAi = path.join(root, "paperclip-ai-co-grant-stale");
    const fresh = path.join(root, "paperclip-run-home-fresh");
    const unrelated = path.join(root, "someone-elses-dir");
    for (const dir of [stale, staleAi, fresh, unrelated]) await mkdir(dir);
    const old = new Date(Date.now() - 3 * 3_600_000);
    for (const dir of [stale, staleAi, unrelated]) await utimes(dir, old, old);
    const live = await createRunHome({ root });
    await utimes(live.path, old, old);
    try {
      const result = await sweepStaleRunHomes({ root, maxAgeMs: 3_600_000 });
      expect(result.removed).toBe(2);
      await expect(stat(stale)).rejects.toThrow();
      await expect(stat(staleAi)).rejects.toThrow();
      await expect(stat(fresh)).resolves.toBeTruthy();
      await expect(stat(unrelated)).resolves.toBeTruthy();
      await expect(stat(live.path)).resolves.toBeTruthy();
    } finally {
      await live.cleanup();
    }
  });

  it("does not follow or remove a non-directory with a Paperclip prefix", async () => {
    const file = path.join(root, "paperclip-run-home-file");
    await writeFile(file, "x");
    const old = new Date(Date.now() - 3 * 3_600_000);
    await utimes(file, old, old);
    expect((await sweepStaleRunHomes({ root, maxAgeMs: 1000 })).removed).toBe(0);
    await expect(stat(file)).resolves.toBeTruthy();
  });

  it("tolerates a missing root", async () => {
    expect(await sweepStaleRunHomes({ root: path.join(root, "nope"), maxAgeMs: 1 })).toEqual({ removed: 0 });
  });
});
