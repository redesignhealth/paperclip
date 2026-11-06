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

export type ParseMemoryAgentGuidanceContextResult =
  | { status: "absent" }
  | { status: "valid"; data: MemoryAgentGuidanceContext }
  | { status: "malformed"; error: z.ZodError };

export function parseMemoryAgentGuidanceContextResult(
  value: unknown,
): ParseMemoryAgentGuidanceContextResult {
  if (value === undefined) {
    return { status: "absent" };
  }
  const result = memoryAgentGuidanceContextSchema.safeParse(value);
  if (result.success) {
    return { status: "valid", data: result.data };
  }
  return { status: "malformed", error: result.error };
}

export function parseMemoryAgentGuidanceContext(
  value: unknown,
): MemoryAgentGuidanceContext | undefined {
  const result = parseMemoryAgentGuidanceContextResult(value);
  return result.status === "valid" ? result.data : undefined;
}

export function buildMemoryAgentGuidance(ctx: MemoryAgentGuidanceContext): string {
  if (ctx.variant === "legacy") {
    return MEMORY_AGENT_GUIDANCE;
  }

  const lines: string[] = [
    "Memory:",
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
    if (ctx.capabilities.mem0 && ctx.capabilities.arcana) {
      lines.push(
        "- Hermes built-in stores are scratch/local session context, not a durable store; save durable facts only to available Mem0, record progress and durable outcomes in issue comments, and propose source documents to Arcana when its tools are available.",
      );
    } else if (ctx.capabilities.mem0) {
      lines.push(
        "- Hermes built-in stores are scratch/local session context, not a durable store; save durable facts only to available Mem0 and progress to issue comments.",
      );
    } else if (ctx.capabilities.arcana) {
      lines.push(
        "- Hermes built-in stores are scratch/local session context, not a durable store; record progress and durable outcomes in issue comments, and propose source documents to Arcana when its tools are available.",
      );
    } else {
      lines.push(
        "- Hermes built-in stores are scratch/local session context, not a durable store; record progress and durable outcomes in issue comments.",
      );
    }
  }

  lines.push(
    "- Never save secrets, credentials, personal data, PHI, or patient/customer identifiers.",
  );

  return lines.join("\n");
}
