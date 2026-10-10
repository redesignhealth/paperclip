/**
 * TECH-7355 R4: strict command-scan mode contract at the testEnvironment gate.
 *
 * Independent of execute.command-scan.test.ts (which drives the full execute()
 * path): this file drives testEnvironment() — the environment-probe surface a
 * user reaches from the adapter settings UI — and pins that the mode gate:
 *   - fails with the dedicated hermes_command_scan_mode_invalid check code,
 *     WITHOUT probing the CLI (no child spawn at any seam), for EVERY invalid
 *     value including EMPTY and private/secret values that must never be
 *     echoed into logs or check messages;
 *   - is absent for unset and 'off' (the CLI probes proceed normally);
 *   - runs BEFORE the launcher resolution in required mode (an untrusted
 *     launcher fails with hermes_untrusted_launcher without a CLI probe).
 *
 * The only child spawns in this surface are node:child_process execFile probes
 * (CLI --version, python --version), which are mocked here — no real Hermes
 * CLI is ever launched.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Fail-closed callback-style fakes: any probe that runs reports ENOENT-ish
  // failure, so assertions can distinguish "probe attempted" from "gate
  // blocked before any probe" — and nothing ever launches a real CLI.
  // Each export gets its OWN mock instance so per-function call counts stay
  // attributable.
  const probeFake = () => {
    const fn = vi.fn((...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        const err = new Error("probe-fail-closed-ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        queueMicrotask(() => last(err));
        return undefined as never;
      }
      return undefined as never;
    });
    return fn;
  };
  return {
    ...actual,
    execFile: probeFake(),
    exec: probeFake(),
    spawn: probeFake(),
    execSync: probeFake(),
    spawnSync: probeFake(),
    fork: probeFake(),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
}));

// Deterministic node:fs existsSync seam (launcher resolution + any fs probes),
// defaulting to real behavior (repo handler-indirection pattern).
const fsMockHandlers = vi.hoisted(() => ({
  existsSync: null as null | ((p: unknown) => boolean),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: unknown) =>
      fsMockHandlers.existsSync ? fsMockHandlers.existsSync(p) : actual.existsSync(p as any),
  };
});

import { execFile as mockedExecFile, spawn as mockedSpawn } from "node:child_process";
import { testEnvironment } from "./test.js";

const INVALID_MODE_MESSAGE =
  'Invalid PAPERCLIP_HERMES_COMMAND_SCAN: expected "required" or "off" (unset = off); refusing to run Hermes';


// Fully-typed testEnvironment context (AdapterEnvironmentTestContext requires
// companyId and adapterType; config is the only field the gate reads).
function makeEnvTestCtx(command: string) {
  return { companyId: "company-1", adapterType: "hermes_local", config: { command } };
}

describe("testEnvironment strict command-scan mode gate (TECH-7355 R4)", () => {
  const originalScanEnv = process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
  const originalHome = process.env.HOME;
  let homeDir: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
    // Keep every host-home-dependent probe (config.yaml discovery, ~/.hermes/.env)
    // pointed at an empty temp home so results are host-independent.
    homeDir = mkdtempSync(path.join(os.tmpdir(), "hermes-testenv-scan-"));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalScanEnv !== undefined) {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = originalScanEnv;
    } else {
      delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fsMockHandlers.existsSync = null;
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
  });

  it("fails with hermes_command_scan_mode_invalid, probing no CLI, for every invalid value including typos and EMPTY", async () => {
    for (const invalid of ["optional", "disable", "require", "on", "1", "true", " ", ""]) {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = invalid;
      vi.clearAllMocks();

      const result = await testEnvironment(makeEnvTestCtx("hermes"));

      expect(result.status, `mode=${JSON.stringify(invalid)}`).toBe("fail");
      expect(result.adapterType).toBe("hermes_local");
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].code).toBe("hermes_command_scan_mode_invalid");
      expect(result.checks[0].level).toBe("error");
      expect(result.checks[0].message).toBe(INVALID_MODE_MESSAGE);
      // No CLI probe, no child spawn at any seam.
      expect(mockedExecFile).not.toHaveBeenCalled();
      expect(mockedSpawn).not.toHaveBeenCalled();
    }
  });

  it("never echoes a private invalid mode value into the check message", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "S3cret-sc4n-mode-value";

    const result = await testEnvironment(makeEnvTestCtx("hermes"));

    expect(result.status).toBe("fail");
    expect(result.checks[0].code).toBe("hermes_command_scan_mode_invalid");
    expect(result.checks[0].message).toBe(INVALID_MODE_MESSAGE);
    expect(result.checks[0].message).not.toContain("S3cret-sc4n-mode-value");
  });

  it("treats EMPTY as invalid, never as unset", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "";

    const result = await testEnvironment(makeEnvTestCtx("hermes"));

    expect(result.status).toBe("fail");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].code).toBe("hermes_command_scan_mode_invalid");
  });

  it("unset mode leaves the gate absent: CLI probes proceed normally", async () => {
    delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;

    const result = await testEnvironment(makeEnvTestCtx("hermes"));

    expect(result.checks.some((c) => c.code === "hermes_command_scan_mode_invalid")).toBe(false);
    // The CLI probe really ran (it fail-closed by mock, which surfaces as the
    // CLI-installed check, not the mode gate).
    expect(mockedExecFile).toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("'off' mode leaves the gate absent: CLI probes proceed normally", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "off";

    const result = await testEnvironment(makeEnvTestCtx("hermes"));

    expect(result.checks.some((c) => c.code === "hermes_command_scan_mode_invalid")).toBe(false);
    expect(mockedExecFile).toHaveBeenCalled();
  });

  it("required mode fails an untrusted launcher with hermes_untrusted_launcher before any CLI probe", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

    const result = await testEnvironment(makeEnvTestCtx("/bin/bash"));

    expect(result.status).toBe("fail");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].code).toBe("hermes_untrusted_launcher");
    expect(result.checks[0].level).toBe("error");
    expect(result.checks[0].message).toMatch(/Untrusted Hermes launcher/);
    // Launcher rejection happens BEFORE the CLI probes.
    expect(mockedExecFile).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("required mode with a trusted launcher name passes the gate and probes the CLI", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
    // Deterministic on any host: no on-disk launcher, so the trusted canonical
    // path is used off-Linux without a trust probe.
    fsMockHandlers.existsSync = () => false;

    const result = await testEnvironment(makeEnvTestCtx("hermes"));

    expect(result.checks.some((c) => c.code === "hermes_command_scan_mode_invalid")).toBe(false);
    expect(result.checks.some((c) => c.code === "hermes_untrusted_launcher")).toBe(false);
    expect(mockedExecFile).toHaveBeenCalled();
  });

  it("required mode resolves the launcher BEFORE probing, so a garbage launcher never reaches a probe", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

    const result = await testEnvironment(makeEnvTestCtx("/tmp/fake-hermes"));

    expect(result.status).toBe("fail");
    expect(result.checks[0].code).toBe("hermes_untrusted_launcher");
    expect(mockedExecFile).not.toHaveBeenCalled();
  });
});
