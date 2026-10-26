/**
 * The environment test runs its `--version` probes in the run's cwd. execFile reports a missing (or
 * non-directory) cwd with ENOENT — the same code as a missing binary — so a bad workspace path must
 * be reported on its own, before anything is spawned, rather than as `hermes_cli_not_found`.
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

import { execFile, spawn } from "node:child_process";
import { testEnvironment } from "./test.js";

const run = (config: Record<string, unknown>) =>
  testEnvironment({
    companyId: "company-1",
    adapterType: "hermes_local",
    config: { hermesCommand: "/opt/x/hermes", ...config },
  });

const saved = { HOME: process.env.HOME, ISO: process.env.PAPERCLIP_HERMES_HOST_ISOLATION };
let home: string;

beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(path.join(os.tmpdir(), "hermes-testenv-cwd-"));
  process.env.HOME = home;
  delete process.env.PAPERCLIP_HERMES_HOST_ISOLATION;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  if (saved.ISO === undefined) delete process.env.PAPERCLIP_HERMES_HOST_ISOLATION;
  else process.env.PAPERCLIP_HERMES_HOST_ISOLATION = saved.ISO;
  rmSync(home, { recursive: true, force: true });
});

describe("working directory", () => {
  it("reports a nonexistent cwd as hermes_cwd_missing without spawning anything", async () => {
    const missing = path.join(home, "workspace-that-does-not-exist");

    const result = await run({ cwd: missing });

    expect(result.status).toBe("fail");
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("hermes_cwd_missing");
    expect(codes).not.toContain("hermes_cli_not_found");
    const cwdCheck = result.checks.find((check) => check.code === "hermes_cwd_missing");
    expect(cwdCheck?.level).toBe("error");
    expect(cwdCheck?.message).toContain(missing);
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports workspaceDir the same way when cwd is absent", async () => {
    const missing = path.join(home, "no-such-workspace");

    const result = await run({ workspaceDir: missing });

    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toContain("hermes_cwd_missing");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports a cwd that is a file, not a directory, without spawning anything", async () => {
    const file = path.join(home, "not-a-directory");
    writeFileSync(file, "x");

    const result = await run({ cwd: file });

    expect(result.status).toBe("fail");
    const cwdCheck = result.checks.find((check) => check.code === "hermes_cwd_missing");
    expect(cwdCheck?.level).toBe("error");
    expect(cwdCheck?.message).toContain("is not a directory");
    expect(result.checks.map((check) => check.code)).not.toContain("hermes_cli_not_found");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("still probes the CLI when the cwd exists", async () => {
    const result = await run({ cwd: home });

    expect(result.checks.map((check) => check.code)).not.toContain("hermes_cwd_missing");
    expect(execFile).toHaveBeenCalled();
  });
});
