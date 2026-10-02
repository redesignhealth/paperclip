/**
 * TECH-7095 commit 5: host GitHub / git credential fallbacks under the agent auth policy, plus
 * the env-guard helpers used by create/update/hire validation.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { AgentAuthPolicyError, isAgentAuthPolicyError } from "@paperclipai/adapter-utils/agent-auth-policy";
import { prepareGitHubExecutionEnvironment } from "@paperclipai/adapter-utils/execution-target";
import {
  GIT_CREDENTIAL_TOKEN_ENV_KEY,
  buildAnonymousGitAuthInvocation,
  createGitRemoteAuthProvider,
  describeGitAuthFailure,
  isGitHubConnectionRequiredFailure,
} from "../services/git-credentials.ts";
import { createWorkspaceGitOperationScheduler } from "../services/workspace-git-operation-scheduler.ts";
import { buildServerGitBaseEnv } from "../services/server-git-env.ts";
import {
  assertAgentEnvOverridesAllowed,
  findForbiddenAgentEnvOverrides,
  findForbiddenProcessAdapterCredentialKeys,
  isManagedCapableAdapter,
  stripForbiddenAgentEnvOverrides,
} from "../services/agent-auth-policy-guards.ts";
import { defaultAiConnectionForHire } from "../services/agent-ai-connection-default.ts";

const fakeDb = null as unknown as Db;
const githubUrl = "https://github.com/example/private.git";

// Sentinel secrets placed in the server process env: none may ever reach a child or an error.
const SENTINELS = {
  DATABASE_URL: "postgres://sentinel-db-url-7095",
  BETTER_AUTH_SECRET: "sentinel-better-auth-7095",
  ANTHROPIC_API_KEY: "sentinel-anthropic-7095",
  GITHUB_TOKEN: "sentinel-github-token-7095",
  GH_TOKEN: "sentinel-gh-token-7095",
} as const;
const SENTINEL_VALUES = Object.values(SENTINELS);

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = { PAPERCLIP_AGENT_AUTH_POLICY: process.env.PAPERCLIP_AGENT_AUTH_POLICY };
  for (const key of Object.keys(SENTINELS)) savedEnv[key] = process.env[key];
  Object.assign(process.env, SENTINELS);
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setPolicy(policy: "managed_only" | "managed_only_report" | "host_fallback") {
  process.env.PAPERCLIP_AGENT_AUTH_POLICY = policy;
}

function secretsFake(byName: Record<string, string>) {
  return {
    getByName: vi.fn(async (_companyId: string, name: string) => (name in byName ? { id: `secret-${name}` } : null)),
    resolveSecretValue: vi.fn(async (_companyId: string, secretId: string) => byName[secretId.replace(/^secret-/, "")] ?? ""),
  };
}

function expectNoSentinel(text: string) {
  for (const value of SENTINEL_VALUES) expect(text).not.toContain(value);
}

describe("git-credentials under the agent auth policy", () => {
  it("managed_only: skips the server-env GITHUB_TOKEN fallback and returns a credential-free invocation", async () => {
    setPolicy("managed_only");
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets: secretsFake({}),
      env: { GITHUB_TOKEN: SENTINELS.GITHUB_TOKEN, GH_TOKEN: SENTINELS.GH_TOKEN },
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.source).toBe("anonymous");
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("");
    expect(invocation?.env.GH_TOKEN).toBe("");
    expect(invocation?.env.GITHUB_TOKEN).toBe("");
    // Host global/system git config (credential helpers, token-bearing insteadOf) is ignored.
    expect(invocation?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(invocation?.env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(invocation?.configArgs).toContain("credential.helper=");
    expectNoSentinel(JSON.stringify(invocation));
  });

  it("managed_only: also skips the company-secret fallback (TECH-7095 D4)", async () => {
    setPolicy("managed_only");
    const secrets = secretsFake({ GITHUB_TOKEN: "company-secret-token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, { secrets, env: {} });
    const invocation = await provider(githubUrl);
    expect(invocation?.source).toBe("anonymous");
    expect(JSON.stringify(invocation)).not.toContain("company-secret-token");
    expect(secrets.getByName).not.toHaveBeenCalled();
  });

  it("host_fallback: keeps the legacy server-env fallback", async () => {
    setPolicy("host_fallback");
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets: secretsFake({}),
      env: { GITHUB_TOKEN: "env-github" },
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.source).toBe("server_env");
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("env-github");
  });

  it("host_fallback: no token anywhere still returns null (ambient behaviour unchanged)", async () => {
    setPolicy("host_fallback");
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, { secrets: secretsFake({}), env: {} });
    expect(await provider(githubUrl)).toBeNull();
  });

  it("managed_only_report: still uses the fallback (never refuses)", async () => {
    setPolicy("managed_only_report");
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets: secretsFake({}),
      env: { GITHUB_TOKEN: "env-github" },
    });
    expect((await provider(githubUrl))?.source).toBe("server_env");
  });

  it("classifies only an auth failure on the anonymous invocation as github_connection_required", () => {
    const anonymous = buildAnonymousGitAuthInvocation();
    expect(isGitHubConnectionRequiredFailure({ error: "fatal: Authentication failed for 'https://github.com/x'", used: anonymous })).toBe(true);
    expect(isGitHubConnectionRequiredFailure({ error: "fatal: unable to access: Could not resolve host", used: anonymous })).toBe(false);
    expect(isGitHubConnectionRequiredFailure({ error: "fatal: Authentication failed", used: null })).toBe(false);
    expect(isGitHubConnectionRequiredFailure({ error: "fatal: Authentication failed", used: { source: "company_secret" } })).toBe(false);
    expect(describeGitAuthFailure({ error: "Authentication failed", used: { source: "anonymous", secretName: null } })).toMatch(/managed GitHub connection/);
  });
});

describe("server git base env (scheduler + heartbeat git calls)", () => {
  it("buildServerGitBaseEnv contains no server secrets", () => {
    const env = buildServerGitBaseEnv();
    for (const key of Object.keys(SENTINELS)) expect(env[key]).toBeUndefined();
    expectNoSentinel(JSON.stringify(env));
    expect(env.PATH).toBeTruthy();
  });

  it("the git operation scheduler's default child env has no DATABASE_URL/BETTER_AUTH_SECRET/ANTHROPIC_API_KEY", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-7095-sched-"));
    try {
      // Stand in for git: a node script that prints its own environment.
      const scheduler = createWorkspaceGitOperationScheduler({
        gitBinary: process.execPath,
        gitArgsPrefix: ["-e", "process.stdout.write(JSON.stringify(process.env))", "--"],
      });
      const result = await scheduler.run({ workspacePath: workspace, args: ["status"], operation: "tech7095.test", cacheTtlMs: 0 });
      const childEnv = JSON.parse(result.stdout) as Record<string, string>;
      expect(childEnv.DATABASE_URL).toBeUndefined();
      expect(childEnv.BETTER_AUTH_SECRET).toBeUndefined();
      expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(childEnv.GITHUB_TOKEN).toBeUndefined();
      expectNoSentinel(result.stdout);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("execution-target GitHub probe", () => {
  it("managed_only: refuses host credential mode with github_connection_required (no values)", async () => {
    setPolicy("managed_only");
    const error = await prepareGitHubExecutionEnvironment({
      target: null, cwd: os.tmpdir(), env: {}, hostCredentials: true, networkAccess: false,
    }).catch((err: unknown) => err);
    expect(isAgentAuthPolicyError(error)).toBe(true);
    expect((error as AgentAuthPolicyError).code).toBe("github_connection_required");
    expectNoSentinel(String((error as Error).message) + JSON.stringify((error as AgentAuthPolicyError).details));
  });

  it("managed mode: the local probe does not see or return server secrets", async () => {
    setPolicy("managed_only");
    const env = await prepareGitHubExecutionEnvironment({
      target: null, cwd: os.tmpdir(), env: {}, hostCredentials: false, networkAccess: false,
    });
    expectNoSentinel(JSON.stringify(env));
    expect(env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("managed");
  });

  it("host_fallback: host mode still copies the host Git context (legacy)", async () => {
    setPolicy("host_fallback");
    const env = await prepareGitHubExecutionEnvironment({
      target: null, cwd: os.tmpdir(), env: {}, hostCredentials: true, networkAccess: false,
    });
    expect(env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
    expect(env.GITHUB_TOKEN).toBe(SENTINELS.GITHUB_TOKEN);
    // ...but never the non-git server secrets.
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
  });
});

describe("agent auth policy guards", () => {
  it("classifies managed-capable adapters from the AI connection capability table", () => {
    expect(isManagedCapableAdapter("claude_local", {})).toBe(true);
    expect(isManagedCapableAdapter("codex_local", {})).toBe(true);
    expect(isManagedCapableAdapter("grok_local", {})).toBe(true);
    expect(isManagedCapableAdapter("opencode_local", { model: "openrouter/anthropic/claude" })).toBe(true);
    expect(isManagedCapableAdapter("opencode_local", { model: "anthropic/claude" })).toBe(false);
    expect(isManagedCapableAdapter("paperclip_runner", { provider: "codex" })).toBe(true);
    expect(isManagedCapableAdapter("paperclip_runner", { provider: "acpx", acpxAgent: "claude" })).toBe(true);
    expect(isManagedCapableAdapter("paperclip_runner", { provider: "aws_agentcore" })).toBe(false);
    for (const type of ["hermes_local", "gemini_local", "cursor", "kimi_local", "pi_local", "process"]) {
      expect(isManagedCapableAdapter(type, {})).toBe(false);
    }
  });

  it("finds home/credential-location overrides by name, ignoring unchanged saved keys", () => {
    const env = {
      HOME: "/tmp/x", XDG_CONFIG_HOME: "/tmp/y", CODEX_HOME: "/c", GIT_CONFIG_COUNT: "1",
      GIT_SSH_COMMAND: "ssh", SSH_AUTH_SOCK: "/s", GH_CONFIG_DIR: "/g", OK_VAR: "v",
    };
    expect(findForbiddenAgentEnvOverrides(env)).toEqual([
      "CODEX_HOME", "GH_CONFIG_DIR", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "HOME", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME",
    ]);
    expect(findForbiddenAgentEnvOverrides({ CODEX_HOME: "/c", HOME: "/new" }, { previousEnv: { CODEX_HOME: "/c" } })).toEqual(["HOME"]);
    expect(stripForbiddenAgentEnvOverrides(env)).toEqual({
      env: { OK_VAR: "v" },
      stripped: ["CODEX_HOME", "GH_CONFIG_DIR", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "HOME", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME"],
    });
  });

  it("assertAgentEnvOverridesAllowed: enforced throws names only; report and host_fallback allow", () => {
    const env = { HOME: { type: "plain", value: SENTINELS.BETTER_AUTH_SECRET }, TMPDIR: "/tmp/z" };
    let thrown: unknown;
    try { assertAgentEnvOverridesAllowed(env, { policy: "managed_only", adapterType: "hermes_local" }); }
    catch (error) { thrown = error; }
    expect(isAgentAuthPolicyError(thrown)).toBe(true);
    expect((thrown as AgentAuthPolicyError).code).toBe("agent_env_override_forbidden");
    expect((thrown as AgentAuthPolicyError).details.keys).toEqual(["HOME", "TMPDIR"]);
    expectNoSentinel((thrown as Error).message + JSON.stringify((thrown as AgentAuthPolicyError).details));
    expect(() => assertAgentEnvOverridesAllowed(env, { policy: "managed_only_report" })).not.toThrow();
    expect(() => assertAgentEnvOverridesAllowed(env, { policy: "host_fallback" })).not.toThrow();
    expect(() => assertAgentEnvOverridesAllowed({ FOO: "bar" }, { policy: "managed_only" })).not.toThrow();
  });

  it("process adapter credential key detection", () => {
    expect(findForbiddenProcessAdapterCredentialKeys({
      ANTHROPIC_API_KEY: "x", OPENAI_BASE_URL: "x", GITHUB_PERSONAL_ACCESS_TOKEN: "x", GH_TOKEN: "x",
      SSH_AUTH_SOCK: "x", GOOGLE_API_KEY: "x", KIMI_API_KEY: "x", MY_SETTING: "x",
    })).toEqual([
      "ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "GOOGLE_API_KEY", "KIMI_API_KEY", "OPENAI_BASE_URL", "SSH_AUTH_SOCK",
    ]);
    // Blanked values (the managed GitHub broker env clears these) carry no credential.
    expect(findForbiddenProcessAdapterCredentialKeys({ GH_TOKEN: "", GITHUB_TOKEN: " ", SSH_AUTH_SOCK: "" })).toEqual([]);
  });
});

describe("defaultAiConnectionForHire under the agent auth policy", () => {
  it("managed_only: an unbound manager's managed-capable hire still gets a responsible_user binding", () => {
    expect(defaultAiConnectionForHire("claude_local", {}, undefined, "managed_only")).toEqual({
      provider: "anthropic", method: "api_key", mode: "responsible_user",
    });
    expect(defaultAiConnectionForHire("codex_local", { env: { OPENAI_API_KEY: "x" } }, undefined, "managed_only")).toEqual({
      provider: "openai", method: "api_key", mode: "responsible_user",
    });
    // Non-managed adapters never get a binding.
    expect(defaultAiConnectionForHire("hermes_local", {}, undefined, "managed_only")).toBeUndefined();
  });

  it("host_fallback: an unbound manager keeps the legacy no-binding behaviour", () => {
    expect(defaultAiConnectionForHire("claude_local", {}, undefined, "host_fallback")).toBeUndefined();
    expect(defaultAiConnectionForHire("claude_local", {}, undefined, "managed_only_report")).toBeUndefined();
  });
});
