import type {
  MemoryAgentCapabilities,
  MemoryAgentGuidanceContext,
  MemoryHardeningFlags,
} from "@paperclipai/adapter-utils/server-utils";
import { readDefaultMcpState } from "../default-mcp-spec.js";
import { BRAIN_BINDING_ARCANA_ENTRY_KEY } from "../arcana-brain-binding.js";
import { HERMES_ADAPTER_TYPE } from "./run-state.js";

export interface ComputeMemoryAgentCapabilitiesInput {
  agentMetadata: unknown;
  runtimeMemory: unknown;
  flags: Pick<MemoryHardeningFlags, "hermesMemoryConfig">;
  /**
   * Adapter type for the executing agent. When specified, hermesBuiltInStores
   * is only enabled for Hermes adapters (HERMES_ADAPTER_TYPE / "hermes_local").
   * Non-Hermes adapters must not emit Hermes-specific store guidance.
   */
  adapterType: string | null | undefined;
}

export function computeMemoryAgentCapabilities(
  input: ComputeMemoryAgentCapabilitiesInput,
): MemoryAgentCapabilities {
  const mcpState = readDefaultMcpState(input.agentMetadata);
  const arcanaReady =
    mcpState?.entries[BRAIN_BINDING_ARCANA_ENTRY_KEY]?.setup?.state === "ready";
  const isHermes = input.adapterType === HERMES_ADAPTER_TYPE;
  const hasRuntimeMemory = Boolean(input.runtimeMemory);

  return {
    mem0: hasRuntimeMemory,
    arcana: arcanaReady,
    hermesBuiltInStores: Boolean(
      isHermes && !hasRuntimeMemory && !input.flags.hermesMemoryConfig,
    ),
  };
}

export function buildHeartbeatMemoryGuidanceContext(input: {
  agentMetadata: unknown;
  runtimeMemory: unknown;
  flags: MemoryHardeningFlags;
  adapterType: string | null | undefined;
}): MemoryAgentGuidanceContext | undefined {
  if (!input.flags.capabilityMemoryGuidance) {
    return undefined;
  }
  return {
    capabilities: computeMemoryAgentCapabilities(input),
    variant: "write-rules",
  };
}
