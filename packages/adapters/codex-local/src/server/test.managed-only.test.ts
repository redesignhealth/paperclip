import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TECH-7095: under the enforced managed_only policy, Codex readiness inspects only what the
// child would receive. Sentinel host credentials (server env key + a fake host ~/.codex) must
// never be read, reported, or handed to a probe.

const SENTINEL_KEY = "sk-host-sentinel-codex-7095";
const SENTINEL_EMAIL = "host-sentinel-7095@example.invalid";

const { runAdapterExecutionTargetProcess, ensureAdapterExecutionTargetCommandResolvable } = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
  runAdapterExecutionTargetProcess: vi.fn(async (..._args: unknown[]) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}",
      "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
      "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess,
  };
});

import { testEnvironment } from "./test.js";
import { testCodexAcpEnvironment } from "./acp.js";

describe("codex readiness under the agent auth policy", () => {
  let fakeHostHome: string;
  let scratch: string;

  beforeEach(async () => {
    fakeHostHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fake-host-home-"));
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-policy-instance-"));
    await fs.mkdir(path.join(fakeHostHome, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(fakeHostHome, ".codex", "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: SENTINEL_KEY, email: SENTINEL_EMAIL }),
    );
    vi.stubEnv("HOME", fakeHostHome);
    vi.stubEnv("CODEX_HOME", path.join(fakeHostHome, ".codex"));
    vi.stubEnv("OPENAI_API_KEY", SENTINEL_KEY);
    vi.stubEnv("PAPERCLIP_HOME", scratch);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(fakeHostHome, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  });

  function expectNoHostLeak(value: unknown) {
    const text = JSON.stringify(value);
    expect(text).not.toContain(SENTINEL_KEY);
    expect(text).not.toContain(SENTINEL_EMAIL);
    expect(text).not.toContain(fakeHostHome);
  }

  it("managed_only + unbound: reports ai_connection_required and never probes host auth", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "managed_only");
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
    });
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("ai_connection_required");
    expect(result.checks.find((c) => c.code === "ai_connection_required")?.level).toBe("error");
    expect(result.status).toBe("fail");
    expect(codes).not.toContain("codex_openai_api_key_present");
    expect(codes).not.toContain("codex_native_auth_present");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    expectNoHostLeak(result);
  });

  it("managed_only + explicit config.env key: probe gets an isolated HOME and no host sentinel", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "managed_only");
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex", env: { OPENAI_API_KEY: "sk-explicit-binding" } },
    });
    expect(result.checks.map((c) => c.code)).toContain("codex_openai_api_key_present");
    expect(result.checks.find((c) => c.code === "codex_openai_api_key_present")?.detail).toBe(
      "Detected in adapter config env.",
    );
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const options = runAdapterExecutionTargetProcess.mock.calls[0]?.[4] as { env: Record<string, string> };
    expect(options.env.HOME).toBeTruthy();
    expect(options.env.HOME).not.toBe(fakeHostHome);
    expect(options.env.HOME).toContain("paperclip-run-home-probe-");
    expect(options.env.CODEX_HOME).not.toBe(path.join(fakeHostHome, ".codex"));
    expect(JSON.stringify(options.env)).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(options.env)).not.toContain(fakeHostHome);
    // The probe home is removed after the probe.
    await expect(fs.stat(options.env.HOME)).rejects.toThrow();
    expectNoHostLeak(result);
  });

  it("managed_only + managed connection: no ai_connection_required", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "managed_only");
    const managedHome = await fs.mkdtemp(path.join(scratch, "managed-codex-"));
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
        env: { CODEX_HOME: managedHome },
        managedAiConnection: { method: "subscription" },
      },
    });
    expect(result.checks.map((c) => c.code)).not.toContain("ai_connection_required");
    const options = runAdapterExecutionTargetProcess.mock.calls[0]?.[4] as { env: Record<string, string> };
    expect(options.env.CODEX_HOME).toBe(managedHome);
    expect(options.env.HOME).not.toBe(fakeHostHome);
    expectNoHostLeak(result);
  });

  it("host_fallback keeps legacy host key detection", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "host_fallback");
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
    });
    const present = result.checks.find((c) => c.code === "codex_openai_api_key_present");
    expect(present?.detail).toBe("Detected in server environment.");
    expect(result.checks.map((c) => c.code)).not.toContain("ai_connection_required");
    const options = runAdapterExecutionTargetProcess.mock.calls[0]?.[4] as { env: Record<string, string> };
    // Legacy: no isolated probe HOME is injected.
    expect(options.env.HOME).toBeUndefined();
  });

  it("managed_only_report keeps legacy detection and adds an info ai_connection_required", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "managed_only_report");
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
    });
    const report = result.checks.find((c) => c.code === "ai_connection_required");
    expect(report?.level).toBe("info");
    expect(result.checks.map((c) => c.code)).toContain("codex_openai_api_key_present");
  });

  describe("ACP readiness", () => {
    it("managed_only + unbound: ai_connection_required, host key never reported", async () => {
      vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "managed_only");
      const result = await testCodexAcpEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "acp", agentCommand: process.execPath },
      });
      const codes = result.checks.map((c) => c.code);
      expect(codes).toContain("ai_connection_required");
      expect(codes).not.toContain("codex_acp_openai_api_key_detected");
      expect(codes).not.toContain("codex_acp_native_auth_detected");
      expectNoHostLeak(result);
    });

    it("managed_only + explicit key: detected from adapter config env only", async () => {
      vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "managed_only");
      const result = await testCodexAcpEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "acp", agentCommand: process.execPath, env: { OPENAI_API_KEY: "sk-explicit" } },
      });
      const detected = result.checks.find((c) => c.code === "codex_acp_openai_api_key_detected");
      expect(detected?.detail).toBe("Detected in adapter config env.");
      expect(result.checks.map((c) => c.code)).not.toContain("ai_connection_required");
      expectNoHostLeak(result);
    });

    it("host_fallback keeps the legacy server-environment detection", async () => {
      vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "host_fallback");
      const result = await testCodexAcpEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "acp", agentCommand: process.execPath },
      });
      const detected = result.checks.find((c) => c.code === "codex_acp_openai_api_key_detected");
      expect(detected?.detail).toBe("Detected in server environment.");
    });
  });
});
