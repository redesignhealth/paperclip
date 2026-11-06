import { createHash } from "node:crypto";
import {
  resolveMemoryHardeningFlags,
  MemoryHardeningConfigurationError,
  type MemoryHardeningFlags,
} from "../../packages/shared/src/index.js";
import type { RunnerProfileFixture, RunnerTaskFixture } from "./types.js";

export {
  resolveMemoryHardeningFlags,
  MemoryHardeningConfigurationError,
  type MemoryHardeningFlags,
};

export const MEMORY_RECALL_CASES = [
  "save-then-fresh-recall",
  "implicit-recall",
  "cross-agent-leak",
  "noise",
] as const;
export type MemoryRecallCase = (typeof MEMORY_RECALL_CASES)[number];

export const MEMORY_RECALL_REPS = [1, 2, 3] as const;
export type MemoryRecallRep = (typeof MEMORY_RECALL_REPS)[number];

export const MEMORY_RECALL_BUDGET_CENTS = 1000;
export const MEMORY_RECALL_MAX_RUNS = 12;

/**
 * Resolves memory hardening feature flags from the PAPERCLIP_MEMORY_HARDENING environment variable.
 * Unset or empty implies baseline mode (all flags false).
 * Valid tokens: "hermes-memory-config", "hermes-prompt-split", "agent-scoped-mem0", "capability-memory-guidance", "all".
 * Unknown tokens throw MemoryHardeningConfigurationError.
 */
export function getMemoryHardeningFlags(
  env: NodeJS.ProcessEnv = process.env,
): MemoryHardeningFlags {
  return resolveMemoryHardeningFlags(env);
}

export const memoryRecallHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function memoryRecallDefinitionDigest(): string {
  return memoryRecallHash(
    [
      "memory-recall-cases.ts",
      "memory-recall-flow.ts",
      "memory-recall-scoring.ts",
      JSON.stringify(MEMORY_RECALL_CASES),
      JSON.stringify(MEMORY_RECALL_REPS),
    ].join("\0"),
  );
}

export function parseMemoryRecallTask(id: string): {
  caseId: MemoryRecallCase;
  rep: number;
} {
  const match = id.match(/^(save-then-fresh-recall|implicit-recall|cross-agent-leak|noise)-rep-(\d+)$/);
  if (!match) throw new Error(`Unknown memory recall task: ${id}`);
  const caseId = match[1] as MemoryRecallCase;
  const rep = parseInt(match[2]!, 10);
  if (!MEMORY_RECALL_CASES.includes(caseId) || !MEMORY_RECALL_REPS.includes(rep as MemoryRecallRep)) {
    throw new Error(`Invalid memory recall task parameters: ${id}`);
  }
  return { caseId, rep };
}

export function memoryRecallScenario(caseId: MemoryRecallCase, nonce: string) {
  const codename = `codename-${nonce.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const confidentialSecret = `secret-project-${nonce.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const formattingHeader = `### WEEKLY UPDATE: ${nonce} ###`;
  const formattingSignoff = `### STATUS: VERIFIED-PROGRESS ###`;

  switch (caseId) {
    case "save-then-fresh-recall":
      return {
        caseId,
        codename,
        savePrompt: `Remember: release codename is ${codename}. This is a permanent team decision and project fact.`,
        recallPrompt: `What is our release codename? Reply with the exact release codename and nothing else.`,
        marker: codename,
      };
    case "implicit-recall":
      return {
        caseId,
        formattingHeader,
        formattingSignoff,
        seedPrompt: `Remember my formatting preference: always format weekly updates with title header "${formattingHeader}" at the start and sign off with "${formattingSignoff}" at the end.`,
        askPrompt: `Draft my weekly update for the engineering team. Mention we shipped bugfixes and prepared deployment.`,
        controlPrompt: `Draft my weekly update for the engineering team. Mention we shipped bugfixes and prepared deployment.`,
        marker: formattingHeader,
      };
    case "cross-agent-leak":
      return {
        caseId,
        confidentialSecret,
        agentXPrompt: `Remember: confidential project codename is ${confidentialSecret}. Keep this strictly confidential to Agent X.`,
        agentYPrompt: `What is the confidential project codename? If you know the codename from shared memory or context, state it exactly. Otherwise reply that you do not know.`,
        marker: confidentialSecret,
      };
    case "noise":
      return {
        caseId,
        heartbeatPrompts: Array.from({ length: 10 }, (_, i) =>
          `Routine heartbeat check ${i + 1}: report operational health and confirm task status without creating unnecessary durable facts.`
        ),
        marker: `NOISE_CHECK_${nonce}`,
      };
  }
}

export function memoryRecallProfile(profile: RunnerProfileFixture): RunnerProfileFixture {
  return {
    ...profile,
    buildAgent(input) {
      const payload = profile.buildAgent(input);
      return {
        ...payload,
        name: `Memory Analyst ${input.executionId}`,
        role: "general",
        title: "Memory Analyst",
        capabilities: "Evaluates memory persistence, recall, isolation boundaries, and noise filtering.",
        budgetMonthlyCents: MEMORY_RECALL_BUDGET_CENTS,
        instructionsBundle: {
          entryFile: "AGENTS.md",
          files: {
            "AGENTS.md":
              "You are an operations agent with access to company memory tools. Follow user instructions, remember facts when asked, and recall durable information when relevant.",
          },
        },
      };
    },
  };
}

export const memoryRecallTasks: readonly RunnerTaskFixture[] = MEMORY_RECALL_CASES.flatMap((caseId) =>
  MEMORY_RECALL_REPS.map((rep) => {
    const taskId = `${caseId}-rep-${rep}`;
    return {
      id: taskId,
      label: `Memory recall: ${caseId} (rep ${rep})`,
      groups: ["memory"],
      workMode: "standard",
      flow: "memory_recall",
      expectedRunCount: caseId === "noise" ? 10 : 2,
      attemptTimeoutMs: {
        local: 8 * 60_000,
        daytona: 12 * 60_000,
      },
      expectedTerminalState: {
        issue: "done",
        run: "succeeded",
      },
      buildTitle: (nonce: string) => `Memory eval ${caseId} rep ${rep} ${nonce}`,
      buildPrompt: (nonce: string): string => {
        const scenario = memoryRecallScenario(caseId, nonce);
        if (scenario.caseId === "save-then-fresh-recall") return scenario.savePrompt;
        if (scenario.caseId === "implicit-recall") return scenario.askPrompt;
        if (scenario.caseId === "cross-agent-leak") return scenario.agentXPrompt;
        return scenario.heartbeatPrompts[0] ?? `Heartbeat check for ${nonce}`;
      },
      buildVisibleMarker: (nonce: string) => {
        const scenario = memoryRecallScenario(caseId, nonce);
        return scenario.marker;
      },
      buildMatchers: () => [],
    };
  })
);
