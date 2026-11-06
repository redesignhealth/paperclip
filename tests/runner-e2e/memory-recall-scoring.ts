import {
  resolveMemoryHardeningFlags,
  type MemoryHardeningFlags,
} from "../../packages/shared/src/index.js";
import {
  MEMORY_HARDENING_CAPABILITIES,
  UNIMPLEMENTED_MEMORY_HARDENING_TICKETS,
  type MemoryRecallCase,
} from "./memory-recall-cases.js";
import type { TypedToolRecord } from "./memory-recall-observation.js";

export const MEMORY_CATEGORIES = [
  "template_boilerplate",
  "task_status",
  "durable_fact",
  "duplicate_conflicting",
  "unclassified",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_RECALL_GRADER_VERSION = "paperclip.memory-recall.v1";

export interface MemoryRecallRunRecord {
  id: string;
  agentId: string;
  status: string;
  issueId?: string;
  result?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    usageSource?: string;
  };
  durationMs?: number;
  toolRecords?: TypedToolRecord[];
  logText?: string;
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
  issues?: Array<{ id: string; status: string; title?: string; description?: string }>;
  comments?: Array<{ id: string; issueId: string; authorAgentId?: string; body: string }>;
  memories?: MemoryItem[];
  controlOutput?: string;
  secondaryAgentId?: string;
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
    runTokenCost?: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      totalTokens: number;
      count: number;
    };
    noiseSummary?: {
      totalNewMemories: number;
      byCategory: Record<MemoryCategory, number>;
      noiseRatio: number;
    };
    implicitRecall?: {
      followsPreference: boolean;
      controlUnbiased: boolean;
    };
  };
}

/**
 * Classifies a raw memory entry into one of the rubric categories:
 * - template_boilerplate: prompt templates, system instructions, tool signatures
 * - task_status: transient progress logs, heartbeat acks, run state updates
 * - durable_fact: user preferences, permanent codenames, project conventions
 * - duplicate_conflicting: duplicate entries or direct contradictions
 * - unclassified: text not matching above rules
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

  return "unclassified";
}

export function summarizeMemories(memories: MemoryItem[]): {
  classified: Array<MemoryItem & { category: MemoryCategory }>;
  byCategory: Record<MemoryCategory, number>;
  totalCount: number;
  noiseCount: number;
  noiseRatio: number;
} {
  const counts: Record<MemoryCategory, number> = {
    template_boilerplate: 0,
    task_status: 0,
    durable_fact: 0,
    duplicate_conflicting: 0,
    unclassified: 0,
  };
  const classified = memories.map((m, idx) => {
    const priors = memories.slice(0, idx).map((p) => p.data);
    const category = m.category ?? classifyMemory(m.data, priors);
    counts[category]++;
    return { ...m, category };
  });
  const totalCount = classified.length;
  const noiseCount = counts.template_boilerplate + counts.task_status;
  const noiseRatio = totalCount > 0 ? noiseCount / totalCount : 0;
  return { classified, byCategory: counts, totalCount, noiseCount, noiseRatio };
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
  const flags = input.flags ?? resolveMemoryHardeningFlags(input.env ?? process.env);

  // Defensive throw if any enabled flag is not implemented
  for (const [flagKey, status] of Object.entries(MEMORY_HARDENING_CAPABILITIES) as [
    keyof MemoryHardeningFlags,
    "implemented" | "not-implemented",
  ][]) {
    if (flags[flagKey] && status === "not-implemented") {
      const info =
        UNIMPLEMENTED_MEMORY_HARDENING_TICKETS[
          flagKey as keyof typeof UNIMPLEMENTED_MEMORY_HARDENING_TICKETS
        ];
      throw new Error(
        `Memory hardening flag '${info.token}' is not implemented on this branch (blocked pending ${info.ticket}).`,
      );
    }
  }

  const checks: MemoryRecallCheck[] = [];
  const check = (id: string, passed: boolean, detail: string) =>
    checks.push({ id, passed, detail });

  const runs = obs.runs ?? [];
  const memories = obs.memories ?? [];
  const comments = obs.comments ?? [];

  switch (caseId) {
    case "save-then-fresh-recall": {
      check(
        "runs-recorded",
        runs.length >= 2 && runs.every((r) => ["succeeded", "done"].includes(r.status)),
        `Recorded ${runs.length} runs; save and recall runs must complete successfully.`,
      );

      const runA = runs[0];
      const runB = runs[1];

      const runAValid = Boolean(runA && (runA.status === "succeeded" || runA.status === "done"));
      const runBValid = Boolean(runB && (runB.status === "succeeded" || runB.status === "done"));
      check("dual-run-completion", runAValid && runBValid, "Both save run A and recall run B must succeed.");

      // Verify memory was extracted/stored from Run A into tenant DB AND typed mem0_add completed
      const memorySaved = memories.some((m) => m.data.toLowerCase().includes(marker.toLowerCase()));
      const typedAddCompleted = (runA?.toolRecords ?? []).some((tr) => tr.tool === "mem0_add");
      check(
        "memory-persisted-in-mem0",
        memorySaved && typedAddCompleted,
        `Release codename '${marker}' must be persisted in tenant DB row and typed mem0_add completed in save run.`,
      );

      // Verify fresh Run B recalled the codename AND typed mem0_search completed AND marker absent from recall issue text
      const recallIssue = obs.issues?.find((i) => i.id === runB?.issueId);
      const recallIssueText = `${recallIssue?.title ?? ""} ${recallIssue?.description ?? ""}`;
      const markerAbsentFromIssue = !recallIssueText.toLowerCase().includes(marker.toLowerCase());

      const runBText = [
        runB?.result ?? "",
        ...comments.filter((c) => c.issueId === runB?.issueId).map((c) => c.body),
      ].join("\n");
      const recalled = runBText.toLowerCase().includes(marker.toLowerCase());
      const typedSearchCompleted = (runB?.toolRecords ?? []).some((tr) => tr.tool === "mem0_search");

      check(
        "fresh-session-recall-matched",
        recalled && typedSearchCompleted && markerAbsentFromIssue,
        `Fresh recall session Run B must return saved codename '${marker}', mem0_search must be logged, and marker absent from recall issue.`,
      );
      break;
    }

    case "implicit-recall": {
      // In baseline: emit metrics only (zero checks)
      // In hardened: check implicit-preference-applied and guidance-off-control-unbiased
      const draftRun = runs.find((r) => r.issueId && r.issueId !== obs.issues?.[0]?.id && r.issueId !== obs.issues?.[1]?.id) ?? runs[runs.length - 1];
      const draftText = [
        draftRun?.result ?? "",
        ...comments.filter((c) => c.issueId === draftRun?.issueId).map((c) => c.body),
      ].join("\n");

      const followsPreference = draftText.includes(marker);
      const controlText = obs.controlOutput ?? "";
      const controlUnbiased = controlText.length > 0 && !controlText.includes(marker);

      if (flags.capabilityMemoryGuidance) {
        check(
          "implicit-preference-applied",
          followsPreference,
          `Draft update must follow the seeded formatting preference ('${marker}') via capability memory guidance.`,
        );
        check(
          "guidance-off-control-unbiased",
          controlUnbiased,
          "Guidance-off control run must not hallucinate or use the synthetic formatting marker.",
        );
      }
      break;
    }

    case "cross-agent-leak": {
      // Precondition: Agent Y run belongs to Agent Y and its prompt has no marker
      const secondaryAgentId = obs.secondaryAgentId;
      const agentYRun = runs.length > 1 ? runs[1] : runs[0];
      const agentYIssue = obs.issues?.find((i) => i.id === agentYRun?.issueId);
      const agentYIssueText = `${agentYIssue?.title ?? ""} ${agentYIssue?.description ?? ""}`;

      const runBelongsToAgentY = Boolean(secondaryAgentId && agentYRun?.agentId === secondaryAgentId);
      const promptHasNoMarker = !agentYIssueText.toLowerCase().includes(marker.toLowerCase());
      const preconditionMet = runBelongsToAgentY && promptHasNoMarker;

      const agentYText = [
        agentYRun?.result ?? "",
        ...comments.filter((c) => c.issueId === agentYRun?.issueId).map((c) => c.body),
      ].join("\n");

      const leaked = agentYText.toLowerCase().includes(marker.toLowerCase());

      check(
        "runs-recorded",
        runs.length >= 2 && runs.every((r) => ["succeeded", "done"].includes(r.status)),
        `Recorded ${runs.length} runs; Agent X and Agent Y runs must complete successfully.`,
      );

      if (flags.agentScopedMem0) {
        check(
          "cross-agent-isolation",
          preconditionMet && !leaked,
          !preconditionMet
            ? "Precondition failed: Agent Y run does not belong to secondary agent or prompt contained marker."
            : leaked
              ? `Cross-agent memory leak detected! Agent Y accessed confidential secret '${marker}' saved by Agent X.`
              : "Agent Y correctly isolated from Agent X confidential memory.",
        );
      } else {
        // Baseline expectation: cross-agent leak occurs because mem0 is unpartitioned by agent
        check(
          "baseline-leak-observed",
          preconditionMet && leaked,
          !preconditionMet
            ? "Precondition failed: Agent Y run does not belong to secondary agent or prompt contained marker."
            : leaked
              ? `Baseline unpartitioned memory leak observed as expected: Agent Y returned Agent X's secret '${marker}'.`
              : "Baseline cross-agent leak was not observed.",
        );
      }
      break;
    }

    case "noise": {
      const summary = summarizeMemories(memories);
      if (flags.hermesMemoryConfig) {
        const heartbeatRuns = runs.filter((r) => r.status === "succeeded" || r.status === "done");
        check(
          "heartbeat-run-count",
          heartbeatRuns.length >= 10,
          `Expected at least 10 ordinary heartbeat runs; observed ${heartbeatRuns.length}.`,
        );

        // Min-sample guard that FAILS if fewer than 5 memories, else ratio <= 0.3
        const minSampleMet = summary.totalCount >= 5;
        const bounded = minSampleMet && summary.noiseRatio <= 0.3;
        check(
          "hardened-noise-bounded",
          bounded,
          !minSampleMet
            ? `Insufficient sample: observed ${summary.totalCount} new memories (minimum 5 required for evaluation).`
            : `Noise ratio under hardening must be bounded <= 30% (observed: ${(summary.noiseRatio * 100).toFixed(1)}%, count: ${summary.noiseCount}/${summary.totalCount}).`,
        );
      }
      // Baseline noise: emit metrics only (zero checks)
      break;
    }
  }

  // Calculate metrics
  const searchLatencies: number[] = [];
  for (const r of runs) {
    for (const tr of r.toolRecords ?? []) {
      if (tr.tool === "mem0_search" && tr.durationMs >= 0) {
        searchLatencies.push(tr.durationMs);
      }
    }
  }

  const recallLatency =
    searchLatencies.length > 0
      ? {
          avgMs: Math.round(searchLatencies.reduce((a, b) => a + b, 0) / searchLatencies.length),
          minMs: Math.min(...searchLatencies),
          maxMs: Math.max(...searchLatencies),
          count: searchLatencies.length,
        }
      : undefined;

  const runsWithUsage = runs.filter(
    (r) =>
      typeof r.usage?.inputTokens === "number" ||
      typeof r.usage?.outputTokens === "number",
  );
  const runTokenCost =
    runsWithUsage.length > 0
      ? {
          inputTokens: runsWithUsage.reduce((acc, r) => acc + (r.usage?.inputTokens ?? 0), 0),
          cachedInputTokens: runsWithUsage.reduce((acc, r) => acc + (r.usage?.cachedInputTokens ?? 0), 0),
          outputTokens: runsWithUsage.reduce((acc, r) => acc + (r.usage?.outputTokens ?? 0), 0),
          totalTokens: runsWithUsage.reduce(
            (acc, r) => acc + ((r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0)),
            0,
          ),
          count: runsWithUsage.length,
        }
      : undefined;

  let noiseSummary: MemoryRecallScoreResult["metrics"]["noiseSummary"] = undefined;
  if (caseId === "noise" || memories.length > 0) {
    const summary = summarizeMemories(memories);
    noiseSummary = {
      totalNewMemories: summary.totalCount,
      byCategory: summary.byCategory,
      noiseRatio: summary.noiseRatio,
    };
  }

  let implicitRecallMetrics: MemoryRecallScoreResult["metrics"]["implicitRecall"] = undefined;
  if (caseId === "implicit-recall") {
    const draftRun = runs[runs.length - 1];
    const draftText = [
      draftRun?.result ?? "",
      ...comments.filter((c) => c.issueId === draftRun?.issueId).map((c) => c.body),
    ].join("\n");
    const followsPreference = draftText.includes(marker);
    const controlText = obs.controlOutput ?? "";
    const controlUnbiased = controlText.length > 0 && !controlText.includes(marker);
    implicitRecallMetrics = {
      followsPreference,
      controlUnbiased,
    };
  }

  const passedChecks = checks.filter((c) => c.passed).length;
  const totalChecks = checks.length;
  const passRate = totalChecks > 0 ? passedChecks / totalChecks : 1;
  const passed = totalChecks === 0 ? true : checks.every((c) => c.passed);

  return {
    passed,
    caseId,
    rep,
    passRate,
    checks,
    metrics: {
      ...(recallLatency ? { recallLatency } : {}),
      ...(runTokenCost ? { runTokenCost } : {}),
      ...(noiseSummary ? { noiseSummary } : {}),
      ...(implicitRecallMetrics ? { implicitRecall: implicitRecallMetrics } : {}),
    },
  };
}
