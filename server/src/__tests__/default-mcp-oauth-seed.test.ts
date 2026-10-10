import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
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
import { companyService } from "../services/companies.js";
import { secretService } from "../services/secrets.js";
import {
  DEFAULT_MCP_SPEC_ENABLED_ENV,
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY,
  DEFAULT_MCP_MANAGED_CONFIG_KEY,
  installAppliesToAgent,
  managedConnectionRole,
  readDefaultMcpState,
  type DefaultMcpAgentState,
} from "../services/default-mcp-spec.js";
import {
  DEFAULT_MCP_OAUTH_SEED_SWEEP_LIMIT,
  defaultMcpApplicationKey,
  defaultMcpSeedUid,
  ensureCompanyDefaultMcpOAuthSeeds,
  scheduleCompanyDefaultMcpOAuthSeedsEnsure,
  startDefaultMcpOAuthSeedSweep,
  sweepDefaultMcpOAuthSeeds,
  validOAuthSeedEndpoint,
  waitForScheduledCompanyOAuthSeeds,
} from "../services/default-mcp-oauth-seed.js";
import {
  DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  __resetDefaultMcpTemplateScopeForTests,
  captureDefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
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
  installBootProvisionerSnapshot,
} from "./helpers/comms-board-downstream.js";
import {
  __resetCompanyTemplateDeferralsForTests,
  waitForScheduledCompanyTemplates,
} from "../services/default-mcp-template.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * TECH-7340 — discovery-only OAuth seeds for the default MCP spec.
 *
 * These tests never touch the network: seeding is RAM/DB only, and every test
 * asserts that assertion by stubbing global fetch (the authoritative prod URLs
 * appear only as inert strings).
 */
const GOOGLE_URL_ENV = "PAPERCLIP_DEFAULT_MCP_RH_GOOGLE_MCP_URL";
const RH_URL_ENV = "PAPERCLIP_DEFAULT_MCP_RH_MCP_URL";
// Authoritative endpoint values (read-only confirmed); used as inert config strings only.
const GOOGLE_URL = "https://rh-google-mcp.drum-mackarel.ts.net/mcp";
const RH_URL = "https://rh-mcp.drum-mackarel.ts.net/mcp";

describe("validOAuthSeedEndpoint (TECH-7340 URL rules)", () => {
  it("accepts absolute https URLs, including the authoritative prod endpoints", () => {
    expect(validOAuthSeedEndpoint(GOOGLE_URL)).toBe(true);
    expect(validOAuthSeedEndpoint(RH_URL)).toBe(true);
    expect(validOAuthSeedEndpoint("https://example.com/mcp")).toBe(true);
    expect(validOAuthSeedEndpoint("https://example.com")).toBe(true);
  });

  it("accepts http only for loopback hostnames, case-insensitively", () => {
    expect(validOAuthSeedEndpoint("http://127.0.0.1:3200/mcp")).toBe(true);
    expect(validOAuthSeedEndpoint("http://localhost:3200/mcp")).toBe(true);
    expect(validOAuthSeedEndpoint("http://LOCALHOST/mcp")).toBe(true);
    expect(validOAuthSeedEndpoint("http://[::1]:3200/mcp")).toBe(true);
  });

  it("rejects plain external http and other schemes", () => {
    expect(validOAuthSeedEndpoint("http://example.com/mcp")).toBe(false);
    expect(validOAuthSeedEndpoint("http://10.0.0.5/mcp")).toBe(false);
    expect(validOAuthSeedEndpoint("ftp://example.com/mcp")).toBe(false);
    expect(validOAuthSeedEndpoint("ws://example.com/mcp")).toBe(false);
    expect(validOAuthSeedEndpoint("example.com/mcp")).toBe(false);
    expect(validOAuthSeedEndpoint("")).toBe(false);
    expect(validOAuthSeedEndpoint("not a url")).toBe(false);
  });

  it("rejects userinfo, query strings, and fragments", () => {
    expect(validOAuthSeedEndpoint("https://user:pass@example.com/mcp")).toBe(false);
    expect(validOAuthSeedEndpoint(`${GOOGLE_URL}?tenant=x`)).toBe(false);
    expect(validOAuthSeedEndpoint(`${GOOGLE_URL}#frag`)).toBe(false);
    expect(validOAuthSeedEndpoint("http://user@127.0.0.1:3200/mcp")).toBe(false);
    expect(validOAuthSeedEndpoint("http://127.0.0.1:3200/mcp?a=1")).toBe(false);
    expect(validOAuthSeedEndpoint("http://127.0.0.1:3200/mcp#f")).toBe(false);
  });

  it("derives the pinned fixed seed UID and application key from the spec entry", () => {
    expect(defaultMcpSeedUid("rh-google-mcp")).toBe("rh-google-mcp/default-mcp-seed");
    expect(defaultMcpSeedUid("rh-mcp-personal")).toBe("rh-mcp-personal/default-mcp-seed");
    expect(defaultMcpApplicationKey("rh-google-mcp")).toBe("default-mcp-rh-google-mcp");
    expect(defaultMcpApplicationKey("rh-mcp")).toBe("default-mcp-rh-mcp");
  });
});

describeEmbeddedPostgres("default MCP OAuth discovery-only seeds (TECH-7340)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-oauth-seed-${randomUUID()}`);
  const envKeys = [
    DEFAULT_MCP_SPEC_ENABLED_ENV,
    GOOGLE_URL_ENV,
    RH_URL_ENV,
    DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
    COMMS_BOARD_MCP_URL_ENV,
    COMMS_BOARD_ADMIN_TOKEN_ENV,
    COMMS_BOARD_OWNERSHIP_API_URL_ENV,
    COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  ];
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-oauth-seed");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
    __resetCompanyTemplateDeferralsForTests();
    __resetDefaultMcpTemplateScopeForTests();
    // Seeds are local DB only: any fetch attempt is a bug. A throwing stub makes
    // an accidental network call loud and observable.
    fetchSpy = vi.fn(() => {
      throw new Error("default MCP OAuth seeding must not make network calls");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    await waitForScheduledCompanyTemplates();
    await waitForScheduledCompanyOAuthSeeds();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
    __resetCompanyTemplateDeferralsForTests();
    __resetDefaultMcpTemplateScopeForTests();
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(connectionTokenIssuances);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(agentWakeupRequests);
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

  function seedEnv() {
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";
    process.env[GOOGLE_URL_ENV] = GOOGLE_URL;
    process.env[RH_URL_ENV] = RH_URL;
    // Boot-frozen rollout scope (first capture wins): unset means every company.
    // The beforeEach reset leaves it uncaptured (none), so capture it here.
    captureDefaultMcpTemplateScope({});
  }

  async function seedCompany(opts: {
    status?: "active" | "paused" | "archived";
    createdAt?: Date;
  } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: opts.status ?? "active",
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
    return companyId;
  }

  async function seedMember(companyId: string, opts: { role?: string | null; status?: string; principalType?: "user" | "agent" } = {}) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Member",
      email: `${userId}@redesignhealth.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: opts.principalType ?? "user",
      principalId: userId,
      status: opts.status ?? "active",
      membershipRole: opts.role === undefined ? "owner" : opts.role,
      createdAt: now,
    });
    return userId;
  }

  const seedRows = (companyId: string) =>
    db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.companyId, companyId))
      .orderBy(asc(toolConnections.id));

  const seedRow = async (companyId: string, uid: string) => {
    const [row] = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.uid, uid)));
    return row ?? null;
  };

  const rowCounts = async (companyId: string) => ({
    connections: (await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId))).length,
    applications: (await db.select().from(toolApplications).where(eq(toolApplications.companyId, companyId))).length,
    secrets: (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).length,
    grants: (await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId))).length,
    profiles: (await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId))).length,
    bindings: (await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))).length,
    installs: (await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId))).length,
    catalog: (await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, companyId))).length,
    oauthStates: (await db.select().from(toolOauthStates).where(eq(toolOauthStates.companyId, companyId))).length,
    wakeups: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).length,
    runs: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).length,
  });

  const zeroSideEffects = {
    secrets: 0,
    grants: 0,
    profiles: 0,
    bindings: 0,
    installs: 0,
    catalog: 0,
    oauthStates: 0,
    wakeups: 0,
    runs: 0,
  };

  // ---- exact seed shape ---------------------------------------------------------------------

  it("creates an exact discovery-only seed: draft, disabled, per_user, personal_only, tagged, fixed UID, no creator", async () => {
    seedEnv();
    const companyId = await seedCompany();

    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });

    const googleSeed = await seedRow(companyId, "rh-google-mcp/default-mcp-seed");
    const rhSeed = await seedRow(companyId, "rh-mcp-personal/default-mcp-seed");
    expect(googleSeed).not.toBeNull();
    expect(rhSeed).not.toBeNull();

    const expectedSeeds = [
      {
        row: googleSeed!,
        uid: "rh-google-mcp/default-mcp-seed",
        name: "RH Google MCP",
        url: GOOGLE_URL,
        tag: "rh-google-mcp",
      },
      {
        row: rhSeed!,
        uid: "rh-mcp-personal/default-mcp-seed",
        name: "RH MCP",
        url: RH_URL,
        tag: "rh-mcp",
      },
    ];
    for (const expected of expectedSeeds) {
      expect(expected.row).toMatchObject({
        companyId,
        uid: expected.uid,
        name: expected.name,
        connectionKind: "managed",
        ownership: "customer",
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "draft",
        enabled: false,
        createdByUserId: null,
        createdByAgentId: null,
        credentialRefs: [],
        credentialSecretRefs: [],
      });
      const config = expected.row.config as Record<string, unknown>;
      expect(config).toMatchObject({
        url: expected.url,
        mcpSessionRequired: true,
        quarantineNewEntries: true,
        [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "seed",
        [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: expected.tag,
        identityModel: "personal_only",
      });
      expect(config.defaultMcpTemplate).toBeUndefined();
      const transportConfig = expected.row.transportConfig as Record<string, unknown>;
      expect(transportConfig).toMatchObject({
        url: expected.url,
        quarantineNewEntries: true,
        [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "seed",
        [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: expected.tag,
        identityModel: "personal_only",
      });
    }

    const apps = await db.select().from(toolApplications).where(eq(toolApplications.companyId, companyId));
    expect(apps.map((app) => [app.applicationKey, app.type, app.name, app.status]).sort()).toEqual([
      ["default-mcp-rh-google-mcp", "mcp_http", "RH Google MCP", "active"],
      ["default-mcp-rh-mcp", "mcp_http", "RH MCP", "active"],
    ]);
  });

  it("seeding is local-only: zero HTTP calls, zero grants/secrets/catalog/profiles/bindings/installs/wakes", async () => {
    seedEnv();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);

    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rowCounts(companyId)).toMatchObject({
      ...zeroSideEffects,
      connections: 2, // the two seeds only
      applications: 2,
    });
    // No agent metadata was written and no default-MCP state exists anywhere.
    const agentRows = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.companyId, companyId));
    expect(agentRows).toHaveLength(0);
    void ownerId;
  });

  it("a second ensure neither inserts nor updates anything (idempotent, byte-identical rows)", async () => {
    seedEnv();
    const companyId = await seedCompany();
    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });
    const before = await seedRows(companyId);
    const beforeUpdatedAt = before.map((row) => row.updatedAt);

    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });
    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });

    const after = await seedRows(companyId);
    expect(after).toEqual(before);
    expect(after.map((row) => row.updatedAt)).toEqual(beforeUpdatedAt);
    expect((await rowCounts(companyId)).connections).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("concurrent ensures for one company converge on exactly one row per entry (advisory lock + unique)", async () => {
    seedEnv();
    const companyId = await seedCompany();

    await Promise.all(
      Array.from({ length: 4 }, () => ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId })),
    );

    const seeds = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.companyId, companyId));
    expect(seeds.filter((row) => (row.config as Record<string, unknown>)[DEFAULT_MCP_MANAGED_CONFIG_KEY] === "seed")).toHaveLength(2);
    expect((await rowCounts(companyId)).applications).toBe(2);
  });

  // ---- gating -------------------------------------------------------------------------------

  it("flag OFF, scope NONE, missing/invalid endpoint URL, and out-of-scope companies all skip with zero rows", async () => {
    const companyId = await seedCompany();

    // Feature flag off: even with URLs set, nothing happens.
    process.env[GOOGLE_URL_ENV] = GOOGLE_URL;
    process.env[RH_URL_ENV] = RH_URL;
    await ensureCompanyDefaultMcpOAuthSeeds({ db, scope: { mode: "all" } }, { companyId });
    expect(await rowCounts(companyId)).toMatchObject({ connections: 0, applications: 0 });

    // Flag on, but rollout scope empty string (staged) -> no company.
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";
    const envOf = (extra: Record<string, string>) =>
      ({ ...process.env, ...extra }) as NodeJS.ProcessEnv;
    await ensureCompanyDefaultMcpOAuthSeeds(
      { db, env: envOf({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: " " }) },
      { companyId },
    );
    expect(await rowCounts(companyId)).toMatchObject({ connections: 0, applications: 0 });

    // Flag on, allowlist without this company -> skipped.
    await ensureCompanyDefaultMcpOAuthSeeds(
      { db, env: envOf({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: randomUUID() }) },
      { companyId },
    );
    expect(await rowCounts(companyId)).toMatchObject({ connections: 0, applications: 0 });

    // Flag on, scope all, no URL env at all -> both entries skip (availability disabled).
    delete process.env[GOOGLE_URL_ENV];
    delete process.env[RH_URL_ENV];
    await ensureCompanyDefaultMcpOAuthSeeds({ db, scope: { mode: "all" } }, { companyId });
    expect(await rowCounts(companyId)).toMatchObject({ connections: 0, applications: 0 });

    // Invalid endpoint (plain external http, userinfo) -> skipped even when set.
    process.env[GOOGLE_URL_ENV] = "http://rh-google-mcp.internal.example/mcp";
    process.env[RH_URL_ENV] = "https://user:pass@rh-mcp.example/mcp";
    await ensureCompanyDefaultMcpOAuthSeeds({ db, scope: { mode: "all" } }, { companyId });
    expect(await rowCounts(companyId)).toMatchObject({ connections: 0, applications: 0 });

    // One valid, one invalid URL: only the valid entry seeds.
    process.env[GOOGLE_URL_ENV] = GOOGLE_URL;
    await ensureCompanyDefaultMcpOAuthSeeds({ db, scope: { mode: "all" } }, { companyId });
    expect((await rowCounts(companyId)).connections).toBe(1);
    expect(await seedRow(companyId, "rh-google-mcp/default-mcp-seed")).not.toBeNull();
    expect(await seedRow(companyId, "rh-mcp-personal/default-mcp-seed")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an allowlisted company is seeded; archived companies are skipped, paused companies are seeded", async () => {
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";
    const allowlisted = await seedCompany();
    const archived = await seedCompany({ status: "archived" });
    const paused = await seedCompany({ status: "paused" });
    const env = {
      ...process.env,
      [GOOGLE_URL_ENV]: GOOGLE_URL,
      [RH_URL_ENV]: RH_URL,
      [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: `${allowlisted},${paused},${archived}`,
    } as NodeJS.ProcessEnv;

    await ensureCompanyDefaultMcpOAuthSeeds({ db, env }, { companyId: allowlisted });
    await ensureCompanyDefaultMcpOAuthSeeds({ db, env }, { companyId: paused });
    await ensureCompanyDefaultMcpOAuthSeeds({ db, env }, { companyId: archived });

    expect((await rowCounts(allowlisted)).connections).toBe(2);
    expect((await rowCounts(paused)).connections).toBe(2);
    expect(await rowCounts(archived)).toMatchObject({ connections: 0, applications: 0 });
  });

  it("an archived seed row is an org opt-out: never recreated, never updated", async () => {
    seedEnv();
    const companyId = await seedCompany();
    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });
    const seed = (await seedRow(companyId, "rh-google-mcp/default-mcp-seed"))!;
    await db
      .update(toolConnections)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(toolConnections.id, seed.id));
    const archived = await seedRow(companyId, "rh-google-mcp/default-mcp-seed");
    const archivedUpdatedAt = archived!.updatedAt;

    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });
    await sweepDefaultMcpOAuthSeeds({ db, env: process.env });

    const stillArchived = await seedRow(companyId, "rh-google-mcp/default-mcp-seed");
    expect(stillArchived!.status).toBe("archived");
    expect(stillArchived!.updatedAt).toEqual(archivedUpdatedAt);
    // The sweep does not even select this company: the (archived) row exists.
    const sweepCount = await sweepDefaultMcpOAuthSeeds({ db, env: { ...process.env } as NodeJS.ProcessEnv });
    expect(sweepCount).toBe(0);
  });

  it("a colliding application (wrong type or archived) blocks the seed, warns once, and never loops", async () => {
    seedEnv();
    const companyId = await seedCompany();
    // A pre-existing app squatting on the seed's application key, wrong type.
    await db.insert(toolApplications).values({
      companyId,
      applicationKey: "default-mcp-rh-google-mcp",
      name: "Squatter",
      type: "chat",
      status: "active",
      metadata: {},
    });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });
    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });

    expect(await seedRow(companyId, "rh-google-mcp/default-mcp-seed")).toBeNull();
    const googleApp = await db
      .select()
      .from(toolApplications)
      .where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.applicationKey, "default-mcp-rh-google-mcp")));
    expect(googleApp).toHaveLength(1);
    expect(googleApp[0]!.type).toBe("chat"); // untouched
    expect((await rowCounts(companyId)).connections).toBe(1); // only the rh-mcp seed
    expect(warnSpy).toHaveBeenCalledTimes(1); // deduped per company+app
    expect(warnSpy.mock.calls[0]![0]).toMatchObject({ companyId, applicationKey: "default-mcp-rh-google-mcp" });

    // After the ensure, every entry is either seeded (rh-mcp) or terminally blocked
    // (the google collision): the sweep no longer selects this company at all, so a
    // terminal collision never re-occupies a sweep tick (M5: no head-block, no loop).
    const processed = await sweepDefaultMcpOAuthSeeds({ db, env: process.env as NodeJS.ProcessEnv });
    expect(processed).toBe(0);
    expect(await seedRow(companyId, "rh-google-mcp/default-mcp-seed")).toBeNull();
    expect(await seedRow(companyId, "rh-mcp-personal/default-mcp-seed")).not.toBeNull();

    // An ARCHIVED colliding app is also a conflict, not a resurrection path.
    const other = await seedCompany();
    await db.insert(toolApplications).values({
      companyId: other,
      applicationKey: "default-mcp-rh-mcp",
      name: "Old app",
      type: "mcp_http",
      status: "active",
      metadata: {},
      archivedAt: new Date(),
    });
    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId: other });
    expect(await seedRow(other, "rh-mcp-personal/default-mcp-seed")).toBeNull();
    expect((await rowCounts(other)).connections).toBe(1); // only the google seed
  });

  it("M5: 25 terminal app collisions never starve a later eligible company in the same sweep tick", async () => {
    seedEnv();
    // 25 OLDER companies whose BOTH entry application keys are terminally blocked
    // (wrong type): they can never be seeded and must be excluded from eligibility
    // entirely, not occupy the 25-per-tick budget.
    for (let index = 0; index < DEFAULT_MCP_OAUTH_SEED_SWEEP_LIMIT; index += 1) {
      const blockedCompanyId = await seedCompany({ createdAt: new Date(Date.UTC(2019, 0, 1 + index)) });
      await db.insert(toolApplications).values([
        { companyId: blockedCompanyId, applicationKey: "default-mcp-rh-google-mcp", name: "Squatter A", type: "chat", status: "active", metadata: {} },
        { companyId: blockedCompanyId, applicationKey: "default-mcp-rh-mcp", name: "Squatter B", type: "chat", status: "active", metadata: {} },
      ]);
    }
    // One LATER, fully eligible company would be starved by a naive oldest-first 25 if the
    // blocked companies were still selected every tick.
    const eligible = await seedCompany({ createdAt: new Date(Date.UTC(2026, 0, 1)) });

    const firstTick = await sweepDefaultMcpOAuthSeeds({ db, env: process.env as NodeJS.ProcessEnv });
    expect(firstTick).toBe(1);
    expect(await seedRow(eligible, "rh-google-mcp/default-mcp-seed")).not.toBeNull();
    expect(await seedRow(eligible, "rh-mcp-personal/default-mcp-seed")).not.toBeNull();
    // The blocked companies stay seedless, and no later tick is occupied by them either.
    const secondTick = await sweepDefaultMcpOAuthSeeds({ db, env: process.env as NodeJS.ProcessEnv });
    expect(secondTick).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the sweep seeds companies missing seeds, oldest first, bounded by 25 per tick", async () => {
    seedEnv();
    const companyIds: string[] = [];
    for (let index = 0; index < DEFAULT_MCP_OAUTH_SEED_SWEEP_LIMIT + 5; index += 1) {
      companyIds.push(
        await seedCompany({ createdAt: new Date(Date.UTC(2020, 0, 1 + index)) }),
      );
    }
    const oldest = companyIds[0]!;
    const overflow = companyIds[DEFAULT_MCP_OAUTH_SEED_SWEEP_LIMIT]!;

    const first = await sweepDefaultMcpOAuthSeeds({ db, env: process.env as NodeJS.ProcessEnv });
    expect(first).toBe(DEFAULT_MCP_OAUTH_SEED_SWEEP_LIMIT);
    const oldestSeed = await seedRow(oldest, "rh-google-mcp/default-mcp-seed");
    expect(oldestSeed).not.toBeNull();
    expect(await seedRow(overflow, "rh-google-mcp/default-mcp-seed")).toBeNull();

    const second = await sweepDefaultMcpOAuthSeeds({ db, env: process.env as NodeJS.ProcessEnv });
    expect(second).toBe(5);
    expect(await seedRow(overflow, "rh-google-mcp/default-mcp-seed")).not.toBeNull();
    const third = await sweepDefaultMcpOAuthSeeds({ db, env: process.env as NodeJS.ProcessEnv });
    expect(third).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("startDefaultMcpOAuthSeedSweep kicks an immediate tick and stop() halts it", async () => {
    seedEnv();
    const companyId = await seedCompany();
    const stop = startDefaultMcpOAuthSeedSweep(db, { env: process.env as NodeJS.ProcessEnv });
    try {
      // The initial tick is setImmediate; poll briefly for the seeded rows.
      let seeded = false;
      for (let attempt = 0; attempt < 100 && !seeded; attempt += 1) {
        seeded = (await seedRow(companyId, "rh-google-mcp/default-mcp-seed")) !== null;
        if (!seeded) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(seeded).toBe(true);
      expect(await seedRow(companyId, "rh-mcp-personal/default-mcp-seed")).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      stop();
    }
    // Flag off: a no-op sweep starter returns a no-op stop.
    delete process.env[DEFAULT_MCP_SPEC_ENABLED_ENV];
    const noopStop = startDefaultMcpOAuthSeedSweep(db, { env: process.env as NodeJS.ProcessEnv });
    noopStop();
  });

  // ---- hooks (company create + reactivate) ---------------------------------------------------

  it("company creation schedules the seed ensure (create hook)", async () => {
    seedEnv();
    // The comms template ensure also fires on creation; pin its downstream config
    // to the fixture URLs so its (failing) provisioning is caught, never a network call.
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
    fetchSpy.mockImplementation(() => Promise.reject(new Error("no network in tests")));

    const created = await companyService(db).create({ name: `Hooked ${randomUUID().slice(0, 6)}` });
    await waitForScheduledCompanyOAuthSeeds();

    expect(await seedRow(created.id, "rh-google-mcp/default-mcp-seed")).not.toBeNull();
    expect(await seedRow(created.id, "rh-mcp-personal/default-mcp-seed")).not.toBeNull();
  });

  it("company reactivation (archived -> active) schedules the seed ensure (reactivate hook)", async () => {
    seedEnv();
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
    fetchSpy.mockImplementation(() => Promise.reject(new Error("no network in tests")));

    const created = await companyService(db).create({ name: `Re ${randomUUID().slice(0, 6)}` });
    await waitForScheduledCompanyOAuthSeeds();
    const before = await seedRow(created.id, "rh-google-mcp/default-mcp-seed");
    expect(before).not.toBeNull();

    await companyService(db).update(created.id, { status: "archived" });
    await waitForScheduledCompanyOAuthSeeds();
    const afterArchive = await seedRow(created.id, "rh-google-mcp/default-mcp-seed");
    // Archiving never removes rows; the archived seed is an opt-out, so reactivation
    // must NOT recreate a second row either.
    await companyService(db).update(created.id, { status: "active" });
    await waitForScheduledCompanyOAuthSeeds();
    await waitForScheduledCompanyTemplates();

    const rows = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, created.id), eq(toolConnections.uid, "rh-google-mcp/default-mcp-seed")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(rows[0]!.config).toEqual(afterArchive!.config);

    // A reactivate hook against a company whose seed rows were fully absent seeds them.
    const direct = await seedCompany({ status: "archived" });
    await companyService(db).update(direct, { status: "active" });
    await waitForScheduledCompanyOAuthSeeds();
    expect(await seedRow(direct, "rh-google-mcp/default-mcp-seed")).not.toBeNull();
    expect(await seedRow(direct, "rh-mcp-personal/default-mcp-seed")).not.toBeNull();
  });

  it("scheduleCompanyDefaultMcpOAuthSeedsEnsure is non-blocking and lands exactly one row per entry", async () => {
    seedEnv();
    const companyId = await seedCompany();
    scheduleCompanyDefaultMcpOAuthSeedsEnsure(db, { companyId });
    scheduleCompanyDefaultMcpOAuthSeedsEnsure(db, { companyId });
    await waitForScheduledCompanyOAuthSeeds();

    expect((await rowCounts(companyId)).connections).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---- preservation of manual canonical rows -------------------------------------------------

  it("seeding preserves manual canonical Google/RH rows, their profiles, installs, and credentials byte-identically", async () => {
    seedEnv();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);

    // A manual canonical Google org row (the entry's connectionName) with real
    // install + curated profile + stored credential.
    const googleApp = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: "RH Google MCP (manual)", type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const secret = await secretService(db).create(companyId, {
      name: "manual google key",
      key: `google.${randomUUID()}`,
      provider: "local_encrypted",
      value: "manual-credential",
    });
    const manualGoogle = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: googleApp.id,
        name: "rh-google-mcp",
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "active",
        enabled: true,
        config: { url: GOOGLE_URL, identityModel: "personal_only" },
        transportConfig: { url: GOOGLE_URL },
        credentialRefs: [{ name: "credentials.authorization", secretId: secret.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }],
        credentialSecretRefs: [],
        createdByUserId: ownerId,
      })
      .returning()
      .then((rows) => rows[0]!);
    const googleProfile = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `app:${manualGoogle.id}`, name: "rh-google-mcp access", defaultAction: "deny" })
      .returning()
      .then((rows) => rows[0]!);
    const googleCatalog = await db
      .insert(toolCatalogEntries)
      .values({ companyId, applicationId: googleApp.id, connectionId: manualGoogle.id, entryKind: "tool", name: "gmail_search", toolName: "gmail_search", title: "Gmail search", riskLevel: "read", isReadOnly: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID() })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(toolProfileEntries).values({ companyId, profileId: googleProfile.id, selectorType: "catalog_entry", effect: "include", applicationId: googleApp.id, connectionId: manualGoogle.id, catalogEntryId: googleCatalog.id });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: manualGoogle.id, targetType: "company", targetId: companyId });

    // A manual canonical RH personal template row (valid per templateRequirements).
    const rhApp = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: "RH MCP (manual)", type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const manualRh = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: rhApp.id,
        name: "rh-mcp-personal",
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "active",
        enabled: true,
        config: { url: RH_URL, identityModel: "personal_only", [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: "rh-mcp" },
        transportConfig: { url: RH_URL },
        credentialRefs: [],
        credentialSecretRefs: [],
        createdByUserId: ownerId,
      })
      .returning()
      .then((rows) => rows[0]!);
    // Reserved-shaped fixtures (odd but legitimate operator rows) that must also stay untouched.
    const arcApp = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: "Arc Tools", type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const manualArc = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: arcApp.id,
        name: "Chief MCP",
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind: "none",
        credentialPolicy: "shared",
        status: "active",
        enabled: true,
        config: { url: "https://chief.example.test/mcp" },
        transportConfig: {},
        credentialRefs: [],
        credentialSecretRefs: [],
      })
      .returning()
      .then((rows) => rows[0]!);

    const snapshotRows = async () =>
      db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId)).orderBy(toolConnections.id);
    const before = await snapshotRows();
    const profilesBefore = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId));
    const installsBefore = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId));
    const secretsBefore = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));

    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });

    const after = await snapshotRows();
    // The two new seed rows are ADDITIVE; every pre-existing row is byte-identical.
    const beforeById = new Map(before.map((row) => [row.id, row]));
    for (const row of after) {
      const prior = beforeById.get(row.id);
      if (prior) expect(row).toEqual(prior);
    }
    expect(after).toHaveLength(before.length + 2);
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId))).toEqual(profilesBefore);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId))).toEqual(installsBefore);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toEqual(secretsBefore);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Generated DISPLAY names never hijack the legacy exact-name finder: the manual
    // canonical rows keep their roles, and the seed rows are forbidden outright.
    const state: DefaultMcpAgentState = {
      version: 1,
      entries: {
        "rh-google-mcp": {
          key: "rh-google-mcp",
          templateKey: "rh-google-mcp",
          dedicated: false,
          enabled: false,
          templateConnectionId: manualGoogle.id,
          connectionId: manualGoogle.id,
          ownerUserId: ownerId,
          setup: { state: "not_required", reason: null, attemptCount: 0, nextAttemptAt: null, leaseUntil: null, claimId: null, registerAttemptedAt: null, mintAttemptedAt: null, updatedAt: new Date().toISOString() },
          binding: null,
        },
        "rh-mcp": {
          key: "rh-mcp",
          templateKey: "rh-mcp-personal",
          dedicated: false,
          enabled: false,
          templateConnectionId: manualRh.id,
          connectionId: manualRh.id,
          ownerUserId: ownerId,
          setup: { state: "not_required", reason: null, attemptCount: 0, nextAttemptAt: null, leaseUntil: null, claimId: null, registerAttemptedAt: null, mintAttemptedAt: null, updatedAt: new Date().toISOString() },
          binding: null,
        },
      },
    };
    expect(managedConnectionRole(state, companyId, { id: manualGoogle.id, companyId, name: manualGoogle.name, config: manualGoogle.config })).toBe("managed");
    expect(managedConnectionRole(state, companyId, { id: manualRh.id, companyId, name: manualRh.name, config: manualRh.config })).toBe("managed");
    const googleSeedRow = await seedRow(companyId, "rh-google-mcp/default-mcp-seed");
    const rhSeedRow = await seedRow(companyId, "rh-mcp-personal/default-mcp-seed");
    expect(managedConnectionRole(state, companyId, { id: googleSeedRow!.id, companyId, name: googleSeedRow!.name, config: googleSeedRow!.config })).toBe("forbidden");
    expect(managedConnectionRole(state, companyId, { id: rhSeedRow!.id, companyId, name: rhSeedRow!.name, config: rhSeedRow!.config })).toBe("forbidden");
    // No legacy or snapshot-managed agent may install or call a seed, whatever rows exist.
    expect(installAppliesToAgent({ targetType: "company", targetId: companyId }, { companyId, state }, { id: googleSeedRow!.id, companyId, name: googleSeedRow!.name, config: googleSeedRow!.config })).toBe(false);
    expect(installAppliesToAgent({ targetType: "agent", targetId: "agent-x" }, { companyId, state }, { id: googleSeedRow!.id, companyId, name: googleSeedRow!.name, config: googleSeedRow!.config })).toBe(false);
    expect(installAppliesToAgent({ targetType: "company", targetId: companyId }, { companyId, state: null }, { id: googleSeedRow!.id, companyId, name: googleSeedRow!.name, config: googleSeedRow!.config })).toBe(false);
    void manualArc;
  });

  it("a new agent born next to seeds records OAuth entries OFF with null connection ids and no installs or grants", async () => {
    seedEnv();
    const companyId = await seedCompany();
    const ownerId = await seedMember(companyId);
    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });

    const agent = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId: ownerId } },
    );
    await waitForScheduledDefaultMcpSetups();

    const state = readDefaultMcpState(
      (await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agent.id)))[0]!.metadata,
    );
    expect(state).not.toBeNull();
    const googleEntry = state!.entries["rh-google-mcp"]!;
    const rhEntry = state!.entries["rh-mcp"]!;
    // The DISPLAY-named seed is never adopted as the entry's template/connection.
    expect(googleEntry).toMatchObject({ enabled: false, templateConnectionId: null, connectionId: null, dedicated: false, templateKey: "rh-google-mcp" });
    expect(googleEntry.setup.state).toBe("not_required");
    expect(rhEntry).toMatchObject({ enabled: false, templateConnectionId: null, connectionId: null, dedicated: false, templateKey: "rh-mcp-personal" });
    expect(rhEntry.setup.state).toBe("not_required");
    // metadata `enabled: false` is not install state: there are no install rows,
    // no grants, no profiles and no secrets for either OAuth entry.
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId));
    expect(installs).toHaveLength(0);
    expect(await rowCounts(companyId)).toMatchObject(zeroSideEffects);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
