import {
  type MemoryAgentCapabilities,
  type MemoryAgentGuidanceContext,
  type MemoryHardeningFlags,
  resolveEffectiveMemoryHardeningFlags,
} from "@paperclipai/adapter-utils/server-utils";
import { readDefaultMcpState } from "../default-mcp-spec.js";
import { BRAIN_BINDING_ARCANA_ENTRY_KEY } from "../arcana-brain-binding.js";

export function resolveHeartbeatEffectiveEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
  adapterConfigEnv?: unknown,
): NodeJS.ProcessEnv {
  const userEnv =
    adapterConfigEnv && typeof adapterConfigEnv === "object"
      ? (adapterConfigEnv as Record<string, string | undefined>)
      : undefined;
  return {
    ...processEnv,
    ...(userEnv ? userEnv : {}),
  };
}

export function resolveHeartbeatMemoryHardeningFlags(input: {
  processEnv?: NodeJS.ProcessEnv;
  runtimeConfig?: Record<string, unknown> | null;
  agentAdapterConfig?: unknown;
}): MemoryHardeningFlags {
  const adapterEnv =
    (input.runtimeConfig?.env ??
    (input.agentAdapterConfig && typeof input.agentAdapterConfig === "object"
      ? (input.agentAdapterConfig as Record<string, unknown>).env
      : undefined)) as Record<string, string | undefined> | undefined;
  return resolveEffectiveMemoryHardeningFlags(
    input.processEnv ?? process.env,
    adapterEnv ?? (input.runtimeConfig as Record<string, string | undefined> | undefined),
  );
}

export interface ComputeMemoryAgentCapabilitiesInput {
  agentMetadata: unknown;
  runtimeMemory: unknown;
  flags: Pick<MemoryHardeningFlags, "hermesMemoryConfig">;
}

export function computeMemoryAgentCapabilities(
  input: ComputeMemoryAgentCapabilitiesInput,
): MemoryAgentCapabilities {
  const mcpState = readDefaultMcpState(input.agentMetadata);
  const arcanaReady =
    mcpState?.entries[BRAIN_BINDING_ARCANA_ENTRY_KEY]?.setup?.state === "ready";

  return {
    mem0: Boolean(input.runtimeMemory),
    arcana: arcanaReady,
    hermesBuiltInStores: !input.flags.hermesMemoryConfig,
  };
}

export function buildHeartbeatMemoryGuidanceContext(input: {
  agentMetadata: unknown;
  runtimeMemory: unknown;
  flags: MemoryHardeningFlags;
}): MemoryAgentGuidanceContext | undefined {
  if (!input.flags.capabilityMemoryGuidance) {
    return undefined;
  }
  return {
    capabilities: computeMemoryAgentCapabilities(input),
    variant: "write-rules",
  };
}
