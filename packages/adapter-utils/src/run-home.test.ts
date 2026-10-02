import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunHome } from "./run-home.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tech7102-run-home-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createRunHome (TECH-7102)", () => {
  it("creates an owner-only tree and binds HOME/XDG/TMPDIR inside it", async () => {
    const home = await createRunHome({ root });
    try {
      expect(path.dirname(home.path)).toBe(root);
      expect((await stat(home.path)).mode & 0o777).toBe(0o700);
      for (const dir of ["config", "data", "cache", "state", "tmp", "runtime"]) {
        expect((await stat(path.join(home.path, dir))).mode & 0o777, dir).toBe(0o700);
      }
      for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) {
        expect(home.env[key].startsWith(home.path), key).toBe(true);
      }
    } finally {
      await home.cleanup();
    }
  });

  it("never maps a variable to the server user's home", async () => {
    const home = await createRunHome({ root });
    try {
      for (const value of Object.values(home.env)) expect(value.startsWith(root)).toBe(true);
    } finally {
      await home.cleanup();
    }
  });

  it("cleanup removes the tree including written files, and is idempotent", async () => {
    const home = await createRunHome({ root });
    await writeFile(path.join(home.path, "config", ".env"), "tech7102-sentinel");
    await home.cleanup();
    await home.cleanup();
    await expect(stat(home.path)).rejects.toThrow();
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

  it("also points XDG_CONFIG_DIRS / XDG_DATA_DIRS at the run home", async () => {
    const home = await createRunHome({ root });
    try {
      expect(home.env.XDG_CONFIG_DIRS.startsWith(home.path)).toBe(true);
      expect(home.env.XDG_DATA_DIRS.startsWith(home.path)).toBe(true);
    } finally {
      await home.cleanup();
    }
  });

  it("subdirectories are 0700 even under a restrictive umask", async () => {
    // 0o277 masks the owner write/execute bits that mkdir's 0700 mode would otherwise grant.
    const previous = process.umask(0o277);
    try {
      const home = await createRunHome({ root });
      try {
        for (const dir of ["config", "data", "cache", "state", "tmp", "runtime"]) {
          expect((await stat(path.join(home.path, dir))).mode & 0o777, dir).toBe(0o700);
        }
      } finally {
        await home.cleanup();
      }
    } finally {
      process.umask(previous);
    }
  });

  // Root ignores directory permissions, so the failure cannot be provoked there.
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "a failed cleanup is not memoised: a later call retries and succeeds",
    async () => {
      const home = await createRunHome({ root });
      // A read-only parent directory prevents unlinking the run home.
      await chmod(root, 0o500);
      let firstError: unknown = null;
      try {
        await home.cleanup();
      } catch (error) {
        firstError = error;
      } finally {
        await chmod(root, 0o700);
      }
      expect(firstError).toBeTruthy();
      await expect(stat(home.path)).resolves.toBeTruthy();
      // The second call retries (not the memoised rejection) and removes it.
      await home.cleanup();
      await expect(stat(home.path)).rejects.toThrow();
      // Idempotent after success.
      await home.cleanup();
    },
  );

  it("rejects and leaves nothing behind when the run home cannot be created", async () => {
    // A root that is a file makes mkdtemp fail.
    const file = path.join(root, "not-a-dir");
    await writeFile(file, "x");
    await expect(createRunHome({ root: file })).rejects.toThrow();
  });
});
