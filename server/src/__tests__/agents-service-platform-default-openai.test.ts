import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
import { secretService } from "../services/secrets.js";
import { awsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";
import {
  captureAndScrubPlatformDefaultOpenAiKey,
  PAPERCLIP_DEFAULT_OPENAI_API_KEY,
  __resetForTests,
} from "../secrets/platform-default-openai-key.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres platform default OpenAI key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agents service platform default OpenAI key autobind", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let embeddedConnectionString = "";
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-platform-default-openai-${randomUUID()}`);
  const FAKE_DEFAULT_KEY = "sk-test-platform-default-key-for-testing-only-1234567890";

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("platform-default-openai");
    stopDb = started.cleanup;
    embeddedConnectionString = started.connectionString;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetForTests();
  });

  afterEach(async () => {
    __resetForTests();
    delete process.env[PAPERCLIP_DEFAULT_OPENAI_API_KEY];
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

  function setupDefaultKey(key = FAKE_DEFAULT_KEY) {
    const env: NodeJS.ProcessEnv = { [PAPERCLIP_DEFAULT_OPENAI_API_KEY]: key };
    captureAndScrubPlatformDefaultOpenAiKey(env);
  }

  it("default off (unconfigured): zero side effects, no secrets created or bound", async () => {
    const companyId = await seedCompany();

    const created = await agentService(db).create(companyId, {
      name: "Hermes Agent",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    expect(created.adapterConfig).toEqual({});
    const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(secrets).toHaveLength(0);
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    expect(bindings).toHaveLength(0);
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(logs.some((l) => l.action.startsWith("secret.platform_default"))).toBe(false);
  });

  it("invalid captured default key (present but malformed): old behavior, zero DB side effects", async () => {
    const invalidEnv: NodeJS.ProcessEnv = { [PAPERCLIP_DEFAULT_OPENAI_API_KEY]: "sk-invalid-short" };
    const status = captureAndScrubPlatformDefaultOpenAiKey(invalidEnv);
    expect(status).toEqual({ configured: false, invalid: true });
    expect(invalidEnv[PAPERCLIP_DEFAULT_OPENAI_API_KEY]).toBeUndefined();

    const companyId = await seedCompany();

    const created = await agentService(db).create(companyId, {
      name: "Hermes Invalid Default",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    expect((created.adapterConfig as Record<string, any>).env).toBeUndefined();
    const secretsRows = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(secretsRows).toHaveLength(0);
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    expect(bindings).toHaveLength(0);
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(logs.some((l) => l.action.startsWith("secret.platform_default"))).toBe(false);
  });

  it("new hermes_local: creates one encrypted secret + latest bindings + audit event without fake key values", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    const created = await agentService(db).create(companyId, {
      name: "Hermes Default",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const config = created.adapterConfig as Record<string, any>;
    expect(config.env).toBeDefined();
    expect(config.env.OPENAI_API_KEY).toMatchObject({
      type: "secret_ref",
      version: "latest",
    });
    const secretId = config.env.OPENAI_API_KEY.secretId;
    expect(secretId).toBeDefined();

    // Verify secret in database
    const [secret] = await db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId)));
    expect(secret).toBeDefined();
    expect(secret.key).toBe("openai_api_key");
    expect(secret.name).toBe("OPENAI_API_KEY (platform default)");
    expect(secret.provider).toBe("local_encrypted");
    expect(secret.status).toBe("active");
    expect(secret.managedMode).toBe("paperclip_managed");

    // The stored ciphertext actually decrypts, through the production resolve
    // path, to the captured platform default value -- not just to any ciphertext.
    const resolvedValue = await secretService(db).resolveSecretValue(companyId, secretId, "latest");
    expect(resolvedValue).toBe(FAKE_DEFAULT_KEY);

    // Verify binding
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(and(eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.targetId, created.id)));
    expect(binding).toBeDefined();
    expect(binding.secretId).toBe(secretId);

    // Verify audit log
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const defaultLog = logs.find((l) => l.action === "secret.platform_default.bound");
    expect(defaultLog).toBeDefined();
    expect(defaultLog!.actorType).toBe("system");
    expect(defaultLog!.actorId).toBe("platform-default-openai-key");
    expect(defaultLog!.entityType).toBe("agent");
    expect(defaultLog!.entityId).toBe(created.id);
    expect(defaultLog!.details).toMatchObject({
      secretId: "***REDACTED***",
      secretKey: "***REDACTED***",
      outcome: "created",
      source: "deployment_env:PAPERCLIP_DEFAULT_OPENAI_API_KEY",
    });
    // Ensure raw key value is not present in audit log details or description
    expect(JSON.stringify(defaultLog)).not.toContain(FAKE_DEFAULT_KEY);
  });

  it("existing active local secret: reuses secret ID without creating a new secret", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();
    const secrets = secretService(db);

    const existingSecret = await secrets.create(companyId, {
      name: "Existing OpenAI Key",
      key: "openai_api_key",
      provider: "local_encrypted",
      value: "sk-existing-company-key-1234567890",
    });

    const created = await agentService(db).create(companyId, {
      name: "Hermes Agent 2",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const config = created.adapterConfig as Record<string, any>;
    expect(config.env.OPENAI_API_KEY).toEqual({
      type: "secret_ref",
      secretId: existingSecret.id,
      version: "latest",
    });

    const allSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(allSecrets).toHaveLength(1);

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const defaultLog = logs.find((l) => l.action === "secret.platform_default.bound");
    expect(defaultLog).toBeDefined();
    expect(defaultLog!.details).toMatchObject({
      secretId: "***REDACTED***",
      secretKey: "***REDACTED***",
      outcome: "reused",
      source: "deployment_env:PAPERCLIP_DEFAULT_OPENAI_API_KEY",
    });
  });

  it("existing active AWS external secret: reuses secret ID without provider resolve", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    // If the autobind path ever tried to fetch from AWS during agent create,
    // this spy would catch it without any network access.
    const resolveSpy = vi
      .spyOn(awsSecretsManagerProvider, "resolveVersion")
      .mockResolvedValue("should-not-be-called-during-autobind");

    const [awsSecret] = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: "openai_api_key",
        name: "OPENAI_API_KEY (AWS)",
        provider: "aws_secrets_manager",
        providerConfigId: null,
        status: "active",
        managedMode: "external_reference",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-xyz",
        latestVersion: 1,
      })
      .returning();

    const created = await agentService(db).create(companyId, {
      name: "Hermes AWS Reused",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const config = created.adapterConfig as Record<string, any>;
    expect(config.env.OPENAI_API_KEY).toEqual({
      type: "secret_ref",
      secretId: awsSecret.id,
      version: "latest",
    });

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const defaultLog = logs.find((l) => l.action === "secret.platform_default.bound");
    expect(defaultLog).toBeDefined();
    expect(defaultLog!.details).toMatchObject({
      secretId: "***REDACTED***",
      outcome: "reused",
    });

    // Reuse must never degrade into a provider fetch.
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it.each(["archived", "disabled"] as const)(
    "inactive existing secret (%s): skips binding, preserves the existing secret untouched, and logs skipped_inactive_existing",
    async (inactiveStatus) => {
      setupDefaultKey();
      const companyId = await seedCompany();

      const [existingSecret] = await db
        .insert(companySecrets)
        .values({
          companyId,
          key: "openai_api_key",
          name: "Inactive OpenAI Key",
          provider: "local_encrypted",
          status: inactiveStatus,
          managedMode: "paperclip_managed",
          latestVersion: 1,
        })
        .returning();

      const created = await agentService(db).create(companyId, {
        name: "Hermes Inactive Skip",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });

      const config = created.adapterConfig as Record<string, any>;
      expect(config.env).toBeUndefined();

      // The inactive secret is preserved exactly as-is: not reactivated, not
      // overwritten, no new versions, no bindings, no replacement secret.
      const allSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
      expect(allSecrets).toHaveLength(1);
      expect(allSecrets[0].id).toBe(existingSecret.id);
      expect(allSecrets[0].status).toBe(inactiveStatus);
      expect(allSecrets[0].latestVersion).toBe(1);
      const versions = await db
        .select()
        .from(companySecretVersions)
        .where(eq(companySecretVersions.secretId, existingSecret.id));
      expect(versions).toHaveLength(0);
      const bindings = await db
        .select()
        .from(companySecretBindings)
        .where(eq(companySecretBindings.companyId, companyId));
      expect(bindings).toHaveLength(0);

      const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      const defaultLog = logs.find((l) => l.action === "secret.platform_default.skipped");
      expect(defaultLog).toBeDefined();
      expect(defaultLog!.details).toMatchObject({
        outcome: "skipped_inactive_existing",
        secretKey: "***REDACTED***",
      });
    },
  );

  it("name collision without key match: skips binding and logs skipped_name_conflict", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    // Insert a secret with the name "OPENAI_API_KEY (platform default)" but with a different key
    await db.insert(companySecrets).values({
      companyId,
      key: "other_custom_key",
      name: "OPENAI_API_KEY (platform default)",
      provider: "local_encrypted",
      status: "active",
      managedMode: "paperclip_managed",
      latestVersion: 1,
    });

    const created = await agentService(db).create(companyId, {
      name: "Hermes Name Conflict",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const config = created.adapterConfig as Record<string, any>;
    expect(config.env).toBeUndefined();

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const defaultLog = logs.find((l) => l.action === "secret.platform_default.skipped");
    expect(defaultLog).toBeDefined();
    expect(defaultLog!.details).toMatchObject({
      outcome: "skipped_name_conflict",
      secretKey: "***REDACTED***",
    });
  });

  it("explicit ANY env values: preserves validation and skips default injection", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    // 1. Plain string override
    const plainAgent = await agentService(db).create(companyId, {
      name: "Hermes Plain",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {
        env: { OPENAI_API_KEY: "sk-my-own-explicit-openai-key" },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    expect((plainAgent.adapterConfig as any).env.OPENAI_API_KEY).toEqual({
      type: "plain",
      value: "sk-my-own-explicit-openai-key",
    });

    // 2. Secret reference override
    const secrets = secretService(db);
    const customSecret = await secrets.create(companyId, {
      name: "Custom Secret",
      provider: "local_encrypted",
      value: "sk-custom-12345",
    });
    const refAgent = await agentService(db).create(companyId, {
      name: "Hermes SecretRef",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {
        env: { OPENAI_API_KEY: { type: "secret_ref", secretId: customSecret.id, version: "latest" } },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    expect((refAgent.adapterConfig as any).env.OPENAI_API_KEY).toMatchObject({
      type: "secret_ref",
      secretId: customSecret.id,
      version: "latest",
    });

    // 3. User secret ref override
    await db.insert(userSecretDefinitions).values({
      companyId,
      key: "my_user_key",
      name: "My User Key",
      scope: "company",
    });
    const userRefAgent = await agentService(db).create(companyId, {
      name: "Hermes UserRef",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {
        env: { OPENAI_API_KEY: { type: "user_secret_ref", key: "my_user_key" } },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    expect((userRefAgent.adapterConfig as any).env.OPENAI_API_KEY).toMatchObject({
      type: "user_secret_ref",
      key: "my_user_key",
    });

    // 4. Invalid env property: throws and preserves validation without default injection
    await expect(
      agentService(db).create(companyId, {
        name: "Hermes Invalid Env",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {
          env: { OPENAI_API_KEY: 12345 as any },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toThrow("Invalid environment binding for key: OPENAI_API_KEY");

    // 5. Non-object env property: throws and preserves validation without default injection
    await expect(
      agentService(db).create(companyId, {
        name: "Hermes Array Env",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {
          env: ["invalid-array"] as any,
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toThrow("env must be an object");

    // Verify none of these triggered platform default audit logs
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(logs.some((l) => l.action.startsWith("secret.platform_default"))).toBe(false);
  });

  it("explicit empty-string and null OPENAI_API_KEY overrides: precise behavior, no default side effects", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    // Empty string is an explicit plain override and is preserved verbatim.
    const emptyOverride = await agentService(db).create(companyId, {
      name: "Hermes Empty Override",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: { env: { OPENAI_API_KEY: "" } },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    expect((emptyOverride.adapterConfig as Record<string, any>).env.OPENAI_API_KEY).toEqual({
      type: "plain",
      value: "",
    });

    // Null is malformed: rejected by the pre-existing env validation, never
    // silently repaired with the platform default.
    await expect(
      agentService(db).create(companyId, {
        name: "Hermes Null Override",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: { env: { OPENAI_API_KEY: null } },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toThrow("Invalid environment binding for key: OPENAI_API_KEY");

    // Neither path created a secret, a binding, or a platform_default audit row.
    const secretsRows = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(secretsRows).toHaveLength(0);
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    expect(bindings).toHaveLength(0);
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(logs.some((l) => l.action.startsWith("secret.platform_default"))).toBe(false);
  });

  it("explicit empty env object (no OPENAI_API_KEY entry) still receives the platform default", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    const created = await agentService(db).create(companyId, {
      name: "Hermes Empty Env",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: { env: {} },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const cfg = created.adapterConfig as Record<string, any>;
    expect(cfg.env).toBeDefined();
    expect(cfg.env.OPENAI_API_KEY).toMatchObject({ type: "secret_ref", version: "latest" });
    const secretId = cfg.env.OPENAI_API_KEY.secretId;
    expect(secretId).toBeDefined();

    const [secret] = await db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId)));
    expect(secret).toBeDefined();
    expect(secret.key).toBe("openai_api_key");

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const defaultLog = logs.find((l) => l.action === "secret.platform_default.bound");
    expect(defaultLog).toBeDefined();
    expect(defaultLog!.details).toMatchObject({ outcome: "created" });
  });

  it("wrong company secret ref: rejects with error and does NOT repair with default", async () => {
    setupDefaultKey();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const secrets = secretService(db);

    const secretInB = await secrets.create(companyB, {
      name: "Secret in B",
      provider: "local_encrypted",
      value: "sk-company-b-key",
    });

    await expect(
      agentService(db).create(companyA, {
        name: "Hermes Wrong Company",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {
          env: { OPENAI_API_KEY: { type: "secret_ref", secretId: secretInB.id, version: "latest" } },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toThrow("Secret must belong to same company");

    const secretsInA = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyA));
    expect(secretsInA).toHaveLength(0);
  });

  it("parallel create: exact one secret row created, both agents bound to the same secret ID", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    const [agent1, agent2] = await Promise.all([
      agentService(db).create(companyId, {
        name: "Parallel Hermes 1",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
      agentService(db).create(companyId, {
        name: "Parallel Hermes 2",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ]);

    const cfg1 = agent1.adapterConfig as Record<string, any>;
    const cfg2 = agent2.adapterConfig as Record<string, any>;

    expect(cfg1.env.OPENAI_API_KEY.secretId).toBeDefined();
    expect(cfg2.env.OPENAI_API_KEY.secretId).toBeDefined();
    expect(cfg1.env.OPENAI_API_KEY.secretId).toBe(cfg2.env.OPENAI_API_KEY.secretId);

    const allSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(allSecrets).toHaveLength(1);

    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    expect(bindings).toHaveLength(2);
    expect(bindings.every((b) => b.secretId === cfg1.env.OPENAI_API_KEY.secretId)).toBe(true);
  });

  it("unique-race against a concurrent manual create: loser savepoint-rolls back, reuses the winner's secret, never overwrites the manual key", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();
    const MANUAL_KEY_VALUE = "sk-manual-winner-fake-key-12345678901234567890";

    // A second, independent pool so the manual winner holds its own backend
    // connection while the platform-default loser runs on the main pool.
    const winnerDb = createDb(embeddedConnectionString);

    let resolveWinnerPid!: (pid: number) => void;
    const winnerPidReady = new Promise<number>((resolve) => {
      resolveWinnerPid = resolve;
    });
    let releaseWinner!: () => void;
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    // A manual secret create on the same company key, held uncommitted: its
    // unique-index entry is inserted but invisible to other transactions
    // until the gate releases.
    const winnerTxn = winnerDb.transaction(async (winnerTx) => {
      const manual = await secretService(winnerTx).create(companyId, {
        name: "Manual OpenAI Key",
        key: "openai_api_key",
        provider: "local_encrypted",
        value: MANUAL_KEY_VALUE,
      });
      const [backend] = (await winnerTx.execute(
        sql`select pg_backend_pid() as pid`,
      )) as unknown as Array<{ pid: number }>;
      resolveWinnerPid(backend.pid);
      await winnerGate;
      return manual;
    });

    const winnerPid = await winnerPidReady;
    expect(winnerPid).toBeGreaterThan(0);

    // The platform-default loser: its initial key/name reads miss the
    // uncommitted winner, so it proceeds to insert and hits the 23505.
    const loserCall = agentService(db).create(companyId, {
      name: "Hermes Unique Race Loser",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    // Poll until Postgres reports the loser blocked behind the winner's
    // uncommitted unique-index entry, instead of guessing the timing.
    let loserBlocked = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const rows = (await db.execute(
        sql`select 1 from pg_stat_activity where ${winnerPid} = any(pg_blocking_pids(pid))`,
      )) as unknown as Array<unknown>;
      if (rows[0]) {
        loserBlocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
      expect(loserBlocked).toBe(true);
    } finally {
      releaseWinner();
    }

    const manualSecret = await winnerTxn;
    const loserAgent = await loserCall;

    // The loser lost the insert race, rolled back only to its savepoint, and
    // re-read the now-committed winner: its transaction was never poisoned
    // (the agent row was created and committed in the same transaction).
    expect((loserAgent.adapterConfig as Record<string, any>).env.OPENAI_API_KEY).toEqual({
      type: "secret_ref",
      secretId: manualSecret.id,
      version: "latest",
    });
    const agentRows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(agentRows).toHaveLength(1);

    // The manual winner is the only secret: the loser neither inserted a
    // second secret nor overwrote/repaired the manual one.
    const allSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(allSecrets).toHaveLength(1);
    expect(allSecrets[0].id).toBe(manualSecret.id);
    expect(allSecrets[0].name).toBe("Manual OpenAI Key");
    expect(allSecrets[0].status).toBe("active");
    expect(allSecrets[0].latestVersion).toBe(1);
    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, manualSecret.id));
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);

    // The manual key's ciphertext still decrypts, through the production
    // resolve path, to the manual value -- not to the platform default.
    const resolved = await secretService(db).resolveSecretValue(companyId, manualSecret.id, "latest");
    expect(resolved).toBe(MANUAL_KEY_VALUE);

    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0].secretId).toBe(manualSecret.id);

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const defaultLog = logs.find((l) => l.action === "secret.platform_default.bound");
    expect(defaultLog).toBeDefined();
    expect(defaultLog!.entityId).toBe(loserAgent.id);
    expect(defaultLog!.details).toMatchObject({
      secretId: "***REDACTED***",
      outcome: "reused",
    });
    expect(JSON.stringify(defaultLog)).not.toContain(MANUAL_KEY_VALUE);
    expect(JSON.stringify(defaultLog)).not.toContain(FAKE_DEFAULT_KEY);
  });

  it("pre-insert conflict against a concurrent manual create: loser catches 409 conflict, rolls back savepoint, reuses the winner's secret", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();
    const MANUAL_KEY_VALUE = "sk-manual-pre-insert-conflict-key-1234567890";
    const winnerDb = createDb(embeddedConnectionString);

    let manualSecretId: string | null = null;

    // Use _testBeforeEnsureSecretCreate hook: after the loser finishes initial getByKey/getByName
    // (which return null), but before createManagedLocalSecretUnlocked runs, the manual create commits!
    const loserAgent = await agentService(db).create(
      companyId,
      {
        name: "Hermes Pre-Insert Conflict Loser",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      {
        _testBeforeEnsureSecretCreate: async () => {
          // Concurrent manual winner commits on winnerDb right before loser's internal check
          const manual = await secretService(winnerDb).create(companyId, {
            name: "Manual PreInsert Winner",
            key: "openai_api_key",
            provider: "local_encrypted",
            value: MANUAL_KEY_VALUE,
          });
          manualSecretId = manual.id;
        },
      },
    );

    expect(manualSecretId).toBeDefined();
    // Loser encountered pre-insert conflict on secret key, savepoint rolled back, re-read winner, reused winner
    expect((loserAgent.adapterConfig as Record<string, any>).env.OPENAI_API_KEY).toEqual({
      type: "secret_ref",
      secretId: manualSecretId,
      version: "latest",
    });

    const allSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(allSecrets).toHaveLength(1);
    expect(allSecrets[0].id).toBe(manualSecretId);

    const resolved = await secretService(db).resolveSecretValue(companyId, manualSecretId!, "latest");
    expect(resolved).toBe(MANUAL_KEY_VALUE);

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const defaultLog = logs.find((l) => l.action === "secret.platform_default.bound");
    expect(defaultLog).toBeDefined();
    expect(defaultLog!.details).toMatchObject({
      secretId: "***REDACTED***",
      outcome: "reused",
    });
  });

  it("pre-insert name conflict against a concurrent manual create: loser catches 409 name conflict, rolls back savepoint, skips binding", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();
    const winnerDb = createDb(embeddedConnectionString);

    let manualSecretId: string | null = null;

    const loserAgent = await agentService(db).create(
      companyId,
      {
        name: "Hermes Pre-Insert Name Conflict Loser",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      {
        _testBeforeEnsureSecretCreate: async () => {
          // Concurrent manual create takes the default name with a different key
          const manual = await secretService(winnerDb).create(companyId, {
            name: "OPENAI_API_KEY (platform default)",
            key: "some_other_key",
            provider: "local_encrypted",
            value: "sk-manual-other-key-1234567890",
          });
          manualSecretId = manual.id;
        },
      },
    );

    expect(manualSecretId).toBeDefined();
    // Loser encountered pre-insert name conflict, savepoint rolled back, re-read winner, skipped binding
    expect((loserAgent.adapterConfig as Record<string, any>).env).toBeUndefined();

    const allSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(allSecrets).toHaveLength(1);
    expect(allSecrets[0].id).toBe(manualSecretId);

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const defaultLog = logs.find((l) => l.action === "secret.platform_default.skipped");
    expect(defaultLog).toBeDefined();
    expect(defaultLog!.details).toMatchObject({
      outcome: "skipped_name_conflict",
    });
  });

  it("non-hermes agents: untouched even when default is configured", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    const claudeAgent = await agentService(db).create(companyId, {
      name: "Claude Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    expect(claudeAgent.adapterConfig).toEqual({});
    const allSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(allSecrets).toHaveLength(0);
  });

  it("crypto failure: returns fixed 422, rolls back atomically with no agent, secret, or audit logged", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    // Temporarily point secrets master key file to an invalid path that cannot be read/written
    const prevKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = "/dev/null/impossible-path/master.key";

    try {
      await expect(
        agentService(db).create(companyId, {
          name: "Hermes Fail",
          role: "engineer",
          status: "active",
          adapterType: "hermes_local",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        }),
      ).rejects.toMatchObject({
        status: 422,
        message: "The platform default OpenAI key could not be stored; the agent was not created.",
        details: { code: "platform_default_secret_unavailable" },
      });

      // Verify atomic rollback
      const agentsInDb = await db.select().from(agents).where(eq(agents.companyId, companyId));
      expect(agentsInDb).toHaveLength(0);
      const secretsInDb = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
      expect(secretsInDb).toHaveLength(0);
      const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(logs).toHaveLength(0);
    } finally {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = prevKey;
    }
  });

  it("pending hire creation binds default secret, and subsequent update does not reseed", async () => {
    setupDefaultKey();
    const companyId = await seedCompany();

    const pendingAgent = await agentService(db).create(companyId, {
      name: "Hermes Pending Hire",
      role: "engineer",
      status: "pending_approval",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const cfg = pendingAgent.adapterConfig as Record<string, any>;
    expect(cfg.env.OPENAI_API_KEY).toBeDefined();
    const initialSecretId = cfg.env.OPENAI_API_KEY.secretId;

    // Updating the pending agent does not reseed or change secrets
    const updated = await agentService(db).update(
      pendingAgent.id,
      { budgetMonthlyCents: 5000 },
      { allowPendingApprovalConfigUpdate: true },
    );

    expect((updated!.adapterConfig as Record<string, any>).env.OPENAI_API_KEY.secretId).toBe(initialSecretId);
    const allSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(allSecrets).toHaveLength(1);
  });

  it("existing agent adapterType update: does NOT auto-bind default key (no legacy reseed)", async () => {
    // 1. Create agent initially with default off
    const companyId = await seedCompany();
    const legacyAgent = await agentService(db).create(companyId, {
      name: "Legacy Process Agent",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    expect(legacyAgent.adapterConfig).toEqual({});

    // 2. Enable platform default key
    setupDefaultKey();

    // 3. Update existing agent to hermes_local
    const updated = await agentService(db).update(legacyAgent.id, {
      adapterType: "hermes_local",
    });

    // Existing agent's adapterConfig is not mutated with default
    expect((updated!.adapterConfig as Record<string, any>).env).toBeUndefined();
    const allSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(allSecrets).toHaveLength(0);
  });

  it("fake key leak scan: no raw key leaked to console or logs during entire lifecycle", async () => {
    const leakSpy = vi.fn();
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: any[]) => { leakSpy(JSON.stringify(args)); origLog(...args); };
    console.warn = (...args: any[]) => { leakSpy(JSON.stringify(args)); origWarn(...args); };
    console.error = (...args: any[]) => { leakSpy(JSON.stringify(args)); origError(...args); };

    try {
      setupDefaultKey(FAKE_DEFAULT_KEY);
      const companyId = await seedCompany();
      await agentService(db).create(companyId, {
        name: "Hermes Leak Scan",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });

      for (const call of leakSpy.mock.calls) {
        expect(call[0]).not.toContain(FAKE_DEFAULT_KEY);
      }
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
  });
});
