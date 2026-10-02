/**
 * TECH-7095: under PAPERCLIP_AGENT_AUTH_POLICY=managed_only the Grok execute path must not read the
 * server's XAI_API_KEY nor point/stage the host company Grok home; HOME/XDG come only from the
 * config env. host_fallback keeps the legacy company-home subscription behaviour.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const mocks = vi.hoisted(() => ({
  state: { isRemote: false },
  runProcessMock: vi.fn(),
  prepareRuntimeMock: vi.fn(async (input: { assets?: Array<{ key: string }> }) => ({
    workspaceRemoteDir: "/remote/workspace",
    assetDirs: Object.fromEntries((input.assets ?? []).map((a) => [a.key, `/remote/workspace/.paperclip-runtime/grok/${a.key}`])),
    restoreWorkspace: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => mocks.state.isRemote,
  adapterExecutionTargetRemoteCwd: (_t: unknown, cwd: string) => (mocks.state.isRemote ? "/remote/workspace" : cwd),
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: mocks.state.isRemote ? "remote" : "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: () => (mocks.state.isRemote ? "remote" : "local"),
  ensureAdapterExecutionTargetCommandResolvable: async () => {},
  ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
  prepareAdapterExecutionTargetRuntime: (...args: unknown[]) =>
    (mocks.prepareRuntimeMock as (...a: unknown[]) => unknown)(...args),
  readAdapterExecutionTarget: () => (mocks.state.isRemote ? { kind: "remote", transport: "ssh" } : { kind: "local" }),
  resolveAdapterExecutionTargetCommandForLogs: async () => "grok",
  resolveAdapterExecutionTargetTimeoutSec: (_t: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: (...args: unknown[]) => mocks.runProcessMock(...args),
}));

import { execute } from "./execute.js";
import { resolveManagedGrokHomeDir } from "./grok-home.js";

const XAI_SENTINEL = "sentinel-host-xai-7095";
const HOST_GROK_AUTH_SENTINEL = "sentinel-host-grok-auth-7095";
const OTHER_SENTINELS = { OPENAI_API_KEY: "sentinel-host-openai-7095", ANTHROPIC_API_KEY: "sentinel-host-anthropic-7095" };
const ALL_SENTINELS = [XAI_SENTINEL, HOST_GROK_AUTH_SENTINEL, ...Object.values(OTHER_SENTINELS)];
const ENV_KEYS = ["HOME", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "XAI_API_KEY", "PAPERCLIP_AGENT_AUTH_POLICY", ...Object.keys(OTHER_SENTINELS)];

const tempRoots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
let hostHome: string;
let runHome: string;
let workspace: string;
let hostGrokHome: string;

function okResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
    stderr: "",
  };
}

function expectNoSentinel(value: unknown) {
  const serialized = JSON.stringify(value) ?? "";
  for (const sentinel of ALL_SENTINELS) expect(serialized).not.toContain(sentinel);
}

function makeCtx(env: Record<string, string>, logs: string[], extra: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    runId: "run-grok-auth-policy",
    agent: { id: "agent-1", companyId: "company-1", name: "Grok", adapterType: "grok_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: workspace, env, ...extra },
    context: {},
    authToken: "run-token",
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
  };
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-grok-auth-policy-"));
  tempRoots.push(root);
  hostHome = path.join(root, "host-home");
  runHome = path.join(root, "run-home");
  workspace = path.join(root, "workspace");
  await fs.mkdir(runHome, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  process.env.HOME = hostHome;
  process.env.PAPERCLIP_HOME = path.join(hostHome, ".paperclip");
  delete process.env.PAPERCLIP_INSTANCE_ID;
  process.env.XAI_API_KEY = XAI_SENTINEL;
  Object.assign(process.env, OTHER_SENTINELS);
  hostGrokHome = resolveManagedGrokHomeDir(process.env, "company-1");
  await fs.mkdir(hostGrokHome, { recursive: true });
  await fs.writeFile(path.join(hostGrokHome, "auth.json"), JSON.stringify({ id: { key: HOST_GROK_AUTH_SENTINEL } }));
  vi.spyOn(os, "homedir").mockReturnValue(hostHome);
  mocks.state.isRemote = false;
  mocks.runProcessMock.mockReset();
  mocks.runProcessMock.mockResolvedValue(okResult());
  mocks.prepareRuntimeMock.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempRoots.length > 0) await fs.rm(tempRoots.pop()!, { recursive: true, force: true });
});

describe("grok execute under managed_only", () => {
  it("never points the child at the host company Grok home and ignores the server XAI_API_KEY", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    const result = await execute(makeCtx({ HOME: runHome }, logs));
    expect(result.exitCode).toBe(0);
    const [, , , args, opts] = mocks.runProcessMock.mock.calls[0] as [string, unknown, string, string[], { env: Record<string, string> }];
    expect(opts.env.HOME).toBe(runHome);
    expect(opts.env.XDG_CONFIG_HOME).toBe(path.join(runHome, ".config"));
    expect(opts.env.GROK_HOME).toBeUndefined();
    expect(opts.env.XAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(opts.env)).not.toContain(hostHome);
    expectNoSentinel({ env: opts.env, args, logs, result });
  });

  it("uses an explicit XAI_API_KEY binding from the config env", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await execute(makeCtx({ HOME: runHome, XAI_API_KEY: "bound-key" }, []));
    const opts = mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> };
    expect(opts.env.XAI_API_KEY).toBe("bound-key");
    expect(opts.env.GROK_HOME).toBeUndefined();
    expect(result.billingType).toBe("api");
  });

  it("uses only the managed runtime GROK_HOME for a managed connection", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const managedGrokHome = path.join(runHome, "provider", "grok");
    await execute(makeCtx({ HOME: runHome, GROK_HOME: managedGrokHome }, [], { managedAiConnection: { id: "conn-1" } }));
    const opts = mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> };
    expect(opts.env.GROK_HOME).toBe(managedGrokHome);
  });

  it("does not stage the host Grok home for a remote run", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    mocks.state.isRemote = true;
    const logs: string[] = [];
    await execute(makeCtx({ HOME: runHome }, logs));
    const prepareInput = mocks.prepareRuntimeMock.mock.calls[0]![0] as { assets?: unknown };
    expect(prepareInput.assets).toBeUndefined();
    const opts = mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> };
    expect(opts.env.GROK_HOME).toBeUndefined();
    expectNoSentinel({ env: opts.env, logs });
  });

  it("refuses a local run before spawn when the config env carries no HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    const error = await execute(makeCtx({}, logs)).then(() => null, (err: unknown) => err);
    expect(error).toMatchObject({ name: "AgentAuthPolicyError", code: "agent_home_isolation_required" });
    expect(mocks.runProcessMock).not.toHaveBeenCalled();
    expectNoSentinel({ logs, message: (error as Error).message });
  });
});

describe("grok execute under host_fallback (legacy)", () => {
  it("uses the host company Grok home for subscription mode when the server has no XAI key", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    delete process.env.XAI_API_KEY;
    await execute(makeCtx({}, []));
    const opts = mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> };
    expect(opts.env.GROK_HOME).toBe(hostGrokHome);
  });

  it("treats a server XAI_API_KEY as API mode (no GROK_HOME)", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    await execute(makeCtx({}, []));
    const opts = mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> };
    expect(opts.env.GROK_HOME).toBeUndefined();
  });
});

const FILES = ["./execute.ts", "./skills.ts"];

describe("static host-read guard (TECH-7095)", () => {
  it("annotates every retained host home/credential read with auth-policy: host_fallback", async () => {
    const hostRead = /os\.homedir\(\)|os\.userInfo\(\)|process\.env\.(HOME|XDG_[A-Z_]+|XAI_API_KEY)\b|resolveManagedGrokHomeDir\(process\.env|hasNonEmptyEnvValue\(process\.env/;
    for (const file of FILES) {
      const lines = (await fs.readFile(new URL(file, import.meta.url), "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
        if (!hostRead.test(line)) return;
        const annotated = line.includes("auth-policy: host_fallback") || (lines[index - 1] ?? "").includes("auth-policy: host_fallback");
        expect(annotated, `${file}:${index + 1}`).toBe(true);
      });
    }
  });
});
