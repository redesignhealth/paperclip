import { beforeEach, expect, it, vi } from "vitest";
import { testAgentSetup } from "./test-agent-setup";
const testEnvironment = vi.hoisted(() => vi.fn());
vi.mock("../api/agents", () => ({ agentsApi: { testEnvironment } }));
const input = {
  companyId: "company-1",
  agentId: "agent-1",
  adapterType: "paperclip_runner",
  providerAdapter: "claude_local",
  environmentId: "sandbox-1",
  adapterConfig: {
    provider: "acpx",
    acpxAgent: "claude",
    env: {
      ANTHROPIC_API_KEY: {
        type: "user_secret_ref",
        key: "ANTHROPIC_API_KEY",
        version: "latest",
      },
    },
  },
};
const ready = {
  adapterType: "paperclip_runner",
  status: "pass",
  testedAt: "now",
  checks: [{ code: "runtime", level: "info", message: "Ready" }],
};
beforeEach(() => testEnvironment.mockReset());
it("does not report a connection when runtime readiness passes but provider authentication fails", async () => {
  testEnvironment
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({
      ...ready,
      adapterType: "claude_local",
      status: "fail",
      checks: [
        {
          code: "claude_hello_probe_failed",
          level: "error",
          message: "Invalid API key",
        },
      ],
    });
  const result = await testAgentSetup(input);
  expect(result.status).toBe("fail");
  expect(result.adapterType).toBe("paperclip_runner");
  expect(testEnvironment).toHaveBeenLastCalledWith(
    "company-1",
    "claude_local",
    {
      agentId: "agent-1",
      environmentId: "sandbox-1",
      adapterConfig: { ...input.adapterConfig, engine: "cli" },
    },
  );
  expect(result.checks.map((check) => check.code)).toEqual([
    "runtime",
    "claude_hello_probe_failed",
  ]);
});
it("does not repeat a completed model probe", async () => {
  testEnvironment.mockResolvedValue({
    ...ready,
    checks: [
      { code: "codex_hello_probe_passed", level: "info", message: "Hello" },
    ],
  });
  await testAgentSetup({
    ...input,
    adapterType: "codex_local",
    providerAdapter: "codex_local",
  });
  expect(testEnvironment).toHaveBeenCalledTimes(1);
});
it("preserves runtime warnings after a successful provider request", async () => {
  testEnvironment
    .mockResolvedValueOnce({ ...ready, status: "warn" })
    .mockResolvedValueOnce(ready);
  expect((await testAgentSetup(input)).status).toBe("warn");
});
it("sends a create purpose only for a new-agent test and returns the server's createDefaults", async () => {
  const createDefaults = { provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true };
  testEnvironment.mockResolvedValue({ ...ready, adapterType: "hermes_local", createDefaults });
  const { agentId: _agentId, ...newAgent } = input;
  const result = await testAgentSetup({ ...newAgent, adapterType: "hermes_local", providerAdapter: "hermes_local", purpose: "create" });
  expect(testEnvironment.mock.calls[0][2]).toMatchObject({ purpose: "create" });
  expect(result.createDefaults).toEqual(createDefaults);
  testEnvironment.mockClear();
  // A saved-agent test never carries the create purpose.
  await testAgentSetup({ ...input, adapterType: "hermes_local", providerAdapter: "hermes_local", purpose: "create" });
  expect(testEnvironment.mock.calls[0][2]).not.toHaveProperty("purpose");
});
