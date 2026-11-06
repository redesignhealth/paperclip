import {
  resolveMemoryHardeningFlags,
  type MemoryHardeningFlags,
} from "../../packages/shared/src/index.js";
import type { MemoryRecallCase } from "./memory-recall-cases.js";

export const MEMORY_CATEGORIES = [
  "template_boilerplate",
  "task_status",
  "durable_fact",
  "duplicate_conflicting",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_RECALL_GRADER_VERSION = "paperclip.memory-recall.v1";

export interface MemoryRecallRunRecord {
  id: string;
  agentId: string;
  status: string;
  issueId?: string;
  output?: string;
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown>; result?: unknown }>;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  recallLatencyMs?: number;
  extractionTokens?: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface MemoryItem {
  id: string;
  agentId?: string;
  userId?: string;
  data: string;
  category?: MemoryCategory;
  createdAt?: string;
}

export interface MemoryRecallObservation {
  caseId: MemoryRecallCase;
  rep: number;
  nonce: string;
  runs: MemoryRecallRunRecord[];
  issues?: Array<{ id: string; status: string; title?: string }>;
  comments?: Array<{ id: string; issueId: string; authorAgentId?: string; body: string }>;
  memories?: MemoryItem[];
  controlOutput?: string;
}

export interface MemoryRecallCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface MemoryRecallScoreResult {
  passed: boolean;
  caseId: MemoryRecallCase;
  rep: number;
  passRate: number;
  checks: MemoryRecallCheck[];
  metrics: {
    recallLatency?: {
      avgMs: number;
      minMs: number;
      maxMs: number;
      count: number;
    };
    extractionTokenCost?: {
      totalTokens: number;
      avgTokensPerRun: number;
      count: number;
    };
    noiseSummary?: {
      totalNewMemories: number;
      byCategory: Record<MemoryCategory, number>;
      noiseRatio: number;
    };
  };
}

/**
 * Classifies a raw memory entry into one of the four rubric categories:
 * - template_boilerplate: prompt templates, system instructions, tool signatures
 * - task_status: transient progress logs, heartbeat acks, run state updates
 * - durable_fact: user preferences, permanent codenames, project conventions
 * - duplicate_conflicting: duplicate entries or direct contradictions
 */
export function classifyMemory(text: string, existingMemories: string[] = []): MemoryCategory {
  const normalized = (text ?? "").trim().toLowerCase();
  if (!normalized) return "template_boilerplate";

  // Check for duplicate / conflicting
  if (existingMemories.some((existing) => existing.trim().toLowerCase() === normalized)) {
    return "duplicate_conflicting";
  }

  // Template / boilerplate detection
  const boilerplatePatterns = [
    /you are (an? )?(ai|assistant|worker|agent)/i,
    /system instructions?:/i,
    /agents\.md/i,
    /available tools?:/i,
    /paperclip instructions?:/i,
    /standard operating procedure/i,
    /use the following format:/i,
    /tool execution syntax/i,
  ];
  if (boilerplatePatterns.some((pattern) => pattern.test(text))) {
    return "template_boilerplate";
  }

  // Ephemeral task status detection
  const statusPatterns = [
    /heartbeat check \d+/i,
    /task (status|progress) is/i,
    /started working on/i,
    /finished step \d+/i,
    /routine health check/i,
    /operational health confirmed/i,
    /running turn \d+/i,
    /heartbeat acknowledged/i,
  ];
  if (statusPatterns.some((pattern) => pattern.test(text))) {
    return "task_status";
  }

  // Durable facts
  const durablePatterns = [
    /codename is/i,
    /release codename/i,
    /preference/i,
    /weekly update/i,
    /format.*with/i,
    /confidential project/i,
    /secret-project/i,
    /permanent/i,
    /always (use|format|prefix|sign)/i,
  ];
  if (durablePatterns.some((pattern) => pattern.test(text))) {
    return "durable_fact";
  }

  // Default heuristic: short declarative facts are durable facts; verbose procedural text is boilerplate
  return text.length > 300 ? "template_boilerplate" : "durable_fact";
}

export function gradeMemoryRecall(input: {
  caseId: MemoryRecallCase;
  rep: number;
  marker: string;
  observation: MemoryRecallObservation;
  flags?: MemoryHardeningFlags;
  env?: NodeJS.ProcessEnv;
}): MemoryRecallScoreResult {
  const { caseId, rep, marker, observation: obs } = input;
  const checks: MemoryRecallCheck[] = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });

  const flags = input.flags ?? resolveMemoryHardeningFlags(input.env ?? process.env);
  const runs = obs.runs ?? [];
  const memories = obs.memories ?? [];
  const comments = obs.comments ?? [];

  // General run sanity check
  check(
    "runs-recorded",
    runs.length > 0 && runs.every((r) => ["succeeded", "done"].includes(r.status)),
    `Recorded ${runs.length} runs; all runs must complete successfully without crashes.`,
  );

  switch (caseId) {
    case "save-then-fresh-recall": {
      // Run A saves the codename, Run B in fresh session recalls it (context only, no flag-specific expectation)
      const runA = runs[0];
      const runB = runs[1];

      const runAValid = Boolean(runA && (runA.status === "succeeded" || runA.status === "done"));
      const runBValid = Boolean(runB && (runB.status === "succeeded" || runB.status === "done"));
      check("dual-run-completion", runAValid && runBValid, "Both save run A and recall run B must succeed.");

      // Verify memory was extracted/stored from Run A
      const memorySaved =
        memories.some((m) => m.data.toLowerCase().includes(marker.toLowerCase())) ||
        (runA?.toolCalls?.some((tc) => tc.name.includes("memory") || tc.name.includes("mem0_add")) ?? false);
      check("memory-persisted-in-mem0", memorySaved, `The release codename '${marker}' must be persisted in Mem0 memory.`);

      // Verify fresh Run B recalled the codename
      const runBText = [
        runB?.output ?? "",
        ...comments.filter((c) => c.authorAgentId === runB?.agentId).map((c) => c.body),
      ].join("\n");
      const recalled = runBText.toLowerCase().includes(marker.toLowerCase());
      check("fresh-session-recall-matched", recalled, `Fresh recall session Run B must return the saved codename '${marker}'.`);
      break;
    }

    case "implicit-recall": {
      // Driven by flags.capabilityMemoryGuidance
      const draftRun = runs[0];
      const draftText = [
        draftRun?.output ?? "",
        ...comments.filter((c) => c.authorAgentId === draftRun?.agentId).map((c) => c.body),
      ].join("\n");

      const followsPreference = draftText.includes(marker);
      const controlText = obs.controlOutput ?? "";
      const controlUnbiased = !controlText.includes(marker);

      if (flags.capabilityMemoryGuidance) {
        check(
          "implicit-preference-applied",
          followsPreference,
          `Draft update must follow the seeded formatting preference ('${marker}') via capability memory guidance.`,
        );
        check(
          "guidance-off-control-unbiased",
          obs.controlOutput !== undefined && controlUnbiased,
          "Guidance-off control run must not hallucinate or use the synthetic formatting marker.",
        );
      } else {
        check(
          "guidance-off-control-unbiased",
          obs.controlOutput !== undefined && controlUnbiased,
          "Guidance-off control run must not hallucinate or use the synthetic formatting marker.",
        );
        check(
          "baseline-guidance-disabled",
          true,
          "Baseline execution without capability memory guidance confirmed.",
        );
      }
      break;
    }

    case "cross-agent-leak": {
      // Driven by flags.agentScopedMem0:
      // leak is expected when !flags.agentScopedMem0; must not leak when flags.agentScopedMem0.
      const agentYRun = runs.length > 1 ? runs[1] : runs[0];
      const agentYText = [
        agentYRun?.output ?? "",
        ...comments.filter((c) => c.authorAgentId === agentYRun?.agentId).map((c) => c.body),
      ].join("\n");

      const leaked = agentYText.toLowerCase().includes(marker.toLowerCase());

      if (flags.agentScopedMem0) {
        check(
          "cross-agent-isolation",
          !leaked,
          leaked
            ? `Cross-agent memory leak detected! Agent Y accessed confidential secret '${marker}' saved by Agent X.`
            : "Agent Y correctly isolated from Agent X confidential memory.",
        );
      } else {
        // Baseline expectation: cross-agent leak occurs because mem0 is unpartitioned by agent
        check(
          "baseline-leak-observed",
          leaked,
          leaked
            ? `Baseline unpartitioned memory leak observed as expected: Agent Y returned Agent X's secret '${marker}'.`
            : "Baseline cross-agent leak was not observed.",
        );
      }
      break;
    }

    case "noise": {
      // Driven by flags.hermesMemoryConfig and flags.capabilityMemoryGuidance
      const heartbeatRuns = runs.filter((r) => r.status === "succeeded" || r.status === "done");
      check(
        "heartbeat-run-count",
        heartbeatRuns.length >= 10,
        `Expected at least 10 ordinary heartbeat runs; observed ${heartbeatRuns.length}.`,
      );

      const classified = memories.map((m, idx) => {
        const priors = memories.slice(0, idx).map((p) => p.data);
        return {
          ...m,
          category: m.category ?? classifyMemory(m.data, priors),
        };
      });

      const counts: Record<MemoryCategory, number> = {
        template_boilerplate: 0,
        task_status: 0,
        durable_fact: 0,
        duplicate_conflicting: 0,
      };

      for (const m of classified) {
        counts[m.category]++;
      }

      const totalNew = classified.length;
      const noiseCount = counts.template_boilerplate + counts.task_status;
      const noiseRatio = totalNew > 0 ? noiseCount / totalNew : 0;

      check(
        "noise-classified",
        totalNew >= 0 && Object.values(counts).every((n) => Number.isFinite(n) && n >= 0),
        `Classified ${totalNew} memories across 10 heartbeat runs into rubric categories.`,
      );

      if (flags.hermesMemoryConfig && flags.capabilityMemoryGuidance) {
        check(
          "hardened-noise-bounded",
          noiseRatio <= 0.3 || totalNew <= 5,
          `Noise ratio under hardening must be bounded (observed ratio: ${(noiseRatio * 100).toFixed(1)}%, count: ${noiseCount}/${totalNew}).`,
        );
      } else {
        // Baseline reports counts and ratio
        check(
          "baseline-noise-profiled",
          true,
          `Baseline noise profiled: ${totalNew} memories, noise ratio ${(noiseRatio * 100).toFixed(1)}% (boilerplate: ${counts.template_boilerplate}, status: ${counts.task_status}).`,
        );
      }
      break;
    }
  }

  // Calculate metrics
  const validLatencies = runs
    .map((r) => r.recallLatencyMs)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);

  const recallLatency =
    validLatencies.length > 0
      ? {
          avgMs: Math.round(validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length),
          minMs: Math.min(...validLatencies),
          maxMs: Math.max(...validLatencies),
          count: validLatencies.length,
        }
      : undefined;

  const validTokens = runs
    .map((r) => r.extractionTokens ?? r.totalTokens)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);

  const extractionTokenCost =
    validTokens.length > 0
      ? {
          totalTokens: validTokens.reduce((a, b) => a + b, 0),
          avgTokensPerRun: Math.round(validTokens.reduce((a, b) => a + b, 0) / validTokens.length),
          count: validTokens.length,
        }
      : undefined;

  // Noise summary if memories exist
  let noiseSummary: MemoryRecallScoreResult["metrics"]["noiseSummary"] = undefined;
  if (caseId === "noise" || memories.length > 0) {
    const counts: Record<MemoryCategory, number> = {
      template_boilerplate: 0,
      task_status: 0,
      durable_fact: 0,
      duplicate_conflicting: 0,
    };
    memories.forEach((m, idx) => {
      const priors = memories.slice(0, idx).map((p) => p.data);
      const cat = m.category ?? classifyMemory(m.data, priors);
      counts[cat]++;
    });
    const total = memories.length;
    const noiseCount = counts.template_boilerplate + counts.task_status;
    noiseSummary = {
      totalNewMemories: total,
      byCategory: counts,
      noiseRatio: total > 0 ? noiseCount / total : 0,
    };
  }

  const passedChecks = checks.filter((c) => c.passed).length;
  const totalChecks = checks.length;
  const passRate = totalChecks > 0 ? passedChecks / totalChecks : 0;
  const passed = totalChecks > 0 && checks.every((c) => c.passed);

  return {
    passed,
    caseId,
    rep,
    passRate,
    checks,
    metrics: {
      ...(recallLatency ? { recallLatency } : {}),
      ...(extractionTokenCost ? { extractionTokenCost } : {}),
      ...(noiseSummary ? { noiseSummary } : {}),
    },
  };
}
