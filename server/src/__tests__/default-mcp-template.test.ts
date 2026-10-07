import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
import { companyService } from "../services/companies.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { managedInstallCheck } from "../services/default-mcp-install-gate.js";
import { cloneTemplateAccess } from "../services/default-mcp-setup.js";
import type { Db } from "@paperclipai/db";
import {
  COMMS_BOARD_REVIEWED_TOOLS,
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_TEMPLATE_UID,
  installAppliesToAgent,
  isManagedDedicated,
  isManagedTemplate,
  readDefaultMcpState,
  readTemplateClaim,
} from "../services/default-mcp-spec.js";
import {
  DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  __resetDefaultMcpTemplateScopeForTests,
  captureDefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import {
  DEFAULT_MCP_TEMPLATE_SECRET_KEY,
  __resetCompanyTemplateDeferralsForTests,
  configureDefaultMcpTemplateRuntime,
  ensureCompanyTemplate,
  managedTemplateUsability,
  verifyTemplateReady,
  scheduleCompanyTemplateEnsure,
  sweepCompanyTemplates,
  waitForScheduledCompanyTemplates,
  type DefaultMcpTemplateContext,
} from "../services/default-mcp-template.js";
import {
  runDefaultMcpSetupForAgent,
  startDefaultMcpSetupSweep,
  sweepDefaultMcpSetups,
  waitForScheduledDefaultMcpSetups,
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
  boardResponse,
  clearBootProvisionerSnapshot,
  installBootProvisionerSnapshot,
} from "./helpers/comms-board-downstream.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";
const TEMPLATE_TOKEN = "template-token-SECRET-value-0123456789";
const RESTRICTED_TOOLS = [
  "comms_register",
  "comms_admin_register",
  "comms_deregister_agent",
  "comms_set_agent_shared",
  "comms_archive_conversation",
  "comms_reopen_conversation",
  "proposals_submit",
  "proposals_get",
  "proposals_withdraw",
];
const ALL_BOARD_TOOLS = [...COMMS_BOARD_REVIEWED_TOOLS, ...RESTRICTED_TOOLS];

interface MintCall {
  sub: string;
  ownerEmail: string;
  scopes: string[];
  expires: number;
  authorization: string | null;
}

/** One fetch for every downstream: ownership API, board JSON-RPC (handshake, tools/list, admin register). */
function makeFetch(
  opts: {
    mint?: (call: MintCall) => Response | Promise<Response> | "throw";
    tools?: () => string[];
    toolsListGate?: () => Promise<void>;
  } = {},
) {
  const calls = {
    mints: [] as MintCall[],
    toolsList: [] as Array<{ authorization: string | null }>,
    registers: [] as string[],
    urls: [] as string[],
  };
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.urls.push(url);
    const headers = new Headers(init.headers as HeadersInit | undefined);
    if (url === `${OWNERSHIP_URL}/agents`) {
      const body = JSON.parse(init.body as string);
      const call: MintCall = {
        sub: body.sub,
        ownerEmail: body.owner_email,
        scopes: body.scopes,
        expires: body.expires_in_days,
        authorization: headers.get("authorization"),
      };
      calls.mints.push(call);
      const planned = opts.mint ? await opts.mint(call) : null;
      if (planned === "throw") throw new Error("network down");
      if (planned) return planned;
      return new Response(
        JSON.stringify({
          sub: body.sub,
          owner_email: body.owner_email,
          active: true,
          token: body.scopes.length === 1 ? TEMPLATE_TOKEN : BOARD_TOKEN,
          token_expires_at: "2027-10-07T00:00:00+00:00",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (url === BOARD_URL) {
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      const body = JSON.parse(init.body as string);
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "board", version: "1" } } }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-board-test" } },
        );
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        calls.toolsList.push({ authorization: headers.get("authorization") });
        if (calls.toolsList.length === 1 && opts.toolsListGate) await opts.toolsListGate();
        const tools = (opts.tools ? opts.tools() : ALL_BOARD_TOOLS).map((name) => ({
          name,
          description: `${name} description`,
          inputSchema: { type: "object", properties: {} },
        }));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.method === "tools/call") {
        calls.registers.push(body.params.arguments.sub);
        return boardResponse(body.params.arguments.sub);
      }
    }
    throw new Error(`unexpected request ${url}`);
  });
  return Object.assign(fn, { calls });
}

describeEmbeddedPostgres("managed company template for the default MCP spec (TECH-7271)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-template-${randomUUID()}`);
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
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-template");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
    __resetCompanyTemplateDeferralsForTests();
    __resetDefaultMcpTemplateScopeForTests();
    configureDefaultMcpTemplateRuntime({});
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    __resetDefaultMcpTemplateScopeForTests();
    configureDefaultMcpTemplateRuntime({});
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

  // ---- harness ------------------------------------------------------------------------------

  function enableFeature() {
    process.env[FEATURE_ENV] = "true";
    // Boot-frozen rollout scope (first capture wins): unset means every company. Scope tests reset and re-capture.
    captureDefaultMcpTemplateScope({});
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
  }

  /** Everything the module needs, with discovery and the ownership POST both routed to the fixture. */
  function ctxFor(fetchMock: ReturnType<typeof makeFetch>, overrides: Partial<DefaultMcpTemplateContext> = {}): DefaultMcpTemplateContext {
    return {
      db,
      fetchImpl: fetchMock,
      scope: { mode: "all" },
      toolAccessOptions: {
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: async (url, init) => fetchMock(url, init),
      },
      ...overrides,
    };
  }

  async function seedCompany(opts: { status?: "active" | "paused" | "archived"; defaultResponsibleUserId?: string | null } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: opts.status ?? "active",
      defaultResponsibleUserId: opts.defaultResponsibleUserId ?? null,
    });
    return companyId;
  }

  async function seedMember(
    companyId: string,
    opts: {
      email?: string;
      verified?: boolean;
      role?: string | null;
      principalType?: "user" | "agent";
      createdAt?: Date;
      status?: string;
      noUserRow?: boolean;
    } = {},
  ) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    if (!opts.noUserRow) {
      await db.insert(authUsers).values({
        id: userId,
        name: "Member",
        email: opts.email ?? `${userId}@redesignhealth.com`,
        emailVerified: opts.verified ?? true,
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.insert(companyMemberships).values({
      companyId,
      principalType: opts.principalType ?? "user",
      principalId: userId,
      status: opts.status ?? "active",
      membershipRole: opts.role === undefined ? "owner" : opts.role,
      createdAt: opts.createdAt ?? now,
    });
    return userId;
  }

  const templateRow = (companyId: string) =>
    db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.uid, DEFAULT_MCP_TEMPLATE_UID)))
      .then((rows) => rows[0] ?? null);
  const claimOf = async (companyId: string) => readTemplateClaim((await templateRow(companyId))?.config);
  const connectionsOf = (companyId: string) => db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
  const catalogOf = (connectionId: string) => db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
  const installsOf = (connectionId: string) => db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId));
  const profileOf = (connectionId: string) =>
    db
      .select()
      .from(toolProfiles)
      .where(eq(toolProfiles.profileKey, `app:${connectionId}`))
      .then((rows) => rows[0] ?? null);
  const secretsOf = (companyId: string) => db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
  const rowCounts = async (companyId: string) => ({
    connections: (await connectionsOf(companyId)).length,
    applications: (await db.select().from(toolApplications).where(eq(toolApplications.companyId, companyId))).length,
    secrets: (await secretsOf(companyId)).length,
    profiles: (await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId))).length,
    bindings: (await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))).length,
    installs: (await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId))).length,
    catalog: (await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, companyId))).length,
  });

  /** A fully provisioned company: owner + ready template. */
  async function readyCompany(opts: { fetchMock?: ReturnType<typeof makeFetch> } = {}) {
    enableFeature();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    const fetchMock = opts.fetchMock ?? makeFetch();
    const outcome = await ensureCompanyTemplate(ctxFor(fetchMock), { companyId });
    expect(outcome).toEqual({ kind: "ready" });
    return { companyId, ownerId, fetchMock, template: (await templateRow(companyId))! };
  }

  async function createAgent(companyId: string, ownerUserId: string | null) {
    const created = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    return created;
  }
  const agentEntry = async (agentId: string) => {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return readDefaultMcpState(row!.metadata)!.entries["comms-board"]!;
  };

  // ---- ready path ---------------------------------------------------------------------------

  it("provisions a verified read-only template for an existing active company with exactly one comms:read mint", async () => {
    enableFeature();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId, { email: "Owner@RedesignHealth.com" });
    const fetchMock = makeFetch();
    const logSpies = (["info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(logger, level));

    const outcome = await ensureCompanyTemplate(ctxFor(fetchMock), { companyId });

    expect(outcome).toEqual({ kind: "ready" });
    // The mint: ONE POST, comms:read only, 365 days, the company subject, the verified owner, the ownership token.
    expect(fetchMock.calls.mints).toEqual([
      {
        sub: `paperclip-company-template-${companyId}`,
        ownerEmail: "owner@redesignhealth.com",
        scopes: ["comms:read"],
        expires: 365,
        authorization: `Bearer ${OWNERSHIP_TOKEN}`,
      },
    ]);
    expect(`paperclip-company-template-${companyId}`).toHaveLength(63);
    // No board admin registration and no admin credential anywhere.
    expect(fetchMock.calls.registers).toEqual([]);
    for (const call of fetchMock.mock.calls) expect(JSON.stringify(call)).not.toContain(BOARD_ADMIN_TOKEN);
    // Discovery carried the freshly minted template token as the Authorization header.
    expect(fetchMock.calls.toolsList).toEqual([{ authorization: `Bearer ${TEMPLATE_TOKEN}` }]);

    const template = (await templateRow(companyId))!;
    expect(template).toMatchObject({
      name: "rh-comms-board",
      uid: DEFAULT_MCP_TEMPLATE_UID,
      transport: "mcp_remote",
      authKind: "api_key",
      credentialPolicy: "shared",
      status: "active",
      enabled: true,
    });
    expect(isManagedTemplate(template.config)).toBe(true);
    expect(template.config).toMatchObject({ url: BOARD_URL, mcpSessionRequired: true, quarantineNewEntries: true });
    expect(template.transportConfig).toMatchObject({ url: BOARD_URL });
    expect(readTemplateClaim(template.transportConfig)).toBeNull();
    const claim = readTemplateClaim(template.config)!;
    expect(claim).toMatchObject({
      version: 1,
      entryKey: "comms-board",
      principalSub: `paperclip-company-template-${companyId}`,
      ownerUserId: ownerId,
      ownerEmailNorm: "owner@redesignhealth.com",
      state: "ready",
      reason: null,
      attemptCount: 1,
      claimId: null,
      leaseUntil: null,
      allowlistVersion: 1,
      tokenExpiresAt: "2027-10-07T00:00:00+00:00",
    });
    expect(claim.mintAttemptedAt).toEqual(expect.any(String));
    expect(claim.readyAt).toEqual(expect.any(String));

    // Vault: the token lives only in the encrypted secret store.
    const [secret] = await secretsOf(companyId);
    expect(secret).toMatchObject({ key: DEFAULT_MCP_TEMPLATE_SECRET_KEY, provider: "local_encrypted", id: claim.secretId });
    expect(template.credentialRefs).toEqual([
      { name: "credentials.authorization", secretId: secret!.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " },
    ]);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, template.id))).toHaveLength(1);

    // Catalog: the 15 reviewed actions are ACTIVE+reviewed, everything else DISABLED.
    const catalog = await catalogOf(template.id);
    expect(catalog).toHaveLength(ALL_BOARD_TOOLS.length);
    const active = catalog.filter((entry) => entry.status === "active");
    expect(active.map((entry) => entry.toolName).sort()).toEqual([...COMMS_BOARD_REVIEWED_TOOLS].sort());
    expect(COMMS_BOARD_REVIEWED_TOOLS).toHaveLength(15);
    expect(active.every((entry) => entry.reviewedAt !== null)).toBe(true);
    expect(catalog.filter((entry) => entry.status === "disabled").map((entry) => entry.toolName).sort()).toEqual([...RESTRICTED_TOOLS].sort());

    // Default-deny profile with exactly the allowlisted includes, and NO bindings / installs.
    const profile = (await profileOf(template.id))!;
    expect(profile).toMatchObject({ defaultAction: "deny", status: "active" });
    const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    expect(entries.map((entry) => entry.catalogEntryId).sort()).toEqual(active.map((entry) => entry.id).sort());
    expect(entries.every((entry) => entry.selectorType === "catalog_entry" && entry.effect === "include")).toBe(true);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))).toHaveLength(0);
    expect(await installsOf(template.id)).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, template.id))).toHaveLength(0);

    // The raw token is never logged or put in activity, claim, config or the connection row.
    const logged = JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(TEMPLATE_TOKEN);
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(activity.some((row) => row.action === "company.default_mcp_template")).toBe(true);
    expect(JSON.stringify(activity)).not.toContain(TEMPLATE_TOKEN);
    expect(JSON.stringify(template)).not.toContain(TEMPLATE_TOKEN);
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "ready" });
    expect(fetchMock.calls.mints).toHaveLength(1);
  });

  it("owner policy: defaultResponsibleUserId when eligible, else the earliest verified owner; ineligible owners never fetch", async () => {
    enableFeature();
    // defaultResponsible is an eligible later owner: it wins.
    const a = await seedCompany();
    await seedMember(a, { email: "first@x.com", createdAt: new Date("2026-01-01") });
    const preferred = await seedMember(a, { email: "Preferred@x.com", createdAt: new Date("2026-03-01") });
    await db.update(companies).set({ defaultResponsibleUserId: preferred }).where(eq(companies.id, a));
    const fa = makeFetch();
    expect(await ensureCompanyTemplate(ctxFor(fa), { companyId: a })).toEqual({ kind: "ready" });
    expect(fa.calls.mints[0]!.ownerEmail).toBe("preferred@x.com");
    expect((await claimOf(a))!.ownerUserId).toBe(preferred);

    // defaultResponsible is NOT an owner member: earliest owner (ties broken by principal id).
    const b = await seedCompany({ defaultResponsibleUserId: "not-a-member" });
    const earliest = await seedMember(b, { email: "earliest@x.com", createdAt: new Date("2026-01-01") });
    await seedMember(b, { email: "later@x.com", createdAt: new Date("2026-02-01") });
    await seedMember(b, { email: "admin@x.com", role: "admin", createdAt: new Date("2025-01-01") });
    const fb = makeFetch();
    expect(await ensureCompanyTemplate(ctxFor(fb), { companyId: b })).toEqual({ kind: "ready" });
    expect(fb.calls.mints[0]!.ownerEmail).toBe("earliest@x.com");
    expect((await claimOf(b))!.ownerUserId).toBe(earliest);

    // No eligible owner: unverified, empty email, agent principal, non-owner role, inactive, no user row. Never fetch.
    const c = await seedCompany();
    await seedMember(c, { verified: false });
    await seedMember(c, { email: "   " });
    await seedMember(c, { principalType: "agent" });
    await seedMember(c, { role: "member" });
    await seedMember(c, { status: "suspended" });
    await seedMember(c, { noUserRow: true });
    const fc = makeFetch();
    const before = await rowCounts(c);
    expect(await ensureCompanyTemplate(ctxFor(fc), { companyId: c })).toEqual({ kind: "waiting", reason: "owner_required" });
    expect(fc).not.toHaveBeenCalled();
    expect(await rowCounts(c)).toEqual(before);
    expect(await templateRow(c)).toBeNull();
  });

  it("paused companies are eligible; archived companies are skipped until reactivated", async () => {
    enableFeature();
    const paused = await seedCompany({ status: "paused" });
    await seedMember(paused);
    const archived = await seedCompany({ status: "archived" });
    await seedMember(archived);
    const fetchMock = makeFetch();
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: paused })).toEqual({ kind: "ready" });
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: archived })).toEqual({ kind: "skipped", reason: "company_archived" });
    expect(await templateRow(archived)).toBeNull();
    expect(await connectionsOf(archived)).toHaveLength(0);
    // The sweep never selects the archived company either.
    __resetCompanyTemplateDeferralsForTests();
    await sweepCompanyTemplates(ctxFor(fetchMock));
    expect(await templateRow(archived)).toBeNull();

    // Reactivation (through the real company service) schedules the ensure after its commit, using the
    // production wiring: the boot-frozen scope and the runtime tool-access options.
    captureDefaultMcpTemplateScope({});
    configureDefaultMcpTemplateRuntime({ toolAccessOptions: ctxFor(fetchMock).toolAccessOptions });
    vi.stubGlobal("fetch", fetchMock);
    await companyService(db).update(archived, { status: "active" });
    await waitForScheduledCompanyTemplates();
    expect((await claimOf(archived))!.state).toBe("ready");
    expect(fetchMock.calls.mints.filter((mint) => mint.sub.endsWith(archived))).toHaveLength(1);
  });

  it("a company created through the service is provisioned by the create hook and the durable backstop, even when the owner arrives late", async () => {
    enableFeature();
    const fetchMock = makeFetch();
    vi.stubGlobal("fetch", fetchMock);
    captureDefaultMcpTemplateScope({});
    configureDefaultMcpTemplateRuntime({ toolAccessOptions: ctxFor(fetchMock).toolAccessOptions });
    const created = await companyService(db).create({ name: `Hooked ${randomUUID().slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await waitForScheduledCompanyTemplates();
    // The create hook ran BEFORE the creator's owner membership existed: it waits, calling nothing.
    expect(await templateRow(created.id)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // The owner is added; the durable sweep (its in-process spacing elapsed) completes it.
    await seedMember(created.id);
    expect(await sweepCompanyTemplates(ctxFor(fetchMock, { now: () => new Date(Date.now() + 60_000) }))).toBeGreaterThanOrEqual(1);
    expect((await claimOf(created.id))!.state).toBe("ready");
    expect(fetchMock.calls.mints.filter((mint) => mint.sub.endsWith(created.id))).toHaveLength(1);

    // With the frozen scope `none`, the same hook does nothing at all.
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: "" });
    const unscoped = await companyService(db).create({ name: `Unscoped ${randomUUID().slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await waitForScheduledCompanyTemplates();
    await seedMember(unscoped.id);
    scheduleCompanyTemplateEnsure(db, { companyId: unscoped.id });
    await waitForScheduledCompanyTemplates();
    expect(await templateRow(unscoped.id)).toBeNull();
  });

  // ---- collisions / adoption ----------------------------------------------------------------

  async function seedUserTemplate(companyId: string, opts: { authKind?: "api_key" | "oauth"; status?: "active" | "draft"; name?: string; appType?: "mcp_http" | "mcp_stdio" } = {}) {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${randomUUID().slice(0, 6)}`, type: opts.appType ?? "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const shared = await secretService(db).create(companyId, { name: `shared ${randomUUID()}`, key: `shared.${randomUUID()}`, provider: "local_encrypted", value: "org-shared-token" });
    const apiKey = (opts.authKind ?? "api_key") === "api_key";
    return db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name: opts.name ?? "rh-comms-board",
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind: opts.authKind ?? "api_key",
        credentialPolicy: apiKey ? "shared" : "per_user",
        status: opts.status ?? "active",
        enabled: true,
        config: { url: "https://8.8.8.8/mcp" },
        transportConfig: { url: "https://8.8.8.8/mcp" },
        credentialRefs: apiKey ? [{ name: "credentials.authorization", secretId: shared.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }] : [],
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("adopts exactly one valid user-managed template unchanged: no writes, secrets, profiles, bindings or installs, and no fetch", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    const userTemplate = await seedUserTemplate(companyId);
    const fetchMock = makeFetch();
    const before = { counts: await rowCounts(companyId), row: await connectionsOf(companyId) };

    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "adopted" });
    expect(await sweepCompanyTemplates(ctxFor(fetchMock))).toBe(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rowCounts(companyId)).toEqual(before.counts);
    expect(await connectionsOf(companyId)).toEqual(before.row);
    expect(await templateRow(companyId)).toBeNull();
    expect(isManagedTemplate(userTemplate.config)).toBe(false);
  });

  it("collisions fail closed: ambiguous, malformed, a reserved uid without the marker, and a foreign application insert and mint nothing", async () => {
    enableFeature();
    const fetchMock = makeFetch();

    const ambiguous = await seedCompany();
    await seedMember(ambiguous);
    await seedUserTemplate(ambiguous);
    await seedUserTemplate(ambiguous);
    const malformedOauth = await seedCompany();
    await seedMember(malformedOauth);
    await seedUserTemplate(malformedOauth, { authKind: "oauth" });
    const draftOnly = await seedCompany();
    await seedMember(draftOnly);
    await seedUserTemplate(draftOnly, { status: "draft" });
    const forgedUid = await seedCompany();
    await seedMember(forgedUid);
    const forged = await seedUserTemplate(forgedUid, { name: "something-else" });
    await db.update(toolConnections).set({ uid: DEFAULT_MCP_TEMPLATE_UID }).where(eq(toolConnections.id, forged.id));
    const foreignApp = await seedCompany();
    await seedMember(foreignApp);
    await db.insert(toolApplications).values({ companyId: foreignApp, applicationKey: "rh-comms-board", name: "rh-comms-board", type: "mcp_stdio", status: "active" });

    const snapshot = async (id: string) => ({ counts: await rowCounts(id), rows: await connectionsOf(id) });
    const before = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
    for (const id of [ambiguous, malformedOauth, draftOnly, forgedUid, foreignApp]) before.set(id, await snapshot(id));

    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: ambiguous })).toEqual({ kind: "collision", reason: "template_ambiguous" });
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: malformedOauth })).toEqual({ kind: "collision", reason: "template_unsupported" });
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: draftOnly })).toEqual({ kind: "collision", reason: "template_unsupported" });
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: forgedUid })).toEqual({ kind: "collision", reason: "template_unsupported" });
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: foreignApp })).toEqual({ kind: "collision", reason: "template_unsupported" });

    expect(fetchMock).not.toHaveBeenCalled();
    for (const [id, snap] of before) expect(await snapshot(id)).toEqual(snap);
  });

  it("an operator-archived template is terminal (revoked) and is never recreated or re-minted", async () => {
    const { companyId, fetchMock, template } = await readyCompany();
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, template.id));
    const counts = await rowCounts(companyId);
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "revoked" });
    __resetCompanyTemplateDeferralsForTests();
    expect(await sweepCompanyTemplates(ctxFor(fetchMock))).toBe(0);
    expect(await rowCounts(companyId)).toEqual(counts);
    expect(fetchMock.calls.mints).toHaveLength(1);
  });

  // ---- concurrency / lease -------------------------------------------------------------------

  it("parallel ensures create one row and send one POST", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    const fetchMock = makeFetch();
    const outcomes = await Promise.all([1, 2, 3, 4].map(() => ensureCompanyTemplate(ctxFor(fetchMock), { companyId })));
    expect(outcomes.filter((outcome) => outcome.kind === "ready")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "not_claimed")).toHaveLength(3);
    expect(fetchMock.calls.mints).toHaveLength(1);
    expect(fetchMock.calls.toolsList).toHaveLength(1);
    expect((await connectionsOf(companyId)).filter((row) => row.uid === DEFAULT_MCP_TEMPLATE_UID)).toHaveLength(1);
    expect((await db.select().from(toolApplications).where(eq(toolApplications.companyId, companyId)))).toHaveLength(1);
    expect(await secretsOf(companyId)).toHaveLength(1);
  });

  it("a lease loser cannot write: the takeover owns the outcome and the stale worker is a no-op", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = makeFetch({ toolsListGate: () => gate });
    const first = ensureCompanyTemplate(ctxFor(slow), { companyId });
    for (let i = 0; i < 200 && slow.calls.toolsList.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(slow.calls.toolsList).toHaveLength(1);
    const staleClaimId = (await claimOf(companyId))!.claimId;

    // The lease expires; a second worker takes over and finishes (the mint was checkpointed: no second POST).
    await db.execute(sql`update tool_connections set config = jsonb_set(config, '{defaultMcpTemplate,leaseUntil}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text)) where company_id = ${companyId}`);
    const fast = makeFetch();
    expect(await ensureCompanyTemplate(ctxFor(fast), { companyId })).toEqual({ kind: "ready" });
    expect(fast.calls.mints).toHaveLength(0);
    const readyClaim = (await claimOf(companyId))!;
    expect(readyClaim.claimId).toBeNull();
    expect(readyClaim.claimId).not.toBe(staleClaimId);

    release();
    expect(await first).toEqual({ kind: "not_claimed" });
    // The stale worker changed neither the claim nor the activation.
    expect(await claimOf(companyId)).toEqual(readyClaim);
    expect((await templateRow(companyId))!.status).toBe("active");
    expect(slow.calls.mints).toHaveLength(1);
  });

  // ---- mint outcomes ------------------------------------------------------------------------

  it("an unknown mint outcome is terminal: HTTP 500 and a network failure are never retried or rotated", async () => {
    enableFeature();
    const serverError = await seedCompany();
    await seedMember(serverError);
    const networkError = await seedCompany();
    await seedMember(networkError);
    const fetch500 = makeFetch({ mint: () => new Response("boom", { status: 500 }) });
    const fetchDown = makeFetch({ mint: () => "throw" });

    expect(await ensureCompanyTemplate(ctxFor(fetch500), { companyId: serverError })).toEqual({ kind: "error", reason: "mint_unknown" });
    expect(await ensureCompanyTemplate(ctxFor(fetchDown), { companyId: networkError })).toEqual({ kind: "error", reason: "mint_unknown" });
    for (const id of [serverError, networkError]) {
      expect(await claimOf(id)).toMatchObject({ state: "error", reason: "mint_unknown", mintAttemptedAt: expect.any(String), secretId: null });
      expect(await secretsOf(id)).toHaveLength(0);
    }
    // A later sweep and a later ensure make NO further calls.
    const after = makeFetch();
    __resetCompanyTemplateDeferralsForTests();
    await sweepCompanyTemplates(ctxFor(after, { now: () => new Date(Date.now() + 3 * 3_600_000) }));
    expect(await ensureCompanyTemplate(ctxFor(after), { companyId: serverError })).toEqual({ kind: "error", reason: "mint_unknown" });
    expect(after).not.toHaveBeenCalled();
    expect(fetch500.calls.mints).toHaveLength(1);
    expect(fetchDown.calls.mints).toHaveLength(1);
  });

  it("a 409 is terminal ownership_conflict and never rotates", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    const fetchMock = makeFetch({ mint: () => new Response("{}", { status: 409 }) });
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "error", reason: "ownership_conflict" });
    __resetCompanyTemplateDeferralsForTests();
    await sweepCompanyTemplates(ctxFor(fetchMock, { now: () => new Date(Date.now() + 3 * 3_600_000) }));
    expect(fetchMock.calls.mints).toHaveLength(1);
    expect(await claimOf(companyId)).toMatchObject({ state: "error", reason: "ownership_conflict", secretId: null });
    expect(fetchMock.calls.toolsList).toHaveLength(0);
  });

  it("a definitive 401 clears the checkpoint and retries with backoff; a later success completes with a second POST", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    let refuse = true;
    const fetchMock = makeFetch({ mint: () => (refuse ? new Response("{}", { status: 401 }) : null) as Response });
    const start = new Date();
    expect(await ensureCompanyTemplate(ctxFor(fetchMock, { now: () => start }), { companyId })).toEqual({ kind: "pending", reason: "ownership_rejected" });
    const pending = (await claimOf(companyId))!;
    expect(pending).toMatchObject({ state: "pending", reason: "ownership_rejected", mintAttemptedAt: null, secretId: null, attemptCount: 1 });
    expect(Date.parse(pending.nextAttemptAt!)).toBeGreaterThan(start.getTime());
    expect(await secretsOf(companyId)).toHaveLength(0);

    // Not due yet: the sweep does nothing.
    expect(await sweepCompanyTemplates(ctxFor(fetchMock, { now: () => start }))).toBe(0);
    expect(fetchMock.calls.mints).toHaveLength(1);
    // Due, and the issuer now accepts: one more POST, then ready.
    refuse = false;
    const later = new Date(start.getTime() + 3_600_000);
    expect(await sweepCompanyTemplates(ctxFor(fetchMock, { now: () => later }))).toBe(1);
    expect(fetchMock.calls.mints).toHaveLength(2);
    expect(await claimOf(companyId)).toMatchObject({ state: "ready", attemptCount: 2, mintAttemptedAt: expect.any(String) });
  });

  it("repeated definitive refusals exhaust the bounded retry budget into a terminal error", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    const fetchMock = makeFetch({ mint: () => new Response("{}", { status: 422 }) });
    let at = Date.now();
    let last: Awaited<ReturnType<typeof ensureCompanyTemplate>> | null = null;
    for (let i = 0; i < 10; i += 1) {
      at += 2 * 3_600_000;
      last = await ensureCompanyTemplate(ctxFor(fetchMock, { now: () => new Date(at) }), { companyId });
      if (last.kind === "error") break;
    }
    expect(last).toEqual({ kind: "error", reason: "ownership_failed" });
    expect(fetchMock.calls.mints).toHaveLength(8);
    const calls = fetchMock.calls.mints.length;
    await ensureCompanyTemplate(ctxFor(fetchMock, { now: () => new Date(at + 10 * 3_600_000) }), { companyId });
    expect(fetchMock.calls.mints).toHaveLength(calls);
  });

  it("adopts only a provably owned stored secret after a crash between storing and checkpointing the token", async () => {
    enableFeature();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    const first = makeFetch({ mint: () => new Response("{}", { status: 401 }) });
    await ensureCompanyTemplate(ctxFor(first), { companyId });
    const claim = (await claimOf(companyId))!;
    // Simulate the crash window: the attempt is checkpointed, the secret was stored, its id never recorded.
    const attemptedAt = new Date(Date.now() - 1000);
    await db.execute(sql`update tool_connections set config = jsonb_set(jsonb_set(config, '{defaultMcpTemplate,mintAttemptedAt}', to_jsonb(${attemptedAt.toISOString()}::text)), '{defaultMcpTemplate,nextAttemptAt}', 'null'::jsonb) where company_id = ${companyId}`);
    const stored = await secretService(db).create(
      companyId,
      { name: "orphan", key: DEFAULT_MCP_TEMPLATE_SECRET_KEY, provider: "local_encrypted", value: TEMPLATE_TOKEN, description: `Managed default-MCP comms-board template token for ${claim.principalSub}. Read-only discovery credential provisioned by Paperclip.` },
      { userId: ownerId },
    );

    const second = makeFetch();
    expect(await ensureCompanyTemplate(ctxFor(second), { companyId })).toEqual({ kind: "ready" });
    expect(second.calls.mints).toHaveLength(0);
    const adopted = (await claimOf(companyId))!;
    expect(adopted.secretId).toBe(stored.id);
    // The real expiry was lost with the reply: the conservative lower bound is attempt + 365 days.
    expect(adopted.tokenExpiresAt).toBe(new Date(attemptedAt.getTime() + 365 * 86_400_000).toISOString());
    expect(second.calls.toolsList).toEqual([{ authorization: `Bearer ${TEMPLATE_TOKEN}` }]);
  });

  it("never adopts an untrusted secret: a foreign description, a pre-existing one or none is a terminal mint_unknown", async () => {
    enableFeature();
    for (const variant of ["foreign_description", "predates_attempt", "none"] as const) {
      const companyId = await seedCompany();
      const ownerId = await seedMember(companyId);
      await ensureCompanyTemplate(ctxFor(makeFetch({ mint: () => new Response("{}", { status: 401 }) })), { companyId });
      const claim = (await claimOf(companyId))!;
      const attemptedAt = variant === "predates_attempt" ? new Date(Date.now() + 60_000) : new Date(Date.now() - 1000);
      await db.execute(sql`update tool_connections set config = jsonb_set(jsonb_set(config, '{defaultMcpTemplate,mintAttemptedAt}', to_jsonb(${attemptedAt.toISOString()}::text)), '{defaultMcpTemplate,nextAttemptAt}', 'null'::jsonb) where company_id = ${companyId}`);
      if (variant !== "none") {
        await secretService(db).create(
          companyId,
          { name: "other", key: DEFAULT_MCP_TEMPLATE_SECRET_KEY, provider: "local_encrypted", value: "someone-elses-token", description: variant === "foreign_description" ? "not ours" : `Managed default-MCP comms-board template token for ${claim.principalSub}. Read-only discovery credential provisioned by Paperclip.` },
          { userId: ownerId },
        );
      }
      const fetchMock = makeFetch();
      expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "error", reason: "mint_unknown" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await claimOf(companyId))!.secretId).toBeNull();
    }
  });

  it("a taken vault key refuses BEFORE minting; a store failure after a successful mint is terminal secret_store_failed", async () => {
    enableFeature();
    const taken = await seedCompany();
    const takenOwner = await seedMember(taken);
    await secretService(db).create(taken, { name: "squatter", key: DEFAULT_MCP_TEMPLATE_SECRET_KEY, provider: "local_encrypted", value: "x" }, { userId: takenOwner });
    const fetchTaken = makeFetch();
    expect(await ensureCompanyTemplate(ctxFor(fetchTaken), { companyId: taken })).toEqual({ kind: "error", reason: "secret_store_failed" });
    expect(fetchTaken.calls.mints).toHaveLength(0);

    // The store fails AFTER the mint (the deterministic NAME is taken by an unrelated secret).
    const failing = await seedCompany();
    const failingOwner = await seedMember(failing);
    await secretService(db).create(failing, { name: `Comms Board template token (company ${failing})`, key: "unrelated.key", provider: "local_encrypted", value: "x" }, { userId: failingOwner });
    const fetchFail = makeFetch();
    expect(await ensureCompanyTemplate(ctxFor(fetchFail), { companyId: failing })).toEqual({ kind: "error", reason: "secret_store_failed" });
    expect(fetchFail.calls.mints).toHaveLength(1);
    expect(await claimOf(failing)).toMatchObject({ state: "error", reason: "secret_store_failed", mintAttemptedAt: expect.any(String), secretId: null });
    await ensureCompanyTemplate(ctxFor(fetchFail), { companyId: failing });
    expect(fetchFail.calls.mints).toHaveLength(1);
  });

  it("discovery failure retries without a second mint; an empty reviewed catalog waits as catalog_unreviewed with everything disabled", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    let tools: string[] | "fail" = "fail";
    const base = makeFetch({ tools: () => (tools === "fail" ? [] : tools) });
    const failingFetch = vi.fn(async (url: string, init: RequestInit) => {
      if (tools === "fail" && url === BOARD_URL && String(init.body).includes("tools/list")) return new Response("down", { status: 503 });
      return base(url, init);
    });
    const ctx = (now?: () => Date) => ({
      ...ctxFor(base),
      fetchImpl: failingFetch as never,
      toolAccessOptions: { remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }], remoteHttpRequest: async (url: string, init: RequestInit) => failingFetch(url, init) },
      ...(now ? { now } : {}),
    });
    const start = Date.now();
    expect(await ensureCompanyTemplate(ctx(() => new Date(start)), { companyId })).toEqual({ kind: "pending", reason: "template_discovery_failed" });
    expect(base.calls.mints).toHaveLength(1);
    expect((await templateRow(companyId))!.status).toBe("draft");

    // Only non-reviewed tools exist: all are disabled, the template stays draft, nothing is activated.
    tools = ["comms_register", "proposals_submit"];
    expect(await ensureCompanyTemplate(ctx(() => new Date(start + 3 * 3_600_000)), { companyId })).toEqual({ kind: "pending", reason: "catalog_unreviewed" });
    const template = (await templateRow(companyId))!;
    expect(template.status).toBe("draft");
    expect(template.enabled).toBe(false);
    expect((await catalogOf(template.id)).every((entry) => entry.status === "disabled")).toBe(true);
    expect(await profileOf(template.id)).toBeNull();
    expect(base.calls.mints).toHaveLength(1);

    // The reviewed tools appear: ready, still ONE mint overall.
    tools = [...ALL_BOARD_TOOLS];
    expect(await ensureCompanyTemplate(ctx(() => new Date(start + 9 * 3_600_000)), { companyId })).toEqual({ kind: "ready" });
    expect(base.calls.mints).toHaveLength(1);
  });

  // ---- scope + flag -------------------------------------------------------------------------

  it("scope: global flag OFF, empty (none) and an out-of-list company do nothing and fetch nothing", async () => {
    const companyId = await seedCompany();
    await seedMember(companyId);
    const fetchMock = makeFetch();
    const counts = await rowCounts(companyId);

    // Flag OFF (but configured).
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "skipped", reason: "feature_disabled" });
    expect(await sweepCompanyTemplates(ctxFor(fetchMock))).toBe(0);

    process.env[FEATURE_ENV] = "true";
    expect(await ensureCompanyTemplate(ctxFor(fetchMock, { scope: { mode: "none" } }), { companyId })).toEqual({ kind: "skipped", reason: "out_of_scope" });
    expect(await sweepCompanyTemplates(ctxFor(fetchMock, { scope: { mode: "none" } }))).toBe(0);
    expect(await ensureCompanyTemplate(ctxFor(fetchMock, { scope: { mode: "allowlist", companyIds: [randomUUID()] } }), { companyId })).toEqual({ kind: "skipped", reason: "out_of_scope" });
    // The boot-frozen scope is `none` until bootstrap captures one, and a malformed or empty value is `none`:
    // the production default fails closed and never widens.
    for (const frozen of [undefined, "", "not-a-uuid", `${companyId},*`]) {
      __resetDefaultMcpTemplateScopeForTests();
      if (frozen !== undefined) captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: frozen });
      expect(await ensureCompanyTemplate({ db, fetchImpl: fetchMock }, { companyId })).toEqual({ kind: "skipped", reason: "out_of_scope" });
    }
    // Missing provisioner configuration: waiting, never a fetch.
    clearBootProvisionerSnapshot();
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "skipped", reason: "provisioner_not_configured" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rowCounts(companyId)).toEqual(counts);
  });

  it("scope allowlist provisions only the listed company, including through the sweep", async () => {
    enableFeature();
    const listed = await seedCompany();
    await seedMember(listed);
    const other = await seedCompany();
    await seedMember(other);
    const fetchMock = makeFetch();
    const ctx = ctxFor(fetchMock, { scope: { mode: "allowlist", companyIds: [listed] } });
    expect(await sweepCompanyTemplates(ctx)).toBe(1);
    expect((await claimOf(listed))!.state).toBe("ready");
    expect(await templateRow(other)).toBeNull();
    expect(fetchMock.calls.mints).toHaveLength(1);
  });

  // ---- scope also bounds per-agent register/mint ---------------------------------------------

  /** A company with an org-authored valid template and an agent snapshot taken while the scope is closed. */
  async function seedAgentWithUserTemplate(frozen: string | undefined) {
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    await seedUserTemplate(companyId);
    __resetDefaultMcpTemplateScopeForTests();
    if (frozen !== undefined) captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: frozen });
    const agent = await createAgent(companyId, ownerId);
    return { companyId, agent };
  }
  const agentRow = (agentId: string) => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);

  it("scope none (unset-before-capture, empty or malformed) bounds agent claims, register and mint even with a valid user-managed template", async () => {
    enableFeature();
    for (const frozen of ["", "not-a-uuid", `${randomUUID()},*`, undefined]) {
      const fetchMock = makeFetch();
      vi.stubGlobal("fetch", fetchMock);
      const { companyId, agent } = await seedAgentWithUserTemplate(frozen);
      // The snapshot is local only; nothing was claimed or sent at creation.
      expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", attemptCount: 0, claimId: null, registerAttemptedAt: null, mintAttemptedAt: null });
      const before = { agent: await agentRow(agent.id), counts: await rowCounts(companyId) };
      expect(await sweepDefaultMcpSetups({ db, fetchImpl: fetchMock })).toBe(0);
      await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, now: () => new Date(Date.now() + 3 * 3_600_000) }, { companyId, agentId: agent.id });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await agentRow(agent.id)).toEqual(before.agent);
      expect(await rowCounts(companyId)).toEqual(before.counts);
      expect(await secretsOf(companyId)).toHaveLength(1); // only the org template's own shared secret
    }
  });

  it("an allowlist bounds the agent sweep and run to the listed companies; the unlisted company is untouched, the listed one proceeds", async () => {
    enableFeature();
    const fetchMock = makeFetch();
    vi.stubGlobal("fetch", fetchMock);
    const listed = await seedAgentWithUserTemplate("");
    const unlisted = await seedAgentWithUserTemplate("");
    const unlistedBefore = await agentRow(unlisted.agent.id);
    const listedScope = { mode: "allowlist" as const, companyIds: [listed.companyId] };

    expect(await sweepDefaultMcpSetups({ db, fetchImpl: fetchMock, templateScope: listedScope, now: () => new Date(Date.now() + 3 * 3_600_000) })).toBe(1);
    expect((await agentEntry(listed.agent.id)).setup.state).toBe("ready");
    expect(fetchMock.calls.registers).toEqual([`paperclip-agent-${listed.agent.id}`]);
    expect(fetchMock.calls.mints.map((mint) => mint.sub)).toEqual([`paperclip-agent-${listed.agent.id}`]);

    // A direct run for the unlisted company (the eager path) is bounded by the same predicate.
    await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, templateScope: listedScope, now: () => new Date(Date.now() + 3 * 3_600_000) }, { companyId: unlisted.companyId, agentId: unlisted.agent.id });
    expect(await agentRow(unlisted.agent.id)).toEqual(unlistedBefore);
    expect(fetchMock.calls.registers).toHaveLength(1);
    expect(fetchMock.calls.mints).toHaveLength(1);
  });

  it("the boot-frozen scope (not just an injected one) bounds the scheduled create-time setup; ready entities outside it are left exactly as they are", async () => {
    enableFeature();
    const fetchMock = makeFetch();
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    await seedUserTemplate(companyId);
    // In scope: the scheduled setup provisions the agent through the org template.
    const ready = await createAgent(companyId, ownerId);
    expect((await agentEntry(ready.id)).setup.state).toBe("ready");
    expect(fetchMock.calls.mints).toHaveLength(1);

    // The scope closes. The ready entity's wiring then drifts, which an in-scope run would repair. Out of scope nothing
    // verifies, repairs, claims or calls: the row is byte-identical and nothing is sent.
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: randomUUID() });
    await db.delete(connectionGrants).where(eq(connectionGrants.subjectAgentId, ready.id));
    const before = await agentRow(ready.id);
    await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, now: () => new Date(Date.now() + 3 * 3_600_000) }, { companyId, agentId: ready.id });
    expect(await sweepDefaultMcpSetups({ db, fetchImpl: fetchMock })).toBe(0);
    expect(await agentRow(ready.id)).toEqual(before);
    // A new agent created now (scheduled hook, frozen scope) is snapshotted only: no claim, no register, no mint.
    const calls = fetchMock.mock.calls.length;
    const late = await createAgent(companyId, ownerId);
    expect((await agentEntry(late.id)).setup).toMatchObject({ state: "pending", attemptCount: 0, claimId: null });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("the sweep tick runs the template sweep before the agent sweep under the same flag", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    const fetchMock = makeFetch();
    const stop = startDefaultMcpSetupSweep(db, {
      ...ctxFor(fetchMock),
      templateScope: { mode: "all" },
    } as never);
    try {
      for (let i = 0; i < 200 && !(await claimOf(companyId))?.readyAt; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      stop();
    }
    expect((await claimOf(companyId))!.state).toBe("ready");
    // Flag OFF: the same entry point is a no-op.
    delete process.env[FEATURE_ENV];
    const idle = makeFetch();
    const other = await seedCompany();
    await seedMember(other);
    const stopOff = startDefaultMcpSetupSweep(db, { ...ctxFor(idle), templateScope: { mode: "all" } } as never);
    await new Promise((resolve) => setTimeout(resolve, 200));
    stopOff();
    expect(idle).not.toHaveBeenCalled();
    expect(await templateRow(other)).toBeNull();
  });

  // ---- ready verification: expiry / drift (terminal, never silently re-issued) ---------------

  it("an expired template is terminal template_expired and agents wait; it is never silently re-minted", async () => {
    const { companyId, ownerId, fetchMock, template } = await readyCompany();
    await db.execute(sql`update tool_connections set config = jsonb_set(config, '{defaultMcpTemplate,tokenExpiresAt}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text)) where id = ${template.id}`);
    const expired = (await templateRow(companyId))!;
    expect(await managedTemplateUsability(db, expired)).toEqual({ ok: false, reason: "template_expired" });

    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "error", reason: "template_expired" });
    expect(await claimOf(companyId)).toMatchObject({ state: "error", reason: "template_expired" });
    expect(await managedTemplateUsability(db, (await templateRow(companyId))!)).toEqual({ ok: false, reason: "template_expired" });
    __resetCompanyTemplateDeferralsForTests();
    await sweepCompanyTemplates(ctxFor(fetchMock, { now: () => new Date(Date.now() + 3_600_000) }));
    expect(fetchMock.calls.mints).toHaveLength(1);

    // An agent created now waits with the specific reason and is never cloned from the expired template.
    vi.stubGlobal("fetch", fetchMock);
    const callsBefore = fetchMock.mock.calls.length;
    const agent = await createAgent(companyId, ownerId);
    expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_expired" });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect((await connectionsOf(companyId)).filter((row) => row.credentialPolicy === "per_agent")).toHaveLength(0);
  });

  it("drift (an install row or a profile binding) is reported, never auto-deleted, and the template is not cloned", async () => {
    const { companyId, ownerId, fetchMock, template } = await readyCompany();
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: template.id, targetType: "company", targetId: companyId });
    expect(await managedTemplateUsability(db, template)).toEqual({ ok: false, reason: "template_failed" });
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "error", reason: "template_drift" });
    expect(await installsOf(template.id)).toHaveLength(1); // the user grant is left exactly as found
    expect(await claimOf(companyId)).toMatchObject({ state: "error", reason: "template_drift" });

    // An agent created now never gets a clone from a drifted template: it waits, calling nothing.
    vi.stubGlobal("fetch", fetchMock);
    const callsBefore = fetchMock.mock.calls.length;
    const agent = await createAgent(companyId, ownerId);
    expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_failed" });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect((await connectionsOf(companyId)).filter((row) => row.credentialPolicy === "per_agent")).toHaveLength(0);
  });

  it("a newer reviewed allowlist version re-runs discovery and the review without a new mint", async () => {
    const { companyId, fetchMock } = await readyCompany();
    const bumped = DEFAULT_MCP_SPEC.map((entry) =>
      entry.templateBootstrap ? { ...entry, reviewedTools: { version: 2, allow: COMMS_BOARD_REVIEWED_TOOLS.filter((name) => name !== "comms_extend_conversation") } } : entry,
    );
    expect(await ensureCompanyTemplate(ctxFor(fetchMock, { spec: bumped }), { companyId })).toEqual({ kind: "ready" });
    const template = (await templateRow(companyId))!;
    expect(readTemplateClaim(template.config)).toMatchObject({ state: "ready", allowlistVersion: 2 });
    const catalog = await catalogOf(template.id);
    expect(catalog.find((entry) => entry.toolName === "comms_extend_conversation")!.status).toBe("disabled");
    const profile = (await profileOf(template.id))!;
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).toHaveLength(14);
    expect(fetchMock.calls.mints).toHaveLength(1);
  });

  it("an operator archive that lands AFTER the activation transaction has read the row can never be flipped back to active", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    const fetchMock = makeFetch();
    const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);
    // Pause the review transaction deterministically AFTER it has read the connection: its first catalog write
    // sleeps inside a statement-level trigger, so the archive below is issued while that transaction is open.
    await db.execute(sql`create or replace function sleep_7271_fn() returns trigger language plpgsql as $$ begin perform pg_sleep(1.5); return null; end $$`);
    await db.execute(sql`drop trigger if exists sleep_7271 on tool_catalog_entries`);
    await db.execute(sql`create trigger sleep_7271 before update on tool_catalog_entries for each statement execute function sleep_7271_fn()`);
    try {
      const ensured = ensureCompanyTemplate(ctxFor(fetchMock), { companyId });
      let sleeping = false;
      for (let i = 0; i < 400 && !sleeping; i += 1) {
        const rows: unknown = await db.execute(sql`select 1 as hit from pg_stat_activity where wait_event = 'PgSleep' and query ilike '%tool_catalog_entries%'`);
        sleeping = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])).length > 0;
        if (!sleeping) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(sleeping).toBe(true);
      const template = (await templateRow(companyId))!;
      expect(template.status).toBe("draft"); // not yet activated: the review transaction is still open
      await service.updateConnection(template.id, { status: "archived" } as never);
      await ensured;
    } finally {
      await db.execute(sql`drop trigger if exists sleep_7271 on tool_catalog_entries`);
      await db.execute(sql`drop function if exists sleep_7271_fn()`);
    }
    const archived = (await templateRow(companyId))!;
    // The archive wins whichever side of the lock it landed on: archived, never active, claim never ready.
    expect(archived.status).toBe("archived");
    expect(isManagedTemplate(archived.config)).toBe(true);
    expect(readTemplateClaim(archived.config)!.state).not.toBe("ready");
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "revoked" });
    __resetCompanyTemplateDeferralsForTests();
    expect(await sweepCompanyTemplates(ctxFor(fetchMock))).toBe(0);
    expect(fetchMock.calls.mints).toHaveLength(1);
    expect(await installsOf(archived.id)).toHaveLength(0);
  });

  it("claim writes carry an archived guard: a worker that still holds the claim cannot write, activate or ready an archived row", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = makeFetch({ toolsListGate: () => gate });
    const first = ensureCompanyTemplate(ctxFor(slow), { companyId });
    for (let i = 0; i < 200 && slow.calls.toolsList.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(slow.calls.toolsList).toHaveLength(1);
    // The worker still holds a live in-progress claim when the operator archives (via the service).
    const template = (await templateRow(companyId))!;
    await toolAccessService(db, ctxFor(slow).toolAccessOptions).updateConnection(template.id, { status: "archived" } as never);
    const heldClaim = (await claimOf(companyId))!;
    expect(heldClaim.state).toBe("in_progress");
    release();
    expect(await first).toEqual({ kind: "not_claimed" });
    const after = (await templateRow(companyId))!;
    expect(after).toMatchObject({ status: "archived", enabled: false });
    expect(await claimOf(companyId)).toEqual(heldClaim); // not even the claim fields were touched
    expect(await profileOf(after.id)).toBeNull();
  });

  it("the production sweep upgrades a ready template with a stale allowlist version without a new mint", async () => {
    const { companyId, fetchMock } = await readyCompany();
    const bumped = DEFAULT_MCP_SPEC.map((entry) =>
      entry.templateBootstrap ? { ...entry, reviewedTools: { version: 2, allow: COMMS_BOARD_REVIEWED_TOOLS.filter((name) => name !== "comms_extend_conversation") } } : entry,
    );
    expect(readTemplateClaim((await templateRow(companyId))!.config)!.allowlistVersion).toBe(1);
    const mintsBefore = fetchMock.calls.mints.length;

    // The sweep (the actual production entry point) selects the stale-version ready template and upgrades it.
    expect(await sweepCompanyTemplates(ctxFor(fetchMock, { spec: bumped }))).toBe(1);
    const template = (await templateRow(companyId))!;
    expect(readTemplateClaim(template.config)).toMatchObject({ state: "ready", allowlistVersion: 2 });
    expect(fetchMock.calls.mints).toHaveLength(mintsBefore); // discovery + review only, never a new mint
    expect((await catalogOf(template.id)).find((row) => row.toolName === "comms_extend_conversation")!.status).toBe("disabled");
    expect(await installsOf(template.id)).toHaveLength(0);
    // Idempotent: an up-to-date ready template is no longer selected.
    expect(await sweepCompanyTemplates(ctxFor(fetchMock, { spec: bumped }))).toBe(0);
  });

  // ---- review round 1: profile/catalog immutability, skew, collisions, structure, races ------

  const refusedWith = (fn: () => Promise<unknown>) =>
    fn().then(() => "allowed", (error: { status?: number; details?: { code?: string } }) => `${error.status}:${error.details?.code}`);

  it("the managed template's profile cannot be edited or widened through the service (entries, new-tools review)", async () => {
    const { companyId, fetchMock, template } = await readyCompany();
    const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);
    const profile = (await profileOf(template.id))!;
    const catalog = await catalogOf(template.id);
    const restricted = catalog.find((row) => row.toolName === "comms_register")!;
    const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    const before = JSON.stringify(entries.map((row) => row.id).sort());

    expect(await refusedWith(() => service.addProfileEntry(profile.id, { selectorType: "catalog_entry", effect: "include", catalogEntryId: restricted.id } as never))).toBe("409:managed_template_immutable");
    expect(await refusedWith(() => service.addProfileEntry(profile.id, { selectorType: "connection", effect: "include", connectionId: template.id } as never))).toBe("409:managed_template_immutable");
    expect(await refusedWith(() => service.updateProfileEntry(entries[0]!.id, { effect: "exclude" } as never))).toBe("409:managed_template_immutable");
    expect(await refusedWith(() => service.deleteProfileEntry(entries[0]!.id))).toBe("409:managed_template_immutable");
    expect(await refusedWith(() => service.reviewProfileNewTools(profile.id, { decisions: [{ catalogEntryId: restricted.id, decision: "allow" }] } as never))).toBe("409:managed_template_immutable");

    expect(JSON.stringify((await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).map((row) => row.id).sort())).toBe(before);
    expect((await catalogOf(template.id)).find((row) => row.toolName === "comms_register")!.status).toBe("disabled");
    // Control: an unrelated profile is still editable through the very same paths.
    const [other] = await db.insert(toolProfiles).values({ companyId, profileKey: "custom:x", name: "custom x", defaultAction: "deny" }).returning();
    expect(await refusedWith(() => service.addProfileEntry(other!.id, { selectorType: "tool_name", effect: "include", toolName: "x" } as never))).toBe("allowed");
  });

  it("template drift: an ACTIVE action outside the allowlist or a non-allowlisted profile include is terminal, and no agent is cloned from it", async () => {
    const allowedTools = COMMS_BOARD_REVIEWED_TOOLS;
    for (const mutation of ["active_restricted", "connection_include", "restricted_include"] as const) {
      const { companyId, ownerId, fetchMock, template } = await readyCompany();
      expect(await verifyTemplateReady(db, template, { allowedTools })).toBe("ok");
      const catalog = await catalogOf(template.id);
      const restricted = catalog.find((row) => row.toolName === "comms_register")!;
      const profile = (await profileOf(template.id))!;
      if (mutation === "active_restricted") await db.update(toolCatalogEntries).set({ status: "active" }).where(eq(toolCatalogEntries.id, restricted.id));
      if (mutation === "connection_include") await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "connection", effect: "include", connectionId: template.id });
      if (mutation === "restricted_include") await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "catalog_entry", effect: "include", connectionId: template.id, catalogEntryId: restricted.id });
      const mutated = (await templateRow(companyId))!;
      expect(await verifyTemplateReady(db, mutated, { allowedTools })).toBe("drift");
      expect(await verifyTemplateReady(db, mutated)).toBe("ok"); // the structural checks alone cannot see it: the allowlist check is what catches it
      expect(await managedTemplateUsability(db, mutated, { allowedTools })).toEqual({ ok: false, reason: "template_failed" });

      // An agent created now waits with the real reason and no clone is made.
      vi.stubGlobal("fetch", fetchMock);
      const agent = await createAgent(companyId, ownerId);
      expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_failed" });
      expect((await connectionsOf(companyId)).filter((row) => row.credentialPolicy === "per_agent")).toHaveLength(0);
      // The provisioner records the terminal drift and never repairs or re-mints.
      expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "error", reason: "template_drift" });
      expect(fetchMock.calls.mints.filter((mint) => mint.scopes.length === 1)).toHaveLength(1);
      await db.delete(agents).where(eq(agents.companyId, companyId));
    }
  });

  it("owned secret recovery tolerates a bounded clock skew but never adopts a foreign, pre-existing or other-creator secret", async () => {
    enableFeature();
    const run = async (variant: "skew_10s" | "skew_2min" | "other_creator") => {
      const companyId = await seedCompany();
      const ownerId = await seedMember(companyId);
      const strangerId = await seedMember(companyId, { role: "member" });
      await ensureCompanyTemplate(ctxFor(makeFetch({ mint: () => new Response("{}", { status: 401 }) })), { companyId });
      const claim = (await claimOf(companyId))!;
      // The secret was stored by an earlier crashed attempt; its created_at is the DATABASE clock.
      const stored = await secretService(db).create(
        companyId,
        { name: "stored", key: DEFAULT_MCP_TEMPLATE_SECRET_KEY, provider: "local_encrypted", value: TEMPLATE_TOKEN, description: `Managed default-MCP comms-board template token for ${claim.principalSub}. Read-only discovery credential provisioned by Paperclip.` },
        { userId: variant === "other_creator" ? strangerId : ownerId },
      );
      const [{ createdAt }] = await db.select({ createdAt: companySecrets.createdAt }).from(companySecrets).where(eq(companySecrets.id, stored.id));
      // The app clock is AHEAD of the database clock: the checkpoint is later than the stored secret by exactly the skew.
      const skewMs = variant === "skew_2min" ? 120_000 : 10_000;
      const attemptedAt = new Date(createdAt.getTime() + skewMs);
      await db.execute(sql`update tool_connections set config = jsonb_set(jsonb_set(config, '{defaultMcpTemplate,mintAttemptedAt}', to_jsonb(${attemptedAt.toISOString()}::text)), '{defaultMcpTemplate,nextAttemptAt}', 'null'::jsonb) where company_id = ${companyId}`);
      const fetchMock = makeFetch();
      const outcome = await ensureCompanyTemplate(ctxFor(fetchMock), { companyId });
      return { outcome, fetchMock, claim: await claimOf(companyId) };
    };
    const within = await run("skew_10s");
    expect(within.outcome).toEqual({ kind: "ready" });
    expect(within.fetchMock.calls.mints).toHaveLength(0);
    for (const variant of ["skew_2min", "other_creator"] as const) {
      const rejected = await run(variant);
      expect(rejected.outcome).toEqual({ kind: "error", reason: "mint_unknown" });
      expect(rejected.fetchMock).not.toHaveBeenCalled();
      expect(rejected.claim!.secretId).toBeNull();
    }
  });

  it("our fixed-uid template is not exempt from same-name ambiguity: a second unarchived rh-comms-board is reported with nothing claimed or minted", async () => {
    enableFeature();
    // Ready template + a later same-name connection.
    const ready = await readyCompany();
    await seedUserTemplate(ready.companyId);
    const beforeReady = { claim: await claimOf(ready.companyId), counts: await rowCounts(ready.companyId) };
    expect(await ensureCompanyTemplate(ctxFor(ready.fetchMock), { companyId: ready.companyId })).toEqual({ kind: "collision", reason: "template_ambiguous" });
    expect(await claimOf(ready.companyId)).toEqual(beforeReady.claim);
    expect(await rowCounts(ready.companyId)).toEqual(beforeReady.counts);

    // Pending (not yet minted) template + a same-name connection: no claim, no mint.
    const companyId = await seedCompany();
    await seedMember(companyId);
    const refusing = makeFetch({ mint: () => new Response("{}", { status: 401 }) });
    await ensureCompanyTemplate(ctxFor(refusing), { companyId });
    await seedUserTemplate(companyId);
    const pendingBefore = await claimOf(companyId);
    const fetchMock = makeFetch();
    __resetCompanyTemplateDeferralsForTests();
    expect(await ensureCompanyTemplate(ctxFor(fetchMock, { now: () => new Date(Date.now() + 3 * 3_600_000) }), { companyId })).toEqual({ kind: "collision", reason: "template_ambiguous" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await claimOf(companyId)).toEqual(pendingBefore);
    // An ARCHIVED same-name connection is not a collision.
    const archivedSibling = await seedCompany();
    await seedMember(archivedSibling);
    await ensureCompanyTemplate(ctxFor(makeFetch()), { companyId: archivedSibling });
    const sibling = await seedUserTemplate(archivedSibling);
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, sibling.id));
    expect(await ensureCompanyTemplate(ctxFor(makeFetch()), { companyId: archivedSibling })).toEqual({ kind: "ready" });
  });

  it("a malformed claim fails closed: no work, no fetch, never trusted as ready, and a legitimate pending claim is untouched", async () => {
    enableFeature();
    const { companyId, fetchMock, template } = await readyCompany();
    const valid = (await templateRow(companyId))!.config;
    for (const [label, path] of [["owner email", "ownerEmailNorm"], ["principal sub", "principalSub"], ["entry key", "entryKey"], ["owner id", "ownerUserId"], ["attempt count", "attemptCount"]] as const) {
      await db.execute(sql`update tool_connections set config = ${JSON.stringify(valid)}::jsonb where id = ${template.id}`);
      await db.execute(sql`update tool_connections set config = config #- ARRAY['defaultMcpTemplate', ${path}]::text[] where id = ${template.id}`);
      const broken = (await templateRow(companyId))!;
      expect(readTemplateClaim(broken.config), label).toBeNull();
      expect(await managedTemplateUsability(db, broken)).toEqual({ ok: false, reason: "template_failed" });
      const calls = fetchMock.mock.calls.length;
      expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "collision", reason: "template_unsupported" });
      expect(fetchMock.mock.calls.length).toBe(calls);
    }
    // A legitimate claim in the pending/retry state (a refused mint) remains valid and keeps its retry state.
    const retry = await seedCompany();
    await seedMember(retry);
    await ensureCompanyTemplate(ctxFor(makeFetch({ mint: () => new Response("{}", { status: 401 }) })), { companyId: retry });
    expect(await claimOf(retry)).toMatchObject({ state: "pending", reason: "ownership_rejected", attemptCount: 1 });
  });

  it("an injected empty allowlist selects nothing in either sweep and has no side effects", async () => {
    enableFeature();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    await seedUserTemplate(companyId);
    const agent = await createAgent(companyId, ownerId);
    const company2 = await seedCompany();
    await seedMember(company2);
    const fetchMock = makeFetch();
    const before = { agent: await agentRow(agent.id), counts: await rowCounts(companyId), counts2: await rowCounts(company2) };
    const empty = { mode: "allowlist" as const, companyIds: [] as string[] };
    expect(await sweepCompanyTemplates(ctxFor(fetchMock, { scope: empty }))).toBe(0);
    expect(await sweepDefaultMcpSetups({ db, fetchImpl: fetchMock, templateScope: empty })).toBe(0);
    await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, templateScope: empty }, { companyId, agentId: agent.id });
    expect(await ensureCompanyTemplate(ctxFor(fetchMock, { scope: empty }), { companyId: company2 })).toEqual({ kind: "skipped", reason: "out_of_scope" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await agentRow(agent.id)).toEqual(before.agent);
    expect(await rowCounts(companyId)).toEqual(before.counts);
    expect(await rowCounts(company2)).toEqual(before.counts2);
  });

  it("a template that becomes unusable between the pre-check and the local stage makes the agent WAIT with the real reason, keeps its secret, and finishes later without repeating register or mint", async () => {
    let flip = false;
    let companyIdForFlip = "";
    const fetchMock = makeFetch({
      mint: async (call) => {
        if (flip && call.scopes.length === 2) {
          const [template] = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyIdForFlip), eq(toolConnections.uid, DEFAULT_MCP_TEMPLATE_UID)));
          await db.insert(toolConnectionInstalls).values({ companyId: companyIdForFlip, connectionId: template!.id, targetType: "company", targetId: companyIdForFlip });
        }
        return null as never;
      },
    });
    const { companyId, ownerId, template } = await readyCompany({ fetchMock });
    companyIdForFlip = companyId;
    flip = true;
    vi.stubGlobal("fetch", fetchMock);
    const agent = await createAgent(companyId, ownerId);
    // Drift appeared AFTER the pre-check (during the mint): the stage reports it as a waiting reason, not a failure.
    const waiting = await agentEntry(agent.id);
    expect(waiting.setup).toMatchObject({ state: "pending", reason: "template_failed", attemptCount: 1 });
    expect(waiting.binding?.secretId).toEqual(expect.any(String));
    expect(fetchMock.calls.registers).toEqual([`paperclip-agent-${agent.id}`]);
    expect(fetchMock.calls.mints.filter((mint) => mint.scopes.length === 2)).toHaveLength(1);
    expect((await connectionsOf(companyId)).filter((row) => row.credentialPolicy === "per_agent")).toHaveLength(0);

    // The operator removes the stray install and a new ready-template ensure runs; the agent then finishes locally.
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, template.id));
    await db.execute(sql`update tool_connections set config = jsonb_set(config, '{defaultMcpTemplate,state}', '"ready"'::jsonb) where id = ${template.id}`);
    flip = false;
    await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, now: () => new Date(Date.now() + 3 * 3_600_000) }, { companyId, agentId: agent.id });
    expect((await agentEntry(agent.id)).setup.state).toBe("ready");
    expect(fetchMock.calls.registers).toHaveLength(1);
    expect(fetchMock.calls.mints.filter((mint) => mint.scopes.length === 2)).toHaveLength(1);
  });

  // ---- review round 2 ------------------------------------------------------------------------

  it("every profile mutation path refuses the managed template's profile (update incl. re-key, delete incl. force/reassign, bind), while unmanaged profiles are unaffected", async () => {
    const { companyId, fetchMock, template } = await readyCompany();
    const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);
    const managed = (await profileOf(template.id))!;
    const snapshot = async () => ({
      profile: await profileOf(template.id),
      entries: (await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, managed.id))).map((row) => row.id).sort(),
      bindings: await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId)),
    });
    const before = await snapshot();
    const immutable = "409:managed_template_immutable";

    expect(await refusedWith(() => service.updateProfile(managed.id, { name: "renamed" } as never))).toBe(immutable);
    expect(await refusedWith(() => service.updateProfile(managed.id, { defaultAction: "allow" } as never))).toBe(immutable);
    expect(await refusedWith(() => service.updateProfile(managed.id, { status: "archived" } as never))).toBe(immutable);
    expect(await refusedWith(() => service.updateProfile(managed.id, { entries: [] } as never))).toBe(immutable);
    expect(await refusedWith(() => service.updateProfile(managed.id, { entries: [{ selectorType: "connection", effect: "include", connectionId: template.id }] } as never))).toBe(immutable);
    expect(await refusedWith(() => service.updateProfile(managed.id, { profileKey: "custom:rekeyed" } as never))).toBe(immutable);
    expect(await refusedWith(() => service.deleteProfile(managed.id, { force: true } as never))).toBe(immutable);
    expect(await refusedWith(() => service.deleteProfile(managed.id, {} as never))).toBe(immutable);
    expect(await refusedWith(() => service.bindProfile(managed.id, { targetType: "company", targetId: companyId } as never))).toBe(immutable);
    // Bindings of another profile can never be reassigned ONTO the managed profile either.
    const [other] = await db.insert(toolProfiles).values({ companyId, profileKey: "custom:other", name: "custom other", defaultAction: "deny" }).returning();
    expect(await refusedWith(() => service.deleteProfile(other!.id, { reassignToProfileId: managed.id } as never))).toBe(immutable);
    expect(await snapshot()).toEqual(before);
    expect((await profileOf(template.id))!.profileKey).toBe(`app:${template.id}`);
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "ready" });

    // Controls: the very same operations succeed on an unmanaged profile (nothing here is blanket-blocked).
    const [plain] = await db.insert(toolProfiles).values({ companyId, profileKey: "custom:plain", name: "custom plain", defaultAction: "deny" }).returning();
    const entry = await service.addProfileEntry(plain!.id, { selectorType: "tool_name", effect: "include", toolName: "x" } as never);
    expect(await refusedWith(() => service.updateProfileEntry(entry.id, { toolName: "y" } as never))).toBe("allowed");
    expect(await refusedWith(() => service.bindProfile(plain!.id, { targetType: "company", targetId: companyId } as never))).toBe("allowed");
    expect(await refusedWith(() => service.updateProfile(plain!.id, { name: "renamed", profileKey: "custom:renamed", defaultAction: "allow", entries: [] } as never))).toBe("allowed");
    // The unmanaged update above replaced the entries, so the entry is gone: not found (and nothing else deleted).
    expect(await refusedWith(() => service.deleteProfileEntry(entry.id))).toBe("404:undefined");
    expect(await refusedWith(() => service.deleteProfile(plain!.id, { force: true } as never))).toBe("allowed");
  });

  it("deleteProfileEntry never deletes when the entry is missing or its profile is the managed template's", async () => {
    const { template, fetchMock } = await readyCompany();
    const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);
    const profile = (await profileOf(template.id))!;
    const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    expect(await refusedWith(() => service.deleteProfileEntry(randomUUID()))).toBe("404:undefined");
    expect(await refusedWith(() => service.deleteProfileEntry(entries[0]!.id))).toBe("409:managed_template_immutable");
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).toHaveLength(entries.length);
  });

  it("verifyTemplateReady treats an empty allowlist or an empty profile as drift", async () => {
    const { template } = await readyCompany();
    expect(await verifyTemplateReady(db, template, { allowedTools: COMMS_BOARD_REVIEWED_TOOLS })).toBe("ok");
    expect(await verifyTemplateReady(db, template, { allowedTools: [] })).toBe("drift");
    const profile = (await profileOf(template.id))!;
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    expect(await verifyTemplateReady(db, template, { allowedTools: COMMS_BOARD_REVIEWED_TOOLS })).toBe("drift");
  });

  it("the clone only ever carries the allowlist: non-allowlisted actions are cloned disabled, stray includes are skipped, and a re-run over an existing clone narrows it", async () => {
    const { companyId, template } = await readyCompany();
    const catalog = await catalogOf(template.id);
    const restricted = catalog.find((row) => row.toolName === "comms_register")!;
    const profile = (await profileOf(template.id))!;
    // A mutated template (the guards refuse this through the service, so it is written directly).
    await db.update(toolCatalogEntries).set({ status: "active" }).where(eq(toolCatalogEntries.id, restricted.id));
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "connection", effect: "include", connectionId: template.id });
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "catalog_entry", effect: "include", connectionId: template.id, catalogEntryId: restricted.id });
    const mutated = (await templateRow(companyId))!;
    const service = toolAccessService(db);
    const agentId = randomUUID();
    const dedicated = await db.transaction((tx) =>
      service.cloneConnectionFromTemplate(tx as unknown as Db, mutated, { name: `rh-comms-board:${agentId}`, credentialRefs: mutated.credentialRefs, configOverlay: { mcpSessionRequired: true } }),
    );
    const allow = new Set<string>(COMMS_BOARD_REVIEWED_TOOLS);
    await cloneTemplateAccess(db, mutated, dedicated, agentId, allow);

    const cloneCatalog = await catalogOf(dedicated.id);
    expect(cloneCatalog.find((row) => row.toolName === "comms_register")!.status).toBe("disabled");
    expect(cloneCatalog.filter((row) => row.status === "active").map((row) => row.toolName).sort()).toEqual([...COMMS_BOARD_REVIEWED_TOOLS].sort());
    const cloneProfile = (await profileOf(dedicated.id))!;
    const includes = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, cloneProfile.id));
    expect(includes).toHaveLength(15);
    expect(includes.every((row) => row.selectorType === "catalog_entry" && row.effect === "include")).toBe(true);
    expect(includes.some((row) => row.catalogEntryId === cloneCatalog.find((c) => c.toolName === "comms_register")!.id)).toBe(false);
    expect((await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, cloneProfile.id))).map((b) => `${b.targetType}:${b.targetId}`)).toEqual([`agent:${agentId}`]);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId))).toHaveLength(0);

    // Re-run over an EXISTING clone that was left exposing more (an active outside action and a stray include).
    const cloneRestricted = cloneCatalog.find((row) => row.toolName === "comms_register")!;
    await db.update(toolCatalogEntries).set({ status: "active" }).where(eq(toolCatalogEntries.id, cloneRestricted.id));
    await db.insert(toolProfileEntries).values({ companyId, profileId: cloneProfile.id, selectorType: "connection", effect: "include", connectionId: dedicated.id });
    await db.insert(toolProfileEntries).values({ companyId, profileId: cloneProfile.id, selectorType: "catalog_entry", effect: "include", connectionId: dedicated.id, catalogEntryId: cloneRestricted.id });
    await cloneTemplateAccess(db, mutated, dedicated, agentId, allow);
    expect((await catalogOf(dedicated.id)).find((row) => row.toolName === "comms_register")!.status).toBe("disabled");
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, cloneProfile.id))).toHaveLength(15);

    // An EMPTY allowlist (never "undefined = everything") clones nothing usable.
    await cloneTemplateAccess(db, mutated, dedicated, agentId, new Set());
    expect((await catalogOf(dedicated.id)).filter((row) => row.status === "active")).toEqual([]);
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, cloneProfile.id))).toHaveLength(0);
  });

  it("a managed template without a reviewed allowlist in the spec fails closed: the agent waits template_unsupported and nothing is cloned", async () => {
    const { companyId, ownerId, fetchMock } = await readyCompany();
    const noReview = DEFAULT_MCP_SPEC.map((entry) => (entry.templateBootstrap ? { ...entry, reviewedTools: undefined } : entry));
    vi.stubGlobal("fetch", fetchMock);
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: "" });
    const agent = await createAgent(companyId, ownerId);
    const calls = fetchMock.mock.calls.length;
    await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, spec: noReview, templateScope: { mode: "all" } }, { companyId, agentId: agent.id });
    expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_unsupported" });
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect((await connectionsOf(companyId)).filter((row) => row.credentialPolicy === "per_agent")).toHaveLength(0);
  });

  describe("template becomes unusable AFTER the agent's register/mint", () => {
    async function unusableAfterMint(sabotage: (templateId: string, companyId: string) => Promise<void>) {
      let flip = false;
      let target = { companyId: "", templateId: "" };
      const fetchMock = makeFetch({
        mint: async (call) => {
          if (flip && call.scopes.length === 2) await sabotage(target.templateId, target.companyId);
          return null as never;
        },
      });
      const { companyId, ownerId, template } = await readyCompany({ fetchMock });
      target = { companyId, templateId: template.id };
      flip = true;
      vi.stubGlobal("fetch", fetchMock);
      const agent = await createAgent(companyId, ownerId);
      flip = false;
      return { companyId, agent, fetchMock, template };
    }
    const botCalls = (fetchMock: ReturnType<typeof makeFetch>) => ({
      registers: fetchMock.calls.registers.length,
      mints: fetchMock.calls.mints.filter((mint) => mint.scopes.length === 2).length,
    });

    it("a TERMINAL reason is bounded by the retry budget and ends in error, never repeating register or mint, keeping the stored credential", async () => {
      const { companyId, agent, fetchMock } = await unusableAfterMint(async (templateId, templateCompanyId) => {
        await db.insert(toolConnectionInstalls).values({ companyId: templateCompanyId, connectionId: templateId, targetType: "company", targetId: templateCompanyId });
      });
      expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_failed", attemptCount: 1 });
      expect(botCalls(fetchMock)).toEqual({ registers: 1, mints: 1 });
      let at = Date.now();
      for (let i = 0; i < 12; i += 1) {
        at += 3 * 3_600_000;
        await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, now: () => new Date(at) }, { companyId, agentId: agent.id });
        if ((await agentEntry(agent.id)).setup.state === "error") break;
      }
      const ended = await agentEntry(agent.id);
      expect(ended.setup).toMatchObject({ state: "error", reason: "template_failed", attemptCount: 8 });
      expect(ended.binding?.secretId).toEqual(expect.any(String)); // credential ownership is preserved, not re-minted or dropped
      expect(botCalls(fetchMock)).toEqual({ registers: 1, mints: 1 });
      expect((await connectionsOf(companyId)).filter((row) => row.credentialPolicy === "per_agent")).toHaveLength(0);
    });

    it("a TRANSIENT reason (provisioning) keeps waiting without budget, and the agent finishes when the template is ready again", async () => {
      const { companyId, agent, fetchMock, template } = await unusableAfterMint(async (templateId) => {
        await db.execute(sql`update tool_connections set config = jsonb_set(config, '{defaultMcpTemplate,state}', '"pending"'::jsonb) where id = ${templateId}`);
      });
      expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_provisioning" });
      let at = Date.now();
      for (let i = 0; i < 10; i += 1) {
        at += 3 * 3_600_000;
        await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, now: () => new Date(at) }, { companyId, agentId: agent.id });
      }
      const waiting = await agentEntry(agent.id);
      expect(waiting.setup).toMatchObject({ state: "pending", reason: "template_provisioning" });
      expect(waiting.setup.attemptCount).toBeGreaterThan(8); // not bounded: waiting is not a failure
      expect(botCalls(fetchMock)).toEqual({ registers: 1, mints: 1 });
      await db.execute(sql`update tool_connections set config = jsonb_set(config, '{defaultMcpTemplate,state}', '"ready"'::jsonb) where id = ${template.id}`);
      await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, now: () => new Date(at + 3 * 3_600_000) }, { companyId, agentId: agent.id });
      expect((await agentEntry(agent.id)).setup.state).toBe("ready");
      expect(botCalls(fetchMock)).toEqual({ registers: 1, mints: 1 });
    });
  });

  it("an unexpected local-stage failure is logged by error class only and retried as binding_failed", async () => {
    const { companyId, ownerId, fetchMock } = await readyCompany();
    vi.stubGlobal("fetch", fetchMock);
    // Snapshot only (scope closed), then make the dedicated connection name ambiguous before setup runs.
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: "" });
    const agent = await createAgent(companyId, ownerId);
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.companyId, companyId));
    for (const n of [1, 2]) {
      await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: `rh-comms-board:${agent.id}`, uid: `dup-${n}-${randomUUID()}`, transport: "mcp_remote", authKind: "api_key", credentialPolicy: "per_agent", status: "active", config: {}, transportConfig: {} });
    }
    const warn = vi.spyOn(logger, "warn");
    await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, templateScope: { mode: "all" } }, { companyId, agentId: agent.id });
    expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "binding_failed" });
    const logged = warn.mock.calls.filter(([fields]) => (fields as { errorClass?: string })?.errorClass !== undefined);
    expect(logged.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logged);
    expect(serialized).toContain('"errorClass":"Error"');
    expect(serialized).not.toMatch(/ambiguous|dedicated connection|Bearer|token/i);
    expect(serialized).not.toContain(BOARD_TOKEN);
  });

  // ---- security: refresh paths, install refusal, runtime gates ------------------------------

  it("every refresh path keeps the managed template out of company bindings, quarantines new tools and never recreates a deleted profile", async () => {
    const { companyId, template } = await readyCompany();

    // The profile is deleted, the board grows a brand-new admin tool, then every refresh path runs.
    const profile = (await profileOf(template.id))!;
    await db.delete(toolProfiles).where(eq(toolProfiles.id, profile.id));
    const grown = makeFetch({ tools: () => [...ALL_BOARD_TOOLS, "comms_brand_new_admin_tool"] });
    const grownService = toolAccessService(db, ctxFor(grown).toolAccessOptions);
    await grownService.refreshCatalog(template.id, { actorType: "user", actorId: "ui-user" });
    await grownService.refreshCatalog(template.id, { actorType: "user", actorId: "ui-user" }, { enableAllByDefault: false, restoreDraftDefaults: true });
    await db.update(toolConnections).set({ lastCatalogRefreshAt: new Date(0) }).where(eq(toolConnections.id, template.id));
    await grownService.listCatalog(template.id, companyId); // the 15-minute cache path

    expect(await profileOf(template.id)).toBeNull();
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))).toHaveLength(0);
    const catalog = await catalogOf(template.id);
    expect(catalog.find((entry) => entry.toolName === "comms_brand_new_admin_tool")!.status).toBe("quarantined");
    for (const name of RESTRICTED_TOOLS) expect(catalog.find((entry) => entry.toolName === name)!.status).toBe("disabled");
    // The claim (config) was not rewritten by the stale-object write-back.
    expect(readTemplateClaim((await templateRow(companyId))!.config)).toMatchObject({ state: "ready" });
    expect(isManagedTemplate((await templateRow(companyId))!.config)).toBe(true);
  });

  it("the managed template cannot be installed on any path and is never usable, whatever grants or agent state exist", async () => {
    const { companyId, ownerId, fetchMock, template } = await readyCompany();
    const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);
    // A genuinely legacy agent: created while the feature is off, so it has NO defaultMcp state at all.
    delete process.env[FEATURE_ENV];
    const legacy = await agentService(db).create(
      companyId,
      { name: "legacy", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId: ownerId } },
    );
    expect(readDefaultMcpState((await db.select().from(agents).where(eq(agents.id, legacy.id)))[0]!.metadata)).toBeNull();
    process.env[FEATURE_ENV] = "true";
    const refused = async (fn: () => Promise<unknown>) =>
      fn().then(() => "allowed", (error: { status?: number; details?: { code?: string } }) => `${error.status}:${error.details?.code}`);

    expect(await refused(() => service.putConnectionInstalls(template.id, { installs: [{ targetType: "company", targetId: companyId }] }))).toBe("409:managed_template_not_installable");
    expect(await refused(() => service.putConnectionInstalls(template.id, { installs: [{ targetType: "agent", targetId: legacy.id }] }))).toBe("409:managed_template_not_installable");
    expect(await refused(() => service.putConnectionInstalls(template.id, { installs: [] }))).toBe("allowed");
    expect(await refused(() => service.addAgentConnectionInstall(db, template, legacy.id, undefined, { install: true, bindingSource: "tool_connection_install" }))).toBe("409:managed_template_not_installable");
    expect(await refused(() => service.addAgentConnectionInstall(db, template, legacy.id, undefined, { install: false, bindingSource: "default_mcp_spec" }))).toBe("409:managed_template_not_installable");
    const catalog = await catalogOf(template.id);
    expect(
      await refused(() =>
        service.finishGalleryAppConnection(companyId, template.id, {
          enabledCatalogEntryIds: catalog.filter((entry) => entry.status === "active").map((entry) => entry.id),
          askFirstCatalogEntryIds: [],
          access: "all_agents",
        }),
      ),
    ).toBe("409:managed_template_not_installable");
    expect(await installsOf(template.id)).toHaveLength(0);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))).toHaveLength(0);

    // Even forced rows (a default organization grant, a company profile binding, company + agent installs) grant nothing.
    const profile = (await profileOf(template.id))!;
    await db.insert(connectionGrants).values({ companyId, connectionId: template.id, kind: "organization", credentialSecretRefs: [], status: "active", isDefault: true });
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "company", targetId: companyId });
    await db.insert(toolConnectionInstalls).values([
      { companyId, connectionId: template.id, targetType: "company", targetId: companyId },
      { companyId, connectionId: template.id, targetType: "agent", targetId: legacy.id },
    ]);
    const forced = (await db.select().from(toolConnections).where(eq(toolConnections.id, template.id)))[0]!;
    // Legacy agent (no defaultMcp state at all) and a managed one: the shared rules say "never".
    expect(installAppliesToAgent({ targetType: "company" }, { companyId, state: null }, forced)).toBe(false);
    expect(installAppliesToAgent({ targetType: "agent" }, { companyId, state: null }, forced)).toBe(false);
    expect(installAppliesToAgent({ targetType: "agent" }, { companyId, state: null }, { id: forced.id, companyId, name: forced.name })).toBe(true); // control: the guard is the config marker
    const gate = await managedInstallCheck(db, { companyId, agentId: legacy.id, connections: [forced] });
    expect(gate).toEqual({ agentFound: true, blocked: new Set([template.id]) });
    expect((await service.getEffectiveProfilesForAgent(companyId, legacy.id)).installedConnections.map((c) => c.id)).not.toContain(template.id);

    // The run projection (a gateway over the template's profile) hands the agent nothing.
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, legacy.id));
    await db.insert(toolMcpGateways).values({ companyId, name: "template gateway", slug: `gw-${randomUUID().slice(0, 8)}`, profileId: profile.id, status: "active" });
    expect(
      await createManagedMcpRunConfig({ db, agent: { id: legacy.id, companyId, name: "legacy", adapterType: "codex_local" }, runId: randomUUID(), config: {}, projectId: null, issueId: null }),
    ).toBeNull();

    // Control: the same rows project through the gateway once the server marker is removed, so the null above
    // is the managed-template rule and not an unrelated projection gap.
    await db.execute(sql`update tool_connections set config = config - 'defaultMcpManaged' where id = ${template.id}`);
    const control = await createManagedMcpRunConfig({ db, agent: { id: legacy.id, companyId, name: "legacy", adapterType: "codex_local" }, runId: randomUUID(), config: {}, projectId: null, issueId: null });
    expect(control?.gateways).toHaveLength(1);
    await db.execute(sql`update tool_connections set config = jsonb_set(config, '{defaultMcpManaged}', '"template"'::jsonb) where id = ${template.id}`);

    // Token mint (the runtime install check) is denied installation_required even with the install rows present.
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: legacy.id, status: "running", contextSnapshot: {}, responsibleUserId: ownerId }).returning();
    const minted = await service
      .mintConnectionTokenForAgent({ connectionId: template.id, companyId, agentId: legacy.id, runId: run!.id, body: { scope: "x" } })
      .then(() => "minted", (error: { details?: { code?: string } }) => error.details?.code);
    expect(minted).toBe("installation_required");
  });

  it("the gateway never lists or executes the managed template for a legacy agent, even with company grants, bindings and installs", async () => {
    const { companyId, ownerId, template } = await readyCompany();
    delete process.env[FEATURE_ENV];
    const legacy = await agentService(db).create(
      companyId,
      { name: "legacy", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId: ownerId } },
    );
    const profile = (await profileOf(template.id))!;
    await db.insert(connectionGrants).values({ companyId, connectionId: template.id, kind: "organization", credentialSecretRefs: [], status: "active", isDefault: true });
    const insertForced = async () => {
      await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "company", targetId: companyId });
      await db.insert(toolConnectionInstalls).values({ companyId, connectionId: template.id, targetType: "company", targetId: companyId });
    };
    await insertForced();

    const remote = vi.fn(async () => new Response("{}", { status: 200 }));
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "template-test-signing-secret",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: remote,
    } as never);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: legacy.id, status: "running", contextSnapshot: {} }).returning();
    const session = await gateway.createSession({ companyId, agentId: legacy.id, runId: run!.id });
    const listed = await gateway.listToolsForSession(session.token);
    expect(listed.filter((tool: { connectionId?: string | null }) => tool.connectionId === template.id)).toEqual([]);
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "comms_whoami", parameters: {} })).rejects.toBeTruthy();
    expect(remote).not.toHaveBeenCalled();
  });

  it("public create/update strip the server markers; the managed template is immutable except archive; dedicated markers are preserved", async () => {
    const { companyId, fetchMock, template } = await readyCompany();
    const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);

    // A client can neither forge nor adopt the markers or the reserved uid through the public create path.
    const created = await service.createConnection(companyId, {
      name: "client-made",
      transport: "mcp_remote",
      authKind: "none",
      config: { url: "https://8.8.8.8/mcp", defaultMcpManaged: "template", defaultMcpTemplate: { version: 1, state: "ready" } },
      transportConfig: { url: "https://8.8.8.8/mcp", defaultMcpManaged: "dedicated" },
    } as never);
    const [clientRow] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.id));
    expect(clientRow!.uid).not.toBe(DEFAULT_MCP_TEMPLATE_UID);
    expect(isManagedTemplate(clientRow!.config)).toBe(false);
    expect(isManagedDedicated(clientRow!.transportConfig)).toBe(false);
    expect(readTemplateClaim(clientRow!.config)).toBeNull();
    const updatedClient = await service.updateConnection(created.id, { config: { url: "https://8.8.8.8/mcp", defaultMcpManaged: "template" } } as never);
    expect(isManagedTemplate((await db.select().from(toolConnections).where(eq(toolConnections.id, updatedClient.id)))[0]!.config)).toBe(false);

    // The managed template cannot be edited (409); archiving is the one allowed change.
    const edits = [{ name: "renamed" }, { enabled: false }, { config: { url: "https://evil.example/mcp" } }, { credentialRefs: [] }];
    for (const edit of edits) {
      const outcome = await service.updateConnection(template.id, edit as never).then(() => "allowed", (error: { status?: number; details?: { code?: string } }) => `${error.status}:${error.details?.code}`);
      expect(outcome).toBe("409:managed_template_immutable");
    }
    expect((await templateRow(companyId))!).toMatchObject({ name: "rh-comms-board", enabled: true });
    expect(readTemplateClaim((await templateRow(companyId))!.config)).toMatchObject({ state: "ready" });
    await service.updateConnection(template.id, { status: "archived" } as never);
    expect((await templateRow(companyId))!.status).toBe("archived");
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "revoked" });
  });

  it("every archive path keeps the managed template's server-owned config and claim byte-identical, so it can never be reactivated", async () => {
    const refused = (fn: () => Promise<unknown>) =>
      fn().then(() => "allowed", (error: { status?: number; details?: { code?: string } }) => `${error.status}:${error.details?.code}`);
    for (const path of ["update", "archive"] as const) {
      const { companyId, fetchMock, template } = await readyCompany();
      const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);
      const before = (await templateRow(companyId))!;
      if (path === "update") await service.updateConnection(template.id, { status: "archived" } as never);
      else await service.archiveConnection(template.id, companyId);
      const after = (await templateRow(companyId))!;
      expect(after.status).toBe("archived");
      // Marker, the WHOLE claim (ready, ids, expiry, allowlist version) and the transport config are untouched.
      expect(after.config).toEqual(before.config);
      expect(after.transportConfig).toEqual(before.transportConfig);
      expect(isManagedTemplate(after.config)).toBe(true);
      expect(readTemplateClaim(after.config)).toEqual(readTemplateClaim(before.config));
      // A client cannot reactivate or edit it; the provisioner reports it revoked and never re-mints or recreates.
      expect(await refused(() => service.updateConnection(template.id, { status: "active" } as never))).toBe("409:managed_template_immutable");
      expect(await refused(() => service.updateConnection(template.id, { enabled: true } as never))).toBe("409:managed_template_immutable");
      expect(await refused(() => service.updateConnection(template.id, { config: { url: BOARD_URL } } as never))).toBe("409:managed_template_immutable");
      expect((await templateRow(companyId))!.status).toBe("archived");
      expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "revoked" });
      __resetCompanyTemplateDeferralsForTests();
      expect(await sweepCompanyTemplates(ctxFor(fetchMock))).toBe(0);
      expect(fetchMock.calls.mints).toHaveLength(1);
      expect((await connectionsOf(companyId)).filter((row) => row.uid === DEFAULT_MCP_TEMPLATE_UID)).toHaveLength(1);
    }
  });

  // ---- per-agent clone from the managed template --------------------------------------------

  it("a new agent clones the verified template per-bot: allowlist only, agent-only binding, no install (OFF), clone marked dedicated", async () => {
    enableFeature();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    const fetchMock = makeFetch();
    vi.stubGlobal("fetch", fetchMock);
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "ready" });
    const template = (await templateRow(companyId))!;
    const templateBefore = JSON.stringify(template);

    const agent = await createAgent(companyId, ownerId);
    const entry = await agentEntry(agent.id);
    expect(entry).toMatchObject({ dedicated: true, enabled: false, templateConnectionId: template.id, setup: { state: "ready", reason: null } });
    // Per-bot mint: read + write (the template mint was read-only).
    const botMint = fetchMock.calls.mints.find((mint) => mint.sub === `paperclip-agent-${agent.id}`)!;
    expect(botMint.scopes).toEqual(["comms:read", "comms:write"]);
    expect(botMint.expires).toBe(365);
    expect(fetchMock.calls.mints.filter((mint) => mint.scopes.length === 1)).toHaveLength(1);

    const clone = (await db.select().from(toolConnections).where(eq(toolConnections.id, entry.connectionId!)))[0]!;
    expect(clone).toMatchObject({ credentialPolicy: "per_agent", status: "active", name: `rh-comms-board:${agent.id}` });
    expect(isManagedDedicated(clone.config)).toBe(true);
    expect(isManagedTemplate(clone.config)).toBe(false);
    expect(readTemplateClaim(clone.config)).toBeNull();
    expect(clone.config).toMatchObject({ quarantineNewEntries: true, mcpSessionRequired: true });
    const cloneCatalog = await catalogOf(clone.id);
    expect(cloneCatalog.filter((row) => row.status === "active").map((row) => row.toolName).sort()).toEqual([...COMMS_BOARD_REVIEWED_TOOLS].sort());
    expect(cloneCatalog.filter((row) => row.status === "disabled")).toHaveLength(RESTRICTED_TOOLS.length);
    const cloneProfile = (await profileOf(clone.id))!;
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, cloneProfile.id))).toHaveLength(15);
    const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, cloneProfile.id));
    expect(bindings.map((b) => `${b.targetType}:${b.targetId}`)).toEqual([`agent:${agent.id}`]);
    // OFF: no install row for the agent, none for the clone, none for the template.
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId))).toHaveLength(0);
    // The template itself was not touched by the clone (no markers leaked, nothing rewritten).
    expect(JSON.stringify((await templateRow(companyId))!)).toBe(templateBefore);

    // A client replacing the dedicated clone's config cannot remove the marker or the quarantine flag.
    const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);
    await service.updateConnection(clone.id, { config: { url: BOARD_URL, mcpSessionRequired: true, quarantineNewEntries: false, defaultMcpManaged: "template" } } as never);
    const after = (await db.select().from(toolConnections).where(eq(toolConnections.id, clone.id)))[0]!;
    expect(isManagedDedicated(after.config)).toBe(true);
    expect(after.config.quarantineNewEntries).toBe(true);

    // A dedicated clone's own refresh never builds a company binding or widens its profile.
    const grown = makeFetch({ tools: () => [...ALL_BOARD_TOOLS, "comms_new_tool"] });
    await toolAccessService(db, ctxFor(grown).toolAccessOptions).refreshCatalog(clone.id, { actorType: "system", actorId: "test" });
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.targetType, "company"))).toHaveLength(0);
    expect((await catalogOf(clone.id)).find((row) => row.toolName === "comms_new_tool")!.status).toBe("quarantined");
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, cloneProfile.id))).toHaveLength(15);
  });

  it("agents created before the template exists wait, are nudged by the path-only update when it is ready, and then finish", async () => {
    enableFeature();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    const fetchMock = makeFetch();
    vi.stubGlobal("fetch", fetchMock);
    const waiting = await createAgent(companyId, ownerId);
    expect((await agentEntry(waiting.id)).setup).toMatchObject({ state: "pending", reason: "template_not_found" });
    const [rowBefore] = await db.select().from(agents).where(eq(agents.id, waiting.id));
    const farFuture = new Date(Date.now() + 24 * 3_600_000).toISOString();
    await db.execute(sql`update agents set metadata = jsonb_set(metadata, '{defaultMcp,entries,comms-board,setup,nextAttemptAt}', to_jsonb(${farFuture}::text)) where id = ${waiting.id}`);
    expect(await sweepDefaultMcpSetups({ db, fetchImpl: fetchMock })).toBe(0);

    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "ready" });
    const [rowAfter] = await db.select().from(agents).where(eq(agents.id, waiting.id));
    const metaBefore = rowBefore!.metadata as { defaultMcp: { entries: Record<string, { setup: Record<string, unknown> }> } };
    const metaAfter = rowAfter!.metadata as typeof metaBefore;
    // Path-only: the single nudged field changed; every other byte of the metadata is identical.
    const strip = (meta: typeof metaBefore) => {
      const clone = JSON.parse(JSON.stringify(meta)) as typeof metaBefore;
      delete clone.defaultMcp.entries["comms-board"]!.setup.nextAttemptAt;
      return clone;
    };
    expect(strip(metaAfter)).toEqual(strip(metaBefore));
    expect(Date.parse(metaAfter.defaultMcp.entries["comms-board"]!.setup.nextAttemptAt as string)).toBeLessThan(Date.now() + 60_000);

    expect(await sweepDefaultMcpSetups({ db, fetchImpl: fetchMock })).toBe(1);
    expect((await agentEntry(waiting.id)).setup).toMatchObject({ state: "ready" });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId))).toHaveLength(0);
  });

  it("an agent waits template_provisioning while the managed template is not ready and is never cloned from a draft", async () => {
    enableFeature();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    const fetchMock = makeFetch({ mint: () => new Response("{}", { status: 401 }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "pending", reason: "ownership_rejected" });
    const agent = await createAgent(companyId, ownerId);
    expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_provisioning" });
    const connections = await connectionsOf(companyId);
    expect(connections).toHaveLength(1); // only the draft template: no per-agent clone
    expect(fetchMock.calls.registers).toEqual([]);
  });

  it("legacy agent rows and other companies are byte-identical after every template operation", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    const other = await seedCompany({ status: "archived" });
    // Created before the feature is enabled: no defaultMcp state at all.
    const legacy = await agentService(db).create(
      companyId,
      { name: "legacy", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId: ownerId } },
    );
    const snapshot = async () => ({
      agents: await db.select().from(agents).where(eq(agents.companyId, companyId)),
      company: await db.select().from(companies).where(eq(companies.id, companyId)),
      otherCompany: await db.select().from(companies).where(eq(companies.id, other)),
      otherRows: await rowCounts(other),
    });
    enableFeature();
    const before = await snapshot();
    const fetchMock = makeFetch();
    vi.stubGlobal("fetch", fetchMock);
    await ensureCompanyTemplate(ctxFor(fetchMock), { companyId });
    await sweepCompanyTemplates(ctxFor(fetchMock));
    expect(await sweepDefaultMcpSetups({ db, fetchImpl: fetchMock })).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(readDefaultMcpState(before.agents.find((row) => row.id === legacy.id)!.metadata)).toBeNull();
  });
});
