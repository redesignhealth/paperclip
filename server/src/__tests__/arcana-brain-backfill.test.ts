import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, companySecretBindings, companySecretVersions, companySecrets, connectionGrants, connectionTokenIssuances, createDb, heartbeatRuns, toolAccessAuditEvents, toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolMcpGatewayTokens, toolMcpGateways, toolOauthStates, toolProfileBindings, toolProfileEntries, toolProfiles, toolRuntimeSlots, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { DEFAULT_MCP_SPEC, readDefaultMcpState } from "../services/default-mcp-spec.js";
import { runDefaultMcpSetupForAgent, snapshotDefaultMcpForNewAgent, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import {
  ARCANA_BACKFILL_CONFIRMATION,
  ArcanaBackfillConfirmationError,
  backfillArcanaBrains,
  enableForAgent,
} from "../services/arcana-brain-backfill.js";
import { installAppliesToAgent, managedConnectionRole } from "../services/default-mcp-spec.js";
import {
  ARCANA_PROVISION_KEY_ENV,
  ARCANA_URL_ENV,
  composeArcanaBrainIdentity,
} from "../services/arcana-provisioner-client.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TEMPLATE_URL = "https://8.8.8.8/mcp";
const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";
const ARCANA_URL = "https://arcana.example.test";
const PROVISION_KEY = "synthetic-provision-key-0123456789abcdef";
const ARCANA_ENTRY = DEFAULT_MCP_SPEC.find((entry) => entry.key === "arcana-brain")!;
const later = (ms = 2 * 3_600_000) => () => new Date(Date.now() + ms);

type ProvisionCall = { url: string; method: string; headers: Record<string, string>; bodyText: string; body: Record<string, string> };

/** A stand-in for Arcana's provision route: idempotent per principal, 409 on a different hash. */
function arcanaFetch(script: Array<"ok" | "network" | "conflict" | "unauthorized" | "server"> = []) {
  const known = new Map<string, string>();
  const calls: ProvisionCall[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const bodyText = String(init.body);
    const body = JSON.parse(bodyText) as Record<string, string>;
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, bodyText, body });
    const step = script.shift() ?? "ok";
    if (step === "network") throw new TypeError("fetch failed");
    if (step === "unauthorized") return new Response("{}", { status: 401 });
    if (step === "server") return new Response("{}", { status: 503 });
    if (step === "conflict") return new Response("{}", { status: 409 });
    const prior = known.get(body.agent_principal_id!);
    if (prior !== undefined && prior !== body.exchange_key_hash) return new Response("{}", { status: 409 });
    known.set(body.agent_principal_id!, body.exchange_key_hash!);
    return new Response(JSON.stringify({ brain_id: `agent:${body.agent_principal_id}`, status: "active" }), {
      status: prior === undefined ? 201 : 200,
    });
  });
  return { impl: impl as unknown as typeof fetch, calls, mock: impl };
}

describeEmbeddedPostgres("Arcana brain backfill for existing agents (TECH-7326)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-arcana-brain-backfill-${randomUUID()}`);
  const configuredEnv: NodeJS.ProcessEnv = { [ARCANA_URL_ENV]: ARCANA_URL, [ARCANA_PROVISION_KEY_ENV]: PROVISION_KEY };

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("arcana-brain-backfill");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    vi.restoreAllMocks();
    __resetDefaultMcpTemplateScopeForTests();
    delete process.env[FEATURE_ENV];
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
    await db.delete(principalPermissionGrants);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
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

  /** The org-authored `rh-arcana-brain` template: an active api_key MCP connection with one header credential ref. */
  async function seedTemplate(companyId: string) {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app arcana ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const shared = await secretService(db).create(companyId, {
      name: `shared arcana ${randomUUID()}`,
      key: `shared.${randomUUID()}`,
      provider: "local_encrypted",
      value: "org-shared-template-token",
    });
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name: ARCANA_ENTRY.connectionName,
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
      .values({ companyId, applicationId: application.id, connectionId: connection.id, name: "arcana_recall", toolName: "arcana_recall", versionHash: "v1" })
      .returning();
    const [profile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `app:${connection.id}`, name: "arcana access", defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: connection.id } })
      .returning();
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "catalog_entry", effect: "include", connectionId: connection.id, catalogEntryId: entry!.id });
    return connection;
  }


  const entryOfKey = async (agentId: string, key: string) =>
    readDefaultMcpState((await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.metadata)!.entries[key];
  /** An EXISTING agent: created while the feature was off, so it has no `defaultMcp` state at all. */
  async function legacyAgent(companyId: string, ownerUserId: string | null) {
    delete process.env[FEATURE_ENV];
    const created = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  /** An enrolled agent whose snapshot predates the arcana entry: it only holds the comms-board entry. */
  async function enrolledWithoutArcana(companyId: string, ownerUserId: string | null) {
    const agent = await legacyAgent(companyId, ownerUserId);
    const commsOnly = DEFAULT_MCP_SPEC.filter((entry) => entry.key === "comms-board");
    await snapshotDefaultMcpForNewAgent(db, { companyId, agentId: agent.id, ownerUserId, spec: commsOnly });
    return agent;
  }

  /** A newly created agent whose arcana setup already failed terminally (a 409 from Arcana). */
  async function agentWithFailedArcanaEntry(companyId: string, ownerUserId: string | null) {
    process.env[FEATURE_ENV] = "true";
    const agent = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    delete process.env[FEATURE_ENV];
    await db.update(agents).set({
      metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries','arcana-brain','setup']::text[], (${agents.metadata} #> ARRAY['defaultMcp','entries','arcana-brain','setup']::text[]) || '{"state":"error","reason":"provision_conflict"}'::jsonb, false)`,
    }).where(eq(agents.id, agent.id));
    return agent;
  }

  const realEnv: NodeJS.ProcessEnv = { ...configuredEnv, [FEATURE_ENV]: "true" };
  const real = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    backfillArcanaBrains(db, { dryRun: false, confirm: ARCANA_BACKFILL_CONFIRMATION, delayMs: 0, env: realEnv, fetchImpl, now: later(), ...extra });
  const census = (extra: Record<string, unknown> = {}) => backfillArcanaBrains(db, { env: realEnv, ...extra });
  const rowOf = async (agentId: string) => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
  const entryOf = async (agentId: string) => readDefaultMcpState((await rowOf(agentId)).metadata)!.entries["arcana-brain"]!;
  const arcanaSecrets = async (companyId: string) =>
    (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).filter((s) => s.key.startsWith("arcana_brain."));
  const grantsFor = (agentId: string) => db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agentId));
  const installsFor = (agentId: string) => db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agentId));
  const outcomeOf = (report: Awaited<ReturnType<typeof census>>, agentId: string) => report.outcomes.find((o) => o.agentId === agentId);

  it("a census lists exactly the agents without a ready arcana entry and writes nothing", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const noState = await legacyAgent(companyId, ownerId);
    const commsOnly = await enrolledWithoutArcana(companyId, ownerId);
    const failed = await agentWithFailedArcanaEntry(companyId, ownerId);
    const terminated = await legacyAgent(companyId, ownerId);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, terminated.id));
    // An agent in another company that is already provisioned.
    const otherCompany = await seedCompany();
    await seedTemplate(otherCompany);
    const done = await legacyAgent(otherCompany, await seedOwner(otherCompany));
    await real(arcanaFetch().impl, { companyId: otherCompany });
    const everything = async () => JSON.stringify([await db.select().from(agents).orderBy(agents.id), await db.select().from(companySecrets).orderBy(companySecrets.id), await db.select().from(connectionGrants).orderBy(connectionGrants.id)]);
    const before = await everything();
    const fetchSpy = arcanaFetch();

    const report = await census({ fetchImpl: fetchSpy.impl });

    expect(report.dryRun).toBe(true);
    expect(report.blocked).toBeNull();
    expect(outcomeOf(report, noState.id)).toMatchObject({ result: "would_provision", plan: "add_entry" });
    expect(outcomeOf(report, commsOnly.id)).toMatchObject({ result: "would_provision", plan: "add_entry" });
    expect(outcomeOf(report, failed.id)).toMatchObject({ result: "would_provision", plan: "retry_failed" });
    expect(outcomeOf(report, done.id)).toMatchObject({ result: "skipped", reason: "already_provisioned" });
    expect(outcomeOf(report, terminated.id)).toMatchObject({ result: "skipped", reason: "agent_terminated" });
    expect(report.counts.would_provision).toBe(3);
    expect(fetchSpy.mock).not.toHaveBeenCalled();
    expect(await everything()).toBe(before);
  });

  it("provisions an empty brain for each existing agent kind, installs only its own connection, and leaves other entries alone", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const legacy = await legacyAgent(companyId, ownerId);
    const enrolled = await enrolledWithoutArcana(companyId, ownerId);
    const failed = await agentWithFailedArcanaEntry(companyId, ownerId);
    const commsBefore = JSON.stringify((await entryOfKey(enrolled.id, "comms-board")));
    const arcana = arcanaFetch();

    const report = await real(arcana.impl);

    for (const agent of [legacy, enrolled, failed]) {
      expect(outcomeOf(report, agent.id)).toMatchObject({ result: "provisioned" });
      const entry = await entryOf(agent.id);
      expect(entry.setup.state).toBe("ready");
      expect(entry).toMatchObject({ enabled: true, backfillEnable: "done" });
      const grants = await grantsFor(agent.id);
      expect(grants).toHaveLength(1);
      expect(grants[0]!.connectionId).toBe(entry.connectionId);
      const installs = await installsFor(agent.id);
      expect(installs).toHaveLength(1);
      expect(installs[0]).toMatchObject({ targetType: "agent", connectionId: entry.connectionId });
    }
    expect(report.counts).toMatchObject({ provisioned: 3, failed: 0, pending: 0 });
    // Empty brains: the only Arcana traffic is one provision call each, never a source or document write.
    expect(arcana.calls).toHaveLength(3);
    expect(arcana.calls.every((c) => c.url.endsWith("/api/v1/brain/provision") && c.method === "POST")).toBe(true);
    expect(arcana.calls.every((c) => /^[0-9a-f]{64}$/.test(c.body.exchange_key_hash!))).toBe(true);
    expect(await arcanaSecrets(companyId)).toHaveLength(3);
    // The comms entry on the enrolled agent is byte-for-byte what it was, and the comms hook never ran.
    expect(JSON.stringify(await entryOfKey(enrolled.id, "comms-board"))).toBe(commsBefore);
    // The legacy agent now holds a state with ONLY the arcana entry; nothing else was added for it.
    expect(Object.keys(readDefaultMcpState((await rowOf(legacy.id)).metadata)!.entries)).toEqual(["arcana-brain"]);
    // The activity log carries non-secret facts only.
    const logged = JSON.stringify(await db.select().from(activityLog));
    expect(logged).toContain("agent.default_mcp.arcana_backfill_enabled");
    for (const secret of await arcanaSecrets(companyId)) {
      expect(logged).not.toContain(await secretService(db).resolveSecretValue(companyId, secret.id, "latest"));
    }
  });

  it("a second run provisions nothing and creates no second key, grant, connection or install", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const agents3 = [await legacyAgent(companyId, ownerId), await enrolledWithoutArcana(companyId, ownerId), await legacyAgent(companyId, ownerId)];
    const arcana = arcanaFetch();
    await real(arcana.impl);
    const snapshot = async () => JSON.stringify([
      await db.select().from(companySecrets).orderBy(companySecrets.id),
      await db.select().from(connectionGrants).orderBy(connectionGrants.id),
      await db.select().from(toolConnections).orderBy(toolConnections.id),
      await db.select().from(toolConnectionInstalls).orderBy(toolConnectionInstalls.id),
    ]);
    const before = await snapshot();

    const again = await real(arcana.impl, { now: later(6 * 3_600_000) });

    expect(again.counts).toMatchObject({ provisioned: 0, would_provision: 0, failed: 0, pending: 0 });
    expect(agents3.every((a) => outcomeOf(again, a.id)?.result === "skipped")).toBe(true);
    expect(arcana.calls).toHaveLength(3);
    expect(await snapshot()).toBe(before);
  });

  it("one agent's Arcana failure is reported, leaves no usable key, and does not stop the others; a retry then succeeds", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const bad = await legacyAgent(companyId, ownerId);
    const good = await legacyAgent(companyId, ownerId);
    const badPrincipal = composeArcanaBrainIdentity(companyId, bad.id)!.agentPrincipalId;
    const arcana = arcanaFetch();
    const failBad = (async (url: string, init: RequestInit) =>
      JSON.parse(String(init.body)).agent_principal_id === badPrincipal ? new Response("{}", { status: 409 }) : arcana.impl(url, init)) as unknown as typeof fetch;

    const report = await real(failBad);

    expect(outcomeOf(report, bad.id)).toMatchObject({ result: "failed", reason: "provision_conflict" });
    expect(outcomeOf(report, good.id)).toMatchObject({ result: "provisioned" });
    expect((await entryOf(bad.id)).setup).toMatchObject({ state: "error", reason: "provision_conflict" });
    // "No usable key": nothing connects the failed agent's stored key to the agent or lets it call anything.
    expect(await grantsFor(bad.id)).toHaveLength(0);
    expect(await installsFor(bad.id)).toHaveLength(0);
    expect((await entryOf(bad.id)).connectionId).toBeNull();

    const retried = await real(arcana.impl, { now: later(8 * 3_600_000) });

    expect(outcomeOf(retried, bad.id)).toMatchObject({ result: "provisioned", plan: "retry_failed" });
    expect(outcomeOf(retried, good.id)).toMatchObject({ result: "skipped", reason: "already_provisioned" });
    expect(await arcanaSecrets(companyId)).toHaveLength(2); // the same stored key was reused, no orphan
    expect(await grantsFor(bad.id)).toHaveLength(1);
  });

  it("changes no other MCP setting: a company-wide install on another connection still applies to a legacy agent", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const legacy = await legacyAgent(companyId, ownerId);
    const otherApp = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `other ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const other = await db
      .insert(toolConnections)
      .values({ companyId, applicationId: otherApp.id, name: "unrelated-app", uid: `uid-${randomUUID()}`, transport: "mcp_remote", authKind: "none", credentialPolicy: "shared", status: "active", enabled: true, config: {}, transportConfig: { url: TEMPLATE_URL }, credentialRefs: [] })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: other.id, targetType: "company", targetId: companyId });
    const installsBefore = JSON.stringify(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, other.id)));

    await real(arcanaFetch().impl);

    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(managedConnectionRole(state, companyId, other)).toBeNull();
    expect(installAppliesToAgent({ targetType: "company" }, { companyId, state }, other)).toBe(true);
    expect(JSON.stringify(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, other.id)))).toBe(installsBefore);
  });

  it("two agents are isolated: separate keys, grants and installs, each bound only to itself", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const a = await legacyAgent(companyId, ownerId);
    const b = await legacyAgent(companyId, ownerId);
    const arcana = arcanaFetch();

    await real(arcana.impl);

    const [entryA, entryB] = [await entryOf(a.id), await entryOf(b.id)];
    expect(entryA.binding?.secretId).not.toBe(entryB.binding?.secretId);
    expect(entryA.connectionId).not.toBe(entryB.connectionId);
    expect(new Set(arcana.calls.map((c) => c.body.agent_principal_id)).size).toBe(2);
    expect(new Set(arcana.calls.map((c) => c.body.exchange_key_hash)).size).toBe(2);
    const [installsA, installsB] = [await installsFor(a.id), await installsFor(b.id)];
    expect(installsA.map((i) => i.connectionId)).toEqual([entryA.connectionId]);
    expect(installsB.map((i) => i.connectionId)).toEqual([entryB.connectionId]);
    expect((await grantsFor(a.id))[0]!.credentialSecretRefs[0]!.secretId).toBe(entryA.binding?.secretId);
    expect((await grantsFor(b.id))[0]!.credentialSecretRefs[0]!.secretId).toBe(entryB.binding?.secretId);
  });

  it("a real run needs dryRun false and the exact confirmation, and does nothing while a gate is closed", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const agent = await legacyAgent(companyId, ownerId);
    const arcana = arcanaFetch();

    await expect(backfillArcanaBrains(db, { dryRun: false, env: realEnv, fetchImpl: arcana.impl })).rejects.toBeInstanceOf(ArcanaBackfillConfirmationError);
    await expect(backfillArcanaBrains(db, { dryRun: false, confirm: "yes", env: realEnv, fetchImpl: arcana.impl })).rejects.toBeInstanceOf(ArcanaBackfillConfirmationError);
    const flagOff = await real(arcana.impl, { env: configuredEnv });
    const noConfig = await real(arcana.impl, { env: { [FEATURE_ENV]: "true" } });

    expect(flagOff).toMatchObject({ blocked: "feature_flag_off", scanned: 0 });
    expect(noConfig).toMatchObject({ blocked: "arcana_not_configured", scanned: 0 });
    expect(arcana.mock).not.toHaveBeenCalled();
    expect(readDefaultMcpState((await rowOf(agent.id)).metadata)).toBeNull();
    // The census still reports what a real run would do, and says why it is blocked.
    expect(await census({ env: { [FEATURE_ENV]: "true" } })).toMatchObject({ blocked: "arcana_not_configured" });
  });

  it("skips companies outside the rollout scope and agents that are pending approval, without touching them", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const outside = await legacyAgent(companyId, ownerId);
    const arcana = arcanaFetch();

    const scoped = await real(arcana.impl, { templateScope: { mode: "allowlist", companyIds: [randomUUID()] } });
    expect(outcomeOf(scoped, outside.id)).toMatchObject({ result: "skipped", reason: "company_out_of_scope" });

    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, outside.id));
    const pending = await real(arcana.impl);
    expect(outcomeOf(pending, outside.id)).toMatchObject({ result: "skipped", reason: "agent_pending_approval" });
    expect(arcana.mock).not.toHaveBeenCalled();
    expect(readDefaultMcpState((await rowOf(outside.id)).metadata)).toBeNull();
  });

  it("waits while the company template is missing, then enables the agent once the sweep finishes setup", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await legacyAgent(companyId, ownerId);
    const arcana = arcanaFetch();

    const first = await real(arcana.impl);
    expect(outcomeOf(first, agent.id)).toMatchObject({ result: "pending", reason: "template_not_found" });
    expect(arcana.mock).not.toHaveBeenCalled();
    expect(await installsFor(agent.id)).toHaveLength(0);

    await seedTemplate(companyId);
    await runDefaultMcpSetupForAgent(
      { db, env: realEnv, fetchImpl: arcana.impl, spec: DEFAULT_MCP_SPEC.filter((e) => e.key === "arcana-brain"), now: later(4 * 3_600_000) },
      { companyId, agentId: agent.id },
    );
    expect((await entryOf(agent.id)).setup.state).toBe("ready");
    expect(await installsFor(agent.id)).toHaveLength(0);

    const second = await real(arcana.impl, { now: later(6 * 3_600_000) });
    expect(outcomeOf(second, agent.id)).toMatchObject({ result: "provisioned", plan: "enable_only" });
    expect(await installsFor(agent.id)).toHaveLength(1);
    expect(arcana.calls).toHaveLength(1);
  });
  it("pages with limit/afterId/nextCursor and skips archived companies and corrupted state", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const created = [await legacyAgent(companyId, ownerId), await legacyAgent(companyId, ownerId), await legacyAgent(companyId, ownerId)];
    const arcana = arcanaFetch();

    const first = await real(arcana.impl, { limit: 2, companyId });
    expect(first.scanned).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await real(arcana.impl, { limit: 2, companyId, afterId: first.nextCursor! });
    expect(second.scanned).toBe(1);
    expect(second.nextCursor).toBeNull();
    const handled = [...first.outcomes, ...second.outcomes];
    expect(new Set(handled.map((o) => o.agentId))).toEqual(new Set(created.map((a) => a.id)));
    expect(handled.every((o) => o.result === "provisioned")).toBe(true);

    const archivedCompany = await seedCompany();
    const archivedAgent = await legacyAgent(archivedCompany, null);
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, archivedCompany));
    const corrupted = await legacyAgent(companyId, ownerId);
    await db.update(agents).set({ metadata: { defaultMcp: { version: 2, entries: "nope" } } }).where(eq(agents.id, corrupted.id));
    const report = await real(arcana.impl);
    expect(outcomeOf(report, archivedAgent.id)).toMatchObject({ result: "skipped", reason: "company_archived" });
    expect(outcomeOf(report, corrupted.id)).toMatchObject({ result: "skipped", reason: "corrupted_existing_state" });
  });

  it("refuses an overlapping real run for the same company and releases the lock afterwards", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    await legacyAgent(companyId, await seedOwner(companyId));
    const arcana = arcanaFetch();

    const [one, two] = await Promise.all([real(arcana.impl, { companyId }), real(arcana.impl, { companyId })]);
    const blocked = [one, two].filter((report) => report.blocked === "backfill_in_progress");
    expect(blocked).toHaveLength(1);
    expect([one, two].filter((report) => report.counts.provisioned === 1)).toHaveLength(1);
    expect(arcana.calls).toHaveLength(1);

    const after = await real(arcana.impl, { companyId });
    expect(after.blocked).toBeNull();
  });
  it("the enable step is a compare-and-set: one of two racing workers enables, audits and reports; a broken entry maps to failed", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await legacyAgent(companyId, await seedOwner(companyId));
    const arcana = arcanaFetch();
    await real(arcana.impl);
    // Put the entry back to "provisioned, enable still pending" and drop the install, as an interrupted run leaves it.
    await db.update(agents).set({
      metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries','arcana-brain','backfillEnable']::text[], '"pending"'::jsonb, false)`,
    }).where(eq(agents.id, agent.id));
    await db.delete(toolConnectionInstalls);
    await db.delete(activityLog);
    const entry = await entryOf(agent.id);

    const results = await Promise.all([enableForAgent(db, companyId, agent.id, entry), enableForAgent(db, companyId, agent.id, entry)]);

    expect([...results].sort()).toEqual(["already", "enabled"]);
    expect(await installsFor(agent.id)).toHaveLength(1);
    const audits = (await db.select().from(activityLog)).filter((row) => row.action === "agent.default_mcp.arcana_backfill_enabled");
    expect(audits).toHaveLength(1);
    expect(await enableForAgent(db, companyId, agent.id, { ...entry, connectionId: null })).toBe("failed");
    expect(await enableForAgent(db, companyId, agent.id, { ...entry, templateKey: "someone-else" })).toBe("failed");
  });

  it("pauses between agents that needed an Arcana call", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    for (let i = 0; i < 3; i += 1) await legacyAgent(companyId, ownerId);
    const startedAt = Date.now();
    await real(arcanaFetch().impl, { companyId, delayMs: 60 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110); // two pauses of 60 ms between three agents
  });

  describe("recreate_archived: an entry stuck on an archived dedicated connection", () => {
    /** A provisioned agent whose own dedicated connection was archived and whose setup is stuck (as in production). */
    async function stuckAgent(companyId: string, ownerId: string, state: "pending" | "error" = "pending") {
      const agent = await legacyAgent(companyId, ownerId);
      await real(arcanaFetch().impl, { companyId });
      const entry = await entryOf(agent.id);
      expect(entry.setup.state).toBe("ready");
      await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, entry.connectionId!));
      await db
        .update(agents)
        .set({
          metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries','arcana-brain','setup']::text[], (${agents.metadata} #> ARRAY['defaultMcp','entries','arcana-brain','setup']::text[]) || ${JSON.stringify({ state, reason: state === "pending" ? "binding_failed" : "provision_conflict", attemptCount: 8 })}::jsonb, false)`,
        })
        .where(eq(agents.id, agent.id));
      return { agent, stale: entry };
    }

    it("a census plans recreate_archived and changes nothing; a real run clones a fresh connection and keeps the vault secret", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId);
      const { agent, stale } = await stuckAgent(companyId, ownerId);
      const before = JSON.stringify(await rowOf(agent.id));
      const spy = arcanaFetch();

      const dry = await census({ fetchImpl: spy.impl, companyId });
      expect(outcomeOf(dry, agent.id)).toMatchObject({ result: "would_provision", plan: "recreate_archived" });
      expect(spy.mock).not.toHaveBeenCalled();
      expect(JSON.stringify(await rowOf(agent.id))).toBe(before);

      const secretsBefore = (await arcanaSecrets(companyId)).map((s) => s.id);
      const report = await real(spy.impl, { companyId });

      expect(outcomeOf(report, agent.id)).toMatchObject({ result: "provisioned", plan: "recreate_archived" });
      const entry = await entryOf(agent.id);
      expect(entry.setup.state).toBe("ready");
      expect(entry.connectionId).not.toBe(stale.connectionId);
      expect(entry.binding!.connectionId).toBe(entry.connectionId);
      expect(entry.binding!.grantId).not.toBe(stale.binding!.grantId);
      expect(entry.binding!.secretId).toBe(stale.binding!.secretId);
      expect((await arcanaSecrets(companyId)).map((s) => s.id)).toEqual(secretsBefore); // no second key
      expect(entry).toMatchObject({ enabled: true, backfillEnable: "done" });
      const [fresh] = await db.select().from(toolConnections).where(eq(toolConnections.id, entry.connectionId!));
      expect(fresh!.status).not.toBe("archived");
      expect(fresh!.name).toBe(`rh-arcana-brain:${agent.id}`);
      // The stale profile of the archived connection is renamed (not deleted) so its name no longer blocks the new one.
      const [stalePolicy] = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${stale.connectionId}`));
      expect(stalePolicy!.name).toContain("(archived ");
      expect(await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${entry.connectionId}`))).toHaveLength(1);
      const logged = JSON.stringify(await db.select().from(activityLog));
      expect(logged).toContain("agent.default_mcp.arcana_connection_recreate_requested");
      // Idempotent afterwards.
      const again = await real(arcanaFetch().impl, { companyId });
      expect(outcomeOf(again, agent.id)).toMatchObject({ result: "skipped", reason: "already_provisioned" });
    });

    it("also recovers an entry whose setup ended in error", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId);
      const { agent, stale } = await stuckAgent(companyId, ownerId, "error");
      const report = await real(arcanaFetch().impl, { companyId });
      expect(outcomeOf(report, agent.id)).toMatchObject({ result: "provisioned", plan: "recreate_archived" });
      expect((await entryOf(agent.id)).connectionId).not.toBe(stale.connectionId);
    });

    it("never matches a connection that is not this agent's own archived dedicated one", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId);
      const { agent, stale } = await stuckAgent(companyId, ownerId);
      // Point the entry at the (archived) org template instead of its own connection: it must stay as is.
      await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, template.id));
      await db
        .update(agents)
        .set({ metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries','arcana-brain','connectionId']::text[], to_jsonb(${template.id}::text), false)` })
        .where(eq(agents.id, agent.id));
      const before = JSON.stringify(await rowOf(agent.id));
      const report = await real(arcanaFetch().impl, { companyId });
      expect(outcomeOf(report, agent.id)).toMatchObject({ result: "skipped", reason: "setup_in_progress" });
      expect(JSON.stringify(await rowOf(agent.id))).toBe(before);
      void stale;
    });

    it("leaves a stuck entry on a LIVE connection alone", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId);
      const { agent, stale } = await stuckAgent(companyId, ownerId);
      await db.update(toolConnections).set({ status: "active" }).where(eq(toolConnections.id, stale.connectionId!));
      const live = await real(arcanaFetch().impl, { companyId });
      expect(outcomeOf(live, agent.id)).toMatchObject({ result: "skipped", reason: "setup_in_progress" });
    });

    /** A READY, enabled entry whose own dedicated connection was archived (as in production). */
    async function readyArchived(companyId: string, ownerId: string) {
      const agent = await legacyAgent(companyId, ownerId);
      await real(arcanaFetch().impl, { companyId });
      const entry = await entryOf(agent.id);
      expect(entry).toMatchObject({ enabled: true, backfillEnable: "done" });
      await db.update(toolConnections).set({ status: "archived", enabled: false }).where(eq(toolConnections.id, entry.connectionId!));
      return { agent, stale: entry };
    }

    it("ready + archived own connection: planned, then replaced with a fresh connection that is installed; a rerun does not match again", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId);
      const { agent, stale } = await readyArchived(companyId, ownerId);
      const before = JSON.stringify(await rowOf(agent.id));

      const dry = await census({ companyId });
      expect(outcomeOf(dry, agent.id)).toMatchObject({ result: "would_provision", plan: "recreate_archived" });
      expect(JSON.stringify(await rowOf(agent.id))).toBe(before);

      const spy = arcanaFetch();
      const report = await real(spy.impl, { companyId });
      expect(outcomeOf(report, agent.id)).toMatchObject({ result: "provisioned", plan: "recreate_archived" });
      const entry = await entryOf(agent.id);
      expect(entry.setup.state).toBe("ready");
      expect(entry.connectionId).not.toBe(stale.connectionId);
      expect(entry.binding!.secretId).toBe(stale.binding!.secretId);
      expect(entry).toMatchObject({ enabled: true, backfillEnable: "done" });
      const installs = await installsFor(agent.id);
      expect(installs.some((i) => i.connectionId === entry.connectionId)).toBe(true);
      expect(JSON.stringify(await db.select().from(activityLog))).toContain("arcana_connection_recreate_requested");
      const [oldProfile] = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${stale.connectionId}`));
      expect(oldProfile!.name).toContain("(archived ");

      const again = await real(arcanaFetch().impl, { companyId });
      expect(outcomeOf(again, agent.id)).toMatchObject({ result: "skipped", reason: "already_provisioned" });
    });

    it("ready + live connection is still already_provisioned", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId);
      const agent = await legacyAgent(companyId, ownerId);
      await real(arcanaFetch().impl, { companyId });
      const before = JSON.stringify(await rowOf(agent.id));
      const report = await real(arcanaFetch().impl, { companyId });
      expect(outcomeOf(report, agent.id)).toMatchObject({ result: "skipped", reason: "already_provisioned" });
      expect(JSON.stringify(await rowOf(agent.id))).toBe(before);
    });

    it("ready + archived but another agent's connection or the org template is skipped", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId);
      const a = await readyArchived(companyId, ownerId);
      const b = await readyArchived(companyId, ownerId);
      const point = (agentId: string, connectionId: string) =>
        db.update(agents).set({ metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries','arcana-brain','connectionId']::text[], to_jsonb(${connectionId}::text), false)` }).where(eq(agents.id, agentId));
      await point(a.agent.id, b.stale.connectionId!); // another agent's archived dedicated connection
      await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, template.id));
      await point(b.agent.id, template.id); // the archived org template
      const before = [JSON.stringify(await rowOf(a.agent.id)), JSON.stringify(await rowOf(b.agent.id))];
      const report = await real(arcanaFetch().impl, { companyId });
      expect(outcomeOf(report, a.agent.id)).toMatchObject({ result: "skipped", reason: "already_provisioned" });
      expect(outcomeOf(report, b.agent.id)).toMatchObject({ result: "skipped", reason: "already_provisioned" });
      expect([JSON.stringify(await rowOf(a.agent.id)), JSON.stringify(await rowOf(b.agent.id))]).toEqual(before);
    });
  });
});
