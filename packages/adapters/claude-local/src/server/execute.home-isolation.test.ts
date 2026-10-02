import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeClaudeAcp } = vi.hoisted(() => ({
  executeClaudeAcp: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  // ACP is the default engine.
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "acp", explicit: false }),
}));

import { execute } from "./execute.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PAPERCLIP_AGENT_AUTH_POLICY;
  executeClaudeAcp.mockClear();
});
afterEach(() => {
  if (saved === undefined) delete process.env.PAPERCLIP_AGENT_AUTH_POLICY;
  else process.env.PAPERCLIP_AGENT_AUTH_POLICY = saved;
});

function ctx(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: { id: "a", companyId: "c", name: "A", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {},
    onLog: async () => {},
    ...extra,
  } as never;
}

describe("claude ACP engine requires an isolated HOME under managed_only (TECH-7095)", () => {
  it("refuses a local ACP run with no config.env.HOME before the ACP executor starts", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    await expect(execute(ctx())).rejects.toMatchObject({ code: "agent_home_isolation_required" });
    expect(executeClaudeAcp).not.toHaveBeenCalled();
  });

  it("refuses an empty/whitespace HOME the same way", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    await expect(execute(ctx({ env: { HOME: "   " } }))).rejects.toMatchObject({ code: "agent_home_isolation_required" });
    expect(executeClaudeAcp).not.toHaveBeenCalled();
  });

  it("runs the ACP executor when the run supplies its own HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    await execute(ctx({ env: { HOME: "/tmp/paperclip-run-home-x" } }));
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
  });

  it("does not require a HOME under host_fallback or managed_only_report (legacy)", async () => {
    for (const policy of ["host_fallback", "managed_only_report"]) {
      process.env.PAPERCLIP_AGENT_AUTH_POLICY = policy;
      executeClaudeAcp.mockClear();
      await execute(ctx());
      expect(executeClaudeAcp, policy).toHaveBeenCalledTimes(1);
    }
  });
});
