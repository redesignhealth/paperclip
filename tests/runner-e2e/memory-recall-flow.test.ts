import { describe, expect, it, vi } from "vitest";
import { runMemoryRecallFlow } from "./memory-recall-flow.js";
import { memoryRecallScenario } from "./memory-recall-cases.js";
import type { RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
import type { TenantMemoryReader } from "./memory-recall-observation.js";

function makeExecution(caseId: string, rep = 1): MatrixExecution {
  return {
    id: `memory-recall.memory-hermes-local.local.${caseId}-rep-${rep}`,
    suite: { id: "memory-recall" } as any,
    profile: {
      id: "memory-hermes-local",
      model: "openrouter/anthropic/claude-3.5-sonnet",
      buildAgent: () => ({ name: "Agent" }),
    } as any,
    environment: { id: "local" } as any,
    task: { id: `${caseId}-rep-${rep}`, flow: "memory_recall" } as any,
    requiredCredentials: ["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
    groups: [],
    suiteDefinitionHash: "dummy-hash",
  };
}

function makeFixtures(): LiveFixtureValues {
  return {
    company: { id: "11111111-1111-4111-8111-111111111111", issuePrefix: "TST" },
    agent: {
      id: "agent-x-id",
      adapterConfig: { model: "anthropic/claude-3.5-sonnet" },
    },
    environment: { id: "local" },
    secretRefs: {},
  } as any;
}

function makeStubTenantReader(memories: any[] = []): TenantMemoryReader {
  return {
    snapshotMemoryIds: vi.fn().mockResolvedValue(new Set()),
    readMemoriesSince: vi.fn().mockResolvedValue(memories),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("memory-recall flow unit tests", () => {
  it("(1) propagates 404 HTTP errors without swallowing", async () => {
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockRejectedValue(new Error("HTTP 404: Route not found")),
      get: vi.fn().mockResolvedValue([]),
    };

    const flowPromise = runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "err-404",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockResolvedValue(undefined),
    });

    await expect(flowPromise).rejects.toThrow("HTTP 404: Route not found");
  });

  it("(2) grades runs strictly by issueId despite interleaving and foreign runs", async () => {
    const postedIssues: any[] = [];
    let issueCounter = 0;

    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        if (path.endsWith("/issues")) {
          issueCounter++;
          const issue = { id: `issue-${issueCounter}`, ...body };
          postedIssues.push(issue);
          return issue;
        }
        return { id: "other" };
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          // Interleaved runs including a foreign run from another issue
          return [
            { id: "run-foreign", issueId: "unrelated-issue-999", status: "succeeded", agentId: "agent-x-id" },
            { id: "run-save", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" },
            { id: "run-recall", issueId: "issue-2", status: "succeeded", agentId: "agent-x-id" },
          ];
        }
        if (path === "/api/heartbeat-runs/run-save") {
          return {
            id: "run-save",
            issueId: "issue-1",
            status: "succeeded",
            agentId: "agent-x-id",
            resultJson: { result: "Saved codename-test-xyz" },
          };
        }
        if (path === "/api/heartbeat-runs/run-recall") {
          return {
            id: "run-recall",
            issueId: "issue-2",
            status: "succeeded",
            agentId: "agent-x-id",
            resultJson: { result: "The codename is codename-test-xyz." },
          };
        }
        if (path.endsWith("/log")) {
          return {
            content: [
              "12:00:01 - agent.tool_executor - INFO - tool mem0_add completed (1.00s, 30 chars)",
              "12:00:02 - agent.tool_executor - INFO - tool mem0_search completed (0.80s, 20 chars)",
            ].join("\n"),
          };
        }
        if (path.includes("/comments")) {
          return [];
        }
        return [];
      }),
    };

    const stubReader = makeStubTenantReader([
      { id: "mem-1", data: "release codename is codename-test-xyz" },
    ]);

    const result = await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "test-xyz",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 60_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => stubReader,
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]?.id).toBe("run-save");
    expect(result.runs[1]?.id).toBe("run-recall");
  });

  it("(3) throws before issue Y if agent-y setup returns no ID", async () => {
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string) => {
        if (path.endsWith("/agents")) {
          return {}; // missing id!
        }
        return { id: "issue-1" };
      }),
      get: vi.fn().mockResolvedValue([]),
    };

    const flowPromise = runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("cross-agent-leak"),
      nonce: "leak-test",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockResolvedValue(undefined),
    });

    await expect(flowPromise).rejects.toThrow(/Agent Y setup failed/);
  });

  it("(4) excludes run when run agentId is undefined/unknown and fails scoring gracefully", async () => {
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => ({
        id: "issue-1",
        ...body,
      })),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [{ id: "run-1", issueId: "issue-1", status: "succeeded" }];
        }
        if (path === "/api/heartbeat-runs/run-1") {
          return { id: "run-1", issueId: "issue-1", status: "succeeded", agentId: undefined };
        }
        return [];
      }),
    };

    const result = await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "agent-id-test",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.runs).toHaveLength(0);
    expect(result.scoreResult.passed).toBe(false);
    expect(result.scoreResult.checks.find((c) => c.id === "runs-recorded")?.passed).toBe(false);
  });

  it("(5) implicit-recall control run uses controlPrompt and precedes seed", async () => {
    const postedIssues: any[] = [];
    const scenario = memoryRecallScenario("implicit-recall", "implicit-nonce");

    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        if (path.endsWith("/issues")) {
          const issue = { id: `issue-${postedIssues.length + 1}`, ...body };
          postedIssues.push(issue);
          return issue;
        }
        return { id: "agent-1" };
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return postedIssues.map((issue) => ({
            id: `run-for-${issue.id}`,
            issueId: issue.id,
            status: "succeeded",
            agentId: "agent-x-id",
          }));
        }
        if (path.startsWith("/api/heartbeat-runs/")) {
          return {
            id: "run",
            agentId: "agent-x-id",
            status: "succeeded",
            resultJson: { result: "response" },
          };
        }
        return [];
      }),
    };

    await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("implicit-recall"),
      nonce: "implicit-nonce",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 60_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockResolvedValue(undefined),
    });

    expect(postedIssues).toHaveLength(3);
    // 1st: Control run with controlPrompt
    expect(postedIssues[0]?.description).toBe(scenario.controlPrompt);
    // 2nd: Seed run with seedPrompt
    expect(postedIssues[1]?.description).toBe(scenario.seedPrompt);
    // 3rd: Ask run with askPrompt
    expect(postedIssues[2]?.description).toBe(scenario.askPrompt);
  });

  it("(6) writes evidence, calls observe, drops tenant DB, and tears down fixtures when pollUntil rejects", async () => {
    const dropper = vi.fn().mockResolvedValue(undefined);
    const observer = vi.fn();
    const evidenceWriter = vi.fn().mockResolvedValue(undefined);

    const api: Partial<RunnerApi> = {
      post: vi.fn().mockResolvedValue({ id: "issue-save" }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          // Never returns succeeded/failed run -> pollUntil times out
          return [{ id: "run-running", issueId: "issue-save", status: "running" }];
        }
        return [];
      }),
    };

    const flowPromise = runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "timeout-test",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 50, // fast timeout
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: dropper,
      observe: observer,
      evidence: evidenceWriter,
    });

    await expect(flowPromise).rejects.toThrow();

    // Verify all cleanup and evidence callbacks ran
    expect(observer).toHaveBeenCalled();
    expect(evidenceWriter).toHaveBeenCalled();
    expect(dropper).toHaveBeenCalled();
  });

  it("(7) noise creates exactly 10 issues and polls per id without parent issue", async () => {
    const postedIssues: any[] = [];
    const scenario = memoryRecallScenario("noise", "noise-nonce");

    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        if (path.endsWith("/issues")) {
          const issue = { id: `issue-noise-${postedIssues.length + 1}`, ...body };
          postedIssues.push(issue);
          return issue;
        }
        return {};
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return postedIssues.map((issue) => ({
            id: `run-${issue.id}`,
            issueId: issue.id,
            status: "succeeded",
            agentId: "agent-x-id",
          }));
        }
        if (path.startsWith("/api/heartbeat-runs/")) {
          return {
            id: "run-noise",
            agentId: "agent-x-id",
            status: "succeeded",
            resultJson: { result: "ok" },
          };
        }
        return [];
      }),
    };

    await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("noise"),
      nonce: "noise-nonce",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockResolvedValue(undefined),
    });

    // Exactly 10 heartbeat issues, no parent issue
    expect(postedIssues).toHaveLength(10);
    if (scenario.caseId === "noise") {
      for (let i = 0; i < 10; i++) {
        expect(postedIssues[i]?.description).toBe(scenario.heartbeatPrompts[i]);
      }
    }
  });

  it("(8) binds issues to expected agent and excludes wrong-agent runs", async () => {
    let issueCount = 0;
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        issueCount++;
        return { id: `issue-${issueCount}`, ...body };
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [
            { id: "run-wrong", issueId: "issue-1", status: "succeeded", agentId: "intruder-agent" },
            { id: "run-wrong-2", issueId: "issue-2", status: "succeeded", agentId: "intruder-agent" },
          ];
        }
        if (path.startsWith("/api/heartbeat-runs/")) {
          return { id: "run-wrong", status: "succeeded", agentId: "intruder-agent" };
        }
        return [];
      }),
    };

    const result = await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "wrong-agent-test",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockResolvedValue(undefined),
    });

    // Wrong-agent runs must never be admitted into mappedRuns or satisfy scoring
    expect(result.runs).toHaveLength(0);
    expect(result.scoreResult.passed).toBe(false);
    expect(result.scoreResult.checks.find((c) => c.id === "runs-recorded")?.passed).toBe(false);
  });

  it("(9) selects comments only through exact run attribution", async () => {
    let capturedEvidence: any = null;
    let postCount = 0;
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        postCount++;
        return { id: postCount === 1 ? "issue-save" : "issue-recall", ...body };
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [
            { id: "run-save", issueId: "issue-save", status: "succeeded", agentId: "agent-x-id", startedAt: "2026-01-01T00:00:00Z" },
            { id: "run-recall", issueId: "issue-recall", status: "succeeded", agentId: "agent-x-id", startedAt: "2026-01-01T00:01:00Z" },
          ];
        }
        if (path === "/api/heartbeat-runs/run-save") {
          return { id: "run-save", issueId: "issue-save", status: "succeeded", agentId: "agent-x-id" };
        }
        if (path === "/api/heartbeat-runs/run-recall") {
          return { id: "run-recall", issueId: "issue-recall", status: "succeeded", agentId: "agent-x-id" };
        }
        if (path === "/api/issues/issue-save/comments?order=asc") {
          return [
            { id: "c1", createdByRunId: "run-save", authorAgentId: "agent-x-id", body: "attributed to terminal run" },
            { id: "c2", createdByRunId: "other-run", authorAgentId: "agent-x-id", body: "attributed to prior run" },
            { id: "c3", createdByRunId: null, authorAgentId: null, body: "unattributed user comment" },
            { id: "c4", createdByRunId: "run-save", authorAgentId: "foreign-agent", body: "wrong agent comment" },
          ];
        }
        return [];
      }),
    };

    await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "comment-attr",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockImplementation(async (_name, val) => {
        capturedEvidence = val;
      }),
    });

    expect(capturedEvidence).toBeDefined();
    // Only c1 matched run-recall with agent-x-id
    expect(capturedEvidence.observation.commentCount).toBe(1);
  });

  it("(10) propagates observation failures after execution", async () => {
    // 10a: pre-run non-database error throws
    const nonDbErrorFactory = async () => {
      const err = new Error("Connection refused ECONNREFUSED");
      (err as any).code = "ECONNREFUSED";
      throw err;
    };
    await expect(
      runMemoryRecallFlow({
        api: { post: vi.fn(), get: vi.fn() } as any,
        fixtures: makeFixtures(),
        execution: makeExecution("save-then-fresh-recall"),
        nonce: "nondb-test",
        workspacePath: "/tmp/ws",
        deadlineAt: Date.now() + 10_000,
        skipPreflightProbe: true,
        tenantReaderFactory: nonDbErrorFactory,
        observe: vi.fn(),
        evidence: vi.fn(),
      }),
    ).rejects.toThrow("ECONNREFUSED");

    // 10b: post-run run summary poll failure propagates
    const failSummaryApi: Partial<RunnerApi> = {
      post: vi.fn().mockResolvedValue({ id: "issue-1" }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          throw new Error("HTTP 500: Failed to fetch heartbeat runs");
        }
        return [];
      }),
    };
    await expect(
      runMemoryRecallFlow({
        api: failSummaryApi as RunnerApi,
        fixtures: makeFixtures(),
        execution: makeExecution("save-then-fresh-recall"),
        nonce: "summary-fail",
        workspacePath: "/tmp/ws",
        deadlineAt: Date.now() + 10_000,
        skipPreflightProbe: true,
        tenantReaderFactory: async () => makeStubTenantReader(),
        tenantDropper: async () => {},
        observe: vi.fn(),
        evidence: vi.fn(),
      }),
    ).rejects.toThrow("HTTP 500: Failed to fetch heartbeat runs");

    // 10c: post-run comment fetch failure propagates
    const failCommentApi: Partial<RunnerApi> = {
      post: vi.fn().mockResolvedValue({ id: "issue-1" }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [{ id: "run-1", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" }];
        }
        if (path === "/api/heartbeat-runs/run-1") {
          return { id: "run-1", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" };
        }
        if (path.includes("/comments")) {
          throw new Error("HTTP 502: Comment service unavailable");
        }
        return [];
      }),
    };
    await expect(
      runMemoryRecallFlow({
        api: failCommentApi as RunnerApi,
        fixtures: makeFixtures(),
        execution: makeExecution("save-then-fresh-recall"),
        nonce: "comment-fail",
        workspacePath: "/tmp/ws",
        deadlineAt: Date.now() + 10_000,
        skipPreflightProbe: true,
        tenantReaderFactory: async () => makeStubTenantReader(),
        tenantDropper: async () => {},
        observe: vi.fn(),
        evidence: vi.fn(),
      }),
    ).rejects.toThrow("HTTP 502: Comment service unavailable");
  });

  it("(11) aggregates cleanup failures and preserves primary failure", async () => {
    let postCount = 0;
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        postCount++;
        return { id: `issue-${postCount}`, ...body };
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [
            { id: "run-1", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" },
            { id: "run-2", issueId: "issue-2", status: "succeeded", agentId: "agent-x-id" },
          ];
        }
        if (path.startsWith("/api/heartbeat-runs/")) {
          return { id: "run-1", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" };
        }
        return [];
      }),
    };

    // Dropper failure alone throws
    await expect(
      runMemoryRecallFlow({
        api: api as RunnerApi,
        fixtures: makeFixtures(),
        execution: makeExecution("save-then-fresh-recall"),
        nonce: "drop-fail",
        workspacePath: "/tmp/ws",
        deadlineAt: Date.now() + 10_000,
        skipPreflightProbe: true,
        tenantReaderFactory: async () => makeStubTenantReader(),
        tenantDropper: async () => {
          throw new Error("PostgreSQL drop database error: permission denied");
        },
        observe: vi.fn(),
        evidence: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow(/PostgreSQL drop database error/);

    // Scenario failure + dropper failure aggregates both
    const failScenarioApi: Partial<RunnerApi> = {
      post: vi.fn().mockRejectedValue(new Error("Primary scenario POST failure")),
      get: vi.fn().mockResolvedValue([]),
    };

    let caughtError: any = null;
    try {
      await runMemoryRecallFlow({
        api: failScenarioApi as RunnerApi,
        fixtures: makeFixtures(),
        execution: makeExecution("save-then-fresh-recall"),
        nonce: "both-fail",
        workspacePath: "/tmp/ws",
        deadlineAt: Date.now() + 10_000,
        skipPreflightProbe: true,
        tenantReaderFactory: async () => makeStubTenantReader(),
        tenantDropper: async () => {
          throw new Error("Cleanup drop failure");
        },
        observe: vi.fn(),
        evidence: vi.fn().mockResolvedValue(undefined),
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    expect(caughtError.errors).toHaveLength(2);
    expect(String(caughtError.errors[0])).toContain("Primary scenario POST failure");
    expect(String(caughtError.errors[1])).toContain("Cleanup drop failure");
  });

  it("(12) removes all raw memory text from serialized evidence (no dataExcerpt) and prevents secret leaks", async () => {
    let capturedEvidence: any = null;
    const secretContent = "TOP_SECRET_CREDENTIAL_XYZ_99999";
    const stubReader = makeStubTenantReader([
      { id: "mem-secret", data: `The master key is ${secretContent}` },
    ]);

    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => ({
        id: "issue-1",
        ...body,
      })),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [
            { id: "run-save", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" },
            { id: "run-recall", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" },
          ];
        }
        if (path.startsWith("/api/heartbeat-runs/")) {
          return { id: "run-detail", agentId: "agent-x-id", status: "succeeded" };
        }
        return [];
      }),
    };

    await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "secrets-hygiene",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => stubReader,
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockImplementation(async (_name, val) => {
        capturedEvidence = val;
      }),
    });

    expect(capturedEvidence).toBeDefined();
    const serialized = JSON.stringify(capturedEvidence);

    // Verify raw secret and prefix excerpts are completely absent
    expect(serialized).not.toContain(secretContent);
    expect(serialized).not.toContain("dataExcerpt");

    // Verify lengths and hashes exist instead
    expect(capturedEvidence.observation.memories[0]).toMatchObject({
      dataLength: `The master key is ${secretContent}`.length,
      dataHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    // Verify graderVersion and contentDigest provenance
    expect(capturedEvidence.graderVersion).toBe("paperclip.memory-recall.v1");
    expect(capturedEvidence.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(capturedEvidence.resolvedModel).toBeDefined();
  });

  it("(13) fails closed on preflight when server boot proof is required but missing", async () => {
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockResolvedValue([]),
    };

    await expect(
      runMemoryRecallFlow({
        api: api as RunnerApi,
        fixtures: makeFixtures(),
        execution: makeExecution("save-then-fresh-recall"),
        nonce: "fail-closed",
        workspacePath: "/tmp/ws",
        deadlineAt: Date.now() + 10_000,
        skipPreflightProbe: false, // Live mode requiring boot proof
        tenantReaderFactory: async () => makeStubTenantReader(),
        tenantDropper: async () => {},
        observe: vi.fn(),
        evidence: vi.fn(),
      }),
    ).rejects.toThrow(/server boot proof is required/);
  });

  it("(14) post-run lazy missing database tolerates 3D000 as empty observation", async () => {
    let callCount = 0;
    const lazyMissingReaderFactory = async () => {
      callCount++;
      if (callCount === 1) {
        // Pre-run snapshot
        return makeStubTenantReader();
      }
      // Post-run observation: DB does not exist (3D000)
      const err = new Error('database "pcmem_abc" does not exist');
      (err as any).code = "3D000";
      throw err;
    };

    let postCount = 0;
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        postCount++;
        return { id: `issue-${postCount}`, ...body };
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [
            { id: "run-1", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" },
            { id: "run-2", issueId: "issue-2", status: "succeeded", agentId: "agent-x-id" },
          ];
        }
        if (path.startsWith("/api/heartbeat-runs/")) {
          return { id: "run-detail", agentId: "agent-x-id", status: "succeeded", toolRecords: [] };
        }
        return [];
      }),
    };

    let capturedEvidence: any = null;
    const result = await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "lazy-post-run",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: lazyMissingReaderFactory,
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockImplementation(async (_name, val) => {
        capturedEvidence = val;
      }),
    });

    expect(capturedEvidence.observation.memoryCount).toBe(0);
    expect(capturedEvidence.observation.memories).toEqual([]);
    expect(result).toBeDefined();
  });

  it("(15) aggregates scenario error and observation error when both fail", async () => {
    let callCount = 0;
    const failObsReaderFactory = async () => {
      callCount++;
      if (callCount === 1) return makeStubTenantReader();
      // Post-run observation throws non-lazy error
      const err = new Error("Connection refused ECONNREFUSED");
      (err as any).code = "ECONNREFUSED";
      throw err;
    };

    const api: Partial<RunnerApi> = {
      post: vi.fn().mockResolvedValue({ id: "issue-1" }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          // Terminal run ended in failure -> causes scenarioError
          return [{ id: "run-failed", issueId: "issue-1", status: "failed", agentId: "agent-x-id" }];
        }
        return [];
      }),
    };

    const flowPromise = runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "agg-err",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: failObsReaderFactory,
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn(),
    });

    await expect(flowPromise).rejects.toThrow(AggregateError);
    await expect(flowPromise).rejects.toThrow(/Both scenario execution and observation failed/);
  });

  it("(16) secondary agent delete 409 is best-effort and does not push to cleanupErrors", async () => {
    let deleteAttempted = false;
    let postCount = 0;
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        if (path.endsWith("/agents")) {
          return { id: "secondary-agent-id", ...body };
        }
        if (path.endsWith("/issues")) {
          postCount++;
          return { id: `issue-${postCount}`, ...body };
        }
        return { id: "misc", ...body };
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [
            { id: "run-x", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" },
            { id: "run-y", issueId: "issue-2", status: "succeeded", agentId: "secondary-agent-id" },
          ];
        }
        if (path === "/api/heartbeat-runs/run-x") {
          return { id: "run-x", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" };
        }
        if (path === "/api/heartbeat-runs/run-y") {
          return { id: "run-y", issueId: "issue-2", status: "succeeded", agentId: "secondary-agent-id" };
        }
        return [];
      }),
      delete: vi.fn().mockImplementation(async (path: string) => {
        deleteAttempted = true;
        // Simulate Paperclip active agent purge error: HTTP 409 Conflict
        const err = new Error("HTTP 409 Conflict: Cannot purge active agent with live references");
        (err as any).status = 409;
        throw err;
      }),
    };

    // cross-agent-leak creates secondary agent and attempts teardown
    const result = await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("cross-agent-leak"),
      nonce: "delete-409",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn(),
    });

    expect(deleteAttempted).toBe(true);
    // Does NOT throw cleanupErrors; returns clean result
    expect(result).toBeDefined();
  });

  it("(17) marks synthetic boot proof explicitly and supports injected bootProofLoader", async () => {
    let capturedEvidence: any = null;
    let postCount = 0;
    const api: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        postCount++;
        return { id: `issue-${postCount}`, ...body };
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [
            { id: "run-1", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" },
            { id: "run-2", issueId: "issue-2", status: "succeeded", agentId: "agent-x-id" },
          ];
        }
        if (path.startsWith("/api/heartbeat-runs/")) {
          return { id: "run-detail", agentId: "agent-x-id", status: "succeeded" };
        }
        return [];
      }),
    };

    // Test injected loader
    const customBootProof = {
      line: "[company-memory] Custom injected proof",
      flags: {
        hermesMemoryConfig: true,
        hermesPromptSplit: false,
        agentScopedMem0: false,
        capabilityMemoryGuidance: false,
      },
      toString() {
        return this.line;
      },
    };

    await runMemoryRecallFlow({
      api: api as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "injected-loader",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      bootProofLoader: async () => customBootProof,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockImplementation(async (_name, val) => {
        capturedEvidence = val;
      }),
    });

    expect(capturedEvidence.bootProof).toBe("[company-memory] Custom injected proof");
    expect(capturedEvidence.serverHardeningFlags.hermesMemoryConfig).toBe(true);
    // When loader injected, synthetic is not marked
    expect(capturedEvidence.synthetic).toBeUndefined();

    // Now test skipPreflightProbe marks synthetic: true
    let postCount2 = 0;
    const api2: Partial<RunnerApi> = {
      post: vi.fn().mockImplementation(async (path: string, body: any) => {
        postCount2++;
        return { id: `issue-${postCount2}`, ...body };
      }),
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("/heartbeat-runs?limit=100")) {
          return [
            { id: "run-1", issueId: "issue-1", status: "succeeded", agentId: "agent-x-id" },
            { id: "run-2", issueId: "issue-2", status: "succeeded", agentId: "agent-x-id" },
          ];
        }
        if (path.startsWith("/api/heartbeat-runs/")) {
          return { id: "run-detail", agentId: "agent-x-id", status: "succeeded" };
        }
        return [];
      }),
    };

    let syntheticEvidence: any = null;
    await runMemoryRecallFlow({
      api: api2 as RunnerApi,
      fixtures: makeFixtures(),
      execution: makeExecution("save-then-fresh-recall"),
      nonce: "synthetic-proof",
      workspacePath: "/tmp/ws",
      deadlineAt: Date.now() + 10_000,
      skipPreflightProbe: true,
      tenantReaderFactory: async () => makeStubTenantReader(),
      tenantDropper: async () => {},
      observe: vi.fn(),
      evidence: vi.fn().mockImplementation(async (_name, val) => {
        syntheticEvidence = val;
      }),
    });

    expect(syntheticEvidence.synthetic).toBe(true);
  });
});
