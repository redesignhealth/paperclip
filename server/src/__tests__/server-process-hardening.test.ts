import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NONDUMPABLE_REQUIRED_MESSAGE,
  checkServerProcessHardening,
  nonDumpableRequired,
  probeServerProcessInspectability,
  type ProbeExec,
} from "../services/server-process-hardening.js";

const execResult = (code: number | null, stderr = "", spawnError = false): ProbeExec => async () => ({ code, stderr, spawnError });

describe("probeServerProcessInspectability (TECH-7095)", () => {
  it("is unknown off Linux without running anything", async () => {
    const exec = vi.fn();
    expect(await probeServerProcessInspectability({ platform: "darwin", exec })).toBe("unknown");
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports inspectable when the same-user child can open the environ", async () => {
    expect(await probeServerProcessInspectability({ platform: "linux", pid: 42, exec: execResult(0) })).toBe("inspectable");
  });

  it("reports protected on a permission denial, and unknown on any other failure", async () => {
    expect(
      await probeServerProcessInspectability({ platform: "linux", exec: execResult(1, "head: cannot open '/proc/42/environ': Permission denied") }),
    ).toBe("protected");
    expect(await probeServerProcessInspectability({ platform: "linux", exec: execResult(1, "No such file or directory") })).toBe("unknown");
    expect(await probeServerProcessInspectability({ platform: "linux", exec: execResult(null, "", true) })).toBe("unknown");
  });

  it("probes /proc/<pid>/environ with a strict env that carries no server secrets", async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "tech7095-probe-sentinel";
    try {
      await probeServerProcessInspectability({
        platform: "linux",
        pid: 4242,
        exec: async (file, args, options) => {
          calls.push({ file, args, env: options.env });
          return { code: 0, stderr: "", spawnError: false };
        },
      });
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["-c", "1", "/proc/4242/environ"]);
    expect(JSON.stringify(calls[0].env)).not.toContain("tech7095-probe-sentinel");
    // A localized error message must not turn a protected server into "unknown".
    expect(calls[0].env.LC_ALL).toBe("C");
  });
});

describe("checkServerProcessHardening (TECH-7095)", () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn() });

  it("does nothing outside an authenticated deployment unless required", async () => {
    const l = log();
    const probe = vi.fn(async () => "inspectable" as const);
    expect(await checkServerProcessHardening({ deploymentMode: "local_trusted", env: {}, log: l, probe })).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();
    expect(l.warn).not.toHaveBeenCalled();
  });

  it("warns (does not throw) when an authenticated server is inspectable and the requirement is off", async () => {
    const l = log();
    await expect(
      checkServerProcessHardening({ deploymentMode: "authenticated", env: {}, log: l, probe: async () => "inspectable" }),
    ).resolves.toBe("inspectable");
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(l.warn.mock.calls)).not.toMatch(/postgres:|secret=|sk-/);
  });

  it("fails startup with a static message when required and inspectable", async () => {
    await expect(
      checkServerProcessHardening({
        deploymentMode: "authenticated",
        env: { PAPERCLIP_REQUIRE_NONDUMPABLE: "true" },
        log: log(),
        probe: async () => "inspectable",
      }),
    ).rejects.toThrow(NONDUMPABLE_REQUIRED_MESSAGE);
  });

  it("passes quietly when protected under the requirement", async () => {
    const l = log();
    const env = { PAPERCLIP_REQUIRE_NONDUMPABLE: "true" };
    expect(await checkServerProcessHardening({ deploymentMode: "authenticated", env, log: l, probe: async () => "protected" })).toBe("protected");
    expect(l.info).toHaveBeenCalledTimes(1);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it("fails startup with the same static message when required and the result is unknown", async () => {
    const l = log();
    const run = (env: NodeJS.ProcessEnv, deploymentMode = "authenticated") =>
      checkServerProcessHardening({ deploymentMode, env, log: l, probe: async () => "unknown" });
    for (const value of ["true", "1", "YES", " on "]) {
      await expect(run({ PAPERCLIP_REQUIRE_NONDUMPABLE: value })).rejects.toThrow(NONDUMPABLE_REQUIRED_MESSAGE);
    }
    // Also for a non-authenticated deployment: an explicit requirement is not satisfied by an unverifiable result.
    await expect(run({ PAPERCLIP_REQUIRE_NONDUMPABLE: "true" }, "local_trusted")).rejects.toThrow(NONDUMPABLE_REQUIRED_MESSAGE);
    // Diagnostics carry the classification only, never an environment value.
    expect(l.warn).toHaveBeenCalled();
    for (const call of l.warn.mock.calls) expect(call[0]).toEqual({ inspectability: "unknown" });
    expect(NONDUMPABLE_REQUIRED_MESSAGE).not.toMatch(/postgres:|secret=|sk-/);
  });

  it("keeps an unknown result non-fatal when the requirement is unset or falsy (unchanged)", async () => {
    for (const env of [{}, { PAPERCLIP_REQUIRE_NONDUMPABLE: "false" }, { PAPERCLIP_REQUIRE_NONDUMPABLE: "" }]) {
      const l = log();
      expect(await checkServerProcessHardening({ deploymentMode: "authenticated", env, log: l, probe: async () => "unknown" })).toBe("unknown");
      expect(l.warn).not.toHaveBeenCalled();
    }
  });

  it("enforces the requirement even for a non-authenticated deployment", async () => {
    await expect(
      checkServerProcessHardening({
        deploymentMode: "local_trusted",
        env: { PAPERCLIP_REQUIRE_NONDUMPABLE: "1" },
        log: log(),
        probe: async () => "inspectable",
      }),
    ).rejects.toThrow(NONDUMPABLE_REQUIRED_MESSAGE);
  });

  it("parses the requirement flag", () => {
    for (const v of ["true", "1", "YES", " on "]) expect(nonDumpableRequired({ PAPERCLIP_REQUIRE_NONDUMPABLE: v })).toBe(true);
    for (const v of ["", "false", "0", "no", undefined]) expect(nonDumpableRequired({ PAPERCLIP_REQUIRE_NONDUMPABLE: v })).toBe(false);
  });
});

// Real kernel behaviour. Linux only (procfs), and not as root (root ignores file modes).
const realKernel = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() !== 0;

describe.skipIf(!realKernel)("exec-only node makes the server non-dumpable (TECH-7095, real Linux)", () => {
  const children: ChildProcess[] = [];
  let dir: string | null = null;

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function copyNode(mode: number): string {
    dir ??= mkdtempSync(path.join(os.tmpdir(), "tech7095-node-"));
    const target = path.join(dir, `node-${mode.toString(8)}`);
    copyFileSync(process.execPath, target);
    chmodSync(target, mode);
    return target;
  }

  async function startServerStandIn(nodeBinary: string): Promise<number> {
    const child = spawn(nodeBinary, ["-e", "console.log('ready'); setInterval(() => {}, 1000);"], {
      env: { PATH: process.env.PATH ?? "", SENTINEL_SERVER_SECRET: "tech7095-server-secret" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout?.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("stand-in exited early")));
    });
    return child.pid!;
  }

  it("positive control: a readable node leaves its environ readable to a same-user child", async () => {
    const pid = await startServerStandIn(copyNode(0o755));
    expect(await probeServerProcessInspectability({ pid })).toBe("inspectable");
  });

  it("an exec-only (0111) node is protected from a same-user child", async () => {
    const pid = await startServerStandIn(copyNode(0o111));
    expect(await probeServerProcessInspectability({ pid })).toBe("protected");
  });

  it("the exec-only server still opens files via /proc/self/fd/<dirfd>/<name> (runner-api-files.ts relies on it)", async () => {
    dir ??= mkdtempSync(path.join(os.tmpdir(), "tech7095-node-"));
    const workDir = path.join(dir, "work");
    const script = `
      const fs = require("node:fs"); const { constants } = fs;
      fs.mkdirSync(${JSON.stringify(workDir)}, { recursive: true });
      fs.writeFileSync(${JSON.stringify(path.join(workDir, "f.txt"))}, "hello");
      const dirfd = fs.openSync(${JSON.stringify(workDir)}, constants.O_RDONLY | constants.O_DIRECTORY);
      const fd = fs.openSync("/proc/self/fd/" + dirfd + "/f.txt", constants.O_RDONLY | constants.O_NOFOLLOW);
      console.log("RESULT:" + fs.readFileSync(fd, "utf8"));
    `;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(copyNode(0o111), ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.once("exit", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`))));
    });
    expect(out).toContain("RESULT:hello");
  });
});
