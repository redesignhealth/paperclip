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
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import { scheduleDefaultMcpSetup, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import {
  COMMS_BOARD_MAX_IDENTITY_GENERATION,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  composeCommsBoardDisplayName,
  composeCommsBoardIdentity,
} from "../services/comms-board-provisioner-client.js";
import {
  COMMS_IDENTITY_REISSUE_CONFIRMATION,
  CommsIdentityReissueConfirmationError,
  CommsIdentityReissueInvalidInputError,
  reissueCommsBoardIdentity,
} from "../services/comms-identity-reissue.js";
import { rescopeCommsCredentials, COMMS_RESCOPE_CONFIRMATION } from "../services/comms-credential-rescope.js";
import {
  BOARD_ADMIN_TOKEN,
  BOARD_AGENT_ID,
  BOARD_URL,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  boardResponse,
  clearBootProvisionerSnapshot,
  downstreamFetch,
  installBootProvisionerSnapshot,
} from "./helpers/comms-board-downstream.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";
const TEMPLATE_URL = "https://8.8.8.8/mcp";
const AGENT_ID = "0b2c7c1e-4f0a-4a4e-9b3e-0d6f0a3c9a11";

describe("comms-board identity generations", () => {
  it("generation 0 or absent keeps the original recipe", () => {
    const bare = `paperclip-agent-${AGENT_ID}`;
    expect(composeCommsBoardIdentity(AGENT_ID)).toEqual({ baseSub: bare, agentKey: null, boardSub: bare });
    expect(composeCommsBoardIdentity(AGENT_ID, 0)).toEqual({ baseSub: bare, agentKey: null, boardSub: bare });
    expect(composeCommsBoardIdentity(AGENT_ID, null)).toEqual({ baseSub: bare, agentKey: null, boardSub: bare });
    expect(composeCommsBoardIdentity(AGENT_ID.toUpperCase(), undefined)?.baseSub).toBe(bare);
  });

  it("generation N >= 1 is a different base sub with no '::' and no email shape", () => {
    const one = composeCommsBoardIdentity(AGENT_ID, 1)!;
    expect(one).toEqual({ baseSub: `paperclip-agent-${AGENT_ID}-r1`, agentKey: null, boardSub: `paperclip-agent-${AGENT_ID}-r1` });
    expect(composeCommsBoardIdentity(AGENT_ID, 12)!.baseSub).toBe(`paperclip-agent-${AGENT_ID}-r12`);
    expect(one.baseSub).not.toContain("::");
    expect(one.baseSub).not.toContain("@");
    expect(one.baseSub.split("::")[0]).not.toBe(`paperclip-agent-${AGENT_ID}`);
  });

  it("an invalid generation fails closed", () => {
    for (const bad of [-1, 1.5, Number.NaN, COMMS_BOARD_MAX_IDENTITY_GENERATION + 1, "1" as unknown as number]) {
      expect(composeCommsBoardIdentity(AGENT_ID, bad)).toBeNull();
    }
  });

  it("the display name carries the generation suffix only for generation >= 1", () => {
    expect(composeCommsBoardDisplayName("Chief", AGENT_ID)).toBe("Chief (0b2c7c1e)");
    expect(composeCommsBoardDisplayName("Chief", AGENT_ID, 0)).toBe("Chief (0b2c7c1e)");
    expect(composeCommsBoardDisplayName("Chief", AGENT_ID, 2)).toBe("Chief (0b2c7c1e-r2)");
    expect(composeCommsBoardDisplayName(null, AGENT_ID, 1)).toBe("Agent (0b2c7c1e-r1)");
    expect(composeCommsBoardDisplayName("x".repeat(500), AGENT_ID, 1).length).toBeLessThan(230);
  });
});

describeEmbeddedPostgres("comms-board identity reissue for board_conflict entries", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-comms-reissue-${randomUUID()}`);
  const envKeys = [FEATURE_ENV, COMMS_BOARD_MCP_URL_ENV, COMMS_BOARD_ADMIN_TOKEN_ENV, COMMS_BOARD_OWNERSHIP_API_URL_ENV, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("comms-identity-reissue");
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

  async function seedCompany(status: "active" | "archived" = "active", visibility: "private" | "shared" | null = null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status,
      visibility,
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

  /** A hand-built entry as setup leaves it after a board conflict (no registration, no credential). */
  function conflictEntry(extra: Record<string, unknown> = {}, setup: Record<string, unknown> = {}) {
    return {
      key: "comms-board",
      templateKey: "rh-comms-board",
      enabled: false,
      dedicated: true,
      ownerUserId: "frozen-owner",
      connectionId: null,
      templateConnectionId: null,
      setup: {
        state: "error",
        reason: "board_conflict",
        attemptCount: 1,
        nextAttemptAt: null,
        leaseUntil: null,
        claimId: null,
        registerAttemptedAt: "2026-10-16T23:59:25.000Z",
        mintAttemptedAt: null,
        updatedAt: "2026-10-16T23:59:25.000Z",
        ...setup,
      },
      binding: null,
      ...extra,
    };
  }

  async function seedAgent(companyId: string, commsEntry: unknown | null, opts: { status?: string; name?: string } = {}) {
    const metadata = commsEntry ? { defaultMcp: { version: 1, entries: { "comms-board": commsEntry, "arcana-brain": { key: "arcana-brain", setup: { state: "ready", reason: null } } } } } : {};
    const [row] = await db
      .insert(agents)
      .values({ companyId, name: opts.name ?? `agent-${randomUUID().slice(0, 6)}`, role: "general", adapterType: "process", adapterConfig: {}, status: (opts.status ?? "idle") as never, metadata })
      .returning();
    return row!.id;
  }

  const rowOf = async (agentId: string) => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
  const entryOf = async (agentId: string) => readDefaultMcpState((await rowOf(agentId)).metadata)!.entries["comms-board"]!;
  const real = { dryRun: false, confirm: COMMS_IDENTITY_REISSUE_CONFIRMATION };

  it("a census (the default) reports would_reissue with the next generation and writes nothing", async () => {
    const companyId = await seedCompany();
    const a = await seedAgent(companyId, conflictEntry());
    const before = JSON.stringify((await rowOf(a)).metadata);
    const report = await reissueCommsBoardIdentity(db, { companyId, agentIds: [a] });
    expect(report.dryRun).toBe(true);
    expect(report.outcomes).toEqual([{ agentId: a, result: "would_reissue", generation: 1 }]);
    expect(JSON.stringify((await rowOf(a)).metadata)).toBe(before);
  });

  it("a real run needs the exact confirmation string and a valid agent id list", async () => {
    const companyId = await seedCompany();
    const a = await seedAgent(companyId, conflictEntry());
    await expect(reissueCommsBoardIdentity(db, { companyId, agentIds: [a], dryRun: false })).rejects.toBeInstanceOf(CommsIdentityReissueConfirmationError);
    await expect(reissueCommsBoardIdentity(db, { companyId, agentIds: [a], dryRun: false, confirm: "nope" })).rejects.toBeInstanceOf(CommsIdentityReissueConfirmationError);
    await expect(reissueCommsBoardIdentity(db, { companyId, agentIds: [], ...real })).rejects.toBeInstanceOf(CommsIdentityReissueInvalidInputError);
    await expect(reissueCommsBoardIdentity(db, { companyId, agentIds: ["not-a-uuid"], ...real })).rejects.toBeInstanceOf(CommsIdentityReissueInvalidInputError);
    await expect(reissueCommsBoardIdentity(db, { companyId, agentIds: Array.from({ length: 26 }, () => randomUUID()), ...real })).rejects.toBeInstanceOf(CommsIdentityReissueInvalidInputError);
    expect((await entryOf(a)).setup.state).toBe("error");
  });

  it("reissues exactly the listed agents: generation bumped, a fresh pending setup, owner and other entries kept", async () => {
    const companyId = await seedCompany();
    const listed = await seedAgent(companyId, conflictEntry());
    const notListed = await seedAgent(companyId, conflictEntry());
    const now = new Date("2026-10-18T12:00:00.000Z");
    const report = await reissueCommsBoardIdentity(db, { companyId, agentIds: [listed], ...real, now: () => now });
    expect(report.outcomes).toEqual([{ agentId: listed, result: "reissued", generation: 1 }]);
    expect(report.counts.reissued).toBe(1);
    const after = await entryOf(listed);
    expect(after.identityGeneration).toBe(1);
    expect(after.ownerUserId).toBe("frozen-owner");
    expect(after.binding).toBeNull();
    expect(after.setup).toMatchObject({
      state: "pending",
      reason: null,
      attemptCount: 0,
      nextAttemptAt: now.toISOString(),
      leaseUntil: null,
      claimId: null,
      registerAttemptedAt: null,
      mintAttemptedAt: null,
    });
    // Untouched: the other agent, and the listed agent's sibling arcana-brain entry.
    expect((await entryOf(notListed)).setup.state).toBe("error");
    expect((await entryOf(notListed)).identityGeneration).toBeUndefined();
    const state = readDefaultMcpState((await rowOf(listed)).metadata)!;
    expect(state.entries["arcana-brain"]).toEqual({ key: "arcana-brain", setup: { state: "ready", reason: null } });
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, listed));
    expect(events.map((e) => e.action)).toEqual(["agent.default_mcp.comms_identity_reissued"]);
    expect(events[0]!.details).toEqual({ key: "comms-board", fromGeneration: 0, toGeneration: 1 });
  });

  it("a second call is a skip (the entry is no longer in board_conflict) and changes nothing", async () => {
    const companyId = await seedCompany();
    const a = await seedAgent(companyId, conflictEntry());
    await reissueCommsBoardIdentity(db, { companyId, agentIds: [a], ...real });
    const first = JSON.stringify((await rowOf(a)).metadata);
    const again = await reissueCommsBoardIdentity(db, { companyId, agentIds: [a], ...real });
    expect(again.outcomes).toEqual([{ agentId: a, result: "skipped_not_board_conflict" }]);
    expect(JSON.stringify((await rowOf(a)).metadata)).toBe(first);
  });

  it("a later conflict on the new identity bumps to generation 2", async () => {
    const companyId = await seedCompany();
    const a = await seedAgent(companyId, conflictEntry({ identityGeneration: 1 }));
    const report = await reissueCommsBoardIdentity(db, { companyId, agentIds: [a], ...real });
    expect(report.outcomes).toEqual([{ agentId: a, result: "reissued", generation: 2 }]);
    expect((await entryOf(a)).identityGeneration).toBe(2);
  });

  it("never touches ready or pending entries, other error reasons, or an entry that already holds a credential", async () => {
    const companyId = await seedCompany();
    const ready = await seedAgent(companyId, conflictEntry({}, { state: "ready", reason: null }));
    const pending = await seedAgent(companyId, conflictEntry({}, { state: "pending", reason: "owner_required" }));
    const otherError = await seedAgent(companyId, conflictEntry({}, { state: "error", reason: "board_rejected" }));
    const hasBoardId = await seedAgent(companyId, conflictEntry({ binding: { boardAgentId: BOARD_AGENT_ID, baseSub: "x", boardSub: "x", secretId: null } }));
    const hasSecret = await seedAgent(companyId, conflictEntry({ binding: { boardAgentId: null, baseSub: "x", boardSub: "x", secretId: randomUUID() } }));
    const before = JSON.stringify((await db.select().from(agents).orderBy(agents.id)).map((r) => r.metadata));
    const report = await reissueCommsBoardIdentity(db, { companyId, agentIds: [ready, pending, otherError, hasBoardId, hasSecret], ...real });
    const result = (id: string) => report.outcomes.find((o) => o.agentId === id)?.result;
    expect(result(ready)).toBe("skipped_not_board_conflict");
    expect(result(pending)).toBe("skipped_not_board_conflict");
    expect(result(otherError)).toBe("skipped_not_board_conflict");
    expect(result(hasBoardId)).toBe("skipped_has_credential");
    expect(result(hasSecret)).toBe("skipped_has_credential");
    expect(JSON.stringify((await db.select().from(agents).orderBy(agents.id)).map((r) => r.metadata))).toBe(before);
  });

  it("skips terminated agents, archived companies and agents without a comms-board entry; foreign ids look unknown", async () => {
    const companyId = await seedCompany();
    const archivedCompany = await seedCompany("archived");
    const terminated = await seedAgent(companyId, conflictEntry(), { status: "terminated" });
    const noEntry = await seedAgent(companyId, null);
    const inArchived = await seedAgent(archivedCompany, conflictEntry());
    const foreign = await seedAgent(archivedCompany, conflictEntry());
    const unknown = randomUUID();
    const report = await reissueCommsBoardIdentity(db, { companyId, agentIds: [terminated, noEntry, foreign, unknown], ...real });
    const result = (id: string) => report.outcomes.find((o) => o.agentId === id)?.result;
    expect(result(terminated)).toBe("skipped_terminated");
    expect(result(noEntry)).toBe("skipped_no_entry");
    expect(result(foreign)).toBe("agent_not_in_company");
    expect(result(unknown)).toBe("agent_not_in_company");
    const archivedReport = await reissueCommsBoardIdentity(db, { companyId: archivedCompany, agentIds: [inArchived], ...real });
    expect(archivedReport.outcomes).toEqual([{ agentId: inArchived, result: "skipped_company_archived" }]);
    expect((await entryOf(inArchived)).setup.state).toBe("error");
    expect((await entryOf(foreign)).setup.state).toBe("error");
  });

  it("end to end: a board conflict on the bare sub, then reissue, then the sweep registers under the new sub and reaches ready", async () => {
    process.env[FEATURE_ENV] = "true";
    configureDownstream();
    const companyId = await seedCompany("active", "shared");
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);

    // The board already holds the bare sub (a hand registration) but accepts a reissued one.
    const oldRegistrations = new Set<string>();
    const fetchImpl = downstreamFetch({
      register: (sub) => {
        if (/-r\d+$/.test(sub)) return boardResponse(sub, { payload: { agent_id: BOARD_AGENT_ID, sub, display_name: "x", status: "active", is_shared: true } });
        oldRegistrations.add(sub);
        return boardResponse(sub, { isError: true, errorText: "already_registered: sub is already a board agent" });
      },
    });
    vi.stubGlobal("fetch", fetchImpl);
    const created = await agentService(db).create(
      companyId,
      { name: "Chief Agent", role: "general", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId: ownerId } },
    );
    await waitForScheduledDefaultMcpSetups();
    const conflicted = await entryOf(created.id);
    expect(conflicted.setup).toMatchObject({ state: "error", reason: "board_conflict" });
    const bareSub = `paperclip-agent-${created.id}`;
    expect([...oldRegistrations]).toEqual([bareSub]);
    expect(fetchImpl.calls.displayNames).toEqual([`Chief Agent (${created.id.slice(0, 8)})`]);

    const census = await reissueCommsBoardIdentity(db, { companyId, agentIds: [created.id] });
    expect(census.outcomes).toEqual([{ agentId: created.id, result: "would_reissue", generation: 1 }]);
    const report = await reissueCommsBoardIdentity(db, { companyId, agentIds: [created.id], ...real });
    expect(report.outcomes).toEqual([{ agentId: created.id, result: "reissued", generation: 1 }]);

    scheduleDefaultMcpSetup(db, { companyId, agentId: created.id });
    await waitForScheduledDefaultMcpSetups();

    const newSub = `${bareSub}-r1`;
    const ready = await entryOf(created.id);
    expect(ready.setup).toMatchObject({ state: "ready", reason: null });
    expect(ready.identityGeneration).toBe(1);
    expect(ready.ownerUserId).toBe(ownerId);
    expect(ready.binding).toMatchObject({ baseSub: newSub, boardSub: newSub, boardAgentId: BOARD_AGENT_ID });
    // Registered once more under the NEW sub only, with a distinct display name and the company's shared flag.
    expect(fetchImpl.calls.register.map((r) => r.sub)).toEqual([bareSub, newSub]);
    expect(fetchImpl.calls.register[1]!.isShared).toBe(true);
    expect(fetchImpl.calls.displayNames).toEqual([`Chief Agent (${created.id.slice(0, 8)})`, `Chief Agent (${created.id.slice(0, 8)}-r1)`]);
    expect(new Set(fetchImpl.calls.displayNames).size).toBe(2);
    // The credential is minted for the new base sub, never for the old one.
    expect(fetchImpl.calls.mint.map((m) => m.sub)).toEqual([newSub]);

    // Later jobs read the recorded sub from the binding: a rescope rotates the NEW sub.
    const rotated: string[] = [];
    const rotateFetch = vi.fn(async (url: string, init: RequestInit) => {
      const match = /\/agents\/([^/]+)\/rotate$/.exec(url);
      if (!match || init.method !== "POST") throw new Error(`unexpected url ${url}`);
      rotated.push(decodeURIComponent(match[1]!));
      return new Response(JSON.stringify({ sub: decodeURIComponent(match[1]!), owner_email: "owner@redesignhealth.com", active: true, token: "rotated-token-v2-0123456789abcdef", token_expires_at: "2027-09-01T00:00:00+00:00" }), { status: 200 });
    }) as unknown as typeof fetch;
    await db
      .update(agents)
      .set({ metadata: sql`${agents.metadata} #- ARRAY['defaultMcp','entries','comms-board','binding','commsScopeVersion']::text[]` })
      .where(eq(agents.id, created.id));
    const rescope = await rescopeCommsCredentials(db, { companyId, dryRun: false, confirm: COMMS_RESCOPE_CONFIRMATION, fetchImpl: rotateFetch });
    expect(rescope.outcomes.find((o) => o.agentId === created.id)?.result).toBe("rescoped");
    expect(rotated).toEqual([newSub]);
  }, 30_000);
});
