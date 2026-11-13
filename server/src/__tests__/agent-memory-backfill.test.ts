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
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { MISSING_ENTRY_CONFIRMATION, addMissingDefaultMcpEntries } from "../services/default-mcp-missing-entry-enrollment.js";
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

describeEmbeddedPostgres("agent memory backfill", () => {
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
  const mintCalls = (fetchMock: ReturnType<typeof downstreamFetch>) => fetchMock.calls.mint.filter((call) => call.sub.startsWith("agent-memory-"));

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

});
