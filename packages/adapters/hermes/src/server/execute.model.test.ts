/**
 * TECH-7074: execute() must never pass the placeholder model "auto" to `hermes chat -m`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
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

// Mock fs and path resolution to avoid real file reads in execute()
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
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}


function spawnedArgs(): string[] {
  const calls = vi.mocked(serverUtils.runChildProcess).mock.calls;
  return calls[calls.length - 1][2] as string[];
}

describe("hermes-local adapter -m handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omits -m when the stored model is the legacy auto sentinel", async () => {
    const { ctx } = makeCtx({ model: "auto" });
    await execute(ctx as any);
    const args = spawnedArgs();
    expect(args).not.toContain("-m");
    expect(args).not.toContain("auto");
  });

  it("omits -m when no model is configured", async () => {
    const { ctx } = makeCtx();
    await execute(ctx as any);
    expect(spawnedArgs()).not.toContain("-m");
  });

  it("passes an explicit model through unchanged", async () => {
    const { ctx } = makeCtx({ model: "anthropic/claude-sonnet-4" });
    await execute(ctx as any);
    const args = spawnedArgs();
    expect(args[args.indexOf("-m") + 1]).toBe("anthropic/claude-sonnet-4");
  });

  it("reads the Hermes default model from the configured HERMES_HOME, not ~/.hermes", async () => {
    const fsp = await import("node:fs/promises");
    vi.mocked(fsp.readFile).mockImplementation((async (file: unknown) => {
      if (String(file) === "/custom/hermes/config.yaml") return "model:\n  default: gpt-5.4\n";
      return "";
    }) as never);
    try {
      const { ctx } = makeCtx({ provider: "copilot", model: "auto", env: { HERMES_HOME: "/custom/hermes" } });
      await execute(ctx as any);
      expect(spawnedArgs()).not.toContain("-m");
    } finally {
      vi.mocked(fsp.readFile).mockImplementation((async () => "") as never);
    }
  });

  it("fails before spawning when a provider is set but no model or Hermes default exists", async () => {
    const { ctx } = makeCtx({ provider: "anthropic", model: "auto" });
    await expect(execute(ctx as any)).rejects.toThrow(/no model is configured/);
    expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();
  });
});
