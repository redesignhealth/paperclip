import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

// TECH-7095: under PAPERCLIP_AGENT_AUTH_POLICY=managed_only the Claude adapter must never read
// or seed from the server host's ~/.claude (or a remote target's own $HOME/.claude credentials),
// and the child's HOME / Claude config dir must come only from the run's config env.

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]): Promise<RunProcessResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: args.includes("--version")
      ? "2.1.251 (Claude Code)\n"
      : [
          JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
          JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";
import {
  buildRemoteClaudeConfigMaterializationCommand,
  prepareClaudeConfigSeed,
  resolveChildClaudeConfigDir,
} from "./claude-config.js";
import { listClaudeSkills } from "./skills.js";

const HOST_SETTINGS_SENTINEL = "host-claude-settings-SENTINEL-7095";
const HOST_CLAUDE_MD_SENTINEL = "host-claude-md-SENTINEL-7095";
const HOST_CREDENTIAL_SENTINEL = "host-claude-oauth-SENTINEL-7095";
const HOST_ENV_KEY_SENTINEL = "sk-ant-host-process-env-SENTINEL-7095";
const HOST_SKILL_SENTINEL = "host-only-skill-sentinel-7095";

const ENV_KEYS = [
  "PAPERCLIP_AGENT_AUTH_POLICY",
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
] as const;

describe("claude adapter under the agent auth policy", () => {
  const saved: Record<string, string | undefined> = {};
  let root: string;
  let hostHome: string;
  let hostClaudeDir: string;
  let runHome: string;
  let workspace: string;

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-auth-policy-"));
    hostHome = path.join(root, "host-home");
    hostClaudeDir = path.join(hostHome, ".claude");
    runHome = path.join(root, "run-home");
    workspace = path.join(root, "workspace");
    await mkdir(path.join(hostClaudeDir, "skills", HOST_SKILL_SENTINEL), { recursive: true });
    await writeFile(path.join(hostClaudeDir, "skills", HOST_SKILL_SENTINEL, "SKILL.md"), "---\nname: x\n---\n");
    await mkdir(runHome, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(hostClaudeDir, "settings.json"), JSON.stringify({ theme: HOST_SETTINGS_SENTINEL }));
    await writeFile(path.join(hostClaudeDir, "CLAUDE.md"), HOST_CLAUDE_MD_SENTINEL);
    await writeFile(path.join(hostClaudeDir, ".credentials.json"), JSON.stringify({ token: HOST_CREDENTIAL_SENTINEL }));

    process.env.HOME = hostHome;
    process.env.CLAUDE_CONFIG_DIR = hostClaudeDir;
    process.env.ANTHROPIC_API_KEY = HOST_ENV_KEY_SENTINEL;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "auth-policy-test";
    vi.spyOn(os, "homedir").mockReturnValue(hostHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    runChildProcess.mockClear();
    resetClaudeCliCapabilitiesCacheForTests();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  function assertNoSentinels(value: string) {
    for (const sentinel of [
      HOST_SETTINGS_SENTINEL,
      HOST_CLAUDE_MD_SENTINEL,
      HOST_CREDENTIAL_SENTINEL,
      HOST_ENV_KEY_SENTINEL,
      HOST_SKILL_SENTINEL,
    ]) {
      expect(value).not.toContain(sentinel);
    }
  }

  async function run(configEnv: Record<string, string>, logs: string[]) {
    return execute({
      runId: "run-auth-policy",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "claude", env: configEnv },
      context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    } as never);
  }

  it("managed_only: child HOME comes from config env and no host secret reaches the child", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    await run({ HOME: runHome }, logs);
    expect(runChildProcess).toHaveBeenCalled();
    for (const call of runChildProcess.mock.calls) {
      const [, , args, opts] = call as unknown as [string, string, string[], { env: Record<string, string> }];
      expect(opts.env.HOME).toBe(runHome);
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      assertNoSentinels(JSON.stringify({ args, env: opts.env }));
      expect(JSON.stringify(args)).not.toContain(hostClaudeDir);
    }
    assertNoSentinels(logs.join(""));
  });

  it("managed_only: refuses before spawn when config env carries no isolated HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const error = await run({}, []).catch((err) => err);
    expect(error).toMatchObject({ name: "AgentAuthPolicyError", code: "agent_home_isolation_required" });
    expect(runChildProcess).not.toHaveBeenCalled();
    assertNoSentinels(String(error?.message));
  });

  it("host_fallback: legacy local run still works without a config HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    await run({}, []);
    expect(runChildProcess).toHaveBeenCalled();
  });

  it("managed_only: the remote config seed never copies host settings.json / CLAUDE.md", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const logs: string[] = [];
    const seedDir = await prepareClaudeConfigSeed(process.env, async (_s, chunk) => void logs.push(chunk), "company-1");
    expect(await readdir(seedDir)).toEqual([]);
    expect(logs.join("")).not.toContain(hostClaudeDir);

    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const legacySeed = await prepareClaudeConfigSeed(process.env, async () => {}, "company-1");
    expect(await readFile(path.join(legacySeed, "CLAUDE.md"), "utf8")).toBe(HOST_CLAUDE_MD_SENTINEL);
  });

  it("managed_only: remote materialization never copies the target's own $HOME/.claude credentials", () => {
    const input = { remoteClaudeConfigDir: "/r/config", remoteClaudeConfigSeedDir: "/r/seed" };
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const enforced = buildRemoteClaudeConfigMaterializationCommand(input);
    expect(enforced).not.toContain(".claude");
    expect(enforced).not.toContain("credentials.json");
    expect(enforced).toContain("/r/seed");
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only_report";
    expect(buildRemoteClaudeConfigMaterializationCommand(input)).toContain("${HOME}/.claude/");
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    expect(buildRemoteClaudeConfigMaterializationCommand(input)).toContain("${HOME}/.claude/");
  });

  it("resolveChildClaudeConfigDir uses only the child env", () => {
    expect(resolveChildClaudeConfigDir({ HOME: runHome })).toBe(path.join(runHome, ".claude"));
    expect(resolveChildClaudeConfigDir({ HOME: runHome, CLAUDE_CONFIG_DIR: "/managed/claude" })).toBe("/managed/claude");
    expect(() => resolveChildClaudeConfigDir({})).toThrow(expect.objectContaining({ code: "agent_home_isolation_required" }));
  });

  it("managed_only: skills listing never inspects the host ~/.claude/skills", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const enforced = await listClaudeSkills({ agentId: "a", companyId: "c", adapterType: "claude_local", config: {} } as never);
    assertNoSentinels(JSON.stringify(enforced));
    const withRunHome = await listClaudeSkills({
      agentId: "a", companyId: "c", adapterType: "claude_local", config: { env: { HOME: runHome } },
    } as never);
    assertNoSentinels(JSON.stringify(withRunHome));

    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const legacy = await listClaudeSkills({ agentId: "a", companyId: "c", adapterType: "claude_local", config: {} } as never);
    expect(JSON.stringify(legacy)).toContain(HOST_SKILL_SENTINEL);
  });
});
