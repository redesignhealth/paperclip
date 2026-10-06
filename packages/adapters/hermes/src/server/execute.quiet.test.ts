/**
 * TECH-7239: `hermes chat` runs quiet (-Q) by default; `quiet: false` is the
 * only opt-out.
 *
 * Pre-fix regression: `useQuiet` required an explicit boolean `quiet: true`,
 * so every config that never carried one (the common case -- the UI builder
 * did not persist `quiet` at all before TECH-7239, see build-config.test.ts)
 * ran Hermes non-quiet, polluting Paperclip run transcripts with banner and
 * spinner noise.
 *
 * Runs the REAL adapter execute() against a mocked runChildProcess and
 * inspects the actual hermes argv it builds -- the same pattern as
 * execute.toolsets.test.ts / execute.model.test.ts.
 *
 * Boundary documented here: only a BOOLEAN false opts out at the execute
 * level. cfgBoolean ignores strings (same contract as persistSession), so a
 * stored string `quiet: "false"` still runs quiet. String values are
 * normalized to booleans by the UI builder before storage, which is why
 * string handling is asserted in build-config.test.ts instead.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

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
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(adapterConfig: Record<string, unknown>) {
  return {
    runId: "test-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      ...adapterConfig,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  } as any;
}

async function hermesArgvFor(adapterConfig: Record<string, unknown>): Promise<string[]> {
  const ctx = makeCtx(adapterConfig);
  try {
    await execute(ctx);
  } catch {
    // execute may fail after the spawn on env/binary resolution; the argv
    // was still built and handed to runChildProcess, which is the contract
    // under test.
  }
  const mocked = vi.mocked(serverUtils.runChildProcess);
  expect(mocked.mock.calls.length).toBeGreaterThan(0);
  const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
  return lastCall[2] as string[];
}

describe("hermes quiet (-Q) resolution on the executed argv path (TECH-7239 regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omitting quiet passes -Q exactly once (quiet is the default, not the exception)", async () => {
    const argv = await hermesArgvFor({});
    expect(argv.filter((a) => a === "-Q")).toHaveLength(1);
    // The lowercase -q (JSON-ish output mode) stays unconditional; only -Q varies.
    expect(argv).toContain("-q");
  });

  it("quiet: true passes -Q exactly once", async () => {
    const argv = await hermesArgvFor({ quiet: true });
    expect(argv.filter((a) => a === "-Q")).toHaveLength(1);
  });

  it("quiet: false is the opt-out: no -Q on the argv", async () => {
    const argv = await hermesArgvFor({ quiet: false });
    expect(argv).not.toContain("-Q");
    expect(argv).toContain("-q");
  });

  it("a string quiet value is not an execute-level opt-out (cfgBoolean honors booleans only)", async () => {
    // Mirrors the persistSession contract: cfgBoolean ignores strings, so a
    // stored quiet: "false" (only reachable via a raw API write -- the UI
    // builder normalizes strings to booleans, see build-config.test.ts)
    // still runs quiet after TECH-7239.
    const argv = await hermesArgvFor({ quiet: "false" });
    expect(argv.filter((a) => a === "-Q")).toHaveLength(1);
  });
});
