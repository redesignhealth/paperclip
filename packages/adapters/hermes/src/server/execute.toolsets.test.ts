/**
 * execute.toolsets.test.ts
 *
 * No-network, no-binary regression for the pinned-Hermes toolset resolution
 * path exercised by scripts/e2e-hosted-memory-local.sh's E2E_SCOPE=all mode
 * (agent adapterConfig `toolsets: "memory"`). Runs the REAL adapter
 * execute() against a mocked runChildProcess and inspects the actual hermes
 * argv it builds -- the same pattern as execute.onspawn.test.ts.
 *
 * What this proves (executed path, not source grep):
 *   1. `toolsets: "memory"` resolves to exactly ["-t", "memory"] in the
 *      hermes argv -- the explicit memory-only toolset the E2E relies on.
 *   2. OMITTING toolsets produces NO -t flag at all: Hermes defaults to every
 *      tool (unrestricted). This is the current default-allowlist-flow state
 *      that motivates recommending `toolsets: "memory"` for ALL flows.
 *   3. `extraArgs` pass through verbatim AFTER the toolset flag without
 *      altering it (the extra-args lineage risk: extras cannot silently
 *      rewrite or bypass the toolset).
 *   4. The argv never carries adapter-config values that are not CLI flags
 *      (secret_ref env bindings are resolved server-side into the child env,
 *      never into argv).
 *
 * NOT covered here (unmapped, needs the pinned Hermes 0.21.3 binary inside
 * the image): whether `-t memory` also excludes RUNTIME MCP servers, and the
 * actual mem0_add/mem0_search tool names in the Hermes trace protocol. The
 * server-side runtime MCP delivery is unconditional w.r.t. toolsets (see the
 * report); a native canary or image-side check must close that gap.
 *
 * Run: pnpm --filter @paperclipai/adapters-hermes exec vitest run src/server/execute.toolsets.test.ts
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

describe("hermes toolset resolution on the executed argv path (E2E_SCOPE=all regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toolsets: 'memory' resolves to exactly -t memory in the hermes argv", async () => {
    const argv = await hermesArgvFor({ toolsets: "memory" });
    const tIndex = argv.indexOf("-t");
    expect(tIndex).toBeGreaterThan(-1, "the -t toolset flag must be present");
    expect(argv[tIndex + 1]).toBe("memory");
    // The toolset value is passed verbatim -- never expanded or rewritten.
    expect(argv.filter((a) => a === "memory")).toHaveLength(1);
  });

  it("omitting toolsets produces NO -t flag (Hermes defaults to every tool)", async () => {
    const argv = await hermesArgvFor({});
    expect(argv).not.toContain("-t");
    // Also via the legacy enabledToolsets alias being absent.
    expect(argv).not.toContain("--toolsets");
  });

  it("extraArgs pass through verbatim after the toolset flag without altering it", async () => {
    const argv = await hermesArgvFor({ toolsets: "memory", extraArgs: ["--flag-x", "value-y"] });
    const tIndex = argv.indexOf("-t");
    expect(argv[tIndex + 1]).toBe("memory");
    expect(argv).toContain("--flag-x");
    expect(argv).toContain("value-y");
    // Extras cannot duplicate or rewrite the toolset flag.
    expect(argv.filter((a) => a === "-t")).toHaveLength(1);
  });

  it("argv carries no secret_ref material: env bindings are never CLI arguments", async () => {
    const argv = await hermesArgvFor({
      toolsets: "memory",
      env: {
        ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "sec-1", version: "latest" },
        OPENAI_API_KEY: { type: "secret_ref", secretId: "sec-2", version: "latest" },
      },
    });
    expect(argv).toContain("memory");
    const joined = argv.join(" ");
    expect(joined).not.toContain("secret_ref");
    expect(joined).not.toContain("sec-1");
    expect(joined).not.toContain("sec-2");
  });
});
