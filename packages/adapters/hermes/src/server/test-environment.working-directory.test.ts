/**
 * The environment test runs its `--version` probes in the run's cwd (for a Router config, the bound
 * plan's cwd). execFile reports a missing (or non-directory) cwd with ENOENT — the same code as a
 * missing binary — so a bad workspace path must be reported on its own, before anything is spawned,
 * rather than as `hermes_cli_not_found` (or hidden behind a Router binding failure).
 *
 * Every child-process seam is a spy that fails closed, so no Hermes (or Python) process starts here.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const failClosed = () =>
    vi.fn((...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        const err = new Error("spawn-blocked-ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        queueMicrotask(() => last(err));
      }
      return undefined as never;
    });
  return { ...actual, execFile: failClosed(), spawn: failClosed() };
});

vi.mock("./detect-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./detect-model.js")>();
  return { ...actual, detectModel: vi.fn(async () => null) };
});

// Deterministic statSync seam (repo handler-indirection pattern), for the unreadable-directory branch
// that cannot be produced portably on a real filesystem.
const fsSeams = vi.hoisted(() => ({
  statSync: null as null | ((p: unknown) => unknown),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (p: unknown) => (fsSeams.statSync ? fsSeams.statSync(p) : actual.statSync(p as string)),
  };
});

// Router binding seam: a bound plan (whose cwd is the one the probes would use) or a binding failure,
// without needing a real Hermes install on the test host.
type BindOptions = { command: string; pathEnv: string | undefined; cwd: string };
const routerSeams = vi.hoisted(() => ({
  resolveBinding: null as null | ((options: BindOptions) => unknown),
  probe: vi.fn(async () => ({ supported: true as const })),
}));
vi.mock("./router-readiness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./router-readiness.js")>();
  return {
    ...actual,
    resolveRouterLaunchPlan: (options: BindOptions) =>
      routerSeams.resolveBinding ? routerSeams.resolveBinding(options) : actual.resolveRouterLaunchPlan(options),
    probeHermesRouterSupport: routerSeams.probe,
  };
});

import { execFile, spawn } from "node:child_process";
import { testEnvironment } from "./test.js";

const run = (config: Record<string, unknown>) =>
  testEnvironment({
    companyId: "company-1",
    adapterType: "hermes_local",
    config: { hermesCommand: "/opt/x/hermes", ...config },
  });

const routerConfig = (workspaceDir: string) => ({
  provider: "router",
  model: "auto-jev-routing",
  workspaceDir,
  env: { RAMP_ROUTER_API_KEY: "router-test-key-7895", PATH: "/usr/bin:/bin" },
});

const saved = {
  HOME: process.env.HOME,
  ISO: process.env.PAPERCLIP_HERMES_HOST_ISOLATION,
  SCAN: process.env.PAPERCLIP_HERMES_COMMAND_SCAN,
};
let home: string;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  routerSeams.resolveBinding = null;
  fsSeams.statSync = null;
  home = mkdtempSync(path.join(os.tmpdir(), "hermes-testenv-cwd-"));
  process.env.HOME = home;
  delete process.env.PAPERCLIP_HERMES_HOST_ISOLATION;
  delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
});

afterEach(() => {
  restoreEnv("HOME", saved.HOME);
  restoreEnv("PAPERCLIP_HERMES_HOST_ISOLATION", saved.ISO);
  restoreEnv("PAPERCLIP_HERMES_COMMAND_SCAN", saved.SCAN);
  routerSeams.resolveBinding = null;
  fsSeams.statSync = null;
  rmSync(home, { recursive: true, force: true });
});

describe("working directory", () => {
  it("reports a nonexistent cwd as hermes_cwd_invalid without spawning anything", async () => {
    const missing = path.join(home, "workspace-that-does-not-exist");

    const result = await run({ cwd: missing });

    expect(result.status).toBe("fail");
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("hermes_cwd_invalid");
    expect(codes).not.toContain("hermes_cli_not_found");
    const cwdCheck = result.checks.find((check) => check.code === "hermes_cwd_invalid");
    expect(cwdCheck?.level).toBe("error");
    expect(cwdCheck?.message).toContain(missing);
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports workspaceDir the same way when cwd is absent", async () => {
    const missing = path.join(home, "no-such-workspace");

    const result = await run({ workspaceDir: missing });

    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain("hermes_cwd_invalid");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports a cwd that is a file, not a directory, without spawning anything", async () => {
    const file = path.join(home, "not-a-directory");
    writeFileSync(file, "x");

    const result = await run({ cwd: file });

    expect(result.status).toBe("fail");
    const cwdCheck = result.checks.find((check) => check.code === "hermes_cwd_invalid");
    expect(cwdCheck?.level).toBe("error");
    expect(cwdCheck?.message).toContain("is not a directory");
    expect(result.checks.map((check) => check.code)).not.toContain("hermes_cli_not_found");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports an unreadable directory (EACCES) as hermes_cwd_invalid without spawning anything", async () => {
    fsSeams.statSync = () => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };

    const result = await run({ cwd: home });

    expect(result.status).toBe("fail");
    const cwdCheck = result.checks.find((check) => check.code === "hermes_cwd_invalid");
    expect(cwdCheck?.level).toBe("error");
    expect(cwdCheck?.message).toContain("could not be read");
    expect(cwdCheck?.message).toContain("EACCES");
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("checks a Router config's bound plan cwd, which the probes would run in", async () => {
    // The config cwd exists; the bound plan resolves to a different, missing directory. Only the plan
    // cwd is what the run and its probes actually use, so that is the one that must be diagnosed.
    const planCwd = path.join(home, "router-workspace-that-does-not-exist");
    routerSeams.resolveBinding = (options: BindOptions) => ({
      ok: true as const,
      plan: {
        cwd: planCwd,
        path: options.pathEnv ?? "",
        executable: options.command,
        launcherDir: path.dirname(options.command),
        interpreter: "/opt/hermes/bin/python3",
      },
    });

    const result = await run(routerConfig(home));

    expect(result.status).toBe("fail");
    const cwdCheck = result.checks.find((check) => check.code === "hermes_cwd_invalid");
    expect(cwdCheck?.level).toBe("error");
    expect(cwdCheck?.message).toContain(planCwd);
    expect(cwdCheck?.message).not.toContain(`"${home}"`);
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(routerSeams.probe).not.toHaveBeenCalled();
  });

  it("reports a missing cwd even when Router binding fails", async () => {
    const missing = path.join(home, "router-cwd-that-does-not-exist");
    routerSeams.resolveBinding = () => ({ ok: false as const, reason: "error" as const, message: "binding failed" });

    const result = await run(routerConfig(missing));

    expect(result.status).toBe("fail");
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("hermes_cwd_invalid");
    expect(codes).not.toContain("hermes_router_error");
    expect(result.checks.find((check) => check.code === "hermes_cwd_invalid")?.message).toContain(missing);
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(routerSeams.probe).not.toHaveBeenCalled();
  });

  it("still probes the CLI in the cwd when it exists", async () => {
    const result = await run({ cwd: home });

    expect(result.checks.map((check) => check.code)).not.toContain("hermes_cwd_invalid");
    expect(vi.mocked(execFile).mock.calls.map((args) => args[2])).toContainEqual(
      expect.objectContaining({ cwd: home }),
    );
  });
});
