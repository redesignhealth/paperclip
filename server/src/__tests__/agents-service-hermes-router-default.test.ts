import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { redactAgentAdapterConfig } from "../redaction.js";
import { __resetForTests, captureAndScrubPlatformDefaultOpenAiKey } from "../secrets/platform-default-openai-key.js";
import { secretService } from "../services/secrets.js";
import { resolveProvider } from "@paperclipai/hermes-paperclip-adapter/server";

/**
 * TECH-7895: new Hermes Local agents default to the Ramp Router provider unless the request
 * chooses a provider or supplies a provider credential. Existing agents and every non-Hermes
 * adapter are untouched, and no instance-wide Router key is invented.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Hermes Router default tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ROUTER_KEY = "router-test-key-must-never-leak-1234567890";

describeEmbeddedPostgres("agents service Hermes Ramp Router default", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-hermes-router-default-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("hermes-router-default");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetForTests();
  });

  afterEach(async () => {
    __resetForTests();
    delete process.env.PAPERCLIP_DEFAULT_OPENAI_API_KEY;
    await db.delete(activityLog);
    await db.delete(userSecretDeclarations);
    await db.delete(userSecretDefinitions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function createAgent(companyId: string, overrides: Record<string, unknown> = {}) {
    return agentService(db).create(companyId, {
      name: `Hermes ${randomUUID().slice(0, 6)}`,
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
      ...overrides,
    } as Parameters<ReturnType<typeof agentService>["create"]>[1]);
  }

  it("defaults a credential-free hermes_local agent to router + auto-jev-routing", async () => {
    const companyId = await seedCompany();

    const created = await createAgent(companyId);

    expect(created.adapterType).toBe("hermes_local");
    expect(created.adapterConfig).toEqual({
      provider: "router",
      model: "auto-jev-routing",
    });
    // No key is invented: no env binding, no secret, no audit row.
    expect((created.adapterConfig as Record<string, unknown>).env).toBeUndefined();
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toHaveLength(0);
  });

  it.each([["auto"], ["  auto  "], [""]])(
    "treats provider %j as no choice and applies the Router default",
    async (provider) => {
      const companyId = await seedCompany();
      const created = await createAgent(companyId, {
        adapterConfig: { provider },
      });
      expect((created.adapterConfig as Record<string, unknown>).provider).toBe("router");
    },
  );

  it.each([
    ["an explicit provider", { provider: "anthropic" }, { provider: "anthropic" }],
    [
      "an explicit provider with a model",
      { provider: "openrouter", model: "anthropic/claude-sonnet-4-6" },
      { provider: "openrouter", model: "anthropic/claude-sonnet-4-6" },
    ],
  ])("preserves %s verbatim", async (_label, adapterConfig, expected) => {
    const companyId = await seedCompany();
    const created = await createAgent(companyId, { adapterConfig });
    expect(created.adapterConfig).toEqual(expected);
  });

  it.each([
    ["an explicit model only", { model: "claude-sonnet-5" }],
    ["an explicit model with provider auto", { provider: "auto", model: "claude-sonnet-5" }],
  ])("leaves %s untouched so model-name inference still applies", async (_label, adapterConfig) => {
    const companyId = await seedCompany();
    const created = await createAgent(companyId, { adapterConfig });
    // An explicit model means the caller chose a vendor; the implicit Router default never applies.
    expect(created.adapterConfig).toEqual(adapterConfig);
  });

  it("treats the legacy \"auto\" model sentinel as no model chosen", async () => {
    const companyId = await seedCompany();
    const created = await createAgent(companyId, { adapterConfig: { model: "auto" } });
    expect(created.adapterConfig).toEqual({ provider: "router", model: "auto-jev-routing" });
  });

  it.each([
    ["no model", {}],
    ["a blank model", { model: "   " }],
    ["the auto model sentinel", { model: "auto" }],
  ])("fills the Router default model for explicit Router with %s, with or without a key", async (_label, extra) => {
    const companyId = await seedCompany();
    for (const env of [undefined, { RAMP_ROUTER_API_KEY: ROUTER_KEY }]) {
      const created = await createAgent(companyId, {
        adapterConfig: { provider: "router", ...extra, ...(env ? { env } : {}) },
      });
      const config = created.adapterConfig as Record<string, any>;
      expect(config.provider).toBe("router");
      expect(config.model).toBe("auto-jev-routing");
      if (env) expect(config.env.RAMP_ROUTER_API_KEY).toMatchObject({ type: "plain" });
    }
  });

  it("keeps an explicit model on explicit Router even when a key is supplied", async () => {
    const companyId = await seedCompany();
    const created = await createAgent(companyId, {
      adapterConfig: { provider: "router", model: "vendor/account-model", env: { RAMP_ROUTER_API_KEY: ROUTER_KEY } },
    });
    expect(created.adapterConfig).toMatchObject({ provider: "router", model: "vendor/account-model" });
  });

  it("does not apply the default when the request supplies a Router key", async () => {
    const companyId = await seedCompany();

    const created = await createAgent(companyId, {
      adapterConfig: { env: { RAMP_ROUTER_API_KEY: ROUTER_KEY } },
    });

    const config = created.adapterConfig as Record<string, any>;
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(config.env.RAMP_ROUTER_API_KEY).toMatchObject({ type: "plain" });
  });

  it("does not apply the default when the request supplies another provider key", async () => {
    const companyId = await seedCompany();

    const created = await createAgent(companyId, {
      adapterConfig: { env: { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" } },
    });

    const config = created.adapterConfig as Record<string, any>;
    expect(config.provider).toBeUndefined();
    expect(config.env.ANTHROPIC_API_KEY).toMatchObject({ type: "plain" });
  });

  // The expected provider is the pre-existing resolver result: model-name inference strips a vendor
  // prefix (openrouter/anthropic/claude-* infers anthropic), and an explicit "auto" is passed through
  // so Hermes detects the provider itself. This change must not alter either, only stop the create
  // path from pinning such models to Router.
  it.each([
    ["claude-sonnet-5", undefined, "anthropic"],
    ["claude-sonnet-5", "auto", "auto"],
    ["openrouter/anthropic/claude-sonnet-4-6", undefined, "anthropic"],
  ])("preserves provider inference for explicit model %s with provider %s", async (model, provider, expectedProvider) => {
    const companyId = await seedCompany();
    const created = await createAgent(companyId, {
      adapterConfig: { model, ...(provider === undefined ? {} : { provider }) },
    });
    const config = created.adapterConfig as { model: string; provider?: string };
    expect(config.model).toBe(model);
    // Preserving the string is insufficient if create pins it to a different inference backend.
    expect(config.provider ?? undefined).toBe(provider);
    expect(resolveProvider({ model: config.model, explicitProvider: config.provider }).provider).toBe(expectedProvider);
    expect(resolveProvider({ model: config.model, explicitProvider: config.provider }).provider).not.toBe("router");
  });

  it.each(["RAMP_ROUTER_API_KEY", "ANTHROPIC_API_KEY"])(
    "recognizes company and user secret references for %s before their values resolve",
    async (key) => {
      const companyId = await seedCompany();
      const secret = await secretService(db).create(companyId, {
        name: "Explicit provider credential",
        provider: "local_encrypted",
        value: ROUTER_KEY,
      });
      await db.insert(userSecretDefinitions).values({
        companyId, key: "provider_key", name: "Provider key", scope: "company",
      });
      for (const binding of [
        { type: "secret_ref", secretId: secret.id, version: "latest" },
        { type: "user_secret_ref", key: "provider_key" },
      ]) {
        const created = await createAgent(companyId, { adapterConfig: { env: { [key]: binding } } });
        expect(created.adapterConfig).toMatchObject({ env: { [key]: binding } });
        expect(created.adapterConfig).not.toHaveProperty("provider");
        expect(created.adapterConfig).not.toHaveProperty("model");
      }
    },
  );

  it.each([
    ["empty string", ""],
    ["whitespace string", "   "],
    ["empty plain binding", { type: "plain", value: "" }],
    ["whitespace plain binding", { type: "plain", value: "   " }],
  ])("does not mistake a %s Router binding for a supplied credential", async (_label, binding) => {
    const companyId = await seedCompany();
    const created = await createAgent(companyId, {
      adapterConfig: { env: { RAMP_ROUTER_API_KEY: binding } },
    });
    expect(created.adapterConfig).toMatchObject({ provider: "router", model: "auto-jev-routing" });
    expect((created.adapterConfig as Record<string, any>).env.RAMP_ROUTER_API_KEY).toEqual(
      typeof binding === "string" ? { type: "plain", value: binding } : binding,
    );
  });

  it("preserves an explicit plain credential binding without imposing Router defaults", async () => {
    const companyId = await seedCompany();
    const binding = { type: "plain", value: ROUTER_KEY };
    const created = await createAgent(companyId, { adapterConfig: { env: { RAMP_ROUTER_API_KEY: binding } } });
    expect(created.adapterConfig).toEqual({ env: { RAMP_ROUTER_API_KEY: binding } });
  });

  it.each([false, true])("a legacy OpenAI platform default cannot change explicit Router routing (own Router key: %s)", async (withRouterKey) => {
    captureAndScrubPlatformDefaultOpenAiKey({
      PAPERCLIP_DEFAULT_OPENAI_API_KEY: "sk-test-platform-default-not-real-1234567890",
    });
    const companyId = await seedCompany();
    const created = await createAgent(companyId, {
      adapterConfig: {
        provider: "router", model: "claude-sonnet-5",
        ...(withRouterKey ? { env: { RAMP_ROUTER_API_KEY: { type: "plain", value: ROUTER_KEY } } } : {}),
      },
    });
    const config = created.adapterConfig as Record<string, any>;
    expect(config.provider).toBe("router");
    expect(config.model).toBe("claude-sonnet-5");
    expect(resolveProvider({ explicitProvider: config.provider, model: config.model }).provider).toBe("router");
    if (withRouterKey) expect(config.env.RAMP_ROUTER_API_KEY).toEqual({ type: "plain", value: ROUTER_KEY });
  });

  it("leaves non-Hermes adapters untouched", async () => {
    const companyId = await seedCompany();

    for (const adapterType of ["claude_local", "codex_local", "process"]) {
      const created = await createAgent(companyId, {
        adapterType,
        adapterConfig: {},
      });
      expect(created.adapterConfig, adapterType).toEqual({});
    }
  });

  it("does not apply the default on the update path, including an adapterType switch to hermes_local", async () => {
    const companyId = await seedCompany();

    const created = await createAgent(companyId, {
      adapterType: "process",
      adapterConfig: {},
    });
    expect(created.adapterConfig).toEqual({});

    const switched = await agentService(db).update(created.id, {
      adapterType: "hermes_local",
    });
    expect((switched!.adapterConfig as Record<string, unknown>).provider).toBeUndefined();
    expect((switched!.adapterConfig as Record<string, unknown>).model).toBeUndefined();

    // A direct update of an existing Hermes agent also stays exactly as the caller wrote it.
    const hermes = await createAgent(companyId, {
      adapterConfig: { provider: "anthropic" },
    });
    const updated = await agentService(db).update(hermes.id, {
      adapterConfig: {},
    });
    expect(updated!.adapterConfig).toEqual({});
  });

  it("never stores or returns the raw provider key in agent, portability, or redacted responses", async () => {
    const companyId = await seedCompany();

    const created = await createAgent(companyId, {
      name: "Hermes Router Key",
      adapterConfig: { env: { RAMP_ROUTER_API_KEY: ROUTER_KEY } },
    });

    // The response redaction the agent routes apply must not leak it.
    const redacted = redactAgentAdapterConfig(created.adapterConfig as Record<string, unknown>);
    expect(JSON.stringify(redacted)).not.toContain(ROUTER_KEY);

    // A company export describes the key as an input and carries no value.
    const exported = await companyPortabilityService(db).exportBundle(companyId, {
      include: { company: true, agents: true, projects: false, issues: false },
    });
    const exportedText = JSON.stringify(exported);
    expect(exportedText).not.toContain(ROUTER_KEY);
    expect(exported.manifest.envInputs).toContainEqual(
      expect.objectContaining({ key: "RAMP_ROUTER_API_KEY", kind: "secret", defaultValue: "" }),
    );
  });
});
