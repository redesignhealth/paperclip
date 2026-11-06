import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

/**
 * Regression: the cost regex captures `[\d.]+`, so reply prose such as "the total cost. Unknown"
 * captured "." and parseFloat produced NaN. A NaN costUsd fails the adapter result schema
 * (`costUsd: expected number, received NaN`) and marks a successful run as failed.
 */

let child: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string } = {
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
};

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({ signal: null, ...child })),
  };
});

function makeContext(): AdapterExecutionContext {
  return {
    runId: "run-cost-parse-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 30, graceSec: 2, env: { ANTHROPIC_API_KEY: "FAKE-KEY-FOR-TESTS-not-a-real-credential" } },
    context: { issueId: "issue-1", wakeReason: "manual" },
    authToken: "paperclip-run-token",
    onLog: async () => {},
    onSpawn: async () => {},
  } as unknown as AdapterExecutionContext;
}

describe("execute: cost parsing never yields a non-finite costUsd", () => {
  beforeEach(() => {
    child = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  });

  it.each([
    ["punctuation-only capture after 'cost'", "Total cost. Unknown for hermes runs.\n\nsession_id: s1"],
    ["ellipsis after 'spent'", "Budget spent... nothing yet.\n\nsession_id: s2"],
    ["dot-only capture", "cost: .\n\nsession_id: s3"],
  ])("omits costUsd for %s", async (_name, stdout) => {
    child.stdout = stdout;
    const result = await execute(makeContext());
    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBeUndefined();
    expect((result.resultJson as { cost_usd: number | null }).cost_usd).toBeNull();
  });

  it("still reports a real cost", async () => {
    child.stdout = "Done.\n\ncost: $0.42\n\nsession_id: s4";
    const result = await execute(makeContext());
    expect(result.costUsd).toBe(0.42);
    expect((result.resultJson as { cost_usd: number | null }).cost_usd).toBe(0.42);
  });

  it("keeps an explicit zero cost", async () => {
    child.stdout = "Done.\n\ncost: $0.00\n\nsession_id: s5";
    const result = await execute(makeContext());
    expect(result.costUsd).toBe(0);
  });
});
