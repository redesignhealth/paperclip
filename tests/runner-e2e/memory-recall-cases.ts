import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  resolveMemoryHardeningFlags,
  type MemoryHardeningFlags,
} from "../../packages/shared/src/index.js";
import type { RunnerTaskFixture } from "./types.js";
import { MEMORY_RECALL_GRADER_VERSION } from "./memory-recall-scoring.js";

export const MEMORY_HARDENING_CAPABILITIES: Record<
  keyof MemoryHardeningFlags,
  "implemented" | "not-implemented"
> = {
  hermesMemoryConfig: "implemented",
  hermesPromptSplit: "implemented",
  agentScopedMem0: "not-implemented",
  capabilityMemoryGuidance: "not-implemented",
  mem0AutoSyncOff: "implemented",
} as const;

export const UNIMPLEMENTED_MEMORY_HARDENING_TICKETS: Record<
  "agentScopedMem0" | "capabilityMemoryGuidance",
  { token: string; ticket: string }
> = {
  agentScopedMem0: { token: "agent-scoped-mem0", ticket: "TECH-8191" },
  capabilityMemoryGuidance: {
    token: "capability-memory-guidance",
    ticket: "TECH-8192",
  },
} as const;

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

export const memoryRecallHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function memoryRecallDefinitionDigest(): string {
  const files = [
    "memory-recall-cases.ts",
    "memory-recall-flow.ts",
    "memory-recall-observation.ts",
    "memory-recall-scoring.ts",
  ];
  const hasher = createHash("sha256");
  hasher.update(MEMORY_RECALL_GRADER_VERSION + "\0");
  for (const file of files) {
    hasher.update(file + "\0" + readFileSync(new URL(file, import.meta.url), "utf8") + "\0");
  }
  return hasher.digest("hex");
}

const CASE_ID_PATTERN = new RegExp(
  `^(${MEMORY_RECALL_CASES.join("|")})-rep-(\\d+)$`,
);

export function parseMemoryRecallTask(id: string): {
  caseId: MemoryRecallCase;
  rep: number;
} {
  const match = id.match(CASE_ID_PATTERN);
  if (!match) throw new Error(`Unknown memory recall task: ${id}`);
  const caseId = match[1] as MemoryRecallCase;
  const rep = parseInt(match[2]!, 10);
  if (
    !MEMORY_RECALL_CASES.includes(caseId) ||
    !MEMORY_RECALL_REPS.includes(rep as MemoryRecallRep)
  ) {
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
        heartbeatPrompts: Array.from(
          { length: 10 },
          (_, i) =>
            `Routine heartbeat check ${i + 1}: report operational health and confirm task status without creating unnecessary durable facts.`,
        ),
        marker: `NOISE_CHECK_${nonce}`,
      };
  }
}

export const memoryRecallTasks: readonly RunnerTaskFixture[] =
  MEMORY_RECALL_CASES.flatMap((caseId) =>
    MEMORY_RECALL_REPS.map((rep) => {
      const taskId = `${caseId}-rep-${rep}`;
      return {
        requiredCredentials: ["OPENAI_API_KEY"],
        id: taskId,
        label: `Memory recall: ${caseId} (rep ${rep})`,
        groups: ["memory"],
        workMode: "standard",
        flow: "memory_recall",
        expectedRunCount:
          caseId === "noise" ? 10 : caseId === "implicit-recall" ? 3 : 2,
        attemptTimeoutMs: {
          local:
            caseId === "noise"
              ? 20 * 60_000
              : caseId === "implicit-recall"
                ? 12 * 60_000
                : 8 * 60_000,
          daytona:
            caseId === "noise"
              ? 25 * 60_000
              : caseId === "implicit-recall"
                ? 18 * 60_000
                : 12 * 60_000,
        },
        expectedTerminalState: {
          issue: "done",
          run: "succeeded",
        },
        buildTitle: (nonce: string) =>
          `Memory eval ${caseId} rep ${rep} ${nonce}`,
        buildPrompt: (nonce: string): string => {
          const scenario = memoryRecallScenario(caseId, nonce);
          if (scenario.caseId === "save-then-fresh-recall")
            return scenario.savePrompt;
          if (scenario.caseId === "implicit-recall")
            return scenario.controlPrompt;
          if (scenario.caseId === "cross-agent-leak")
            return scenario.agentXPrompt;
          return (
            scenario.heartbeatPrompts[0] ?? `Heartbeat check for ${nonce}`
          );
        },
        buildVisibleMarker: (nonce: string) => {
          const scenario = memoryRecallScenario(caseId, nonce);
          return scenario.marker;
        },
        buildMatchers: () => [],
      };
    }),
  );
