/**
 * TECH-7095: under the enforced managed-only auth policy the Kimi execute/skills paths must never
 * reach for the server user's home, its KIMI_CODE_HOME, or host Kimi/Moonshot keys; under
 * host_fallback the legacy behaviour stays.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { AgentAuthPolicyError } from "@paperclipai/adapter-utils/agent-auth-policy";

const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => false,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  adapterExecutionTargetUsesManagedHome: () => false,
  adapterExecutionTargetUsesPaperclipBridge: () => false,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: async () => {},
  ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
  prepareAdapterExecutionTargetRuntime: async () => ({ workspaceRemoteDir: null, restoreWorkspace: async () => {} }),
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
  readAdapterExecutionTargetHomeDir: async () => null,
  resolveAdapterExecutionTargetCommandForLogs: async () => "kimi",
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
  runAdapterExecutionTargetShellCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  startAdapterExecutionTargetPaperclipBridge: async () => null,
}));

import { execute } from "./execute.js";
import { listKimiSkills, syncKimiSkills } from "./skills.js";

const HOST_SECRET = "sentinel-host-kimi-secret-7095";
const HOST_FILE_SECRET = "sentinel-host-kimi-file-7095";
const SENTINELS = [HOST_SECRET, HOST_FILE_SECRET];
const ENV_KEYS = [
  "PAPERCLIP_AGENT_AUTH_POLICY",
  "HOME",
  "KIMI_CODE_HOME",
  "KIMI_MODEL_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
];
const savedEnv: Record<string, string | undefined> = {};
const tempRoots: string[] = [];
let fakeHostHome = "";

async function tempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return out.sort();
}

function makeContext(config: Record<string, unknown>, logs: string[]): AdapterExecutionContext {
  return {
    runId: "run-auth-policy",
    agent: { id: "agent-1", companyId: "company-1", name: "Kimi", adapterType: "kimi_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli", ...config },
    context: {},
    authToken: "run-token",
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
  };
}

const skillCtx = (config: Record<string, unknown>) => ({
  agentId: "a",
  companyId: "c",
  adapterType: "kimi_local",
  config,
});

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  fakeHostHome = await tempDir("paperclip-fake-host-home-");
  await fs.mkdir(path.join(fakeHostHome, ".kimi-code", "skills"), { recursive: true });
  await fs.writeFile(path.join(fakeHostHome, ".kimi-code", "credentials.json"), JSON.stringify({ token: HOST_FILE_SECRET }));
  process.env.HOME = fakeHostHome;
  process.env.KIMI_CODE_HOME = path.join(fakeHostHome, ".kimi-code");
  process.env.KIMI_MODEL_API_KEY = HOST_SECRET;
  process.env.KIMI_API_KEY = HOST_SECRET;
  process.env.MOONSHOT_API_KEY = HOST_SECRET;
  vi.spyOn(os, "homedir").mockReturnValue(fakeHostHome);
  runProcessMock.mockReset();
  runProcessMock.mockImplementation(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({ role: "assistant", content: "done" }),
    stderr: "",
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempRoots.length > 0) {
    await fs.rm(tempRoots.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("kimi execute under managed_only", () => {
  it("uses only the supplied child HOME and never host keys or host home", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const before = await listTree(fakeHostHome);
    const runHome = await tempDir("paperclip-run-home-test-");
    const cwd = await tempDir("paperclip-kimi-cwd-");
    const logs: string[] = [];

    const result = await execute(makeContext({ cwd, env: { HOME: runHome } }, logs));

    expect(runProcessMock).toHaveBeenCalledTimes(1);
    const [, , , args, opts] = runProcessMock.mock.calls[0] as [string, unknown, string, string[], { env: Record<string, string> }];
    expect(opts.env.HOME).toBe(runHome);
    expect(opts.env.KIMI_CODE_HOME).toBeUndefined();
    // TECH-7095: no explicit key bound and no host login to infer from => unknown billing.
    expect(result.billingType).toBe("unknown");
    const serialized = JSON.stringify({ args, env: opts.env, logs, result });
    for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(fakeHostHome);
    expect(await listTree(fakeHostHome)).toEqual(before);
  });

  it("refuses before spawn when no isolated child HOME is supplied", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const cwd = await tempDir("paperclip-kimi-cwd-");
    const logs: string[] = [];
    const error = await execute(makeContext({ cwd }, logs)).then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(AgentAuthPolicyError);
    expect((error as AgentAuthPolicyError).code).toBe("agent_home_isolation_required");
    expect(runProcessMock).not.toHaveBeenCalled();
    for (const sentinel of SENTINELS) expect(JSON.stringify({ m: (error as Error).message, logs })).not.toContain(sentinel);
  });

  it("skills ignore the server KIMI_CODE_HOME/home and write nothing there", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const before = await listTree(fakeHostHome);
    const listed = await listKimiSkills(skillCtx({}));
    const synced = await syncKimiSkills(skillCtx({}), ["paperclip"]);
    expect(await listTree(fakeHostHome)).toEqual(before);
    for (const snapshot of [listed, synced]) {
      expect(JSON.stringify(snapshot)).not.toContain(fakeHostHome);
    }
    const runHome = await tempDir("paperclip-run-home-test-");
    const scoped = await listKimiSkills(skillCtx({ env: { HOME: runHome } }));
    expect(scoped.entries.every((e) => !e.targetPath || e.targetPath.startsWith(path.join(runHome, ".kimi-code", "skills")))).toBe(true);
  });
});

describe("kimi under host_fallback", () => {
  it("keeps the legacy server KIMI_CODE_HOME skills location and runs without a child HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const cwd = await tempDir("paperclip-kimi-cwd-");
    await execute(makeContext({ cwd }, []));
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    const listed = await listKimiSkills(skillCtx({}));
    expect(listed.entries.every((e) => !e.targetPath || e.targetPath.startsWith(path.join(fakeHostHome, ".kimi-code", "skills")))).toBe(true);
  });
});
