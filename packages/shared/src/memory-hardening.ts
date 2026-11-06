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
  const raw = env.PAPERCLIP_MEMORY_HARDENING?.trim();
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
