import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";

import { parseModelFromConfig, resolveEffectiveRunConfig, resolveProvider, type DetectedModel } from "./detect-model.js";
import { testEnvironment } from "./test.js";

const providerEnvKeys = [
  "ANTHROPIC_API_KEY",
  "RAMP_ROUTER_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
];

const isolationEnvKeys = ["PAPERCLIP_HERMES_HOST_ISOLATION", "PAPERCLIP_DEPLOYMENT_MODE", "PAPERCLIP_HERMES_COMMAND_SCAN"] as const;

const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  ...Object.fromEntries(providerEnvKeys.map((key) => [key, process.env[key]])),
};

const previousIsolationEnv = Object.fromEntries(
  isolationEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof isolationEnvKeys)[number], string | undefined>;

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const key of isolationEnvKeys) {
    const value = previousIsolationEnv[key];
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
  // An explicit auto skips prefix inference, so even a mappable different model still defers — and
  // would inherit the host's router provider, so it is a Router run with the agent's model.
  expect(resolveEffectiveRunConfig({ explicitProvider: "auto", configuredModel: "claude-sonnet-5", detected: hostRouter })).toMatchObject({
    provider: "router",
    resolvedFrom: "hermesConfigProvider",
    isRouter: true,
    modelArg: "claude-sonnet-5",
  });
});

test("resolveEffectiveRunConfig classifies every deferring run that would inherit a host Router provider as Router", () => {
  // Legacy resolution ends at "auto" (no `--provider`), so Hermes uses the host's `router` provider
  // regardless of `-m`: classify as Router and keep the agent's manual model.
  for (const [explicitProvider, configuredModel] of [
    [undefined, "unmapped-model-7895"],
    ["auto", "unmapped-model-7895"],
    ["auto", "claude-sonnet-5"],
    ["auto", "auto-jev-routing-v2"],
  ] as const) {
    expect(resolveEffectiveRunConfig({ explicitProvider, configuredModel, detected: hostRouter }), `${explicitProvider}/${configuredModel}`)
      .toEqual({
        ok: true,
        provider: "router",
        resolvedFrom: "hermesConfigProvider",
        isRouter: true,
        modelArg: configuredModel,
        effectiveModel: configuredModel,
      });
  }
  // A concrete provider — explicit or prefix-inferred — is never overridden by a Router host.
  for (const [explicitProvider, configuredModel, provider, resolvedFrom] of [
    [undefined, "claude-sonnet-5", "anthropic", "modelInference"],
    ["anthropic", "unmapped-model-7895", "anthropic", "adapterConfig"],
    ["openrouter", "unmapped-model-7895", "openrouter", "adapterConfig"],
  ] as const) {
    expect(resolveEffectiveRunConfig({ explicitProvider, configuredModel, detected: hostRouter }), `${explicitProvider}/${configuredModel}`)
      .toMatchObject({ ok: true, provider, resolvedFrom, isRouter: false, modelArg: configuredModel });
  }
  // A non-Router host, or no host detection at all (hosted/isolated), never yields Router.
  for (const detected of [hostAnthropic, { ...hostRouter, provider: "custom" }, null]) {
    for (const explicitProvider of [undefined, "auto"] as const) {
      const result = resolveEffectiveRunConfig({ explicitProvider, configuredModel: "unmapped-model-7895", detected });
      expect(result, `${detected?.provider ?? "isolated"}/${explicitProvider}`).toMatchObject({ isRouter: false });
      expect(result.provider).not.toBe("router");
    }
  }
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
  // Explicit Router with no model pins only a genuinely Router host default...
  expect(resolveEffectiveRunConfig({ explicitProvider: "router", configuredModel: undefined, detected: hostRouter })).toMatchObject({
    ok: true,
    provider: "router",
    modelArg: "auto-jev-routing",
  });
  // ...never an unrelated provider's default, and fails as a missing model with none at all.
  for (const detected of [hostAnthropic, null]) {
    expect(resolveEffectiveRunConfig({ explicitProvider: "router", configuredModel: undefined, detected })).toMatchObject({
      ok: false,
      provider: "router",
      isRouter: true,
      message: expect.stringMatching(/no model is configured/),
    });
  }
  expect(resolveEffectiveRunConfig({ explicitProvider: "router", configuredModel: "auto-jev-routing", detected: hostAnthropic })).toMatchObject({
    ok: true,
    modelArg: "auto-jev-routing",
  });
});

async function withFakeHermes(router: boolean, fn: (command: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "hermes-router-fake-install-"));
  const { createFakeHermesInstall } = await import("./test-support/fake-hermes-install.js");
  const install = await createFakeHermesInstall(root, router ? {} : { profile: null, auth: null });
  try {
    await fn(install.command);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ROUTER_INSTALL = true;
const PRE_ROUTER_INSTALL = false;

test("testEnvironment passes a Router config with the canonical key on a Hermes that supports router", async () => {
  await withHermesHomeConfig([], async () => {
    await withFakeHermes(ROUTER_INSTALL, async (command) => {
      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: { hermesCommand: command, provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "router-test-key" } },
      });
      const codes = result.checks.map((check) => check.code);
      expect(codes).toContain("hermes_router_key_found");
      expect(codes).toContain("hermes_router_supported");
      expect(codes).not.toContain("hermes_no_api_keys");
      expect(result.checks.filter((check) => check.level === "error")).toEqual([]);
    });
  });
});

test.each(["cwd", "relative cwd", "workspaceDir", "empty cwd", "non-string cwd"])(
  "testEnvironment resolves ./.venv/bin/hermes from the execution %s, including preliminary CLI checks",
  async (source) => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "off";
    await withHermesHomeConfig([], async () => {
      const root = await mkdtemp(join(tmpdir(), "hermes-router-relative-readiness-"));
      try {
        const { createFakeHermesInstall } = await import("./test-support/fake-hermes-install.js");
        // Trailing whitespace is significant in execute.ts; readiness must not trim the cwd.
        const workspace = join(await realpath(root), "workspace ");
        const install = await createFakeHermesInstall(join(workspace, ".venv"));
        const versionCalls = join(root, "version-calls.jsonl");
        await writeFile(join(install.srcRoot, "hermes_cli", "main.py"), [
          "import os, json",
          "def main():",
          `    with open(${JSON.stringify(versionCalls)}, 'a') as f: f.write(json.dumps(os.getcwd()) + '\\n')`,
          "    print('workspace-hermes 0.19.0')",
          "    return 0",
          "",
        ].join("\n"));
        const workingDirConfig = source === "cwd"
          ? { cwd: workspace, workspaceDir: join(root, "wrong-workspace") }
          : source === "relative cwd"
            ? { cwd: relative(process.cwd(), workspace), workspaceDir: join(root, "wrong-workspace") }
            : { workspaceDir: workspace, ...(source === "empty cwd" ? { cwd: "" } : source === "non-string cwd" ? { cwd: 123 } : {}) };
        const result = await testEnvironment({
          companyId: "company-test",
          adapterType: "hermes_local",
          config: {
            ...workingDirConfig,
            hermesCommand: "./.venv/bin/hermes",
            provider: "router",
            model: "auto-jev-routing",
            env: { RAMP_ROUTER_API_KEY: "router-test-key" },
          },
        });
        expect(result.checks.filter((check) => check.level === "error")).toEqual([]);
        expect(result.checks.map((check) => check.code)).toContain("hermes_router_supported");
        expect(result.checks.find((check) => check.code === "hermes_version")?.message).toContain("workspace-hermes 0.19.0");
        // Both --version invocations must run in the workspace, not only the registry resolver.
        expect((await readFile(versionCalls, "utf8")).trim().split("\n").map((line) => JSON.parse(line)))
          .toEqual([workspace, workspace]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

test("testEnvironment fails a Router config whose only key belongs to another provider", async () => {
  await withHermesHomeConfig([], async () => {
    await withFakeHermes(ROUTER_INSTALL, async (command) => {
      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: { hermesCommand: command, provider: "router", model: "auto-jev-routing", env: { OPENAI_API_KEY: "sk-openai-test" } },
      });
      expect(result.status).toBe("fail");
      expect(result.checks.map((check) => check.code)).toContain("hermes_router_key_missing");
      // The generic "API keys found" acceptance must not vouch for a Router config.
      expect(result.checks.map((check) => check.code)).not.toContain("hermes_api_keys_found");
    });
  });
});

test("testEnvironment fails a Router config on a Hermes without native Router support", async () => {
  await withHermesHomeConfig([], async () => {
    await withFakeHermes(PRE_ROUTER_INSTALL, async (command) => {
      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: { hermesCommand: command, provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "router-test-key" } },
      });
      expect(result.status).toBe("fail");
      const check = result.checks.find((entry) => entry.code === "hermes_router_unsupported");
      expect(check?.level).toBe("error");
      expect(check?.message).toMatch(/does not provide the native Ramp Router provider/);
    });
  });
});

test("testEnvironment rejects a Router config for a remote execution target without probing the host", async () => {
  await withHermesHomeConfig([], async () => {
    await withFakeHermes(ROUTER_INSTALL, async (command) => {
      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: { hermesCommand: command, provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "router-test-key" } },
        executionTarget: { kind: "remote" } as never,
      });
      expect(result.status).toBe("fail");
      const codes = result.checks.map((check) => check.code);
      expect(codes).toContain("hermes_router_remote_unsupported");
      expect(codes).not.toContain("hermes_router_supported");
    });
  });
});

test("testEnvironment uses the same Router key precedence as a run: an explicit blank agent key never uses the host key", async () => {
  await withHermesHomeConfig([], async () => {
    await writeFile(join(process.env.HOME!, ".hermes", ".env"), "RAMP_ROUTER_API_KEY=host-test-key\n");
    await withFakeHermes(ROUTER_INSTALL, async (command) => {
      const blank = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: { hermesCommand: command, provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "  " } },
      });
      expect(blank.checks.map((check) => check.code)).toContain("hermes_router_key_missing");
      const hostOnly = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: { hermesCommand: command, provider: "router", model: "auto-jev-routing" },
      });
      expect(hostOnly.checks.map((check) => check.code)).toContain("hermes_router_key_found");
    });
  });
});

test("testEnvironment explains that host endpoint overrides are not used by the fresh Router profile, and rejects extraArgs", async () => {
  await withHermesHomeConfig([], async () => {
    await withFakeHermes(ROUTER_INSTALL, async (command) => {
      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: {
          hermesCommand: command,
          provider: "router",
          model: "auto-jev-routing",
          extraArgs: ["--profile", "work"],
          env: { RAMP_ROUTER_API_KEY: "router-test-key", RAMP_ROUTER_BASE_URL: "https://proxy.example/v1" },
        },
      });
      const override = result.checks.find((check) => check.code === "hermes_router_endpoint_override_ignored");
      expect(override?.message).toMatch(/RAMP_ROUTER_BASE_URL/);
      expect(override?.message).toMatch(/fresh per-run Hermes profile/);
      expect(override?.message).toMatch(/auth\/credential pools/);
      expect(result.checks.map((check) => check.code)).toContain("hermes_router_extra_args");
      expect(result.status).toBe("fail");
    });
  });
});

test("testEnvironment probes through the agent's PATH, the same launcher resolution a run uses", async () => {
  await withHermesHomeConfig([], async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-router-path-"));
    try {
      const { createFakeHermesInstall } = await import("./test-support/fake-hermes-install.js");
      const install = await createFakeHermesInstall(join(root, "router"));
      const old = await createFakeHermesInstall(join(root, "old"), { profile: null, auth: null });
      const serverPath = process.env.PATH;
      // The server's PATH finds a pre-Router Hermes; the agent's PATH (what a run launches) finds the
      // Router-capable one. The probe must follow the agent's PATH.
      process.env.PATH = `${old.binDir}:${serverPath ?? ""}`;
      try {
        const run = (agentPath: string) =>
          testEnvironment({
            companyId: "company-test",
            adapterType: "hermes_local",
            config: {
              hermesCommand: "hermes",
              provider: "router",
              model: "auto-jev-routing",
              env: { RAMP_ROUTER_API_KEY: "router-test-key", PATH: agentPath },
            },
          });
        expect((await run(`${install.binDir}:/usr/bin:/bin`)).checks.map((check) => check.code)).toContain(
          "hermes_router_supported",
        );
        expect((await run(`${old.binDir}:/usr/bin:/bin`)).checks.map((check) => check.code)).toContain(
          "hermes_router_unsupported",
        );
      } finally {
        process.env.PATH = serverPath;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TECH-7895: environment test ↔ run parity
// ---------------------------------------------------------------------------

test("testEnvironment ignores host-detected config for Router detection when host isolation is on", async () => {
  process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "true";
  // The host Hermes config selects Router for this model, but an isolated run never reads it, so the
  // environment test must not treat this as a Router config (execute.ts mirrors the same gate).
  await withHermesHomeConfig([
    "model:",
    "  default: auto-jev-routing",
    "  provider: router",
  ], async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        hermesCommand: "python3",
        model: "auto-jev-routing",
        env: { ANTHROPIC_API_KEY: "sk-ant-test-7895" },
      },
    });
    const codes = result.checks.map((check) => check.code);
    expect(codes).not.toContain("hermes_router_key_missing");
    expect(codes).not.toContain("hermes_router_supported");
    expect(codes).toContain("hermes_api_keys_found");
  });
});

test("testEnvironment still checks Router readiness for an explicit Router config under host isolation", async () => {
  process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "true";
  await withHermesHomeConfig([], async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-router-isolated-"));
    try {
      const { createFakeHermesInstall } = await import("./test-support/fake-hermes-install.js");
      const install = await createFakeHermesInstall(join(root, "router"));
      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: {
          hermesCommand: install.command,
          provider: "router",
          model: "auto-jev-routing",
          env: { RAMP_ROUTER_API_KEY: "router-test-key-7895" },
        },
      });
      const codes = result.checks.map((check) => check.code);
      expect(codes).toContain("hermes_router_key_found");
      expect(codes).toContain("hermes_router_supported");
      expect(codes).not.toContain("hermes_no_api_keys");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("testEnvironment warns about no API keys when the only key is RAMP_ROUTER_API_KEY on a non-Router config", async () => {
  await withHermesHomeConfig([], async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        hermesCommand: "python3",
        provider: "anthropic",
        model: "claude-sonnet-5",
        env: { RAMP_ROUTER_API_KEY: "router-test-key-7895" },
      },
    });
    const codes = result.checks.map((check) => check.code);
    // The Router key is not a provider key for an Anthropic config.
    expect(codes).toContain("hermes_no_api_keys");
    expect(codes).not.toContain("hermes_api_keys_found");
    expect(codes).not.toContain("hermes_router_key_missing");
  });
});

test("testEnvironment probes with the run's env: empty PATH preserved, PYTHONPATH/HOME stripped", async () => {
  await withHermesHomeConfig([], async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-router-probe-env-"));
    const capture = join(root, "probe-env.json");
    try {
      const { createFakeHermesInstall } = await import("./test-support/fake-hermes-install.js");
      const install = await createFakeHermesInstall(join(root, "router"), {
        providersExtra:
          "import os as _os\n" +
          `open(${JSON.stringify(capture)}, 'w').write(json.dumps({k: _os.environ.get(k) for k in ` +
          "['PATH','PYTHONPATH','PYTHONHOME','PYTHONUSERBASE','PYTHONNOUSERSITE']}))",
      });
      const result = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: {
          // Absolute launcher: an explicitly empty PATH must still reach the probe empty, exactly as
          // it reaches the run, so launcher lookup does not depend on a default PATH substituted here.
          hermesCommand: install.command,
          provider: "router",
          model: "auto-jev-routing",
          env: {
            RAMP_ROUTER_API_KEY: "router-test-key-7895",
            PATH: "",
            PYTHONPATH: "/workspace/shadow",
            PYTHONHOME: "/nowhere",
            PYTHONUSERBASE: "/shadow-user-site",
          },
        },
      });
      expect(result.checks.map((check) => check.code)).toContain("hermes_router_supported");
      const seen = JSON.parse(await readFile(capture, "utf8")) as Record<string, string | null>;
      expect(seen.PATH).toBe("");
      expect(seen.PYTHONPATH).toBeNull();
      expect(seen.PYTHONHOME).toBeNull();
      expect(seen.PYTHONUSERBASE).toBeNull();
      expect(seen.PYTHONNOUSERSITE).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
