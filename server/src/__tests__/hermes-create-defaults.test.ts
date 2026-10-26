import { describe, expect, it, vi } from "vitest";

import {
  PLATFORM_DEFAULT_OPENAI_SECRET,
  PLATFORM_DEFAULT_ROUTER_SECRET,
  applyHermesRouterProviderDefault,
  assertExpectedCreateDefaults,
  createDefaultsEqual,
  forecastHermesCreateDefaults,
  needsPlatformDefaultOpenAiKey,
  needsPlatformDefaultRouterKey,
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
      provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: false,
    });
    const platform = {};
    expect(projectHermesCreateDefaults({ before: platform, after: platform, platformDefaultOpenAiKeyBound: true })).toEqual({
      provider: null, model: null, source: "platform_openai", requiresRouterReadiness: false, platformRouterKeyBound: false,
    });
    const projection = projectHermesCreateDefaults({ before, after: before, platformDefaultOpenAiKeyBound: false });
    expect(projection).toEqual({ provider: null, model: null, source: "explicit_or_inferred", requiresRouterReadiness: false, platformRouterKeyBound: false });
    expect(JSON.stringify(projection)).not.toContain("secret");
  });

  it("forecasts without consulting secrets when no platform binding is attempted, and counts one-shot credential names", async () => {
    const forecastPlatformSecret = vi.fn(async () => ({ wouldBind: true }));
    expect(await forecastHermesCreateDefaults({ adapterConfig: {}, extraCredentialNames: [], deploymentKeyAvailable: false, forecastPlatformSecret }))
      .toMatchObject({ source: "router_default" });
    expect(forecastPlatformSecret).not.toHaveBeenCalled();
    // A one-shot OPENAI_API_KEY means the create binds the entered key, not the platform default.
    expect(await forecastHermesCreateDefaults({ adapterConfig: {}, extraCredentialNames: ["OPENAI_API_KEY"], deploymentKeyAvailable: true, forecastPlatformSecret }))
      .toEqual({ provider: null, model: null, source: "explicit_or_inferred", requiresRouterReadiness: false, platformRouterKeyBound: false });
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

/** TECH-7959: the platform-default Ramp Router key and its effect on the create defaults. */
describe("hermes create defaults: platform Router key (pure)", () => {
  const ref = { type: "secret_ref", secretId: "s" };

  it("names the managed secret as deployment-managed", () => {
    expect(PLATFORM_DEFAULT_ROUTER_SECRET).toMatchObject({ key: "ramp_router_api_key", name: "RAMP_ROUTER_API_KEY (platform default)" });
    expect(PLATFORM_DEFAULT_ROUTER_SECRET.description).toMatch(/deployment/i);
  });

  it.each([
    ["an untouched config", {}, true],
    ["no config at all", undefined, true],
    ["an empty env", { env: {} }, true],
    ["an auto provider and AUTO model", { provider: "auto", model: " AUTO " }, true],
    ["an explicit Router provider", { provider: "router" }, true],
    ["an explicit Router provider in another spelling", { provider: " Router " }, true],
    ["an explicit Router provider and model", { provider: "router", model: "custom" }, true],
    ["Router with another provider's key", { provider: "router", env: { ANTHROPIC_API_KEY: ref } }, true],
    ["a non-credential env entry", { env: { FOO: "bar" } }, true],
    ["a blank provider credential (not a credential)", { env: { ANTHROPIC_API_KEY: "  " } }, true],
    ["its own Router key", { provider: "router", env: { RAMP_ROUTER_API_KEY: ref } }, false],
    ["an explicit blank Router key", { env: { RAMP_ROUTER_API_KEY: "" } }, false],
    ["an explicit blank Router key with Router", { provider: "router", env: { RAMP_ROUTER_API_KEY: "" } }, false],
    ["an explicit model", { model: "claude-sonnet-5" }, false],
    ["an explicit other provider", { provider: "anthropic" }, false],
    ["a user Anthropic credential", { env: { ANTHROPIC_API_KEY: ref } }, false],
    ["a user OpenAI credential", { env: { OPENAI_API_KEY: "sk-user" } }, false],
    ["a malformed env", { env: ["x"] }, false],
  ])("attempts the platform Router key for %s: %s", (_label, adapterConfig, expected) => {
    expect(needsPlatformDefaultRouterKey("hermes_local", adapterConfig, true)).toBe(expected);
  });

  it("never attempts without a captured key or for another adapter", () => {
    expect(needsPlatformDefaultRouterKey("hermes_local", {}, false)).toBe(false);
    expect(needsPlatformDefaultRouterKey("claude_local", {}, true)).toBe(false);
    expect(needsPlatformDefaultRouterKey("hermes_gateway", { provider: "router" }, true)).toBe(false);
  });

  it("applies the Router default when the platform Router key is bound, even with the platform OpenAI key bound too", () => {
    const bothBound = { env: { RAMP_ROUTER_API_KEY: ref, OPENAI_API_KEY: ref } };
    const after = applyHermesRouterProviderDefault({
      adapterType: "hermes_local",
      adapterConfig: bothBound,
      bindsPlatformDefaultOpenAiKey: true,
      bindsPlatformDefaultRouterKey: true,
    });
    expect(after).toEqual({ ...bothBound, provider: "router", model: "auto-jev-routing" });
    expect(projectHermesCreateDefaults({
      before: bothBound,
      after,
      platformDefaultOpenAiKeyBound: true,
      platformDefaultRouterKeyBound: true,
    })).toEqual({ provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: true });
  });

  it("falls back to today's behavior when the Router secret is skipped", () => {
    const openAiOnly = { env: { OPENAI_API_KEY: ref } };
    expect(applyHermesRouterProviderDefault({
      adapterType: "hermes_local",
      adapterConfig: openAiOnly,
      bindsPlatformDefaultOpenAiKey: true,
      bindsPlatformDefaultRouterKey: false,
    })).toBe(openAiOnly);
  });

  it("never overrides an explicit model or provider, even with the Router key bound", () => {
    for (const adapterConfig of [{ model: "claude-sonnet-5" }, { provider: "anthropic" }]) {
      expect(applyHermesRouterProviderDefault({
        adapterType: "hermes_local",
        adapterConfig,
        bindsPlatformDefaultOpenAiKey: false,
        bindsPlatformDefaultRouterKey: true,
      })).toBe(adapterConfig);
    }
  });

  it("compares the flag, treating an absent flag (older client) as not bound", () => {
    const base = { provider: "router", model: "auto-jev-routing", source: "router_default" as const, requiresRouterReadiness: true };
    expect(createDefaultsEqual({ ...base, platformRouterKeyBound: false }, { ...base } as never)).toBe(true);
    expect(createDefaultsEqual({ ...base, platformRouterKeyBound: true }, { ...base, platformRouterKeyBound: false })).toBe(false);
  });

  it("forecasts in create order (Router secret, then OpenAI) with the generic secret forecast", async () => {
    const calls: string[] = [];
    const forecastPlatformSecret = vi.fn(async (secret: { key: string }) => {
      calls.push(secret.key);
      return { wouldBind: true };
    });
    const projection = await forecastHermesCreateDefaults({
      adapterConfig: {},
      extraCredentialNames: [],
      deploymentKeyAvailable: true,
      routerKeyAvailable: true,
      forecastPlatformSecret,
    });
    expect(calls).toEqual([PLATFORM_DEFAULT_ROUTER_SECRET.key, PLATFORM_DEFAULT_OPENAI_SECRET.key]);
    expect(projection).toEqual({ provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: true });
  });

  it("forecasts the OpenAI default when the Router secret would be skipped", async () => {
    const projection = await forecastHermesCreateDefaults({
      adapterConfig: {},
      extraCredentialNames: [],
      deploymentKeyAvailable: true,
      routerKeyAvailable: true,
      forecastPlatformSecret: async (secret) => ({ wouldBind: secret.key !== PLATFORM_DEFAULT_ROUTER_SECRET.key }),
    });
    expect(projection).toEqual({ provider: null, model: null, source: "platform_openai", requiresRouterReadiness: false, platformRouterKeyBound: false });
  });

  it("counts a one-shot Router key as the caller's own (no platform Router binding)", async () => {
    const forecastPlatformSecret = vi.fn(async () => ({ wouldBind: true }));
    const projection = await forecastHermesCreateDefaults({
      adapterConfig: { provider: "router" },
      extraCredentialNames: ["RAMP_ROUTER_API_KEY"],
      deploymentKeyAvailable: false,
      routerKeyAvailable: true,
      forecastPlatformSecret,
    });
    expect(projection.platformRouterKeyBound).toBe(false);
    expect(forecastPlatformSecret).not.toHaveBeenCalled();
  });

  it("forecast == create: the same inputs produce the same projection as the create-side sequence", async () => {
    const intents: Array<Record<string, unknown>> = [
      {},
      { provider: "router" },
      { provider: "router", model: "custom" },
      { model: "claude-sonnet-5" },
      { provider: "anthropic", env: { ANTHROPIC_API_KEY: ref } },
      { env: { RAMP_ROUTER_API_KEY: "" } },
      { env: { OPENAI_API_KEY: "" } },
    ];
    for (const intent of intents) {
      for (const routerBinds of [true, false]) {
        for (const openAiBinds of [true, false]) {
          const forecast = await forecastHermesCreateDefaults({
            adapterConfig: intent,
            extraCredentialNames: [],
            deploymentKeyAvailable: true,
            routerKeyAvailable: true,
            forecastPlatformSecret: async (secret) => ({
              wouldBind: secret.key === PLATFORM_DEFAULT_ROUTER_SECRET.key ? routerBinds : openAiBinds,
            }),
          });
          // The create transaction's sequence, with binds standing in for the secret step.
          const routerBound = needsPlatformDefaultRouterKey("hermes_local", intent, true) && routerBinds;
          const openAiBound = needsPlatformDefaultOpenAiKey("hermes_local", intent, true) && openAiBinds;
          let config: Record<string, unknown> = intent;
          const env = { ...((intent.env as Record<string, unknown>) ?? {}) };
          if (routerBound) env.RAMP_ROUTER_API_KEY = ref;
          if (openAiBound) env.OPENAI_API_KEY = ref;
          if (routerBound || openAiBound) config = { ...intent, env };
          const after = applyHermesRouterProviderDefault({
            adapterType: "hermes_local",
            adapterConfig: config,
            bindsPlatformDefaultOpenAiKey: openAiBound,
            bindsPlatformDefaultRouterKey: routerBound,
          });
          const created = projectHermesCreateDefaults({
            before: config,
            after,
            platformDefaultOpenAiKeyBound: openAiBound,
            platformDefaultRouterKeyBound: routerBound,
          });
          expect(forecast, JSON.stringify({ intent, routerBinds, openAiBinds })).toEqual(created);
        }
      }
    }
  });
});
