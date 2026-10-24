import { describe, expect, it } from "vitest";

import {
  applyHermesRouterProviderDefault,
  needsPlatformDefaultOpenAiKey,
} from "../services/hermes-create-defaults.js";

/** TECH-7895: pure create-default decisions applied by the agent create path. */
describe("hermes create defaults (pure)", () => {
  it("attempts the platform OpenAI key only for Hermes with a deployment key and no OPENAI_API_KEY entry", () => {
    expect(needsPlatformDefaultOpenAiKey("hermes_local", {}, true)).toBe(true);
    expect(needsPlatformDefaultOpenAiKey("hermes_local", undefined, true)).toBe(true);
    expect(needsPlatformDefaultOpenAiKey("hermes_local", { env: {} }, true)).toBe(true);
    expect(needsPlatformDefaultOpenAiKey("hermes_local", { env: { OPENAI_API_KEY: "" } }, true)).toBe(false);
    expect(needsPlatformDefaultOpenAiKey("hermes_local", {}, false)).toBe(false);
    expect(needsPlatformDefaultOpenAiKey("claude_local", {}, true)).toBe(false);
  });

  it.each([
    ["no provider or model", {}],
    ["a blank model", { model: "  " }],
    ["the legacy auto model sentinel", { model: "AUTO" }],
    ["an auto provider", { provider: "auto" }],
  ])("defaults %s to the Ramp Router provider/model", async (_label, adapterConfig) => {
    expect(applyHermesRouterProviderDefault({
      adapterType: "hermes_local",
      adapterConfig,
      bindsPlatformDefaultOpenAiKey: false,
    })).toEqual({ ...adapterConfig, provider: "router", model: "auto-jev-routing" });
  });

  it("fills only the model for an explicit Router provider and canonicalizes its spelling", () => {
    expect(applyHermesRouterProviderDefault({
      adapterType: "hermes_local",
      adapterConfig: { provider: "Router" },
      bindsPlatformDefaultOpenAiKey: false,
    })).toEqual({ provider: "router", model: "auto-jev-routing" });
    const explicit = { provider: "router", model: "custom-model" };
    expect(applyHermesRouterProviderDefault({
      adapterType: "hermes_local",
      adapterConfig: explicit,
      bindsPlatformDefaultOpenAiKey: false,
    })).toBe(explicit);
  });

  it("never overrides an explicit choice, a supplied provider credential, or a non-Hermes adapter", () => {
    const explicit = { provider: "anthropic", model: "claude-sonnet-5" };
    for (const adapterConfig of [
      explicit,
      { model: "claude-sonnet-5" },
      { env: { RAMP_ROUTER_API_KEY: { type: "secret_ref", secretId: "s" } } },
    ]) {
      expect(applyHermesRouterProviderDefault({
        adapterType: "hermes_local",
        adapterConfig,
        bindsPlatformDefaultOpenAiKey: false,
      })).toBe(adapterConfig);
    }
    const other = { model: "whatever" };
    expect(applyHermesRouterProviderDefault({
      adapterType: "claude_local",
      adapterConfig: other,
      bindsPlatformDefaultOpenAiKey: false,
    })).toBe(other);
  });

  it("does not apply the default when the platform OpenAI key is actually bound", () => {
    const adapterConfig = { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "s" } } };
    expect(applyHermesRouterProviderDefault({
      adapterType: "hermes_local",
      adapterConfig,
      bindsPlatformDefaultOpenAiKey: true,
    })).toBe(adapterConfig);
  });
});
