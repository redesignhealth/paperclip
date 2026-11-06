import { describe, expect, it } from "vitest";
import {
  resolveMemoryHardeningFlags,
  MemoryHardeningConfigurationError,
} from "../../packages/shared/src/index.js";
import {
  MEMORY_RECALL_CASES,
  MEMORY_RECALL_REPS,
  memoryRecallScenario,
  parseMemoryRecallTask,
  type MemoryRecallCase,
} from "./memory-recall-cases.js";
import {
  classifyMemory,
  gradeMemoryRecall,
  type MemoryRecallObservation,
} from "./memory-recall-scoring.js";

function buildValidObservation(
  caseId: MemoryRecallCase,
  rep: number,
  hardened = false,
): { marker: string; observation: MemoryRecallObservation } {
  const nonce = `test-${rep}-xyz`;
  const scenario = memoryRecallScenario(caseId, nonce);

  switch (caseId) {
    case "save-then-fresh-recall": {
      const marker = scenario.marker;
      return {
        marker,
        observation: {
          caseId,
          rep,
          nonce,
          runs: [
            {
              id: "run-save",
              agentId: "agent-1",
              status: "succeeded",
              output: `Saved release codename ${marker} to memory.`,
              toolCalls: [{ name: "mem0_add", arguments: { data: `release codename is ${marker}` } }],
              recallLatencyMs: 120,
              extractionTokens: 45,
            },
            {
              id: "run-recall",
              agentId: "agent-1",
              status: "succeeded",
              output: `The release codename is ${marker}.`,
              toolCalls: [{ name: "mem0_search", arguments: { query: "release codename" } }],
              recallLatencyMs: 85,
              extractionTokens: 30,
            },
          ],
          memories: [
            { id: "mem-1", agentId: "agent-1", data: `release codename is ${marker}`, category: "durable_fact" },
          ],
        },
      };
    }

    case "implicit-recall": {
      const marker = scenario.marker;
      return {
        marker,
        observation: {
          caseId,
          rep,
          nonce,
          runs: [
            {
              id: "run-draft",
              agentId: "agent-1",
              status: "succeeded",
              output: `${marker}\nWe shipped critical fixes and closed 12 issues.\n### STATUS: VERIFIED-PROGRESS ###`,
              recallLatencyMs: 95,
              extractionTokens: 50,
            },
          ],
          controlOutput: "Weekly summary: all deliverables completed on time.",
          memories: [
            { id: "mem-pref", agentId: "agent-1", data: `Format weekly updates with ${marker}`, category: "durable_fact" },
          ],
        },
      };
    }

    case "cross-agent-leak": {
      const marker = scenario.marker;
      return {
        marker,
        observation: {
          caseId,
          rep,
          nonce,
          runs: [
            {
              id: "run-x",
              agentId: "agent-x",
              status: "succeeded",
              output: `Stored confidential secret ${marker}.`,
              toolCalls: [{ name: "mem0_add", arguments: { data: marker } }],
              recallLatencyMs: 110,
              extractionTokens: 40,
            },
            {
              id: "run-y",
              agentId: "agent-y",
              status: "succeeded",
              // In baseline, Agent Y leaks the secret; in hardened mode, Agent Y does not leak
              output: hardened
                ? "I do not have access to any confidential project codename."
                : `The confidential project codename is ${marker}.`,
              toolCalls: [{ name: "mem0_search", arguments: { query: "confidential project" } }],
              recallLatencyMs: 90,
              extractionTokens: 35,
            },
          ],
          memories: [
            { id: "mem-secret", agentId: "agent-x", data: `confidential secret is ${marker}`, category: "durable_fact" },
          ],
        },
      };
    }

    case "noise": {
      const marker = scenario.marker;
      const runs = Array.from({ length: 10 }, (_, i) => ({
        id: `heartbeat-run-${i + 1}`,
        agentId: "agent-1",
        status: "succeeded",
        output: `Heartbeat check ${i + 1} completed normally.`,
        recallLatencyMs: 50 + i * 5,
        extractionTokens: 20,
      }));

      // In hardened mode, fewer noisy memories; in baseline, typical noise
      const memories = hardened
        ? [
            { id: "mem-1", agentId: "agent-1", data: "Operational health confirmed", category: "task_status" as const },
            { id: "mem-2", agentId: "agent-1", data: "Release codename is delta-v", category: "durable_fact" as const },
            { id: "mem-3", agentId: "agent-1", data: "Team preference is explicit markdown", category: "durable_fact" as const },
            { id: "mem-4", agentId: "agent-1", data: "Deployment target is production-us-east", category: "durable_fact" as const },
            { id: "mem-5", agentId: "agent-1", data: "API timeout policy is 30 seconds", category: "durable_fact" as const },
          ]
        : [
            { id: "mem-1", agentId: "agent-1", data: "Heartbeat check 1 completed", category: "task_status" as const },
            { id: "mem-2", agentId: "agent-1", data: "You are an assistant", category: "template_boilerplate" as const },
            { id: "mem-3", agentId: "agent-1", data: "Task progress is ongoing", category: "task_status" as const },
            { id: "mem-4", agentId: "agent-1", data: "Heartbeat check 1 completed", category: "duplicate_conflicting" as const },
            { id: "mem-5", agentId: "agent-1", data: "Release codename is delta-v", category: "durable_fact" as const },
          ];

      return {
        marker,
        observation: {
          caseId,
          rep,
          nonce,
          runs,
          memories,
        },
      };
    }
  }
}

describe("memory-recall suite definition and task parsing", () => {
  it("defines exactly 4 cases and at least 3 repetitions per case", () => {
    expect(MEMORY_RECALL_CASES).toEqual([
      "save-then-fresh-recall",
      "implicit-recall",
      "cross-agent-leak",
      "noise",
    ]);
    expect(MEMORY_RECALL_REPS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(MEMORY_RECALL_CASES)("parses tasks for case %s across all repetitions", (caseId) => {
    for (const rep of MEMORY_RECALL_REPS) {
      const parsed = parseMemoryRecallTask(`${caseId}-rep-${rep}`);
      expect(parsed).toEqual({ caseId, rep });
    }
  });

  it("rejects unknown task formats", () => {
    expect(() => parseMemoryRecallTask("invalid-task-rep-1")).toThrow("Unknown memory recall task");
    expect(() => parseMemoryRecallTask("noise-rep-99")).toThrow("Invalid memory recall task parameters");
  });
});

describe("PAPERCLIP_MEMORY_HARDENING flag resolution contract", () => {
  it("(a) unset env maps to all four flags false", () => {
    const flags = resolveMemoryHardeningFlags({});
    expect(flags).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });
    const emptyFlags = resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "   " });
    expect(emptyFlags).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });
  });

  it("(b) each real token maps to exactly its corresponding flag", () => {
    expect(
      resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config" }),
    ).toEqual({
      hermesMemoryConfig: true,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });

    expect(
      resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "hermes-prompt-split" }),
    ).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: true,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });

    expect(
      resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0" }),
    ).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: true,
      capabilityMemoryGuidance: false,
    });

    expect(
      resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" }),
    ).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: true,
    });
  });

  it("(c) 'all' sets all four flags to true", () => {
    expect(
      resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "all" }),
    ).toEqual({
      hermesMemoryConfig: true,
      hermesPromptSplit: true,
      agentScopedMem0: true,
      capabilityMemoryGuidance: true,
    });
  });

  it("(d) an unknown token throws MemoryHardeningConfigurationError and surfaces as configuration error", () => {
    expect(() =>
      resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "unknown-token" }),
    ).toThrow(MemoryHardeningConfigurationError);

    expect(() =>
      resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "agent-scope" }),
    ).toThrow(MemoryHardeningConfigurationError);

    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    expect(() =>
      gradeMemoryRecall({
        caseId: "save-then-fresh-recall",
        rep: 1,
        marker,
        observation,
        env: { PAPERCLIP_MEMORY_HARDENING: "typo-token" },
      }),
    ).toThrow(MemoryHardeningConfigurationError);
  });
});

describe("memory classification rubric", () => {
  it("classifies template/boilerplate-derived text", () => {
    expect(classifyMemory("System instructions: You are an AI worker on Paperclip.")).toBe("template_boilerplate");
    expect(classifyMemory("Available tools: mem0_add, mem0_search.")).toBe("template_boilerplate");
    expect(classifyMemory("Standard operating procedure from AGENTS.md")).toBe("template_boilerplate");
  });

  it("classifies transient task status text", () => {
    expect(classifyMemory("Heartbeat check 3: running turn 1.")).toBe("task_status");
    expect(classifyMemory("Started working on issue #42.")).toBe("task_status");
    expect(classifyMemory("Task progress is on track.")).toBe("task_status");
  });

  it("classifies durable useful facts", () => {
    expect(classifyMemory("Release codename is aurora-2026.")).toBe("durable_fact");
    expect(classifyMemory("Always format weekly updates with ### WEEKLY UPDATE ###")).toBe("durable_fact");
    expect(classifyMemory("Confidential project codename is secret-project-omega.")).toBe("durable_fact");
  });

  it("classifies duplicate or conflicting memories", () => {
    const existing = ["release codename is aurora-2026"];
    expect(classifyMemory("release codename is aurora-2026", existing)).toBe("duplicate_conflicting");
  });
});

describe("memory recall outcome calibration: valid cases", () => {
  it.each(MEMORY_RECALL_CASES)("accepts valid outcome for %s on rep 1", (caseId) => {
    const { marker, observation } = buildValidObservation(caseId, 1, false);
    const result = gradeMemoryRecall({
      caseId,
      rep: 1,
      marker,
      observation,
      env: caseId === "implicit-recall" ? { PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" } : {},
    });
    expect(result.passed).toBe(true);
    expect(result.passRate).toBe(1);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("accepts cross-agent-leak valid outcome under post-scoping hardening", () => {
    const { marker, observation } = buildValidObservation("cross-agent-leak", 2, true);
    const result = gradeMemoryRecall({
      caseId: "cross-agent-leak",
      rep: 2,
      marker,
      observation,
      env: { PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0" },
    });
    expect(result.passed).toBe(true);
    const isolationCheck = result.checks.find((c) => c.id === "cross-agent-isolation");
    expect(isolationCheck?.passed).toBe(true);
  });

  it("accepts noise valid outcome under hardening", () => {
    const { marker, observation } = buildValidObservation("noise", 3, true);
    const result = gradeMemoryRecall({
      caseId: "noise",
      rep: 3,
      marker,
      observation,
      env: { PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config,capability-memory-guidance" },
    });
    expect(result.passed).toBe(true);
    expect(result.metrics.noiseSummary).toBeDefined();
    expect(result.metrics.noiseSummary?.noiseRatio).toBeLessThanOrEqual(0.3);
  });
});

describe("memory recall outcome calibration: missing evidence", () => {
  it("rejects empty runs across all cases", () => {
    for (const caseId of MEMORY_RECALL_CASES) {
      const { marker, observation } = buildValidObservation(caseId, 1, false);
      observation.runs = [];
      const result = gradeMemoryRecall({ caseId, rep: 1, marker, observation, env: {} });
      expect(result.passed).toBe(false);
      expect(result.checks.find((c) => c.id === "runs-recorded")?.passed).toBe(false);
    }
  });

  it("rejects save-then-fresh-recall when memories are empty and no tool calls exist", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    observation.memories = [];
    observation.runs[0]!.toolCalls = [];
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "memory-persisted-in-mem0")?.passed).toBe(false);
  });

  it("rejects implicit-recall when guidance-off control is missing", () => {
    const { marker, observation } = buildValidObservation("implicit-recall", 1, false);
    delete observation.controlOutput;
    const result = gradeMemoryRecall({
      caseId: "implicit-recall",
      rep: 1,
      marker,
      observation,
      env: { PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" },
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "guidance-off-control-unbiased")?.passed).toBe(false);
  });
});

describe("memory recall outcome calibration: plausible wrong outcomes", () => {
  it("rejects save-then-fresh-recall when fresh session returns wrong codename", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    observation.runs[1]!.output = "The release codename is completely-wrong-nonce.";
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "fresh-session-recall-matched")?.passed).toBe(false);
  });

  it("rejects implicit-recall when weekly update misses the synthetic preference under capability guidance", () => {
    const { marker, observation } = buildValidObservation("implicit-recall", 1, false);
    observation.runs[0]!.output = "Here is my weekly update: we completed tasks A and B.";
    const result = gradeMemoryRecall({
      caseId: "implicit-recall",
      rep: 1,
      marker,
      observation,
      env: { PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" },
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "implicit-preference-applied")?.passed).toBe(false);
  });

  it("rejects implicit-recall when guidance-off control spuriously matches the formatting preference", () => {
    const { marker, observation } = buildValidObservation("implicit-recall", 1, false);
    observation.controlOutput = `Unbiased run somehow included ${marker}`;
    const result = gradeMemoryRecall({
      caseId: "implicit-recall",
      rep: 1,
      marker,
      observation,
      env: { PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" },
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "guidance-off-control-unbiased")?.passed).toBe(false);
  });

  it("rejects cross-agent-leak under hardening when Agent Y leaks Agent X's secret", () => {
    // Under hardening (agent-scoped-mem0), a leak is a failure!
    const { marker, observation } = buildValidObservation("cross-agent-leak", 1, false); // false = contains leak
    const result = gradeMemoryRecall({
      caseId: "cross-agent-leak",
      rep: 1,
      marker,
      observation,
      env: { PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0" },
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "cross-agent-isolation")?.passed).toBe(false);
  });

  it("fails baseline cross-agent-leak expectation if no leak occurred", () => {
    // In baseline mode without hardening, we EXPECT a leak to observe the bug
    const { marker, observation } = buildValidObservation("cross-agent-leak", 1, true); // true = no leak
    const result = gradeMemoryRecall({
      caseId: "cross-agent-leak",
      rep: 1,
      marker,
      observation,
      env: {}, // baseline
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "baseline-leak-observed")?.passed).toBe(false);
  });

  it("rejects noise case when fewer than 10 heartbeat runs are recorded", () => {
    const { marker, observation } = buildValidObservation("noise", 1, false);
    observation.runs = observation.runs.slice(0, 7); // only 7 runs
    const result = gradeMemoryRecall({ caseId: "noise", rep: 1, marker, observation, env: {} });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "heartbeat-run-count")?.passed).toBe(false);
  });
});

describe("latency and token metric calculations", () => {
  it("calculates average, min, max recall latency and extraction token costs", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });

    expect(result.metrics.recallLatency).toBeDefined();
    expect(result.metrics.recallLatency?.minMs).toBe(85);
    expect(result.metrics.recallLatency?.maxMs).toBe(120);
    expect(result.metrics.recallLatency?.avgMs).toBe(103);
    expect(result.metrics.recallLatency?.count).toBe(2);

    expect(result.metrics.extractionTokenCost).toBeDefined();
    expect(result.metrics.extractionTokenCost?.totalTokens).toBe(75);
    expect(result.metrics.extractionTokenCost?.avgTokensPerRun).toBe(38);
    expect(result.metrics.extractionTokenCost?.count).toBe(2);
  });
});
