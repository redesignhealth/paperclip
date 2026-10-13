import { createHash, randomUUID, createHmac } from "node:crypto";
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
import { DEFAULT_MCP_SPEC, readDefaultMcpState } from "../services/default-mcp-spec.js";
import { toolAccessService } from "../services/tool-access.js";
import { runDefaultMcpSetupForAgent, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import {
  ARCANA_PROVISION_KEY_ENV,
  ARCANA_URL_ENV,
  composeArcanaBrainIdentity,
  sha256Hex,
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

describeEmbeddedPostgres("default MCP arcana_brain hook (TECH-7252)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-arcana-brain-hook-${randomUUID()}`);
  const configuredEnv: NodeJS.ProcessEnv = { [ARCANA_URL_ENV]: ARCANA_URL, [ARCANA_PROVISION_KEY_ENV]: PROVISION_KEY };

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("arcana-brain-hook");
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

  /** Creates the agent as the routes do, with the feature on and Arcana NOT configured in the live env. */
  async function createAgent(companyId: string, ownerUserId: string | null) {
    process.env[FEATURE_ENV] = "true";
    const created = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  const run = (companyId: string, agentId: string, fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = configuredEnv, now = later()) =>
    runDefaultMcpSetupForAgent({ db, env, fetchImpl, spec: [ARCANA_ENTRY], now }, { companyId, agentId });
  const entryOf = async (agentId: string) => {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return readDefaultMcpState(row!.metadata)!.entries["arcana-brain"]!;
  };
  const arcanaSecrets = async (companyId: string) =>
    (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).filter((s) => s.key.startsWith("arcana_brain."));
  const grantsFor = (agentId: string) => db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agentId));
  const plaintextOf = (companyId: string, secretId: string) => secretService(db).resolveSecretValue(companyId, secretId, "latest");
  const everythingStored = async () =>
    JSON.stringify([
      await db.select().from(agents),
      await db.select().from(activityLog),
      await db.select().from(connectionGrants),
      await db.select().from(toolConnections),
      await db.select().from(companySecretVersions),
      await db.select().from(companySecretBindings),
    ]);

  it("provisions the brain, stores the key first, and sends only its hash", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, ownerId);
    const arcana = arcanaFetch();

    await run(companyId, agent.id, arcana.impl);

    const entry = await entryOf(agent.id);
    expect(entry.setup.state).toBe("ready");
    const credentialRef = (await grantsFor(agent.id))[0]!.credentialSecretRefs[0]!;
    expect(JSON.stringify(credentialRef)).toContain("Arcana brain exchange key");
    const identity = composeArcanaBrainIdentity(companyId, agent.id)!;
    expect(identity.agentPrincipalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(identity.runtimeId).not.toBe(identity.agentPrincipalId);
    expect(entry.binding?.baseSub).toBe(identity.agentPrincipalId);

    const secrets = await arcanaSecrets(companyId);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.key).toBe(`arcana_brain.${agent.id}`);
    const plaintext = await plaintextOf(companyId, secrets[0]!.id);
    expect(plaintext.length).toBeGreaterThanOrEqual(48);

    expect(arcana.calls).toHaveLength(1);
    const call = arcana.calls[0]!;
    expect(call.url).toBe(`${ARCANA_URL}/api/v1/brain/provision`);
    expect(call.method).toBe("POST");
    expect(Object.keys(call.body).sort()).toEqual(["agent_principal_id", "company_id", "exchange_key_hash", "runtime_id"]);
    expect(call.body.exchange_key_hash).toMatch(/^[0-9a-f]{64}$/);
    const bearer = call.headers.authorization!;
    expect(bearer).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(bearer).not.toContain(PROVISION_KEY);
    const [h, c, sig] = bearer.slice("Bearer ".length).split(".");
    expect(createHmac("sha256", PROVISION_KEY).update(`${h}.${c}`).digest("base64url")).toBe(sig);
    expect(call.body).toEqual({
      agent_principal_id: identity.agentPrincipalId,
      company_id: companyId,
      runtime_id: identity.runtimeId,
      exchange_key_hash: createHash("sha256").update(plaintext).digest("hex"),
    });
    expect(call.bodyText).not.toContain(plaintext);
    expect(await everythingStored()).not.toContain(plaintext);
    expect(await everythingStored()).not.toContain(PROVISION_KEY);

    const grants = await grantsFor(agent.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.credentialSecretRefs.map((ref) => ref.secretId)).toEqual([secrets[0]!.id]);
    const dedicated = await db.select().from(toolConnections).where(eq(toolConnections.id, entry.connectionId!));
    expect(dedicated[0]!.name).toBe(`${ARCANA_ENTRY.connectionName}:${agent.id}`);
  });

  it("default ON: a new agent that reaches ready has its OWN dedicated connection installed and usable (no other connection)", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, await seedOwner(companyId));
    const arcana = arcanaFetch();

    await run(companyId, agent.id, arcana.impl);

    const entry = await entryOf(agent.id);
    expect(entry.setup.state).toBe("ready");
    expect(entry.enabled).toBe(true);
    const service = toolAccessService(db);
    const effective = await service.getEffectiveProfilesForAgent(companyId, agent.id);
    expect(effective.installedConnections.map((c) => c.id)).toEqual([entry.connectionId]);
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id));
    expect(installs.map((i) => i.connectionId)).toEqual([entry.connectionId]);
    const tools = (await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, entry.connectionId!))).map((t) => t.toolName);
    expect(tools).toEqual(["arcana_recall"]);

    // A replay changes nothing.
    await run(companyId, agent.id, arcana.impl, configuredEnv, later(4 * 3_600_000));
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id))).toHaveLength(1);
  });

  it("default ON: a failed provision installs nothing, and an owner's later uninstall is never undone", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const failed = await createAgent(companyId, await seedOwner(companyId));
    await run(companyId, failed.id, arcanaFetch(["conflict"]).impl);
    expect((await entryOf(failed.id)).setup.state).toBe("error");
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, failed.id))).toHaveLength(0);

    const agent = await createAgent(companyId, await seedOwner(companyId));
    const arcana = arcanaFetch();
    await run(companyId, agent.id, arcana.impl);
    const entry = await entryOf(agent.id);
    expect(entry.enabled).toBe(true);
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id));
    // A wiring-drift repair re-runs the stage; the consumed marker means the owner's removal stands.
    await db.delete(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id));
    await run(companyId, agent.id, arcana.impl, configuredEnv, later(4 * 3_600_000));
    expect((await entryOf(agent.id)).setup.state).toBe("ready");
    expect((await entryOf(agent.id)).installOnReady).toBe(false);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id))).toHaveLength(0);
    // The install is recorded exactly once.
    const installedEvents = (await db.select().from(activityLog)).filter((row) => row.action === "agent.default_mcp.dedicated_installed" && row.entityId === agent.id);
    expect(installedEvents).toHaveLength(1);
  });

  it("without the new-agent flag (backfill / legacy enrollment) nothing is installed implicitly", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, await seedOwner(companyId));
    // Reset to the shape a snapshot without the flag produces.
    await db
      .update(agents)
      .set({ metadata: sql`jsonb_set(${agents.metadata}, '{defaultMcp,entries,arcana-brain}', (${agents.metadata} #> '{defaultMcp,entries,arcana-brain}') - 'installOnReady', false)` })
      .where(eq(agents.id, agent.id));
    await run(companyId, agent.id, arcanaFetch().impl);
    const entry = await entryOf(agent.id);
    expect(entry.setup.state).toBe("ready");
    expect(entry.enabled).toBe(false);
    expect(entry.installOnReady).toBeUndefined();
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id))).toHaveLength(0);
  });

  it("a second run of a ready entry creates nothing and calls nothing", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, await seedOwner(companyId));
    const arcana = arcanaFetch();
    await run(companyId, agent.id, arcana.impl);
    await run(companyId, agent.id, arcana.impl, configuredEnv, later(4 * 3_600_000));

    expect(arcana.calls).toHaveLength(1);
    expect(await arcanaSecrets(companyId)).toHaveLength(1);
    expect(await grantsFor(agent.id)).toHaveLength(1);
  });

  it("an unknown outcome is retried with the same hash and never duplicates the key", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, await seedOwner(companyId));
    const arcana = arcanaFetch(["network", "server"]);

    await run(companyId, agent.id, arcana.impl, configuredEnv, later(1 * 3_600_000));
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "provisioner_failed" });
    await run(companyId, agent.id, arcana.impl, configuredEnv, later(2 * 3_600_000));
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "provisioner_failed" });
    await run(companyId, agent.id, arcana.impl, configuredEnv, later(3 * 3_600_000));

    expect((await entryOf(agent.id)).setup.state).toBe("ready");
    expect(arcana.calls).toHaveLength(3);
    expect(new Set(arcana.calls.map((c) => c.body.exchange_key_hash)).size).toBe(1);
    expect(await arcanaSecrets(companyId)).toHaveLength(1);
    expect(await grantsFor(agent.id)).toHaveLength(1);
  });

  it("reuses a stored-but-uncheckpointed key instead of creating a second secret", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, await seedOwner(companyId));
    const orphan = await secretService(db).create(companyId, {
      name: "orphan",
      key: `arcana_brain.${agent.id}`,
      provider: "local_encrypted",
      value: "k".repeat(48),
    });
    const arcana = arcanaFetch();

    await run(companyId, agent.id, arcana.impl);

    expect(await arcanaSecrets(companyId)).toHaveLength(1);
    expect((await entryOf(agent.id)).binding?.secretId).toBe(orphan.id);
    expect(arcana.calls[0]!.body.exchange_key_hash).toBe(sha256Hex("k".repeat(48)));
  });

  it("a 409 from Arcana is a terminal provision_conflict that keeps the key and binds nothing", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, await seedOwner(companyId));
    const arcana = arcanaFetch(["conflict"]);

    await run(companyId, agent.id, arcana.impl);
    await run(companyId, agent.id, arcana.impl, configuredEnv, later(4 * 3_600_000));

    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "error", reason: "provision_conflict" });
    expect(arcana.calls).toHaveLength(1);
    expect(await grantsFor(agent.id)).toHaveLength(0);
  });

  it("an auth failure is a terminal provision_rejected", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, await seedOwner(companyId));
    await run(companyId, agent.id, arcanaFetch(["unauthorized"]).impl);
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "error", reason: "provision_rejected" });
  });

  it("waits, with no secret and no call, when Arcana is not configured or the template is missing", async () => {
    const companyId = await seedCompany();
    const agent = await createAgent(companyId, await seedOwner(companyId));
    const arcana = arcanaFetch();

    await run(companyId, agent.id, arcana.impl, {});
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "provisioner_not_configured" });
    await run(companyId, agent.id, arcana.impl, configuredEnv, later(4 * 3_600_000));
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "template_not_found" });

    expect(arcana.mock).not.toHaveBeenCalled();
    expect(await arcanaSecrets(companyId)).toHaveLength(0);
  });

  it("two agents get different principals, keys and grants, and never share a secret", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedTemplate(companyId);
    const a = await createAgent(companyId, ownerId);
    const b = await createAgent(companyId, ownerId);
    const arcana = arcanaFetch();

    await run(companyId, a.id, arcana.impl);
    await run(companyId, b.id, arcana.impl);

    expect(arcana.calls).toHaveLength(2);
    expect(new Set(arcana.calls.map((c) => c.body.agent_principal_id)).size).toBe(2);
    expect(new Set(arcana.calls.map((c) => c.body.runtime_id)).size).toBe(2);
    expect(new Set(arcana.calls.map((c) => c.body.exchange_key_hash)).size).toBe(2);
    const [entryA, entryB] = [await entryOf(a.id), await entryOf(b.id)];
    expect(entryA.binding?.secretId).not.toBe(entryB.binding?.secretId);
    expect(entryA.connectionId).not.toBe(entryB.connectionId);
    const [grantA, grantB] = [await grantsFor(a.id), await grantsFor(b.id)];
    expect(grantA).toHaveLength(1);
    expect(grantB).toHaveLength(1);
    expect(grantA[0]!.credentialSecretRefs[0]!.secretId).toBe(entryA.binding?.secretId);
    expect(grantB[0]!.credentialSecretRefs[0]!.secretId).toBe(entryB.binding?.secretId);
    expect(grantA[0]!.connectionId).toBe(entryA.connectionId);
    expect(grantB[0]!.connectionId).toBe(entryB.connectionId);
  });

  it("a deleted vault secret ends in secret_unavailable and is never recreated", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, await seedOwner(companyId));
    await run(companyId, agent.id, arcanaFetch(["network"]).impl, configuredEnv, later(1 * 3_600_000));
    const [secret] = await arcanaSecrets(companyId);
    await db.update(companySecrets).set({ status: "deleted", deletedAt: new Date() }).where(eq(companySecrets.id, secret!.id));
    const arcana = arcanaFetch();

    await run(companyId, agent.id, arcana.impl, configuredEnv, later(3 * 3_600_000));

    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "error", reason: "secret_unavailable" });
    expect(arcana.mock).not.toHaveBeenCalled();
    expect(await arcanaSecrets(companyId)).toHaveLength(1);
  });

  it("a soft-deleted or revoked secret for the key is never revived or replaced, even before any binding exists", async () => {
    for (const patch of [{ status: "deleted", deletedAt: new Date() }, { status: "disabled" }] as const) {
      const companyId = await seedCompany();
      await seedTemplate(companyId);
      const agent = await createAgent(companyId, await seedOwner(companyId));
      const dead = await secretService(db).create(companyId, {
        name: "dead",
        key: `arcana_brain.${agent.id}`,
        provider: "local_encrypted",
        value: "d".repeat(48),
      });
      await db.update(companySecrets).set(patch).where(eq(companySecrets.id, dead.id));
      const arcana = arcanaFetch();

      await run(companyId, agent.id, arcana.impl);

      expect((await entryOf(agent.id)).setup).toMatchObject({ state: "error", reason: "secret_unavailable" });
      expect(arcana.mock).not.toHaveBeenCalled();
      const rows = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
      expect(rows.filter((row) => row.key.startsWith("arcana_brain."))).toHaveLength(1);
      expect(rows.find((row) => row.id === dead.id)!.status).toBe(patch.status);
    }
  });

  it("an invalid Arcana URL waits as provisioner_config_invalid with no secret and no call", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const agent = await createAgent(companyId, await seedOwner(companyId));
    const arcana = arcanaFetch();
    for (const url of ["http://arcana.example.test", "https://user:pw@arcana.example.test", "not a url", "https://a.test/?token=1"]) {
      await run(companyId, agent.id, arcana.impl, { [ARCANA_URL_ENV]: url, [ARCANA_PROVISION_KEY_ENV]: PROVISION_KEY }, later(4 * 3_600_000));
      expect((await entryOf(agent.id)).setup).toMatchObject({ reason: "provisioner_config_invalid" });
    }
    expect(arcana.mock).not.toHaveBeenCalled();
    expect(await arcanaSecrets(companyId)).toHaveLength(0);
  });

  it("with the feature flag off, creating an agent snapshots nothing and calls nothing", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    delete process.env[FEATURE_ENV];
    const arcana = arcanaFetch();
    vi.stubGlobal("fetch", arcana.impl);
    try {
      const created = await agentService(db).create(
        companyId,
        { name: "Flag off", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
        { claudeLogin: { storedSessionId: null, ownerUserId: await seedOwner(companyId) } },
      );
      await waitForScheduledDefaultMcpSetups();
      expect(readDefaultMcpState(created.metadata)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(arcana.mock).not.toHaveBeenCalled();
    expect(await arcanaSecrets(companyId)).toHaveLength(0);
  });

  // ---- TECH-7253: default ON

  it("default ON: a brand-new agent in an unconfigured deployment gets a pending entry and nothing broken (no connection, grant, secret or call)", async () => {
    const companyId = await seedCompany();
    await seedTemplate(companyId);
    const arcana = arcanaFetch();
    vi.stubGlobal("fetch", arcana.impl);
    try {
      const created = await createAgent(companyId, await seedOwner(companyId));
      const entry = await entryOf(created.id);
      expect(ARCANA_ENTRY.defaultEnabled).toBe(true);
      expect(entry).toMatchObject({ dedicated: true, enabled: false, connectionId: null, binding: null });
      expect(entry.setup.state).toBe("pending");
      expect(await grantsFor(created.id)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(arcana.mock).not.toHaveBeenCalled();
    expect(await arcanaSecrets(companyId)).toHaveLength(0);
  });

  it("default ON: a company-wide connection or install can never widen an agent's tools or point it at another agent's brain", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const template = await seedTemplate(companyId);
    const a = await createAgent(companyId, ownerId);
    const b = await createAgent(companyId, ownerId);
    const arcana = arcanaFetch();
    await run(companyId, a.id, arcana.impl);
    await run(companyId, b.id, arcana.impl);
    const [entryA, entryB] = [await entryOf(a.id), await entryOf(b.id)];
    expect(entryA.setup.state).toBe("ready");
    expect(entryB.setup.state).toBe("ready");
    const ownA = entryA.connectionId!;
    const ownB = entryB.connectionId!;
    expect(ownA).not.toBe(ownB);
    expect(ownA).not.toBe(template.id);

    // Each agent's own connection is a snapshot of the template's tools at provisioning time (the real template is the
    // static five-verb catalog: see default-mcp-static-template.test.ts).
    const activeToolsOf = async (connectionId: string) =>
      (await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)))
        .filter((row) => row.status === "active")
        .map((row) => row.toolName)
        .sort();
    const toolsA = await activeToolsOf(ownA);
    const toolsB = await activeToolsOf(ownB);
    expect(toolsA).toEqual(["arcana_recall"]);
    expect(toolsB).toEqual(["arcana_recall"]);

    // The org then adds a wider tool to the shared template and installs it company-wide: the agents' own
    // connections do not change, and the org template / the other agent's connection stay uninstallable.
    await db.insert(toolCatalogEntries).values({ companyId, applicationId: template.applicationId, connectionId: template.id, name: "arcana_admin", toolName: "arcana_admin", versionHash: "v1" });
    const service = toolAccessService(db);
    for (const connectionId of [template.id, ownB]) {
      await expect(service.putConnectionInstalls(connectionId, { installs: [{ targetType: "agent", targetId: a.id }] })).rejects.toMatchObject({
        status: 422,
        details: { code: "managed_connection_not_installable" },
      });
    }
    // Defense in depth: forced install rows written behind the API authorize nothing.
    await db.insert(toolConnectionInstalls).values([
      { companyId, connectionId: template.id, targetType: "company", targetId: companyId },
      { companyId, connectionId: template.id, targetType: "agent", targetId: a.id },
      { companyId, connectionId: ownB, targetType: "agent", targetId: a.id },
    ]);
    const effective = await service.getEffectiveProfilesForAgent(companyId, a.id);
    const installedIds = effective.installedConnections.map((c) => c.id);
    expect(installedIds).not.toContain(template.id);
    expect(installedIds).not.toContain(ownB);
    expect(await activeToolsOf(ownA)).toEqual(toolsA);
    expect(await activeToolsOf(ownB)).toEqual(toolsB);
    expect(await activeToolsOf(ownA)).not.toContain("arcana_admin");

    // Grants and credentials stay per agent: A's grant names only A's connection and A's own key.
    const [grantA, grantB] = [await grantsFor(a.id), await grantsFor(b.id)];
    expect(grantA.map((g) => g.connectionId)).toEqual([ownA]);
    expect(grantB.map((g) => g.connectionId)).toEqual([ownB]);
    expect(grantA[0]!.credentialSecretRefs[0]!.secretId).toBe(entryA.binding?.secretId);
    expect(entryA.binding?.secretId).not.toBe(entryB.binding?.secretId);
  });
});
