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

// Explicit child_process seam: the ONLY in-process spawn paths in execute()
// are the memory import probe (execFile) and runChildProcess (mocked above).
// The spies behave as fail-closed callback-style fakes so an accidental spawn
// can never hang the suite; the assertions below then prove it never happened.
// Each export gets its OWN mock instance so per-function call counts stay
// attributable.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const failClosed = () =>
    vi.fn((...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        queueMicrotask(() => last(new Error("child_process must not be spawned from these tests")));
        return undefined as never;
      }
      return undefined as never;
    });
  return {
    ...actual,
    execFile: failClosed(),
    exec: failClosed(),
    spawn: failClosed(),
    execSync: failClosed(),
    spawnSync: failClosed(),
    fork: failClosed(),
  };
});

import { execFile as mockedExecFile, spawn as mockedSpawn } from "node:child_process";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(
  configOverrides: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
) {
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
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null, ...contextOverrides },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

// Fully-typed testEnvironment context (AdapterEnvironmentTestContext requires
// companyId and adapterType; config is the only field the gate reads).
function makeEnvTestCtx(command: string) {
  return { companyId: "company-1", adapterType: "hermes_local", config: { command } };
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

  describe("exact spawn argv at the real runChildProcess seam (R4)", () => {
    // Deterministic prompt: a custom promptTemplate renders exactly the
    // task body, so the full argv can be pinned token for token.
    const PROMPT_TEMPLATE = "USER QUERY: {{taskBody}}";
    const TASK_BODY = "Summarize `git log --stat` for issue #7";
    const PROMPT = `USER QUERY: ${TASK_BODY}`;

    function lastSpawnArgs(): string[] {
      const mocked = vi.mocked(serverUtils.runChildProcess);
      expect(mocked).toHaveBeenCalledTimes(1);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      return lastCall[2];
    }

    it("builds the exact default argv: flag at argv[0], chat at argv[1], -q prompt, -Q, --source tool, --yolo", async () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

      const ctx = makeCtx({ promptTemplate: PROMPT_TEMPLATE });
      Object.assign(ctx.context, { taskBody: TASK_BODY });

      await execute(ctx as any);

      // EXACT equality — not .toContain — so any regression to the old
      // ['chat', '--require-command-scan', ...] form (flag after the
      // subcommand) or to appending the flag after prompt/extraArgs fails.
      expect(lastSpawnArgs()).toEqual([
        "--require-command-scan",
        "chat",
        "-q",
        PROMPT,
        "-Q",
        "--source",
        "tool",
        "--yolo",
      ]);
    });

    it("builds the exact maximal argv with every optional flag and extraArgs verbatim at the end", async () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

      const ctx = makeCtx({
        promptTemplate: PROMPT_TEMPLATE,
        model: "anthropic/claude-sonnet-4",
        provider: "openrouter",
        toolsets: "terminal,files",
        maxTurnsPerRun: 25,
        worktreeMode: true,
        checkpoints: true,
        verbose: true,
        extraArgs: ["-s", "github", "--run-budget", "600"],
      });
      Object.assign(ctx.context, { taskBody: TASK_BODY });
      (ctx.runtime as Record<string, unknown>).sessionParams = { sessionId: "sess-abc123" };

      await execute(ctx as any);

      expect(lastSpawnArgs()).toEqual([
        "--require-command-scan",
        "chat",
        "-q",
        PROMPT,
        "-Q",
        "-m",
        "anthropic/claude-sonnet-4",
        "--provider",
        "openrouter",
        "-t",
        "terminal,files",
        "--max-turns",
        "25",
        "-w",
        "--checkpoints",
        "-v",
        "--source",
        "tool",
        "--yolo",
        "--resume",
        "sess-abc123",
        "-s",
        "github",
        "--run-budget",
        "600",
      ]);
    });

    it("prompt data containing the literal flag string never masks the control flag (exactly one, at argv[0])", async () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

      const promptWithFlagLiteral = "How do I configure --require-command-scan?";
      const ctx = makeCtx({ promptTemplate: PROMPT_TEMPLATE });
      Object.assign(ctx.context, { taskBody: promptWithFlagLiteral });

      await execute(ctx as any);

      const args = lastSpawnArgs();
      const expectedPrompt = `USER QUERY: ${promptWithFlagLiteral}`;
      expect(args).toEqual([
        "--require-command-scan",
        "chat",
        "-q",
        expectedPrompt,
        "-Q",
        "--source",
        "tool",
        "--yolo",
      ]);
      // The control flag appears exactly once and only at argv[0]; the literal
      // string inside the prompt data is never mistaken for the control.
      expect(args.indexOf("--require-command-scan")).toBe(0);
      expect(args.lastIndexOf("--require-command-scan")).toBe(0);
      expect(args[3]).toBe(expectedPrompt);
    });
  });

  describe("invalid mode fails fast with no child spawn at any seam (R4)", () => {
    it("rejects EMPTY value, never treats it as unset, and never echoes it", async () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "";

      const ctx = makeCtx();
      await expect(execute(ctx as any)).rejects.toThrow(
        'Invalid PAPERCLIP_HERMES_COMMAND_SCAN: expected "required" or "off" (unset = off); refusing to run Hermes',
      );
    });

    it("rejects a private/secret value and never echoes it in the thrown message", async () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "hunter2-super-secret-mode";

      const ctx = makeCtx();
      let message = "";
      await expect(execute(ctx as any)).rejects.toThrow(/Invalid PAPERCLIP_HERMES_COMMAND_SCAN/);
      try {
        await execute(ctx as any);
      } catch (err: unknown) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toContain("hunter2-super-secret-mode");
      expect(message).toBe(
        'Invalid PAPERCLIP_HERMES_COMMAND_SCAN: expected "required" or "off" (unset = off); refusing to run Hermes',
      );
    });

    it("spawns no child process at ANY seam before the mode gate rejects (runChildProcess, execFile, spawn)", async () => {
      for (const invalid of ["optional", "", " ", "REQUIRED", "1", "on"]) {
        process.env.PAPERCLIP_HERMES_COMMAND_SCAN = invalid;

        const ctx = makeCtx();
        await expect(execute(ctx as any)).rejects.toThrow(/Invalid PAPERCLIP_HERMES_COMMAND_SCAN/);

        // No spawn at either seam: not the Hermes child (runChildProcess) and
        // not the memory preflight probe (node:child_process execFile/spawn).
        expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();
        expect(mockedExecFile).not.toHaveBeenCalled();
        expect(mockedSpawn).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }
    });

    it("testEnvironment with an EMPTY mode value fails with hermes_command_scan_mode_invalid and probes no CLI", async () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "";

      const result = await testEnvironment(makeEnvTestCtx("hermes"));

      expect(result.status).toBe("fail");
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].code).toBe("hermes_command_scan_mode_invalid");
      expect(result.checks[0].level).toBe("error");
      expect(mockedExecFile).not.toHaveBeenCalled();
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("testEnvironment never echoes a private invalid mode value", async () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "S3cret-sc4n-mode";

      const result = await testEnvironment(makeEnvTestCtx("hermes"));

      expect(result.status).toBe("fail");
      expect(result.checks[0].code).toBe("hermes_command_scan_mode_invalid");
      expect(result.checks[0].message).toBe(
        'Invalid PAPERCLIP_HERMES_COMMAND_SCAN: expected "required" or "off" (unset = off); refusing to run Hermes',
      );
      expect(result.checks[0].message).not.toContain("S3cret-sc4n-mode");
    });
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

    const result = await testEnvironment(makeEnvTestCtx("hermes"));

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
