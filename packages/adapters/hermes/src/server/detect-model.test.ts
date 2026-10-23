import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { parseModelFromConfig, resolveEffectiveRunConfig, resolveProvider, type DetectedModel } from "./detect-model.js";
import { testEnvironment } from "./test.js";

const providerEnvKeys = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
];

const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  ...Object.fromEntries(providerEnvKeys.map((key) => [key, process.env[key]])),
};

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("parseModelFromConfig tracks api_key presence without exposing the raw secret", () => {
  const parsed = parseModelFromConfig([
    "model:",
    "  default: oca/gpt-5.4",
    "  provider: custom",
    "  base_url: https://example.invalid/litellm",
    "  api_key: super-secret-value",
    "",
  ].join("\n"));

  expect(parsed).toBeTruthy();
  expect(parsed?.hasApiKey).toBe(true);
  expect(Object.hasOwn(parsed ?? {}, "apiKey")).toBe(false);
});

test("resolveProvider does not fall through to model inference when Hermes config provider is unsupported but matches the requested model", () => {
  expect(resolveProvider({
    explicitProvider: undefined,
    detectedProvider: "custom",
    detectedModel: "oca/gpt-5.4",
    detectedBaseUrl: "https://example.invalid/litellm",
    detectedHasApiKey: true,
    model: "oca/gpt-5.4",
  })).toEqual({
    provider: "auto",
    resolvedFrom: "hermesConfigUnsupported:custom",
  });
});

test("resolveProvider also defers to Hermes runtime when the matching config omits provider but includes runtime signals", () => {
  expect(resolveProvider({
    explicitProvider: undefined,
    detectedProvider: "",
    detectedModel: "oca/gpt-5.4",
    detectedBaseUrl: "https://example.invalid/litellm",
    detectedHasApiKey: true,
    model: "oca/gpt-5.4",
  })).toEqual({
    provider: "auto",
    resolvedFrom: "hermesConfigRuntime",
  });
});

test("resolveProvider still infers from the requested model when Hermes config is for a different model", () => {
  expect(resolveProvider({
    explicitProvider: undefined,
    detectedProvider: "custom",
    detectedModel: "oca/gpt-5.4",
    detectedBaseUrl: "https://example.invalid/litellm",
    detectedHasApiKey: true,
    model: "claude-sonnet-4",
  })).toEqual({
    provider: "anthropic",
    resolvedFrom: "modelInference",
  });
});

async function withHermesHomeConfig(
  configLines: string[],
  fn: () => Promise<void>,
) {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const hermesDir = join(tempHome, ".hermes");
  const configPath = join(hermesDir, "config.yaml");

  await mkdir(hermesDir, { recursive: true });
  await writeFile(configPath, `${configLines.join("\n")}\n`, "utf8");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  for (const key of providerEnvKeys) {
    delete process.env[key];
  }

  try {
    await fn();
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

test("testEnvironment does not warn about missing API keys when Hermes config provides a supported provider api_key", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: openrouter/gpt-4.1-mini",
    "  provider: openrouter",
    "  api_key: test-secret",
  ], async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        hermesCommand: "python3",
        model: "openrouter/gpt-4.1-mini",
      },
    });

    const codes = result.checks.map((check) => check.code);

    expect(codes.includes("hermes_no_api_keys")).toBe(false);
    expect(result.status).toBe("pass");
  });
});

test("testEnvironment describes provider-omitted runtime config without inventing provider auto", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: oca/gpt-5.4",
    "  base_url: https://example.invalid/litellm",
    "  api_key: test-secret",
  ], async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        hermesCommand: "python3",
        model: "oca/gpt-5.4",
      },
    });

    const apiKeyCheck = result.checks.find((check) => check.code === "hermes_api_key_in_config");
    expect(apiKeyCheck).toBeTruthy();
    expect(apiKeyCheck?.message).toMatch(/without an explicit provider/i);
    expect(apiKeyCheck?.message).not.toMatch(/provider "auto"/i);
  });
});

test("testEnvironment does not warn about missing API keys when Hermes config provides a custom provider base_url and api_key", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: oca/gpt-5.4",
    "  provider: custom",
    "  base_url: https://example.invalid/litellm",
    "  api_key: test-secret",
  ], async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        hermesCommand: "python3",
        model: "oca/gpt-5.4",
      },
    });

    const codes = result.checks.map((check) => check.code);

    expect(codes.includes("hermes_no_api_keys")).toBe(false);
    expect(result.status).toBe("pass");
  });
});

test("detectModel() with no arguments reads config.yaml from HERMES_HOME when set", async () => {
  const { detectModel } = await import("./detect-model.js");
  const hermesHome = await mkdtemp(join(tmpdir(), "hermes-detect-home-"));
  const previous = process.env.HERMES_HOME;
  try {
    await writeFile(join(hermesHome, "config.yaml"), "model:\n  default: gpt-5.4\n  provider: copilot\n");
    process.env.HERMES_HOME = hermesHome;
    const detected = await detectModel();
    expect(detected?.model).toBe("gpt-5.4");
    expect(detected?.provider).toBe("copilot");
  } finally {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
    await rm(hermesHome, { recursive: true, force: true });
  }
});

test("resolveProvider honours an explicit openai-api provider (Hermes's direct OpenAI Platform provider)", () => {
  // TECH-7348: before openai-api was in VALID_PROVIDERS an explicit choice was silently dropped and a
  // gpt-* model fell through to prefix inference, which never yields openai-api.
  expect(resolveProvider({ explicitProvider: "openai-api", model: "gpt-5.5-mini" })).toEqual({
    provider: "openai-api",
    resolvedFrom: "adapterConfig",
  });
  expect(resolveProvider({ explicitProvider: "openai-api" })).toEqual({
    provider: "openai-api",
    resolvedFrom: "adapterConfig",
  });
});

test("resolveProvider honours an explicit router provider and never infers it from a model name", () => {
  // TECH-7895: Ramp Router model IDs look like vendor IDs, so an explicit provider pick must win
  // and no model-name prefix may ever resolve to "router".
  expect(resolveProvider({ explicitProvider: "router", model: "claude-sonnet-5" })).toEqual({
    provider: "router",
    resolvedFrom: "adapterConfig",
  });
  expect(resolveProvider({ explicitProvider: "router" })).toEqual({
    provider: "router",
    resolvedFrom: "adapterConfig",
  });
  expect(resolveProvider({ model: "auto-jev-routing" }).provider).not.toBe("router");
  expect(resolveProvider({ model: "claude-sonnet-5" }).provider).toBe("anthropic");
});


// ---------------------------------------------------------------------------
// TECH-7895: effective run config (provider + source + -m together)
// ---------------------------------------------------------------------------

const hostRouter: DetectedModel = {
  model: "auto-jev-routing",
  provider: "router",
  baseUrl: "",
  hasApiKey: false,
  apiMode: "",
  source: "config",
};
const hostAnthropic: DetectedModel = { ...hostRouter, model: "claude-sonnet-5", provider: "anthropic" };

test("resolveEffectiveRunConfig gates a Router host default the run would otherwise use silently", () => {
  for (const [explicitProvider, configuredModel] of [
    [undefined, undefined],
    ["auto", undefined],
    [undefined, "auto"],
    [undefined, "auto-jev-routing"],
    ["auto", "AUTO-JEV-ROUTING"],
  ] as const) {
    const result = resolveEffectiveRunConfig({ explicitProvider, configuredModel, detected: hostRouter });
    expect(result, `${explicitProvider}/${configuredModel}`).toMatchObject({
      ok: true,
      provider: "router",
      isRouter: true,
      effectiveModel: configuredModel && configuredModel !== "auto" ? configuredModel : "auto-jev-routing",
    });
    // A fresh Router profile has no host model: the model is always passed explicitly.
    expect(result.ok && result.modelArg).toBeTruthy();
  }
  expect(resolveEffectiveRunConfig({ explicitProvider: undefined, configuredModel: undefined, detected: hostRouter })).toMatchObject({
    resolvedFrom: "hermesConfigDefault",
    modelArg: "auto-jev-routing",
  });
});

test("resolveEffectiveRunConfig keeps an explicit concrete provider and a different manual model on legacy resolution", () => {
  expect(resolveEffectiveRunConfig({ explicitProvider: "anthropic", configuredModel: undefined, detected: hostRouter })).toEqual({
    ok: true,
    provider: "anthropic",
    resolvedFrom: "adapterConfig",
    isRouter: false,
    modelArg: undefined,
    effectiveModel: "auto-jev-routing",
  });
  expect(resolveEffectiveRunConfig({ explicitProvider: undefined, configuredModel: "claude-sonnet-5", detected: hostRouter })).toMatchObject({
    ok: true,
    provider: "anthropic",
    resolvedFrom: "modelInference",
    isRouter: false,
    modelArg: "claude-sonnet-5",
  });
  // An explicit auto with a different manual model stays "auto", exactly as before.
  expect(resolveEffectiveRunConfig({ explicitProvider: "auto", configuredModel: "claude-sonnet-5", detected: hostRouter })).toMatchObject({
    provider: "auto",
    isRouter: false,
  });
});

test("resolveEffectiveRunConfig leaves non-Router host defaults and hosted runs unchanged", () => {
  for (const [explicitProvider, configuredModel] of [
    [undefined, undefined],
    ["auto", undefined],
    [undefined, "claude-sonnet-5"],
    ["anthropic", undefined],
  ] as const) {
    const legacy = resolveProvider({
      explicitProvider,
      detectedProvider: hostAnthropic.provider,
      detectedModel: hostAnthropic.model,
      model: configuredModel,
    });
    const result = resolveEffectiveRunConfig({ explicitProvider, configuredModel, detected: hostAnthropic });
    expect(result).toMatchObject({ ok: true, provider: legacy.provider, resolvedFrom: legacy.resolvedFrom, isRouter: false });
    expect(result.ok && result.modelArg).toBe(configuredModel);
  }
  // Hosted: the caller passes no detection, so a host Router default can never be discovered.
  expect(resolveEffectiveRunConfig({ explicitProvider: undefined, configuredModel: undefined, detected: null })).toEqual({
    ok: true,
    provider: "auto",
    resolvedFrom: "auto",
    isRouter: false,
    modelArg: undefined,
    effectiveModel: undefined,
  });
});

test("resolveEffectiveRunConfig never infers Router from a model name and pins only Router defaults", () => {
  expect(resolveEffectiveRunConfig({ explicitProvider: undefined, configuredModel: "auto-jev-routing", detected: null })).toMatchObject({
    isRouter: false,
  });
  // Explicit Router with no model pins the Hermes default it would have used (fresh profile).
  expect(resolveEffectiveRunConfig({ explicitProvider: "router", configuredModel: undefined, detected: hostAnthropic })).toMatchObject({
    ok: true,
    provider: "router",
    modelArg: "claude-sonnet-5",
  });
  // ...and fails clearly when there is no default at all (hosted, or no host model).
  expect(resolveEffectiveRunConfig({ explicitProvider: "router", configuredModel: undefined, detected: null })).toMatchObject({
    ok: false,
    isRouter: true,
  });
});
