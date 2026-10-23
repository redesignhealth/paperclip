import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { parseModelFromConfig, resolveProvider } from "./detect-model.js";
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
