/**
 * TECH-7204 review-finding regressions (protected metadata, gateway OFF gate, owner/claim,
 * frozen template identity, ordinary default permission, atomic dedicated stage, credential-path
 * refresh). Complements default-mcp-spec/-setup/-audit; none of these assertions is relaxed there.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
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
  toolCallEvents,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolGatewaySessions,
  toolInvocations,
  toolMcpGatewayTokens,
  toolMcpGateways,
  toolOauthStates,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { createManagedMcpRunConfig } from "../services/heartbeat.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_SPEC_ENABLED_ENV,
  readDefaultMcpState,
  type DefaultMcpEntrySpec,
} from "../services/default-mcp-spec.js";
import {
  bindDefaultMcpOwnerIfUnset,
  runDefaultMcpSetupForAgent,
  snapshotDefaultMcpForNewAgent,
  waitForScheduledDefaultMcpSetups,
  type DefaultMcpSetupHook,
} from "../services/default-mcp-setup.js";
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
  downstreamFetch,
  clearBootProvisionerSnapshot,
  installBootProvisionerSnapshot,
} from "./helpers/comms-board-downstream.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const URL_LITERAL = "https://8.8.8.8/mcp";
/** A test clock three hours ahead: past every waiting backoff written at creation (a legitimate future time, not a past one). */
const AFTER_BACKOFF = () => new Date(Date.now() + 3 * 3_600_000);

describeEmbeddedPostgres("default MCP review-finding regressions", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmp = path.join(os.tmpdir(), `paperclip-default-mcp-hardening-${randomUUID()}`);
  const envKeys = [DEFAULT_MCP_SPEC_ENABLED_ENV, COMMS_BOARD_MCP_URL_ENV, COMMS_BOARD_ADMIN_TOKEN_ENV, COMMS_BOARD_OWNERSHIP_API_URL_ENV, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV];

  beforeAll(async () => {
    mkdirSync(tmp, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmp, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-hardening");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    // TECH-7271: the boot-frozen rollout scope also bounds per-agent setup; these suites run it for every company.
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
    clearBootProvisionerSnapshot();
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(toolGatewaySessions);
    await db.delete(toolCallEvents);
    await db.delete(toolAccessAuditEvents);
    await db.delete(connectionTokenIssuances);
    await db.delete(toolInvocations);
    await db.delete(toolPolicies);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolOauthStates);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(companySecretBindings);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
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
    rmSync(tmp, { recursive: true, force: true });
  });

  // ---- fixtures ------------------------------------------------------------------------------

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Co-${id.slice(0, 8)}`, issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    return id;
  }

  async function seedOwner(companyId: string, email = "owner@redesignhealth.com") {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  /** An org template: live MCP connection + catalog (optionally a quarantined tool) + optional curated (wizard) profile. */
  async function seedTemplate(
    companyId: string,
    name: string,
    opts: { authKind?: "api_key" | "oauth"; policy?: "shared" | "per_agent" | "per_user"; tools?: string[]; quarantined?: string[]; curated?: boolean } = {},
  ) {
    const application = await db.insert(toolApplications).values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${name} ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" }).returning().then((r) => r[0]!);
    const shared = await secretService(db).create(companyId, { name: `shared ${randomUUID()}`, key: `shared.${randomUUID()}`, provider: "local_encrypted", value: "org-shared-credential" });
    const apiKey = (opts.authKind ?? "api_key") === "api_key";
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId, applicationId: application.id, name, uid: `uid-${randomUUID()}`, transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok",
        authKind: opts.authKind ?? "api_key", credentialPolicy: opts.policy ?? (apiKey ? "shared" : "per_user"),
        config: { url: URL_LITERAL }, transportConfig: { url: URL_LITERAL },
        credentialRefs: apiKey ? [{ name: "credentials.authorization", secretId: shared.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }] : [],
      })
      .returning()
      .then((r) => r[0]!);
    const catalog: Array<typeof toolCatalogEntries.$inferSelect> = [];
    for (const toolName of opts.tools ?? ["do_thing", "do_other"]) {
      const quarantined = opts.quarantined?.includes(toolName);
      const [entry] = await db
        .insert(toolCatalogEntries)
        .values({ companyId, applicationId: application.id, connectionId: connection.id, entryKind: "tool", name: toolName, toolName, title: toolName, riskLevel: "read", isReadOnly: true, status: quarantined ? "quarantined" : "active", versionHash: randomUUID(), schemaHash: randomUUID() })
        .returning();
      catalog.push(entry!);
    }
    let profile: typeof toolProfiles.$inferSelect | null = null;
    if (opts.curated) {
      [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `app:${connection.id}`, name: `${name} access`, defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: connection.id } }).returning();
      for (const entry of catalog.filter((e) => e.status === "active")) {
        await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "catalog_entry", effect: "include", applicationId: application.id, connectionId: connection.id, catalogEntryId: entry.id });
      }
    }
    return { application, connection, catalog, profile };
  }

  /** The "org installs and permits the app for everyone" scenario the OFF contract must hold against. */
  async function companyWideInstallAndAccess(companyId: string, template: Awaited<ReturnType<typeof seedTemplate>>) {
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: template.connection.id, targetType: "company", targetId: companyId });
    let profileId = template.profile?.id;
    if (!profileId) {
      const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `app:${template.connection.id}`, name: `company ${randomUUID().slice(0, 6)}`, defaultAction: "deny" }).returning();
      profileId = profile!.id;
      for (const entry of template.catalog.filter((e) => e.status === "active")) {
        await db.insert(toolProfileEntries).values({ companyId, profileId, selectorType: "catalog_entry", effect: "include", applicationId: template.application.id, connectionId: template.connection.id, catalogEntryId: entry.id });
      }
    }
    await db.insert(toolProfileBindings).values({ companyId, profileId, targetType: "company", targetId: companyId });
  }

  const enableFeature = () => {
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";
  };
  const downstreamEnv = (): NodeJS.ProcessEnv => ({
    [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
    [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
    [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
    [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
  });

  async function createAgent(companyId: string, ownerUserId: string | null, extra: Record<string, unknown> = {}) {
    const created = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null, ...extra },
      ownerUserId ? { claudeLogin: { storedSessionId: null, ownerUserId } } : {},
    );
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  /** An agent created while the feature flag is off: no defaultMcp state (a pre-feature/legacy agent). */
  async function createAgentWithoutFeature(companyId: string, ownerId: string | null) {
    const previous = process.env[DEFAULT_MCP_SPEC_ENABLED_ENV];
    delete process.env[DEFAULT_MCP_SPEC_ENABLED_ENV];
    try {
      return await createAgent(companyId, ownerId);
    } finally {
      if (previous !== undefined) process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = previous;
    }
  }

  const secretKeysOf = async (companyId: string) =>
    (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).map((row) => row.key);

  const rowOf = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then((r) => r[0]!);
  const entryOf = async (id: string, key = "comms-board") => readDefaultMcpState((await rowOf(id)).metadata)!.entries[key]!;

  /** Provision a default-OFF agent against an existing comms template (waiting at create, one explicit pass). */
  async function provisionReady(companyId: string, ownerId: string, name = "Ready Bot") {
    enableFeature();
    const agent = await createAgent(companyId, ownerId, { name });
    await runDefaultMcpSetupForAgent({ db, env: downstreamEnv(), fetchImpl: downstreamFetch(), now: AFTER_BACKOFF }, { companyId, agentId: agent.id });
    return agent;
  }

  async function gatewaySetup(companyId: string, agentId: string) {
    const remote = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }), { status: 200, headers: { "content-type": "application/json" } }));
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "hardening-test-signing-secret",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: remote,
    } as never);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: {} }).returning();
    const session = await gateway.createSession({ companyId, agentId, runId: run!.id });
    return { gateway, session, remote };
  }

  const toolNamesFor = (tools: Array<{ name: string; connectionId?: string | null }>, connectionId: string) =>
    tools.filter((tool) => tool.connectionId === connectionId).map((tool) => tool.name);
  const secretReads = () => db.select().from(secretAccessEvents).then((rows) => rows.length);

  // ---- A: protected metadata, atomic ---------------------------------------------------------

  describe("A. protected metadata is atomic and shape-checked", () => {
    it("create rejects array and primitive metadata (unprocessable) and never stores them", async () => {
      const companyId = await seedCompany();
      for (const bad of [["x"], "text", 7, true]) {
        await expect(createAgent(companyId, null, { metadata: bad })).rejects.toMatchObject({ status: 422 });
      }
      expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    });

    it("update with an array/primitive metadata patch is dropped: protected AND ordinary metadata are unchanged", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      enableFeature();
      const agent = await createAgent(companyId, ownerId, { metadata: { keep: "me" } });
      const before = (await rowOf(agent.id)).metadata;
      for (const bad of [["x"], "text", 7, true]) await agentService(db).update(agent.id, { metadata: bad } as never);
      expect((await rowOf(agent.id)).metadata).toEqual(before);
      await agentService(db).update(agent.id, { name: "Renamed" }); // absent metadata: unchanged
      expect((await rowOf(agent.id)).metadata).toEqual(before);
    });

    it("null clears ordinary keys only; ordinary replacement is replacement (not a merge); the protected key always stays", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      enableFeature();
      const agent = await createAgent(companyId, ownerId, { metadata: { a: 1 } });
      const state = readDefaultMcpState((await rowOf(agent.id)).metadata);
      expect(state).not.toBeNull();

      await agentService(db).update(agent.id, { metadata: { b: 2 } });
      expect((await rowOf(agent.id)).metadata).toEqual({ b: 2, defaultMcp: state });
      await agentService(db).update(agent.id, { metadata: {} });
      expect((await rowOf(agent.id)).metadata).toEqual({ defaultMcp: state });
      await agentService(db).update(agent.id, { metadata: { c: 3 } });
      await agentService(db).update(agent.id, { metadata: null });
      expect((await rowOf(agent.id)).metadata).toEqual({ defaultMcp: state });

      // An agent without protected state: null really clears (metadata becomes null).
      const legacy = await createAgent(companyId, ownerId, { metadata: { z: 1 } });
      delete process.env[DEFAULT_MCP_SPEC_ENABLED_ENV];
      const plain = await createAgent(companyId, ownerId, { metadata: { z: 1 } });
      expect(readDefaultMcpState((await rowOf(plain.id)).metadata)).toBeNull();
      await agentService(db).update(plain.id, { metadata: null });
      expect((await rowOf(plain.id)).metadata).toBeNull();
      expect(legacy.id).toBeTruthy();
    });

    it("snapshot is a path-scoped write: existing ordinary metadata survives creation", async () => {
      const companyId = await seedCompany();
      enableFeature();
      const agent = await createAgent(companyId, null, { metadata: { keep: { nested: true }, note: "x" } });
      const metadata = (await rowOf(agent.id)).metadata as Record<string, unknown>;
      expect(metadata).toMatchObject({ keep: { nested: true }, note: "x" });
      expect(readDefaultMcpState(metadata)).not.toBeNull();
    });

    it("concurrent ordinary updates, an owner bind and a claimed setup never lose the checkpoint, owner or outcome", async () => {
      const companyId = await seedCompany();
      await seedTemplate(companyId, "rh-comms-board");
      enableFeature();
      const agent = await createAgent(companyId, null); // ownerless: pending owner_required
      const approver = await seedOwner(companyId, "approver@redesignhealth.com");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const hook: DefaultMcpSetupHook = async ({ checkpoint }) => {
        await checkpoint({ registerAttemptedAt: "2026-01-01T00:00:00.000Z" }); // a checkpoint under the claim
        entered();
        await gate;
        return { kind: "ready" };
      };
      const run = runDefaultMcpSetupForAgent({ db, hooks: { comms_board_identity: hook }, now: AFTER_BACKOFF }, { companyId, agentId: agent.id });
      await inside;

      await Promise.all([
        bindDefaultMcpOwnerIfUnset(db, agent.id, approver),
        ...[1, 2, 3, 4, 5].map((n) => agentService(db).update(agent.id, { metadata: { n } })),
        ...[1, 2, 3].map((n) => agentService(db).update(agent.id, { title: `t${n}` })),
      ]);
      release();
      await run;

      const entry = await entryOf(agent.id);
      expect(entry.ownerUserId).toBe(approver); // owner bind kept
      expect(entry.setup).toMatchObject({ state: "ready", registerAttemptedAt: "2026-01-01T00:00:00.000Z", claimId: null }); // checkpoint + outcome kept
      expect(entry.templateKey).toBe("rh-comms-board");
      expect(((await rowOf(agent.id)).metadata as { n?: number }).n).toBeGreaterThan(0); // ordinary writes landed
    });

    it("an approval-activation replay applies benign metadata but can never forge owner/binding/checkpoints; invalid shapes are dropped, null clears ordinary only", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const victim = await seedOwner(companyId, "victim@redesignhealth.com");
      enableFeature();
      const agent = await createAgent(companyId, ownerId, { status: "pending_approval", metadata: { before: 1 } });
      const protectedBefore = readDefaultMcpState((await rowOf(agent.id)).metadata);

      const forged = {
        defaultMcp: { version: 1, entries: { "comms-board": { key: "comms-board", ownerUserId: victim, setup: { state: "ready", registerAttemptedAt: "x" }, binding: { secretId: "forged", boardAgentId: "forged" } } } },
        benign: "applied",
      };
      await agentService(db).activatePendingApproval(agent.id, { name: "Approved", metadata: forged });
      const after = await rowOf(agent.id);
      expect(after.name).toBe("Approved");
      expect(after.status).toBe("idle");
      expect((after.metadata as Record<string, unknown>).benign).toBe("applied");
      expect((after.metadata as Record<string, unknown>).before).toBeUndefined(); // replacement semantics
      expect(readDefaultMcpState(after.metadata)).toEqual(protectedBefore);

      for (const [label, payload] of [["array", ["x"]], ["string", "x"], ["number", 3]] as const) {
        const pending = await createAgent(companyId, ownerId, { status: "pending_approval", metadata: { keep: label } });
        const keepBefore = (await rowOf(pending.id)).metadata;
        await agentService(db).activatePendingApproval(pending.id, { metadata: payload });
        expect((await rowOf(pending.id)).metadata).toEqual(keepBefore); // dropped, NOT turned into a clearing null
      }
      const clearing = await createAgent(companyId, ownerId, { status: "pending_approval", metadata: { gone: true } });
      const state = readDefaultMcpState((await rowOf(clearing.id)).metadata);
      await agentService(db).activatePendingApproval(clearing.id, { metadata: null });
      expect((await rowOf(clearing.id)).metadata).toEqual({ defaultMcp: state });
    });
  });

  // ---- B: gateway gate -----------------------------------------------------------------------

  describe("B. gateway enforces the OFF contract before any credential or dispatch", () => {
    it("shared org connection: a company install+permission never lets a default-OFF agent's session list or execute it (0 HTTP, 0 secret reads); a pre-feature agent is unchanged", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: false });
      await companyWideInstallAndAccess(companyId, template);
      const legacy = await createAgent(companyId, ownerId);
      enableFeature();
      const off = await createAgent(companyId, ownerId);

      const legacySession = await gatewaySetup(companyId, legacy.id);
      const legacyTools = await legacySession.gateway.listToolsForSession(legacySession.session.token);
      const sharedNames = toolNamesFor(legacyTools, template.connection.id);
      expect(sharedNames.length).toBeGreaterThan(0); // pre-feature agents keep today's behaviour

      const offSession = await gatewaySetup(companyId, off.id);
      expect(toolNamesFor(await offSession.gateway.listToolsForSession(offSession.session.token), template.connection.id)).toEqual([]);
      const reads = await secretReads();
      await expect(
        offSession.gateway.executeTool({ sessionToken: offSession.session.token, tool: sharedNames[0]!, parameters: {} }),
      ).rejects.toMatchObject({ reasonCode: "installation_required" });
      expect(offSession.remote).not.toHaveBeenCalled();
      expect(await secretReads()).toBe(reads); // no credential was ever resolved

      // The legacy agent is not blocked by the gate: it proceeds past it (and fails later, at the org
      // credential step this fixture does not authorize), which is exactly what it did before.
      const legacyOutcome = await legacySession.gateway
        .executeTool({ sessionToken: legacySession.session.token, tool: sharedNames[0]!, parameters: {} })
        .then(() => "executed", (error: { reasonCode?: string }) => error.reasonCode);
      expect(legacyOutcome).not.toBe("installation_required");
    });

    it("upfront per-agent connection: OFF blocks list/execute/credential (0 HTTP, 0 secret reads); explicit install works; removal blocks the NEXT invocation", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const agent = await provisionReady(companyId, ownerId);
      const entry = await entryOf(agent.id);
      expect(entry.setup.state).toBe("ready");
      const dedicatedId = entry.connectionId!;
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, dedicatedId));

      const { gateway, session, remote } = await gatewaySetup(companyId, agent.id);
      expect(toolNamesFor(await gateway.listToolsForSession(session.token), dedicatedId)).toEqual([]);
      // Learn the descriptor name through an explicitly installed sibling session, then try it while OFF.
      await toolAccessService(db).putConnectionInstalls(dedicatedId, { installs: [{ targetType: "agent", targetId: agent.id }] });
      const onNames = toolNamesFor(await gateway.listToolsForSession(session.token), dedicatedId);
      expect(onNames.length).toBeGreaterThan(0);
      await toolAccessService(db).putConnectionInstalls(dedicatedId, { installs: [] });

      const reads = await secretReads();
      await expect(gateway.executeTool({ sessionToken: session.token, tool: onNames[0]!, parameters: {} })).rejects.toMatchObject({ reasonCode: "installation_required" });
      expect(remote).not.toHaveBeenCalled();
      expect(await secretReads()).toBe(reads);

      // Explicit ON executes; the agent's own secret is the one resolved.
      await toolAccessService(db).putConnectionInstalls(dedicatedId, { installs: [{ targetType: "agent", targetId: agent.id }] });
      await expect(gateway.executeTool({ sessionToken: session.token, tool: onNames[0]!, parameters: {} })).resolves.toBeDefined();
      expect(remote).toHaveBeenCalled();
      const calls = remote.mock.calls.length;
      expect(await secretReads()).toBeGreaterThan(reads);

      // Removing the install blocks the very next invocation of the same session (no revocation of the call already made).
      await toolAccessService(db).putConnectionInstalls(dedicatedId, { installs: [] });
      await expect(gateway.executeTool({ sessionToken: session.token, tool: onNames[0]!, parameters: {} })).rejects.toMatchObject({ reasonCode: "installation_required" });
      expect(remote.mock.calls.length).toBe(calls);
    });
  });

  // ---- C: owner activation + claim token ----------------------------------------------------

  describe("C. owner binding is atomic with approval; claims are token-guarded", () => {
    it("the verified approver (active member) becomes the owner INSIDE activation, before the post-commit schedule; the creation owner is never overridden", async () => {
      const companyId = await seedCompany();
      const creator = await seedOwner(companyId, "creator@redesignhealth.com");
      const approver = await seedOwner(companyId, "approver@redesignhealth.com");
      const outsiderCompany = await seedCompany();
      const outsider = await seedOwner(outsiderCompany, "outsider@redesignhealth.com");
      await seedTemplate(companyId, "rh-comms-board");
      enableFeature();
      installBootProvisionerSnapshot(downstreamEnv());
      const fetchMock = downstreamFetch();
      vi.stubGlobal("fetch", fetchMock);

      const ownerless = await createAgent(companyId, null, { status: "pending_approval" });
      const created = await createAgent(companyId, creator, { status: "pending_approval" });
      const foreign = await createAgent(companyId, null, { status: "pending_approval" });
      const agentActor = await createAgent(companyId, null, { status: "pending_approval" });

      await agentService(db).activatePendingApproval(ownerless.id, undefined, { approverUserId: approver });
      // Bound synchronously with the activation (nothing awaited the schedule yet).
      expect((await entryOf(ownerless.id)).ownerUserId).toBe(approver);
      await agentService(db).activatePendingApproval(created.id, undefined, { approverUserId: approver });
      expect((await entryOf(created.id)).ownerUserId).toBe(creator);
      await agentService(db).activatePendingApproval(foreign.id, undefined, { approverUserId: outsider });
      expect((await entryOf(foreign.id)).ownerUserId).toBeNull();
      await agentService(db).activatePendingApproval(agentActor.id, undefined, { approverUserId: null });
      expect((await entryOf(agentActor.id)).ownerUserId).toBeNull();

      await waitForScheduledDefaultMcpSetups();
      expect((await entryOf(ownerless.id)).setup.state).toBe("ready"); // the FIRST scheduled attempt already had the owner
      expect(fetchMock.calls.register.find((r) => r.ownerEmail === "approver@redesignhealth.com")).toBeTruthy();
      expect((await entryOf(foreign.id)).setup).toMatchObject({ state: "pending", reason: "owner_required" });
      expect((await entryOf(agentActor.id)).setup).toMatchObject({ state: "pending", reason: "owner_required" });
    });

    it("an owner bind while a claim is held loses neither the claim nor the outcome (real ordering, not a pre-bind)", async () => {
      const companyId = await seedCompany();
      await seedTemplate(companyId, "rh-comms-board");
      enableFeature();
      const agent = await createAgent(companyId, null);
      const approver = await seedOwner(companyId, "approver@redesignhealth.com");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const hook: DefaultMcpSetupHook = async () => {
        entered();
        await gate;
        return { kind: "ready" };
      };
      const run = runDefaultMcpSetupForAgent({ db, hooks: { comms_board_identity: hook }, now: AFTER_BACKOFF }, { companyId, agentId: agent.id });
      await inside;
      const claimed = await entryOf(agent.id);
      expect(claimed.setup).toMatchObject({ state: "in_progress", claimId: expect.any(String) });
      await bindDefaultMcpOwnerIfUnset(db, agent.id, approver);
      expect((await entryOf(agent.id)).setup.claimId).toBe(claimed.setup.claimId); // claim untouched by the bind
      release();
      await run;
      expect(await entryOf(agent.id)).toMatchObject({ ownerUserId: approver, setup: { state: "ready", claimId: null } });
    });

    it("a stale claimer loses: the takeover's outcome stands and the old hook's writes and final state are rejected", async () => {
      const companyId = await seedCompany();
      await seedTemplate(companyId, "rh-comms-board");
      enableFeature();
      const agent = await createAgent(companyId, null);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      let staleCheckpointError: unknown = null;
      const slow: DefaultMcpSetupHook = async ({ checkpoint }) => {
        entered();
        await gate;
        try {
          await checkpoint({ mintAttemptedAt: "2026-01-01T00:00:00.000Z" });
        } catch (error) {
          staleCheckpointError = error;
          throw error;
        }
        return { kind: "ready" };
      };
      let clock = Date.now() + 2 * 3_600_000; // past the waiting backoff written at creation
      const first = runDefaultMcpSetupForAgent({ db, hooks: { comms_board_identity: slow }, now: () => new Date(clock) }, { companyId, agentId: agent.id });
      await inside;
      const staleClaim = (await entryOf(agent.id)).setup.claimId;

      // The lease expires; another instance takes over and finishes with an error outcome.
      clock += 11 * 60_000;
      const takeover: DefaultMcpSetupHook = async () => ({ kind: "error", reason: "board_conflict" });
      await runDefaultMcpSetupForAgent({ db, hooks: { comms_board_identity: takeover }, now: () => new Date(clock) }, { companyId, agentId: agent.id });
      expect((await entryOf(agent.id)).setup).toMatchObject({ state: "error", reason: "board_conflict", claimId: null });

      release();
      await first;
      expect(staleCheckpointError).toBeInstanceOf(Error); // ClaimLostError
      const finalSetup = (await entryOf(agent.id)).setup;
      expect(finalSetup).toMatchObject({ state: "error", reason: "board_conflict", mintAttemptedAt: null }); // stale write never landed
      expect(finalSetup.claimId).not.toBe(staleClaim);
    });
  });

  // ---- D: frozen template identity + late resolution ----------------------------------------

  describe("D. frozen template identity", () => {
    it("the snapshot freezes templateKey and dedicated; a later spec edit cannot re-scope an old agent", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      enableFeature();
      const agent = await createAgent(companyId, ownerId);
      expect(await entryOf(agent.id)).toMatchObject({ templateKey: "rh-comms-board", dedicated: true });
      expect(await entryOf(agent.id, "rh-google-mcp")).toMatchObject({ templateKey: "rh-google-mcp", dedicated: false });

      // The template shows up LATER, and the global spec now names it differently: the frozen key still wins.
      await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const renamedSpec: DefaultMcpEntrySpec[] = DEFAULT_MCP_SPEC.map((e) => (e.key === "comms-board" ? { ...e, connectionName: "renamed-board" } : e));
      await runDefaultMcpSetupForAgent({ db, spec: renamedSpec, env: downstreamEnv(), fetchImpl: downstreamFetch(), now: AFTER_BACKOFF }, { companyId, agentId: agent.id });
      const entry = await entryOf(agent.id);
      expect(entry.setup.state).toBe("ready");
      const [dedicated] = await db.select().from(toolConnections).where(eq(toolConnections.id, entry.connectionId!));
      expect(dedicated!.name).toBe(`rh-comms-board:${agent.id}`);
    });

    it("a template created AFTER the agent, then installed + permitted company-wide, still never reaches the OFF agent on any surface; an explicit install does", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const legacy = await createAgent(companyId, ownerId);
      enableFeature();
      const off = await createAgent(companyId, ownerId);
      expect(await entryOf(off.id)).toMatchObject({ templateConnectionId: null, connectionId: null }); // nothing recorded: the template didn't exist

      const template = await seedTemplate(companyId, "rh-comms-board");
      await companyWideInstallAndAccess(companyId, template);
      await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.companyId, companyId));
      const [gwProfile] = await db.insert(toolProfiles).values({ companyId, profileKey: `gw:${randomUUID()}`, name: "gw", defaultAction: "deny" }).returning();
      await db.insert(toolProfileEntries).values({ companyId, profileId: gwProfile!.id, selectorType: "connection", effect: "include", connectionId: template.connection.id });
      await db.insert(toolMcpGateways).values({ companyId, name: "late gw", slug: `gw-${randomUUID().slice(0, 8)}`, profileId: gwProfile!.id, status: "active" });
      const runConfig = (id: string) => createManagedMcpRunConfig({ db, agent: { id, companyId, name: "a", adapterType: "codex_local" }, runId: randomUUID(), config: {}, projectId: null, issueId: null });

      expect((await runConfig(legacy.id))?.gateways ?? []).toHaveLength(1); // legacy agents unchanged
      expect(await runConfig(off.id)).toBeNull();
      const effective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, off.id);
      expect(effective.installedConnections.map((c) => c.id)).not.toContain(template.connection.id);
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: off.id, status: "running", contextSnapshot: {}, responsibleUserId: ownerId }).returning();
      await expect(
        toolAccessService(db).mintConnectionTokenForAgent({ connectionId: template.connection.id, companyId, agentId: off.id, runId: run!.id, body: { scope: "x" } }),
      ).rejects.toMatchObject({ details: { code: "installation_required" } });
      const { gateway, session, remote } = await gatewaySetup(companyId, off.id);
      expect(toolNamesFor(await gateway.listToolsForSession(session.token), template.connection.id)).toEqual([]);
      expect(remote).not.toHaveBeenCalled();

      // The comms entry is DEDICATED: its org template is provisioning-only, so even an explicit install is refused...
      await expect(
        toolAccessService(db).putConnectionInstalls(template.connection.id, { installs: [{ targetType: "company", targetId: companyId }, { targetType: "agent", targetId: off.id }] }),
      ).rejects.toMatchObject({ status: 422, details: { code: "managed_connection_not_installable" } });
      expect(await runConfig(off.id)).toBeNull();
    });

    it("a late-created ORDINARY template (Google) stays OFF under a company install and turns on for exactly the agent with an explicit install", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      enableFeature();
      const off = await createAgent(companyId, ownerId);
      const sibling = await createAgent(companyId, ownerId);
      const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth", policy: "per_user", tools: ["gmail_search"], curated: true });
      await companyWideInstallAndAccess(companyId, google);
      await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.companyId, companyId));
      const [gwProfile] = await db.insert(toolProfiles).values({ companyId, profileKey: `gw:${randomUUID()}`, name: "gw", defaultAction: "deny" }).returning();
      await db.insert(toolProfileEntries).values({ companyId, profileId: gwProfile!.id, selectorType: "connection", effect: "include", connectionId: google.connection.id });
      await db.insert(toolMcpGateways).values({ companyId, name: "google gw", slug: `gw-${randomUUID().slice(0, 8)}`, profileId: gwProfile!.id, status: "active" });
      const runConfig = (id: string) => createManagedMcpRunConfig({ db, agent: { id, companyId, name: "a", adapterType: "codex_local" }, runId: randomUUID(), config: {}, projectId: null, issueId: null });
      expect(await runConfig(off.id)).toBeNull();

      await toolAccessService(db).putConnectionInstalls(google.connection.id, { installs: [{ targetType: "company", targetId: companyId }, { targetType: "agent", targetId: off.id }] });
      expect((await runConfig(off.id))?.gateways ?? []).toHaveLength(1);
      expect(await runConfig(sibling.id)).toBeNull();
      const { gateway, session } = await gatewaySetup(companyId, off.id);
      expect(toolNamesFor(await gateway.listToolsForSession(session.token), google.connection.id).length).toBeGreaterThan(0);
    });
  });

  // ---- E: ordinary default permission --------------------------------------------------------

  describe("E. ordinary entries are offered through the normal install machinery", () => {
    it("an OFF ordinary template with curated access is offered as permitted-not-installed; company tools are not shadowed; no OAuth, no foreign grants", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth", policy: "per_user", tools: ["gmail_search"], curated: true });
      // An existing company app (wizard-managed, company-bound and installed for everyone).
      const other = await seedTemplate(companyId, "rh-other-tools", { tools: ["other_tool"], curated: true });
      await companyWideInstallAndAccess(companyId, other);
      const foreignCompany = await seedCompany();
      await seedTemplate(foreignCompany, "rh-google-mcp", { authKind: "oauth", policy: "per_user", curated: true });
      enableFeature();
      const agent = await createAgent(companyId, ownerId);

      const bindings = await db.select().from(toolProfileBindings).where(and(eq(toolProfileBindings.targetType, "agent"), eq(toolProfileBindings.targetId, agent.id)));
      expect(bindings.filter((b) => (b.metadata as { source?: string }).source === "default_mcp_spec" && b.profileId === google.profile!.id)).toHaveLength(1);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id))).toHaveLength(0); // OFF: no install

      const effective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agent.id);
      expect(effective.entries.some((e) => e.connectionId === google.connection.id && e.effect === "include")).toBe(true); // visible (permitted)
      expect(effective.installedConnections.map((c) => c.id)).not.toContain(google.connection.id); // not installed
      // Existing company tools are not shadowed by the new agent-level offering.
      expect(effective.entries.some((e) => e.connectionId === other.connection.id && e.effect === "include")).toBe(true);
      expect(effective.installedConnections.map((c) => c.id)).toContain(other.connection.id);
      expect(await db.select().from(toolOauthStates)).toHaveLength(0);
      expect(await db.select().from(connectionGrants)).toHaveLength(0);
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, foreignCompany))).toHaveLength(0);
    });

    it("with a general (non-wizard) company-bound profile the OFF offering is STILL written, stays additive, and the company's tools are exactly as before", async () => {
      const companyId = await seedCompany();
      const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth", policy: "per_user", tools: ["gmail_search"], curated: true });
      const general = await seedTemplate(companyId, "rh-general", { tools: ["general_tool"], curated: false });
      await companyWideInstallAndAccess(companyId, general); // a plain (non-wizard) company-bound profile
      const legacy = await createAgent(companyId, null);
      enableFeature();
      const agent = await createAgent(companyId, null);

      const [offering] = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.targetId, agent.id));
      expect(offering).toMatchObject({ targetType: "agent", profileId: google.profile!.id, metadata: { source: "default_mcp_spec", connectionId: google.connection.id } });
      const effective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agent.id);
      const legacyEffective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, legacy.id);
      // Offered (visible/permitted), not installed, and every company tool a pre-feature agent has is still there.
      expect(effective.entries.some((e) => e.connectionId === google.connection.id && e.effect === "include")).toBe(true);
      expect(effective.installedConnections.map((c) => c.id)).not.toContain(google.connection.id);
      for (const entry of legacyEffective.entries) expect(effective.entries.map((e) => e.id)).toContain(entry.id);
      expect(effective.installedConnections.map((c) => c.id)).toContain(general.connection.id);
      expect(effective.allowedToolNames).toEqual(expect.arrayContaining(legacyEffective.allowedToolNames));
      // The runtime gateway keeps listing the general company tool for the agent, and withholds the OFF app.
      const { gateway, session } = await gatewaySetup(companyId, agent.id);
      const tools = await gateway.listToolsForSession(session.token);
      expect(toolNamesFor(tools, general.connection.id).length).toBeGreaterThan(0);
      expect(toolNamesFor(tools, google.connection.id)).toEqual([]);
      // Normal ON adds only that app; OFF again blocks the next invocation.
      await toolAccessService(db).putConnectionInstalls(google.connection.id, { installs: [{ targetType: "agent", targetId: agent.id }] });
      const onTools = await gateway.listToolsForSession(session.token);
      expect(toolNamesFor(onTools, google.connection.id).length).toBeGreaterThan(0);
      expect(toolNamesFor(onTools, general.connection.id).length).toBeGreaterThan(0);
    });

    it("an explicit agent-scope profile is still the operator's policy: it narrows company profiles exactly as before, and the offering does not widen it", async () => {
      const companyId = await seedCompany();
      const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth", policy: "per_user", tools: ["gmail_search"], curated: true });
      const general = await seedTemplate(companyId, "rh-general", { tools: ["general_tool"], curated: false });
      await companyWideInstallAndAccess(companyId, general);
      enableFeature();
      const agent = await createAgent(companyId, null);
      // The operator pins this agent to its own explicit profile (a non-wizard agent-scope binding).
      const [explicit] = await db.insert(toolProfiles).values({ companyId, profileKey: `explicit:${randomUUID()}`, name: "explicit", defaultAction: "deny" }).returning();
      await db.insert(toolProfileBindings).values({ companyId, profileId: explicit!.id, targetType: "agent", targetId: agent.id, metadata: {} });

      const effective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agent.id);
      // Explicit agent policy keeps priority: the company's general profile is narrowed away for this agent (unchanged precedence)...
      expect(effective.entries.some((e) => e.connectionId === general.connection.id)).toBe(false);
      // ...and the server-tagged offering is carried alongside, without granting anything that profile denies.
      expect(effective.entries.some((e) => e.connectionId === google.connection.id)).toBe(true);
    });

    it("a tool policy deny is respected: the default offering never grants past it, before or after install", async () => {
      const companyId = await seedCompany();
      const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth", policy: "per_user", tools: ["gmail_search", "gmail_send"], curated: true });
      enableFeature();
      const agent = await createAgent(companyId, null);
      await toolAccessService(db).putConnectionInstalls(google.connection.id, { installs: [{ targetType: "agent", targetId: agent.id }] });
      const { gateway, session } = await gatewaySetup(companyId, agent.id);
      const before = toolNamesFor(await gateway.listToolsForSession(session.token), google.connection.id);
      expect(before.length).toBe(2);
      const sendTool = before.find((name) => name.includes("gmail-send"))!;
      await db.insert(toolPolicies).values({ companyId, name: "deny send", policyType: "block", selectors: { toolName: sendTool } });
      const after = toolNamesFor(await gateway.listToolsForSession(session.token), google.connection.id);
      expect(after).not.toContain(sendTool);
      expect(after.length).toBe(1);
    });

    it("a caller cannot forge the server-tagged offering: bindProfile strips the reserved source, so the binding keeps ordinary (narrowing) precedence", async () => {
      const companyId = await seedCompany();
      const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth", policy: "per_user", curated: true });
      const general = await seedTemplate(companyId, "rh-general", { tools: ["general_tool"], curated: false });
      await companyWideInstallAndAccess(companyId, general);
      const agent = await createAgent(companyId, null);
      const bound = await toolAccessService(db).bindProfile(google.profile!.id, { targetType: "agent", targetId: agent.id, priority: 100, metadata: { source: "default_mcp_spec", connectionId: google.connection.id, keep: 1 } });
      expect(bound.metadata).toEqual({ connectionId: google.connection.id, keep: 1 });
      const effective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agent.id);
      expect(effective.entries.some((e) => e.connectionId === general.connection.id)).toBe(false); // narrowed like any ordinary agent binding
    });

    it("an ordinary template WITHOUT curated access is not given a permission binding (no profile is invented for OFF)", async () => {
      const companyId = await seedCompany();
      const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth", policy: "per_user", curated: false });
      enableFeature();
      const agent = await createAgent(companyId, null);
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.targetId, agent.id))).toHaveLength(0);
      expect(await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${google.connection.id}`))).toHaveLength(0);
    });

    it("defaultEnabled:true installs through the normal helper with a reviewed-only profile; the normal PUT writes the same binding shape", async () => {
      const companyId = await seedCompany();
      const third = await seedTemplate(companyId, "rh-third-mcp", { tools: ["good_tool", "bad_tool"], quarantined: ["bad_tool"] });
      const agent = await createAgent(companyId, null);
      const spec: DefaultMcpEntrySpec[] = [{ key: "third-mcp", displayName: "Third", connectionName: "rh-third-mcp", authKind: "none", defaultEnabled: true }];
      await db.transaction(async (tx) => {
        await snapshotDefaultMcpForNewAgent(tx as never, { companyId, agentId: agent.id, ownerUserId: null, spec });
      });
      expect(await entryOf(agent.id, "third-mcp")).toMatchObject({ enabled: true, connectionId: third.connection.id, templateKey: "rh-third-mcp" });
      expect((await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id))).map((i) => i.connectionId)).toEqual([third.connection.id]);
      const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${third.connection.id}`));
      expect(profile!.metadata).toMatchObject({ source: "app_gallery_finish" });
      expect(profile!.defaultAction).toBe("deny");
      const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile!.id));
      expect(entries.map((e) => e.catalogEntryId)).toEqual([third.catalog.find((c) => c.toolName === "good_tool")!.id]); // the quarantined tool is never offered
      const [binding] = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.targetId, agent.id));
      // Server-tagged (additive) so a default-ON app never narrows away company-bound profiles.
      expect(binding!.metadata).toEqual({ source: "default_mcp_spec", connectionId: third.connection.id });

      // Normal PUT for another agent: unchanged shape.
      const other = await createAgent(companyId, null);
      await toolAccessService(db).putConnectionInstalls(third.connection.id, { installs: [{ targetType: "agent", targetId: agent.id }, { targetType: "agent", targetId: other.id }] });
      const [putBinding] = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.targetId, other.id));
      expect(putBinding!.metadata).toEqual({ source: "tool_connection_install", connectionId: third.connection.id });
    });

    it("defaultEnabled:true (generic third entry) coexists with a general company-bound profile: installed + permitted, company tools untouched", async () => {
      const companyId = await seedCompany();
      const third = await seedTemplate(companyId, "rh-third-mcp", { tools: ["third_tool"] });
      const general = await seedTemplate(companyId, "rh-general", { tools: ["general_tool"], curated: false });
      await companyWideInstallAndAccess(companyId, general);
      const legacy = await createAgent(companyId, null);
      const agent = await createAgent(companyId, null);
      const spec: DefaultMcpEntrySpec[] = [{ key: "third-mcp", displayName: "Third", connectionName: "rh-third-mcp", authKind: "none", defaultEnabled: true }];
      await db.transaction(async (tx) => {
        await snapshotDefaultMcpForNewAgent(tx as never, { companyId, agentId: agent.id, ownerUserId: null, spec });
      });

      const effective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agent.id);
      const legacyEffective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, legacy.id);
      expect(effective.installedConnections.map((c) => c.id)).toEqual(expect.arrayContaining([third.connection.id, general.connection.id]));
      expect(effective.entries.some((e) => e.connectionId === third.connection.id && e.effect === "include")).toBe(true);
      for (const entry of legacyEffective.entries) expect(effective.entries.map((e) => e.id)).toContain(entry.id); // nothing shadowed
      const { gateway, session } = await gatewaySetup(companyId, agent.id);
      const tools = await gateway.listToolsForSession(session.token);
      expect(toolNamesFor(tools, third.connection.id).length).toBeGreaterThan(0);
      expect(toolNamesFor(tools, general.connection.id).length).toBeGreaterThan(0);
    });
  });

  // ---- 2: dedicated entries never fall back to the shared template or another agent's connection

  describe("2. the org template is provisioning-only for a dedicated entry", () => {
    it("a managed agent can neither install nor use the shared template or another agent's dedicated connection (0 HTTP, 0 secret reads); its own READY connection works only with an explicit install", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const a = await provisionReady(companyId, ownerId, "Agent A");
      const b = await provisionReady(companyId, ownerId, "Agent B");
      const ownA = (await entryOf(a.id)).connectionId!;
      const ownB = (await entryOf(b.id)).connectionId!;
      expect(ownA).not.toBe(ownB);
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.companyId, companyId));
      // The org then installs and permits the shared template for everyone; a pre-feature agent gets it.
      await companyWideInstallAndAccess(companyId, template);
      const legacy = await createAgentWithoutFeature(companyId, ownerId);

      // Backend refuses the installs outright (normal PUT = the checkbox's endpoint).
      const service = toolAccessService(db);
      await expect(service.putConnectionInstalls(template.connection.id, { installs: [{ targetType: "agent", targetId: a.id }] })).rejects.toMatchObject({ status: 422, details: { code: "managed_connection_not_installable" } });
      await expect(service.putConnectionInstalls(ownB, { installs: [{ targetType: "agent", targetId: a.id }] })).rejects.toMatchObject({ status: 422, details: { code: "managed_connection_not_installable" } });
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, a.id))).toHaveLength(0);

      // Defense in depth: even a forced install row (written behind the API) authorizes nothing, on every surface.
      await db.insert(toolConnectionInstalls).values([
        { companyId, connectionId: template.connection.id, targetType: "agent", targetId: a.id },
        { companyId, connectionId: ownB, targetType: "agent", targetId: a.id },
      ]);
      await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, a.id));
      const effective = await service.getEffectiveProfilesForAgent(companyId, a.id);
      expect(effective.installedConnections.map((c) => c.id)).not.toContain(template.connection.id);
      expect(effective.installedConnections.map((c) => c.id)).not.toContain(ownB);
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: a.id, status: "running", contextSnapshot: {}, responsibleUserId: ownerId }).returning();
      for (const connectionId of [template.connection.id, ownB]) {
        await expect(service.mintConnectionTokenForAgent({ connectionId, companyId, agentId: a.id, runId: run!.id, body: { scope: "x" } })).rejects.toMatchObject({ details: { code: "installation_required" } });
      }
      // Learn the tool names via the legitimate sessions, then try them from A's session.
      const legacySession = await gatewaySetup(companyId, legacy.id);
      const templateTools = toolNamesFor(await legacySession.gateway.listToolsForSession(legacySession.session.token), template.connection.id);
      expect(templateTools.length).toBeGreaterThan(0);
      await service.putConnectionInstalls(ownB, { installs: [{ targetType: "agent", targetId: b.id }] });
      const bSession = await gatewaySetup(companyId, b.id);
      const bTools = toolNamesFor(await bSession.gateway.listToolsForSession(bSession.session.token), ownB);
      expect(bTools.length).toBeGreaterThan(0);

      const aSession = await gatewaySetup(companyId, a.id);
      const aListed = await aSession.gateway.listToolsForSession(aSession.session.token);
      expect(toolNamesFor(aListed, template.connection.id)).toEqual([]);
      expect(toolNamesFor(aListed, ownB)).toEqual([]);
      const reads = await secretReads();
      for (const tool of [templateTools[0]!, bTools[0]!]) {
        await expect(aSession.gateway.executeTool({ sessionToken: aSession.session.token, tool, parameters: {} })).rejects.toMatchObject({ reasonCode: "installation_required" });
      }
      expect(aSession.remote).not.toHaveBeenCalled();
      expect(await secretReads()).toBe(reads);

      // Its OWN ready connection works, and only with the explicit install.
      expect(toolNamesFor(await aSession.gateway.listToolsForSession(aSession.session.token), ownA)).toEqual([]);
      await service.putConnectionInstalls(ownA, { installs: [{ targetType: "agent", targetId: a.id }] });
      expect(toolNamesFor(await aSession.gateway.listToolsForSession(aSession.session.token), ownA).length).toBeGreaterThan(0);

      // Pre-feature/legacy agents keep the shared template exactly as before (installable, unchanged).
      await service.putConnectionInstalls(template.connection.id, { installs: [{ targetType: "agent", targetId: legacy.id }] });
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, legacy.id))).toHaveLength(1);
    });

    it("before the agent's own connection is READY the template is already refused (pending entry), and an ordinary entry (Google) is not restricted", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth", policy: "per_user", tools: ["gmail_search"], curated: true });
      enableFeature();
      const agent = await createAgent(companyId, ownerId); // downstream unconfigured: pending
      expect((await entryOf(agent.id)).setup.state).toBe("pending");
      expect((await entryOf(agent.id)).connectionId).toBeNull();

      await expect(toolAccessService(db).putConnectionInstalls(template.connection.id, { installs: [{ targetType: "agent", targetId: agent.id }] })).rejects.toMatchObject({ status: 422 });
      await toolAccessService(db).putConnectionInstalls(google.connection.id, { installs: [{ targetType: "agent", targetId: agent.id }] }); // ordinary OAuth entry: normal toggle
      expect((await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agent.id))).map((i) => i.connectionId)).toEqual([google.connection.id]);
      expect(await db.select().from(toolOauthStates)).toHaveLength(0); // a toggle is not consent
      expect(await db.select().from(connectionGrants)).toHaveLength(0);
    });
  });

  // ---- 3: metadata update semantics

  describe("3. update ignores (never 422s) an invalid metadata shape and writes nothing else unsafely", () => {
    it("applies the valid fields of the same patch, leaves ordinary and protected metadata untouched", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      enableFeature();
      const agent = await createAgent(companyId, ownerId, { metadata: { keep: 1 } });
      const before = (await rowOf(agent.id)).metadata;
      const updated = await agentService(db).update(agent.id, { name: "Valid Rename", title: "T", metadata: ["bad"] } as never); // resolves: ignored, not thrown
      expect(updated?.name).toBe("Valid Rename");
      const row = await rowOf(agent.id);
      expect(row.title).toBe("T");
      expect(row.metadata).toEqual(before);
    });
  });

});
