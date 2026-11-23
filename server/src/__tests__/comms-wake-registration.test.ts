/**
 * TECH-9912: per-org wake subscription of NEW agents. Registration is stored first (vault secret + registration row),
 * then the board is told where to deliver; failures stay pending and the default-MCP sweep retries them.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, commsWakeRegistrations, companies, companyMemberships, companySecretBindings, companySecretVersions, companySecrets, connectionGrants, createDb, principalPermissionGrants, secretAccessEvents, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolApplications, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";
import { secretService } from "../services/secrets.js";
import { logger } from "../middleware/logger.js";
import { DEFAULT_MCP_SPEC, DEFAULT_MCP_SPEC_ENABLED_ENV, readDefaultMcpState } from "../services/default-mcp-spec.js";
import { runDefaultMcpSetupForAgent, sweepDefaultMcpSetups, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  setCommsBoardWakeTarget,
} from "../services/comms-board-provisioner-client.js";
import { buildCommsWakeUrl, generateCommsWakeSecret, setCommsWakePublicBaseUrl } from "../services/comms-wake-registration.js";
import { parseCommsWakeSecret } from "../services/comms-wake-signature.js";
import { BOARD_ADMIN_TOKEN, BOARD_AGENT_ID, BOARD_URL, OWNERSHIP_TOKEN, OWNERSHIP_URL, clientConfig, downstreamFetch } from "./helpers/comms-board-downstream.js";
import { withoutCommsInstallByDefault } from "./helpers/comms-install-by-default.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PUBLIC_BASE = "https://paperclip.example.test";
// Every setup run happens three hours after the previous one, so a backoff never hides a retry.
let clock = Date.now();
const LATER = () => new Date((clock += 3 * 3_600_000));
const URL_LITERAL = "https://8.8.8.8/mcp";
const WAKE_TOOL = "comms_admin_wake_target_set";

type WakeCall = { agent_id: string; url: string; secret: string; system: string };

/** Board + ownership fake that also serves `comms_admin_wake_target_set`; everything else goes to the shared fixture. */
function boardFetch(wake: { respond?: () => Response | Promise<Response> } = {}) {
  const downstream = downstreamFetch();
  const wakeCalls: WakeCall[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    if (url === BOARD_URL && init.method === "POST") {
      const body = JSON.parse(init.body as string);
      if (body.method === "tools/call" && body.params.name === WAKE_TOOL) {
        wakeCalls.push(body.params.arguments as WakeCall);
        if (wake.respond) return wake.respond();
        const payload = { agent_id: body.params.arguments.agent_id, system: "paperclip", host: "paperclip.example.test", result: "created" };
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }
    return downstream(url, init);
  });
  return Object.assign(fn, { wakeCalls, downstream });
}

const toolError = (text: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError: true } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("wake URL and secret", () => {
  it("builds the URL from the public origin and refuses anything that is not https", () => {
    expect(buildCommsWakeUrl("a-1", "https://paperclip.example.test")).toBe("https://paperclip.example.test/api/comms-board/wake/a-1");
    expect(buildCommsWakeUrl("a-1", "https://paperclip.example.test/")).toBe("https://paperclip.example.test/api/comms-board/wake/a-1");
    expect(buildCommsWakeUrl("a-1", "http://paperclip.example.test")).toBeNull();
    expect(buildCommsWakeUrl("a-1", "https://user:pw@paperclip.example.test")).toBeNull();
    expect(buildCommsWakeUrl("a-1", "not a url")).toBeNull();
    expect(buildCommsWakeUrl("a-1", null)).toBeNull();
  });

  it("generates whsec_ + base64 of 32 random bytes that the wake route can parse", () => {
    const first = generateCommsWakeSecret();
    expect(first).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(first.slice(6), "base64")).toHaveLength(32);
    expect(parseCommsWakeSecret(first)).toHaveLength(32);
    expect(generateCommsWakeSecret()).not.toBe(first);
  });
});

describe("setCommsBoardWakeTarget", () => {
  const request = { boardAgentId: BOARD_AGENT_ID, url: `${PUBLIC_BASE}/api/comms-board/wake/x`, secret: generateCommsWakeSecret(), system: "paperclip" };

  it("makes one handshake and exactly one tools/call with the four arguments", async () => {
    const fetchImpl = boardFetch();
    const outcome = await setCommsBoardWakeTarget(clientConfig, request, fetchImpl);
    expect(outcome).toEqual({ ok: true, result: "created" });
    expect(fetchImpl.wakeCalls).toEqual([{ agent_id: BOARD_AGENT_ID, url: request.url, secret: request.secret, system: "paperclip" }]);
  });

  it.each([
    ["access_denied", "rejected"],
    ["invalid_request: host not allowed", "invalid_request"],
    ["misconfigured: no allowlist", "misconfigured"],
    ["something_else", "failed"],
  ])("maps the board error %s to %s without echoing it", async (text, reason) => {
    const outcome = await setCommsBoardWakeTarget(clientConfig, request, boardFetch({ respond: () => toolError(text) }));
    expect(outcome).toEqual({ ok: false, reason });
    expect(JSON.stringify(outcome)).not.toContain(request.secret);
  });

  it("maps a network failure and a 401 to failed and rejected", async () => {
    expect(await setCommsBoardWakeTarget(clientConfig, request, boardFetch({ respond: () => Promise.reject(new Error("boom")) }))).toEqual({ ok: false, reason: "failed" });
    expect(await setCommsBoardWakeTarget(clientConfig, request, boardFetch({ respond: () => new Response("no", { status: 401 }) }))).toEqual({ ok: false, reason: "rejected" });
  });

  it("refuses a non-https url, a malformed secret and a non-uuid agent before any call", async () => {
    const fetchImpl = boardFetch();
    for (const bad of [{ url: "http://paperclip.example.test/x" }, { secret: "whsec_not base64!" }, { secret: "plain" }, { boardAgentId: "nope" }]) {
      expect(await setCommsBoardWakeTarget(clientConfig, { ...request, ...bad }, fetchImpl)).toEqual({ ok: false, reason: "failed" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describeEmbeddedPostgres("comms-board wake registration at agent creation (TECH-9912)", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmp = path.join(os.tmpdir(), `paperclip-comms-wake-registration-${randomUUID()}`);
  let restoreCommsInstallDefault: (() => void) | null = null;
  const env: NodeJS.ProcessEnv = {
    [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
    [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
    [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
    [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
  };
  const wakeEntry = DEFAULT_MCP_SPEC.find((entry) => entry.key === "comms-wake")!;
  const boardEntry = DEFAULT_MCP_SPEC.find((entry) => entry.key === "comms-board")!;

  beforeAll(async () => {
    restoreCommsInstallDefault = withoutCommsInstallByDefault();
    mkdirSync(tmp, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmp, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("comms-wake-registration");
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
    // The org's comms-board template connection (read-only template the agent's own connection is cloned from).
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

  async function createAgent(companyId: string, ownerUserId: string) {
    const created = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  const rowOf = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then((r) => r[0]!);
  const stateOf = async (id: string) => readDefaultMcpState((await rowOf(id)).metadata)!.entries;
  const run = (companyId: string, agentId: string, fetchImpl: ReturnType<typeof boardFetch>, opts: { env?: NodeJS.ProcessEnv; spec?: typeof DEFAULT_MCP_SPEC[number][] } = {}) =>
    runDefaultMcpSetupForAgent({ db, env: opts.env ?? env, fetchImpl, now: LATER, ...(opts.spec ? { spec: opts.spec } : {}) }, { companyId, agentId });
  const wakeSecrets = (companyId: string) =>
    db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId)).then((rows) => rows.filter((row) => row.key?.startsWith("comms_wake.signing_secret.")));

  /** Everything that could leak: agent metadata, activity log, every logger call and every secret-access row's metadata. */
  async function expectNoSecretAnywhere(secret: string, agentId: string, logSpies: Array<ReturnType<typeof vi.spyOn>>) {
    expect(JSON.stringify((await rowOf(agentId)).metadata)).not.toContain(secret);
    expect(JSON.stringify(await db.select().from(activityLog))).not.toContain(secret);
    expect(JSON.stringify(await db.select().from(commsWakeRegistrations))).not.toContain(secret);
    for (const spy of logSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  }

  it("setting on: a new agent whose board identity is ready gets a vault secret, a registration row and exactly one board call", async () => {
    const { companyId, ownerId } = await seedCompany(true);
    const spies = (["warn", "error", "info", "debug"] as const).map((level) => vi.spyOn(logger, level));
    const agent = await createAgent(companyId, ownerId);
    expect((await stateOf(agent.id))["comms-wake"]!.setup.state).toBe("pending"); // offered at creation
    const fetchImpl = boardFetch();
    await run(companyId, agent.id, fetchImpl);

    const entries = await stateOf(agent.id);
    expect(entries["comms-board"]!.setup.state).toBe("ready");
    expect(entries["comms-wake"]!.setup).toMatchObject({ state: "ready", reason: null });
    expect(entries["comms-wake"]!.binding).toBeNull();

    expect(fetchImpl.wakeCalls).toHaveLength(1);
    const call = fetchImpl.wakeCalls[0]!;
    expect(call.agent_id).toBe(entries["comms-board"]!.binding!.boardAgentId);
    expect(call.url).toBe(`${PUBLIC_BASE}/api/comms-board/wake/${agent.id}`);
    expect(call.system).toBe("paperclip");
    expect(call.secret).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(call.secret.slice(6), "base64")).toHaveLength(32);

    const [registration] = await db.select().from(commsWakeRegistrations).where(eq(commsWakeRegistrations.agentId, agent.id));
    expect(registration).toMatchObject({ companyId, boardAgentId: call.agent_id });
    expect(await secretService(db).resolveSecretValue(companyId, registration!.signingSecretId, "latest")).toBe(call.secret);
    expect(await wakeSecrets(companyId)).toHaveLength(1);
    await expectNoSecretAnywhere(call.secret, agent.id, spies);
  });

  it("setting off: nothing is stored or called, and the agent has no comms-wake entry", async () => {
    const { companyId, ownerId } = await seedCompany(false);
    const agent = await createAgent(companyId, ownerId);
    const fetchImpl = boardFetch();
    await run(companyId, agent.id, fetchImpl);
    const entries = await stateOf(agent.id);
    expect(entries["comms-board"]!.setup.state).toBe("ready");
    expect(entries["comms-wake"]).toBeUndefined();
    expect(fetchImpl.wakeCalls).toHaveLength(0);
    expect(await wakeSecrets(companyId)).toHaveLength(0);
    expect(await db.select().from(commsWakeRegistrations)).toHaveLength(0);
  });

  it("a board failure does not fail creation: the state is pending with a reason, the secret and registration exist, and the sweep completes it with one more call and the same secret", async () => {
    const { companyId, ownerId } = await seedCompany(true);
    const spies = (["warn", "error", "info", "debug"] as const).map((level) => vi.spyOn(logger, level));
    const agent = await createAgent(companyId, ownerId);
    let failing = true;
    const fetchImpl = boardFetch({ respond: () => (failing ? toolError("misconfigured: allowlist is empty") : undefined as never) });
    // Failing board: the same fake answers normally once `failing` is false.
    const original = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      if (!failing && url === BOARD_URL && init.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.method === "tools/call" && body.params.name === WAKE_TOOL) {
          fetchImpl.wakeCalls.push(body.params.arguments);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ result: "replaced" }) }], isError: false } }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      return original(url, init);
    });

    await run(companyId, agent.id, fetchImpl);
    let entries = await stateOf(agent.id);
    expect((await rowOf(agent.id)).status).not.toBe("terminated");
    expect(entries["comms-board"]!.setup.state).toBe("ready");
    expect(entries["comms-wake"]!.setup).toMatchObject({ state: "pending", reason: "board_failed" });
    expect(fetchImpl.wakeCalls).toHaveLength(1);
    const firstSecret = fetchImpl.wakeCalls[0]!.secret;
    const [registration] = await db.select().from(commsWakeRegistrations).where(eq(commsWakeRegistrations.agentId, agent.id));
    expect(registration).toBeDefined(); // stored BEFORE the board call, so the route can already verify

    failing = false;
    expect(await sweepDefaultMcpSetups({ db, env, fetchImpl, now: LATER })).toBeGreaterThanOrEqual(1);
    entries = await stateOf(agent.id);
    expect(entries["comms-wake"]!.setup).toMatchObject({ state: "ready", reason: null });
    expect(fetchImpl.wakeCalls).toHaveLength(2);
    expect(fetchImpl.wakeCalls[1]!.secret).toBe(firstSecret); // the stored secret is reused, never regenerated
    expect(await wakeSecrets(companyId)).toHaveLength(1);
    expect(await db.select().from(commsWakeRegistrations)).toHaveLength(1);
    await expectNoSecretAnywhere(firstSecret, agent.id, spies);
  });

  it("credential not configured: stays pending without storing a secret or calling the board, then completes once configured", async () => {
    const { companyId, ownerId } = await seedCompany(true);
    const agent = await createAgent(companyId, ownerId);
    const fetchImpl = boardFetch();
    await run(companyId, agent.id, fetchImpl, { spec: [boardEntry] });
    expect((await stateOf(agent.id))["comms-board"]!.setup.state).toBe("ready");

    await run(companyId, agent.id, fetchImpl, { env: {}, spec: [wakeEntry] });
    expect((await stateOf(agent.id))["comms-wake"]!.setup).toMatchObject({ state: "pending", reason: "provisioner_not_configured" });
    expect(fetchImpl.wakeCalls).toHaveLength(0);
    expect(await wakeSecrets(companyId)).toHaveLength(0);

    await run(companyId, agent.id, fetchImpl, { spec: [wakeEntry] });
    expect((await stateOf(agent.id))["comms-wake"]!.setup.state).toBe("ready");
    expect(fetchImpl.wakeCalls).toHaveLength(1);
    expect(await wakeSecrets(companyId)).toHaveLength(1);
  });

  it("waits while the board identity is not ready, and while the instance has no https public base URL", async () => {
    const { companyId, ownerId } = await seedCompany(true);
    const agent = await createAgent(companyId, ownerId);
    const fetchImpl = boardFetch();
    await run(companyId, agent.id, fetchImpl, { spec: [wakeEntry] });
    expect((await stateOf(agent.id))["comms-wake"]!.setup).toMatchObject({ state: "pending", reason: "board_not_ready" });

    await run(companyId, agent.id, fetchImpl, { spec: [boardEntry] });
    setCommsWakePublicBaseUrl("http://paperclip.example.test");
    await run(companyId, agent.id, fetchImpl, { spec: [wakeEntry] });
    expect((await stateOf(agent.id))["comms-wake"]!.setup).toMatchObject({ state: "pending", reason: "public_base_url_unavailable" });
    expect(fetchImpl.wakeCalls).toHaveLength(0);
    expect(await wakeSecrets(companyId)).toHaveLength(0);
  });

  it("re-running after success makes no board call and creates no second secret", async () => {
    const { companyId, ownerId } = await seedCompany(true);
    const agent = await createAgent(companyId, ownerId);
    const fetchImpl = boardFetch();
    await run(companyId, agent.id, fetchImpl);
    expect(fetchImpl.wakeCalls).toHaveLength(1);
    await run(companyId, agent.id, fetchImpl);
    await sweepDefaultMcpSetups({ db, env, fetchImpl, now: LATER });
    expect(fetchImpl.wakeCalls).toHaveLength(1);
    expect(await wakeSecrets(companyId)).toHaveLength(1);
  });

  it("turning the setting off before the entry finishes leaves it pending (operator_excluded) with no call", async () => {
    const { companyId, ownerId } = await seedCompany(true);
    const agent = await createAgent(companyId, ownerId);
    await db.update(companies).set({ commsBoardWakeEnabled: false }).where(eq(companies.id, companyId));
    const fetchImpl = boardFetch();
    await run(companyId, agent.id, fetchImpl);
    expect((await stateOf(agent.id))["comms-wake"]!.setup).toMatchObject({ state: "pending", reason: "operator_excluded" });
    expect(fetchImpl.wakeCalls).toHaveLength(0);
    expect(await wakeSecrets(companyId)).toHaveLength(0);
  });

  it("an existing agent is never enrolled by creation of a later one (the entry is new-agents-only)", async () => {
    const { companyId, ownerId } = await seedCompany(false);
    const earlier = await createAgent(companyId, ownerId);
    await db.update(companies).set({ commsBoardWakeEnabled: true }).where(eq(companies.id, companyId));
    const later = await createAgent(companyId, ownerId);
    expect((await stateOf(earlier.id))["comms-wake"]).toBeUndefined();
    expect((await stateOf(later.id))["comms-wake"]).toBeDefined();
  });

  describe("deletion paths with a wake registration", () => {
    async function registered() {
      const { companyId, ownerId } = await seedCompany(true);
      const agent = await createAgent(companyId, ownerId);
      await run(companyId, agent.id, boardFetch());
      const [registration] = await db.select().from(commsWakeRegistrations).where(eq(commsWakeRegistrations.agentId, agent.id));
      expect(registration).toBeDefined();
      return { companyId, agent, registration: registration! };
    }
    const terminate = (agentId: string) => db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, agentId));

    it("deleting the company succeeds and leaves no registration or secret rows", async () => {
      const { companyId, agent } = await registered();
      await terminate(agent.id);
      await companyService(db).remove(companyId);
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
      expect(await db.select().from(commsWakeRegistrations)).toHaveLength(0);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(0);
    });

    it("purging the agent removes its registration (cascade) and, since TECH-9914, its vault secret (board cleanup is in comms-wake-admin.test.ts)", async () => {
      const { companyId, agent, registration } = await registered();
      await terminate(agent.id);
      await agentService(db).remove(agent.id);
      expect(await db.select().from(agents).where(eq(agents.id, agent.id))).toHaveLength(0);
      expect(await db.select().from(commsWakeRegistrations)).toHaveLength(0);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, registration.signingSecretId))).toHaveLength(0);
      expect(companyId).toBeTruthy();
    });

    it("removing the signing secret itself is refused up front and leaves it intact and usable", async () => {
      const { companyId, registration } = await registered();
      await expect(secretService(db).remove(registration.signingSecretId)).rejects.toMatchObject({ status: 409 });
      const [row] = await db.select().from(companySecrets).where(eq(companySecrets.id, registration.signingSecretId));
      expect(row).toMatchObject({ status: "active", deletedAt: null });
      expect(await secretService(db).resolveSecretValue(companyId, registration.signingSecretId, "latest")).toMatch(/^whsec_/);
      expect(await db.select().from(commsWakeRegistrations)).toHaveLength(1);
    });
  });
});
