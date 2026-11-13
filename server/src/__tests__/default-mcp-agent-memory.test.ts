import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { DEFAULT_MCP_SPEC, readDefaultMcpState } from "../services/default-mcp-spec.js";
import { runDefaultMcpSetupForAgent, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import {
  AGENT_MEMORY_ENABLED_ENV,
  AGENT_MEMORY_PROXY_ENV,
  AGENT_MEMORY_URL_ENV,
  agentMemoryEligibleForNewAgent,
  resolveAgentMemoryConfig,
} from "../services/default-mcp-agent-memory.js";
import {
  AGENT_MEMORY_TOKEN_EXPIRES_IN_DAYS,
  AGENT_MEMORY_TOKEN_SCOPES,
  COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS,
  COMMS_BOARD_TOKEN_SCOPES,
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  composeAgentMemorySub,
  mintAgentMemoryCredential,
  mintCommsBoardCredential,
} from "../services/comms-board-provisioner-client.js";
import {
  BOARD_ADMIN_TOKEN,
  BOARD_TOKEN,
  BOARD_URL,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  clearBootProvisionerSnapshot,
  clientConfig,
  downstreamFetch,
  installBootProvisionerSnapshot,
  ownershipResponse,
} from "./helpers/comms-board-downstream.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";
const MEMORY_URL = "https://rh-memory.example.test";
const MEMORY_PROXY = "http://127.0.0.1:1055";
const AGENT_ID = "0f3c7a52-8d41-4c0e-9f43-1a2b3c4d5e6f";

describe("agent memory config", () => {
  const on = { [AGENT_MEMORY_ENABLED_ENV]: "true", [AGENT_MEMORY_URL_ENV]: MEMORY_URL };

  it("is off unless explicitly enabled with a URL", () => {
    expect(resolveAgentMemoryConfig({})).toEqual({ ok: false, reason: "provisioner_not_configured" });
    expect(resolveAgentMemoryConfig({ [AGENT_MEMORY_URL_ENV]: MEMORY_URL })).toEqual({ ok: false, reason: "provisioner_not_configured" });
    expect(resolveAgentMemoryConfig({ [AGENT_MEMORY_ENABLED_ENV]: "true" })).toEqual({ ok: false, reason: "provisioner_not_configured" });
    expect(resolveAgentMemoryConfig({ ...on, [AGENT_MEMORY_ENABLED_ENV]: "yes" })).toEqual({ ok: false, reason: "provisioner_not_configured" });
  });

  it("accepts https and loopback http, trims the trailing slash, and carries an optional proxy", () => {
    expect(resolveAgentMemoryConfig({ ...on, [AGENT_MEMORY_URL_ENV]: `${MEMORY_URL}/` })).toEqual({ ok: true, config: { url: MEMORY_URL, proxy: null } });
    expect(resolveAgentMemoryConfig({ ...on, [AGENT_MEMORY_URL_ENV]: "http://127.0.0.1:8080" })).toMatchObject({ ok: true });
    expect(resolveAgentMemoryConfig({ ...on, [AGENT_MEMORY_PROXY_ENV]: MEMORY_PROXY })).toEqual({ ok: true, config: { url: MEMORY_URL, proxy: MEMORY_PROXY } });
  });

  it.each([
    ["plain http to a remote host", "http://memory.example.test"],
    ["userinfo", "https://user:pass@memory.example.test"],
    ["query string", "https://memory.example.test?token=x"],
    ["fragment", "https://memory.example.test#x"],
    ["not a URL", "memory"],
  ])("rejects a URL with %s", (_label, url) => {
    expect(resolveAgentMemoryConfig({ ...on, [AGENT_MEMORY_URL_ENV]: url })).toEqual({ ok: false, reason: "provisioner_config_invalid" });
  });

  it.each(["ftp://127.0.0.1:1055", "http://user:pw@127.0.0.1:1055", "http://127.0.0.1:1055/path", "127.0.0.1:1055"])(
    "rejects proxy %s",
    (proxy) => {
      expect(resolveAgentMemoryConfig({ ...on, [AGENT_MEMORY_PROXY_ENV]: proxy })).toEqual({ ok: false, reason: "provisioner_config_invalid" });
    },
  );

  it("only Hermes local agents are eligible, and only when configured", () => {
    expect(agentMemoryEligibleForNewAgent("hermes_local", on)).toBe(true);
    expect(agentMemoryEligibleForNewAgent("hermes_gateway", on)).toBe(false);
    expect(agentMemoryEligibleForNewAgent("claude_local", on)).toBe(false);
    expect(agentMemoryEligibleForNewAgent("hermes_local", {})).toBe(false);
  });

  it("the spec entry is a new-agents-only managed hook entry that is never installed or enabled by default", () => {
    const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "agent-memory");
    expect(entry).toMatchObject({ setupHook: "agent_memory", newAgentsOnly: true, defaultEnabled: false });
    expect(entry?.installByDefault).toBeUndefined();
  });
});

describe("memory mint purpose", () => {
  it("memory credentials carry memory scopes only, a 90-day expiry and the agent-memory sub", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return ownershipResponse(body.sub, { owner_email: "owner@redesignhealth.com" });
    });
    const minted = await mintAgentMemoryCredential(clientConfig, { agentId: AGENT_ID.toUpperCase(), ownerEmail: "owner@redesignhealth.com" }, fetchImpl);
    expect(minted.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${OWNERSHIP_URL}/agents`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ sub: `agent-memory-${AGENT_ID}`, scopes: ["memory:read", "memory:write"], expires_in_days: 90 });
    expect(AGENT_MEMORY_TOKEN_SCOPES).toEqual(["memory:read", "memory:write"]);
    expect(AGENT_MEMORY_TOKEN_EXPIRES_IN_DAYS).toBe(90);
  });

  it("comms bot credentials keep their scopes and 365-day expiry", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return ownershipResponse(body.sub, { owner_email: "owner@redesignhealth.com" });
    });
    await mintCommsBoardCredential(clientConfig, { baseSub: "paperclip-agent-x", ownerEmail: "owner@redesignhealth.com" }, fetchImpl);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.scopes).toEqual([...COMMS_BOARD_TOKEN_SCOPES]);
    expect(body.expires_in_days).toBe(COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS);
    expect(COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS).toBe(365);
  });

  it("refuses a non-UUID agent id before any call", async () => {
    const fetchImpl = vi.fn();
    expect(composeAgentMemorySub("not-a-uuid")).toBeNull();
    expect(await mintAgentMemoryCredential(clientConfig, { agentId: "not-a-uuid", ownerEmail: "o@x.test" }, fetchImpl)).toEqual({ ok: false, reason: "invalid_subject" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describeEmbeddedPostgres("agent_memory setup hook", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-memory-${randomUUID()}`);
  const envKeys = [
    FEATURE_ENV,
    AGENT_MEMORY_ENABLED_ENV,
    AGENT_MEMORY_URL_ENV,
    AGENT_MEMORY_PROXY_ENV,
    COMMS_BOARD_MCP_URL_ENV,
    COMMS_BOARD_ADMIN_TOKEN_ENV,
    COMMS_BOARD_OWNERSHIP_API_URL_ENV,
    COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  ];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-memory-hook");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(principalPermissionGrants);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedOwner(companyId: string, email = "owner@redesignhealth.com") {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  function enable(opts: { proxy?: boolean; provisioner?: boolean } = {}) {
    process.env[FEATURE_ENV] = "true";
    process.env[AGENT_MEMORY_ENABLED_ENV] = "true";
    process.env[AGENT_MEMORY_URL_ENV] = MEMORY_URL;
    if (opts.proxy !== false) process.env[AGENT_MEMORY_PROXY_ENV] = MEMORY_PROXY;
    if (opts.provisioner !== false) {
      installBootProvisionerSnapshot({
        [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
        [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
        [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
        [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
      });
    }
  }

  async function createAgent(
    companyId: string,
    ownerUserId: string | null,
    extra: Record<string, unknown> = {},
  ) {
    const created = await agentService(db).create(
      companyId,
      {
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: { env: { KEEP_ME: "yes" }, model: "some-model" },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
        ...extra,
      },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  const rowOf = (agentId: string) => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
  const memoryEntryOf = async (agentId: string) => readDefaultMcpState((await rowOf(agentId)).metadata)?.entries["agent-memory"];
  const secretsFor = (companyId: string, agentId: string) =>
    db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId)).then((rows) => rows.filter((row) => row.key === `agent_memory.${agentId}`));

  it("new Hermes agent: mints, stores the secret, attaches the mem0 settings and turns runtime memory off", async () => {
    enable();
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, ownerId);

    const memoryMints = fetchMock.calls.mint.filter((call) => call.sub.startsWith("agent-memory-"));
    expect(memoryMints).toEqual([{ sub: `agent-memory-${agent.id}`, scopes: ["memory:read", "memory:write"], expires: 90 }]);

    const entry = await memoryEntryOf(agent.id);
    expect(entry?.setup.state).toBe("ready");
    expect(entry?.binding?.secretId).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(BOARD_TOKEN);

    const [secret] = await secretsFor(companyId, agent.id);
    expect(secret?.id).toBe(entry?.binding?.secretId);
    expect(await secretService(db).resolveSecretValue(companyId, secret!.id, "latest")).toBe(BOARD_TOKEN);

    const config = (await rowOf(agent.id)).adapterConfig as Record<string, any>;
    expect(config.memoryProvider).toBe("mem0");
    expect(config.runtimeMemory).toBe(false);
    expect(config.model).toBe("some-model");
    expect(config.env).toEqual({
      KEEP_ME: { type: "plain", value: "yes" },
      MEM0_API_KEY: { type: "secret_ref", secretId: secret!.id, version: "latest" },
      MEM0_HOST: { type: "plain", value: MEMORY_URL },
      MEM0_PROXY: { type: "plain", value: MEMORY_PROXY },
      MEM0_USER_ID: { type: "plain", value: agent.id },
    });
    expect(JSON.stringify(config)).not.toContain(BOARD_TOKEN);

    // The secret reference resolves at run time only through its binding row.
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, agent.id));
    expect(bindings.map((row) => ({ path: row.configPath, secretId: row.secretId, target: row.targetType }))).toEqual([
      { path: "env.MEM0_API_KEY", secretId: secret!.id, target: "agent" },
    ]);
    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      (await rowOf(agent.id)).adapterConfig as Record<string, unknown>,
      { consumerType: "agent", consumerId: agent.id },
      { adapterType: "hermes_local" },
    );
    expect((resolved.config.env as Record<string, unknown>).MEM0_API_KEY).toBe(BOARD_TOKEN);
  });

  it("omits MEM0_PROXY when no proxy is configured", async () => {
    enable({ proxy: false });
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    vi.stubGlobal("fetch", downstreamFetch());
    const agent = await createAgent(companyId, ownerId);
    const config = (await rowOf(agent.id)).adapterConfig as Record<string, any>;
    expect(config.env.MEM0_PROXY).toBeUndefined();
    expect(config.env.MEM0_HOST).toEqual({ type: "plain", value: MEMORY_URL });
  });

  it("is retry-safe: a second setup run neither re-mints nor duplicates the secret, and replaying the stage is idempotent", async () => {
    enable();
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, ownerId);
    const before = (await rowOf(agent.id)).adapterConfig;
    const mintsBefore = fetchMock.calls.mint.length;

    await runDefaultMcpSetupForAgent({ db }, { companyId, agentId: agent.id });

    expect(fetchMock.calls.mint.length).toBe(mintsBefore);
    expect(await secretsFor(companyId, agent.id)).toHaveLength(1);
    expect((await rowOf(agent.id)).adapterConfig).toEqual(before);
  });

  it("an unknown mint outcome is terminal and is never re-minted", async () => {
    enable();
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const fetchMock = downstreamFetch({
      mint: (sub) => (sub.startsWith("agent-memory-") ? ownershipResponse(sub, {}, 502) : ownershipResponse(sub)),
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, ownerId);
    expect(await memoryEntryOf(agent.id)).toMatchObject({ setup: { state: "error", reason: "mint_unknown" } });
    expect(await secretsFor(companyId, agent.id)).toHaveLength(0);
    const mints = fetchMock.calls.mint.length;

    await runDefaultMcpSetupForAgent({ db, now: () => new Date(Date.now() + 3 * 3_600_000) }, { companyId, agentId: agent.id });
    expect(fetchMock.calls.mint.length).toBe(mints);
    const config = (await rowOf(agent.id)).adapterConfig as Record<string, any>;
    expect(config.memoryProvider).toBeUndefined();
    expect(config.runtimeMemory).toBeUndefined();
  });

  it("a registry conflict is terminal and leaves the agent config untouched", async () => {
    enable();
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    vi.stubGlobal("fetch", downstreamFetch({ mint: (sub) => ownershipResponse(sub, {}, sub.startsWith("agent-memory-") ? 409 : 201) }));
    const agent = await createAgent(companyId, ownerId);
    expect(await memoryEntryOf(agent.id)).toMatchObject({ setup: { state: "error", reason: "ownership_conflict" } });
    expect(((await rowOf(agent.id)).adapterConfig as Record<string, unknown>).memoryProvider).toBeUndefined();
  });

  it("waits for an owner and mints nothing without one", async () => {
    enable();
    const companyId = await seedCompany();
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, null);
    expect(await memoryEntryOf(agent.id)).toMatchObject({ setup: { state: "pending", reason: "owner_required" } });
    expect(fetchMock.calls.mint.filter((call) => call.sub.startsWith("agent-memory-"))).toHaveLength(0);
  });

  it("waits, with no external call, when the registry settings are missing", async () => {
    enable({ provisioner: false });
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, ownerId);
    expect(await memoryEntryOf(agent.id)).toMatchObject({ setup: { state: "pending", reason: "provisioner_not_configured" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is off by default: no entry, no mint, config untouched", async () => {
    process.env[FEATURE_ENV] = "true";
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, ownerId);
    expect(await memoryEntryOf(agent.id)).toBeUndefined();
    expect(fetchMock.calls.mint.filter((call) => call.sub.startsWith("agent-memory-"))).toHaveLength(0);
    expect(((await rowOf(agent.id)).adapterConfig as Record<string, unknown>).memoryProvider).toBeUndefined();
  });

  it("non-Hermes agents get no entry and no mint", async () => {
    enable();
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, ownerId, { adapterType: "process", adapterConfig: {} });
    expect(await memoryEntryOf(agent.id)).toBeUndefined();
    expect(fetchMock.calls.mint.filter((call) => call.sub.startsWith("agent-memory-"))).toHaveLength(0);
  });

  it("an existing agent is never provisioned when the flag is turned on later", async () => {
    process.env[FEATURE_ENV] = "true";
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    vi.stubGlobal("fetch", downstreamFetch());
    const agent = await createAgent(companyId, ownerId);
    enable();
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    await runDefaultMcpSetupForAgent({ db }, { companyId, agentId: agent.id });
    expect(await memoryEntryOf(agent.id)).toBeUndefined();
    expect(fetchMock.calls.mint.filter((call) => call.sub.startsWith("agent-memory-"))).toHaveLength(0);
  });

  it("never logs the token or the stored secret", async () => {
    enable();
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    vi.stubGlobal("fetch", downstreamFetch());
    const logged: string[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      }) as never);
    }
    const agent = await createAgent(companyId, ownerId);
    expect(await memoryEntryOf(agent.id)).toMatchObject({ setup: { state: "ready" } });
    expect(logged.join("\n")).not.toContain(BOARD_TOKEN);
  });

  it("an operator-revoked (disabled) secret is never re-minted or revived", async () => {
    enable();
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, ownerId);
    const [secret] = await secretsFor(companyId, agent.id);
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, secret!.id));
    await db.execute(sql`update ${agents} set metadata = jsonb_set(metadata, '{defaultMcp,entries,agent-memory,setup}', (metadata #> '{defaultMcp,entries,agent-memory,setup}') || '{"state":"pending","nextAttemptAt":null}'::jsonb) where id = ${agent.id}`);
    const mints = fetchMock.calls.mint.length;
    await runDefaultMcpSetupForAgent({ db, now: () => new Date(Date.now() + 3_600_000) }, { companyId, agentId: agent.id });
    expect(fetchMock.calls.mint.length).toBe(mints);
    expect(await memoryEntryOf(agent.id)).toMatchObject({ setup: { state: "error", reason: "secret_unavailable" } });
  });
});
