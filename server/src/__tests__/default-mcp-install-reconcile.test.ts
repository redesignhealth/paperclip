import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV, __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, companySecretBindings, companySecretVersions, companySecrets, connectionGrants, connectionTokenIssuances, createDb, heartbeatRuns, toolAccessAuditEvents, toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolMcpGatewayTokens, toolMcpGateways, toolOauthStates, toolProfileBindings, toolProfileEntries, toolProfiles, toolRuntimeSlots, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import { runDefaultMcpSetupForAgent, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { sweepDefaultInstalls } from "../services/default-mcp-install-reconcile.js";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TEMPLATE_URL = "https://8.8.8.8/mcp";
const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

describeEmbeddedPostgres("comms-board is installed by default (installByDefault)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-install-reconcile-${randomUUID()}`);
  const envKeys = [FEATURE_ENV, COMMS_BOARD_MCP_URL_ENV, COMMS_BOARD_ADMIN_TOKEN_ENV, COMMS_BOARD_OWNERSHIP_API_URL_ENV, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-install-reconcile");
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
    await db.delete(toolAccessAuditEvents);
    await db.delete(connectionTokenIssuances);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolOauthStates);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(companySecretBindings);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
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

  async function seedCompany(status: "active" | "archived" = "active") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status,
    });
    return companyId;
  }

  async function seedOwner(companyId: string) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: "owner@redesignhealth.com", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  async function seedConnection(companyId: string, name: string, authKind: "oauth" | "api_key" = "oauth") {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${name} ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    return db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name,
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind,
        credentialPolicy: authKind === "api_key" ? "shared" : "per_user",
        status: "active",
        enabled: true,
        config: { url: TEMPLATE_URL },
        transportConfig: { url: TEMPLATE_URL },
        credentialRefs: [],
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedCommsTemplate(companyId: string) {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app comms ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const shared = await secretService(db).create(companyId, { name: `shared comms ${randomUUID()}`, key: `shared.${randomUUID()}`, provider: "local_encrypted", value: "org-shared-template-token" });
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name: "rh-comms-board",
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind: "api_key",
        credentialPolicy: "shared",
        status: "active",
        enabled: true,
        config: { url: TEMPLATE_URL },
        transportConfig: { url: TEMPLATE_URL },
        credentialRefs: [{ name: "credentials.authorization", secretId: shared.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }],
      })
      .returning()
      .then((rows) => rows[0]!);
    const [entry] = await db
      .insert(toolCatalogEntries)
      .values({ companyId, applicationId: application.id, connectionId: connection.id, name: "send_note", toolName: "send_note", versionHash: "v1" })
      .returning();
    const [profile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `app:${connection.id}`, name: "comms access", defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: connection.id } })
      .returning();
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "catalog_entry", effect: "include", connectionId: connection.id, catalogEntryId: entry!.id });
  }

  function configureDownstream() {
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
  }

  const enableFeature = () => { process.env[FEATURE_ENV] = "true"; };

  const rowOf = async (agentId: string) => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
  const stateOf = async (agentId: string) => readDefaultMcpState((await rowOf(agentId)).metadata)!;
  const outcomeOf = (report: { outcomes: Array<{ agentId: string }> }, agentId: string) => report.outcomes.find((o) => o.agentId === agentId) as Record<string, unknown> | undefined;
  const everything = async () =>
    JSON.stringify([await db.select().from(agents).orderBy(agents.id), await db.select().from(companySecrets).orderBy(companySecrets.id), await db.select().from(connectionGrants).orderBy(connectionGrants.id)]);

  const commsEntry = async (agentId: string) => (await stateOf(agentId)).entries["comms-board"]!;
  const installsFor = async (agentId: string) =>
    (await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agentId))).map((row) => row.connectionId);

  async function newAgent(companyId: string, ownerUserId: string | null) {
    const created = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    // Creation schedules the post-commit setup itself; settle it so tests never race a second run.
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  /** An agent as it exists today: ready comms-board entry, no marker, no install (what the 21 agents looked like before). */
  async function legacyReadyAgent(companyId: string, ownerId: string) {
    const agent = await newAgent(companyId, ownerId);
    const entry = await commsEntry(agent.id);
    expect(entry.setup.state).toBe("ready");
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id));
    await db.update(agents).set({
      metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, '{defaultMcp,entries,comms-board}', (${agents.metadata} #> '{defaultMcp,entries,comms-board}') - 'installOnReady', false), '{defaultMcp,entries,comms-board,enabled}', 'false'::jsonb, false)`,
    }).where(eq(agents.id, agent.id));
    return agent;
  }

  function ready() {
    enableFeature();
    configureDownstream();
    vi.stubGlobal("fetch", downstreamFetch());
  }

  it("a NEW agent gets its own dedicated connection installed when setup makes it, and never the org template", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    ready();
    const agent = await newAgent(companyId, ownerId);

    const entry = await commsEntry(agent.id);
    expect(entry.setup.state).toBe("ready");
    expect(entry).toMatchObject({ enabled: true, installOnReady: false });
    const [template] = await db.select().from(toolConnections).where(eq(toolConnections.name, "rh-comms-board"));
    const installs = await installsFor(agent.id);
    expect(installs).toEqual([entry.binding!.connectionId]);
    expect(installs).not.toContain(template!.id);
  });

  it("creation never fails and the marker waits when setup cannot run yet (no template, no owner)", async () => {
    const companyId = await seedCompany();
    enableFeature();
    const agent = await newAgent(companyId, null);
    const entry = await commsEntry(agent.id);
    expect(entry).toMatchObject({ installOnReady: true, enabled: false });
    expect(entry.setup.state).toBe("pending");
    expect(await installsFor(agent.id)).toEqual([]);
  });

  it("an existing ready agent with no install is installed once by the sweep, and the sweep is idempotent", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    ready();
    const agent = await legacyReadyAgent(companyId, ownerId);
    expect(await installsFor(agent.id)).toEqual([]);

    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 0, installed: 1 });
    const entry = await commsEntry(agent.id);
    expect(entry).toMatchObject({ enabled: true, installOnReady: false });
    expect(await installsFor(agent.id)).toEqual([entry.binding!.connectionId]);
    expect(JSON.stringify(await db.select().from(activityLog))).toContain("default-mcp-install-reconcile");

    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 0, installed: 0 });
    expect(await installsFor(agent.id)).toHaveLength(1);
  });

  it("an install the owner removed afterwards is not reinstalled", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    ready();
    const agent = await legacyReadyAgent(companyId, ownerId);
    await sweepDefaultInstalls(db);
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id));
    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 0, installed: 0 });
    expect(await installsFor(agent.id)).toEqual([]);
  });

  it("an owner_required (pending) agent is only marked, stays blocked, and is installed when it later becomes ready", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    ready();
    const agent = await newAgent(companyId, null);
    expect((await commsEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "owner_required" });
    // An entry that predates the marker.
    await db.update(agents).set({
      metadata: sql`jsonb_set(${agents.metadata}, '{defaultMcp,entries,comms-board}', (${agents.metadata} #> '{defaultMcp,entries,comms-board}') - 'installOnReady', false)`,
    }).where(eq(agents.id, agent.id));

    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 1, installed: 0 });
    expect(await installsFor(agent.id)).toEqual([]);
    expect((await commsEntry(agent.id)).installOnReady).toBe(true);

    await db.update(agents).set({
      metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, '{defaultMcp,entries,comms-board,ownerUserId}', to_jsonb(${ownerId}::text), true), '{defaultMcp,entries,comms-board,setup,nextAttemptAt}', to_jsonb(${new Date(0).toISOString()}::text), true)`,
    }).where(eq(agents.id, agent.id));
    await runDefaultMcpSetupForAgent({ db }, { companyId, agentId: agent.id });
    const entry = await commsEntry(agent.id);
    expect(entry.setup.state).toBe("ready");
    expect(await installsFor(agent.id)).toEqual([entry.binding!.connectionId]);
  });

  it("a ready entry whose wiring is broken is not installed", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    ready();
    const agent = await legacyReadyAgent(companyId, ownerId);
    await db.delete(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id));
    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 0, installed: 0 });
    expect(await installsFor(agent.id)).toEqual([]);
  });

  it("does nothing with the flag off, for terminated agents, archived companies, or out-of-scope companies", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    ready();
    const agent = await legacyReadyAgent(companyId, ownerId);

    delete process.env[FEATURE_ENV];
    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 0, installed: 0 });
    enableFeature();

    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agent.id));
    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 0, installed: 0 });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));

    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 0, installed: 0 });
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, companyId));

    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: randomUUID() } as NodeJS.ProcessEnv);
    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 0, installed: 0 });
    expect(await installsFor(agent.id)).toEqual([]);

    // A paused agent in scope is installed (pausing does not change what it may call).
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
    expect(await sweepDefaultInstalls(db)).toEqual({ marked: 0, installed: 1 });
  });
});
