import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveMemoryHardeningFlags,
  MemoryHardeningConfigurationError,
} from "../../packages/shared/src/index.js";
import { deriveCompanyMemoryDatabaseNames } from "../../server/src/services/company-memory-databases.js";
import { parseCompanyMemoryConfig } from "../../server/src/services/company-memory-config.js";
import {
  MEMORY_RECALL_CASES,
  MEMORY_RECALL_REPS,
  MEMORY_HARDENING_CAPABILITIES,
  memoryRecallScenario,
  memoryRecallDefinitionDigest,
  parseMemoryRecallTask,
  type MemoryRecallCase,
} from "./memory-recall-cases.js";
import {
  classifyMemory,
  gradeMemoryRecall,
  summarizeMemories,
  type MemoryRecallObservation,
} from "./memory-recall-scoring.js";
import {
  deriveTenantNames,
  extractBootProof,
  extractLogText,
  dropTenantDatabase,
  typedToolRecords,
  TEST_TENANT_DB_REGEX,
  TEST_TENANT_ROLE_REGEX,
} from "./memory-recall-observation.js";
import { memoryRecallTasks } from "./memory-recall-cases.js";
import { loadLocalEnvironment } from "./launch.js";
import { assertMemoryRecallPrerequisites } from "./prerequisites.js";
import type { MatrixExecution } from "./types.js";

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
          issues: [
            { id: "issue-save", status: "done", title: `Save ${nonce}`, description: scenario.savePrompt },
            { id: "issue-recall", status: "done", title: `Recall ${nonce}`, description: scenario.recallPrompt },
          ],
          runs: [
            {
              id: "run-save",
              agentId: "agent-1",
              status: "succeeded",
              issueId: "issue-save",
              result: `Saved release codename ${marker} to memory.`,
              toolRecords: [
                {
                  tool: "mem0_add",
                  durationSec: 1.2,
                  durationMs: 1200,
                  chars: 45,
                  raw: "12:00:01 - agent.tool_executor - INFO - tool mem0_add completed (1.20s, 45 chars)",
                },
              ],
              usage: { inputTokens: 45, outputTokens: 20, cachedInputTokens: 0, usageSource: "provider" },
            },
            {
              id: "run-recall",
              agentId: "agent-1",
              status: "succeeded",
              issueId: "issue-recall",
              result: `The release codename is ${marker}.`,
              toolRecords: [
                {
                  tool: "mem0_search",
                  durationSec: 0.85,
                  durationMs: 850,
                  chars: 30,
                  raw: "12:00:02 - agent.tool_executor - INFO - tool mem0_search completed (0.85s, 30 chars)",
                },
              ],
              usage: { inputTokens: 30, outputTokens: 15, cachedInputTokens: 0, usageSource: "provider" },
            },
          ],
          // No explicit categories: let classifyMemory be exercised
          memories: [
            { id: "mem-1", agentId: "agent-1", data: `release codename is ${marker}` },
            { id: "mem-2", agentId: "agent-1", data: "random unstructured note without patterns" },
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
          issues: [
            { id: "issue-control", status: "done", title: `Control ${nonce}`, description: scenario.controlPrompt },
            { id: "issue-seed", status: "done", title: `Seed ${nonce}`, description: scenario.seedPrompt },
            { id: "issue-draft", status: "done", title: `Draft ${nonce}`, description: scenario.askPrompt },
          ],
          runs: [
            {
              id: "run-control",
              agentId: "agent-1",
              status: "succeeded",
              issueId: "issue-control",
              result: "Weekly summary: all deliverables completed on time.",
              toolRecords: [],
              usage: { inputTokens: 25, outputTokens: 20, cachedInputTokens: 0, usageSource: "provider" },
            },
            {
              id: "run-seed",
              agentId: "agent-1",
              status: "succeeded",
              issueId: "issue-seed",
              result: "Preference recorded.",
              toolRecords: [
                {
                  tool: "mem0_add",
                  durationSec: 1.0,
                  durationMs: 1000,
                  chars: 50,
                  raw: "12:00:01 - agent.tool_executor - INFO - tool mem0_add completed (1.00s, 50 chars)",
                },
              ],
              usage: { inputTokens: 30, outputTokens: 10, cachedInputTokens: 0, usageSource: "provider" },
            },
            {
              id: "run-draft",
              agentId: "agent-1",
              status: "succeeded",
              issueId: "issue-draft",
              result: `${marker}\nWe shipped critical fixes and closed 12 issues.\n### STATUS: VERIFIED-PROGRESS ###`,
              toolRecords: [
                {
                  tool: "mem0_search",
                  durationSec: 0.95,
                  durationMs: 950,
                  chars: 40,
                  raw: "12:00:03 - agent.tool_executor - INFO - tool mem0_search completed (0.95s, 40 chars)",
                },
              ],
              usage: { inputTokens: 50, outputTokens: 40, cachedInputTokens: 0, usageSource: "provider" },
            },
          ],
          controlOutput: "Weekly summary: all deliverables completed on time.",
          memories: [
            { id: "mem-pref", agentId: "agent-1", data: `always format weekly updates with ${marker}` },
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
          secondaryAgentId: "agent-y",
          issues: [
            { id: "issue-x", status: "done", title: `Agent X ${nonce}`, description: scenario.agentXPrompt },
            { id: "issue-y", status: "done", title: `Agent Y ${nonce}`, description: scenario.agentYPrompt },
          ],
          runs: [
            {
              id: "run-x",
              agentId: "agent-x",
              status: "succeeded",
              issueId: "issue-x",
              result: `Stored confidential secret ${marker}.`,
              toolRecords: [
                {
                  tool: "mem0_add",
                  durationSec: 1.1,
                  durationMs: 1100,
                  chars: 40,
                  raw: "12:00:01 - agent.tool_executor - INFO - tool mem0_add completed (1.10s, 40 chars)",
                },
              ],
              usage: { inputTokens: 40, outputTokens: 15, cachedInputTokens: 0, usageSource: "provider" },
            },
            {
              id: "run-y",
              agentId: "agent-y",
              status: "succeeded",
              issueId: "issue-y",
              result: hardened
                ? "I do not have access to any confidential project codename."
                : `The confidential project codename is ${marker}.`,
              toolRecords: [
                {
                  tool: "mem0_search",
                  durationSec: 0.9,
                  durationMs: 900,
                  chars: 35,
                  raw: "12:00:02 - agent.tool_executor - INFO - tool mem0_search completed (0.90s, 35 chars)",
                },
              ],
              usage: { inputTokens: 35, outputTokens: 25, cachedInputTokens: 0, usageSource: "provider" },
            },
          ],
          memories: [
            { id: "mem-secret", agentId: "agent-x", data: `confidential project codename is ${marker}` },
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
        issueId: `issue-${i + 1}`,
        result: `Heartbeat check ${i + 1} completed normally.`,
        toolRecords: [
          {
            tool: "mem0_search",
            durationSec: 0.5 + i * 0.05,
            durationMs: Math.round((0.5 + i * 0.05) * 1000),
            chars: 20,
            raw: `12:00:${String(i).padStart(2, "0")} - agent.tool_executor - INFO - tool mem0_search completed (0.50s, 20 chars)`,
          },
        ],
        usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, usageSource: "provider" },
      }));

      // Memories without hardcoded categories
      const memories = hardened
        ? [
            { id: "mem-1", agentId: "agent-1", data: "Operational health confirmed" },
            { id: "mem-2", agentId: "agent-1", data: "Release codename is delta-v" },
            { id: "mem-3", agentId: "agent-1", data: "always use explicit markdown" },
            { id: "mem-4", agentId: "agent-1", data: "confidential project is secret-project-alpha" },
            { id: "mem-5", agentId: "agent-1", data: "permanent decision on policy" },
            { id: "mem-6", agentId: "agent-1", data: "unstructured random statement for test" },
          ]
        : [
            { id: "mem-1", agentId: "agent-1", data: "Heartbeat check 1 completed" },
            { id: "mem-2", agentId: "agent-1", data: "You are an assistant" },
            { id: "mem-3", agentId: "agent-1", data: "Task progress is ongoing" },
            { id: "mem-4", agentId: "agent-1", data: "Running turn 2" },
            { id: "mem-5", agentId: "agent-1", data: "System instructions: follow format" },
          ];

      return {
        marker,
        observation: {
          caseId,
          rep,
          nonce,
          issues: Array.from({ length: 10 }, (_, i) => ({
            id: `issue-${i + 1}`,
            status: "done",
            title: `Check ${i + 1}`,
            description: `Heartbeat prompt ${i + 1}`,
          })),
          runs,
          memories,
        },
      };
    }
  }
}

describe("memory-recall contract tests", () => {
  it("derives tenant names identical to deriveCompanyMemoryDatabaseNames across a UUID table", () => {
    const uuids = [
      "11111111-1111-4111-8111-111111111111",
      "abcdef01-2345-4678-9abc-def012345678",
      "00000000-0000-4000-8000-000000000000",
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    for (const uuid of uuids) {
      expect(deriveTenantNames(uuid)).toEqual(deriveCompanyMemoryDatabaseNames(uuid));
      expect(deriveTenantNames(uuid.toUpperCase())).toEqual(deriveCompanyMemoryDatabaseNames(uuid.toLowerCase()));
    }
  });

  it("validates prerequisites against real parseCompanyMemoryConfig including sslmode and scope", () => {
    const dummyExecution: MatrixExecution = {
      id: "memory-recall.memory-hermes-local.local.save-then-fresh-recall-rep-1",
      suite: { id: "memory-recall" } as any,
      profile: { id: "memory-hermes-local" } as any,
      environment: { id: "local" } as any,
      task: { id: "save-then-fresh-recall-rep-1", flow: "memory_recall" } as any,
      requiredCredentials: ["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
      groups: [],
      suiteDefinitionHash: "dummy-hash",
    };

    const baseEnv = {
      PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
      PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
      PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: "postgresql://postgres:pass@localhost:5432/postgres?sslmode=require",
      PAPERCLIP_E2E_MEMORY_HERMES_MODEL: "anthropic/claude-3.5-sonnet",
      OPENROUTER_API_KEY: "sk-or-test",
      OPENAI_API_KEY: "sk-oa-test",
    };

    // Valid configuration passes
    expect(() => assertMemoryRecallPrerequisites([dummyExecution], baseEnv)).not.toThrow();

    // Tenant isolation not true
    expect(() =>
      assertMemoryRecallPrerequisites([dummyExecution], { ...baseEnv, PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "false" }),
    ).toThrow("PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED='true'");

    // Company scope not all
    expect(() =>
      assertMemoryRecallPrerequisites([dummyExecution], { ...baseEnv, PAPERCLIP_MEMORY_COMPANY_SCOPE: "allowlist" }),
    ).toThrow("PAPERCLIP_MEMORY_COMPANY_SCOPE='all'");

    // sslmode=require missing
    expect(() =>
      assertMemoryRecallPrerequisites([dummyExecution], {
        ...baseEnv,
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: "postgresql://postgres:pass@localhost:5432/postgres",
      }),
    ).toThrow("sslmode=require");

    // Missing model
    expect(() =>
      assertMemoryRecallPrerequisites([dummyExecution], { ...baseEnv, PAPERCLIP_E2E_MEMORY_HERMES_MODEL: "" }),
    ).toThrow("PAPERCLIP_E2E_MEMORY_HERMES_MODEL");

    // Missing OpenRouter key
    expect(() =>
      assertMemoryRecallPrerequisites([dummyExecution], { ...baseEnv, OPENROUTER_API_KEY: "" }),
    ).toThrow("OPENROUTER_API_KEY");

    // Missing OpenAI key
    expect(() =>
      assertMemoryRecallPrerequisites([dummyExecution], { ...baseEnv, OPENAI_API_KEY: "" }),
    ).toThrow("OPENAI_API_KEY");

    // Unimplemented flag agent-scoped-mem0
    expect(() =>
      assertMemoryRecallPrerequisites([dummyExecution], {
        ...baseEnv,
        PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0",
      }),
    ).toThrow("TECH-8191");

    // Unimplemented flag capability-memory-guidance
    expect(() =>
      assertMemoryRecallPrerequisites([dummyExecution], {
        ...baseEnv,
        PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance",
      }),
    ).toThrow("TECH-8192");
  });

  it("checks capability inventory consistency with adapter implementations", () => {
    const hardeningFlags = resolveMemoryHardeningFlags({});
    expect(Object.keys(MEMORY_HARDENING_CAPABILITIES).sort()).toEqual(Object.keys(hardeningFlags).sort());

    // Implemented capabilities corroborate against Hermes source files
    const memoryConfigSrc = fs.readFileSync(
      path.resolve(__dirname, "../../packages/adapters/hermes/src/server/memory-config.ts"),
      "utf8",
    );
    expect(memoryConfigSrc).toContain("hermesMemoryConfig");

    const executeSrc = fs.readFileSync(
      path.resolve(__dirname, "../../packages/adapters/hermes/src/server/execute.ts"),
      "utf8",
    );
    expect(executeSrc).toContain("hermesPromptSplit");

    // Not-implemented flags must not appear outside memory-hardening.ts and test suites
    // (This contract test will intentionally fail when TECH-8191 or TECH-8192 land)
    expect(MEMORY_HARDENING_CAPABILITIES.agentScopedMem0).toBe("not-implemented");
    expect(MEMORY_HARDENING_CAPABILITIES.capabilityMemoryGuidance).toBe("not-implemented");
  });

  it("parses typed tool records against strict grammar with negative fixtures", () => {
    const validLines = [
      "12:34:56 - agent.tool_executor - INFO - tool mem0_add completed (1.23s, 456 chars)",
      "09:15:00 - agent.tool_executor - INFO [main-session] - tool mem0_search completed (0.45s, 12 chars)",
    ].join("\n");

    const parsed = typedToolRecords(validLines);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      tool: "mem0_add",
      durationSec: 1.23,
      durationMs: 1230,
      chars: 456,
      raw: "12:34:56 - agent.tool_executor - INFO - tool mem0_add completed (1.23s, 456 chars)",
    });
    expect(parsed[1]?.tool).toBe("mem0_search");

    // Negative fixtures: substrings, missing units, extra text
    const invalidLines = [
      "Assistant text says: 12:34:56 - agent.tool_executor - INFO - tool mem0_add completed (1.23s, 456 chars)",
      "12:34:56 - agent.tool_executor - INFO - tool mem0_add completed (1.23s, 456 chars) and extra stuff",
      "12:34:56 - agent.tool_executor - WARNING - tool mem0_add completed (1.23s, 456 chars)",
      "12:34:56 - agent.tool_executor - INFO - tool mem0_add completed (1.2s, 456 chars)",
    ].join("\n");
    expect(typedToolRecords(invalidLines)).toHaveLength(0);

    // NDJSON extraction: only stderr stream counts
    const ndjson = [
      JSON.stringify({ stream: "stdout", chunk: "12:34:56 - agent.tool_executor - INFO - tool mem0_add completed (1.23s, 456 chars)\n" }),
      JSON.stringify({ stream: "stderr", chunk: "12:34:56 - agent.tool_executor - INFO - tool mem0_search completed (0.85s, 100 chars)\n" }),
    ].join("\n");
    const extracted = extractLogText(ndjson);
    expect(extracted).not.toContain("mem0_add");
    expect(extracted).toContain("mem0_search");
    expect(typedToolRecords(extracted)).toHaveLength(1);
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

  it("classifies unrecognized text as unclassified rather than guessing", () => {
    expect(classifyMemory("The quick brown fox jumps over the lazy dog.")).toBe("unclassified");
  });
});

describe("memory recall grader: baseline and hardened behavior", () => {
  it("accepts save-then-fresh-recall valid outcome", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    const result = gradeMemoryRecall({
      caseId: "save-then-fresh-recall",
      rep: 1,
      marker,
      observation,
      env: {},
    });
    expect(result.passed).toBe(true);
    expect(result.passRate).toBe(1);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.checks.map((c) => c.id)).toContain("dual-run-completion");
    expect(result.checks.map((c) => c.id)).toContain("memory-persisted-in-mem0");
    expect(result.checks.map((c) => c.id)).toContain("fresh-session-recall-matched");
  });

  it("emits metrics and mandatory checks for baseline implicit-recall", () => {
    const { marker, observation } = buildValidObservation("implicit-recall", 1, false);
    const result = gradeMemoryRecall({
      caseId: "implicit-recall",
      rep: 1,
      marker,
      observation,
      env: {}, // baseline
    });
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual([
      "implicit-runs-completed",
      "actual-control-recorded",
      "guidance-off-control-unbiased",
      "draft-run-observed",
    ]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.metrics.implicitRecall).toBeDefined();
    expect(result.metrics.implicitRecall?.followsPreference).toBe(true);
    expect(result.metrics.implicitRecall?.controlUnbiased).toBe(true);
  });

  it("emits metrics and mandatory checks for baseline noise", () => {
    const { marker, observation } = buildValidObservation("noise", 1, false);
    const result = gradeMemoryRecall({
      caseId: "noise",
      rep: 1,
      marker,
      observation,
      env: {}, // baseline
    });
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual([
      "heartbeat-run-count",
      "noise-memory-observation",
    ]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.metrics.noiseSummary).toBeDefined();
  });

  it("evaluates hardened noise bounded when hermes-memory-config is enabled", () => {
    const { marker, observation } = buildValidObservation("noise", 1, true);
    const result = gradeMemoryRecall({
      caseId: "noise",
      rep: 1,
      marker,
      observation,
      env: { PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config" },
    });
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.id === "heartbeat-run-count")?.passed).toBe(true);
    expect(result.checks.find((c) => c.id === "hardened-noise-bounded")?.passed).toBe(true);
  });

  it("throws defensively when an unimplemented hardening flag is passed to grader", () => {
    const { marker, observation } = buildValidObservation("implicit-recall", 1, false);
    expect(() =>
      gradeMemoryRecall({
        caseId: "implicit-recall",
        rep: 1,
        marker,
        observation,
        env: { PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" },
      }),
    ).toThrow("TECH-8192");

    expect(() =>
      gradeMemoryRecall({
        caseId: "cross-agent-leak",
        rep: 1,
        marker,
        observation,
        env: { PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0" },
      }),
    ).toThrow("TECH-8191");
  });

  it("requires cross-agent-leak baseline to observe leak with precondition", () => {
    const { marker, observation } = buildValidObservation("cross-agent-leak", 1, false);
    const result = gradeMemoryRecall({
      caseId: "cross-agent-leak",
      rep: 1,
      marker,
      observation,
      env: {},
    });
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.id === "baseline-leak-observed")?.passed).toBe(true);
  });
});

describe("memory recall wrong-outcome rejection", () => {
  it("rejects save-then-fresh-recall when memory was not persisted in tenant DB", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    observation.memories = [];
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "memory-persisted-in-mem0")?.passed).toBe(false);
  });

  it("rejects save-then-fresh-recall when typed mem0_add was not logged", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    observation.runs[0]!.toolRecords = [];
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "memory-persisted-in-mem0")?.passed).toBe(false);
  });

  it("rejects save-then-fresh-recall when recall run answer text is wrong", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    observation.runs[1]!.result = "Wrong codename.";
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "fresh-session-recall-matched")?.passed).toBe(false);
  });

  it("rejects save-then-fresh-recall when mem0_search was not logged in recall run", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    observation.runs[1]!.toolRecords = [];
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "fresh-session-recall-matched")?.passed).toBe(false);
  });

  it("rejects save-then-fresh-recall when marker was leaked in recall issue text", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    observation.issues![1]!.description = `Here is the marker: ${marker}`;
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "fresh-session-recall-matched")?.passed).toBe(false);
  });

  it("rejects cross-agent-leak baseline when precondition fails (Agent Y run has wrong agentId)", () => {
    const { marker, observation } = buildValidObservation("cross-agent-leak", 1, false);
    observation.runs[1]!.agentId = "agent-x"; // Attributed to Agent X instead of Agent Y
    const result = gradeMemoryRecall({ caseId: "cross-agent-leak", rep: 1, marker, observation, env: {} });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "baseline-leak-observed")?.passed).toBe(false);
  });

  it("fails hardened noise bounded check when memory sample is insufficient (< 5)", () => {
    const { marker, observation } = buildValidObservation("noise", 1, true);
    observation.memories = observation.memories!.slice(0, 3);
    const result = gradeMemoryRecall({
      caseId: "noise",
      rep: 1,
      marker,
      observation,
      env: { PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config" },
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "hardened-noise-bounded")?.passed).toBe(false);
  });
});

describe("latency and token metric calculations", () => {
  it("calculates recallLatency from mem0_search typed durations and runTokenCost from usage", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });

    expect(result.metrics.recallLatency).toBeDefined();
    expect(result.metrics.recallLatency?.avgMs).toBe(850);
    expect(result.metrics.recallLatency?.minMs).toBe(850);
    expect(result.metrics.recallLatency?.count).toBe(1);

    expect(result.metrics.runTokenCost).toBeDefined();
    expect(result.metrics.runTokenCost?.inputTokens).toBe(75);
    expect(result.metrics.runTokenCost?.outputTokens).toBe(35);
    expect(result.metrics.runTokenCost?.totalTokens).toBe(110);
    expect(result.metrics.runTokenCost?.count).toBe(2);
  });

  it("includes cachedInputTokens in totalTokens calculation", () => {
    const { marker, observation } = buildValidObservation("save-then-fresh-recall", 1, false);
    observation.runs[0]!.usage = {
      inputTokens: 50,
      cachedInputTokens: 30,
      outputTokens: 20,
      usageSource: "provider",
    };
    observation.runs[1]!.usage = {
      inputTokens: 40,
      cachedInputTokens: 20,
      outputTokens: 10,
      usageSource: "provider",
    };
    const result = gradeMemoryRecall({ caseId: "save-then-fresh-recall", rep: 1, marker, observation, env: {} });

    expect(result.metrics.runTokenCost).toBeDefined();
    expect(result.metrics.runTokenCost?.inputTokens).toBe(90);
    expect(result.metrics.runTokenCost?.cachedInputTokens).toBe(50);
    expect(result.metrics.runTokenCost?.outputTokens).toBe(30);
    expect(result.metrics.runTokenCost?.totalTokens).toBe(170); // 90 + 50 + 30
  });
});

describe("launch prerequisites ordering and local environment loading", () => {
  it("ensures loadLocalEnvironment precedes assertMemoryRecallPrerequisites in launch.ts", async () => {
    const launchSource = await fs.promises.readFile(
      new URL("./launch.ts", import.meta.url),
      "utf8",
    );
    const loadEnvIdx = launchSource.indexOf("loadLocalEnvironment(process.env)");
    const memoryPrereqIdx = launchSource.indexOf(
      "assertMemoryRecallPrerequisites(executions, process.env)",
    );
    expect(loadEnvIdx).toBeGreaterThan(-1);
    expect(memoryPrereqIdx).toBeGreaterThan(loadEnvIdx);

    // Also verify installedStartupOnly does not call assertMemoryRecallPrerequisites
    const installedStartupIdx = launchSource.indexOf("if (options.installedStartupOnly)");
    const installedStartupBlock = launchSource.slice(
      installedStartupIdx,
      installedStartupIdx + 500,
    );
    expect(installedStartupBlock).not.toContain("assertMemoryRecallPrerequisites");
  });

  it("loads local env file before evaluating memory recall prerequisites", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "launch-env-test-"));
    const envFilePath = path.join(tmpDir, ".env.runner-e2e.local");
    const envContent = [
      "PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED=true",
      "PAPERCLIP_MEMORY_COMPANY_SCOPE=all",
      "PAPERCLIP_MEMORY_ADMIN_DATABASE_URL=postgresql://postgres:pass@localhost:5432/postgres?sslmode=require",
      "PAPERCLIP_E2E_MEMORY_HERMES_MODEL=anthropic/claude-3.5-sonnet",
      "OPENROUTER_API_KEY=sk-or-test",
      "OPENAI_API_KEY=sk-oa-test",
    ].join("\n");
    await fs.promises.writeFile(envFilePath, envContent, "utf8");

    const targetEnv: NodeJS.ProcessEnv = {};
    const dummyExecution: MatrixExecution = {
      id: "memory-recall.memory-hermes-local.local.save-then-fresh-recall-rep-1",
      suite: { id: "memory-recall" } as any,
      profile: { id: "memory-hermes-local" } as any,
      environment: { id: "local" } as any,
      task: { id: "save-then-fresh-recall-rep-1", flow: "memory_recall" } as any,
      requiredCredentials: ["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
      groups: [],
      suiteDefinitionHash: "dummy-hash",
    };

    // Before loading env: prerequisites throw
    expect(() => assertMemoryRecallPrerequisites([dummyExecution], targetEnv)).toThrow();

    // After loading env file: prerequisites pass
    await loadLocalEnvironment(targetEnv, envFilePath);
    expect(() => assertMemoryRecallPrerequisites([dummyExecution], targetEnv)).not.toThrow();

    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });
});

describe("task run counts, budgets, and scenario prompt correspondence", () => {
  it("assigns expectedRunCount 3 to implicit-recall (control+seed+draft) and 10 to noise", () => {
    for (const task of memoryRecallTasks) {
      if (task.id.startsWith("implicit-recall")) {
        expect(task.expectedRunCount).toBe(3);
      } else if (task.id.startsWith("noise")) {
        expect(task.expectedRunCount).toBe(10);
      } else if (task.id.startsWith("save-then-fresh-recall")) {
        expect(task.expectedRunCount).toBe(2);
      } else if (task.id.startsWith("cross-agent-leak")) {
        expect(task.expectedRunCount).toBe(2);
      }
    }
  });

  it("buildPrompt for implicit-recall returns scenario.controlPrompt as the initial prompt", () => {
    const implicitTask = memoryRecallTasks.find((t) => t.id === "implicit-recall-rep-1")!;
    expect(implicitTask).toBeDefined();
    const prompt = implicitTask.buildPrompt("test-nonce");
    const scenario = memoryRecallScenario("implicit-recall", "test-nonce");
    expect(prompt).toBe(scenario.controlPrompt);
  });

  it("provides an explicit 20-minute local attempt budget for noise 10-turn sequence", () => {
    const noiseTask = memoryRecallTasks.find((t) => t.id === "noise-rep-1")!;
    expect(noiseTask).toBeDefined();
    expect(noiseTask.attemptTimeoutMs?.local).toBe(20 * 60_000);
    expect(noiseTask.attemptTimeoutMs?.daytona).toBe(25 * 60_000);
  });
});

describe("server boot proof extraction and server-resolved flags", () => {
  it("extracts single-line JSON boot proof and server-resolved hardening flags", () => {
    const log = [
      '{"level":30,"time":1700000000000,"pid":1234,"msg":"[company-memory] Initialized company memory configuration","enabled":true,"companyScope":"all","pilotCompanyCount":0}',
      '{"level":30,"time":1700000000001,"pid":1234,"msg":"[company-memory-hardening] Server resolved hardening flags: {\\"hermesMemoryConfig\\":true,\\"hermesPromptSplit\\":false,\\"agentScopedMem0\\":false,\\"capabilityMemoryGuidance\\":false}"}',
    ].join("\n");

    const proof = extractBootProof(log);
    expect(proof.line).toContain("[company-memory] Initialized company memory configuration");
    expect(proof.flags).toEqual({
      hermesMemoryConfig: true,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });
  });

  it("extracts multiline pino-pretty formatted boot proof", () => {
    const log = [
      "[12:34:56.789] INFO: [company-memory] Initialized company memory configuration",
      "    enabled: true",
      '    companyScope: "all"',
      "    pilotCompanyCount: 0",
      "[12:34:56.790] INFO: [company-memory-hardening] Server resolved hardening flags: {\"hermesMemoryConfig\":false,\"hermesPromptSplit\":false,\"agentScopedMem0\":false,\"capabilityMemoryGuidance\":false}",
    ].join("\n");

    const proof = extractBootProof(log);
    expect(proof.line).toContain("[company-memory] Initialized company memory configuration");
    expect(proof.flags.hermesMemoryConfig).toBe(false);
  });

  it("fails closed when company memory init line is missing", () => {
    const log = '[company-memory-hardening] Server resolved hardening flags: {"hermesMemoryConfig":false,"hermesPromptSplit":false,"agentScopedMem0":false,"capabilityMemoryGuidance":false}';
    expect(() => extractBootProof(log)).toThrow(/Initialized company memory configuration/);
  });

  it("fails closed when server resolved hardening flags proof is missing", () => {
    const log = '[company-memory] Initialized company memory configuration {"enabled":true,"companyScope":"all"}';
    expect(() => extractBootProof(log)).toThrow(/Server resolved hardening flags/);
  });

  it("fails closed when server resolved hardening flags JSON is malformed", () => {
    const log = [
      '[company-memory] Initialized company memory configuration {"enabled":true,"companyScope":"all"}',
      "[company-memory-hardening] Server resolved hardening flags: {bad-json",
    ].join("\n");
    expect(() => extractBootProof(log)).toThrow(/Server resolved hardening flags/);
  });

  it("grader prioritizes server-resolved flags over controller process.env", () => {
    const { marker, observation } = buildValidObservation("implicit-recall", 1, false);
    // Controller env has capability-memory-guidance enabled
    const controllerEnv = { PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" };
    // But server boot proof has all flags false
    const serverFlags = {
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    };

    const result = gradeMemoryRecall({
      caseId: "implicit-recall",
      rep: 1,
      marker,
      observation,
      flags: serverFlags,
      env: controllerEnv,
    });

    // Since server flags had capabilityMemoryGuidance=false, implicit-preference-applied was NOT checked
    expect(result.checks.map((c) => c.id)).not.toContain("implicit-preference-applied");
    expect(result.passed).toBe(true);
  });
});

describe("tenant database drop safety", () => {
  it("refuses to drop non-tenant database names to protect system/production DBs", async () => {
    for (const dangerousName of ["postgres", "template1", "prod_company_db", "paperclip_main"]) {
      await expect(
        dropTenantDatabase("postgres://localhost/test", dangerousName),
      ).rejects.toThrow(/does not match expected test tenant pattern/);
    }
  });

  it("refuses to drop non-tenant role names", async () => {
    const validDbName = "paperclip_tenant_11111111_2222_4333_8444_555555555555";
    for (const dangerousRole of ["postgres", "admin", "app_user", "paperclip_service"]) {
      await expect(
        dropTenantDatabase("postgres://localhost/test", validDbName, dangerousRole),
      ).rejects.toThrow(/does not match expected test tenant role pattern/);
    }
  });

  it("validates exact regex patterns for tenant databases and roles", () => {
    expect(TEST_TENANT_DB_REGEX.test("paperclip_tenant_11111111_2222_4333_8444_555555555555")).toBe(true);
    expect(TEST_TENANT_DB_REGEX.test("paperclip_tenant_invalid_uuid")).toBe(false);
    expect(TEST_TENANT_DB_REGEX.test("postgres")).toBe(false);

    expect(TEST_TENANT_ROLE_REGEX.test("paperclip_tenant_11111111_2222_4333_8444_555555555555_owner")).toBe(true);
    expect(TEST_TENANT_ROLE_REGEX.test("paperclip_tenant_11111111_2222_4333_8444_555555555555")).toBe(false);
    expect(TEST_TENANT_ROLE_REGEX.test("postgres")).toBe(false);
  });
});

describe("mandatory baseline checks and empty/invalid evidence", () => {
  it("fails when observation has zero checks (totalChecks === 0)", () => {
    const result = gradeMemoryRecall({
      caseId: "save-then-fresh-recall",
      rep: 1,
      marker: "TEST",
      observation: {
        caseId: "save-then-fresh-recall",
        rep: 1,
        nonce: "empty",
        runs: [],
        issues: [],
      },
      env: {},
    });
    // save-then-fresh-recall adds runs-recorded which fails
    expect(result.passed).toBe(false);
    expect(result.passRate).toBe(0);
  });

  it("fails baseline implicit-recall when runs count is insufficient (< 3)", () => {
    const { marker, observation } = buildValidObservation("implicit-recall", 1, false);
    observation.runs = observation.runs.slice(0, 2); // only 2 runs
    const result = gradeMemoryRecall({
      caseId: "implicit-recall",
      rep: 1,
      marker,
      observation,
      env: {},
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "implicit-runs-completed")?.passed).toBe(false);
  });

  it("fails baseline implicit-recall when control output is empty", () => {
    const { marker, observation } = buildValidObservation("implicit-recall", 1, false);
    observation.controlOutput = "";
    const result = gradeMemoryRecall({
      caseId: "implicit-recall",
      rep: 1,
      marker,
      observation,
      env: {},
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "actual-control-recorded")?.passed).toBe(false);
  });

  it("fails baseline implicit-recall when control output is biased (contains marker)", () => {
    const { marker, observation } = buildValidObservation("implicit-recall", 1, false);
    observation.controlOutput = `Here is the synthetic preference marker: ${marker}`;
    const result = gradeMemoryRecall({
      caseId: "implicit-recall",
      rep: 1,
      marker,
      observation,
      env: {},
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "guidance-off-control-unbiased")?.passed).toBe(false);
  });

  it("fails baseline noise when heartbeat runs are fewer than 10", () => {
    const { marker, observation } = buildValidObservation("noise", 1, false);
    observation.runs = observation.runs.slice(0, 9);
    const result = gradeMemoryRecall({
      caseId: "noise",
      rep: 1,
      marker,
      observation,
      env: {},
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "heartbeat-run-count")?.passed).toBe(false);
  });

  it("fails baseline noise when memories observation is missing or invalid", () => {
    const { marker, observation } = buildValidObservation("noise", 1, false);
    delete (observation as any).memories;
    const result = gradeMemoryRecall({
      caseId: "noise",
      rep: 1,
      marker,
      observation,
      env: {},
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "noise-memory-observation")?.passed).toBe(false);
  });

  it("passes baseline noise on legitimate empty memory outcome with 10 successful heartbeat runs", () => {
    const { marker, observation } = buildValidObservation("noise", 1, false);
    observation.memories = []; // legitimate 0 memories recorded
    const result = gradeMemoryRecall({
      caseId: "noise",
      rep: 1,
      marker,
      observation,
      env: {},
    });
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.id === "noise-memory-observation")?.passed).toBe(true);
  });
});
