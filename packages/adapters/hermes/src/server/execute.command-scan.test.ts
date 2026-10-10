import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(configOverrides: Record<string, unknown> = {}) {
  return {
    runId: "test-run-command-scan",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: "/opt/hermes/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
      ...configOverrides,
    },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

describe("hermes execute command-scan policy (TECH-7355)", () => {
  const originalEnv = process.env.PAPERCLIP_HERMES_COMMAND_SCAN;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = originalEnv;
    } else {
      delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
    }
  });

  it("applies mandatory command scan policy when PAPERCLIP_HERMES_COMMAND_SCAN=required", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

    const ctx = makeCtx({
      env: {
        USER_VAR: "custom_value",
        TIRITH_ENABLED: "0",
        HERMES_YOLO_MODE: "1",
        PYTHONPATH: "/attacker/path",
        LD_PRELOAD: "/attacker/lib.so",
      },
    });

    await execute(ctx as any);

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked).toHaveBeenCalledTimes(1);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const hermesCmd = lastCall[1];
    const args = lastCall[2];
    const opts = lastCall[3] as { env: Record<string, string> };

    expect(hermesCmd).toBe("/opt/hermes/bin/hermes");
    expect(args[0]).toBe("--require-command-scan");
    expect(args[1]).toBe("chat");

    // Invariants enforced
    expect(opts.env.PYTHONNOUSERSITE).toBe("1");
    expect(opts.env.HERMES_REQUIRE_COMMAND_SCAN).toBe("1");
    expect(opts.env.HERMES_COMMAND_SCANNER).toBe("/usr/local/bin/tirith");

    // Legitimate user env preserved
    expect(opts.env.USER_VAR).toBe("custom_value");

    // Overrides stripped
    expect(opts.env.TIRITH_ENABLED).toBeUndefined();
    expect(opts.env.PYTHONPATH).toBeUndefined();
    expect(opts.env.LD_PRELOAD).toBeUndefined();
  });

  it("rejects untrusted command launchers when command scanning is required", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

    const ctx = makeCtx({
      command: "/bin/bash",
    });

    await expect(execute(ctx as any)).rejects.toThrow(/Untrusted Hermes launcher/);
  });

  it("rejects reserved extraArgs attempting to bypass command scanning", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

    const ctx = makeCtx({
      extraArgs: ["--no-require-command-scan"],
    });

    await expect(execute(ctx as any)).rejects.toThrow(/Reserved argument flag/);
  });

  it("preserves standard behavior when PAPERCLIP_HERMES_COMMAND_SCAN is unset", async () => {
    const ctx = makeCtx({
      env: {
        TIRITH_ENABLED: "0",
      },
    });

    await execute(ctx as any);

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked).toHaveBeenCalledTimes(1);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const args = lastCall[2];
    const opts = lastCall[3] as { env: Record<string, string> };

    expect(args).not.toContain("--require-command-scan");
    expect(opts.env.HERMES_REQUIRE_COMMAND_SCAN).toBeUndefined();
    expect(opts.env.HERMES_COMMAND_SCANNER).toBeUndefined();
  });

  it("preserves standard behavior when PAPERCLIP_HERMES_COMMAND_SCAN is 'off'", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "off";

    const ctx = makeCtx({
      env: {
        TIRITH_ENABLED: "0",
      },
    });

    await execute(ctx as any);

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked).toHaveBeenCalledTimes(1);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const args = lastCall[2];
    const opts = lastCall[3] as { env: Record<string, string> };

    expect(args).not.toContain("--require-command-scan");
    expect(opts.env.HERMES_REQUIRE_COMMAND_SCAN).toBeUndefined();
    expect(opts.env.HERMES_COMMAND_SCANNER).toBeUndefined();
  });

  it("execute fails fast before spawn or probes when PAPERCLIP_HERMES_COMMAND_SCAN is invalid", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "optional";

    const ctx = makeCtx();

    await expect(execute(ctx as any)).rejects.toThrow(
      'Invalid PAPERCLIP_HERMES_COMMAND_SCAN: expected "required" or "off" (unset = off); refusing to run Hermes',
    );

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("testEnvironment returns failure check hermes_command_scan_mode_invalid without CLI probe when mode is invalid", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "invalid_mode";

    const result = await testEnvironment({
      config: { command: "hermes" },
    });

    expect(result.status).toBe("fail");
    expect(result.adapterType).toBe("hermes_local");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].code).toBe("hermes_command_scan_mode_invalid");
    expect(result.checks[0].level).toBe("error");
    expect(result.checks[0].message).toBe(
      'Invalid PAPERCLIP_HERMES_COMMAND_SCAN: expected "required" or "off" (unset = off); refusing to run Hermes',
    );
  });
});
