import { describe, expect, it, vi } from "vitest";

import {
  applyHermesRouterProviderDefault,
  assertExpectedCreateDefaults,
  forecastHermesCreateDefaults,
  needsPlatformDefaultOpenAiKey,
  projectHermesCreateDefaults,
} from "../services/hermes-create-defaults.js";

/** TECH-7895: pure create-default decisions shared by the create transaction and its forecast. */
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

  it("projects router_default, platform_openai and explicit choices without env or keys", () => {
    const before = { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s" } } };
    const routerBefore = {};
    const routerAfter = applyHermesRouterProviderDefault({ adapterType: "hermes_local", adapterConfig: routerBefore, bindsPlatformDefaultOpenAiKey: false });
    expect(projectHermesCreateDefaults({ before: routerBefore, after: routerAfter, platformDefaultOpenAiKeyBound: false })).toEqual({
      provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true,
    });
    const platform = {};
    expect(projectHermesCreateDefaults({ before: platform, after: platform, platformDefaultOpenAiKeyBound: true })).toEqual({
      provider: null, model: null, source: "platform_openai", requiresRouterReadiness: false,
    });
    const projection = projectHermesCreateDefaults({ before, after: before, platformDefaultOpenAiKeyBound: false });
    expect(projection).toEqual({ provider: null, model: null, source: "explicit_or_inferred", requiresRouterReadiness: false });
    expect(JSON.stringify(projection)).not.toContain("secret");
  });

  it("forecasts without consulting secrets when no platform binding is attempted, and counts one-shot credential names", async () => {
    const forecastPlatformSecret = vi.fn(async () => ({ wouldBind: true }));
    expect(await forecastHermesCreateDefaults({ adapterConfig: {}, extraCredentialNames: [], deploymentKeyAvailable: false, forecastPlatformSecret }))
      .toMatchObject({ source: "router_default" });
    expect(forecastPlatformSecret).not.toHaveBeenCalled();
    // A one-shot OPENAI_API_KEY means the create binds the entered key, not the platform default.
    expect(await forecastHermesCreateDefaults({ adapterConfig: {}, extraCredentialNames: ["OPENAI_API_KEY"], deploymentKeyAvailable: true, forecastPlatformSecret }))
      .toEqual({ provider: null, model: null, source: "explicit_or_inferred", requiresRouterReadiness: false });
    expect(forecastPlatformSecret).not.toHaveBeenCalled();
    expect(await forecastHermesCreateDefaults({ adapterConfig: { model: " AUTO " }, extraCredentialNames: [], deploymentKeyAvailable: true, forecastPlatformSecret }))
      .toMatchObject({ source: "platform_openai" });
    expect(forecastPlatformSecret).toHaveBeenCalledTimes(1);
  });

  it("asserts an expected projection only when one is given", () => {
    const actual = { provider: "router", model: "auto-jev-routing", source: "router_default" as const, requiresRouterReadiness: true };
    expect(() => assertExpectedCreateDefaults(undefined, actual)).not.toThrow();
    expect(() => assertExpectedCreateDefaults({ ...actual }, actual)).not.toThrow();
    expect(() => assertExpectedCreateDefaults({ provider: null, model: null, source: "platform_openai", requiresRouterReadiness: false }, actual))
      .toThrow(expect.objectContaining({ status: 409, details: expect.objectContaining({ code: "agent_create_defaults_changed" }) }));
  });
});
