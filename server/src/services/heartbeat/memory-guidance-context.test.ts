import { describe, expect, it } from "vitest";
import {
  computeMemoryAgentCapabilities,
  buildHeartbeatMemoryGuidanceContext,
  resolveHeartbeatEffectiveEnv,
  resolveHeartbeatMemoryHardeningFlags,
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
    });
    expect(withoutMemory.mem0).toBe(false);

    const withMemory = computeMemoryAgentCapabilities({
      agentMetadata: {},
      runtimeMemory: { provider: "mem0" },
      flags: { hermesMemoryConfig: false },
    });
    expect(withMemory.mem0).toBe(true);
  });

  it("computes arcana true only when setup.state === 'ready'", () => {
    const readyCaps = computeMemoryAgentCapabilities({
      agentMetadata: makeMetadataWithArcanaState("ready"),
      runtimeMemory: null,
      flags: { hermesMemoryConfig: false },
    });
    expect(readyCaps.arcana).toBe(true);

    const states = ["configured", "failed", "pending", "unknown", null];
    for (const state of states) {
      const caps = computeMemoryAgentCapabilities({
        agentMetadata: makeMetadataWithArcanaState(state),
        runtimeMemory: null,
        flags: { hermesMemoryConfig: false },
      });
      expect(caps.arcana).toBe(false);
    }

    // Handles null / undefined / non-object metadata safely
    expect(
      computeMemoryAgentCapabilities({
        agentMetadata: null,
        runtimeMemory: null,
        flags: { hermesMemoryConfig: false },
      }).arcana,
    ).toBe(false);
  });

  it("computes hermesBuiltInStores inverted from flags.hermesMemoryConfig", () => {
    const withConfig = computeMemoryAgentCapabilities({
      agentMetadata: {},
      runtimeMemory: null,
      flags: { hermesMemoryConfig: true },
    });
    expect(withConfig.hermesBuiltInStores).toBe(false);

    const withoutConfig = computeMemoryAgentCapabilities({
      agentMetadata: {},
      runtimeMemory: null,
      flags: { hermesMemoryConfig: false },
    });
    expect(withoutConfig.hermesBuiltInStores).toBe(true);
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
});

describe("effective environment resolution and guidance regression", () => {
  it("enables capability-memory-guidance from config.env with empty processEnv", () => {
    const flags = resolveHeartbeatMemoryHardeningFlags({
      processEnv: {},
      runtimeConfig: { env: { PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" } },
    });
    expect(flags.capabilityMemoryGuidance).toBe(true);
    expect(flags.hermesMemoryConfig).toBe(false);

    const guidanceCtx = buildHeartbeatMemoryGuidanceContext({
      agentMetadata: {},
      runtimeMemory: null,
      flags,
    });
    expect(guidanceCtx).toBeDefined();
    expect(guidanceCtx?.capabilities.hermesBuiltInStores).toBe(true);
    const guidance = buildMemoryAgentGuidance(guidanceCtx!);
    expect(guidance).toContain("Hermes built-in stores handle session continuity.");
  });

  it("does not allow config.env to disable capability-memory-guidance when processEnv has it enabled (additive OR)", () => {
    const flags = resolveHeartbeatMemoryHardeningFlags({
      processEnv: { PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" },
      runtimeConfig: { env: { PAPERCLIP_MEMORY_HARDENING: "" } },
    });
    expect(flags.capabilityMemoryGuidance).toBe(true);

    const guidanceCtx = buildHeartbeatMemoryGuidanceContext({
      agentMetadata: {},
      runtimeMemory: null,
      flags,
    });
    expect(guidanceCtx).toBeDefined();
  });

  it("falls back to processEnv when config.env does not specify PAPERCLIP_MEMORY_HARDENING", () => {
    const flags = resolveHeartbeatMemoryHardeningFlags({
      processEnv: { PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance" },
      runtimeConfig: { env: { OTHER_VAR: "value" } },
    });
    expect(flags.capabilityMemoryGuidance).toBe(true);
  });

  it("hermes-memory-config in config.env turns off built-in store guidance", () => {
    const flags = resolveHeartbeatMemoryHardeningFlags({
      processEnv: {},
      runtimeConfig: {
        env: {
          PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance,hermes-memory-config",
        },
      },
    });
    expect(flags.capabilityMemoryGuidance).toBe(true);
    expect(flags.hermesMemoryConfig).toBe(true);

    const guidanceCtx = buildHeartbeatMemoryGuidanceContext({
      agentMetadata: {},
      runtimeMemory: null,
      flags,
    });
    expect(guidanceCtx).toBeDefined();
    expect(guidanceCtx?.capabilities.hermesBuiltInStores).toBe(false);
    const guidance = buildMemoryAgentGuidance(guidanceCtx!);
    expect(guidance).not.toContain("Hermes built-in stores");
  });

  it("resolves from agent.adapterConfig.env fallback when runtimeConfig has no env", () => {
    const flags = resolveHeartbeatMemoryHardeningFlags({
      processEnv: {},
      runtimeConfig: {},
      agentAdapterConfig: {
        env: {
          PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance",
        },
      },
    });
    expect(flags.capabilityMemoryGuidance).toBe(true);
  });

  it("resolves flags additively with logical OR between processEnv and adapter config.env", () => {
    const flags = resolveHeartbeatMemoryHardeningFlags({
      processEnv: { PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config" },
      runtimeConfig: { env: { PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0,capability-memory-guidance" } },
    });
    // Verifies additive semantics: server flags and adapter flags are merged via logical OR
    expect(flags.hermesMemoryConfig).toBe(true);
    expect(flags.agentScopedMem0).toBe(true);
    expect(flags.capabilityMemoryGuidance).toBe(true);
  });
});
