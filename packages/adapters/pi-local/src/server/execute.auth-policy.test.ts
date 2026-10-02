/**
 * TECH-7095: under PAPERCLIP_AGENT_AUTH_POLICY=managed_only the Pi execute path derives its
 * sessions/skills dirs from the child's HOME (config env) only, never the server user's home
 * (whose ~/.pi/agent holds host Pi logins). host_fallback keeps the legacy server-home layout.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  modelCheckMock: vi.fn(async () => [{ id: "openai/gpt-5", label: "openai/gpt-5" }]),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runAdapterExecutionTargetProcess: (...args: unknown[]) => mocks.runProcessMock(...args),
    ensureAdapterExecutionTargetCommandResolvable: async () => undefined,
    ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => undefined,
    resolveAdapterExecutionTargetCommandForLogs: async () => "pi",
  };
});

vi.mock("./models.js", () => ({
  ensurePiModelConfiguredAndAvailable: (...args: unknown[]) => mocks.modelCheckMock(...(args as [])),
}));

import { execute } from "./execute.js";
import { listPiSkills, syncPiSkills } from "./skills.js";

const SENTINELS = {
  OPENAI_API_KEY: "sentinel-host-openai-7095",
  ANTHROPIC_API_KEY: "sentinel-host-anthropic-7095",
};
const HOST_PI_AUTH_SENTINEL = "sentinel-host-pi-auth-7095";
const ALL_SENTINELS = [...Object.values(SENTINELS), HOST_PI_AUTH_SENTINEL];
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "PAPERCLIP_AGENT_AUTH_POLICY", ...Object.keys(SENTINELS)];

const tempRoots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
let hostHome: string;
let runHome: string;
let workspace: string;

function okResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "done", usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } } }, toolResults: [] }),
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  };
}

async function exists(candidate: string) {
  return fs.lstat(candidate).then(() => true).catch(() => false);
}

function expectNoSentinel(value: unknown) {
  const serialized = JSON.stringify(value) ?? "";
  for (const sentinel of ALL_SENTINELS) expect(serialized).not.toContain(sentinel);
}

function ctx(configEnv: Record<string, string>, logs: string[], runtimeSessionId: string | null = null) {
  return {
    runId: "run-pi-auth-policy",
    agent: { id: "agent-1", companyId: "company-1", name: "Pi", adapterType: "pi_local", adapterConfig: {} },
    runtime: { sessionId: runtimeSessionId, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "pi", cwd: workspace, model: "openai/gpt-5", env: configEnv },
    context: {},
    onLog: async (_stream: string, chunk: string) => {
      logs.push(chunk);
    },
  } as never;
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-auth-policy-"));
  tempRoots.push(root);
  hostHome = path.join(root, "host-home");
  runHome = path.join(root, "run-home");
  workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(hostHome, ".pi", "agent"), { recursive: true });
  await fs.writeFile(path.join(hostHome, ".pi", "agent", "auth.json"), JSON.stringify({ key: HOST_PI_AUTH_SENTINEL }));
  await fs.mkdir(runHome, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  process.env.HOME = hostHome;
  process.env.XDG_CONFIG_HOME = path.join(hostHome, ".config");
  Object.assign(process.env, SENTINELS);
  vi.spyOn(os, "homedir").mockReturnValue(hostHome);
  mocks.runProcessMock.mockReset();
  mocks.runProcessMock.mockResolvedValue(okResult());
  mocks.modelCheckMock.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempRoots.length > 0) await fs.rm(tempRoots.pop()!, { recursive: true, force: true });
});

describe("pi execute under managed_only", () => {
  it("derives sessions/skills from the configured HOME and never touches the host ~/.pi", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    const result = await execute(ctx({ HOME: runHome }, logs));
    expect(result.exitCode).toBe(0);
    const [, , , args, opts] = mocks.runProcessMock.mock.calls[0] as [string, unknown, string, string[], { env: Record<string, string> }];
    expect(opts.env.HOME).toBe(runHome);
    expect(opts.env.XDG_CONFIG_HOME).toBe(path.join(runHome, ".config"));
    expect(JSON.stringify(opts.env)).not.toContain(hostHome);
    expect(JSON.stringify(args)).not.toContain(hostHome);
    const sessionArg = args[args.indexOf("--session") + 1]!;
    const skillArg = args[args.indexOf("--skill") + 1]!;
    expect(sessionArg.startsWith(path.join(runHome, ".pi", "paperclips"))).toBe(true);
    expect(skillArg).toBe(path.join(runHome, ".pi", "agent", "skills"));
    const modelEnv = (mocks.modelCheckMock.mock.calls[0] as unknown as [{ env: Record<string, string> }])[0].env;
    expect(modelEnv.HOME).toBe(runHome);
    expectNoSentinel({ env: opts.env, args, logs, result });
    expect(await exists(path.join(hostHome, ".pi", "paperclips"))).toBe(false);
    expect(await exists(path.join(hostHome, ".pi", "agent", "skills"))).toBe(false);
  });

  it("refuses before spawn when the config env carries no HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    const error = await execute(ctx({}, logs)).then(() => null, (err: unknown) => err);
    expect(error).toMatchObject({ name: "AgentAuthPolicyError", code: "agent_home_isolation_required" });
    expect(mocks.runProcessMock).not.toHaveBeenCalled();
    expect(await exists(path.join(hostHome, ".pi", "paperclips"))).toBe(false);
    expectNoSentinel({ logs, message: (error as Error).message });
  });

  it("does not read a saved session file outside the child home", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const hostSession = path.join(hostHome, ".pi", "paperclips", "old.jsonl");
    await fs.mkdir(path.dirname(hostSession), { recursive: true });
    await fs.writeFile(hostSession, JSON.stringify({ type: "session", cwd: workspace }) + "\n");
    const readSpy = vi.spyOn(fs, "readFile");
    await execute(ctx({ HOME: runHome }, [], hostSession));
    expect(readSpy.mock.calls.some(([file]) => String(file) === hostSession)).toBe(false);
    const args = mocks.runProcessMock.mock.calls[0]![3] as string[];
    expect(args[args.indexOf("--session") + 1]).not.toBe(hostSession);
  });
});

describe("pi execute under host_fallback (legacy)", () => {
  it("keeps the server-home sessions/skills layout", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    await execute(ctx({}, []));
    const args = mocks.runProcessMock.mock.calls[0]![3] as string[];
    expect(args[args.indexOf("--skill") + 1]).toBe(path.join(hostHome, ".pi", "agent", "skills"));
    expect(args[args.indexOf("--session") + 1]!.startsWith(path.join(hostHome, ".pi", "paperclips"))).toBe(true);
  });
});

describe("pi skills under managed_only", () => {
  it("never writes the host skills home without a child HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const snapshot = await syncPiSkills({ config: {} } as never, ["paperclip"]);
    expect(await exists(path.join(hostHome, ".pi", "agent", "skills"))).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(hostHome);
    expect(JSON.stringify(await listPiSkills({ config: {} } as never))).not.toContain(hostHome);
  });

  it("syncs into the configured child HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    await syncPiSkills({ config: { env: { HOME: runHome } } } as never, []);
    expect(await exists(path.join(runHome, ".pi", "agent", "skills"))).toBe(true);
  });
});

const FILES = ["./execute.ts", "./runtime-config.ts", "./skills.ts"];

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
