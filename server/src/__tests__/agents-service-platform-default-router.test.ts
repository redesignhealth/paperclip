import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { conflict } from "../errors.js";
import {
  captureAndScrubPlatformDefaultOpenAiKey,
  PAPERCLIP_DEFAULT_OPENAI_API_KEY,
  __resetForTests as resetOpenAiKey,
} from "../secrets/platform-default-openai-key.js";
import {
  captureAndScrubPlatformDefaultRouterKey,
  PAPERCLIP_DEFAULT_ROUTER_API_KEY,
  __resetForTests as resetRouterKey,
} from "../secrets/platform-default-router-key.js";
import { reconcilePlatformDefaultRouterSecretsOnStartup } from "../services/platform-default-router-reconcile.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres platform default Router key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ROUTER_KEY = "rr-test-platform-router-key-for-testing-only-1234567890";
const OPENAI_KEY = "sk-test-platform-openai-key-for-testing-only-1234567890";
const ROUTER_NAME = "RAMP_ROUTER_API_KEY (platform default)";

/** TECH-7959: the platform-default Ramp Router key bound at create, and its boot-time reconcile. */
describeEmbeddedPostgres("agents service platform default Ramp Router key", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-platform-default-router-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("platform-default-router");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    resetOpenAiKey();
    resetRouterKey();
  });

  afterEach(async () => {
    resetOpenAiKey();
    resetRouterKey();
    delete process.env[PAPERCLIP_DEFAULT_OPENAI_API_KEY];
    delete process.env[PAPERCLIP_DEFAULT_ROUTER_API_KEY];
    await db.delete(activityLog);
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

  function setupRouterKey(extraEnv: NodeJS.ProcessEnv = {}) {
    captureAndScrubPlatformDefaultRouterKey({ [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: ROUTER_KEY, ...extraEnv });
  }
  function setupOpenAiKey() {
    captureAndScrubPlatformDefaultOpenAiKey({ [PAPERCLIP_DEFAULT_OPENAI_API_KEY]: OPENAI_KEY });
  }

  function hermes(companyId: string, adapterConfig: Record<string, unknown> = {}, name = `Hermes ${randomUUID().slice(0, 6)}`) {
    return agentService(db).create(companyId, {
      name,
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig,
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
  }

  async function companyLogs(companyId: string) {
    return db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
  }
  async function companySecretRows(companyId: string) {
    return db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
  }

  it("feature off (no Router key captured): identical to today for both an untouched and an OpenAI-default create", async () => {
    const companyId = await seedCompany();
    const untouched = await hermes(companyId);
    expect(untouched.adapterConfig).toEqual({ provider: "router", model: "auto-jev-routing" });

    setupOpenAiKey();
    const withOpenAi = await hermes(companyId);
    const cfg = withOpenAi.adapterConfig as Record<string, any>;
    expect(cfg.provider).toBeUndefined();
    expect(cfg.env.OPENAI_API_KEY).toMatchObject({ type: "secret_ref", version: "latest" });
    expect(cfg.env).not.toHaveProperty("RAMP_ROUTER_API_KEY");
    const secrets = await companySecretRows(companyId);
    expect(secrets.map((s) => s.key)).toEqual(["openai_api_key"]);
    const logs = await companyLogs(companyId);
    expect(logs.some((l) => l.actorId === "platform-default-router-key")).toBe(false);
  });

  it("created: binds RAMP_ROUTER_API_KEY, makes Router the default, and audits without the value", async () => {
    setupRouterKey();
    const companyId = await seedCompany();
    const created = await hermes(companyId);
    const cfg = created.adapterConfig as Record<string, any>;
    expect(cfg.provider).toBe("router");
    expect(cfg.model).toBe("auto-jev-routing");
    expect(cfg.env.RAMP_ROUTER_API_KEY).toMatchObject({ type: "secret_ref", version: "latest" });
    expect(cfg.env).not.toHaveProperty("OPENAI_API_KEY");

    const secretId = cfg.env.RAMP_ROUTER_API_KEY.secretId;
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
    expect(secret).toMatchObject({
      key: "ramp_router_api_key",
      name: ROUTER_NAME,
      provider: "local_encrypted",
      status: "active",
      managedMode: "paperclip_managed",
    });
    expect(await secretService(db).resolveSecretValue(companyId, secretId, "latest")).toBe(ROUTER_KEY);

    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, created.id));
    expect(bindings.map((b) => b.secretId)).toEqual([secretId]);

    const logs = await companyLogs(companyId);
    const routerLog = logs.find((l) => l.actorId === "platform-default-router-key");
    expect(routerLog).toMatchObject({ actorType: "system", action: "secret.platform_default.bound", entityId: created.id });
    expect(routerLog!.details).toMatchObject({ outcome: "created", source: "deployment_env:PAPERCLIP_DEFAULT_ROUTER_API_KEY" });
    expect(JSON.stringify(logs)).not.toContain(ROUTER_KEY);
  });

  it("binds both platform keys when both are available: Router decides the provider, OpenAI stays for memory", async () => {
    setupRouterKey();
    setupOpenAiKey();
    const companyId = await seedCompany();
    const created = await hermes(companyId);
    const cfg = created.adapterConfig as Record<string, any>;
    expect(cfg.provider).toBe("router");
    expect(cfg.model).toBe("auto-jev-routing");
    expect(cfg.env.RAMP_ROUTER_API_KEY).toMatchObject({ type: "secret_ref" });
    expect(cfg.env.OPENAI_API_KEY).toMatchObject({ type: "secret_ref" });
    expect((await companySecretRows(companyId)).map((s) => s.key).sort()).toEqual(["openai_api_key", "ramp_router_api_key"]);
    expect(await secretService(db).resolveSecretValue(companyId, cfg.env.OPENAI_API_KEY.secretId, "latest")).toBe(OPENAI_KEY);

    const logs = await companyLogs(companyId);
    expect(logs.filter((l) => l.action === "secret.platform_default.bound").map((l) => l.actorId).sort())
      .toEqual(["platform-default-openai-key", "platform-default-router-key"]);
    expect(JSON.stringify(logs)).not.toContain(ROUTER_KEY);
    expect(JSON.stringify(logs)).not.toContain(OPENAI_KEY);
  });

  it("reused: binds an existing active ramp_router_api_key without creating another", async () => {
    setupRouterKey();
    const companyId = await seedCompany();
    const existing = await secretService(db).create(companyId, {
      name: "Org Router Key",
      key: "ramp_router_api_key",
      provider: "local_encrypted",
      value: "rr-existing-company-router-key-1234567890",
    });
    const created = await hermes(companyId);
    expect((created.adapterConfig as Record<string, any>).env.RAMP_ROUTER_API_KEY).toEqual({
      type: "secret_ref",
      secretId: existing.id,
      version: "latest",
    });
    expect(await companySecretRows(companyId)).toHaveLength(1);
    const routerLog = (await companyLogs(companyId)).find((l) => l.actorId === "platform-default-router-key");
    expect(routerLog!.details).toMatchObject({ outcome: "reused" });
  });

  it.each([
    ["skipped_inactive_existing", { key: "ramp_router_api_key", name: "Old Router Key", status: "archived" }],
    ["skipped_name_conflict", { key: "something_else", name: ROUTER_NAME, status: "active" }],
  ])("%s: binds nothing for Router and falls back to today's OpenAI default", async (outcome, row) => {
    setupRouterKey();
    setupOpenAiKey();
    const companyId = await seedCompany();
    await db.insert(companySecrets).values({
      companyId,
      ...row,
      provider: "local_encrypted",
      managedMode: "paperclip_managed",
      latestVersion: 1,
    });
    const created = await hermes(companyId);
    const cfg = created.adapterConfig as Record<string, any>;
    expect(cfg.provider).toBeUndefined();
    expect(cfg.env).not.toHaveProperty("RAMP_ROUTER_API_KEY");
    expect(cfg.env.OPENAI_API_KEY).toMatchObject({ type: "secret_ref" });
    const routerLog = (await companyLogs(companyId)).find((l) => l.actorId === "platform-default-router-key");
    expect(routerLog).toMatchObject({ action: "secret.platform_default.skipped" });
    expect(routerLog!.details).toMatchObject({ outcome });
  });

  it("keeps an explicit blank RAMP_ROUTER_API_KEY and an explicit Anthropic agent untouched", async () => {
    setupRouterKey();
    const companyId = await seedCompany();
    const blank = await hermes(companyId, { env: { RAMP_ROUTER_API_KEY: "" } });
    expect((blank.adapterConfig as Record<string, any>).env.RAMP_ROUTER_API_KEY).toEqual({ type: "plain", value: "" });

    const anthropicKey = await secretService(db).create(companyId, {
      name: "Anthropic",
      key: "anthropic_api_key",
      provider: "local_encrypted",
      value: "sk-ant-user-key-1234567890",
    });
    const anthropic = await hermes(companyId, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: anthropicKey.id, version: "latest" } },
    });
    const cfg = anthropic.adapterConfig as Record<string, any>;
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-5");
    expect(cfg.env).not.toHaveProperty("RAMP_ROUTER_API_KEY");

    expect((await companySecretRows(companyId)).some((s) => s.key === "ramp_router_api_key")).toBe(false);
    expect((await companyLogs(companyId)).some((l) => l.actorId === "platform-default-router-key")).toBe(false);
  });

  it("binds the platform key for an explicit Router provider with no key, keeping an explicit model", async () => {
    setupRouterKey();
    const companyId = await seedCompany();
    const created = await hermes(companyId, { provider: "router", model: "custom-model" });
    const cfg = created.adapterConfig as Record<string, any>;
    expect(cfg).toMatchObject({ provider: "router", model: "custom-model" });
    expect(cfg.env.RAMP_ROUTER_API_KEY).toMatchObject({ type: "secret_ref" });
  });

  it("concurrent creates yield one Router secret (and one OpenAI secret), shared by both agents", async () => {
    setupRouterKey();
    setupOpenAiKey();
    const companyId = await seedCompany();
    const [a, b] = await Promise.all([hermes(companyId, {}, "Parallel 1"), hermes(companyId, {}, "Parallel 2")]);
    const envA = (a.adapterConfig as Record<string, any>).env;
    const envB = (b.adapterConfig as Record<string, any>).env;
    expect(envA.RAMP_ROUTER_API_KEY.secretId).toBe(envB.RAMP_ROUTER_API_KEY.secretId);
    expect(envA.OPENAI_API_KEY.secretId).toBe(envB.OPENAI_API_KEY.secretId);
    const secrets = await companySecretRows(companyId);
    expect(secrets.filter((s) => s.key === "ramp_router_api_key")).toHaveLength(1);
    expect(secrets.filter((s) => s.key === "openai_api_key")).toHaveLength(1);
  });

  it("refuses a drifted expectation with 409 and rolls back every side effect, including the new secrets", async () => {
    setupRouterKey();
    setupOpenAiKey();
    const companyId = await seedCompany();
    await expect(
      agentService(db).create(
        companyId,
        {
          name: "Hermes Drift",
          role: "engineer",
          status: "active",
          adapterType: "hermes_local",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        {
          // A forecast taken before the Router key existed.
          expectedCreateDefaults: {
            provider: null, model: null, source: "platform_openai", requiresRouterReadiness: false, platformRouterKeyBound: false,
          },
        },
      ),
    ).rejects.toMatchObject({ status: 409, details: { code: "agent_create_defaults_changed" } });
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await companySecretRows(companyId)).toHaveLength(0);
    expect(await companyLogs(companyId)).toHaveLength(0);
  });

  it("accepts the matching expectation", async () => {
    setupRouterKey();
    setupOpenAiKey();
    const companyId = await seedCompany();
    const created = await agentService(db).create(
      companyId,
      {
        name: "Hermes Expected",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      {
        expectedCreateDefaults: {
          provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true, platformRouterKeyBound: true,
        },
      },
    );
    expect((created.adapterConfig as Record<string, any>).provider).toBe("router");
  });

  it("fails closed with a fixed Router 422 when the secret cannot be stored, rolling back atomically", async () => {
    setupRouterKey();
    const companyId = await seedCompany();
    const hook = vi.fn(async (secretKey: string) => {
      throw conflict(`Secret key already exists: ${secretKey}`, { code: "secret_key_conflict", field: "key" });
    });
    await expect(
      agentService(db).create(
        companyId,
        {
          name: "Hermes Router Unavailable",
          role: "engineer",
          status: "active",
          adapterType: "hermes_local",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        { _testBeforeEnsureSecretCreate: hook },
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: "The platform default Ramp Router key could not be stored; the agent was not created.",
      details: { code: "platform_default_secret_unavailable" },
    });
    expect(hook).toHaveBeenCalledWith("ramp_router_api_key");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await companySecretRows(companyId)).toHaveLength(0);
  });

  it("never changes an existing agent on update", async () => {
    const companyId = await seedCompany();
    const legacy = await agentService(db).create(companyId, {
      name: "Legacy",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    setupRouterKey();
    const updated = await agentService(db).update(legacy.id, { adapterType: "hermes_local" });
    expect((updated!.adapterConfig as Record<string, any>).env).toBeUndefined();
    expect(await companySecretRows(companyId)).toHaveLength(0);
  });

  it("never writes the Router key to the console during a create", async () => {
    const seen: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { seen.push(JSON.stringify(args)); }));
    try {
      setupRouterKey();
      setupOpenAiKey();
      const companyId = await seedCompany();
      await hermes(companyId);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    for (const line of seen) expect(line).not.toContain(ROUTER_KEY);
  });

  describe("boot reconcile", () => {
    it("is off by default: no reads, no rotations", async () => {
      setupRouterKey();
      const companyId = await seedCompany();
      await secretService(db).create(companyId, {
        name: ROUTER_NAME,
        key: "ramp_router_api_key",
        provider: "local_encrypted",
        value: "rr-stale-router-key-0000000000000000",
      });
      const summary = await reconcilePlatformDefaultRouterSecretsOnStartup(db);
      expect(summary).toEqual({ enabled: false, scanned: 0, unchanged: 0, rotated: 0, failed: 0 });
      const [row] = await companySecretRows(companyId);
      expect(row.latestVersion).toBe(1);
    });

    it("rotates only exact-name managed platform secrets that drifted, and reports counts only", async () => {
      setupRouterKey({ PAPERCLIP_PLATFORM_ROUTER_RECONCILE: "true" });
      const stale = await seedCompany();
      const current = await seedCompany();
      const renamed = await seedCompany();
      const svc = secretService(db);
      const staleSecret = await svc.create(stale, {
        name: ROUTER_NAME, key: "ramp_router_api_key", provider: "local_encrypted", value: "rr-stale-router-key-0000000000000000",
      });
      const currentSecret = await svc.create(current, {
        name: ROUTER_NAME, key: "ramp_router_api_key", provider: "local_encrypted", value: ROUTER_KEY,
      });
      const renamedSecret = await svc.create(renamed, {
        name: "My Router Key", key: "ramp_router_api_key", provider: "local_encrypted", value: "rr-user-own-router-key-1111111111111",
      });

      const summary = await reconcilePlatformDefaultRouterSecretsOnStartup(db);
      expect(summary).toEqual({ enabled: true, scanned: 2, unchanged: 1, rotated: 1, failed: 0 });
      expect(JSON.stringify(summary)).not.toContain(ROUTER_KEY);

      expect(await svc.resolveSecretValue(stale, staleSecret.id, "latest")).toBe(ROUTER_KEY);
      const [staleRow] = await db.select().from(companySecrets).where(eq(companySecrets.id, staleSecret.id));
      expect(staleRow.latestVersion).toBe(2);
      const [currentRow] = await db.select().from(companySecrets).where(eq(companySecrets.id, currentSecret.id));
      expect(currentRow.latestVersion).toBe(1);
      expect(await svc.resolveSecretValue(renamed, renamedSecret.id, "latest")).toBe("rr-user-own-router-key-1111111111111");

      // Idempotent: a second boot finds nothing to rotate.
      expect(await reconcilePlatformDefaultRouterSecretsOnStartup(db)).toMatchObject({ scanned: 2, unchanged: 2, rotated: 0 });
    });

    it("skips inactive platform secrets", async () => {
      setupRouterKey({ PAPERCLIP_PLATFORM_ROUTER_RECONCILE: "true" });
      const companyId = await seedCompany();
      await db.insert(companySecrets).values({
        companyId,
        key: "ramp_router_api_key",
        name: ROUTER_NAME,
        provider: "local_encrypted",
        status: "disabled",
        managedMode: "paperclip_managed",
        latestVersion: 1,
      });
      expect(await reconcilePlatformDefaultRouterSecretsOnStartup(db)).toMatchObject({ enabled: true, scanned: 0 });
      const rows = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId)));
      expect(rows[0].latestVersion).toBe(1);
    });
  });
});
