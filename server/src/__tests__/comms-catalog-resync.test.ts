import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  connectionGrants,
  connectionTokenIssuances,
  createDb,
  heartbeatRuns,
  toolAccessAuditEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolMcpGatewayTokens,
  toolMcpGateways,
  toolOauthStates,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import {
  COMMS_CATALOG_RESYNC_CONFIRMATION,
  CommsCatalogResyncConfirmationError,
  resyncCommsCatalogs,
} from "../services/comms-catalog-resync.js";
import {
  BOARD_ADMIN_TOKEN,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  clearBootProvisionerSnapshot,
  downstreamFetch,
  installBootProvisionerSnapshot,
} from "./helpers/comms-board-downstream.js";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
} from "../services/comms-board-provisioner-client.js";
import { BOARD_URL } from "./helpers/comms-board-downstream.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TEMPLATE_URL = "https://8.8.8.8/mcp";
const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

describeEmbeddedPostgres("comms-board catalog resync for existing agents", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-comms-resync-${randomUUID()}`);
  const envKeys = [FEATURE_ENV, COMMS_BOARD_MCP_URL_ENV, COMMS_BOARD_ADMIN_TOKEN_ENV, COMMS_BOARD_OWNERSHIP_API_URL_ENV, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("comms-catalog-resync");
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
    await db.delete(companies);
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
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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

  const TOOLS = [
    { name: "comms_whoami", status: "active" as const },
    { name: "proposals_submit", status: "active" as const },
    { name: "proposals_get", status: "active" as const },
    { name: "comms_admin_register", status: "disabled" as const },
  ];

  async function seedCommsTemplate(companyId: string) {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app comms ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const shared = await secretService(db).create(companyId, {
      name: `shared comms ${randomUUID()}`,
      key: `shared.${randomUUID()}`,
      provider: "local_encrypted",
      value: "org-shared-template-token",
    });
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
    const [profile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `app:${connection.id}`, name: "comms access", defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: connection.id } })
      .returning();
    for (const tool of TOOLS) {
      const [entry] = await db
        .insert(toolCatalogEntries)
        .values({ companyId, applicationId: application.id, connectionId: connection.id, name: tool.name, toolName: tool.name, versionHash: "v1", status: tool.status })
        .returning();
      if (tool.status === "active") {
        await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "catalog_entry", effect: "include", connectionId: connection.id, catalogEntryId: entry!.id });
      }
    }
    return connection;
  }

  function configureDownstream() {
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
  }

  /** A NEW agent through the real create + setup path: its token is minted at the current scope version. */
  async function readyAgent(companyId: string, ownerUserId: string) {
    process.env[FEATURE_ENV] = "true";
    configureDownstream();
    vi.stubGlobal("fetch", downstreamFetch());
    const created = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    vi.unstubAllGlobals();
    delete process.env[FEATURE_ENV];
    return created;
  }

  const rowOf = async (agentId: string) => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
  const entryOf = async (agentId: string) => readDefaultMcpState((await rowOf(agentId)).metadata)!.entries["comms-board"]!;
  const PROPOSALS = ["proposals_get", "proposals_submit"];

  /** Simulates a clone made while the allowlist was v1: proposals_* disabled and outside the clone's profile. */
  async function makeV1Clone(agentId: string) {
    const connectionId = (await entryOf(agentId)).binding!.connectionId!;
    const rows = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
    const ids = rows.filter((r) => PROPOSALS.includes(r.toolName)).map((r) => r.id);
    await db.update(toolCatalogEntries).set({ status: "disabled" }).where(inArray(toolCatalogEntries.id, ids));
    await db.delete(toolProfileEntries).where(inArray(toolProfileEntries.catalogEntryId, ids));
    return connectionId;
  }
  const cloneStatus = async (connectionId: string) =>
    Object.fromEntries((await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId))).map((r) => [r.toolName, r.status]));
  const cloneIncludes = async (connectionId: string) => {
    const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${connectionId}`));
    const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile!.id));
    const rows = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
    const byId = new Map(rows.map((r) => [r.id, r.toolName]));
    return entries.map((e) => byId.get(e.catalogEntryId!)).sort();
  };
  const run = (companyId: string, extra: Record<string, unknown> = {}) =>
    resyncCommsCatalogs(db, { companyId, dryRun: false, confirm: COMMS_CATALOG_RESYNC_CONFIRMATION, ...extra });
  const outcomeOf = (report: Awaited<ReturnType<typeof run>>, agentId: string) => report.outcomes.find((o) => o.agentId === agentId);

  async function legacyAgent() {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const template = await seedCommsTemplate(companyId);
    const agent = await readyAgent(companyId, ownerId);
    const connectionId = await makeV1Clone(agent.id);
    return { companyId, ownerId, template, agent, connectionId };
  }

  it("a census reports would_widen with the tool names and writes nothing", async () => {
    const { companyId, agent, connectionId } = await legacyAgent();
    const before = JSON.stringify([await cloneStatus(connectionId), await cloneIncludes(connectionId)]);
    const report = await resyncCommsCatalogs(db, { companyId });
    expect(report.dryRun).toBe(true);
    expect(outcomeOf(report, agent.id)).toEqual({ agentId: agent.id, companyId, result: "would_widen", tools: PROPOSALS });
    expect(JSON.stringify([await cloneStatus(connectionId), await cloneIncludes(connectionId)])).toBe(before);
  });

  it("a real run requires the exact confirmation string", async () => {
    const { companyId } = await legacyAgent();
    await expect(resyncCommsCatalogs(db, { companyId, dryRun: false })).rejects.toBeInstanceOf(CommsCatalogResyncConfirmationError);
    await expect(resyncCommsCatalogs(db, { companyId, dryRun: false, confirm: "yes" })).rejects.toBeInstanceOf(CommsCatalogResyncConfirmationError);
  });

  it("widens exactly the allowlisted tools, adds their profile includes, leaves other tools alone and creates no install", async () => {
    const { companyId, agent, connectionId } = await legacyAgent();
    expect(await cloneStatus(connectionId)).toMatchObject({ proposals_submit: "disabled", proposals_get: "disabled", comms_admin_register: "disabled", comms_whoami: "active" });
    expect(await cloneIncludes(connectionId)).toEqual(["comms_whoami"]);
    const installsBefore = (await db.select().from(toolConnectionInstalls)).length;

    const report = await run(companyId);
    expect(outcomeOf(report, agent.id)).toMatchObject({ result: "widened", tools: PROPOSALS });
    expect(await cloneStatus(connectionId)).toMatchObject({ proposals_submit: "active", proposals_get: "active", comms_admin_register: "disabled", comms_whoami: "active" });
    expect(await cloneIncludes(connectionId)).toEqual(["comms_whoami", "proposals_get", "proposals_submit"]);
    expect((await db.select().from(toolConnectionInstalls)).length).toBe(installsBefore);
    const [event] = await db.select().from(activityLog).where(eq(activityLog.action, "agent.default_mcp.comms_catalog_resynced"));
    expect(event).toMatchObject({ entityId: agent.id, actorId: "comms-catalog-resync" });
    expect(JSON.stringify(event!.details)).not.toMatch(/token|secret/i);

    // Idempotent.
    expect(outcomeOf(await run(companyId), agent.id)?.result).toBe("already_current");
    expect(outcomeOf(await resyncCommsCatalogs(db, { companyId }), agent.id)?.result).toBe("already_current");
  });

  it("only widens a tool whose template row is active (a quarantined template tool stays unusable on the clone)", async () => {
    const { companyId, agent, template, connectionId } = await legacyAgent();
    await db.update(toolCatalogEntries).set({ status: "quarantined" }).where(and(eq(toolCatalogEntries.connectionId, template.id), eq(toolCatalogEntries.toolName, "proposals_get")));
    const report = await run(companyId);
    expect(outcomeOf(report, agent.id)).toMatchObject({ result: "widened", tools: ["proposals_submit"] });
    expect(await cloneStatus(connectionId)).toMatchObject({ proposals_submit: "active", proposals_get: "disabled" });
  });

  it("never widens a tool outside the allowlist even if the template marks it active", async () => {
    const { companyId, agent, template, connectionId } = await legacyAgent();
    await db.update(toolCatalogEntries).set({ status: "active" }).where(and(eq(toolCatalogEntries.connectionId, template.id), eq(toolCatalogEntries.toolName, "comms_admin_register")));
    const report = await run(companyId);
    expect(outcomeOf(report, agent.id)).toMatchObject({ result: "widened", tools: PROPOSALS });
    expect((await cloneStatus(connectionId)).comms_admin_register).toBe("disabled");
    expect(await cloneIncludes(connectionId)).not.toContain("comms_admin_register");
  });

  it("skips (and changes nothing) when the template is unavailable", async () => {
    const { companyId, agent, template, connectionId } = await legacyAgent();
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, template.id));
    const real = outcomeOf(await run(companyId), agent.id);
    expect(real?.result).toBe("skipped_template_unavailable");
    expect(outcomeOf(await resyncCommsCatalogs(db, { companyId }), agent.id)?.result).toBe("skipped_template_unavailable");
    expect(await cloneStatus(connectionId)).toMatchObject({ proposals_submit: "disabled", proposals_get: "disabled" });
  });

  it("skips terminated agents, archived companies, agents without a ready dedicated comms entry and broken wiring", async () => {
    const { companyId, ownerId, agent, connectionId } = await legacyAgent();
    const terminated = await readyAgent(companyId, ownerId);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, terminated.id));
    const bare = await agentService(db).create(
      companyId,
      { name: "bare", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId: ownerId } },
    );
    await waitForScheduledDefaultMcpSetups();
    const report = await run(companyId);
    expect(outcomeOf(report, terminated.id)?.result).toBe("skipped_terminated");
    expect(outcomeOf(report, bare.id)?.result).toBe("skipped_no_entry");
    expect(outcomeOf(report, agent.id)?.result).toBe("widened");

    // Break the wiring of a second legacy agent: its grant is revoked.
    const broken = await readyAgent(companyId, ownerId);
    const brokenConnection = await makeV1Clone(broken.id);
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, (await entryOf(broken.id)).binding!.grantId!));
    expect(outcomeOf(await run(companyId), broken.id)?.result).toBe("skipped_wiring_invalid");
    expect(await cloneStatus(brokenConnection)).toMatchObject({ proposals_submit: "disabled" });

    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    expect(outcomeOf(await run(companyId), agent.id)?.result).toBe("skipped_company_archived");
    expect(connectionId).toBeTruthy();
  });

  it("pages with limit and afterId", async () => {
    const { companyId, ownerId } = await legacyAgent();
    const second = await readyAgent(companyId, ownerId);
    await makeV1Clone(second.id);
    const first = await resyncCommsCatalogs(db, { companyId, limit: 1 });
    expect(first.scanned).toBe(1);
    expect(first.nextCursor).not.toBeNull();
    const next = await resyncCommsCatalogs(db, { companyId, limit: 1, afterId: first.nextCursor! });
    expect(next.scanned).toBe(1);
    expect(first.outcomes[0]!.agentId).not.toBe(next.outcomes[0]!.agentId);
  });
});
