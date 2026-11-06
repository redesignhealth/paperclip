export interface MemoryHardeningFlags {
  readonly hermesMemoryConfig: boolean;
  readonly hermesPromptSplit: boolean;
  readonly agentScopedMem0: boolean;
  readonly capabilityMemoryGuidance: boolean;
}

export class MemoryHardeningConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryHardeningConfigurationError";
  }
}

const ALL_OFF_FLAGS: MemoryHardeningFlags = Object.freeze({
  hermesMemoryConfig: false,
  hermesPromptSplit: false,
  agentScopedMem0: false,
  capabilityMemoryGuidance: false,
});

export function resolveMemoryHardeningFlags(
  env: Record<string, string | undefined> = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env ?? {},
): MemoryHardeningFlags {
  const rawCandidate = env.PAPERCLIP_MEMORY_HARDENING;
  const raw = typeof rawCandidate === "string" ? rawCandidate.trim() : undefined;
  if (!raw) {
    return ALL_OFF_FLAGS;
  }

  let hermesMemoryConfig = false;
  let hermesPromptSplit = false;
  let agentScopedMem0 = false;
  let capabilityMemoryGuidance = false;

  for (const rawSegment of raw.split(",")) {
    const token = rawSegment.trim();
    if (!token) {
      continue;
    }

    switch (token) {
      case "hermes-memory-config":
        hermesMemoryConfig = true;
        break;
      case "hermes-prompt-split":
        hermesPromptSplit = true;
        break;
      case "agent-scoped-mem0":
        agentScopedMem0 = true;
        break;
      case "capability-memory-guidance":
        capabilityMemoryGuidance = true;
        break;
      case "all":
        hermesMemoryConfig = true;
        hermesPromptSplit = true;
        agentScopedMem0 = true;
        capabilityMemoryGuidance = true;
        break;
      default:
        throw new MemoryHardeningConfigurationError(
          `Unknown PAPERCLIP_MEMORY_HARDENING token "${token}"`,
        );
    }
  }

  return Object.freeze({
    hermesMemoryConfig,
    hermesPromptSplit,
    agentScopedMem0,
    capabilityMemoryGuidance,
  });
}

export function mergeMemoryHardeningFlags(
  a: MemoryHardeningFlags,
  b: MemoryHardeningFlags,
): MemoryHardeningFlags {
  return Object.freeze({
    hermesMemoryConfig: a.hermesMemoryConfig || b.hermesMemoryConfig,
    hermesPromptSplit: a.hermesPromptSplit || b.hermesPromptSplit,
    agentScopedMem0: a.agentScopedMem0 || b.agentScopedMem0,
    capabilityMemoryGuidance: a.capabilityMemoryGuidance || b.capabilityMemoryGuidance,
  });
}

/**
 * Resolves memory hardening flags with additive semantics:
 * - Server flags are resolved from `serverEnv` (or process.env).
 * - Agent flags are resolved from `agentEnv` (e.g. agent config.env).
 * - Flags are merged via logical OR: agent config can enable additional hardening
 *   flags, but cannot disable hardening flags enabled by the server.
 * - Fails closed: an unknown token in either environment throws MemoryHardeningConfigurationError.
 */
export function resolveEffectiveMemoryHardeningFlags(
  serverEnv?: Record<string, string | undefined>,
  agentEnv?: Record<string, string | undefined> | null,
): MemoryHardeningFlags {
  const serverFlags = resolveMemoryHardeningFlags(serverEnv);
  if (!agentEnv) {
    return serverFlags;
  }
  const agentFlags = resolveMemoryHardeningFlags(agentEnv);
  return mergeMemoryHardeningFlags(serverFlags, agentFlags);
}

