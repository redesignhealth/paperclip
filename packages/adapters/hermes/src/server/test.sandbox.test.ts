/**
 * TECH-8174: testEnvironment on a remote target probes inside the target (never this host's
 * Hermes, python3 or ~/.hermes), and applies the same gates as a sandbox run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const h = vi.hoisted(() => ({
  processCalls: [] as Array<{ command: string; args: string[]; env: Record<string, string> }>,
  resolvable: vi.fn(async () => {}),
  execFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: h.execFile };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: h.resolvable,
    runAdapterExecutionTargetProcess: vi.fn(async (_runId: string, _t: unknown, command: string, args: string[], options: { env: Record<string, string> }) => {
      h.processCalls.push({ command, args, env: options.env });
      return { exitCode: 0, signal: null, timedOut: false, stdout: "Hermes Agent v0.19.0-pod\n", stderr: "", pid: null, startedAt: new Date().toISOString() };
    }),
  };
});

import { testEnvironment } from "./test.js";
import { HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE } from "./execute-sandbox.js";

const sandboxTarget: AdapterExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "kubernetes", remoteCwd: "/workspace" };

function run(config: Record<string, unknown>, executionTarget: AdapterExecutionTarget = sandboxTarget) {
  return testEnvironment({ companyId: "c", adapterType: "hermes_local", config, executionTarget, environmentName: "eks-proof" });
}

afterEach(() => {
  vi.clearAllMocks();
  h.processCalls.length = 0;
});

describe("hermes testEnvironment on a remote target (TECH-8174)", () => {
  it("runs hermes --version inside the sandbox and nothing on the host", async () => {
    const result = await run({ provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" } });
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.resolvable).toHaveBeenCalledWith("/opt/hermes/bin/hermes", sandboxTarget, "/workspace", {});
    expect(h.processCalls).toEqual([{ command: "/opt/hermes/bin/hermes", args: ["--version"], env: {} }]);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "hermes_environment_target", message: "Probing inside environment: eks-proof" }),
      expect.objectContaining({ code: "hermes_version", message: "Hermes Agent version: Hermes Agent v0.19.0-pod" }),
      expect.objectContaining({ code: "hermes_model_configured" }),
    ]));
    expect(result.status).toBe("pass");
  });

  it("fails when the image has no Hermes", async () => {
    h.resolvable.mockRejectedValueOnce(new Error('Command "/opt/hermes/bin/hermes" is not installed'));
    const result = await run({ provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" } });
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "hermes_cli_not_found" })]));
    expect(h.processCalls).toHaveLength(0);
  });

  it("reports the run's gates: missing credential and memory provider", async () => {
    const result = await run({ provider: "openai-api", model: "gpt-5.4", memoryProvider: "mem0", env: {} });
    expect(result.status).toBe("fail");
    expect(result.checks.map((c) => c.code)).toEqual(expect.arrayContaining([
      "hermes_memory_sandbox_unsupported",
      "hermes_explicit_credential_required",
    ]));
  });

  it("refuses a Router config before launching anything", async () => {
    const result = await run({ provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "rr-x" } });
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "hermes_router_remote_unsupported" }),
    ]));
    expect(h.processCalls).toHaveLength(0);
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it("refuses an SSH target", async () => {
    const ssh = { kind: "remote", transport: "ssh", remoteCwd: "/srv", spec: {} } as unknown as AdapterExecutionTarget;
    const result = await run({ provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" } }, ssh);
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([expect.objectContaining({ code: "hermes_ssh_unsupported", message: HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE })]);
    expect(h.processCalls).toHaveLength(0);
    expect(h.execFile).not.toHaveBeenCalled();
  });
});
