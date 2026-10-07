/**
 * Managed company template for the default MCP spec (TECH-7271): regression guards that
 * `default-mcp-template.test.ts` does not cover. Everything here is synthetic: an embedded
 * Postgres, a mocked downstream (ownership API + board JSON-RPC) and no live service, SSM or
 * auth state.
 *
 * Genuinely missing material regressions covered here (the rest of the TECH-7271 focus list is
 * already covered by default-mcp-template.test.ts / default-mcp-spec.test.ts /
 * default-mcp-template-scope.test.ts / agent-jwt-env.test.ts and is NOT duplicated):
 *  - an operator archive MID-CLAIM: the in-flight worker can neither reactivate the row nor
 *    materialize grants/bindings, and the claim is never re-claimed;
 *  - a user grant sneaking in MID-CLAIM (install row or profile binding) is reported as drift,
 *    never auto-deleted, and the template never activates;
 *  - a client cannot reactivate or edit an archived (revoked) managed template;
 *  - the frozen owner is kept while eligible and deterministically re-picked when demoted or
 *    re-emailed before the first mint; no owner left -> owner_required with no fetch;
 *  - a dead vault secret is terminal drift / secret_unavailable, never silently re-minted;
 *  - an ARCHIVED user-managed same-name template is neither adopted nor a sweep blocker;
 *  - an agent is never cloned from a stale-allowlist (version-mismatched) template;
 *  - the boot-frozen rollout scope is immune to later process.env mutations (a subsequent
 *    dotenv load or child environment can neither narrow, empty nor widen it) through the
 *    production path (no ctx.scope seam).
 *
 * One test is the regression guard for a MATERIAL FINDING that has since been fixed: the public archive
 * path used to strip the server-owned config markers (the `defaultMcpManaged` marker and the whole
 * `defaultMcpTemplate` claim), which let a client reactivate a revoked managed template. `updateConnection`
 * now carries the managed template's config and transport config over unchanged when archiving it, so the
 * test passes and must keep passing.
 */
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
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  COMMS_BOARD_REVIEWED_TOOLS,
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_TEMPLATE_UID,
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
  __resetCompanyTemplateDeferralsForTests,
  configureDefaultMcpTemplateRuntime,
  ensureCompanyTemplate,
  managedTemplateUsability,
  sweepCompanyTemplates,
  type DefaultMcpTemplateContext,
} from "../services/default-mcp-template.js";
import {
  runDefaultMcpSetupForAgent,
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
}

/** One fetch for every downstream: ownership API, board JSON-RPC (handshake, tools/list, register). */
function makeFetch(
  opts: {
    mint?: (call: MintCall) => Response | Promise<Response> | "throw" | null;
    tools?: () => string[];
    toolsListGate?: () => Promise<void>;
  } = {},
) {
  const calls = {
    mints: [] as MintCall[],
    toolsList: [] as Array<{ authorization: string | null }>,
    registers: [] as string[],
  };
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    if (url === `${OWNERSHIP_URL}/agents`) {
      const body = JSON.parse(init.body as string);
      const call: MintCall = {
        sub: body.sub,
        ownerEmail: body.owner_email,
        scopes: body.scopes,
        expires: body.expires_in_days,
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

describeEmbeddedPostgres("managed company template mid-claim regressions (TECH-7271)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-template-regressions-${randomUUID()}`);
  const envKeys = [
    FEATURE_ENV,
    COMMS_BOARD_MCP_URL_ENV,
    COMMS_BOARD_ADMIN_TOKEN_ENV,
    COMMS_BOARD_OWNERSHIP_API_URL_ENV,
    COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
    DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  ];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("paperclip-default-mcp-template-regressions-");
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
    // Boot-frozen rollout scope: unset means every company. Later tests may re-capture a narrower one.
    captureDefaultMcpTemplateScope({});
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
  }

  /**
   * Everything the module needs, with discovery and the ownership POST both routed to the fixture.
   * Deliberately WITHOUT `scope`: the production boot-frozen capture (readDefaultMcpTemplateScope)
   * is the scope source for every test here, not an injected seam.
   */
  function ctxFor(fetchMock: ReturnType<typeof makeFetch>, overrides: Partial<DefaultMcpTemplateContext> = {}): DefaultMcpTemplateContext {
    return {
      db,
      fetchImpl: fetchMock,
      toolAccessOptions: {
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: async (url, init) => fetchMock(url, init),
      },
      ...overrides,
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: "active",
      defaultResponsibleUserId: null,
    });
    return companyId;
  }

  async function seedMember(
    companyId: string,
    opts: { email?: string; verified?: boolean; createdAt?: Date } = {},
  ) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Member",
      email: opts.email ?? `${userId}@redesignhealth.com`,
      emailVerified: opts.verified ?? true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
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
  const installsOf = (connectionId: string) => db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId));
  const profileOf = (connectionId: string) =>
    db
      .select()
      .from(toolProfiles)
      .where(eq(toolProfiles.profileKey, `app:${connectionId}`))
      .then((rows) => rows[0] ?? null);
  const secretsOf = (companyId: string) => db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
  const bindingsOf = (companyId: string) => db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId));

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

  /** Waits until the gated worker is parked inside the template discovery (its first tools/list). */
  async function waitForToolsList(fetchMock: ReturnType<typeof makeFetch>) {
    for (let i = 0; i < 200 && fetchMock.calls.toolsList.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fetchMock.calls.toolsList).toHaveLength(1);
  }

  // ---- mid-claim operator archive -----------------------------------------------------------

  it("an operator archive mid-claim is terminal for the in-flight worker: no late reactivation, grants or bindings, and the claim is never re-claimed", async () => {
    enableFeature();
    const companyId = await seedCompany();
    await seedMember(companyId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = makeFetch({ toolsListGate: () => gate });
    const first = ensureCompanyTemplate(ctxFor(slow), { companyId });
    await waitForToolsList(slow);
    // The worker is mid-discovery, holding the claim; the mint already happened (checkpointed).
    expect(slow.calls.mints).toHaveLength(1);
    const template = (await templateRow(companyId))!;
    const staleClaimId = (await claimOf(companyId))!.claimId;
    expect(staleClaimId).toBeTruthy();

    // The operator archives the template while the worker is parked inside discovery.
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, template.id));
    release();
    expect(await first).toEqual({ kind: "not_claimed" });

    // The loser's late write never reactivated the row and never materialized any grant.
    const after = (await templateRow(companyId))!;
    expect(after.status).toBe("archived");
    expect(after.enabled).toBe(false);
    const claim = readTemplateClaim(after.config)!;
    expect(claim.state).toBe("in_progress");
    expect(claim.claimId).toBe(staleClaimId);
    expect(await profileOf(template.id)).toBeNull();
    expect(await bindingsOf(companyId)).toHaveLength(0);
    expect(await installsOf(template.id)).toHaveLength(0);

    // The claim is never re-claimed (the claim SQL refuses archived rows), the ensure is revoked
    // and the sweep never selects the company again: no second mint, ever.
    expect(await ensureCompanyTemplate(ctxFor(slow, { now: () => new Date(Date.now() + 2 * 3_600_000) }), { companyId })).toEqual({ kind: "revoked" });
    expect((await templateRow(companyId))!.status).toBe("archived");
    expect((await claimOf(companyId))!.claimId).toBe(staleClaimId);
    __resetCompanyTemplateDeferralsForTests();
    expect(await sweepCompanyTemplates(ctxFor(slow, { now: () => new Date(Date.now() + 3 * 3_600_000) }))).toBe(0);
    expect(slow.calls.mints).toHaveLength(1);
  });

  // ---- mid-claim drift (a user grant sneaks in) ----------------------------------------------

  it("a user grant added mid-claim (install row or profile binding) is reported as drift, never deleted, and the template never activates", async () => {
    enableFeature();
    const logSpies = (["info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(logger, level));

    // Variant 1: a company-wide install row appears while the worker holds the claim.
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = makeFetch({ toolsListGate: () => gate });
    const first = ensureCompanyTemplate(ctxFor(slow), { companyId });
    await waitForToolsList(slow);
    const template = (await templateRow(companyId))!;
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: template.id, targetType: "company", targetId: companyId });
    release();
    expect(await first).toEqual({ kind: "error", reason: "template_drift" });
    expect((await claimOf(companyId))).toMatchObject({ state: "error", reason: "template_drift", claimId: null });
    // The user grant is left exactly as found: reported, never auto-deleted.
    expect(await installsOf(template.id)).toHaveLength(1);
    const after = (await templateRow(companyId))!;
    expect(after.status).toBe("draft");
    expect(after.enabled).toBe(false);
    expect(await profileOf(template.id)).toBeNull();
    expect(await bindingsOf(companyId)).toHaveLength(0);

    // A second ensure is terminal without any call, and the sweep never re-selects the error row.
    expect(await ensureCompanyTemplate(ctxFor(slow), { companyId })).toEqual({ kind: "error", reason: "template_drift" });
    expect(await sweepCompanyTemplates(ctxFor(slow))).toBe(0);
    expect(slow.calls.mints).toHaveLength(1);

    // An agent created now waits template_failed and is never cloned from the drifted template.
    vi.stubGlobal("fetch", slow);
    const callsBefore = slow.mock.calls.length;
    const agent = await createAgent(companyId, ownerId);
    expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_failed" });
    expect(slow.mock.calls.length).toBe(callsBefore);
    expect((await connectionsOf(companyId)).filter((row) => row.credentialPolicy === "per_agent")).toHaveLength(0);

    // Variant 2: a profile binding appears mid-claim (a manual profile row plus a company binding).
    const other = await seedCompany();
    await seedMember(other);
    let releaseOther!: () => void;
    const gateOther = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    const slowOther = makeFetch({ toolsListGate: () => gateOther });
    const second = ensureCompanyTemplate(ctxFor(slowOther), { companyId: other });
    await waitForToolsList(slowOther);
    const otherTemplate = (await templateRow(other))!;
    const [manualProfile] = await db
      .insert(toolProfiles)
      .values({ companyId: other, profileKey: `app:${otherTemplate.id}`, name: "user-made profile", status: "active", defaultAction: "deny" })
      .returning();
    await db.insert(toolProfileBindings).values({ companyId: other, profileId: manualProfile!.id, targetType: "company", targetId: other });
    releaseOther();
    expect(await second).toEqual({ kind: "error", reason: "template_drift" });
    expect((await claimOf(other))).toMatchObject({ state: "error", reason: "template_drift" });
    // The user's profile and binding are intact; the template itself never activated.
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.id, manualProfile!.id))).toHaveLength(1);
    expect(await bindingsOf(other)).toHaveLength(1);
    expect((await templateRow(other))!.status).toBe("draft");
    expect(slowOther.calls.mints).toHaveLength(1);

    // No raw token material (minted template token, board admin token, ownership token) ever
    // reaches the logs or the activity trail.
    const logged = JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));
    const activity = JSON.stringify(await db.select().from(activityLog));
    for (const secret of [TEMPLATE_TOKEN, BOARD_ADMIN_TOKEN, OWNERSHIP_TOKEN]) {
      expect(logged).not.toContain(secret);
      expect(activity).not.toContain(secret);
    }
  });

  // ---- revoked (archived) template vs the client ----------------------------------------------

  it("a client cannot reactivate or edit an archived (revoked) managed template whose markers are intact", async () => {
    const { companyId, fetchMock, template } = await readyCompany();
    const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);
    // An operator archive that leaves the row's server-owned config intact (any non-client path).
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, template.id));
    expect((await templateRow(companyId))!.status).toBe("archived");

    const refused = async (fn: () => Promise<unknown>) =>
      fn().then(() => "allowed", (error: { status?: number; details?: { code?: string } }) => `${error.status}:${error.details?.code}`);
    // Reactivation attempts (and every other edit) are rejected; only archiving is ever allowed.
    for (const edit of [
      { status: "active" },
      { name: "renamed", status: "archived" },
      { status: "archived", enabled: true },
      { status: "archived", config: { url: "https://evil.example/mcp" } },
    ]) {
      expect(await refused(() => service.updateConnection(template.id, edit as never))).toBe("409:managed_template_immutable");
    }
    const after = (await templateRow(companyId))!;
    expect(after.status).toBe("archived");
    expect(after.name).toBe("rh-comms-board");
    expect(readTemplateClaim(after.config)).toMatchObject({ state: "ready" });

    // The provisioner agrees: revoked, never recreated, never re-minted.
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "revoked" });
    expect(await sweepCompanyTemplates(ctxFor(fetchMock))).toBe(0);
    expect(fetchMock.calls.mints).toHaveLength(1);
  });

  // MATERIAL FINDING (fails today; see the report): archiving a managed template through the public
  // updateConnection path writes back the marker-stripped config (applyUpdate always sets `config`
  // from stripDefaultMcpProtectedConfigKeys(...)), so the archived row loses `defaultMcpManaged:
  // "template"` AND the whole `defaultMcpTemplate` claim. The managed_template_immutable guard then
  // no longer matches, and a client can immediately reactivate and freely edit the revoked template
  // (status back to active, no marker), with its vault token and profile still wired - defeating
  // every managed-template guard downstream. The archive path must preserve the server-owned
  // markers exactly like the dedicated-clone branch re-adds its own marker.
  it("MATERIAL FINDING: the public archive path must preserve the server-owned markers so a revoked template stays immutable and cannot be reactivated", async () => {
    const { companyId, fetchMock, template } = await readyCompany();
    const service = toolAccessService(db, ctxFor(fetchMock).toolAccessOptions);
    await service.updateConnection(template.id, { status: "archived" } as never);
    const archived = (await templateRow(companyId))!;
    expect(archived.status).toBe("archived");
    // The revocation must not strip the server-owned classification or the durable claim.
    expect(isManagedTemplate(archived.config)).toBe(true);
    expect(readTemplateClaim(archived.config)).toMatchObject({ state: "ready" });
    // With the markers intact, reactivation (and every other edit) is rejected.
    const refused = async (fn: () => Promise<unknown>) =>
      fn().then(() => "allowed", (error: { status?: number; details?: { code?: string } }) => `${error.status}:${error.details?.code}`);
    expect(await refused(() => service.updateConnection(template.id, { status: "active" } as never))).toBe("409:managed_template_immutable");
    expect((await templateRow(companyId))!.status).toBe("archived");
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId })).toEqual({ kind: "revoked" });
    expect(fetchMock.calls.mints).toHaveLength(1);
  });

  // ---- frozen owner vs re-pick before the first mint -------------------------------------------

  it("the frozen owner is kept while eligible and deterministically re-picked when demoted or re-emailed before the first mint", async () => {
    enableFeature();
    const later = () => new Date(Date.now() + 2 * 3_600_000);
    const staged = () => {
      let refuse = true;
      const fetchMock = makeFetch({ mint: () => (refuse ? new Response("{}", { status: 401 }) : null) });
      return {
        fetchMock,
        accept: () => {
          refuse = false;
        },
      };
    };

    // Kept while eligible: the second attempt mints as the SAME frozen owner.
    const kept = await seedCompany();
    const keptOwner = await seedMember(kept, { email: "First@x.com", createdAt: new Date("2026-01-01") });
    await seedMember(kept, { email: "second@x.com", createdAt: new Date("2026-02-01") });
    const keptFetch = staged();
    expect(await ensureCompanyTemplate(ctxFor(keptFetch.fetchMock), { companyId: kept })).toEqual({ kind: "pending", reason: "ownership_rejected" });
    keptFetch.accept();
    expect(await ensureCompanyTemplate(ctxFor(keptFetch.fetchMock, { now: later }), { companyId: kept })).toEqual({ kind: "ready" });
    expect(keptFetch.fetchMock.calls.mints).toHaveLength(2);
    expect(keptFetch.fetchMock.calls.mints[1]!.scopes).toEqual(["comms:read"]);
    expect(keptFetch.fetchMock.calls.mints[1]!.ownerEmail).toBe("first@x.com");
    expect((await claimOf(kept))!.ownerUserId).toBe(keptOwner);

    // Demoted before the first mint: the earliest still-eligible owner is re-picked deterministically.
    const demoted = await seedCompany();
    const demotedA = await seedMember(demoted, { email: "first@x.com", createdAt: new Date("2026-01-01") });
    const demotedB = await seedMember(demoted, { email: "second@x.com", createdAt: new Date("2026-02-01") });
    const demotedFetch = staged();
    expect(await ensureCompanyTemplate(ctxFor(demotedFetch.fetchMock), { companyId: demoted })).toEqual({ kind: "pending", reason: "ownership_rejected" });
    await db
      .update(companyMemberships)
      .set({ membershipRole: "member" })
      .where(and(eq(companyMemberships.companyId, demoted), eq(companyMemberships.principalId, demotedA)));
    demotedFetch.accept();
    expect(await ensureCompanyTemplate(ctxFor(demotedFetch.fetchMock, { now: later }), { companyId: demoted })).toEqual({ kind: "ready" });
    expect(demotedFetch.fetchMock.calls.mints[1]!.ownerEmail).toBe("second@x.com");
    const demotedClaim = (await claimOf(demoted))!;
    expect(demotedClaim.ownerUserId).toBe(demotedB);
    expect(demotedClaim.ownerEmailNorm).toBe("second@x.com");

    // Re-emailed before the first mint: the same owner is re-picked with the NEW verified email.
    const reemailed = await seedCompany();
    const reemailedOwner = await seedMember(reemailed, { email: "original@x.com" });
    const reemailedFetch = staged();
    expect(await ensureCompanyTemplate(ctxFor(reemailedFetch.fetchMock), { companyId: reemailed })).toEqual({ kind: "pending", reason: "ownership_rejected" });
    await db.update(authUsers).set({ email: "New@x.com" }).where(eq(authUsers.id, reemailedOwner));
    reemailedFetch.accept();
    expect(await ensureCompanyTemplate(ctxFor(reemailedFetch.fetchMock, { now: later }), { companyId: reemailed })).toEqual({ kind: "ready" });
    expect(reemailedFetch.fetchMock.calls.mints[1]!.ownerEmail).toBe("new@x.com");
    expect((await claimOf(reemailed))!).toMatchObject({ ownerUserId: reemailedOwner, ownerEmailNorm: "new@x.com" });

    // Owner removed with no other owner left: the claim goes back to waiting owner_required, and
    // NO second POST happens even though the issuer would now accept.
    const orphaned = await seedCompany();
    const orphanedOwner = await seedMember(orphaned, { email: "only@x.com" });
    const orphanedFetch = staged();
    expect(await ensureCompanyTemplate(ctxFor(orphanedFetch.fetchMock), { companyId: orphaned })).toEqual({ kind: "pending", reason: "ownership_rejected" });
    await db
      .delete(companyMemberships)
      .where(and(eq(companyMemberships.companyId, orphaned), eq(companyMemberships.principalId, orphanedOwner)));
    orphanedFetch.accept();
    expect(await ensureCompanyTemplate(ctxFor(orphanedFetch.fetchMock, { now: later }), { companyId: orphaned })).toEqual({ kind: "pending", reason: "owner_required" });
    expect(orphanedFetch.fetchMock.calls.mints).toHaveLength(1);
    expect((await claimOf(orphaned))!).toMatchObject({ state: "pending", reason: "owner_required", secretId: null });
    expect(await secretsOf(orphaned)).toHaveLength(0);
  });

  // ---- dead vault secret ----------------------------------------------------------------------

  it("a dead vault secret is terminal (drift or secret_unavailable) and never silently re-minted", async () => {
    // A READY template whose stored secret is disabled: drift, terminal, no re-mint, no new secret.
    const disabled = await readyCompany();
    const disabledClaim = (await claimOf(disabled.companyId))!;
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, disabledClaim.secretId!));
    expect(await managedTemplateUsability(db, (await templateRow(disabled.companyId))!)).toEqual({ ok: false, reason: "template_failed" });
    expect(await ensureCompanyTemplate(ctxFor(disabled.fetchMock), { companyId: disabled.companyId })).toEqual({ kind: "error", reason: "template_drift" });
    expect((await claimOf(disabled.companyId))!).toMatchObject({ state: "error", reason: "template_drift" });
    expect(await ensureCompanyTemplate(ctxFor(disabled.fetchMock), { companyId: disabled.companyId })).toEqual({ kind: "error", reason: "template_drift" });
    expect(disabled.fetchMock.calls.mints).toHaveLength(1);
    expect(await secretsOf(disabled.companyId)).toHaveLength(1);

    // A crash between checkpointing the secret id and finishing left the claim pending with a
    // secret id, and the secret is now deleted: secret_unavailable, still no second mint.
    const deleted = await readyCompany();
    const deletedClaim = (await claimOf(deleted.companyId))!;
    const forged = { ...deletedClaim, state: "pending" as const, reason: null, claimId: null, nextAttemptAt: null, leaseUntil: null };
    await db.execute(sql`update tool_connections set config = jsonb_set(config, '{defaultMcpTemplate}', ${JSON.stringify(forged)}::jsonb) where id = ${deleted.template.id}`);
    await db.update(companySecrets).set({ deletedAt: new Date() }).where(eq(companySecrets.id, deletedClaim.secretId!));
    expect(await ensureCompanyTemplate(ctxFor(deleted.fetchMock), { companyId: deleted.companyId })).toEqual({ kind: "error", reason: "secret_unavailable" });
    expect((await claimOf(deleted.companyId))!).toMatchObject({ state: "error", reason: "secret_unavailable" });
    expect(deleted.fetchMock.calls.mints).toHaveLength(1);
    expect(await secretsOf(deleted.companyId)).toHaveLength(1);
  });

  // ---- archived user-managed same-name template ------------------------------------------------

  it("an archived user-managed same-name template is neither adopted nor a sweep blocker: a fresh managed template is created", async () => {
    enableFeature();
    const fetchMock = makeFetch();

    const seedArchivedUserTemplate = async (companyId: string) => {
      const application = await db
        .insert(toolApplications)
        .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${randomUUID().slice(0, 6)}`, type: "mcp_http", status: "active" })
        .returning()
        .then((rows) => rows[0]!);
      const shared = await secretService(db).create(companyId, { name: `shared ${randomUUID()}`, key: `shared.${randomUUID()}`, provider: "local_encrypted", value: "org-shared-token" });
      return db
        .insert(toolConnections)
        .values({
          companyId,
          applicationId: application.id,
          name: "rh-comms-board",
          uid: `uid-${randomUUID()}`,
          transport: "mcp_remote",
          authKind: "api_key",
          credentialPolicy: "shared",
          status: "archived",
          enabled: true,
          config: { url: "https://8.8.8.8/mcp" },
          transportConfig: { url: "https://8.8.8.8/mcp" },
          credentialRefs: [{ name: "credentials.authorization", secretId: shared.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }],
        })
        .returning()
        .then((rows) => rows[0]!);
    };

    // The direct ensure: the archived user row is invisible to adoption, so the managed template
    // is created fresh, and the user's row is byte-identical afterwards.
    const a = await seedCompany();
    await seedMember(a);
    const userRow = await seedArchivedUserTemplate(a);
    const userRowBefore = JSON.stringify(userRow);
    expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: a })).toEqual({ kind: "ready" });
    const managed = (await templateRow(a))!;
    expect(managed.id).not.toBe(userRow.id);
    const [userRowAfter] = await db.select().from(toolConnections).where(eq(toolConnections.id, userRow.id));
    expect(JSON.stringify(userRowAfter)).toBe(userRowBefore);
    expect(fetchMock.calls.mints).toHaveLength(1);

    // The durable sweep: the archived row does not count as an existing template, so the company
    // is selected and provisioned without the direct ensure.
    const b = await seedCompany();
    await seedMember(b);
    await seedArchivedUserTemplate(b);
    expect(await sweepCompanyTemplates(ctxFor(fetchMock))).toBe(1);
    expect((await claimOf(b))!.state).toBe("ready");
    expect((await connectionsOf(b)).filter((row) => row.uid === DEFAULT_MCP_TEMPLATE_UID)).toHaveLength(1);
    expect(fetchMock.calls.mints).toHaveLength(2);
  });

  // ---- stale-allowlist version gating for per-agent clones -------------------------------------

  it("an agent is never cloned from a stale-allowlist template and completes once the template catches up", async () => {
    enableFeature();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    const t0 = Date.now();
    const at = (hours: number) => () => new Date(t0 + hours * 3_600_000);
    const bumped = DEFAULT_MCP_SPEC.map((entry) =>
      entry.templateBootstrap
        ? { ...entry, reviewedTools: { version: 2, allow: COMMS_BOARD_REVIEWED_TOOLS.filter((name) => name !== "comms_extend_conversation") } }
        : entry,
    );

    // The template stalls at pending (a definitive 401), so a new agent waits template_provisioning.
    const fetch401 = makeFetch({ mint: () => new Response("{}", { status: 401 }) });
    expect(await ensureCompanyTemplate(ctxFor(fetch401), { companyId })).toEqual({ kind: "pending", reason: "ownership_rejected" });
    vi.stubGlobal("fetch", fetch401);
    const agent = await createAgent(companyId, ownerId);
    expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_provisioning" });

    // The template becomes ready at allowlist version 1.
    const good = makeFetch();
    expect(await ensureCompanyTemplate(ctxFor(good, { now: at(2) }), { companyId })).toEqual({ kind: "ready" });
    expect(good.calls.mints).toHaveLength(1);
    expect(good.calls.mints[0]!.scopes).toEqual(["comms:read"]);

    // The reviewed allowlist moves to version 2: the agent is never cloned from the stale v1 template.
    await runDefaultMcpSetupForAgent({ db, fetchImpl: good, now: at(4), spec: bumped }, { companyId, agentId: agent.id });
    expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_provisioning" });
    expect((await connectionsOf(companyId)).filter((row) => row.credentialPolicy === "per_agent")).toHaveLength(0);
    expect(good.calls.registers).toEqual([]);
    expect(good.calls.mints).toHaveLength(1);

    // The template catches up to v2 (discovery + L3 only, no new template mint) and the agent
    // then completes against the updated allowlist.
    expect(await ensureCompanyTemplate(ctxFor(good, { now: at(6), spec: bumped }), { companyId })).toEqual({ kind: "ready" });
    expect((await claimOf(companyId))!.allowlistVersion).toBe(2);
    expect(good.calls.mints).toHaveLength(1);
    await runDefaultMcpSetupForAgent({ db, fetchImpl: good, now: at(8), spec: bumped }, { companyId, agentId: agent.id });
    expect((await agentEntry(agent.id)).setup).toMatchObject({ state: "ready", reason: null });
    expect(good.calls.registers).toEqual([`paperclip-agent-${agent.id}`]);
    const botMint = good.calls.mints.find((mint) => mint.sub === `paperclip-agent-${agent.id}`)!;
    expect(botMint.scopes).toEqual(["comms:read", "comms:write"]);
    const clone = (await connectionsOf(companyId)).find((row) => row.name === `rh-comms-board:${agent.id}`)!;
    expect(clone.credentialPolicy).toBe("per_agent");
  });

  // ---- boot-frozen scope vs later environment mutations ------------------------------------------

  it("the boot-frozen scope is immune to later process.env mutations: a subsequent dotenv load or child environment can neither narrow, empty nor widen it", async () => {
    enableFeature();
    const inScope = await seedCompany();
    await seedMember(inScope);
    const other = await seedCompany();
    await seedMember(other);
    const fetchMock = makeFetch();
    // The operator captured an allowlist of exactly one company at boot.
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: inScope });
    try {
      // A later environment (dotenv file, child process) empties the rollout...
      process.env[DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV] = "";
      expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: other })).toEqual({ kind: "skipped", reason: "out_of_scope" });
      // ...then widens it to the other company. Both mutations are ignored: the frozen allowlist wins.
      process.env[DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV] = other;
      expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: other })).toEqual({ kind: "skipped", reason: "out_of_scope" });
      expect(await ensureCompanyTemplate(ctxFor(fetchMock), { companyId: inScope })).toEqual({ kind: "ready" });
      expect(fetchMock.calls.mints.map((mint) => mint.sub)).toEqual([`paperclip-company-template-${inScope}`]);
    } finally {
      delete process.env[DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV];
    }
  });
});
