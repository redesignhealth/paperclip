import { describe, expect, it } from "vitest";
import {
  computeMemoryAgentCapabilities,
  buildHeartbeatMemoryGuidanceContext,
} from "./memory-guidance-context.js";
import { buildMemoryAgentGuidance } from "@paperclipai/adapter-utils/server-utils";
import { BRAIN_BINDING_ARCANA_ENTRY_KEY } from "../arcana-brain-binding.js";
import { DEFAULT_MCP_METADATA_KEY } from "../default-mcp-spec.js";

function makeMetadataWithArcanaState(state: string | null) {
  if (state === null) {
    return {};
  }
  return {
    [DEFAULT_MCP_METADATA_KEY]: {
      version: 1,
      entries: {
        [BRAIN_BINDING_ARCANA_ENTRY_KEY]: {
          setup: {
            state,
          },
        },
      },
    },
  };
}

describe("computeMemoryAgentCapabilities", () => {
  it("computes mem0 from runtimeMemory presence", () => {
    const withoutMemory = computeMemoryAgentCapabilities({
      agentMetadata: {},
      runtimeMemory: null,
      flags: { hermesMemoryConfig: false },
      adapterType: "hermes_local",
    });
    expect(withoutMemory.mem0).toBe(false);

    const withMemory = computeMemoryAgentCapabilities({
      agentMetadata: {},
      runtimeMemory: { provider: "mem0" },
      flags: { hermesMemoryConfig: false },
      adapterType: "hermes_local",
    });
    expect(withMemory.mem0).toBe(true);
  });

  it("computes arcana true only when setup.state === 'ready'", () => {
    const readyCaps = computeMemoryAgentCapabilities({
      agentMetadata: makeMetadataWithArcanaState("ready"),
      runtimeMemory: null,
      flags: { hermesMemoryConfig: false },
      adapterType: "hermes_local",
    });
    expect(readyCaps.arcana).toBe(true);

    const states = ["configured", "failed", "pending", "unknown", null];
    for (const state of states) {
      const caps = computeMemoryAgentCapabilities({
        agentMetadata: makeMetadataWithArcanaState(state),
        runtimeMemory: null,
        flags: { hermesMemoryConfig: false },
        adapterType: "hermes_local",
      });
      expect(caps.arcana).toBe(false);
    }

    // Handles null / undefined / non-object metadata safely
    expect(
      computeMemoryAgentCapabilities({
        agentMetadata: null,
        runtimeMemory: null,
        flags: { hermesMemoryConfig: false },
        adapterType: undefined,
      }).arcana,
    ).toBe(false);
  });

  it("computes hermesBuiltInStores based on adapter, runtimeMemory, and flags.hermesMemoryConfig", () => {
    // mem0 present + hermes-memory-config off => false (isolated home wipes stores)
    const mem0WithConfigOff = computeMemoryAgentCapabilities({
      agentMetadata: {},
      runtimeMemory: { provider: "mem0" },
      flags: { hermesMemoryConfig: false },
      adapterType: "hermes_local",
    });
    expect(mem0WithConfigOff.hermesBuiltInStores).toBe(false);

    // no mem0 + no flag => true
    const noMem0NoFlag = computeMemoryAgentCapabilities({
      agentMetadata: {},
      runtimeMemory: null,
      flags: { hermesMemoryConfig: false },
      adapterType: "hermes_local",
    });
    expect(noMem0NoFlag.hermesBuiltInStores).toBe(true);

    // flag on => false
    const flagOnNoMem0 = computeMemoryAgentCapabilities({
      agentMetadata: {},
      runtimeMemory: null,
      flags: { hermesMemoryConfig: true },
      adapterType: "hermes_local",
    });
    expect(flagOnNoMem0.hermesBuiltInStores).toBe(false);

    const flagOnWithMem0 = computeMemoryAgentCapabilities({
      agentMetadata: {},
      runtimeMemory: { provider: "mem0" },
      flags: { hermesMemoryConfig: true },
      adapterType: "hermes_local",
    });
    expect(flagOnWithMem0.hermesBuiltInStores).toBe(false);
  });

  it("gates hermesBuiltInStores false for non-Hermes adapters regardless of flags", () => {
    for (const adapterType of ["claude_local", "codex_local", "process", undefined, null]) {
      const caps = computeMemoryAgentCapabilities({
        agentMetadata: {},
        runtimeMemory: null,
        flags: { hermesMemoryConfig: false },
        adapterType,
      });
      expect(caps.hermesBuiltInStores).toBe(false);
    }
  });
});

describe("buildHeartbeatMemoryGuidanceContext", () => {
  it("returns undefined when capabilityMemoryGuidance flag is false", () => {
    const result = buildHeartbeatMemoryGuidanceContext({
      agentMetadata: makeMetadataWithArcanaState("ready"),
      runtimeMemory: { provider: "mem0" },
      flags: {
        hermesMemoryConfig: false,
        hermesPromptSplit: false,
        agentScopedMem0: false,
        capabilityMemoryGuidance: false,
      },
      adapterType: "hermes_local",
    });
    expect(result).toBeUndefined();
  });

  it("returns write-rules context when capabilityMemoryGuidance flag is true", () => {
    const result = buildHeartbeatMemoryGuidanceContext({
      agentMetadata: makeMetadataWithArcanaState("ready"),
      runtimeMemory: { provider: "mem0" },
      flags: {
        hermesMemoryConfig: true,
        hermesPromptSplit: false,
        agentScopedMem0: false,
        capabilityMemoryGuidance: true,
      },
      adapterType: "hermes_local",
    });
    expect(result).toEqual({
      capabilities: {
        mem0: true,
        arcana: true,
        hermesBuiltInStores: false,
      },
      variant: "write-rules",
    });
  });

  it("correctly enables hermesBuiltInStores for Hermes without hermesMemoryConfig", () => {
    const result = buildHeartbeatMemoryGuidanceContext({
      agentMetadata: {},
      runtimeMemory: null,
      flags: {
        hermesMemoryConfig: false,
        hermesPromptSplit: false,
        agentScopedMem0: false,
        capabilityMemoryGuidance: true,
      },
      adapterType: "hermes_local",
    });
    expect(result).toEqual({
      capabilities: {
        mem0: false,
        arcana: false,
        hermesBuiltInStores: true,
      },
      variant: "write-rules",
    });
    const guidance = buildMemoryAgentGuidance(result!);
    expect(guidance).toContain(
      "Hermes built-in stores are scratch/local session context, not a durable store; save durable facts only to available Mem0/Arcana and progress to issue comments.",
    );
    expect(guidance).not.toContain("handle session continuity");
  });

  it("keeps hermesBuiltInStores false for Hermes when runtimeMemory is present even without hermesMemoryConfig", () => {
    const result = buildHeartbeatMemoryGuidanceContext({
      agentMetadata: {},
      runtimeMemory: { provider: "mem0" },
      flags: {
        hermesMemoryConfig: false,
        hermesPromptSplit: false,
        agentScopedMem0: false,
        capabilityMemoryGuidance: true,
      },
      adapterType: "hermes_local",
    });
    expect(result).toEqual({
      capabilities: {
        mem0: true,
        arcana: false,
        hermesBuiltInStores: false,
      },
      variant: "write-rules",
    });
    const guidance = buildMemoryAgentGuidance(result!);
    expect(guidance).not.toContain("Hermes built-in stores");
  });

  it("gates hermesBuiltInStores to false for non-Hermes adapters in guidance context", () => {
    const result = buildHeartbeatMemoryGuidanceContext({
      agentMetadata: {},
      runtimeMemory: null,
      flags: {
        hermesMemoryConfig: false,
        hermesPromptSplit: false,
        agentScopedMem0: false,
        capabilityMemoryGuidance: true,
      },
      adapterType: "claude_local",
    });
    expect(result).toEqual({
      capabilities: {
        mem0: false,
        arcana: false,
        hermesBuiltInStores: false,
      },
      variant: "write-rules",
    });
    const guidance = buildMemoryAgentGuidance(result!);
    expect(guidance).not.toContain("Hermes built-in stores");
  });
});
