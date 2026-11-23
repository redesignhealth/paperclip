/**
 * TECH-9914: operator tools for comms-board wake registrations of EXISTING agents: enrol (one, all, dry run, idempotent),
 * unsubscribe, secret rotation, status, and board + vault cleanup when an agent is deleted. Text fixtures only.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, commsWakeRegistrations, companies, companyMemberships, companySecretBindings, companySecretVersions, companySecrets, connectionGrants, createDb, principalPermissionGrants, secretAccessEvents, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolApplications, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";
import { secretService } from "../services/secrets.js";
import { logger } from "../middleware/logger.js";
import { DEFAULT_MCP_SPEC, DEFAULT_MCP_SPEC_ENABLED_ENV, readDefaultMcpState } from "../services/default-mcp-spec.js";
import { runDefaultMcpSetupForAgent, sweepDefaultMcpSetups, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { COMMS_BOARD_ADMIN_TOKEN_ENV, COMMS_BOARD_MCP_URL_ENV, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV, COMMS_BOARD_OWNERSHIP_API_URL_ENV, removeCommsBoardWakeTarget } from "../services/comms-board-provisioner-client.js";
import { setCommsWakePublicBaseUrl } from "../services/comms-wake-registration.js";
import {
  COMMS_WAKE_ENROL_CONFIRMATION,
  CommsWakeConfirmationError,
  enrolCommsWakeAgents,
  listCommsWakeStatus,
  rotateCommsWakeSecret,
  unsubscribeCommsWakeAgent,
} from "../services/comms-wake-admin.js";
import { BOARD_ADMIN_TOKEN, BOARD_URL, OWNERSHIP_TOKEN, OWNERSHIP_URL, clientConfig, downstreamFetch } from "./helpers/comms-board-downstream.js";
import { withoutCommsInstallByDefault } from "./helpers/comms-install-by-default.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PUBLIC_BASE = "https://paperclip.example.test";
const URL_LITERAL = "https://8.8.8.8/mcp";
const SET_TOOL = "comms_admin_wake_target_set";
const REMOVE_TOOL = "comms_admin_wake_target_remove";
let clock = Date.now();
const LATER = () => new Date((clock += 3 * 3_600_000));

type Call = { tool: string; args: Record<string, string> };

/** Board + ownership fake that also serves the wake set/remove tools, with a switch to make wake calls fail. */
function boardFetch() {
  const downstream = downstreamFetch();
  const calls: Call[] = [];
  const control = { failWake: null as null | (() => Response | Promise<Response>), failNext: 0 };
  const ok = (id: number, payload: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false } }), { status: 200, headers: { "content-type": "application/json" } });
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    if (url === BOARD_URL && init.method === "POST") {
      const body = JSON.parse(init.body as string);
      if (body.method === "tools/call" && (body.params.name === SET_TOOL || body.params.name === REMOVE_TOOL)) {
        calls.push({ tool: body.params.name, args: body.params.arguments });
        if (control.failNext > 0) {
          control.failNext -= 1;
          return Promise.reject(new Error("network down"));
        }
        if (control.failWake) return control.failWake();
        return body.params.name === SET_TOOL ? ok(body.id, { result: "created" }) : ok(body.id, { agent_id: body.params.arguments.agent_id, removed: true });
      }
    }
    return downstream(url, init);
  });
  return Object.assign(fn, {
    control,
    calls,
    sets: () => calls.filter((call) => call.tool === SET_TOOL),
    removes: () => calls.filter((call) => call.tool === REMOVE_TOOL),
  });
}
const refused = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "access_denied" }], isError: true } }), { status: 200, headers: { "content-type": "application/json" } });

describe("removeCommsBoardWakeTarget", () => {
  it("makes one tools/call with the board agent id and reads removed", async () => {
    const fetchImpl = boardFetch();
    const id = randomUUID();
    expect(await removeCommsBoardWakeTarget(clientConfig, { boardAgentId: id }, fetchImpl)).toEqual({ ok: true, removed: true });
    expect(fetchImpl.removes()).toEqual([{ tool: REMOVE_TOOL, args: { agent_id: id } }]);
  });
  it("maps a refusal and a network failure without echoing anything, and refuses a non-uuid before any call", async () => {
    const fetchImpl = boardFetch();
    fetchImpl.control.failWake = refused;
    expect(await removeCommsBoardWakeTarget(clientConfig, { boardAgentId: randomUUID() }, fetchImpl)).toEqual({ ok: false, reason: "rejected" });
    fetchImpl.control.failWake = null;
    fetchImpl.control.failNext = 1;
    expect(await removeCommsBoardWakeTarget(clientConfig, { boardAgentId: randomUUID() }, fetchImpl)).toEqual({ ok: false, reason: "failed" });
    const untouched = boardFetch();
    expect(await removeCommsBoardWakeTarget(clientConfig, { boardAgentId: "nope" }, untouched)).toEqual({ ok: false, reason: "failed" });
    expect(untouched).not.toHaveBeenCalled();
  });
});

describeEmbeddedPostgres("comms-board wake operator tools for existing agents (TECH-9914)", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmp = path.join(os.tmpdir(), `paperclip-comms-wake-admin-${randomUUID()}`);
  let restoreCommsInstallDefault: (() => void) | null = null;
  const env: NodeJS.ProcessEnv = {
    [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
    [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
    [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
    [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
  };
  const boardEntry = DEFAULT_MCP_SPEC.find((entry) => entry.key === "comms-board")!;

  beforeAll(async () => {
    restoreCommsInstallDefault = withoutCommsInstallByDefault();
    mkdirSync(tmp, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmp, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("comms-wake-admin");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";
    setCommsWakePublicBaseUrl(PUBLIC_BASE);
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    vi.restoreAllMocks();
    delete process.env[DEFAULT_MCP_SPEC_ENABLED_ENV];
    setCommsWakePublicBaseUrl(null);
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(companySecretBindings);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(commsWakeRegistrations);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(principalPermissionGrants);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    restoreCommsInstallDefault?.();
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function seedCompany(commsBoardWakeEnabled: boolean) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Co-${id.slice(0, 8)}`, issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`, commsBoardWakeEnabled });
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: "owner@redesignhealth.com", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const application = await db.insert(toolApplications).values({ companyId: id, applicationKey: `app-${randomUUID()}`, name: `app ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" }).returning().then((r) => r[0]!);
    const shared = await secretService(db).create(id, { name: `shared ${randomUUID()}`, key: `shared.${randomUUID()}`, provider: "local_encrypted", value: "org-shared-credential" });
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId: id, applicationId: application.id, name: "rh-comms-board", uid: `uid-${randomUUID()}`, transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok",
        authKind: "api_key", credentialPolicy: "shared", config: { url: URL_LITERAL }, transportConfig: { url: URL_LITERAL },
        credentialRefs: [{ name: "credentials.authorization", secretId: shared.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }],
      })
      .returning()
      .then((r) => r[0]!);
    const [entry] = await db
      .insert(toolCatalogEntries)
      .values({ companyId: id, applicationId: application.id, connectionId: connection.id, entryKind: "tool", name: "t", toolName: "t", title: "t", riskLevel: "read", isReadOnly: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID() })
      .returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId: id, profileKey: `app:${connection.id}`, name: "rh-comms-board access", defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: connection.id } }).returning();
    await db.insert(toolProfileEntries).values({ companyId: id, profileId: profile!.id, selectorType: "catalog_entry", effect: "include", applicationId: application.id, connectionId: connection.id, catalogEntryId: entry!.id });
    return { companyId: id, ownerId: userId };
  }

  /** An agent that exists before the org turned the setting on: it has a ready board identity and no comms-wake entry. */
  async function existingAgent(companyId: string, ownerUserId: string, opts: { boardReady?: boolean } = {}) {
    const created = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    if (opts.boardReady !== false) await runDefaultMcpSetupForAgent({ db, env, fetchImpl: boardFetch(), now: LATER, spec: [boardEntry] }, { companyId, agentId: created.id });
    return created;
  }

  const rowOf = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then((r) => r[0]!);
  const stateOf = async (id: string) => readDefaultMcpState((await rowOf(id)).metadata)!.entries;
  const registrationOf = (agentId: string) => db.select().from(commsWakeRegistrations).where(eq(commsWakeRegistrations.agentId, agentId)).then((r) => r[0] ?? null);
  const wakeSecrets = (companyId: string) =>
    db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId)).then((rows) => rows.filter((row) => row.key?.startsWith("comms_wake.signing_secret.")));
  const enrol = (db_: typeof db, fetchImpl: ReturnType<typeof boardFetch>, opts: Parameters<typeof enrolCommsWakeAgents>[1]) =>
    enrolCommsWakeAgents(db_, opts, { env, fetchImpl });
  const real = { dryRun: false, confirm: COMMS_WAKE_ENROL_CONFIRMATION };
  const boardIdOf = async (agentId: string) => (await stateOf(agentId))["comms-board"]!.binding!.boardAgentId;

  /** Everything that could leak a secret value. */
  async function expectNoSecretAnywhere(secret: string, agentId: string, reports: unknown[], logSpies: Array<ReturnType<typeof vi.spyOn>>) {
    expect(JSON.stringify((await rowOf(agentId)).metadata)).not.toContain(secret);
    expect(JSON.stringify(await db.select().from(activityLog))).not.toContain(secret);
    expect(JSON.stringify(reports)).not.toContain(secret);
    for (const spy of logSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  }

  describe("enrol", () => {
    it("dry run changes nothing; a real run needs the confirmation; then it stores the secret and registration and tells the board once", async () => {
      const { companyId, ownerId } = await seedCompany(false);
      const agent = await existingAgent(companyId, ownerId);
      await db.update(companies).set({ commsBoardWakeEnabled: true }).where(eq(companies.id, companyId));
      const fetchImpl = boardFetch();

      const dry = await enrol(db, fetchImpl, { companyId, agentId: agent.id });
      expect(dry).toMatchObject({ dryRun: true, scanned: 1, outcomes: [{ agentId: agent.id, result: "would_enrol" }] });
      expect(fetchImpl.calls).toHaveLength(0);
      expect(await wakeSecrets(companyId)).toHaveLength(0);
      expect(await registrationOf(agent.id)).toBeNull();
      expect((await stateOf(agent.id))["comms-wake"]).toBeUndefined();

      await expect(enrol(db, fetchImpl, { companyId, agentId: agent.id, dryRun: false })).rejects.toBeInstanceOf(CommsWakeConfirmationError);
      await expect(enrol(db, fetchImpl, { companyId, agentId: agent.id, dryRun: false, confirm: "yes" })).rejects.toBeInstanceOf(CommsWakeConfirmationError);
      expect(fetchImpl.calls).toHaveLength(0);

      const spies = (["warn", "error", "info", "debug"] as const).map((level) => vi.spyOn(logger, level));
      const report = await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      expect(report.outcomes).toEqual([{ agentId: agent.id, result: "enrolled" }]);
      expect(report.counts.enrolled).toBe(1);
      expect((await stateOf(agent.id))["comms-wake"]!.setup).toMatchObject({ state: "ready", reason: null });
      expect(fetchImpl.sets()).toHaveLength(1);
      const call = fetchImpl.sets()[0]!.args;
      expect(call).toMatchObject({ agent_id: await boardIdOf(agent.id), url: `${PUBLIC_BASE}/api/comms-board/wake/${agent.id}`, system: "paperclip" });
      const registration = await registrationOf(agent.id);
      expect(registration).toMatchObject({ companyId, boardAgentId: call.agent_id });
      expect(await secretService(db).resolveSecretValue(companyId, registration!.signingSecretId, "latest")).toBe(call.secret);
      await expectNoSecretAnywhere(call.secret!, agent.id, [report, dry], spies);
    });

    it("running it twice changes nothing: already_registered, no board call, one secret", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await existingAgent(companyId, ownerId);
      const fetchImpl = boardFetch();
      await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      const before = await registrationOf(agent.id);
      const again = await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      expect(again.outcomes).toEqual([{ agentId: agent.id, result: "already_registered" }]);
      expect(fetchImpl.sets()).toHaveLength(1);
      expect(await wakeSecrets(companyId)).toHaveLength(1);
      expect(await registrationOf(agent.id)).toEqual(before);
    });

    it("a ready comms-wake entry whose registration is gone is rebuilt, not reported as done", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await existingAgent(companyId, ownerId);
      const fetchImpl = boardFetch();
      await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      const gone = (await registrationOf(agent.id))!;
      await db.delete(commsWakeRegistrations).where(eq(commsWakeRegistrations.agentId, agent.id));
      await secretService(db).remove(gone.signingSecretId); // everything of the registration is gone, only the entry remains
      expect((await stateOf(agent.id))["comms-wake"]!.setup.state).toBe("ready");
      const report = await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      expect(report.outcomes).toEqual([{ agentId: agent.id, result: "enrolled" }]);
      expect(fetchImpl.sets()).toHaveLength(2);
      expect(await registrationOf(agent.id)).not.toBeNull();
    });

    it("works on an agent created while the setting was on (it already has a pending entry) and on one with the setting never touched", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const created = await existingAgent(companyId, ownerId); // has a pending comms-wake entry from creation
      expect((await stateOf(created.id))["comms-wake"]!.setup.state).toBe("pending");
      const report = await enrol(db, boardFetch(), { companyId, agentId: created.id, ...real });
      expect(report.outcomes[0]!.result).toBe("enrolled");
    });

    it("all agents of one company, mixed states: enrolled, already registered, board not ready, terminated", async () => {
      const { companyId, ownerId } = await seedCompany(false);
      const fresh = await existingAgent(companyId, ownerId);
      const done = await existingAgent(companyId, ownerId);
      const notReady = await existingAgent(companyId, ownerId, { boardReady: false });
      const gone = await existingAgent(companyId, ownerId);
      await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, gone.id));
      await db.update(companies).set({ commsBoardWakeEnabled: true }).where(eq(companies.id, companyId));
      const fetchImpl = boardFetch();
      await enrol(db, fetchImpl, { companyId, agentId: done.id, ...real });
      fetchImpl.calls.length = 0;

      const dry = await enrol(db, fetchImpl, { companyId });
      const byAgent = Object.fromEntries(dry.outcomes.map((outcome) => [outcome.agentId, outcome.result]));
      expect(byAgent).toEqual({
        [fresh.id]: "would_enrol",
        [done.id]: "already_registered",
        [notReady.id]: "skipped_board_not_ready",
        [gone.id]: "skipped_terminated",
      });
      expect(fetchImpl.calls).toHaveLength(0);

      const run = await enrol(db, fetchImpl, { companyId, ...real });
      expect(run.counts).toMatchObject({ enrolled: 1, already_registered: 1, skipped_board_not_ready: 1, skipped_terminated: 1 });
      expect(fetchImpl.sets()).toHaveLength(1);
      expect(await registrationOf(fresh.id)).not.toBeNull();
      expect(await registrationOf(notReady.id)).toBeNull();
      expect(await registrationOf(gone.id)).toBeNull();
      expect(run.nextCursor).toBeNull();
    });

    it("pages through a company with limit and nextCursor", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      for (let i = 0; i < 3; i += 1) await existingAgent(companyId, ownerId);
      const first = await enrol(db, boardFetch(), { companyId, limit: 2 });
      expect(first.scanned).toBe(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await enrol(db, boardFetch(), { companyId, limit: 2, afterId: first.nextCursor! });
      expect(second.scanned).toBe(1);
      expect(second.nextCursor).toBeNull();
    });

    it("setting off: nothing is stored or called, whatever the run mode", async () => {
      const { companyId, ownerId } = await seedCompany(false);
      const agent = await existingAgent(companyId, ownerId);
      const fetchImpl = boardFetch();
      const report = await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      expect(report.outcomes).toEqual([{ agentId: agent.id, result: "skipped_setting_off" }]);
      expect(fetchImpl.calls).toHaveLength(0);
      expect(await wakeSecrets(companyId)).toHaveLength(0);
      expect((await stateOf(agent.id))["comms-wake"]).toBeUndefined();
    });

    it("a board failure leaves it pending with the reason; running it again completes it with the same secret", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await existingAgent(companyId, ownerId);
      const fetchImpl = boardFetch();
      fetchImpl.control.failWake = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "misconfigured: allowlist" }], isError: true } }), { status: 200, headers: { "content-type": "application/json" } });
      const first = await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      expect(first.outcomes).toEqual([{ agentId: agent.id, result: "pending", reason: "board_failed" }]);
      expect(await registrationOf(agent.id)).not.toBeNull(); // stored before the board call
      const firstSecret = fetchImpl.sets()[0]!.args.secret;

      fetchImpl.control.failWake = null;
      const second = await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      expect(second.outcomes).toEqual([{ agentId: agent.id, result: "enrolled" }]);
      expect(fetchImpl.sets()[1]!.args.secret).toBe(firstSecret);
      expect(await wakeSecrets(companyId)).toHaveLength(1);
    });

    it("tenant isolation: another company's agent id is not found, and nothing of it is touched", async () => {
      const a = await seedCompany(true);
      const b = await seedCompany(true);
      const agentB = await existingAgent(b.companyId, b.ownerId);
      const fetchImpl = boardFetch();
      await expect(enrol(db, fetchImpl, { companyId: a.companyId, agentId: agentB.id, ...real })).rejects.toMatchObject({ status: 404 });
      await expect(enrol(db, fetchImpl, { companyId: a.companyId, agentId: randomUUID(), ...real })).rejects.toMatchObject({ status: 404 });
      const all = await enrol(db, fetchImpl, { companyId: a.companyId, ...real });
      expect(all.scanned).toBe(0);
      expect(fetchImpl.calls).toHaveLength(0);
      expect(await registrationOf(agentB.id)).toBeNull();
      expect((await stateOf(agentB.id))["comms-wake"]!.setup.state).toBe("pending"); // as created, untouched
    });
  });

  describe("unsubscribe", () => {
    async function registered() {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await existingAgent(companyId, ownerId);
      const fetchImpl = boardFetch();
      await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      const registration = (await registrationOf(agent.id))!;
      return { companyId, ownerId, agent, registration, fetchImpl };
    }
    const unsub = (fetchImpl: ReturnType<typeof boardFetch>, companyId: string, agentId: string) =>
      unsubscribeCommsWakeAgent(db, { companyId, agentId, actorUserId: null }, { env, fetchImpl });

    it("removes the board address, the registration row and the signing secret, and the sweep never registers it again", async () => {
      const { companyId, agent, registration, fetchImpl } = await registered();
      const report = await unsub(fetchImpl, companyId, agent.id);
      expect(report).toEqual({ agentId: agent.id, result: "unsubscribed", board: "removed", registration: "removed", secret: "removed" });
      expect(fetchImpl.removes()).toEqual([{ tool: REMOVE_TOOL, args: { agent_id: registration.boardAgentId } }]);
      expect(await registrationOf(agent.id)).toBeNull();
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, registration.signingSecretId))).toHaveLength(0);
      expect(await wakeSecrets(companyId)).toHaveLength(0);
      expect((await stateOf(agent.id))["comms-wake"]!.setup).toMatchObject({ state: "not_required", reason: "operator_excluded" });
      await sweepDefaultMcpSetups({ db, env, fetchImpl, now: LATER });
      expect(fetchImpl.sets()).toHaveLength(1);
      expect(await registrationOf(agent.id)).toBeNull();
    });

    it("a second unsubscribe is a no-op (no board call), and enrolling again afterwards works with a new secret", async () => {
      const { companyId, agent, registration, fetchImpl } = await registered();
      await unsub(fetchImpl, companyId, agent.id);
      const again = await unsub(fetchImpl, companyId, agent.id);
      expect(again).toMatchObject({ result: "not_registered", board: "not_called", registration: "none", secret: "none" });
      expect(fetchImpl.removes()).toHaveLength(1);
      const re = await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      expect(re.outcomes[0]!.result).toBe("enrolled");
      expect((await registrationOf(agent.id))!.signingSecretId).not.toBe(registration.signingSecretId);
    });

    it("a board that cannot remove the address stops everything: registration and secret stay, and a repeat succeeds", async () => {
      const { companyId, agent, registration, fetchImpl } = await registered();
      fetchImpl.control.failNext = 1;
      const failed = await unsub(fetchImpl, companyId, agent.id);
      expect(failed).toMatchObject({ result: "board_remove_failed", board: "failed", registration: "kept" });
      expect(await registrationOf(agent.id)).not.toBeNull();
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, registration.signingSecretId))).toHaveLength(1);
      expect((await stateOf(agent.id))["comms-wake"]!.setup.state).toBe("ready");
      const repeat = await unsub(fetchImpl, companyId, agent.id);
      expect(repeat.result).toBe("unsubscribed");
      expect(await registrationOf(agent.id)).toBeNull();
    });

    it("removes a signing secret left behind by a registration that crashed before it was recorded", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await existingAgent(companyId, ownerId);
      await secretService(db).create(companyId, { name: "orphan", key: `comms_wake.signing_secret.${agent.id}`, provider: "local_encrypted", value: "whsec_AAAA" });
      const report = await unsub(boardFetch(), companyId, agent.id);
      expect(report).toMatchObject({ result: "not_registered", secret: "removed" });
      expect(await wakeSecrets(companyId)).toHaveLength(0);
    });

    it("tenant isolation: another company cannot unsubscribe the agent", async () => {
      const { agent, registration, fetchImpl } = await registered();
      const other = await seedCompany(true);
      await expect(unsub(fetchImpl, other.companyId, agent.id)).rejects.toMatchObject({ status: 404 });
      expect(fetchImpl.removes()).toHaveLength(0);
      expect(await registrationOf(agent.id)).toMatchObject({ id: registration.id });
    });
  });

  describe("agent deletion", () => {
    const terminate = (agentId: string) => db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, agentId));

    it("removes the board address and the vault secret along with the registration", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await existingAgent(companyId, ownerId);
      await enrol(db, boardFetch(), { companyId, agentId: agent.id, ...real });
      const registration = (await registrationOf(agent.id))!;
      await terminate(agent.id);
      const fetchImpl = boardFetch();
      await agentService(db, {}, { env, fetchImpl }).remove(agent.id);
      expect(await db.select().from(agents).where(eq(agents.id, agent.id))).toHaveLength(0);
      expect(await registrationOf(agent.id)).toBeNull();
      expect(fetchImpl.removes()).toEqual([{ tool: REMOVE_TOOL, args: { agent_id: registration.boardAgentId } }]);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, registration.signingSecretId))).toHaveLength(0);
    });

    it("an unreachable board does not block the deletion: the secret is still removed and the failure is recorded, not silent", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await existingAgent(companyId, ownerId);
      await enrol(db, boardFetch(), { companyId, agentId: agent.id, ...real });
      const registration = (await registrationOf(agent.id))!;
      await terminate(agent.id);
      const fetchImpl = boardFetch();
      fetchImpl.control.failNext = 1;
      const warn = vi.spyOn(logger, "warn");
      await expect(agentService(db, {}, { env, fetchImpl }).remove(agent.id)).resolves.toBeTruthy();
      expect(await db.select().from(agents).where(eq(agents.id, agent.id))).toHaveLength(0);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, registration.signingSecretId))).toHaveLength(0);
      const [record] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "agent.comms_wake.board_cleanup_failed")));
      expect(record).toMatchObject({ entityId: agent.id, details: { boardAgentId: registration.boardAgentId, reason: "failed" } });
      expect(JSON.stringify(warn.mock.calls)).toContain(registration.boardAgentId);
    });

    it("an agent without a registration is deleted with no board call; a refused purge (not terminated) touches nothing", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const plain = await existingAgent(companyId, ownerId);
      await terminate(plain.id);
      const fetchImpl = boardFetch();
      await agentService(db, {}, { env, fetchImpl }).remove(plain.id);
      expect(fetchImpl.calls).toHaveLength(0);

      const live = await existingAgent(companyId, ownerId);
      await enrol(db, boardFetch(), { companyId, agentId: live.id, ...real });
      await expect(agentService(db, {}, { env, fetchImpl }).remove(live.id)).rejects.toBeTruthy();
      expect(fetchImpl.calls).toHaveLength(0);
      expect(await registrationOf(live.id)).not.toBeNull();
      expect(await wakeSecrets(companyId)).toHaveLength(1);
    });

    it("deleting a company takes its agents' addresses off the board", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await existingAgent(companyId, ownerId);
      await enrol(db, boardFetch(), { companyId, agentId: agent.id, ...real });
      const registration = (await registrationOf(agent.id))!;
      await terminate(agent.id);
      const fetchImpl = boardFetch();
      await companyService(db, {}, { env, fetchImpl }).remove(companyId);
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
      expect(fetchImpl.removes()).toEqual([{ tool: REMOVE_TOOL, args: { agent_id: registration.boardAgentId } }]);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(0);
    });
  });

  describe("rotate", () => {
    async function registered() {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await existingAgent(companyId, ownerId);
      const fetchImpl = boardFetch();
      await enrol(db, fetchImpl, { companyId, agentId: agent.id, ...real });
      const registration = (await registrationOf(agent.id))!;
      return { companyId, agent, registration, fetchImpl, oldSecret: fetchImpl.sets()[0]!.args.secret! };
    }
    const rotate = (fetchImpl: ReturnType<typeof boardFetch>, companyId: string, agentId: string) =>
      rotateCommsWakeSecret(db, { companyId, agentId, actorUserId: null }, { env, fetchImpl });
    const vaultValue = (companyId: string, secretId: string) => secretService(db).resolveSecretValue(companyId, secretId, "latest");

    it("writes a new vault version and sends the same value to the board in one step", async () => {
      const { companyId, agent, registration, fetchImpl, oldSecret } = await registered();
      const spies = (["warn", "error", "info", "debug"] as const).map((level) => vi.spyOn(logger, level));
      const report = await rotate(fetchImpl, companyId, agent.id);
      expect(report).toEqual({ agentId: agent.id, result: "rotated", board: "new_secret", secretVersion: 2 });
      expect(fetchImpl.sets()).toHaveLength(2);
      const sent = fetchImpl.sets()[1]!.args;
      expect(sent).toMatchObject({ agent_id: registration.boardAgentId, url: `${PUBLIC_BASE}/api/comms-board/wake/${agent.id}`, system: "paperclip" });
      expect(sent.secret).not.toBe(oldSecret);
      expect(await vaultValue(companyId, registration.signingSecretId)).toBe(sent.secret);
      expect(await wakeSecrets(companyId)).toHaveLength(1);
      await expectNoSecretAnywhere(sent.secret!, agent.id, [report], spies);
      await expectNoSecretAnywhere(oldSecret, agent.id, [report], spies);
    });

    it("a board that refuses leaves the old secret in force and the vault untouched", async () => {
      const { companyId, agent, registration, fetchImpl, oldSecret } = await registered();
      fetchImpl.control.failWake = refused;
      const report = await rotate(fetchImpl, companyId, agent.id);
      expect(report).toMatchObject({ result: "board_failed", board: "old_secret", boardReason: "rejected", secretVersion: 1 });
      expect(await vaultValue(companyId, registration.signingSecretId)).toBe(oldSecret);
    });

    it("an unreachable board: the vault is untouched and the old secret is sent back; if that fails too the report says unknown", async () => {
      const { companyId, agent, registration, fetchImpl, oldSecret } = await registered();
      fetchImpl.control.failNext = 1; // the new-secret call fails, the restore call succeeds
      const restored = await rotate(fetchImpl, companyId, agent.id);
      expect(restored).toMatchObject({ result: "board_failed", board: "old_secret", boardReason: "failed" });
      expect(fetchImpl.sets().at(-1)!.args.secret).toBe(oldSecret);
      expect(await vaultValue(companyId, registration.signingSecretId)).toBe(oldSecret);

      fetchImpl.control.failNext = 2;
      const unknown = await rotate(fetchImpl, companyId, agent.id);
      expect(unknown).toMatchObject({ result: "board_failed", board: "unknown" });
      expect(await vaultValue(companyId, registration.signingSecretId)).toBe(oldSecret);
    });

    it("an agent that is not registered, and another company's agent, are refused without any call", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      const plain = await existingAgent(companyId, ownerId);
      const fetchImpl = boardFetch();
      expect(await rotate(fetchImpl, companyId, plain.id)).toMatchObject({ result: "not_registered", board: "not_called" });
      const reg = await registered();
      await expect(rotate(reg.fetchImpl, companyId, reg.agent.id)).rejects.toMatchObject({ status: 404 });
      expect(fetchImpl.calls).toHaveLength(0);
      expect(reg.fetchImpl.sets()).toHaveLength(1);
    });
  });

  describe("status", () => {
    it("lists registered, pending (with the reason), not enrolled and not eligible agents of the company only", async () => {
      const { companyId, ownerId } = await seedCompany(false);
      const done = await existingAgent(companyId, ownerId);
      const waiting = await existingAgent(companyId, ownerId);
      const fresh = await existingAgent(companyId, ownerId);
      const notReady = await existingAgent(companyId, ownerId, { boardReady: false });
      const gone = await existingAgent(companyId, ownerId);
      await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, gone.id));
      await db.update(companies).set({ commsBoardWakeEnabled: true }).where(eq(companies.id, companyId));
      const fetchImpl = boardFetch();
      await enrol(db, fetchImpl, { companyId, agentId: done.id, ...real });
      fetchImpl.control.failWake = refused;
      await enrol(db, fetchImpl, { companyId, agentId: waiting.id, ...real });
      const other = await seedCompany(true);
      const foreign = await existingAgent(other.companyId, other.ownerId);

      const report = await listCommsWakeStatus(db, { companyId });
      expect(report).toMatchObject({ companyId, settingEnabled: true, scanned: 5, counts: { registered: 1, pending: 1, not_enrolled: 2, not_eligible: 1 }, nextCursor: null });
      const byAgent = Object.fromEntries(report.agents.map((entry) => [entry.agentId, entry]));
      expect(byAgent[done.id]).toMatchObject({ status: "registered", boardAgentId: await boardIdOf(done.id) });
      expect(byAgent[waiting.id]).toMatchObject({ status: "pending", reason: "board_rejected" });
      expect(byAgent[fresh.id]).toEqual({ agentId: fresh.id, name: expect.any(String), status: "not_enrolled" });
      expect(byAgent[notReady.id]).toMatchObject({ status: "not_enrolled", reason: "board_not_ready" });
      expect(byAgent[gone.id]).toMatchObject({ status: "not_eligible", reason: "terminated" });
      expect(byAgent[foreign.id]).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain("whsec_");
    });

    it("pages with limit and nextCursor and refuses an unknown company", async () => {
      const { companyId, ownerId } = await seedCompany(true);
      for (let i = 0; i < 3; i += 1) await existingAgent(companyId, ownerId);
      const first = await listCommsWakeStatus(db, { companyId, limit: 2 });
      expect(first.agents).toHaveLength(2);
      const second = await listCommsWakeStatus(db, { companyId, limit: 2, afterId: first.nextCursor! });
      expect(second.agents).toHaveLength(1);
      await expect(listCommsWakeStatus(db, { companyId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    });
  });
});
