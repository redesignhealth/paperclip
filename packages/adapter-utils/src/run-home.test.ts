import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
});
