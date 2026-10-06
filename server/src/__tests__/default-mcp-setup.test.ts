import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { agentService } from "../services/agents.js";
import { createManagedMcpRunConfig } from "../services/heartbeat.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  DEFAULT_MCP_SPEC,
  readCommsBoardBindingReference,
  readDefaultMcpState,
  type DefaultMcpEntrySpec,
  type DefaultMcpEntryState,
} from "../services/default-mcp-spec.js";
import {
  bindDefaultMcpOwnerIfUnset,
  runDefaultMcpSetupForAgent,
  snapshotDefaultMcpForNewAgent,
  startDefaultMcpSetupSweep,
  sweepDefaultMcpSetups,
  waitForScheduledDefaultMcpSetups,
  type DefaultMcpSetupHook,
} from "../services/default-mcp-setup.js";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
} from "../services/comms-board-provisioner-client.js";
import {
  BOARD_ADMIN_TOKEN,
  BOARD_AGENT_ID,
  BOARD_TOKEN,
  BOARD_URL,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  SECRETS,
  boardResponse,
  clearBootProvisionerSnapshot,
  downstreamFetch,
  installBootProvisionerSnapshot,
  ownershipResponse,
} from "./helpers/comms-board-downstream.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TEMPLATE_URL = "https://8.8.8.8/mcp";
const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

describeEmbeddedPostgres("default MCP spec: setup, dedicated connections, effective OFF", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-setup-${randomUUID()}`);
  const envKeys = [
    FEATURE_ENV,
    COMMS_BOARD_MCP_URL_ENV,
    COMMS_BOARD_ADMIN_TOKEN_ENV,
    COMMS_BOARD_OWNERSHIP_API_URL_ENV,
    COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  ];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-setup");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
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

  // ---- seeding ------------------------------------------------------------------------------

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

  async function seedOwner(companyId: string, email = "owner@redesignhealth.com") {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  /** The org's read-only template connection, with one reviewed action and its access profile. */
  async function seedTemplate(
    companyId: string,
    name: string,
    opts: { authKind?: "api_key" | "oauth"; status?: "active" | "draft"; withAccess?: boolean } = {},
  ) {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${name} ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const sharedSecret = await secretService(db).create(companyId, {
      name: `shared ${name} ${randomUUID()}`,
      key: `shared.${randomUUID()}`,
      provider: "local_encrypted",
      value: "org-shared-template-token",
    });
    const apiKey = (opts.authKind ?? "api_key") === "api_key";
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name,
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind: opts.authKind ?? "api_key",
        credentialPolicy: apiKey ? "shared" : "per_user",
        status: opts.status ?? "active",
        enabled: true,
        config: { url: TEMPLATE_URL },
        transportConfig: { url: TEMPLATE_URL },
        credentialRefs: apiKey
          ? [{ name: "credentials.authorization", secretId: sharedSecret.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }]
          : [],
      })
      .returning()
      .then((rows) => rows[0]!);
    let catalogEntryId: string | null = null;
    let profileId: string | null = null;
    if (opts.withAccess !== false) {
      const [entry] = await db
        .insert(toolCatalogEntries)
        .values({ companyId, applicationId: application.id, connectionId: connection.id, name: "send_note", toolName: "send_note", versionHash: "v1" })
        .returning();
      catalogEntryId = entry!.id;
      const [profile] = await db
        .insert(toolProfiles)
        .values({ companyId, profileKey: `app:${connection.id}`, name: `${name} access`, defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: connection.id } })
        .returning();
      profileId = profile!.id;
      await db.insert(toolProfileEntries).values({ companyId, profileId, selectorType: "catalog_entry", effect: "include", connectionId: connection.id, catalogEntryId });
    }
    return { connection, application, catalogEntryId, profileId, sharedSecretId: sharedSecret.id };
  }

  async function seedBothTemplates(companyId: string) {
    const comms = await seedTemplate(companyId, "rh-comms-board");
    const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth" });
    return { comms, google };
  }

  function downstreamSettings(): NodeJS.ProcessEnv {
    return {
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    };
  }

  // The live resolver reads the frozen boot snapshot (TECH-7228), so "configured" means a snapshot.
  function configureDownstream() {
    installBootProvisionerSnapshot(downstreamSettings());
  }

  function enableFeature(opts: { downstream?: boolean } = {}) {
    process.env[FEATURE_ENV] = "true";
    if (opts.downstream) configureDownstream();
  }

  /** Creates the agent exactly as the routes do (verified actor in `claudeLogin.ownerUserId`) and lets scheduled setup finish. */
  async function createAgent(
    companyId: string,
    ownerUserId: string | null,
    extra: Record<string, unknown> = {},
    opts: { settle?: boolean } = {},
  ) {
    const created = await agentService(db).create(
      companyId,
      {
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
        ...extra,
      },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    if (opts.settle !== false) await waitForScheduledDefaultMcpSetups();
    return created;
  }

  const rowOf = (agentId: string) => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
  const entryOf = async (agentId: string, key = "comms-board") => readDefaultMcpState((await rowOf(agentId)).metadata)!.entries[key]!;
  const installsFor = (agentId: string) => db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agentId));
  const effectiveInstalled = async (companyId: string, agentId: string) =>
    (await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agentId)).installedConnections.map((c) => c.id);
  const grantsFor = (agentId: string) => db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agentId));
  const secretKeysIn = async (companyId: string) =>
    (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).map((s) => s.key);
  const earlier = (ms = 2 * 3_600_000) => () => new Date(Date.now() + ms);

  // ---- feature guard / existing agents ------------------------------------------------------

  it("feature guard off: creation is unchanged, nothing is called, company installs still apply", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { google } = await seedBothTemplates(companyId);
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: google.connection.id, targetType: "company", targetId: companyId });
    configureDownstream();
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, ownerId);

    expect(readDefaultMcpState(agent.metadata)).toBeNull();
    expect(agent.metadata ?? null).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await installsFor(agent.id)).toHaveLength(0);
    expect(await grantsFor(agent.id)).toHaveLength(0);
    expect(await effectiveInstalled(companyId, agent.id)).toContain(google.connection.id);
  });

  it("existing agents (no defaultMcp state) are unchanged when the feature is later enabled", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { google } = await seedBothTemplates(companyId);
    const legacy = await createAgent(companyId, ownerId);
    const before = await rowOf(legacy.id);

    enableFeature({ downstream: true });
    vi.stubGlobal("fetch", downstreamFetch());
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: google.connection.id, targetType: "company", targetId: companyId });
    const swept = await sweepDefaultMcpSetups({ db });

    expect(swept).toBe(0);
    expect((await rowOf(legacy.id)).metadata).toEqual(before.metadata);
    // The company-wide install still reaches the legacy agent: no global row rewrite.
    expect(await effectiveInstalled(companyId, legacy.id)).toContain(google.connection.id);
  });

  it("a caller-supplied defaultMcp key is discarded even with the feature off", async () => {
    const companyId = await seedCompany();
    const agent = await createAgent(companyId, null, { metadata: { defaultMcp: { forged: true }, keep: 1 } });
    expect(agent.metadata).toEqual({ keep: 1 });
  });

  // ---- P2: effective OFF across company inheritance ----------------------------------------

  it("new agents have both entries OFF even when the org installs and permits both apps company-wide; explicit install toggles normally; later company changes never enable it", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { comms, google } = await seedBothTemplates(companyId);
    const legacy = await createAgent(companyId, ownerId); // created before the feature
    enableFeature();
    const agent = await createAgent(companyId, ownerId);
    const other = await createAgent(companyId, ownerId);

    // Company-wide access + install are added AFTER the agents exist (a "later company default change").
    for (const template of [comms, google]) {
      await db.insert(toolProfileBindings).values({ companyId, profileId: template.profileId!, targetType: "company", targetId: companyId });
      await db.insert(toolConnectionInstalls).values({ companyId, connectionId: template.connection.id, targetType: "company", targetId: companyId });
    }

    // Snapshot: both entries recorded OFF with the connection the toggle governs.
    expect((await entryOf(agent.id, "rh-google-mcp"))).toMatchObject({ enabled: false, connectionId: google.connection.id, templateConnectionId: google.connection.id, ownerUserId: ownerId });
    expect((await entryOf(agent.id))).toMatchObject({ enabled: false, connectionId: null, templateConnectionId: comms.connection.id });

    // The existing effective-access resolution: legacy inherits live, feature agents do not.
    expect(await effectiveInstalled(companyId, legacy.id)).toEqual(expect.arrayContaining([comms.connection.id, google.connection.id]));
    for (const featureAgent of [agent, other]) {
      const installed = await effectiveInstalled(companyId, featureAgent.id);
      expect(installed).not.toContain(comms.connection.id);
      expect(installed).not.toContain(google.connection.id);
    }

    // Runtime projection: with a gateway over the google app, legacy gets it, the feature agent does not.
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.companyId, companyId));
    await db.insert(toolMcpGateways).values({ companyId, name: "google gateway", slug: `gw-${randomUUID().slice(0, 8)}`, profileId: google.profileId!, status: "active" });
    const runConfig = (agentId: string) =>
      createManagedMcpRunConfig({ db, agent: { id: agentId, companyId, name: "a", adapterType: "codex_local" }, runId: randomUUID(), config: {}, projectId: null, issueId: null });
    expect((await runConfig(legacy.id))?.gateways).toHaveLength(1);
    expect(await runConfig(agent.id)).toBeNull();

    // Normal install toggle (existing PUT semantics, company install kept): explicit agent install turns it on...
    const service = toolAccessService(db);
    await service.putConnectionInstalls(google.connection.id, {
      installs: [{ targetType: "company", targetId: companyId }, { targetType: "agent", targetId: agent.id }],
    });
    expect(await effectiveInstalled(companyId, agent.id)).toContain(google.connection.id);
    expect((await runConfig(agent.id))?.gateways).toHaveLength(1);
    expect(await effectiveInstalled(companyId, other.id)).not.toContain(google.connection.id); // other agents still OFF
    // ...and removing it blocks the company install again.
    await service.putConnectionInstalls(google.connection.id, { installs: [{ targetType: "company", targetId: companyId }] });
    expect(await effectiveInstalled(companyId, agent.id)).not.toContain(google.connection.id);
    expect(await runConfig(agent.id)).toBeNull();
    // Company rows were never rewritten by any of this.
    expect(await db.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.targetType, "company")))).toHaveLength(2);
  });

  it("direct token mint is denied for a default-MCP agent with only a company install, and allowed after an explicit agent install", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { google } = await seedBothTemplates(companyId);
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: google.connection.id, targetType: "company", targetId: companyId });
    const legacy = await createAgent(companyId, ownerId);
    enableFeature();
    const agent = await createAgent(companyId, ownerId);
    const mint = async (agentId: string) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: {}, responsibleUserId: ownerId }).returning();
      return toolAccessService(db)
        .mintConnectionTokenForAgent({ connectionId: google.connection.id, companyId, agentId, runId: run!.id, body: { scope: "x" } })
        .then(() => ({ code: "minted" as string | undefined }), (error: { details?: { code?: string } }) => ({ code: error.details?.code }));
    };

    expect((await mint(agent.id)).code).toBe("installation_required");
    // The legacy agent passes the install gate (it fails later for unrelated reasons, never installation_required).
    expect((await mint(legacy.id)).code).not.toBe("installation_required");
    await toolAccessService(db).putConnectionInstalls(google.connection.id, {
      installs: [{ targetType: "company", targetId: companyId }, { targetType: "agent", targetId: agent.id }],
    });
    expect((await mint(agent.id)).code).not.toBe("installation_required");
  });

  // ---- P1: dedicated per-agent connection ---------------------------------------------------

  it("ready: a dedicated per-agent connection + grant + vault secret, org template untouched, agent still OFF", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { comms } = await seedBothTemplates(companyId);
    const templateBefore = await db.select().from(toolConnections).where(eq(toolConnections.id, comms.connection.id)).then((r) => r[0]!);
    const templateBindingsBefore = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, comms.connection.id));
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, ownerId, { name: "Research Bot" });

    const baseSub = `paperclip-agent-${agent.id}`;
    expect(fetchMock.calls.register[0]).toEqual({ sub: baseSub, ownerEmail: "owner@redesignhealth.com" });
    expect(fetchMock.calls.mint[0]).toEqual({ sub: baseSub, scopes: ["comms:read", "comms:write"], expires: 30 });

    const entry = await entryOf(agent.id);
    expect(entry.setup).toMatchObject({ state: "ready", reason: null, leaseUntil: null, nextAttemptAt: null });
    expect(entry.binding).toMatchObject({ boardAgentId: BOARD_AGENT_ID, baseSub, agentKey: null, boardSub: baseSub });

    // Dedicated connection: deterministic company-scoped name, persisted id, per_agent, agent-secret header ref.
    const [dedicated] = await db.select().from(toolConnections).where(eq(toolConnections.name, `rh-comms-board:${agent.id}`));
    expect(dedicated).toMatchObject({ companyId, credentialPolicy: "per_agent", authKind: "api_key", status: "active", enabled: true, applicationId: comms.application.id });
    expect(entry.connectionId).toBe(dedicated!.id);
    expect(entry.binding!.connectionId).toBe(dedicated!.id);
    expect(dedicated!.config).toEqual({ url: TEMPLATE_URL, mcpSessionRequired: true });
    expect(dedicated!.credentialRefs).toEqual([
      expect.objectContaining({ name: "credentials.authorization", secretId: entry.binding!.secretId, placement: "header", key: "Authorization", prefix: "Bearer " }),
    ]);

    // Active agent grant with the same secret at the same config path; exactly one binding row for it.
    const [grant] = await grantsFor(agent.id);
    expect(grant).toMatchObject({ connectionId: dedicated!.id, kind: "agent", status: "active" });
    expect(grant!.id).toBe(entry.binding!.grantId);
    expect(grant!.credentialSecretRefs).toEqual([expect.objectContaining({ secretId: entry.binding!.secretId, configPath: "credentials.authorization" })]);
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, dedicated!.id));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ secretId: entry.binding!.secretId, configPath: "credentials.authorization", targetType: "tool_connection" });

    // Reviewed actions are copied from the template (no network); no bindings, no install => OFF.
    const clonedActions = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, dedicated!.id));
    expect(clonedActions.map((e) => e.toolName)).toEqual(["send_note"]);
    const [dedicatedProfile] = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${dedicated!.id}`));
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, dedicatedProfile!.id))).toEqual([
      expect.objectContaining({ catalogEntryId: clonedActions[0]!.id, connectionId: dedicated!.id }),
    ]);
    // Access (not an install) for this agent only, tagged so the normal uninstall path leaves it in place.
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, dedicatedProfile!.id))).toEqual([
      expect.objectContaining({ targetType: "agent", targetId: agent.id, metadata: { source: "default_mcp_spec", connectionId: dedicated!.id } }),
    ]);
    expect(await installsFor(agent.id)).toHaveLength(0);
    const effective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agent.id);
    expect(effective.entries.some((e) => e.connectionId === dedicated!.id)).toBe(true); // permitted: visible in the Tools tab
    expect(effective.installedConnections.map((c) => c.id)).not.toContain(dedicated!.id); // but OFF

    // The org template is read-only: row, grants, bindings, installs and catalog are exactly as before.
    expect(await db.select().from(toolConnections).where(eq(toolConnections.id, comms.connection.id)).then((r) => r[0])).toEqual(templateBefore);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, comms.connection.id)).then((r) => r.filter((g) => g.kind === "agent"))).toHaveLength(0);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, comms.connection.id))).toEqual(templateBindingsBefore);
    expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, comms.connection.id))).toHaveLength(1);

    // The vault holds the board token; the read-only reference carries ids only.
    expect(await secretService(db).resolveSecretValue(companyId, entry.binding!.secretId!, "latest")).toBe(BOARD_TOKEN);
    expect(readCommsBoardBindingReference((await rowOf(agent.id)).metadata)).toEqual(entry.binding);
  });

  it("two agents get separate connections, grants, secrets and bindings; no shared token reaches either", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { comms } = await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch({
      register: (sub) => boardResponse(sub, { payload: { agent_id: randomUUID(), sub } }),
      mint: (sub) => ownershipResponse(sub, { token: `token-for-${sub}` }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const a = await createAgent(companyId, ownerId, { name: "Alpha" });
    const b = await createAgent(companyId, ownerId, { name: "Beta" });
    const [ea, eb] = [await entryOf(a.id), await entryOf(b.id)];
    expect([ea.setup.state, eb.setup.state]).toEqual(["ready", "ready"]);

    expect(ea.connectionId).not.toBe(eb.connectionId);
    expect(ea.binding!.secretId).not.toBe(eb.binding!.secretId);
    expect(ea.binding!.boardAgentId).not.toBe(eb.binding!.boardAgentId);
    expect(ea.binding!.grantId).not.toBe(eb.binding!.grantId);
    for (const [agent, entry] of [[a, ea], [b, eb]] as const) {
      expect(await secretService(db).resolveSecretValue(companyId, entry.binding!.secretId!, "latest")).toBe(`token-for-paperclip-agent-${agent.id}`);
      const [grant] = await grantsFor(agent.id);
      expect(grant!.connectionId).toBe(entry.connectionId);
      expect(grant!.credentialSecretRefs.map((ref) => ref.secretId)).toEqual([entry.binding!.secretId]);
      // Each dedicated connection binds only its own agent's secret.
      const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, entry.connectionId!));
      expect(bindings.map((x) => x.secretId)).toEqual([entry.binding!.secretId]);
    }
    // Agent A has no grant on B's connection (the gateway would answer agent_authorization_required).
    expect(await db.select().from(connectionGrants).where(and(eq(connectionGrants.connectionId, eb.connectionId!), eq(connectionGrants.subjectAgentId, a.id)))).toHaveLength(0);
    // Template and shared org secret are not referenced by either agent's secret or connection.
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, comms.sharedSecretId))).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, comms.connection.id)).then((r) => r.filter((g) => g.kind === "agent"))).toHaveLength(0);
  });

  it("tenant isolation: a same-named template in another company is never read or modified", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const { comms: foreign } = await seedBothTemplates(companyB);
    const ownerA = await seedOwner(companyA);
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyA, ownerA);

    expect(await entryOf(agent.id)).toMatchObject({ templateConnectionId: null, setup: { state: "pending", reason: "template_not_found" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyB))).toHaveLength(2);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, foreign.connection.id))).toHaveLength(0);
  });

  it("Google (ordinary entry) is OFF with no provisioning, grants or OAuth consent at create", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { google } = await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    vi.stubGlobal("fetch", downstreamFetch());
    const agent = await createAgent(companyId, ownerId);

    expect(await entryOf(agent.id, "rh-google-mcp")).toMatchObject({ enabled: false, connectionId: google.connection.id, setup: { state: "not_required", reason: null } });
    expect(await db.select().from(toolOauthStates)).toHaveLength(0);
    expect((await grantsFor(agent.id)).map((g) => g.connectionId)).not.toContain(google.connection.id);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, google.connection.id))).toHaveLength(0);
    expect(await installsFor(agent.id)).toHaveLength(0);
  });

  // ---- P1/P5: OFF withholds the credential everywhere ---------------------------------------

  it("OFF withholds the credential from every runtime path; installing the dedicated connection exposes only the run-scoped gateway", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    vi.stubGlobal("fetch", downstreamFetch());

    for (const adapterType of ["hermes_local", "claude_local", "process"]) {
      const agent = await createAgent(companyId, ownerId, { adapterType, adapterConfig: { env: { KEEP: { type: "plain", value: "1" } } } });
      expect((await entryOf(agent.id)).setup.state).toBe("ready");
      const row = await rowOf(agent.id);
      expect(JSON.stringify(row.adapterConfig)).not.toContain("RH_COMMS_BOARD_TOKEN");
      expect(JSON.stringify(row.adapterConfig)).not.toContain("secret_ref");
      const resolved = await secretService(db).resolveAdapterConfigForRuntime(
        companyId,
        row.adapterConfig as Record<string, unknown>,
        { companyId, consumerType: "agent", consumerId: agent.id, actorType: "system", actorId: agent.id } as never,
        { adapterType },
      );
      expect(JSON.stringify(resolved)).not.toContain(BOARD_TOKEN);
      expect([...resolved.secretKeys]).toEqual([]);
      expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, agent.id))).toHaveLength(0);
    }

    // Normal enable on a codex agent: install the DEDICATED connection through the existing PUT semantics.
    const agent = await createAgent(companyId, ownerId, { adapterType: "codex_local" });
    const entry = await entryOf(agent.id);
    const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${entry.connectionId}`));
    await db.insert(toolMcpGateways).values({ companyId, name: "dedicated gateway", slug: `gw-${randomUUID().slice(0, 8)}`, profileId: profile!.id, status: "active" });
    const runConfig = () =>
      createManagedMcpRunConfig({ db, agent: { id: agent.id, companyId, name: "a", adapterType: "codex_local" }, runId: randomUUID(), config: {}, projectId: null, issueId: null });
    expect(await runConfig()).toBeNull(); // OFF: server and credential withheld

    await toolAccessService(db).putConnectionInstalls(entry.connectionId!, { installs: [{ targetType: "agent", targetId: agent.id }] });
    const enabled = await runConfig();
    expect(enabled?.gateways).toHaveLength(1);
    for (const secret of SECRETS) expect(JSON.stringify(enabled)).not.toContain(secret);

    await toolAccessService(db).putConnectionInstalls(entry.connectionId!, { installs: [] }); // toggle OFF: next run withholds again
    expect(await runConfig()).toBeNull();
    // The access binding survives the uninstall, so the toggle stays visible and can be turned back on.
    expect(await db.select().from(toolProfileBindings).where(and(eq(toolProfileBindings.profileId, profile!.id), eq(toolProfileBindings.targetId, agent.id)))).toHaveLength(1);
    // The state itself stays ready: the credential is simply not delivered.
    expect((await entryOf(agent.id)).setup.state).toBe("ready");
  });

  // ---- P3: durable retry, checkpoints, unknown outcomes -------------------------------------

  it("agent creation never awaits the external calls", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = downstreamFetch({ register: async (sub) => { await gate; return boardResponse(sub); } });
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, ownerId, {}, { settle: false }); // resolves while the register POST is gated
    expect((await rowOf(agent.id)).id).toBe(agent.id);
    expect((await entryOf(agent.id)).setup.state).toMatch(/pending|in_progress/);
    release();
    await waitForScheduledDefaultMcpSetups();
    expect((await entryOf(agent.id)).setup.state).toBe("ready");
  });

  it("pre-call checkpoints are durable BEFORE each POST", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature();
    const agent = await createAgent(companyId, ownerId); // pending: provisioner not configured
    const seen: Array<{ phase: string; setup: DefaultMcpEntryState["setup"]; hasBoardId: boolean }> = [];
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch({
      register: async (sub) => { const e = await entryOf(agent.id); seen.push({ phase: "register", setup: e.setup, hasBoardId: Boolean(e.binding?.boardAgentId) }); return boardResponse(sub); },
      mint: async (sub) => { const e = await entryOf(agent.id); seen.push({ phase: "mint", setup: e.setup, hasBoardId: Boolean(e.binding?.boardAgentId) }); return ownershipResponse(sub); },
    });
    vi.stubGlobal("fetch", fetchMock);

    await sweepDefaultMcpSetups({ db, now: earlier() });

    expect(seen.map((s) => s.phase)).toEqual(["register", "mint"]);
    expect(seen[0]!.setup).toMatchObject({ state: "in_progress", registerAttemptedAt: expect.any(String), mintAttemptedAt: null });
    expect(seen[0]!.hasBoardId).toBe(false);
    expect(seen[1]!.setup).toMatchObject({ state: "in_progress", registerAttemptedAt: expect.any(String), mintAttemptedAt: expect.any(String) });
    expect(seen[1]!.hasBoardId).toBe(true);
    expect((await entryOf(agent.id)).setup.state).toBe("ready");
  });

  it("missing config is retried automatically (config restart): pending with backoff, then ready, never an inline error", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature(); // no downstream config yet
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, ownerId);

    const waiting = await entryOf(agent.id);
    expect(waiting.setup).toMatchObject({ state: "pending", reason: "provisioner_not_configured", attemptCount: 1 });
    expect(Date.parse(waiting.setup.nextAttemptAt!)).toBeGreaterThan(Date.now());
    expect(fetchMock).not.toHaveBeenCalled();

    // Not due yet: the sweep leaves it alone even once configured.
    configureDownstream();
    expect(await sweepDefaultMcpSetups({ db })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // Due (a later sweep after the process restarted with the config): claimed and completed.
    expect(await sweepDefaultMcpSetups({ db, now: earlier(10 * 60_000) })).toBe(1);
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "ready", reason: null });
    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(1);
  });

  it("never honors provisioner credentials found only in the live process.env (boot snapshot is the sole source, TECH-7228)", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature(); // no boot snapshot: the server booted without provisioner settings
    // A late dotenv-style write straight into the live environment must not be adopted.
    for (const [key, value] of Object.entries(downstreamSettings())) process.env[key] = value!;
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, ownerId);

    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "provisioner_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a missing or unsupported org template stays visibly pending and never mints; it completes once the template exists", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, ownerId);
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_not_found" });

    // A draft (not yet governed/enabled) template is not usable either.
    const draft = await seedTemplate(companyId, "rh-comms-board", { status: "draft" });
    await sweepDefaultMcpSetups({ db, now: earlier(10 * 60_000) });
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();

    await db.update(toolConnections).set({ status: "active" }).where(eq(toolConnections.id, draft.connection.id));
    await sweepDefaultMcpSetups({ db, now: earlier(5 * 3_600_000) });
    expect((await entryOf(agent.id)).setup.state).toBe("ready");
    expect(fetchMock.calls.register).toHaveLength(1);
  });

  it.each([
    ["board 'already_registered'", { register: (sub: string) => boardResponse(sub, { isError: true, payload: { error_code: "already_registered" } }) }, "board_conflict", 0],
    ["board HTTP 403", { register: (sub: string) => boardResponse(sub, { status: 403 }) }, "board_rejected", 0],
    ["board timeout", { register: () => { throw new DOMException("timed out", "TimeoutError"); } }, "board_unknown", 0],
    ["board 5xx", { register: (sub: string) => boardResponse(sub, { status: 503 }) }, "board_unknown", 0],
    ["board success without agent_id", { register: (sub: string) => boardResponse(sub, { payload: { sub } }) }, "board_unknown", 0],
    ["ownership 409", { mint: (sub: string) => ownershipResponse(sub, {}, 409) }, "ownership_conflict", 1],
    ["ownership 403", { mint: (sub: string) => ownershipResponse(sub, {}, 403) }, "ownership_rejected", 1],
    ["ownership timeout", { mint: () => { throw new DOMException("timed out", "TimeoutError"); } }, "mint_unknown", 1],
    ["ownership 5xx", { mint: (sub: string) => ownershipResponse(sub, {}, 502) }, "mint_unknown", 1],
    ["ownership 201 with null token", { mint: (sub: string) => ownershipResponse(sub, { token: null }) }, "mint_unknown", 1],
  ])("%s: terminal visible error, no secret/connection/grant, and no automatic POST retry or rotation", async (_label, behavior, reason, mintCalls) => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { comms } = await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch(behavior);
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, ownerId);
    expect(agent.id).toBeTruthy(); // creation itself still succeeded
    const entry = await entryOf(agent.id);
    expect(entry.setup).toMatchObject({ state: "error", reason, leaseUntil: null, nextAttemptAt: null });
    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(mintCalls);
    if (mintCalls === 1) expect(entry.binding).toMatchObject({ boardAgentId: BOARD_AGENT_ID, secretId: null });
    expect(await grantsFor(agent.id)).toHaveLength(0);
    expect((await secretKeysIn(companyId)).some((k) => k.startsWith("comms_board."))).toBe(false);
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId))).toHaveLength(2);
    expect(comms.connection.id).toBeTruthy();

    // Neither the sweep (even far in the future) nor a direct rerun ever POSTs again.
    await sweepDefaultMcpSetups({ db, now: earlier(24 * 3_600_000) });
    await runDefaultMcpSetupForAgent({ db, now: earlier(24 * 3_600_000) }, { companyId, agentId: agent.id });
    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(mintCalls);
    expect(fetchMock).toHaveBeenCalledTimes(4 + mintCalls);
  });

  it("stale claims are classified from their checkpoints: unknown POST outcomes are terminal, safe steps resume exactly once", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature(); // downstream not configured while the agents are created: nothing external has happened
    const baseBinding = (id: string) => ({ boardAgentId: BOARD_AGENT_ID, baseSub: `paperclip-agent-${id}`, agentKey: "k", boardSub: `paperclip-agent-${id}::k`, secretId: null, secretVersion: null, connectionId: null, grantId: null, tokenExpiresAt: null });
    const stale = async (patch: (e: DefaultMcpEntryState, agentId: string) => DefaultMcpEntryState) => {
      const agent = await createAgent(companyId, ownerId);
      const entry = await entryOf(agent.id);
      const next = patch({ ...entry, setup: { ...entry.setup, state: "in_progress", reason: null, leaseUntil: new Date(Date.now() - 60_000).toISOString() } }, agent.id);
      await db.update(agents).set({ metadata: { defaultMcp: { version: 1, entries: { ...readDefaultMcpState((await rowOf(agent.id)).metadata)!.entries, "comms-board": next } } } }).where(eq(agents.id, agent.id));
      return agent;
    };
    const attempted = () => new Date().toISOString();
    // register attempted, no board UUID => the register POST outcome is unknown.
    const a = await stale((e) => ({ ...e, setup: { ...e.setup, registerAttemptedAt: attempted() } }));
    // mint attempted, no durable secret => the mint POST outcome is unknown.
    const b = await stale((e, id) => ({ ...e, setup: { ...e.setup, registerAttemptedAt: attempted(), mintAttemptedAt: attempted() }, binding: baseBinding(id) }));
    // board UUID persisted and no mint attempt => safe: mint once, never register again.
    const c = await stale((e, id) => ({ ...e, setup: { ...e.setup, registerAttemptedAt: attempted() }, binding: baseBinding(id) }));
    // no checkpoint at all (crashed before any POST) => behaves like a normal first attempt.
    const d = await stale((e) => e);

    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    await sweepDefaultMcpSetups({ db });

    expect((await entryOf(a.id)).setup).toMatchObject({ state: "error", reason: "board_unknown" });
    expect((await entryOf(b.id)).setup).toMatchObject({ state: "error", reason: "mint_unknown" });
    expect((await entryOf(c.id)).setup.state).toBe("ready");
    expect((await entryOf(d.id)).setup.state).toBe("ready");
    // Only c (mint) and d (register + mint) made calls; a and b made none.
    expect(fetchMock.calls.register.map((r) => r.sub)).toEqual([`paperclip-agent-${d.id}`]);
    expect(fetchMock.calls.mint.map((m) => m.sub).sort()).toEqual([`paperclip-agent-${c.id}`, `paperclip-agent-${d.id}`].sort());
  });

  it("a stored secret makes the connection/grant steps retryable (bounded, capped backoff) without any POST; exhaustion is a visible error", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { comms } = await seedBothTemplates(companyId);
    // Two connections already carry the deterministic dedicated name, which makes the local stage refuse to pick one.
    enableFeature();
    const duplicateOf = async (agentId: string) => {
      for (let i = 0; i < 2; i += 1) {
        await db.insert(toolConnections).values({ companyId, applicationId: comms.application.id, name: `rh-comms-board:${agentId}`, uid: `dup-${randomUUID()}`, transport: "mcp_remote", authKind: "api_key", credentialPolicy: "per_agent", status: "active", enabled: true, config: { url: TEMPLATE_URL }, transportConfig: { url: TEMPLATE_URL } });
      }
    };
    const agent = await createAgent(companyId, ownerId);
    await duplicateOf(agent.id);
    const secret = await secretService(db).create(companyId, { name: "stored", key: `comms_board.${agent.id}`, provider: "local_encrypted", value: BOARD_TOKEN });
    const entry = await entryOf(agent.id);
    await db.update(agents).set({
      metadata: { defaultMcp: { version: 1, entries: { ...readDefaultMcpState((await rowOf(agent.id)).metadata)!.entries, "comms-board": {
        ...entry,
        setup: { ...entry.setup, state: "pending", reason: null, nextAttemptAt: null, attemptCount: 0, registerAttemptedAt: "2026-01-01T00:00:00.000Z", mintAttemptedAt: "2026-01-01T00:00:00.000Z" },
        binding: { boardAgentId: BOARD_AGENT_ID, baseSub: `paperclip-agent-${agent.id}`, agentKey: "k", boardSub: `paperclip-agent-${agent.id}::k`, secretId: secret.id, secretVersion: "latest", connectionId: null, grantId: null, tokenExpiresAt: null },
      } } } },
    }).where(eq(agents.id, agent.id));
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    let clock = Date.now();
    const now = () => new Date(clock);
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      clock += 3_700_000;
      await runDefaultMcpSetupForAgent({ db, now }, { companyId, agentId: agent.id });
      const e = await entryOf(agent.id);
      expect(e.setup).toMatchObject({ state: "pending", reason: "binding_failed", attemptCount: attempt });
      waits.push(Date.parse(e.setup.nextAttemptAt!) - clock);
    }
    expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]); // doubles, capped at 1h
    // Not due before nextAttemptAt.
    await runDefaultMcpSetupForAgent({ db, now: () => new Date(clock + 1_000) }, { companyId, agentId: agent.id });
    expect((await entryOf(agent.id)).setup.attemptCount).toBe(7);

    clock += 3_700_000;
    await runDefaultMcpSetupForAgent({ db, now }, { companyId, agentId: agent.id }); // 8th attempt
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "error", reason: "binding_failed", attemptCount: 8, nextAttemptAt: null });
    expect(fetchMock).not.toHaveBeenCalled(); // no POST during any retry
    expect(await grantsFor(agent.id)).toHaveLength(0);

    // Fix the template; an operator-reset entry (pending, secret retained) completes without a new POST.
    await db.delete(toolConnections).where(eq(toolConnections.name, `rh-comms-board:${agent.id}`));
    const failed = await entryOf(agent.id);
    await db.update(agents).set({ metadata: { defaultMcp: { version: 1, entries: { ...readDefaultMcpState((await rowOf(agent.id)).metadata)!.entries, "comms-board": { ...failed, setup: { ...failed.setup, state: "pending", reason: null, attemptCount: 0, nextAttemptAt: null } } } } } }).where(eq(agents.id, agent.id));
    await runDefaultMcpSetupForAgent({ db }, { companyId, agentId: agent.id });
    expect((await entryOf(agent.id)).setup.state).toBe("ready");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.select().from(toolConnections).where(eq(toolConnections.name, `rh-comms-board:${agent.id}`))).toHaveLength(1);
  });

  it("repeated parallel claims (create event + sweeps on several instances) make exactly one register and one mint", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature();
    const agent = await createAgent(companyId, ownerId);
    enableFeature({ downstream: true });
    const slow = async (response: Response) => { await new Promise((resolve) => setTimeout(resolve, 25)); return response; };
    const fetchMock = downstreamFetch({ register: (sub) => slow(boardResponse(sub)), mint: (sub) => slow(ownershipResponse(sub)) });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      sweepDefaultMcpSetups({ db, now: earlier() }),
      sweepDefaultMcpSetups({ db, now: earlier() }),
      runDefaultMcpSetupForAgent({ db, now: earlier() }, { companyId, agentId: agent.id }),
      runDefaultMcpSetupForAgent({ db, now: earlier() }, { companyId, agentId: agent.id }),
    ]);

    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(1);
    expect(await grantsFor(agent.id)).toHaveLength(1);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.key, `comms_board.${agent.id}`))).toHaveLength(1);
    expect(await db.select().from(toolConnections).where(eq(toolConnections.name, `rh-comms-board:${agent.id}`))).toHaveLength(1);
  });

  it("sweep: at most 25 candidates per pass, only pending-due or stale entries, ignores unapproved/legacy agents", async () => {
    const companyId = await seedCompany();
    enableFeature();
    const calls: string[] = [];
    const hook: DefaultMcpSetupHook = async ({ agentId }) => { calls.push(agentId); return { kind: "waiting", reason: "provisioner_not_configured" }; };
    const dueEntry = (): DefaultMcpEntryState => ({
      key: "comms-board", templateKey: "rh-comms-board", dedicated: true, enabled: false, templateConnectionId: null, connectionId: null, ownerUserId: null,
      setup: { state: "pending", reason: null, attemptCount: 0, nextAttemptAt: null, leaseUntil: null, claimId: null, registerAttemptedAt: null, mintAttemptedAt: null, updatedAt: new Date().toISOString() },
      binding: null,
    });
    const insert = (status: string, metadata: unknown) =>
      db.insert(agents).values({ companyId, name: `A ${randomUUID().slice(0, 6)}`, role: "engineer", status, adapterType: "process", adapterConfig: {}, runtimeConfig: {}, metadata: metadata as never });
    for (let i = 0; i < 30; i += 1) await insert("idle", { defaultMcp: { version: 1, entries: { "comms-board": dueEntry() } } });
    await insert("pending_approval", { defaultMcp: { version: 1, entries: { "comms-board": dueEntry() } } });
    await insert("idle", null);
    await insert("idle", { defaultMcp: { version: 1, entries: { "comms-board": { ...dueEntry(), setup: { ...dueEntry().setup, state: "ready" } } } } });
    await insert("idle", { defaultMcp: { version: 1, entries: { "comms-board": { ...dueEntry(), setup: { ...dueEntry().setup, state: "pending", nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() } } } } });

    expect(await sweepDefaultMcpSetups({ db, hooks: { comms_board_identity: hook } })).toBe(25);
    expect(new Set(calls).size).toBe(25);
  });

  it("the sweep starter is a no-op with the flag off and, with it on, runs at startup and stops cleanly", async () => {
    const companyId = await seedCompany();
    const calls: string[] = [];
    const hook: DefaultMcpSetupHook = async ({ agentId }) => { calls.push(agentId); return { kind: "waiting", reason: "provisioner_not_configured" }; };
    await db.insert(agents).values({
      companyId, name: "Sweepee", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
      metadata: { defaultMcp: { version: 1, entries: { "comms-board": { key: "comms-board", templateKey: "rh-comms-board", dedicated: true, enabled: false, templateConnectionId: null, connectionId: null, ownerUserId: null, setup: { state: "pending", reason: null, attemptCount: 0, nextAttemptAt: null, leaseUntil: null, claimId: null, registerAttemptedAt: null, mintAttemptedAt: null, updatedAt: new Date().toISOString() }, binding: null } } } } as never,
    });

    startDefaultMcpSetupSweep(db, { hooks: { comms_board_identity: hook } })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(0);

    enableFeature();
    const stop = startDefaultMcpSetupSweep(db, { hooks: { comms_board_identity: hook } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();
    expect(calls).toHaveLength(1);
  });

  // ---- approval ------------------------------------------------------------------------------

  it("pending-approval hires are skipped until approval, then complete without an inline await", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, ownerId, { status: "pending_approval" });
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "awaiting_approval" });
    await sweepDefaultMcpSetups({ db, now: earlier() });
    await runDefaultMcpSetupForAgent({ db, now: earlier() }, { companyId, agentId: agent.id });
    expect(fetchMock).not.toHaveBeenCalled();

    const activated = await agentService(db).activatePendingApproval(agent.id);
    expect(activated?.activated).toBe(true);
    await waitForScheduledDefaultMcpSetups();
    expect((await entryOf(agent.id)).setup.state).toBe("ready");
    expect(fetchMock.calls.register).toHaveLength(1);
  });

  // ---- P4: verified owner --------------------------------------------------------------------

  it("owner is frozen from the verified actor; body-supplied owner/defaultMcp values are never read", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId, "real-owner@redesignhealth.com");
    const victimId = await seedOwner(companyId, "victim@redesignhealth.com");
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, ownerId, {
      metadata: { defaultMcp: { version: 1, entries: { "comms-board": { ownerUserId: victimId } } }, ownerUserId: victimId },
      adapterConfig: { defaultMcp: { ownerUserId: victimId }, ownerUserId: victimId, owner_email: "victim@redesignhealth.com" },
    });

    expect((await entryOf(agent.id)).ownerUserId).toBe(ownerId);
    expect(fetchMock.calls.register[0]!.ownerEmail).toBe("real-owner@redesignhealth.com");
    expect(fetchMock.calls.mint).toHaveLength(1);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("victim@redesignhealth.com");
  });

  it("an agent actor, a non-member owner, or a revoked membership never reaches the downstream calls", async () => {
    const companyId = await seedCompany();
    const otherCompany = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const foreignOwner = await seedOwner(otherCompany, "foreign@redesignhealth.com");
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const byAgent = await createAgent(companyId, null);
    const byForeign = await createAgent(companyId, foreignOwner);
    expect((await entryOf(byAgent.id)).ownerUserId).toBeNull();
    for (const a of [byAgent, byForeign]) expect((await entryOf(a.id)).setup).toMatchObject({ state: "pending", reason: "owner_required" });
    expect(fetchMock).not.toHaveBeenCalled();

    // Membership is checked on EVERY attempt: revoke it between creation and a later sweep.
    const pendingOwner = await createAgent(companyId, ownerId, {}, { settle: false });
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, ownerId));
    await waitForScheduledDefaultMcpSetups();
    expect((await entryOf(pendingOwner.id)).setup).toMatchObject({ state: "pending", reason: "owner_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an approving human may bind the owner only when none exists; the verified approver never overrides one", async () => {
    const companyId = await seedCompany();
    const creator = await seedOwner(companyId, "creator@redesignhealth.com");
    const approver = await seedOwner(companyId, "approver@redesignhealth.com");
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const agentCreated = await createAgent(companyId, null, { status: "pending_approval" });
    const humanCreated = await createAgent(companyId, creator, { status: "pending_approval" });
    await bindDefaultMcpOwnerIfUnset(db, agentCreated.id, approver);
    await bindDefaultMcpOwnerIfUnset(db, humanCreated.id, approver);
    expect((await entryOf(agentCreated.id)).ownerUserId).toBe(approver);
    expect((await entryOf(humanCreated.id)).ownerUserId).toBe(creator);
    await bindDefaultMcpOwnerIfUnset(db, agentCreated.id, null); // no verified approver => nothing bound

    await agentService(db).activatePendingApproval(agentCreated.id);
    await waitForScheduledDefaultMcpSetups();
    expect((await entryOf(agentCreated.id)).setup.state).toBe("ready");
    expect(fetchMock.calls.register[0]!.ownerEmail).toBe("approver@redesignhealth.com");
  });

  it("agent updates cannot forge or wipe the server-managed state", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    vi.stubGlobal("fetch", downstreamFetch());
    const agent = await createAgent(companyId, ownerId);
    const before = readDefaultMcpState((await rowOf(agent.id)).metadata);

    await agentService(db).update(agent.id, { metadata: { defaultMcp: { version: 1, entries: { "comms-board": { forged: true } } }, note: "x" } });
    await agentService(db).update(agent.id, { metadata: null });

    expect(readDefaultMcpState((await rowOf(agent.id)).metadata)).toEqual(before);
  });

  // ---- generic spec --------------------------------------------------------------------------

  it("a third ordinary MCP is one config entry: snapshot only, no hook, no per-MCP code, existing agents untouched", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const third = await seedTemplate(companyId, "rh-third-mcp", { authKind: "api_key" });
    const existing = await createAgent(companyId, ownerId);
    const existingBefore = await rowOf(existing.id);
    const thirdEntry: DefaultMcpEntrySpec = { key: "third-mcp", displayName: "Third", connectionName: "rh-third-mcp", authKind: "none", defaultEnabled: false };
    const created = await createAgent(companyId, ownerId);
    const spec = [...DEFAULT_MCP_SPEC, thirdEntry];
    await db.transaction(async (tx) => {
      await snapshotDefaultMcpForNewAgent(tx as never, { companyId, agentId: created.id, existingMetadata: null, ownerUserId: ownerId, spec });
    });
    const fetchMock = vi.fn();
    await runDefaultMcpSetupForAgent({ db, spec, fetchImpl: fetchMock }, { companyId, agentId: created.id });

    expect(await entryOf(created.id, "third-mcp")).toMatchObject({ enabled: false, connectionId: third.connection.id, setup: { state: "not_required" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await installsFor(created.id)).toHaveLength(0);
    expect((await rowOf(existing.id)).metadata).toEqual(existingBefore.metadata);

    // `defaultEnabled: true` on an ordinary entry installs only the NEW agent.
    const onSpec: DefaultMcpEntrySpec[] = [{ ...thirdEntry, defaultEnabled: true }];
    const another = await createAgent(companyId, ownerId);
    await db.transaction(async (tx) => {
      await snapshotDefaultMcpForNewAgent(tx as never, { companyId, agentId: another.id, existingMetadata: null, ownerUserId: ownerId, spec: onSpec });
    });
    expect((await installsFor(another.id)).map((i) => i.connectionId)).toEqual([third.connection.id]);
    expect(await installsFor(existing.id)).toHaveLength(0);
  });

  // ---- P5: redaction ---------------------------------------------------------------------------

  it("secrets never appear in metadata, audit, logs or errors; the scan is not vacuous", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });
    vi.stubGlobal("fetch", downstreamFetch());
    const warn = vi.spyOn(logger, "warn");

    const agent = await createAgent(companyId, ownerId);
    const entry = await entryOf(agent.id);
    const row = await rowOf(agent.id);
    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const reference = readCommsBoardBindingReference(row.metadata);

    // Not vacuous: the token really is in the vault, and the non-secret markers really are in every blob.
    expect(await secretService(db).resolveSecretValue(companyId, entry.binding!.secretId!, "latest")).toBe(BOARD_TOKEN);
    expect(JSON.stringify(row.metadata)).toContain(entry.binding!.baseSub);
    expect(JSON.stringify(audit)).toContain("agent.default_mcp.setup");
    expect(reference).not.toBeNull();
    for (const blob of [JSON.stringify(agent), JSON.stringify(row), JSON.stringify(audit), JSON.stringify(reference), JSON.stringify(warn.mock.calls)]) {
      for (const secret of SECRETS) expect(blob).not.toContain(secret);
    }

    // A hook that throws a secret-bearing error is logged by class only and surfaces as a coded error.
    installBootProvisionerSnapshot({ ...downstreamSettings(), [COMMS_BOARD_MCP_URL_ENV]: undefined });
    const pending = await createAgent(companyId, ownerId); // downstream unconfigured => naturally pending
    const pendingEntry = await entryOf(pending.id);
    expect(pendingEntry.setup.state).toBe("pending");
    const leaky: DefaultMcpSetupHook = async () => { throw new Error(`boom ${BOARD_TOKEN} ${BOARD_ADMIN_TOKEN} Authorization: Bearer ${OWNERSHIP_TOKEN}`); };
    await runDefaultMcpSetupForAgent({ db, hooks: { comms_board_identity: leaky }, now: earlier() }, { companyId, agentId: pending.id });
    expect((await entryOf(pending.id)).setup).toMatchObject({ state: "error", reason: "provisioner_failed" });
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("Error"); // the class name is logged
    for (const secret of SECRETS) {
      expect(logged).not.toContain(secret);
      expect(JSON.stringify((await rowOf(pending.id)).metadata)).not.toContain(secret);
      expect(JSON.stringify(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)))).not.toContain(secret);
    }
  });

  it("temporary handshake 500 or timeout stays pending with registerAttemptedAt absent, sends 0 register/mint, and resumes to ready on next attempt", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });

    let handshakeFailing = true;
    const fetchMock = downstreamFetch();
    const customFetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === BOARD_URL) {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        if (body?.method === "initialize" && handshakeFailing) {
          return new Response(JSON.stringify({ error: "server error" }), { status: 500 });
        }
      }
      return fetchMock(url, init);
    });
    Object.assign(customFetch, { calls: fetchMock.calls });
    vi.stubGlobal("fetch", customFetch);

    // Initial creation: handshake fails with 500
    const agent = await createAgent(companyId, ownerId);
    const entryAfterFail = await entryOf(agent.id);

    // State is pending (retryable!), reason is provisioner_failed, registerAttemptedAt is ABSENT
    expect(entryAfterFail.setup.state).toBe("pending");
    expect(entryAfterFail.setup.reason).toBe("provisioner_failed");
    expect(entryAfterFail.setup.registerAttemptedAt).toBeNull();
    expect(entryAfterFail.setup.attemptCount).toBe(1);
    expect(entryAfterFail.setup.nextAttemptAt).not.toBeNull();
    expect(fetchMock.calls.register).toHaveLength(0);
    expect(fetchMock.calls.mint).toHaveLength(0);

    // Now restore healthy downstream, advance past backoff, and run next attempt
    handshakeFailing = false;
    const pastBackoff = new Date(Date.now() + 3_700_000);
    await sweepDefaultMcpSetups({ db, now: () => pastBackoff });

    const entryAfterRecover = await entryOf(agent.id);
    expect(entryAfterRecover.setup.state).toBe("ready");
    expect(entryAfterRecover.setup.reason).toBeNull();
    expect(entryAfterRecover.setup.registerAttemptedAt).not.toBeNull();
    expect(entryAfterRecover.binding?.boardAgentId).toBeTruthy();
    expect(entryAfterRecover.binding?.secretId).toBeTruthy();

    // Exactly one register tool call and exactly one mint call
    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(1);
  });

  it("uppercase returned sub is rejected as board_unknown and creates no successful binding", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    enableFeature({ downstream: true });

    const fetchMock = downstreamFetch({
      register: (sub: string) =>
        boardResponse(sub, {
          payload: {
            agent_id: BOARD_AGENT_ID,
            sub: sub.toUpperCase(), // uppercase sub mismatch
            display_name: "x",
            status: "active",
            is_shared: false,
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, ownerId);
    const entry = await entryOf(agent.id);
    expect(entry.setup.state).toBe("error");
    expect(entry.setup.reason).toBe("board_unknown");
    expect(entry.binding).toBeNull();
    expect(await grantsFor(agent.id)).toHaveLength(0);
  });
});
