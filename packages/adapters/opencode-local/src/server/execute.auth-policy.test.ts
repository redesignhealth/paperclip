/**
 * TECH-7095: under PAPERCLIP_AGENT_AUTH_POLICY=managed_only the OpenCode execute path must never
 * reach for the server user's home (config, provider logins, skills) and the child's HOME/XDG must
 * come only from the supplied config env. host_fallback keeps the legacy host behaviour.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runChildProcessMock: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runAdapterExecutionTargetProcess: (...args: unknown[]) => mocks.runProcessMock(...args),
    ensureAdapterExecutionTargetCommandResolvable: async () => undefined,
    ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => undefined,
    resolveAdapterExecutionTargetCommandForLogs: async () => "opencode",
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runChildProcess: (...args: unknown[]) => mocks.runChildProcessMock(...args) };
});

import { execute } from "./execute.js";
import { discoverOpenCodeModels, listOpenCodeModels, resetOpenCodeModelsCacheForTests } from "./models.js";
import { listOpenCodeSkills, syncOpenCodeSkills } from "./skills.js";

const SENTINELS = {
  OPENAI_API_KEY: "sentinel-host-openai-7095",
  ANTHROPIC_API_KEY: "sentinel-host-anthropic-7095",
  XAI_API_KEY: "sentinel-host-xai-7095",
};
const HOST_CONFIG_SENTINEL = "sentinel-host-opencode-config-7095";
const HOST_AUTH_SENTINEL = "sentinel-host-opencode-auth-7095";
const ALL_SENTINELS = [...Object.values(SENTINELS), HOST_CONFIG_SENTINEL, HOST_AUTH_SENTINEL];

const tempRoots: string[] = [];
let hostHome: string;
let runHome: string;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PAPERCLIP_AGENT_AUTH_POLICY", ...Object.keys(SENTINELS)];

function okResult(stdout = JSON.stringify({ type: "text", sessionID: "s-1", part: { text: "done" } })) {
  return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 1, startedAt: new Date().toISOString() };
}

async function exists(candidate: string) {
  return fs.lstat(candidate).then(() => true).catch(() => false);
}

function expectNoSentinel(value: unknown) {
  const serialized = JSON.stringify(value) ?? "";
  for (const sentinel of ALL_SENTINELS) expect(serialized).not.toContain(sentinel);
}

function runHomeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
  };
}

function ctx(configEnv: Record<string, string>, logs: string[]) {
  return {
    runId: "run-auth-policy",
    agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: "opencode",
      cwd: workspace,
      model: "openai/gpt-5",
      env: { OPENCODE_ALLOW_ALL_MODELS: "1", ...configEnv },
    },
    context: {},
    onLog: async (_stream: string, chunk: string) => {
      logs.push(chunk);
    },
  } as never;
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-auth-policy-"));
  tempRoots.push(root);
  hostHome = path.join(root, "host-home");
  runHome = path.join(root, "run-home");
  workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(hostHome, ".config", "opencode"), { recursive: true });
  await fs.mkdir(path.join(hostHome, ".local", "share", "opencode"), { recursive: true });
  await fs.mkdir(path.join(hostHome, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(hostHome, ".config", "opencode", "opencode.json"),
    JSON.stringify({ provider: { hostprov: { options: { apiKey: HOST_CONFIG_SENTINEL } } } }),
  );
  await fs.writeFile(path.join(hostHome, ".local", "share", "opencode", "auth.json"), HOST_AUTH_SENTINEL);
  await fs.mkdir(path.join(runHome, "config"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });

  process.env.HOME = hostHome;
  process.env.XDG_CONFIG_HOME = path.join(hostHome, ".config");
  process.env.XDG_DATA_HOME = path.join(hostHome, ".local", "share");
  Object.assign(process.env, SENTINELS);
  vi.spyOn(os, "homedir").mockReturnValue(hostHome);
  vi.spyOn(os, "userInfo").mockReturnValue({ homedir: hostHome } as never);
  mocks.runProcessMock.mockReset();
  mocks.runChildProcessMock.mockReset();
  resetOpenCodeModelsCacheForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempRoots.length > 0) {
    await fs.rm(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("opencode execute under managed_only", () => {
  it("runs with only the supplied HOME/XDG and never copies host config or links host skills", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    let runtimeConfigContents = "";
    mocks.runProcessMock.mockImplementation(async (_runId: string, _target: unknown, _cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      runtimeConfigContents = await fs.readFile(path.join(opts.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8");
      return okResult();
    });
    const logs: string[] = [];
    const result = await execute(ctx(runHomeEnv(runHome), logs));

    expect(result.exitCode).toBe(0);
    expect(mocks.runProcessMock).toHaveBeenCalledTimes(1);
    const [, , , args, opts] = mocks.runProcessMock.mock.calls[0] as [string, unknown, string, string[], { env: Record<string, string> }];
    expect(opts.env.HOME).toBe(runHome);
    expect(opts.env.XDG_DATA_HOME).toBe(path.join(runHome, "data"));
    expect(opts.env.XDG_CONFIG_HOME.startsWith(hostHome)).toBe(false);
    expect(JSON.stringify(opts.env)).not.toContain(hostHome);
    expect(runtimeConfigContents).not.toContain(HOST_CONFIG_SENTINEL);
    expect(runtimeConfigContents).not.toContain("hostprov");
    expectNoSentinel({ env: opts.env, args, logs, result });
    // Skills went into the run home, never the host home.
    expect(await exists(path.join(hostHome, ".claude", "skills"))).toBe(false);
    expect(await exists(path.join(runHome, ".claude", "skills"))).toBe(true);
  });

  it("refuses before spawn when the config env carries no HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    const error = await execute(ctx({}, logs)).then(() => null, (err: unknown) => err);
    expect(error).toMatchObject({ name: "AgentAuthPolicyError", code: "agent_home_isolation_required" });
    expect(mocks.runProcessMock).not.toHaveBeenCalled();
    expect(await exists(path.join(hostHome, ".claude", "skills"))).toBe(false);
    expectNoSentinel({ logs, message: (error as Error).message });
  });
});

describe("opencode execute under host_fallback (legacy)", () => {
  it("still seeds the runtime config from the host XDG config and links host skills", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    let runtimeConfigContents = "";
    mocks.runProcessMock.mockImplementation(async (_r: string, _t: unknown, _c: string, _a: string[], opts: { env: Record<string, string> }) => {
      runtimeConfigContents = await fs.readFile(path.join(opts.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8");
      return okResult();
    });
    const result = await execute(ctx({}, []));
    expect(result.exitCode).toBe(0);
    expect(runtimeConfigContents).toContain("hostprov");
    expect(await exists(path.join(hostHome, ".claude", "skills"))).toBe(true);
  });
});

describe("opencode model discovery", () => {
  it("uses the supplied HOME, not the passwd home, under managed_only", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    mocks.runChildProcessMock.mockResolvedValue(okResult("openai/gpt-5\n"));
    const models = await discoverOpenCodeModels({ command: "opencode", cwd: workspace, env: { HOME: runHome } });
    expect(models.map((m) => m.id)).toEqual(["openai/gpt-5"]);
    const opts = mocks.runChildProcessMock.mock.calls[0]![3] as { env: Record<string, string> };
    expect(opts.env.HOME).toBe(runHome);
    expect(opts.env.XDG_CONFIG_HOME).toBe(path.join(runHome, ".config"));
    expect(opts.env.XDG_DATA_HOME).toBe(path.join(runHome, ".local", "share"));
    expect(JSON.stringify(opts.env)).not.toContain(hostHome);
    expectNoSentinel(opts.env);
  });

  it("skips host-login model listing under managed_only when no HOME is supplied", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    mocks.runChildProcessMock.mockResolvedValue(okResult("openai/gpt-5\n"));
    await expect(listOpenCodeModels()).resolves.toEqual([]);
    expect(mocks.runChildProcessMock).not.toHaveBeenCalled();
  });

  it("keeps the legacy passwd-home override under host_fallback", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    mocks.runChildProcessMock.mockResolvedValue(okResult("openai/gpt-5\n"));
    await discoverOpenCodeModels({ command: "opencode", cwd: workspace, env: { HOME: runHome } });
    const opts = mocks.runChildProcessMock.mock.calls[0]![3] as { env: Record<string, string> };
    expect(opts.env.HOME).toBe(hostHome);
  });
});

describe("opencode skills under managed_only", () => {
  it("never reads or writes the host skills home when no child HOME is configured", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const snapshot = await syncOpenCodeSkills({ config: {} } as never, ["paperclip"]);
    expect(await exists(path.join(hostHome, ".claude", "skills"))).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(hostHome);
    const listed = await listOpenCodeSkills({ config: {} } as never);
    expect(JSON.stringify(listed)).not.toContain(hostHome);
  });

  it("syncs into the configured child HOME under managed_only", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    await syncOpenCodeSkills({ config: { env: { HOME: runHome } } } as never, []);
    expect(await exists(path.join(runHome, ".claude", "skills"))).toBe(true);
    expect(await exists(path.join(hostHome, ".claude", "skills"))).toBe(false);
  });
});

const FILES = ["./execute.ts", "./runtime-config.ts", "./models.ts", "./skills.ts"];

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
