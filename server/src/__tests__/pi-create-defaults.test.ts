import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog, agents, companies, companySecretBindings, companySecretProviderConfigs,
  companySecretVersions, companySecrets, createDb, principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import {
  PI_DEFAULT_ROUTER_MODEL, needsPlatformDefaultRouterKeyForPi, reconcilePiAgentsRouterKey,
} from "../services/pi-create-defaults.js";
import {
  captureAndScrubPlatformDefaultRouterKey, PAPERCLIP_DEFAULT_ROUTER_API_KEY,
  __resetForTests as resetRouterKey,
} from "../secrets/platform-default-router-key.js";

const KEY = "rr-test-pi-router-key-for-testing-only-1234567890";

describe("needsPlatformDefaultRouterKeyForPi", () => {
  const cases: Array<[string, string, unknown, boolean, boolean]> = [
    ["pi, empty config", "pi_local", {}, true, true],
    ["pi, non-object config", "pi_local", null, true, true],
    ["pi, blank model", "pi_local", { model: "  " }, true, true],
    ["pi, ramp-router model", "pi_local", { model: "ramp-router/gpt-6-luna" }, true, true],
    ["pi, anthropic router model", "pi_local", { model: PI_DEFAULT_ROUTER_MODEL }, true, true],
    ["pi, other model", "pi_local", { model: "openai/gpt-5.4-mini" }, true, false],
    ["pi, key present", "pi_local", { env: { RAMP_ROUTER_API_KEY: { type: "plain", value: "" } } }, true, false],
    ["pi, other env ok", "pi_local", { env: { FOO: "x" } }, true, true],
    ["pi, env not a record", "pi_local", { env: "x" }, true, false],
    ["no captured key", "pi_local", {}, false, false],
    ["hermes", "hermes_local", {}, true, false],
  ];
  it.each(cases)("%s", (_n, type, cfg, captured, want) => {
    expect(needsPlatformDefaultRouterKeyForPi(type, cfg, captured)).toBe(want);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("pi_local platform default Ramp Router key", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const prevSecretsFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmp = path.join(os.tmpdir(), `paperclip-pi-defaults-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmp, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmp, "secrets-file");
    const started = await startEmbeddedPostgresTestDatabase("pi-create-defaults");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);
  beforeEach(() => {
    resetRouterKey();
    captureAndScrubPlatformDefaultRouterKey({ [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: KEY });
  });
  afterEach(async () => {
    resetRouterKey();
    for (const t of [activityLog, companySecretBindings, companySecretVersions, companySecrets,
      companySecretProviderConfigs, agents, principalPermissionGrants, companies]) await db.delete(t);
  });
  afterAll(async () => {
    await stopDb?.();
    if (prevSecretsFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = prevSecretsFile;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id, name: `C-${id.slice(0, 8)}`, issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }
  const pi = (companyId: string, adapterConfig: Record<string, unknown> = {}) =>
    agentService(db).create(companyId, {
      name: `Pi ${randomUUID().slice(0, 6)}`, role: "engineer", status: "active",
      adapterType: "pi_local", adapterConfig, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null,
    });
  const configOf = async (id: string) =>
    (await db.select().from(agents).where(eq(agents.id, id)))[0]!.adapterConfig as Record<string, any>;

  it("create binds secret_ref and default model; value never persisted", async () => {
    const companyId = await seedCompany();
    const agent = await pi(companyId);
    const cfg = agent.adapterConfig as Record<string, any>;
    expect(cfg.model).toBe(PI_DEFAULT_ROUTER_MODEL);
    expect(cfg.env.RAMP_ROUTER_API_KEY).toMatchObject({ type: "secret_ref", version: "latest" });
    expect(JSON.stringify(await configOf(agent.id))).not.toContain(KEY);
    expect(JSON.stringify(await db.select().from(activityLog))).not.toContain(KEY);
  });

  it("explicit model and explicit key are untouched", async () => {
    const companyId = await seedCompany();
    const a = await pi(companyId, { model: "openai/gpt-5.4-mini" });
    expect((a.adapterConfig as any).model).toBe("openai/gpt-5.4-mini");
    expect((a.adapterConfig as any).env).toBeUndefined();
    const b = await pi(companyId, { env: { RAMP_ROUTER_API_KEY: { type: "plain", value: "mine" } } });
    expect((b.adapterConfig as any).env.RAMP_ROUTER_API_KEY).toEqual({ type: "plain", value: "mine" });
    expect((b.adapterConfig as any).model ?? "").toBe("");
  });

  it("reconcile fixes existing agents idempotently, per company, without overwriting", async () => {
    const c1 = await seedCompany();
    const c2 = await seedCompany();
    resetRouterKey(); // legacy agents created before the key was captured
    const legacy1 = await pi(c1);
    const legacy2 = await pi(c2, { model: "ramp-router/gpt-6-luna" });
    const explicit = await pi(c1, { model: "openai/gpt-5.4-mini" });
    expect((legacy1.adapterConfig as any).env).toBeUndefined();

    expect(await reconcilePiAgentsRouterKey(db, KEY)).toEqual({ scanned: 3, bound: 2, failed: 0 });
    const cfg1 = await configOf(legacy1.id);
    const cfg2 = await configOf(legacy2.id);
    expect(cfg1.model).toBe(PI_DEFAULT_ROUTER_MODEL);
    expect(cfg2.model).toBe("ramp-router/gpt-6-luna");
    const rows = await db.select().from(companySecrets);
    expect(rows.find((r) => r.id === cfg1.env.RAMP_ROUTER_API_KEY.secretId)?.companyId).toBe(c1);
    expect(rows.find((r) => r.id === cfg2.env.RAMP_ROUTER_API_KEY.secretId)?.companyId).toBe(c2);
    expect(rows).toHaveLength(2);
    expect((await configOf(explicit.id)).env).toBeUndefined();
    expect(JSON.stringify([cfg1, cfg2])).not.toContain(KEY);

    const bindingsFor = (id: string) =>
      db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, id));
    for (const [id, cfg] of [[legacy1.id, cfg1], [legacy2.id, cfg2]] as const) {
      const b = await bindingsFor(id);
      expect(b).toHaveLength(1);
      expect(b[0]).toMatchObject({ secretId: cfg.env.RAMP_ROUTER_API_KEY.secretId, configPath: "env.RAMP_ROUTER_API_KEY" });
    }
    expect(await bindingsFor(explicit.id)).toHaveLength(0);

    expect(await reconcilePiAgentsRouterKey(db, KEY)).toEqual({ scanned: 3, bound: 0, failed: 0 });
    expect(await bindingsFor(legacy1.id)).toHaveLength(1);
    expect(await bindingsFor(legacy2.id)).toHaveLength(1);
    expect(await reconcilePiAgentsRouterKey(db, null)).toEqual({ scanned: 0, bound: 0, failed: 0 });
  });
});
