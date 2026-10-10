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
  secretAccessEvents,
  toolAccessAuditEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
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
import { toolAccessService } from "../services/tool-access.js";
import { managedInstallCheck } from "../services/default-mcp-install-gate.js";
import {
  DEFAULT_MCP_SPEC_ENABLED_ENV,
  DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY,
  DEFAULT_MCP_MANAGED_CONFIG_KEY,
  readDefaultMcpState,
  type DefaultMcpAgentState,
} from "../services/default-mcp-spec.js";
import {
  ensureCompanyDefaultMcpOAuthSeeds,
  waitForScheduledCompanyOAuthSeeds,
} from "../services/default-mcp-oauth-seed.js";
import {
  DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  __resetDefaultMcpTemplateScopeForTests,
  captureDefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import {
  __resetCompanyTemplateDeferralsForTests,
  waitForScheduledCompanyTemplates,
} from "../services/default-mcp-template.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * TECH-7340 — strict personal default-MCP instances (the rows a human's "Connect
 * your account" creates from a discovery-only seed) and the safety gates around
 * them. All network-free: seeds never call out, and every OAuth/network surface
 * (start/callback/catalog) is covered by the generic-mcp suite with its fixture.
 */
const GOOGLE_URL_ENV = "PAPERCLIP_DEFAULT_MCP_RH_GOOGLE_MCP_URL";
const GOOGLE_URL = "https://rh-google-mcp.drum-mackarel.ts.net/mcp"; // authoritative; never fetched here

describeEmbeddedPostgres("personal default-MCP instances (TECH-7340)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-personal-${randomUUID()}`);
  const envKeys = [
    DEFAULT_MCP_SPEC_ENABLED_ENV,
    GOOGLE_URL_ENV,
    "PAPERCLIP_DEFAULT_MCP_RH_MCP_URL",
    DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  ];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-personal-instance");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
    __resetCompanyTemplateDeferralsForTests();
    __resetDefaultMcpTemplateScopeForTests();
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("personal-instance service tests must not make network calls");
    }));
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    await waitForScheduledCompanyTemplates();
    await waitForScheduledCompanyOAuthSeeds();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of envKeys) delete process.env[key];
    __resetCompanyTemplateDeferralsForTests();
    __resetDefaultMcpTemplateScopeForTests();
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(connectionTokenIssuances);
    await db.delete(secretAccessEvents);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolOauthStates);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(companySecretBindings);
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

  function enableSeeds() {
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";
    process.env[GOOGLE_URL_ENV] = GOOGLE_URL;
    captureDefaultMcpTemplateScope({}); // unset -> every company
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: "active",
    });
    return companyId;
  }

  async function seedMember(companyId: string, opts: { role?: string | null; status?: string; principalType?: "user" | "agent"; noUserRow?: boolean } = {}) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    if (!opts.noUserRow) {
      await db.insert(authUsers).values({
        id: userId,
        name: "Member",
        email: `${userId}@redesignhealth.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.insert(companyMemberships).values({
      companyId,
      principalType: opts.principalType ?? "user",
      principalId: userId,
      status: opts.status ?? "active",
      membershipRole: opts.role === undefined ? "member" : opts.role,
      createdAt: now,
    });
    return userId;
  }

  async function seedAgent(companyId: string, opts: { state?: DefaultMcpAgentState | null } = {}) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        ...(opts.state ? { metadata: { defaultMcp: opts.state } } : {}),
      })
      .returning();
    return agent!;
  }

  function agentState(opts: { connectionId?: string | null } = {}): DefaultMcpAgentState {
    return {
      version: 1,
      entries: {
        "rh-google-mcp": {
          key: "rh-google-mcp",
          templateKey: "rh-google-mcp",
          dedicated: false,
          enabled: false,
          templateConnectionId: opts.connectionId ?? null,
          connectionId: opts.connectionId ?? null,
          ownerUserId: null,
          setup: {
            state: "not_required",
            reason: null,
            attemptCount: 0,
            nextAttemptAt: null,
            leaseUntil: null,
            claimId: null,
            registerAttemptedAt: null,
            mintAttemptedAt: null,
            updatedAt: new Date().toISOString(),
          },
          binding: null,
        },
      },
    };
  }

  const svc = () => toolAccessService(db);
  const userActor = (userId: string) => ({ actorType: "user" as const, actorId: userId });
  const agentActor = (agentId: string) => ({ actorType: "agent" as const, actorId: agentId });

  async function googleSeed(companyId: string) {
    const [row] = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.uid, "rh-google-mcp/default-mcp-seed")));
    return row ?? null;
  }

  async function instanceRow(companyId: string, userId: string) {
    const [row] = await db
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.uid, `rh-google-mcp/default-mcp-personal/${userId}`),
        ),
      );
    return row ?? null;
  }

  async function seededCompanyWithMembers(opts: { roles?: { a?: string | null; b?: string | null } } = {}) {
    enableSeeds();
    const companyId = await seedCompany();
    const userA = await seedMember(companyId, { role: opts.roles?.a ?? "member" });
    const userB = await seedMember(companyId, { role: opts.roles?.b ?? "member" });
    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });
    return { companyId, userA, userB };
  }

  const toolRowsOf = async (companyId: string) => {
    const [connections, applications, profiles, bindings, installs, grants, catalog, oauthStates] = await Promise.all([
      db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId)),
      db.select().from(toolApplications).where(eq(toolApplications.companyId, companyId)),
      db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId)),
      db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId)),
      db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId)),
      db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId)),
      db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, companyId)),
      db.select().from(toolOauthStates).where(eq(toolOauthStates.companyId, companyId)),
    ]);
    return { connections, applications, profiles, bindings, installs, grants, catalog, oauthStates };
  };

  // ---- ensurePersonalDefaultMcpInstance ------------------------------------------------------

  it("two active humans in one company each get a stable, distinct personal instance; connecting twice is idempotent", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;

    const a1 = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const b1 = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);
    const a2 = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

    expect(a1.uid).toBe(`rh-google-mcp/default-mcp-personal/${userA}`);
    expect(b1.uid).toBe(`rh-google-mcp/default-mcp-personal/${userB}`);
    expect(a1.uid).not.toBe(b1.uid);
    expect(a2.id).toBe(a1.id); // repeat connect: same row, not a second one
    // Concurrent connects converge on one row per person.
    const [a3, a4] = await Promise.all([
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA),
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA),
    ]);
    expect(a3.id).toBe(a1.id);
    expect(a4.id).toBe(a1.id);

    const rows = await toolRowsOf(companyId);
    expect(rows.connections.filter((row) => (row.config as Record<string, unknown>)[DEFAULT_MCP_MANAGED_CONFIG_KEY] === "personal")).toHaveLength(2);
    expect(rows.grants).toHaveLength(0); // an instance row is consent plumbing only: no grant yet
    expect(rows.installs).toHaveLength(0);
    expect(rows.profiles).toHaveLength(0);
    expect(rows.bindings).toHaveLength(0);
    expect(rows.catalog).toHaveLength(0);
  });

  it("the instance copies the seed's endpoint and tags, is draft/disabled, per-user, personal_only, and owned by its creator", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const seed = (await googleSeed(companyId))!;
    const instance = await svc().ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

    expect(instance).toMatchObject({
      companyId,
      applicationId: seed.applicationId,
      uid: `rh-google-mcp/default-mcp-personal/${userA}`,
      connectionKind: "managed",
      ownership: "customer",
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "draft",
      enabled: false,
      createdByUserId: userA,
      createdByAgentId: null,
      credentialRefs: [],
      credentialSecretRefs: [],
    });
    const config = instance.config as Record<string, unknown>;
    expect(config).toMatchObject({
      url: GOOGLE_URL,
      mcpSessionRequired: true,
      quarantineNewEntries: true,
      [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "personal",
      [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: "rh-google-mcp",
      identityModel: "personal_only",
    });
    expect(config.defaultMcpTemplate).toBeUndefined();
    const transportConfig = instance.transportConfig as Record<string, unknown>;
    expect(transportConfig).toMatchObject({
      url: GOOGLE_URL,
      [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "personal",
      [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: "rh-google-mcp",
      identityModel: "personal_only",
    });
  });

  it("membership is the gate: non-members, invited, suspended, and agent principals get 403 and no row (viewers are refused by the route)", async () => {
    const { companyId } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const outsider = await seedMember(await seedCompany()); // active member of a DIFFERENT company
    const invited = await seedMember(companyId, { status: "invited" });
    const suspended = await seedMember(companyId, { status: "suspended" });
    const agentPrincipal = await seedMember(companyId, { principalType: "agent", noUserRow: true });

    for (const userId of [outsider, invited, suspended, agentPrincipal]) {
      await expect(
        service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userId),
      ).rejects.toMatchObject({ status: 403, details: { code: "active_membership_required" } });
    }
    const rows = await toolRowsOf(companyId);
    expect(rows.connections.filter((row) => row.createdByUserId !== null)).toHaveLength(0);
  });

  it("cross-company seeds fail closed: a foreign member gets 403 (by seed company) or 400 (by own company) and no row anywhere", async () => {
    const { companyId, userB } = await seededCompanyWithMembers();
    const otherCompanyId = await seedCompany();
    const foreigner = await seedMember(otherCompanyId);
    const seed = (await googleSeed(companyId))!;
    const service = svc();

    // Service called with the SEED's company: the foreign member fails the locked membership check.
    await expect(
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, foreigner),
    ).rejects.toMatchObject({ status: 403, details: { code: "active_membership_required" } });
    // Service called with the caller's own company: the foreign seed is simply not there.
    await expect(
      service.ensurePersonalDefaultMcpInstance(otherCompanyId, seed.id, foreigner),
    ).rejects.toMatchObject({ status: 400, details: { code: "default_mcp_seed_unavailable" } });

    for (const companyIdToCheck of [companyId, otherCompanyId]) {
      const rows = await toolRowsOf(companyIdToCheck);
      expect(rows.connections.filter((row) => row.createdByUserId === foreigner)).toHaveLength(0);
    }
    void userB;
  });

  it("a forged personal-instance row with the wrong owner is a 409 conflict, not a takeover", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const seed = (await googleSeed(companyId))!;
    // A row squatting on B's expected UID but owned by A.
    await db.insert(toolConnections).values({
      companyId,
      applicationId: seed.applicationId,
      name: "Squatter",
      uid: `rh-google-mcp/default-mcp-personal/${userB}`,
      connectionKind: "managed",
      ownership: "customer",
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "draft",
      enabled: false,
      config: { url: GOOGLE_URL, [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "personal", [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: "rh-google-mcp", identityModel: "personal_only" },
      transportConfig: {},
      credentialRefs: [],
      credentialSecretRefs: [],
      createdByUserId: userA,
    });

    await expect(
      svc().ensurePersonalDefaultMcpInstance(companyId, seed.id, userB),
    ).rejects.toMatchObject({ status: 409, details: { code: "personal_instance_conflict" } });
    // A still gets their own instance at their own UID.
    const aInstance = await svc().ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    expect(aInstance.uid).toBe(`rh-google-mcp/default-mcp-personal/${userA}`);
  });

  it("an archived seed is unavailable; an archived own instance revives to draft with every grant, credential, and review preserved", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

    // Owner-reviewed catalog + a user grant + an explicit install survive archival and revival byte-identically.
    const [catalogEntry] = await db
      .insert(toolCatalogEntries)
      .values({ companyId, applicationId: instance.applicationId, connectionId: instance.id, entryKind: "tool", name: "gmail_search", toolName: "gmail_search", title: "Gmail search", riskLevel: "read", isReadOnly: true, status: "active", reviewedAt: new Date(), versionHash: randomUUID(), schemaHash: randomUUID() })
      .returning();
    const [grant] = await db
      .insert(connectionGrants)
      .values({ companyId, connectionId: instance.id, kind: "user", subjectUserId: userA, status: "active", isDefault: false, credentialSecretRefs: [], createdByUserId: userA })
      .returning();
    const agent = await seedAgent(companyId);
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: instance.id, targetType: "agent", targetId: agent.id });

    await db.update(toolConnections).set({ status: "archived", updatedAt: new Date() }).where(eq(toolConnections.id, instance.id));
    const revived = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    expect(revived.id).toBe(instance.id);
    expect(revived.status).toBe("draft");
    expect(revived.config).toEqual(instance.config);
    expect(revived.credentialSecretRefs).toEqual(instance.credentialSecretRefs);
    const grantsAfter = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, instance.id));
    expect(grantsAfter).toEqual([grant]);
    const installsAfter = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, instance.id));
    expect(installsAfter).toHaveLength(1);
    const catalogAfter = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, instance.id));
    expect(catalogAfter).toEqual([catalogEntry]);
    // No re-mint, no wipe: no oauth state was created by revival.
    expect((await toolRowsOf(companyId)).oauthStates).toHaveLength(0);

    // An archived seed, in contrast, is gone for good.
    await db.update(toolConnections).set({ status: "archived", updatedAt: new Date() }).where(eq(toolConnections.id, seed.id));
    await expect(
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB),
    ).rejects.toMatchObject({ status: 400, details: { code: "default_mcp_seed_unavailable" } });
  });

  // ---- OAuth start gates ---------------------------------------------------------------------

  it("starting OAuth directly on a seed is a 409 with no OAuth state; A cannot start OAuth on B's instance", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const bInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);

    await expect(
      service.startOAuth(companyId, seed.id, { redirectUri: "https://paperclip.example.test/api/tools/oauth/callback", actor: userActor(userA) }),
    ).rejects.toMatchObject({ status: 409, details: { code: "default_mcp_seed_not_connectable" } });

    // A starting sign-in on B's instance: the fixed personal identity is B, so A is refused 403.
    await expect(
      service.startOAuth(companyId, bInstance.id, {
        redirectUri: "https://paperclip.example.test/api/tools/oauth/callback",
        actor: userActor(userA),
        subjectUserId: userA,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await toolRowsOf(companyId)).oauthStates).toHaveLength(0);
  });

  // ---- shared company identity is refused ----------------------------------------------------

  it("a shared organization identity (addConnectionInstallation) is refused on personal instances and seeds", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

    await expect(
      service.addConnectionInstallation(instance.id, { credentialSecretRefs: [] }, userActor(userA)),
    ).rejects.toMatchObject({ status: 422, details: { code: "personal_default_mcp_requires_personal_grant" } });
    await expect(
      service.addConnectionInstallation(seed.id, { credentialSecretRefs: [] }, userActor(userA)),
    ).rejects.toMatchObject({ status: 409, details: { code: "managed_template_not_installable" } });
    const rows = await toolRowsOf(companyId);
    expect(rows.grants).toHaveLength(0);
  });

  // ---- install producer gates ----------------------------------------------------------------

  it("seeds are never installable; personal instances are agent-only, owner-only, and one-owner-per-agent", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const aInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const bInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);
    const agent = await seedAgent(companyId, { state: agentState() });

    // A seed is not installable for anyone, company- or agent-targeted, even by the "owner".
    for (const installs of [
      [{ targetType: "company" as const, targetId: companyId }],
      [{ targetType: "agent" as const, targetId: agent.id }],
    ]) {
      await expect(
        service.putConnectionInstalls(seed.id, { installs }, userActor(userA)),
      ).rejects.toMatchObject({ status: 409, details: { code: "managed_template_not_installable" } });
    }

    // A personal instance cannot be installed company-wide, even by its owner.
    await expect(
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "company", targetId: companyId }] }, userActor(userA)),
    ).rejects.toMatchObject({ status: 422, details: { code: "company_install_not_permitted" } });

    // Only the personal connection owner may add installs: another human (even an
    // owner-role admin) and any agent actor are refused 403.
    await expect(
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userB)),
    ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
    await expect(
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, agentActor(agent.id)),
    ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
    expect((await toolRowsOf(companyId)).installs).toHaveLength(0);

    // The owner may install on their own agents.
    await service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userA));
    expect((await toolRowsOf(companyId)).installs).toHaveLength(1);

    // A second owner's same-entry instance on the same agent is a 409 conflict, both directions.
    await expect(
      service.putConnectionInstalls(bInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userB)),
    ).rejects.toMatchObject({ status: 409, details: { code: "personal_instance_conflict" } });

    // M4: A and B CONCURRENTLY add their same-entry instances to the SAME fresh
    // agent. The sorted shared per-agent/entry advisory locks serialize them:
    // exactly one install lands and the loser gets the 409 conflict — never two
    // rows, never a deadlock.
    const secondAgent = await seedAgent(companyId, { state: agentState() });
    const [aAttempt, bAttempt] = await Promise.allSettled([
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: secondAgent.id }] }, userActor(userA)),
      service.putConnectionInstalls(bInstance.id, { installs: [{ targetType: "agent", targetId: secondAgent.id }] }, userActor(userB)),
    ]);
    const winners = [aAttempt, bAttempt].filter((attempt) => attempt.status === "fulfilled");
    const losers = [aAttempt, bAttempt].filter((attempt) => attempt.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      details: { code: "personal_instance_conflict" },
    });
    const concurrentInstalls = await db
      .select()
      .from(toolConnectionInstalls)
      .where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, secondAgent.id)));
    expect(concurrentInstalls).toHaveLength(1);
    expect([aInstance.id, bInstance.id]).toContain(concurrentInstalls[0]!.connectionId);

    // Authorized removal (owner clears the install) is allowed.
    await service.putConnectionInstalls(aInstance.id, { installs: [] }, userActor(userA));
    expect((await toolRowsOf(companyId)).installs).toHaveLength(0);
    // And a non-owner clearing is a removal, not an addition: no owner gate applies.
    await service.putConnectionInstalls(aInstance.id, { installs: [] }, userActor(userB));
    expect((await toolRowsOf(companyId)).installs).toHaveLength(0);
  });

  it("COUNTEREXAMPLE (guard-all-producer-paths): a non-owner manager cannot finish/review someone else's personal instance", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers({ roles: { a: "member", b: "member" } });
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const bInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);
    // B's owner review is pending: one quarantined catalog entry from the consented catalog.
    const [quarantined] = await db
      .insert(toolCatalogEntries)
      .values({ companyId, applicationId: bInstance.applicationId, connectionId: bInstance.id, entryKind: "tool", name: "gmail_search", toolName: "gmail_search", title: "Gmail search", riskLevel: "read", isReadOnly: true, status: "quarantined", versionHash: randomUUID(), schemaHash: randomUUID() })
      .returning();

    // The finish route's gate (creator OR connection manager) lets a manager through; the
    // service must still refuse a non-owner finish: enabling B's quarantined tool and binding
    // the whole company is exactly the install/owner bypass the PUT path already refuses.
    const managerActor = userActor(userA);
    await expect(
      service.finishGalleryAppConnection(companyId, bInstance.id, {
        enabledCatalogEntryIds: [],
        askFirstCatalogEntryIds: [],
        reviewedCatalogEntryIds: [quarantined!.id],
        access: "all_agents",
      }, managerActor),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "personal_instance_owner_required" },
    });
    // No actor-owner fallback: an agent actor, and an omitted actor, are never the
    // personal owner either — only the validated personal subject may finish.
    const agent = await seedAgent(companyId, { state: agentState() });
    for (const finishActor of [agentActor(agent.id), undefined]) {
      await expect(
        service.finishGalleryAppConnection(companyId, bInstance.id, {
          enabledCatalogEntryIds: [],
          askFirstCatalogEntryIds: [],
          reviewedCatalogEntryIds: [quarantined!.id],
          access: "all_agents",
        }, finishActor),
      ).rejects.toMatchObject({
        status: 403,
        details: { code: "personal_instance_owner_required" },
      });
    }
    // The owner's own finish is the review path (covered end-to-end in the generic suite).
    // Regardless of the guard's shape, nothing may have been enabled or bound.
    const rows = await toolRowsOf(companyId);
    expect(rows.bindings).toHaveLength(0);
    expect(rows.profiles).toHaveLength(0);
    expect(rows.catalog.map((entry) => entry.status)).toEqual(["quarantined"]);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, bInstance.id)))[0]!.status).toBe("draft");
  });

  // ---- updateConnection (seed immutable; personal instance pinned) --------------------------

  it("a seed is server-owned: every public mutation except archiving is a 409, and archiving preserves it byte for byte", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;

    const mutations: Array<Record<string, unknown>> = [
      { name: "Renamed" },
      { enabled: true },
      { status: "active" },
      { transport: "stdio_command" },
      { authKind: "api_key" },
      { credentialPolicy: "shared" },
      { config: { url: "https://evil.example.test/mcp" } },
      { transportConfig: { url: "https://evil.example.test/mcp" } },
      { credentialSecretRefs: [{ secretId: randomUUID(), configPath: "oauth.access_token" }] },
      { credentialRefs: [{ name: "credentials.authorization", secretId: randomUUID(), version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }] },
      { name: "x", config: { [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "personal" } },
    ];
    for (const input of mutations) {
      await expect(service.updateConnection(seed.id, input as never)).rejects.toMatchObject({
        status: 409,
        details: { code: "managed_seed_immutable" },
      });
    }

    // The one allowed change: archiving (org opt-out). The row stays byte-identical otherwise.
    const before = (await googleSeed(companyId))!;
    await service.updateConnection(seed.id, { status: "archived" });
    const after = (await googleSeed(companyId))!;
    expect(after.status).toBe("archived");
    expect({ ...after, status: before.status, updatedAt: after.updatedAt }).toEqual({
      ...before,
      status: before.status,
      updatedAt: after.updatedAt,
    });
    void userA;
  });

  it("a personal instance is immutable except the enabled toggle and archiving: every identity/exfiltration mutation is a 409", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    // A real same-company secret so the secret-ref attempts pass shape validation and the
    // PERSONAL-INSTANCE guard (not a 422) is what the test observes.
    const secretService = (await import("../services/secrets.js")).secretService;
    const secret = await secretService(db).create(companyId, {
      name: "exfiltration attempt secret",
      key: `google.${randomUUID()}`,
      provider: "local_encrypted",
      value: "would-be-exfiltrated-token",
    });

    const refused: Array<Record<string, unknown>> = [
      { name: "My Google" },
      { transport: "local_stdio" },
      { authKind: "api_key" },
      { credentialPolicy: "shared" },
      { status: "active" },
      { config: { url: "https://evil.example.test/mcp", [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "dedicated" } },
      { transportConfig: { url: "https://evil.example.test/mcp" } },
      // H1: public attempts to re-route OAuth credentials/token endpoints are refused too.
      { config: { oauth: { tokenUrl: "https://evil.example.test/token", authorizationUrl: "https://evil.example.test/authorize" } } },
      { config: { oauth: { clientSecretEnv: "STOLEN_SECRET_ENV" } } },
      { transportConfig: { oauth: { tokenUrl: "https://evil.example.test/token" } } },
      { credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.exfiltrate" }] },
      { credentialRefs: [{ name: "credentials.authorization", secretId: secret.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }] },
      { enabled: true, name: "sneaky combo" },
    ];
    for (const input of refused) {
      await expect(service.updateConnection(instance.id, input as never)).rejects.toMatchObject({
        status: 409,
        details: { code: "personal_instance_immutable" },
      });
    }

    // The enabled toggle is the one allowed live change, and it pins every server-owned fact.
    const updated = await service.updateConnection(instance.id, { enabled: true });
    expect(updated.enabled).toBe(true);
    expect(updated.name).toBe(instance.name);
    expect(updated.transport).toBe("mcp_remote");
    expect(updated.authKind).toBe("oauth");
    expect(updated.credentialPolicy).toBe("per_user");
    const config = updated.config as Record<string, unknown>;
    expect(config).toEqual(instance.config);
    expect(updated.credentialSecretRefs).toEqual(instance.credentialSecretRefs);
    expect(updated.credentialRefs).toEqual(instance.credentialRefs);
    const transportConfig = updated.transportConfig as Record<string, unknown>;
    expect(transportConfig).toEqual(instance.transportConfig);

    // Archiving (the owner's removal) is allowed and preserves everything else.
    const archived = await service.updateConnection(instance.id, { status: "archived" });
    expect(archived.status).toBe("archived");
    expect(archived.config).toEqual(instance.config);
    expect(archived.credentialSecretRefs).toEqual(instance.credentialSecretRefs);
  });

  // ---- install gate / effective profiles / token mint ----------------------------------------

  it("managedInstallCheck and effective profiles exclude seeds for legacy and snapshot-managed agents, whatever rows exist", async () => {
    const { companyId } = await seededCompanyWithMembers();
    const seed = (await googleSeed(companyId))!;
    const legacyAgent = await seedAgent(companyId); // no defaultMcp state
    const stateAgent = await seedAgent(companyId, { state: agentState() });

    // Forged rows: company install + company profile binding + active catalog on the seed.
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: seed.id, targetType: "company", targetId: companyId });
    const [profile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `app:${seed.id}`, name: "seed profile", defaultAction: "deny" })
      .returning();
    await db.insert(toolCatalogEntries).values({ companyId, applicationId: seed.applicationId, connectionId: seed.id, entryKind: "tool", name: "gmail_search", toolName: "gmail_search", title: "Gmail search", riskLevel: "read", isReadOnly: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID() });
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "connection", effect: "include", connectionId: seed.id });
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "company", targetId: companyId });

    for (const agent of [legacyAgent, stateAgent]) {
      const identity = { id: seed.id, companyId, name: seed.name, config: seed.config };
      const check = await managedInstallCheck(db, { companyId, agentId: agent.id, connections: [identity] });
      expect(check.blocked.has(seed.id)).toBe(true);
      // The install projection excludes the seed even with the forged install row
      // (the company-bound profile keeping it "permitted" mirrors the managed-template
      // behavior: visible, but never installed and never callable).
      const effective = await svc().getEffectiveProfilesForAgent(companyId, agent.id);
      expect(effective.installedConnections.map((connection) => connection.id)).not.toContain(seed.id);
    }
  });

  it("minting a token for a seed is refused 403 installation_required before any secret is touched", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const seed = (await googleSeed(companyId))!;
    const agent = await seedAgent(companyId, { state: agentState() });
    // A forged install row that tries to make the seed look installed.
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: seed.id, targetType: "agent", targetId: agent.id });
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: agent.id, status: "running", contextSnapshot: {}, responsibleUserId: userA })
      .returning();

    await expect(
      svc().mintConnectionTokenForAgent({ connectionId: seed.id, companyId, agentId: agent.id, runId: run!.id, body: {} }),
    ).rejects.toMatchObject({ details: { code: "installation_required" } });
    expect(await db.select().from(secretAccessEvents)).toHaveLength(0); // no secret was decrypted
    const issuances = await db.select().from(connectionTokenIssuances).where(eq(connectionTokenIssuances.connectionId, seed.id));
    expect(issuances.map((row) => [row.outcome, row.errorCode])).toContainEqual(["denied", "installation_required"]);
  });

  it("a run whose responsible user is not the installed instance's owner is refused 409 user_authorization_required before secret use", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const aInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const agent = await seedAgent(companyId, { state: agentState() });
    await service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userA));
    // A's personal grant (the credential the mint would resolve for A).
    const secretService = (await import("../services/secrets.js")).secretService;
    const secret = await secretService(db).create(companyId, {
      name: "a google tokens",
      key: `google.${randomUUID()}`,
      provider: "local_encrypted",
      value: "a-access-token-value",
    });
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: aInstance.id,
      kind: "user",
      subjectUserId: userA,
      status: "active",
      isDefault: false,
      credentialSecretRefs: [{ secretId: secret!.id, configPath: "oauth.access_token" }],
      createdByUserId: userA,
    });

    // B is an active member and responsible for the run, but the only grant on this
    // instance belongs to A: B's runtime may not use A's personal Google account.
    const [bRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: agent.id, status: "running", contextSnapshot: {}, responsibleUserId: userB })
      .returning();
    await expect(
      service.mintConnectionTokenForAgent({ connectionId: aInstance.id, companyId, agentId: agent.id, runId: bRun!.id, body: {} }),
    ).rejects.toMatchObject({ status: 409, details: { code: "user_authorization_required" } });
    expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
    const denied = await db.select().from(connectionTokenIssuances).where(eq(connectionTokenIssuances.connectionId, aInstance.id));
    expect(denied.map((row) => [row.outcome, row.errorCode])).toContainEqual(["denied", "user_authorization_required"]);

    // The owner's own responsible run passes the grant gate (it then stops at the
    // still-draft connection, which proves the gate is about the responsible user).
    const [aRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: agent.id, status: "running", contextSnapshot: {}, responsibleUserId: userA })
      .returning();
    await expect(
      service.mintConnectionTokenForAgent({ connectionId: aInstance.id, companyId, agentId: agent.id, runId: aRun!.id, body: {} }),
    ).rejects.not.toMatchObject({ details: { code: "user_authorization_required" } });
    expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
  });
});
