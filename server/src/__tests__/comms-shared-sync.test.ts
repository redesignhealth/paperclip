import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
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
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { setCommsBoardAgentShared } from "../services/comms-board-provisioner-client.js";
import { COMMS_SHARED_SYNC_CONFIRMATION, CommsSharedSyncConfirmationError, syncCommsShared } from "../services/comms-shared-sync.js";
import {
  BOARD_ADMIN_TOKEN,
  BOARD_TOKEN,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  clientConfig,
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

describeEmbeddedPostgres("comms-board shared sync for existing agents", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-comms-shared-sync-${randomUUID()}`);
  const envKeys = [FEATURE_ENV, COMMS_BOARD_MCP_URL_ENV, COMMS_BOARD_ADMIN_TOKEN_ENV, COMMS_BOARD_OWNERSHIP_API_URL_ENV, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("comms-shared-sync");
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

  async function seedCompany(visibility: "private" | "shared" | null = null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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

  const setVisibility = (companyId: string, visibility: "private" | "shared" | null) =>
    db.update(companies).set({ visibility }).where(eq(companies.id, companyId));
  const markerOf = async (agentId: string) => (await entryOf(agentId)).binding!.commsSharedSynced;
  /** Agents registered before the marker existed. */
  const dropMarker = (agentId: string) =>
    db.update(agents).set({ metadata: sql`${agents.metadata} #- ARRAY['defaultMcp','entries','comms-board','binding','commsSharedSynced']::text[]` }).where(eq(agents.id, agentId));

  type Step = "ok" | "access_denied" | "agent_not_found" | "invalid_request" | 401 | 500 | "network";
  /** Stand-in for the board MCP endpoint's comms_set_agent_shared tool; records the calls it saw. */
  function boardFetch(script: (args: { agent_id: string; is_shared: boolean }) => Step = () => "ok") {
    const calls: Array<{ agent_id: string; is_shared: boolean; auth: string | undefined }> = [];
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    const impl = vi.fn(async (url: string, init: RequestInit) => {
      if (url !== BOARD_URL) throw new Error(`unexpected url ${url}`);
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") {
        return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "board", version: "1" } } }, 200, { "mcp-session-id": "s" });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method !== "tools/call" || body.params.name !== "comms_set_agent_shared") throw new Error(`unexpected call ${body.method}`);
      const args = body.params.arguments as { agent_id: string; is_shared: boolean };
      calls.push({ ...args, auth: (init.headers as Record<string, string>)?.authorization });
      const step = script(args);
      if (step === "network") throw new TypeError("fetch failed");
      if (step === 401 || step === 500) return new Response("{}", { status: step });
      if (step === "ok") return json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ agent_id: args.agent_id, is_shared: args.is_shared }) }], isError: false } });
      return json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: step }], isError: true } });
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  const real = (companyId: string, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    syncCommsShared(db, { companyId, dryRun: false, confirm: COMMS_SHARED_SYNC_CONFIRMATION, fetchImpl, ...extra });
  const outcomeOf = (report: Awaited<ReturnType<typeof real>>, agentId: string) => report.outcomes.find((o) => o.agentId === agentId);

  async function company(visibility: "private" | "shared" | null = null) {
    const companyId = await seedCompany(visibility);
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    return { companyId, ownerId };
  }

  it("a freshly registered agent matches registration already; its first sync is one no-op call that records the marker", async () => {
    const shared = await company("shared");
    const agent = await readyAgent(shared.companyId, shared.ownerId);
    expect(await markerOf(agent.id)).toBeUndefined();
    configureDownstream();
    const board = boardFetch();
    const first = await real(shared.companyId, board.impl);
    expect(outcomeOf(first, agent.id)).toMatchObject({ result: "synced", target: true });
    expect(board.calls).toHaveLength(1);
    const second = await real(shared.companyId, board.impl);
    expect(outcomeOf(second, agent.id)).toMatchObject({ result: "already_current", target: true });
    expect(board.calls).toHaveLength(1);
  });

  it("syncs an agent whose company was classified after it registered, then is idempotent", async () => {
    const { companyId, ownerId } = await company(null);
    const agent = await readyAgent(companyId, ownerId);
    await setVisibility(companyId, "shared");
    configureDownstream();
    const board = boardFetch();

    const census = await syncCommsShared(db, { companyId, fetchImpl: board.impl });
    expect(census.dryRun).toBe(true);
    expect(outcomeOf(census, agent.id)).toMatchObject({ result: "would_sync", target: true });
    expect(board.calls).toHaveLength(0);
    expect(await markerOf(agent.id)).toBeUndefined();

    const boardAgentId = (await entryOf(agent.id)).binding!.boardAgentId!;
    const first = await real(companyId, board.impl);
    expect(outcomeOf(first, agent.id)).toMatchObject({ result: "synced", target: true });
    expect(first.counts.synced).toBe(1);
    expect(board.calls).toEqual([{ agent_id: boardAgentId, is_shared: true, auth: `Bearer ${BOARD_ADMIN_TOKEN}` }]);
    expect(await markerOf(agent.id)).toBe(true);

    const second = await real(companyId, board.impl);
    expect(outcomeOf(second, agent.id)).toMatchObject({ result: "already_current" });
    expect(board.calls).toHaveLength(1);
    const events = (await db.select().from(activityLog)).filter((row) => row.action === "agent.default_mcp.comms_shared_synced");
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toMatchObject({ key: "comms-board", isShared: true });
  });

  it("narrows a shared agent to private when the company is private", async () => {
    const { companyId, ownerId } = await company("shared");
    const agent = await readyAgent(companyId, ownerId);
    await setVisibility(companyId, "private");
    configureDownstream();
    const board = boardFetch();
    const report = await real(companyId, board.impl);
    expect(outcomeOf(report, agent.id)).toMatchObject({ result: "synced", target: false });
    expect(board.calls.map((c) => c.is_shared)).toEqual([false]);
    expect(await markerOf(agent.id)).toBe(false);
  });

  it("targets private and flags an unclassified company (legacy agent without a marker)", async () => {
    const { companyId, ownerId } = await company(null);
    const agent = await readyAgent(companyId, ownerId);
    await dropMarker(agent.id);
    configureDownstream();
    const board = boardFetch();
    const census = await syncCommsShared(db, { companyId, fetchImpl: board.impl });
    expect(outcomeOf(census, agent.id)).toMatchObject({ result: "would_sync", target: false, visibilityUnset: true });
    const report = await real(companyId, board.impl);
    expect(outcomeOf(report, agent.id)).toMatchObject({ result: "synced", target: false, visibilityUnset: true });
    expect(board.calls.map((c) => c.is_shared)).toEqual([false]);
  });

  it("requires the exact confirmation for a real run", async () => {
    const { companyId } = await company("shared");
    await expect(syncCommsShared(db, { companyId, dryRun: false })).rejects.toBeInstanceOf(CommsSharedSyncConfirmationError);
    await expect(syncCommsShared(db, { companyId, dryRun: false, confirm: "yes" })).rejects.toBeInstanceOf(CommsSharedSyncConfirmationError);
  });

  it("classifies board failures per agent without advancing the marker, and a re-run retries", async () => {
    const { companyId, ownerId } = await company(null);
    const rejected = await readyAgent(companyId, ownerId);
    const missing = await readyAgent(companyId, ownerId);
    const broken = await readyAgent(companyId, ownerId);
    const flaky = await readyAgent(companyId, ownerId);
    await setVisibility(companyId, "shared");
    configureDownstream();
    // The shared registration fixture returns one board id for everyone; give each agent its own.
    for (const agent of [rejected, missing, broken, flaky]) {
      await db
        .update(agents)
        .set({ metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries','comms-board','binding','boardAgentId']::text[], ${JSON.stringify(randomUUID())}::jsonb)` })
        .where(eq(agents.id, agent.id));
    }
    const idOf = async (agentId: string) => (await entryOf(agentId)).binding!.boardAgentId!;
    const byBoardId = new Map([[await idOf(rejected.id), "access_denied"], [await idOf(missing.id), "agent_not_found"], [await idOf(broken.id), 500], [await idOf(flaky.id), "network"]] as const);
    const board = boardFetch((args) => (byBoardId.get(args.agent_id) ?? "ok") as Step);
    const report = await real(companyId, board.impl);
    expect(outcomeOf(report, rejected.id)!.result).toBe("set_shared_rejected");
    expect(outcomeOf(report, missing.id)!.result).toBe("set_shared_unknown_agent");
    expect(outcomeOf(report, broken.id)!.result).toBe("set_shared_failed");
    expect(outcomeOf(report, flaky.id)!.result).toBe("set_shared_failed");
    for (const agent of [rejected, missing, broken, flaky]) expect(await markerOf(agent.id)).toBeUndefined();

    const healthy = boardFetch();
    const retry = await real(companyId, healthy.impl);
    expect(retry.counts.synced).toBe(4);
    for (const agent of [rejected, missing, broken, flaky]) expect(await markerOf(agent.id)).toBe(true);
  });

  it("skips terminated agents, archived companies and agents without a ready dedicated entry; makes no call for them", async () => {
    const { companyId, ownerId } = await company(null);
    const terminated = await readyAgent(companyId, ownerId);
    const notReady = await readyAgent(companyId, ownerId);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, terminated.id));
    await db.update(agents).set({ metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries','comms-board','setup','state']::text[], '"pending"'::jsonb)` }).where(eq(agents.id, notReady.id));
    await setVisibility(companyId, "shared");
    configureDownstream();
    const board = boardFetch();
    const report = await real(companyId, board.impl);
    expect(outcomeOf(report, terminated.id)!.result).toBe("skipped_terminated");
    expect(outcomeOf(report, notReady.id)!.result).toBe("skipped_not_ready");
    expect(board.calls).toHaveLength(0);

    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    const archived = await real(companyId, board.impl);
    expect(archived.outcomes.every((o) => o.result === "skipped_company_archived" || o.result === "skipped_terminated")).toBe(true);
    expect(board.calls).toHaveLength(0);
  });

  it("fails closed with no provisioner configuration: no board call, marker untouched", async () => {
    const { companyId, ownerId } = await company(null);
    const agent = await readyAgent(companyId, ownerId);
    await setVisibility(companyId, "shared");
    clearBootProvisionerSnapshot();
    const board = boardFetch();
    const report = await real(companyId, board.impl);
    expect(outcomeOf(report, agent.id)!.result).toBe("provisioner_not_configured");
    expect(board.calls).toHaveLength(0);
    expect(await markerOf(agent.id)).toBeUndefined();
  });

  it("only touches the named company's agents and pages with a cursor", async () => {
    const a = await company(null);
    const b = await company(null);
    const agentsA = [await readyAgent(a.companyId, a.ownerId), await readyAgent(a.companyId, a.ownerId), await readyAgent(a.companyId, a.ownerId)];
    const agentB = await readyAgent(b.companyId, b.ownerId);
    await setVisibility(a.companyId, "shared");
    await setVisibility(b.companyId, "shared");
    configureDownstream();
    const board = boardFetch();
    const page1 = await real(a.companyId, board.impl, { limit: 2 });
    expect(page1.scanned).toBe(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await real(a.companyId, board.impl, { limit: 2, afterId: page1.nextCursor! });
    expect(page2.scanned).toBe(1);
    expect(board.calls).toHaveLength(3);
    for (const agent of agentsA) expect(await markerOf(agent.id)).toBe(true);
    expect(await markerOf(agentB.id)).toBeUndefined();
  });

  it("setCommsBoardAgentShared sends exactly agent_id and is_shared, and refuses a malformed id locally", async () => {
    const board = boardFetch();
    const id = "0b2c7c1e-4f0a-4a4e-9b3e-0d6f0a3c9a11";
    expect(await setCommsBoardAgentShared(clientConfig, { boardAgentId: id, isShared: true }, board.impl)).toEqual({ ok: true });
    expect(board.calls).toEqual([{ agent_id: id, is_shared: true, auth: `Bearer ${BOARD_ADMIN_TOKEN}` }]);
    expect(await setCommsBoardAgentShared(clientConfig, { boardAgentId: "not-a-uuid", isShared: true }, board.impl)).toEqual({ ok: false, reason: "failed" });
    expect(board.calls).toHaveLength(1);
    const denied = boardFetch(() => 401);
    expect(await setCommsBoardAgentShared(clientConfig, { boardAgentId: id, isShared: false }, denied.impl)).toEqual({ ok: false, reason: "rejected" });
  });
});
