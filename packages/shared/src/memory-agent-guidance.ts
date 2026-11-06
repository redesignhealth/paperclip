import { z } from "zod";

/**
 * Canonical memory-routing instructions appended to every agent run prompt.
 *
 * Tool syntax is left to each tool's own schema and to the Arcana proposals
 * reference; this text only routes knowledge to its one home.
 */
export const MEMORY_AGENT_GUIDANCE = [
  "Memory:",
  "- Task progress and handoffs go in issue comments, not memory.",
  "- Arcana is your knowledge layer: the documents and source material you work from (docs, research, specs, finished write-ups). Check it before relying on your own assumptions, and open the source before relying on a result. Propose new documents only after reading `skills/paperclip/references/arcana-brain-proposals.md`.",
  "- Mem0 is your learned memory: owner preferences, decisions (with reason and date), lessons, environment facts, procedures that worked. Mark inferences \"(inferred)\". It also saves conversation automatically, so treat recalled memories as hints: Arcana, the issue, or a source you just read wins. Preferences, decisions and lessons go to Mem0, not Arcana, even if older instructions say otherwise.",
  "- Hermes MEMORY.md/USER.md are wiped after each run; don't use them.",
  "- Never save secrets, credentials, PHI or PII.",
].join("\n");

export interface MemoryAgentCapabilities {
  mem0: boolean;
  arcana: boolean;
  hermesBuiltInStores: boolean;
}

export type MemoryAgentGuidanceVariant = "legacy" | "write-rules";

export interface MemoryAgentGuidanceContext {
  capabilities: MemoryAgentCapabilities;
  variant: MemoryAgentGuidanceVariant;
}

export const memoryAgentCapabilitiesSchema = z.object({
  mem0: z.boolean(),
  arcana: z.boolean(),
  hermesBuiltInStores: z.boolean(),
});

export const memoryAgentGuidanceVariantSchema = z.enum(["legacy", "write-rules"]);

export const memoryAgentGuidanceContextSchema = z.object({
  capabilities: memoryAgentCapabilitiesSchema,
  variant: memoryAgentGuidanceVariantSchema,
});

export function parseMemoryAgentGuidanceContext(
  value: unknown,
): MemoryAgentGuidanceContext | undefined {
  const result = memoryAgentGuidanceContextSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function buildMemoryAgentGuidance(ctx: MemoryAgentGuidanceContext): string {
  if (ctx.variant === "legacy") {
    return MEMORY_AGENT_GUIDANCE;
  }

  const lines: string[] = [
    "- Task progress belongs in issue comments, not memory.",
  ];

  if (ctx.capabilities.arcana) {
    lines.push(
      "- Arcana brain tools exist; prefer them for durable cross-run knowledge.",
    );
  }

  if (ctx.capabilities.mem0) {
    lines.push(
      "- Mem0: save short, self-contained facts (one fact per memory; include the why); recall by searching before asking again.",
    );
  }

  if (ctx.capabilities.hermesBuiltInStores) {
    if (ctx.capabilities.mem0) {
      lines.push(
        "- Hermes built-in stores handle session continuity; do not duplicate that in Mem0.",
      );
    } else {
      lines.push(
        "- Hermes built-in stores handle session continuity.",
      );
    }
  }

  lines.push(
    "- Never save secrets, credentials, personal data, PHI, or patient/customer identifiers.",
  );

  return `${lines.join("\n")}\n`;
}
