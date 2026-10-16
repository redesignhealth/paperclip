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
import { logger } from "../middleware/logger.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { readDefaultMcpState, stripReservedDefaultMcpMetadata } from "../services/default-mcp-spec.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import {
  COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS,
  COMMS_BOARD_TOKEN_SCOPES,
  COMMS_BOARD_TOKEN_SCOPES_VERSION,
  rotateCommsBoardCredential,
} from "../services/comms-board-provisioner-client.js";
import {
  COMMS_RESCOPE_CONFIRMATION,
  CommsRescopeConfirmationError,
  rescopeCommsCredentials,
} from "../services/comms-credential-rescope.js";
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
const NEW_TOKEN = "rotated-board-token-SECRET-v2-abcdef0123456789";
const NEW_EXPIRY = "2027-09-01T00:00:00+00:00";

describe("rotateCommsBoardCredential (ownership API rotate contract)", () => {
  const sub = "paperclip-agent-0b2c7c1e-4f0a-4a4e-9b3e-0d6f0a3c9a11";
  const reply = (status: number, body: unknown = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("sends exactly the current scopes and expiry to /agents/{sub}/rotate with the ownership bearer", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ sub, owner_email: "o@x.test", active: true, token: NEW_TOKEN, token_expires_at: NEW_EXPIRY }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await rotateCommsBoardCredential(clientConfig, { baseSub: sub }, fetchImpl);
    expect(out).toEqual({ ok: true, boardToken: NEW_TOKEN, tokenExpiresAt: NEW_EXPIRY });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${OWNERSHIP_URL}/agents/${sub}/rotate`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${OWNERSHIP_TOKEN}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ scopes: [...COMMS_BOARD_TOKEN_SCOPES], expires_in_days: COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS });
    expect(body.scopes.some((s: string) => s.startsWith("ownership:") || s === "comms:admin")).toBe(false);
  });

  it("classifies 404, 409, 401/403, other statuses, network errors and contradictory 200s without leaking the token", async () => {
    expect(await rotateCommsBoardCredential(clientConfig, { baseSub: sub }, reply(404))).toEqual({ ok: false, reason: "rotate_unknown_sub" });
    expect(await rotateCommsBoardCredential(clientConfig, { baseSub: sub }, reply(409))).toEqual({ ok: false, reason: "rotate_deactivated" });
    expect(await rotateCommsBoardCredential(clientConfig, { baseSub: sub }, reply(403))).toEqual({ ok: false, reason: "rotate_rejected" });
    expect(await rotateCommsBoardCredential(clientConfig, { baseSub: sub }, reply(500))).toEqual({ ok: false, reason: "rotate_failed" });
    const network = vi.fn(async () => { throw new TypeError(`fetch failed ${NEW_TOKEN}`); }) as unknown as typeof fetch;
    expect(await rotateCommsBoardCredential(clientConfig, { baseSub: sub }, network)).toEqual({ ok: false, reason: "rotate_failed" });
    expect(await rotateCommsBoardCredential(clientConfig, { baseSub: sub }, reply(200, { sub: "other", active: true, token: NEW_TOKEN }))).toEqual({ ok: false, reason: "rotate_failed" });
    expect(await rotateCommsBoardCredential(clientConfig, { baseSub: sub }, reply(200, { sub, active: false, token: NEW_TOKEN }))).toEqual({ ok: false, reason: "rotate_failed" });
    expect(await rotateCommsBoardCredential(clientConfig, { baseSub: sub }, reply(200, { sub, active: true, token: "" }))).toEqual({ ok: false, reason: "rotate_failed" });
  });

  it("refuses a malformed sub locally with no call", async () => {
    const fetchImpl = reply(200);
    expect(await rotateCommsBoardCredential(clientConfig, { baseSub: "A/../b" }, fetchImpl)).toEqual({ ok: false, reason: "invalid_subject" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("scope version marker protection", () => {
  it("a client-supplied defaultMcp key (including a forged commsScopeVersion) is discarded; the stored one is preserved", () => {
    const stored = { version: 1, entries: { "comms-board": { binding: { commsScopeVersion: 1 } } } };
    const forged = { version: 1, entries: { "comms-board": { binding: { commsScopeVersion: 99 } } } };
    expect(stripReservedDefaultMcpMetadata({ defaultMcp: forged, keep: 1 }, { defaultMcp: stored })).toEqual({ keep: 1, defaultMcp: stored });
    expect(stripReservedDefaultMcpMetadata({ defaultMcp: forged }, null)).toEqual({});
  });
});

describeEmbeddedPostgres("comms-board credential rescope for existing agents", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-comms-rescope-${randomUUID()}`);
  const envKeys = [FEATURE_ENV, COMMS_BOARD_MCP_URL_ENV, COMMS_BOARD_ADMIN_TOKEN_ENV, COMMS_BOARD_OWNERSHIP_API_URL_ENV, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("comms-credential-rescope");
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
  /** Turns a freshly minted agent into one created before the marker existed (v1 token, no marker). */
  async function makeLegacy(agentId: string) {
    await db
      .update(agents)
      .set({ metadata: sql`${agents.metadata} #- ARRAY['defaultMcp','entries','comms-board','binding','commsScopeVersion']::text[]` })
      .where(eq(agents.id, agentId));
  }
  const secretOf = async (agentId: string) => (await entryOf(agentId)).binding!.secretId!;
  const latestToken = async (companyId: string, agentId: string) => secretService(db).resolveSecretValue(companyId, await secretOf(agentId), "latest");
  const secretVersions = async (agentId: string) =>
    (await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, await secretOf(agentId)))).length;

  type RotateStep = "ok" | 404 | 409 | 403 | 500 | "network";
  /** Stand-in for the ownership API rotate route; records what it saw. Anything else is unexpected. */
  function rotateFetch(script: (sub: string) => RotateStep = () => "ok") {
    const calls: Array<{ url: string; sub: string; headers: Record<string, string>; body: { scopes: string[]; expires_in_days: number } }> = [];
    const impl = vi.fn(async (url: string, init: RequestInit) => {
      const match = /^https:\/\/ownership\.example\.test\/agents\/([^/]+)\/rotate$/.exec(url);
      if (!match || init.method !== "POST") throw new Error(`unexpected url ${url}`);
      const sub = decodeURIComponent(match[1]!);
      calls.push({ url, sub, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      const step = script(sub);
      if (step === "network") throw new TypeError("fetch failed");
      if (step !== "ok") return new Response("{}", { status: step });
      return new Response(JSON.stringify({ sub, owner_email: "owner@redesignhealth.com", active: true, token: NEW_TOKEN, token_expires_at: NEW_EXPIRY }), { status: 200 });
    });
    return { impl: impl as unknown as typeof fetch, calls, mock: impl };
  }

  const real = (companyId: string, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    rescopeCommsCredentials(db, { companyId, dryRun: false, confirm: COMMS_RESCOPE_CONFIRMATION, fetchImpl, ...extra });
  const outcomeOf = (report: Awaited<ReturnType<typeof real>>, agentId: string) => report.outcomes.find((o) => o.agentId === agentId)?.result;
  const everything = async () =>
    JSON.stringify([
      await db.select().from(agents).orderBy(agents.id),
      await db.select().from(companySecrets).orderBy(companySecrets.id),
      await db.select().from(companySecretVersions).orderBy(companySecretVersions.id),
      await db.select().from(connectionGrants).orderBy(connectionGrants.id),
    ]);

  async function legacyAgents(count: number) {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    const created = [];
    for (let i = 0; i < count; i += 1) {
      const agent = await readyAgent(companyId, ownerId);
      await makeLegacy(agent.id);
      created.push(agent);
    }
    return { companyId, ownerId, agents: created };
  }

  it("new mints record the current scope version on the binding", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    const agent = await readyAgent(companyId, ownerId);
    const entry = await entryOf(agent.id);
    expect(entry.setup.state).toBe("ready");
    expect(entry.binding!.commsScopeVersion).toBe(COMMS_BOARD_TOKEN_SCOPES_VERSION);
    expect(COMMS_BOARD_TOKEN_SCOPES_VERSION).toBe(2);
  });

  it("a dry run (the default) lists who would be rescoped, changes nothing and calls nothing", async () => {
    const { companyId, ownerId, agents: [legacy] } = await legacyAgents(1);
    const current = await readyAgent(companyId, ownerId);
    configureDownstream();
    const before = await everything();
    const spy = rotateFetch();

    const report = await rescopeCommsCredentials(db, { companyId, fetchImpl: spy.impl });

    expect(report.dryRun).toBe(true);
    expect(outcomeOf(report, legacy!.id)).toBe("would_rescope");
    expect(outcomeOf(report, current.id)).toBe("already_current");
    expect(report.counts.would_rescope).toBe(1);
    expect(report.counts.already_current).toBe(1);
    expect(spy.mock).not.toHaveBeenCalled();
    expect(await everything()).toBe(before);
  });

  it("a real run without the confirmation string is rejected before anything happens", async () => {
    const { companyId } = await legacyAgents(1);
    configureDownstream();
    const spy = rotateFetch();
    const before = await everything();
    await expect(rescopeCommsCredentials(db, { companyId, dryRun: false, fetchImpl: spy.impl })).rejects.toBeInstanceOf(CommsRescopeConfirmationError);
    await expect(rescopeCommsCredentials(db, { companyId, dryRun: false, confirm: "yes", fetchImpl: spy.impl })).rejects.toBeInstanceOf(CommsRescopeConfirmationError);
    expect(spy.mock).not.toHaveBeenCalled();
    expect(await everything()).toBe(before);
  });

  it("rotates once per eligible agent with exactly the current scopes, writes a new secret version, then records the marker; the connection is untouched", async () => {
    const { companyId, agents: [a, b] } = await legacyAgents(2);
    configureDownstream();
    const spy = rotateFetch();
    const bindingBefore = await entryOf(a!.id);
    const versionsBefore = await secretVersions(a!.id);
    const oldToken = await latestToken(companyId, a!.id);
    expect(oldToken).toBe(BOARD_TOKEN);
    // At the moment of the rotate call the marker is still absent: it is only written after the secret.
    const markerAtCall: Array<number | null | undefined> = [];
    const orderedFetch = (async (url: string, init: RequestInit) => {
      if (url.includes(a!.id)) markerAtCall.push((await entryOf(a!.id)).binding!.commsScopeVersion);
      return spy.impl(url, init);
    }) as typeof fetch;

    const report = await real(companyId, orderedFetch);

    expect(report.counts.rescoped).toBe(2);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.map((c) => c.sub).sort()).toEqual([`paperclip-agent-${a!.id}`, `paperclip-agent-${b!.id}`].sort());
    for (const call of spy.calls) {
      expect(call.body).toEqual({ scopes: [...COMMS_BOARD_TOKEN_SCOPES], expires_in_days: COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS });
      expect(call.body.scopes.some((s) => s.startsWith("ownership:") || s === "comms:admin")).toBe(false);
      expect(call.headers.authorization).toBe(`Bearer ${OWNERSHIP_TOKEN}`);
    }
    expect(markerAtCall).toEqual([undefined]);
    for (const agent of [a!, b!]) {
      const entry = await entryOf(agent.id);
      expect(entry.binding!.commsScopeVersion).toBe(COMMS_BOARD_TOKEN_SCOPES_VERSION);
      expect(entry.binding!.tokenExpiresAt).toBe(NEW_EXPIRY);
      expect(entry.binding!.rescope).toBeUndefined();
      expect(entry.setup.state).toBe("ready");
      expect(await latestToken(companyId, agent.id)).toBe(NEW_TOKEN);
    }
    expect(await secretVersions(a!.id)).toBe(versionsBefore + 1);
    // Same secret, same connection, same grant: only the secret gained a version and the marker moved.
    const bindingAfter = await entryOf(a!.id);
    expect({ ...bindingAfter.binding, commsScopeVersion: undefined, tokenExpiresAt: undefined }).toEqual({ ...bindingBefore.binding, commsScopeVersion: undefined, tokenExpiresAt: undefined });
    expect(bindingAfter.connectionId).toBe(bindingBefore.connectionId);
  });

  it("is idempotent: a second run makes no call and changes nothing", async () => {
    const { companyId } = await legacyAgents(2);
    configureDownstream();
    await real(companyId, rotateFetch().impl);
    const before = await everything();
    const spy = rotateFetch();

    const report = await real(companyId, spy.impl);

    expect(report.counts.already_current).toBe(2);
    expect(report.counts.rescoped).toBe(0);
    expect(spy.mock).not.toHaveBeenCalled();
    expect(await everything()).toBe(before);
  });

  it("isolates per-agent failures and classifies unknown/deactivated subs; failed agents stay untouched and retryable", async () => {
    const { companyId, agents: [ok, unknown, deactivated, rejected, broken, network] } = await legacyAgents(6);
    configureDownstream();
    const script = (sub: string): RotateStep =>
      sub.endsWith(unknown!.id) ? 404 : sub.endsWith(deactivated!.id) ? 409 : sub.endsWith(rejected!.id) ? 403 : sub.endsWith(broken!.id) ? 500 : sub.endsWith(network!.id) ? "network" : "ok";
    const before = new Map<string, string>();
    for (const a of [unknown!, deactivated!, rejected!, broken!, network!]) before.set(a.id, JSON.stringify(await rowOf(a.id)) + (await latestToken(companyId, a.id)));
    const spy = rotateFetch(script);

    const report = await real(companyId, spy.impl);

    expect(outcomeOf(report, ok!.id)).toBe("rescoped");
    expect(outcomeOf(report, unknown!.id)).toBe("rotate_unknown_sub");
    expect(outcomeOf(report, deactivated!.id)).toBe("rotate_deactivated");
    expect(outcomeOf(report, rejected!.id)).toBe("rotate_rejected");
    expect(outcomeOf(report, broken!.id)).toBe("rotate_failed");
    expect(outcomeOf(report, network!.id)).toBe("rotate_failed");
    expect(report.counts).toMatchObject({ rescoped: 1, rotate_unknown_sub: 1, rotate_deactivated: 1, rotate_rejected: 1, rotate_failed: 2 });
    expect(spy.calls).toHaveLength(6); // one call each, no retry inside the call
    for (const a of [unknown!, deactivated!, rejected!, broken!, network!]) {
      expect(JSON.stringify(await rowOf(a.id)) + (await latestToken(companyId, a.id))).toBe(before.get(a.id));
    }
    // A re-run picks up exactly the failed ones.
    const again = rotateFetch();
    const second = await real(companyId, again.impl);
    expect(second.counts).toMatchObject({ rescoped: 5, already_current: 1 });
    expect(again.calls).toHaveLength(5);
  });

  it("a secret write failure records a visible retryable marker without advancing the version; the old token still resolves; a re-run rotates again", async () => {
    const { companyId, agents: [agent] } = await legacyAgents(1);
    configureDownstream();
    const secretId = await secretOf(agent!.id);
    await db.update(companySecrets).set({ provider: "no_such_provider" as never }).where(eq(companySecrets.id, secretId));
    const spy = rotateFetch();

    const report = await real(companyId, spy.impl);

    expect(outcomeOf(report, agent!.id)).toBe("secret_write_failed");
    expect(spy.calls).toHaveLength(1);
    const failed = await entryOf(agent!.id);
    expect(failed.binding!.commsScopeVersion).toBeUndefined();
    expect(failed.binding!.rescope).toMatchObject({ state: "failed", reason: "secret_write_failed", tokenMinted: true });
    expect(failed.setup.state).toBe("ready");

    await db.update(companySecrets).set({ provider: "local_encrypted" }).where(eq(companySecrets.id, secretId));
    expect(await latestToken(companyId, agent!.id)).toBe(BOARD_TOKEN); // never left without a valid token
    const retry = rotateFetch();
    const second = await real(companyId, retry.impl);
    expect(outcomeOf(second, agent!.id)).toBe("rescoped");
    expect(retry.calls).toHaveLength(1); // rotated again rather than assuming
    const healed = await entryOf(agent!.id);
    expect(healed.binding!.commsScopeVersion).toBe(COMMS_BOARD_TOKEN_SCOPES_VERSION);
    expect(healed.binding!.rescope).toBeUndefined();
    expect(await latestToken(companyId, agent!.id)).toBe(NEW_TOKEN);
  });

  it("fails closed when the provisioner is not configured: every eligible agent is reported and no HTTP call is made", async () => {
    const { companyId, agents: [a, b] } = await legacyAgents(2);
    clearBootProvisionerSnapshot();
    const spy = rotateFetch();
    const before = await everything();

    const report = await real(companyId, spy.impl);

    expect(outcomeOf(report, a!.id)).toBe("provisioner_not_configured");
    expect(outcomeOf(report, b!.id)).toBe("provisioner_not_configured");
    expect(report.counts.provisioner_not_configured).toBe(2);
    expect(spy.mock).not.toHaveBeenCalled();
    expect(await everything()).toBe(before);
  });

  it("skips agents that are not eligible and never rotates them", async () => {
    const { companyId, ownerId, agents: [pending, notDedicated, terminated] } = await legacyAgents(3);
    const noEntry = await db.insert(agents).values({ companyId, name: "plain", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning().then((r) => r[0]!);
    void ownerId;
    await db.update(agents).set({ metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries','comms-board','setup','state']::text[], '"pending"'::jsonb)` }).where(eq(agents.id, pending!.id));
    await db.update(agents).set({ metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries','comms-board','dedicated']::text[], 'false'::jsonb)` }).where(eq(agents.id, notDedicated!.id));
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, terminated!.id));
    configureDownstream();
    const spy = rotateFetch();

    const report = await real(companyId, spy.impl);

    expect(outcomeOf(report, pending!.id)).toBe("skipped_not_ready");
    expect(outcomeOf(report, notDedicated!.id)).toBe("skipped_not_dedicated");
    expect(outcomeOf(report, terminated!.id)).toBe("skipped_terminated");
    expect(outcomeOf(report, noEntry.id)).toBe("skipped_no_entry");
    expect(spy.mock).not.toHaveBeenCalled();
  });

  it("batches with limit and afterId and never touches another company", async () => {
    const { companyId, agents: created } = await legacyAgents(3);
    const other = await legacyAgents(1);
    configureDownstream();
    const spy = rotateFetch();

    const first = await real(companyId, spy.impl, { limit: 2 });
    expect(first.scanned).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await real(companyId, spy.impl, { limit: 2, afterId: first.nextCursor! });
    expect(second.scanned).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect(spy.calls).toHaveLength(created.length);
    expect((await entryOf(other.agents[0]!.id)).binding!.commsScopeVersion).toBeUndefined();
  });

  it("no token, secret value, secret id, vault key, bearer or URL appears in the report, logs or activity log", async () => {
    const { companyId, agents: created } = await legacyAgents(3);
    configureDownstream();
    const secretIds = await Promise.all(created.map((a) => secretOf(a.id)));
    const keys = (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).map((s) => s.key);
    const logged: unknown[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
    }
    const spy = rotateFetch((sub) => (sub.endsWith(created[1]!.id) ? "network" : "ok"));
    const report = await real(companyId, spy.impl);
    // Also a secret-write failure path.
    await db.update(companySecrets).set({ provider: "no_such_provider" as never }).where(eq(companySecrets.id, secretIds[2]!));
    const failing = await real(companyId, rotateFetch().impl);
    await db.update(companySecrets).set({ provider: "local_encrypted" }).where(eq(companySecrets.id, secretIds[2]!));

    const haystack = JSON.stringify([report, failing, logged, await db.select().from(activityLog), await Promise.all(created.map(async (a) => (await rowOf(a.id)).metadata.defaultMcp === undefined ? null : (await entryOf(a.id)).binding!.rescope ?? null))]);
    for (const needle of [NEW_TOKEN, BOARD_TOKEN, BOARD_ADMIN_TOKEN, OWNERSHIP_TOKEN, OWNERSHIP_URL, BOARD_URL, "Bearer", ...secretIds, ...keys]) {
      expect(haystack).not.toContain(needle);
    }
    expect(JSON.stringify(report)).toContain(created[0]!.id);
  });
});
