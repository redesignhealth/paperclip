import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { runAdapterExecutionTargetProcess, probeResult } = vi.hoisted(() => {
  const probeResult = { stdout: "", exitCode: 0 };
  return {
    probeResult,
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: probeResult.exitCode,
      signal: null,
      timedOut: false,
      stdout: probeResult.stdout,
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    })),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return { ...actual, runAdapterExecutionTargetProcess };
});

import { testEnvironment } from "./test.js";
import { probeClaudeAcpSandboxLogin, resolveClaudeAcpBillingIdentity, testClaudeAcpEnvironment } from "./acp.js";

const SENTINEL = "tech7095-claude-host-sentinel";
const HOST_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
];
const SAVED_KEYS = ["PAPERCLIP_AGENT_AUTH_POLICY", "HOME", "PATH", ...HOST_KEYS];

const helloStdout = [
  '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"abc","tools":[]}',
  '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
].join("\n");

let saved: Record<string, string | undefined> = {};
let fakeHome = "";
let binDir = "";

function spawnedEnvs(): Record<string, string>[] {
  return runAdapterExecutionTargetProcess.mock.calls.map(
    (call) => ((call as unknown as unknown[])[4] as { env: Record<string, string> }).env,
  );
}

beforeEach(async () => {
  saved = {};
  for (const key of SAVED_KEYS) saved[key] = process.env[key];
  fakeHome = await mkdtemp(path.join(os.tmpdir(), "tech7095-claude-fake-home-"));
  await mkdir(path.join(fakeHome, ".claude"), { recursive: true });
  await writeFile(path.join(fakeHome, ".claude", ".credentials.json"), JSON.stringify({ token: SENTINEL }));
  binDir = await mkdtemp(path.join(os.tmpdir(), "tech7095-claude-bin-"));
  await writeFile(path.join(binDir, "claude"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(binDir, "claude"), 0o755);
  process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
  process.env.HOME = fakeHome;
  process.env.ANTHROPIC_API_KEY = SENTINEL;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = SENTINEL;
  process.env.ANTHROPIC_AUTH_TOKEN = SENTINEL;
  process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, ".claude");
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
  probeResult.stdout = helloStdout;
  probeResult.exitCode = 0;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.clearAllMocks();
  await rm(fakeHome, { recursive: true, force: true });
  await rm(binDir, { recursive: true, force: true });
});

function expectNoHostLeak(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain(fakeHome);
}

describe("claude readiness under managed_only (TECH-7095)", () => {
  for (const engine of ["cli", "acp"] as const) {
    it(`${engine}: unbound agent reports ai_connection_required and never probes host auth`, async () => {
      process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: { engine, command: "claude", agentCommand: process.execPath },
        executionTarget: null,
        environmentName: null,
      });
      expect(result.status).toBe("fail");
      expect(result.checks).toContainEqual(expect.objectContaining({ code: "ai_connection_required", level: "error" }));
      expect(result.checks.some((c) => /server environment/.test(c.detail ?? ""))).toBe(false);
      expect(result.checks.some((c) => c.code.includes("subscription_mode_possible"))).toBe(false);
      expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
      expectNoHostLeak(result);
    });

    it(`${engine}: explicit binding probes with an isolated home and no host credentials`, async () => {
      process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: {
          engine,
          command: "claude",
          agentCommand: process.execPath,
          env: { CLAUDE_CODE_OAUTH_TOKEN: "explicit-bound-token", CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude") },
        },
        executionTarget: null,
        environmentName: null,
      });
      expect(result.checks.some((c) => c.code === "ai_connection_required")).toBe(false);
      const envs = spawnedEnvs();
      expect(envs.length).toBeGreaterThan(0);
      for (const env of envs) {
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("explicit-bound-token");
        expect(env.HOME).toBeTruthy();
        expect(env.HOME).not.toBe(fakeHome);
        expect(env.HOME).toContain("paperclip-run-home-probe-");
        expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expectNoHostLeak(env);
        // The probe home is removed after the probe.
        await expect(stat(env.HOME)).rejects.toThrow();
      }
      expectNoHostLeak(result);
    });
  }

  it("acp: a managed connection keeps its provider CLAUDE_CONFIG_DIR in the isolated probe", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const providerDir = "/tmp/paperclip-ai-provider-home";
    await probeClaudeAcpSandboxLogin({
      config: {
        engine: "acp",
        managedAiConnection: { method: "subscription" },
        env: { CLAUDE_CONFIG_DIR: providerDir },
      },
      target: null,
    });
    const [env] = spawnedEnvs();
    expect(env?.CLAUDE_CONFIG_DIR).toBe(providerDir);
    expect(env?.HOME).not.toBe(fakeHome);
    expectNoHostLeak(env);
  });

  it("acp billing: managed_only unbound is unknown; managed and explicit keys are resolved", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    expect(resolveClaudeAcpBillingIdentity({ config: {} }).billingType).toBe("unknown");
    expect(resolveClaudeAcpBillingIdentity({ config: { managedAiConnection: { method: "subscription" } } }).billingType)
      .toBe("subscription");
    expect(resolveClaudeAcpBillingIdentity({ config: { managedAiConnection: { method: "api_key" } } }).billingType)
      .toBe("api");
    expect(resolveClaudeAcpBillingIdentity({ config: { env: { ANTHROPIC_API_KEY: "k" } } }).billingType).toBe("api");
    expect(resolveClaudeAcpBillingIdentity({ config: { env: { CLAUDE_CODE_USE_BEDROCK: "1" } } }).billingType)
      .toBe("metered_api");
  });

  it("acp billing: host_fallback keeps the legacy unbound => subscription mapping", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    expect(resolveClaudeAcpBillingIdentity({ config: {} }).billingType).toBe("subscription");
    expect(resolveClaudeAcpBillingIdentity({ config: { env: { ANTHROPIC_API_KEY: "k" } } }).billingType).toBe("api");
  });
});

describe("claude readiness under host_fallback keeps the legacy host detection", () => {
  it("cli: detects the host ANTHROPIC_API_KEY from the server environment", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: null,
      environmentName: null,
    });
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_anthropic_api_key_overrides_subscription",
      detail: "Detected in server environment.",
    }));
    expect(result.checks.some((c) => c.code === "ai_connection_required")).toBe(false);
    expect(JSON.stringify(result.checks)).not.toContain(SENTINEL);
  });

  it("acp: still seeds the host credential into the local probe", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    delete process.env.ANTHROPIC_API_KEY;
    await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", agentCommand: process.execPath },
      executionTarget: null,
      environmentName: null,
    });
    const [env] = spawnedEnvs();
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(SENTINEL);
  });

  it("managed_only_report: legacy probe plus an informational ai_connection_required", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only_report";
    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", agentCommand: process.execPath },
      executionTarget: null,
      environmentName: null,
    });
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "ai_connection_required", level: "info" }));
    expect(JSON.stringify(result.checks)).not.toContain(SENTINEL);
  });
});
