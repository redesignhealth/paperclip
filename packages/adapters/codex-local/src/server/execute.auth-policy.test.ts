import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TECH-7095: under PAPERCLIP_AGENT_AUTH_POLICY=managed_only the Codex adapter must never read,
// symlink, copy, vend or copy back the server host's Codex credential/config, and the child's
// HOME must come only from the run's config env.

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(async (_input: { assets?: Array<{ key: string; restore?: unknown }> }) => ({
    target: { kind: "remote", transport: "ssh" },
    workspaceRemoteDir: "/remote/workspace",
    runtimeRootDir: "/remote/workspace/.paperclip-runtime/codex",
    assetDirs: { home: "/remote/workspace/.paperclip-runtime/codex/home" },
    restoreWorkspace: async () => {},
  })),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return { ...actual, prepareAdapterExecutionTargetRuntime, startAdapterExecutionTargetPaperclipBridge };
});

import { execute } from "./execute.js";
import { evaluateCodexCredentialReadiness, resolveSharedCodexHomeDirForPolicy, seedManagedCodexHome } from "./codex-home.js";
import { prepareCodexRuntimeConfig } from "./runtime-config.js";

const HOST_TOKEN_SENTINEL = "host-codex-refresh-token-SENTINEL-7095";
const HOST_CONFIG_SENTINEL = "host-codex-config-SENTINEL-7095";
const HOST_ENV_KEY_SENTINEL = "sk-host-process-env-SENTINEL-7095";
const EXPLICIT_BINDING_KEY = "sk-explicit-binding-7095";

const ENV_KEYS = [
  "PAPERCLIP_AGENT_AUTH_POLICY",
  "HOME",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_CODEX_AUTH_CACHE",
  "PAPERCLIP_CODEX_PROVIDERS",
] as const;

describe("codex execute under the agent auth policy", () => {
  const saved: Record<string, string | undefined> = {};
  let root: string;
  let hostHome: string;
  let hostCodexHome: string;
  let runHome: string;
  let workspace: string;

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-policy-"));
    hostHome = path.join(root, "host-home");
    hostCodexHome = path.join(hostHome, ".codex");
    runHome = path.join(root, "run-home");
    workspace = path.join(root, "workspace");
    await mkdir(hostCodexHome, { recursive: true });
    await mkdir(runHome, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(hostCodexHome, "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: HOST_ENV_KEY_SENTINEL,
        tokens: { account_id: "acct-host", refresh_token: HOST_TOKEN_SENTINEL, access_token: HOST_TOKEN_SENTINEL },
      }),
      { mode: 0o600 },
    );
    await writeFile(path.join(hostCodexHome, "config.toml"), `# ${HOST_CONFIG_SENTINEL}\n`);
    await writeFile(path.join(hostCodexHome, "instructions.md"), HOST_CONFIG_SENTINEL);

    process.env.HOME = hostHome;
    process.env.CODEX_HOME = hostCodexHome;
    process.env.OPENAI_API_KEY = HOST_ENV_KEY_SENTINEL;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "auth-policy-test";
    delete process.env.PAPERCLIP_CODEX_PROVIDERS;
    vi.spyOn(os, "homedir").mockReturnValue(hostHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    runChildProcess.mockClear();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  function companyCodexHome() {
    return path.join(root, "paperclip-home", "instances", "auth-policy-test", "companies", "company-1", "codex-home");
  }

  async function run(configEnv: Record<string, string>, logs: string[], extra: Record<string, unknown> = {}) {
    return execute({
      ...extra,
      runId: "run-auth-policy",
      agent: { id: "agent-1", companyId: "company-1", name: "Coder", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "codex", engine: "cli", env: configEnv },
      context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    } as never);
  }

  function assertNoSentinels(value: string) {
    expect(value).not.toContain(HOST_TOKEN_SENTINEL);
    expect(value).not.toContain(HOST_CONFIG_SENTINEL);
    expect(value).not.toContain(HOST_ENV_KEY_SENTINEL);
  }

  it("managed_only: never links/copies host ~/.codex and the child HOME comes from config env", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    await run({ HOME: runHome, OPENAI_API_KEY: EXPLICIT_BINDING_KEY }, logs);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[], { env: Record<string, string> }];
    const childEnv = call[3].env;
    expect(childEnv.HOME).toBe(runHome);
    expect(childEnv.CODEX_HOME).toBe(companyCodexHome());
    expect(childEnv.OPENAI_API_KEY).toBe(EXPLICIT_BINDING_KEY);
    assertNoSentinels(JSON.stringify(call));
    assertNoSentinels(logs.join(""));

    const home = companyCodexHome();
    const authStat = await lstat(path.join(home, "auth.json"));
    expect(authStat.isSymbolicLink()).toBe(false);
    const auth = await readFile(path.join(home, "auth.json"), "utf8");
    assertNoSentinels(auth);
    expect(auth).toContain(EXPLICIT_BINDING_KEY);
    for (const name of await readdir(home)) {
      const stat = await lstat(path.join(home, name));
      if (stat.isFile()) assertNoSentinels(await readFile(path.join(home, name), "utf8"));
      expect(stat.isSymbolicLink()).toBe(false);
    }
  });

  it("managed_only: removes a legacy host-linked auth.json from the company home", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const home = companyCodexHome();
    await mkdir(home, { recursive: true });
    await symlink(path.join(hostCodexHome, "auth.json"), path.join(home, "auth.json"));
    const logs: string[] = [];
    await run({ HOME: runHome, OPENAI_API_KEY: EXPLICIT_BINDING_KEY }, logs);
    expect((await lstat(path.join(home, "auth.json"))).isSymbolicLink()).toBe(false);
    assertNoSentinels(await readFile(path.join(home, "auth.json"), "utf8"));
  });

  it("managed_only: refuses before spawn when config env carries no isolated HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    const error = await run({ OPENAI_API_KEY: EXPLICIT_BINDING_KEY }, logs).catch((err) => err);
    expect(error).toMatchObject({ name: "AgentAuthPolicyError", code: "agent_home_isolation_required" });
    expect(runChildProcess).not.toHaveBeenCalled();
    assertNoSentinels(String(error?.message));
  });

  it("managed_only: an unbound run with no explicit key is refused, never satisfied by the host login", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    const error = await run({ HOME: runHome }, logs).catch((err) => err);
    expect(error).toMatchObject({ name: "AgentAuthPolicyError", code: "ai_connection_required" });
    expect(runChildProcess).not.toHaveBeenCalled();
    assertNoSentinels(String(error?.message));
    assertNoSentinels(logs.join(""));
  });

  it("managed_only: a remote unbound run never copies sandbox auth back to the host credential", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const remote = {
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1", port: 2222, username: "fixture",
          remoteWorkspacePath: "/remote/workspace", remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY", knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA", strictHostKeyChecking: true,
        },
      },
    };
    await run({ OPENAI_API_KEY: EXPLICIT_BINDING_KEY }, [], remote);
    const input = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0];
    const homeAsset = input?.assets?.find((asset) => asset.key === "home");
    expect(homeAsset).toBeDefined();
    expect(homeAsset?.restore).toBeUndefined();

    prepareAdapterExecutionTargetRuntime.mockClear();
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    process.env.PAPERCLIP_CODEX_AUTH_CACHE = "0";
    await run({ OPENAI_API_KEY: EXPLICIT_BINDING_KEY }, [], remote);
    const legacyHome = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0]?.assets?.find((asset) => asset.key === "home");
    expect(typeof legacyHome?.restore).toBe("function");
  });

  it("host_fallback: legacy seeding still symlinks the shared host auth.json", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    process.env.PAPERCLIP_CODEX_AUTH_CACHE = "0";
    await run({}, []);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const authStat = await lstat(path.join(companyCodexHome(), "auth.json"));
    expect(authStat.isSymbolicLink()).toBe(true);
  });

  it("policy-aware helpers ignore the host home only when enforced", async () => {
    const env = { CODEX_HOME: hostCodexHome, PAPERCLIP_HOME: process.env.PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID: "auth-policy-test" };
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    expect(resolveSharedCodexHomeDirForPolicy(env)).toBeNull();
    const readiness = await evaluateCodexCredentialReadiness({
      env, companyId: "company-1", configuredCodexHome: null, configuredApiKey: null,
    });
    expect(readiness).toMatchObject({ managed: true, ready: false, sharedSourceHome: null });

    const target = path.join(root, "seed-target");
    await seedManagedCodexHome(target, env, async () => {});
    expect(await readdir(target)).toEqual([]);

    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only_report";
    expect(resolveSharedCodexHomeDirForPolicy(env)).toBe(hostCodexHome);
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    expect(
      (await evaluateCodexCredentialReadiness({ env, companyId: "company-1", configuredCodexHome: null, configuredApiKey: null })).ready,
    ).toBe(true);
  });

  it("managed_only: provider placeholders never resolve from the server env", async () => {
    process.env.PAPERCLIP_CODEX_PROVIDERS = JSON.stringify({
      providers: { gw: { base_url: "http://gw.invalid", http_headers: { Authorization: "{env:OPENAI_API_KEY}" } } },
    });
    const codexHome = path.join(root, "codex-home-providers");
    await mkdir(codexHome, { recursive: true });
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const prepared = await prepareCodexRuntimeConfig({ env: {}, codexHome });
    assertNoSentinels(await readFile(path.join(codexHome, "config.toml"), "utf8").catch(() => ""));
    await prepared.cleanup();

    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const legacy = await prepareCodexRuntimeConfig({ env: {}, codexHome });
    expect(await readFile(path.join(codexHome, "config.toml"), "utf8")).toContain(HOST_ENV_KEY_SENTINEL);
    await legacy.cleanup();
  });
});
