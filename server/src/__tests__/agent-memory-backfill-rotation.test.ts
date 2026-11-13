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
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { MISSING_ENTRY_CONFIRMATION, addMissingDefaultMcpEntries } from "../services/default-mcp-missing-entry-enrollment.js";
import { AGENT_MEMORY_ROTATION_RETRY_AFTER_MS, AGENT_MEMORY_ROTATION_WINDOW_DAYS, rotateAgentMemoryCredentials, sweepAgentMemoryRotation } from "../services/agent-memory-rotation.js";
import {
  AGENT_MEMORY_BACKFILL_ENABLED_ENV,
  AGENT_MEMORY_ENABLED_ENV,
  AGENT_MEMORY_PROXY_ENV,
  AGENT_MEMORY_URL_ENV,
} from "../services/default-mcp-agent-memory.js";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
} from "../services/comms-board-provisioner-client.js";
import {
  BOARD_ADMIN_TOKEN,
  BOARD_TOKEN,
  BOARD_URL,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  clearBootProvisionerSnapshot,
  downstreamFetch,
  installBootProvisionerSnapshot,
} from "./helpers/comms-board-downstream.js";

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";
const MEMORY_URL = "https://rh-memory.example.test";
const MEMORY_PROXY = "http://127.0.0.1:1055";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent memory backfill and rotation", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-memory-ops-${randomUUID()}`);
  const envKeys = [
    FEATURE_ENV,
    AGENT_MEMORY_ENABLED_ENV,
    AGENT_MEMORY_BACKFILL_ENABLED_ENV,
    AGENT_MEMORY_URL_ENV,
    AGENT_MEMORY_PROXY_ENV,
    COMMS_BOARD_MCP_URL_ENV,
    COMMS_BOARD_ADMIN_TOKEN_ENV,
    COMMS_BOARD_OWNERSHIP_API_URL_ENV,
    COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  ];
  const ROTATED_TOKEN = "rotated-memory-token-SECRET-value-9876543210";

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-memory-ops");
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
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

  function configureProvisioner() {
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
  }

  function enableMemory(opts: { backfill?: boolean } = {}) {
    process.env[FEATURE_ENV] = "true";
    process.env[AGENT_MEMORY_ENABLED_ENV] = "true";
    process.env[AGENT_MEMORY_URL_ENV] = MEMORY_URL;
    process.env[AGENT_MEMORY_PROXY_ENV] = MEMORY_PROXY;
    if (opts.backfill) process.env[AGENT_MEMORY_BACKFILL_ENABLED_ENV] = "true";
    configureProvisioner();
  }

  async function createAgent(companyId: string, ownerUserId: string | null, extra: Record<string, unknown> = {}) {
    const created = await agentService(db).create(
      companyId,
      {
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: { env: { KEEP_ME: "yes" } },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
        ...extra,
      },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    if (ownerUserId) {
      await db.insert(activityLog).values({ companyId, actorType: "user", actorId: ownerUserId, action: "agent.created", entityType: "agent", entityId: created.id });
    }
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  const rowOf = (agentId: string) => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
  const memoryEntryOf = async (agentId: string) => readDefaultMcpState((await rowOf(agentId)).metadata)?.entries["agent-memory"];
  const secretFor = async (companyId: string, agentId: string) =>
    (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).find((row) => row.key === `agent_memory.${agentId}`);
  const mintCalls = (fetchMock: ReturnType<typeof downstreamFetch>) => fetchMock.calls.mint.filter((call) => call.sub.startsWith("agent-memory-"));

  /** A fetch stub for the registry rotate route, recording what it saw. */
  function rotateFetch(respond: (sub: string) => Response | Promise<Response> = (sub) => rotateResponse(sub)) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      const sub = decodeURIComponent(url.slice(`${OWNERSHIP_URL}/agents/`.length, -"/rotate".length));
      return respond(sub);
    });
    return Object.assign(fn, { calls });
  }
  const rotateResponse = (sub: string, over: Record<string, unknown> = {}, status = 200) =>
    new Response(JSON.stringify({ sub, active: true, token: ROTATED_TOKEN, token_expires_at: "2027-06-01T00:00:00+00:00", ...over }), {
      status,
      headers: { "content-type": "application/json" },
    });

  /** Creates a new agent through the normal path (memory enabled), so its memory entry is ready. */
  async function readyAgent(companyId: string, ownerId: string) {
    enableMemory();
    vi.stubGlobal("fetch", downstreamFetch());
    const agent = await createAgent(companyId, ownerId);
    expect(await memoryEntryOf(agent.id)).toMatchObject({ setup: { state: "ready" } });
    return agent;
  }

  async function setExpiry(agentId: string, iso: string) {
    await db.execute(sql`update ${agents} set metadata = jsonb_set(metadata, '{defaultMcp,entries,agent-memory,binding,tokenExpiresAt}', to_jsonb(${iso}::text)) where id = ${agentId}`);
  }

  // ---- backfill ----------------------------------------------------------------------------

  async function existingAgentWithoutMemory(companyId: string, ownerId: string, extra: Record<string, unknown> = {}) {
    // Created while agent memory was off: it holds a default-MCP state but no agent-memory entry.
    process.env[FEATURE_ENV] = "true";
    vi.stubGlobal("fetch", downstreamFetch());
    const agent = await createAgent(companyId, ownerId, extra);
    expect(await memoryEntryOf(agent.id)).toBeUndefined();
    expect(readDefaultMcpState((await rowOf(agent.id)).metadata)).not.toBeNull();
    return agent;
  }

  it("without the backfill flag the missing-entry job never adds agent-memory", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await existingAgentWithoutMemory(companyId, ownerId);
    enableMemory(); // memory on for new agents, but no backfill flag
    const report = await addMissingDefaultMcpEntries(db, { companyId, dryRun: false, confirm: MISSING_ENTRY_CONFIRMATION, keys: ["agent-memory"] });
    expect(report.outcomes.find((o) => o.agentId === agent.id)).toMatchObject({ result: "skipped", reason: "nothing_missing" });
    expect(await memoryEntryOf(agent.id)).toBeUndefined();
  });

  it("with the backfill flag a dry run only lists, and a real run mints, stores and attaches for the profiled agent only", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const hermes = await existingAgentWithoutMemory(companyId, ownerId);
    const other = await existingAgentWithoutMemory(companyId, ownerId, { adapterType: "process", adapterConfig: {} });
    enableMemory({ backfill: true });
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const dry = await addMissingDefaultMcpEntries(db, { companyId, keys: ["agent-memory"] });
    expect(dry.dryRun).toBe(true);
    expect(dry.outcomes.find((o) => o.agentId === hermes.id)).toMatchObject({ result: "would_add", keys: ["agent-memory"] });
    expect(dry.outcomes.find((o) => o.agentId === other.id)).toMatchObject({ result: "skipped", reason: "nothing_missing" });
    expect(await memoryEntryOf(hermes.id)).toBeUndefined();
    expect(mintCalls(fetchMock)).toHaveLength(0);

    const report = await addMissingDefaultMcpEntries(db, { companyId, dryRun: false, confirm: MISSING_ENTRY_CONFIRMATION, keys: ["agent-memory"] });
    await waitForScheduledDefaultMcpSetups();
    expect(report.outcomes.find((o) => o.agentId === hermes.id)).toMatchObject({ result: "added", keys: ["agent-memory"] });

    expect(await memoryEntryOf(hermes.id)).toMatchObject({ setup: { state: "ready" } });
    expect(mintCalls(fetchMock)).toEqual([{ sub: `agent-memory-${hermes.id}`, scopes: ["memory:read", "memory:write"], expires: 90 }]);
    const config = (await rowOf(hermes.id)).adapterConfig as Record<string, any>;
    expect(config.memoryProvider).toBe("mem0");
    expect(config.runtimeMemory).toBe(false);
    expect(Object.keys(config.env).sort()).toEqual(["KEEP_ME", "MEM0_API_KEY", "MEM0_HOST", "MEM0_PROXY", "MEM0_USER_ID"]);
    expect(await memoryEntryOf(other.id)).toBeUndefined();
    // `keys` restricted the run: no other missing entry was added.
    const entryKeys = Object.keys(readDefaultMcpState((await rowOf(hermes.id)).metadata)!.entries);
    expect(entryKeys).toContain("agent-memory");

    // Idempotent: a second real run changes nothing and mints nothing.
    const again = await addMissingDefaultMcpEntries(db, { companyId, dryRun: false, confirm: MISSING_ENTRY_CONFIRMATION, keys: ["agent-memory"] });
    expect(again.outcomes.find((o) => o.agentId === hermes.id)).toMatchObject({ result: "skipped", reason: "nothing_missing" });
    expect(mintCalls(fetchMock)).toHaveLength(1);
  });

  // ---- rotation ----------------------------------------------------------------------------

  it("rotates only agents whose token expires inside the window, writing a new secret version and the new expiry", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const due = await readyAgent(companyId, ownerId);
    const fresh = await readyAgent(companyId, ownerId);
    const now = new Date("2027-01-01T00:00:00.000Z");
    await setExpiry(due.id, new Date(now.getTime() + 3 * 86_400_000).toISOString());
    await setExpiry(fresh.id, new Date(now.getTime() + (AGENT_MEMORY_ROTATION_WINDOW_DAYS + 30) * 86_400_000).toISOString());
    const stub = rotateFetch();
    const before = await secretFor(companyId, due.id);

    const report = await rotateAgentMemoryCredentials(db, { fetchImpl: stub, now: () => now });

    expect(report.outcomes).toEqual([{ agentId: due.id, companyId, result: "rotated" }]);
    expect(stub.calls).toEqual([
      { url: `${OWNERSHIP_URL}/agents/agent-memory-${due.id}/rotate`, body: { scopes: ["memory:read", "memory:write"], expires_in_days: 90 } },
    ]);
    const after = await secretFor(companyId, due.id);
    expect(after!.id).toBe(before!.id);
    expect(after!.latestVersion).toBe(before!.latestVersion + 1);
    expect(await secretService(db).resolveSecretValue(companyId, after!.id, "latest")).toBe(ROTATED_TOKEN);
    expect((await memoryEntryOf(due.id))!.binding).toMatchObject({ tokenExpiresAt: "2027-06-01T00:00:00.000Z", rotation: null, secretId: after!.id });
    expect((await secretFor(companyId, fresh.id))!.latestVersion).toBe(1);
    expect(JSON.stringify(await rowOf(due.id))).not.toContain(ROTATED_TOKEN);

    // Not due any more: a second pass does nothing.
    const stub2 = rotateFetch();
    expect((await rotateAgentMemoryCredentials(db, { fetchImpl: stub2, now: () => now })).outcomes).toEqual([]);
    expect(stub2).not.toHaveBeenCalled();
  });

  it("a registry failure changes nothing and a later pass retries", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await readyAgent(companyId, ownerId);
    const now = new Date("2027-01-01T00:00:00.000Z");
    const expiry = new Date(now.getTime() + 86_400_000).toISOString();
    await setExpiry(agent.id, expiry);
    const failing = rotateFetch((sub) => rotateResponse(sub, {}, 502));
    const report = await rotateAgentMemoryCredentials(db, { fetchImpl: failing, now: () => now });
    expect(report.outcomes).toEqual([{ agentId: agent.id, companyId, result: "rotate_failed" }]);
    expect((await secretFor(companyId, agent.id))!.latestVersion).toBe(1);
    expect((await memoryEntryOf(agent.id))!.binding!.tokenExpiresAt).toBe(expiry);

    expect(((await memoryEntryOf(agent.id))!.binding as Record<string, any>).rotation).toMatchObject({ state: "failed", reason: "rotate_failed", tokenMinted: false });

    // Inside the back-off the agent is not tried again.
    const early = rotateFetch();
    expect((await rotateAgentMemoryCredentials(db, { fetchImpl: early, now: () => new Date(now.getTime() + 60_000) })).outcomes).toEqual([]);
    expect(early).not.toHaveBeenCalled();

    // After it, the next pass rotates and clears the marker.
    const ok = rotateFetch();
    const later = new Date(now.getTime() + AGENT_MEMORY_ROTATION_RETRY_AFTER_MS + 1000);
    expect((await rotateAgentMemoryCredentials(db, { fetchImpl: ok, now: () => later })).outcomes[0]).toMatchObject({ result: "rotated" });
    expect(((await memoryEntryOf(agent.id))!.binding as Record<string, any>).rotation).toBeNull();
  });

  it.each([{ token_expires_at: undefined }, { token_expires_at: "not a date" }])("a registry reply without a usable expiry stores nothing and keeps the metadata intact (%j)", async (over) => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await readyAgent(companyId, ownerId);
    const now = new Date("2027-01-01T00:00:00.000Z");
    const expiry = new Date(now.getTime() + 86_400_000).toISOString();
    await setExpiry(agent.id, expiry);
    const metadataBefore = (await rowOf(agent.id)).metadata as Record<string, any>;
    const report = await rotateAgentMemoryCredentials(db, { fetchImpl: rotateFetch((sub) => rotateResponse(sub, over)), now: () => now });
    expect(report.outcomes[0]).toMatchObject({ result: "rotate_failed" });
    const metadataAfter = (await rowOf(agent.id)).metadata as Record<string, any>;
    expect(metadataAfter).not.toBeNull();
    expect(Object.keys(metadataAfter.defaultMcp.entries)).toEqual(Object.keys(metadataBefore.defaultMcp.entries));
    expect(metadataAfter.defaultMcp.entries["agent-memory"].binding.tokenExpiresAt).toBe(expiry);
    expect((await secretFor(companyId, agent.id))!.latestVersion).toBe(1);
  });

  it.each([
    [404, "rotate_unknown_sub"],
    [409, "rotate_deactivated"],
    [403, "rotate_rejected"],
  ] as const)("registry %s is reported as %s and leaves the secret alone", async (status, result) => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await readyAgent(companyId, ownerId);
    const now = new Date("2027-01-01T00:00:00.000Z");
    await setExpiry(agent.id, new Date(now.getTime() + 86_400_000).toISOString());
    const report = await rotateAgentMemoryCredentials(db, { fetchImpl: rotateFetch((sub) => rotateResponse(sub, {}, status)), now: () => now });
    expect(report.outcomes[0]).toMatchObject({ result });
    expect((await secretFor(companyId, agent.id))!.latestVersion).toBe(1);
  });

  it("a concurrent secret change loses the version guard: a visible failure marker, old expiry kept, retried next pass", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await readyAgent(companyId, ownerId);
    const now = new Date("2027-01-01T00:00:00.000Z");
    const expiry = new Date(now.getTime() + 86_400_000).toISOString();
    await setExpiry(agent.id, expiry);
    const secret = (await secretFor(companyId, agent.id))!;
    // Another writer bumps the secret while the registry call is in flight.
    const racing = rotateFetch(async (sub) => {
      await secretService(db).rotate(secret.id, { value: "someone-elses-value-1234567890", expectedLatestVersion: secret.latestVersion }, { userId: ownerId });
      return rotateResponse(sub);
    });
    const report = await rotateAgentMemoryCredentials(db, { fetchImpl: racing, now: () => now });
    expect(report.outcomes[0]).toMatchObject({ result: "secret_write_failed" });
    const binding = (await memoryEntryOf(agent.id))!.binding as Record<string, any>;
    expect(binding.tokenExpiresAt).toBe(expiry);
    expect(binding.rotation).toMatchObject({ state: "failed", reason: "secret_write_failed", tokenMinted: true });
    expect(JSON.stringify(binding)).not.toContain(ROTATED_TOKEN);

    const retry = await rotateAgentMemoryCredentials(db, { fetchImpl: rotateFetch(), now: () => new Date(now.getTime() + AGENT_MEMORY_ROTATION_RETRY_AFTER_MS + 1000) });
    expect(retry.outcomes[0]).toMatchObject({ result: "rotated" });
    expect(((await memoryEntryOf(agent.id))!.binding as Record<string, any>).rotation).toBeNull();
  });

  it("a revoked secret is never rotated or revived", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await readyAgent(companyId, ownerId);
    const now = new Date("2027-01-01T00:00:00.000Z");
    await setExpiry(agent.id, new Date(now.getTime() + 86_400_000).toISOString());
    const secret = await secretFor(companyId, agent.id);
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, secret!.id));
    const stub = rotateFetch();
    const report = await rotateAgentMemoryCredentials(db, { fetchImpl: stub, now: () => now });
    expect(report.outcomes[0]).toMatchObject({ result: "skipped_secret_unavailable" });
    expect(stub).not.toHaveBeenCalled();
  });

  it("is a no-op unless agent memory and the registry are configured", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await readyAgent(companyId, ownerId);
    await setExpiry(agent.id, new Date(Date.now() + 86_400_000).toISOString());
    const stub = rotateFetch();

    delete process.env[AGENT_MEMORY_ENABLED_ENV];
    expect(await rotateAgentMemoryCredentials(db, { fetchImpl: stub })).toMatchObject({ blocked: "memory_not_configured", outcomes: [] });
    process.env[AGENT_MEMORY_ENABLED_ENV] = "true";
    clearBootProvisionerSnapshot();
    expect(await rotateAgentMemoryCredentials(db, { fetchImpl: stub })).toMatchObject({ blocked: "provisioner_not_configured", outcomes: [] });
    delete process.env[FEATURE_ENV];
    configureProvisioner();
    expect(await rotateAgentMemoryCredentials(db, { fetchImpl: stub })).toMatchObject({ blocked: "feature_flag_off", outcomes: [] });
    expect(stub).not.toHaveBeenCalled();
  });

  it("the sweep entry point rotates due agents and never logs the token", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await readyAgent(companyId, ownerId);
    await setExpiry(agent.id, new Date(Date.now() + 86_400_000).toISOString());
    const logged: string[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      }) as never);
    }
    expect(await sweepAgentMemoryRotation(db, { fetchImpl: rotateFetch() })).toBe(1);
    expect(logged.join("\n")).not.toContain(ROTATED_TOKEN);
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, agent.id));
    expect(JSON.stringify(activity)).not.toContain(ROTATED_TOKEN);
  });
});
