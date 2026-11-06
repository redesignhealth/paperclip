import { describe, expect, it } from "vitest";
import {
  resolveMemoryHardeningFlags,
  MemoryHardeningConfigurationError,
} from "./memory-hardening.js";

describe("resolveMemoryHardeningFlags", () => {
  it("defaults to all flags false when env is unset or undefined", () => {
    expect(resolveMemoryHardeningFlags({})).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });
  });

  it("returns all flags false when PAPERCLIP_MEMORY_HARDENING is empty or only whitespace", () => {
    expect(
      resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "" }),
    ).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });

    expect(
      resolveMemoryHardeningFlags({ PAPERCLIP_MEMORY_HARDENING: "   \t\n  " }),
    ).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });
  });

  it("parses individual tokens correctly", () => {
    expect(
      resolveMemoryHardeningFlags({
        PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config",
      }),
    ).toEqual({
      hermesMemoryConfig: true,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });

    expect(
      resolveMemoryHardeningFlags({
        PAPERCLIP_MEMORY_HARDENING: "hermes-prompt-split",
      }),
    ).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: true,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });

    expect(
      resolveMemoryHardeningFlags({
        PAPERCLIP_MEMORY_HARDENING: "agent-scoped-mem0",
      }),
    ).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: true,
      capabilityMemoryGuidance: false,
    });

    expect(
      resolveMemoryHardeningFlags({
        PAPERCLIP_MEMORY_HARDENING: "capability-memory-guidance",
      }),
    ).toEqual({
      hermesMemoryConfig: false,
      hermesPromptSplit: false,
      agentScopedMem0: false,
      capabilityMemoryGuidance: true,
    });
  });

  it("enables all flags when token 'all' is provided", () => {
    expect(
      resolveMemoryHardeningFlags({
        PAPERCLIP_MEMORY_HARDENING: "all",
      }),
    ).toEqual({
      hermesMemoryConfig: true,
      hermesPromptSplit: true,
      agentScopedMem0: true,
      capabilityMemoryGuidance: true,
    });
  });

  it("parses multiple tokens and trims whitespace and ignores empty segments", () => {
    const flags = resolveMemoryHardeningFlags({
      PAPERCLIP_MEMORY_HARDENING: " hermes-memory-config , , agent-scoped-mem0 , ",
    });
    expect(flags).toEqual({
      hermesMemoryConfig: true,
      hermesPromptSplit: false,
      agentScopedMem0: true,
      capabilityMemoryGuidance: false,
    });
  });

  it("handles duplicate tokens without error", () => {
    const flags = resolveMemoryHardeningFlags({
      PAPERCLIP_MEMORY_HARDENING:
        "hermes-memory-config,hermes-memory-config,hermes-prompt-split",
    });
    expect(flags).toEqual({
      hermesMemoryConfig: true,
      hermesPromptSplit: true,
      agentScopedMem0: false,
      capabilityMemoryGuidance: false,
    });
  });

  it("throws MemoryHardeningConfigurationError naming unknown tokens", () => {
    expect(() =>
      resolveMemoryHardeningFlags({
        PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config,invalid-token",
      }),
    ).toThrow(MemoryHardeningConfigurationError);

    expect(() =>
      resolveMemoryHardeningFlags({
        PAPERCLIP_MEMORY_HARDENING: "hermes-memory-config,invalid-token",
      }),
    ).toThrow(/invalid-token/);
  });
});
