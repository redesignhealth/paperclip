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
import { credentialRefConfigPath, toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import * as bindingSync from "../services/connection-credential-bindings.js";
import { agentInstallsRefused, loadAgentDefaultMcpState, managedInstallCheck } from "../services/default-mcp-install-gate.js";
import {
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_SPEC_ENABLED_ENV,
  readDefaultMcpState,
  type DefaultMcpEntrySpec,
  type DefaultMcpEntryState,
} from "../services/default-mcp-spec.js";
import {
  bindDefaultMcpOwnerIfUnset,
  resolveCommsBoardBinding,
  runDefaultMcpSetupForAgent,
  snapshotDefaultMcpForNewAgent,
  sweepDefaultMcpSetups,
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
  BOARD_TOKEN,
  BOARD_URL,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  SECRETS,
  downstreamFetch,
  ownershipResponse,
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
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of envKeys) delete process.env[key];
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
      for (const [k, v] of Object.entries(downstreamEnv())) process.env[k] = v!;
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

  // ---- F: atomic dedicated stage -------------------------------------------------------------

  describe("F. the dedicated stage is one local transaction", () => {
    it("a failure between writes rolls everything back (no READY, no connection/catalog/profile/grant); the retry completes once without duplicates", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: true, tools: ["a_tool", "b_tool"] });
      enableFeature();
      const agent = await createAgent(companyId, ownerId);
      const fetchMock = downstreamFetch();
      const spy = vi.spyOn(bindingSync, "syncConnectionCredentialBindings").mockRejectedValueOnce(new Error("injected failure"));

      await runDefaultMcpSetupForAgent({ db, env: downstreamEnv(), fetchImpl: fetchMock, now: AFTER_BACKOFF }, { companyId, agentId: agent.id });
      expect(spy).toHaveBeenCalled();
      const failed = await entryOf(agent.id);
      expect(failed.setup).toMatchObject({ state: "pending", reason: "binding_failed" });
      expect(failed.connectionId).toBeNull(); // the checkpoint rolled back with the stage
      expect(failed.binding?.secretId).toBeTruthy(); // the externally created secret is kept
      const name = `rh-comms-board:${agent.id}`;
      expect(await db.select().from(toolConnections).where(eq(toolConnections.name, name))).toHaveLength(0);
      expect(await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id))).toHaveLength(0);
      expect(await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId)).then((r) => r.filter((p) => p.profileKey !== `app:${template.connection.id}`))).toHaveLength(0);
      expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, companyId)).then((r) => r.filter((c) => c.connectionId !== template.connection.id))).toHaveLength(0);
      expect(await readDefaultMcpState((await rowOf(agent.id)).metadata)!.entries["comms-board"]!.setup.state).not.toBe("ready");

      await runDefaultMcpSetupForAgent({ db, env: downstreamEnv(), fetchImpl: fetchMock, now: () => new Date(Date.now() + 5 * 3_600_000) }, { companyId, agentId: agent.id });
      const ready = await entryOf(agent.id);
      expect(ready.setup.state).toBe("ready");
      expect(fetchMock.calls.register).toHaveLength(1); // no second register/mint during the retry
      expect(fetchMock.calls.mint).toHaveLength(1);
      const dedicated = await db.select().from(toolConnections).where(eq(toolConnections.name, name));
      expect(dedicated).toHaveLength(1);
      expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, dedicated[0]!.id))).toHaveLength(2);
      expect(await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id))).toHaveLength(1);
      expect(ready.connectionId).toBe(dedicated[0]!.id);
      // The org template is unchanged.
      expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, template.connection.id))).toHaveLength(2);
    });

    it("a partially copied dedicated connection (some catalog rows, empty profile, no grant) is completed idempotently; quarantine status is copied, never widened", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: true, tools: ["keep_tool", "held_tool"], quarantined: ["held_tool"] });
      enableFeature();
      const agent = await createAgent(companyId, ownerId);
      // Simulate the aftermath of an older, non-atomic partial run.
      const [partial] = await db.insert(toolConnections).values({
        companyId, applicationId: template.application.id, name: `rh-comms-board:${agent.id}`, uid: `partial-${randomUUID()}`, transport: "mcp_remote", authKind: "api_key", credentialPolicy: "per_agent", status: "active", enabled: true,
        config: { url: URL_LITERAL }, transportConfig: { url: URL_LITERAL },
        credentialRefs: [{ name: "credentials.authorization", secretId: template.connection.credentialRefs[0]!.secretId, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }],
      }).returning();
      const keep = template.catalog.find((c) => c.toolName === "keep_tool")!;
      const { id: _id, ...keepRest } = keep;
      await db.insert(toolCatalogEntries).values({ ...keepRest, connectionId: partial!.id });
      await db.insert(toolProfiles).values({ companyId, profileKey: `app:${partial!.id}`, name: "partial", defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: partial!.id } });

      // Four parallel passes (lease takeover / duplicate events) still produce one connection.
      await Promise.all([1, 2, 3, 4].map(() => runDefaultMcpSetupForAgent({ db, env: downstreamEnv(), fetchImpl: downstreamFetch(), now: AFTER_BACKOFF }, { companyId, agentId: agent.id })));

      const entry = await entryOf(agent.id);
      expect(entry.setup.state).toBe("ready");
      expect(entry.connectionId).toBe(partial!.id);
      expect(await db.select().from(toolConnections).where(eq(toolConnections.name, `rh-comms-board:${agent.id}`))).toHaveLength(1);
      const cloned = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, partial!.id));
      expect(cloned.map((c) => [c.toolName, c.status]).sort()).toEqual([["held_tool", "quarantined"], ["keep_tool", "active"]]);
      const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${partial!.id}`));
      const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile!.id));
      expect(entries.map((e) => e.catalogEntryId)).toEqual([cloned.find((c) => c.toolName === "keep_tool")!.id]); // exactly the template's include, once
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, profile!.id))).toHaveLength(1);
      expect(await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id))).toHaveLength(1);
    });
  });

  // ---- G: credential path refresh + validated reference --------------------------------------

  describe("G. credential-path refresh and the validated binding reference", () => {
    async function ready(companyId: string, ownerId: string, name = "Refresh Bot") {
      await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const agent = await provisionReady(companyId, ownerId, name);
      return { agent, entry: await entryOf(agent.id) };
    }

    it("a normal connection update that renames the per-agent header path moves the grant ref and the single binding in the same transaction (0 downstream POSTs)", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const { agent, entry } = await ready(companyId, ownerId);
      const dedicated = await db.select().from(toolConnections).where(eq(toolConnections.id, entry.connectionId!)).then((r) => r[0]!);
      const header = dedicated.credentialRefs.find((r) => r.placement === "header")!;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await toolAccessService(db).updateConnection(dedicated.id, { credentialRefs: [{ ...header, name: "credentials.x-api-key", key: "X-Api-Key", prefix: null }] }, companyId);

      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id));
      expect(grant!.credentialSecretRefs).toEqual([expect.objectContaining({ secretId: entry.binding!.secretId, configPath: "credentials.x-api-key" })]);
      const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, dedicated.id));
      expect(bindings.map((b) => [b.secretId, b.configPath])).toEqual([[entry.binding!.secretId, "credentials.x-api-key"]]); // old path gone, no duplicate
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await secretService(db).resolveSecretValue(companyId, entry.binding!.secretId!, "latest")).toBe(BOARD_TOKEN); // vault secret retained
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).toMatchObject({ secretId: entry.binding!.secretId, connectionId: dedicated.id });
    });

    it("an ambiguous mapping (several header refs) on a managed connection is rejected and changes nothing; unmanaged connections are never reconciled", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const { agent, entry } = await ready(companyId, ownerId);
      const dedicated = await db.select().from(toolConnections).where(eq(toolConnections.id, entry.connectionId!)).then((r) => r[0]!);
      const header = dedicated.credentialRefs.find((r) => r.placement === "header")!;
      await expect(
        toolAccessService(db).updateConnection(dedicated.id, { credentialRefs: [{ ...header, name: "credentials.one" }, { ...header, name: "credentials.two", key: "X-Two" }] }, companyId),
      ).rejects.toMatchObject({ status: 422 });
      expect((await db.select().from(toolConnections).where(eq(toolConnections.id, dedicated.id)).then((r) => r[0]!)).credentialRefs).toEqual(dedicated.credentialRefs);
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).not.toBeNull();

      // An unmanaged legacy per-agent connection keeps its grant refs exactly as they are.
      const legacy = await seedTemplate(companyId, "legacy-per-agent", { policy: "per_agent" });
      const legacyAgent = await agentService(db).create(companyId, { name: "L", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null });
      const [legacyGrant] = await db.insert(connectionGrants).values({ companyId, connectionId: legacy.connection.id, kind: "agent", subjectAgentId: legacyAgent.id, credentialSecretRefs: [{ secretId: legacy.connection.credentialRefs[0]!.secretId, configPath: "credentials.authorization", versionSelector: "latest" }], status: "active" }).returning();
      const legacyHeader = legacy.connection.credentialRefs[0]!;
      await toolAccessService(db).updateConnection(legacy.connection.id, { credentialRefs: [{ ...legacyHeader, name: "credentials.renamed" }] }, companyId);
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, legacyGrant!.id)).then((r) => r[0]!)).credentialSecretRefs).toEqual(legacyGrant!.credentialSecretRefs);
    });

    it("resolveCommsBoardBinding fails closed on every drift and never exports the token or crosses tenants", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const otherCompany = await seedCompany();
      const { agent, entry } = await ready(companyId, ownerId);

      const binding = await resolveCommsBoardBinding(db, companyId, agent.id);
      expect(binding).toMatchObject({ baseSub: expect.stringContaining(agent.id), connectionId: entry.connectionId, grantId: entry.binding!.grantId });
      for (const secret of SECRETS) expect(JSON.stringify(binding)).not.toContain(secret);
      expect(await resolveCommsBoardBinding(db, otherCompany, agent.id)).toBeNull(); // wrong tenant
      expect(await resolveCommsBoardBinding(db, companyId, randomUUID())).toBeNull();
      expect(await resolveCommsBoardBinding(db, companyId, agent.id, new Date(Date.now() + 400 * 86_400_000))).toBeNull(); // token expired

      const grantRow = () => db.select().from(connectionGrants).where(eq(connectionGrants.id, entry.binding!.grantId!)).then((r) => r[0]!);
      const original = await grantRow();
      await db.update(connectionGrants).set({ credentialSecretRefs: original.credentialSecretRefs.map((r) => ({ ...r, configPath: "credentials.stale" })) }).where(eq(connectionGrants.id, original.id));
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).toBeNull(); // path mismatch
      await db.update(connectionGrants).set({ credentialSecretRefs: original.credentialSecretRefs, status: "revoked" }).where(eq(connectionGrants.id, original.id));
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).toBeNull(); // grant not active
      await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, original.id));
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).not.toBeNull(); // restored => valid again
      await db.update(connectionGrants).set({ credentialSecretRefs: [{ ...original.credentialSecretRefs[0]!, secretId: randomUUID() }] }).where(eq(connectionGrants.id, original.id));
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).toBeNull(); // secret mismatch

      // Not ready (metadata alone is never authoritative).
      const waiting = await createAgent(companyId, ownerId);
      expect(await resolveCommsBoardBinding(db, companyId, waiting.id)).toBeNull();
    });
  });

  // ---- Argus R1: S3 deleted secret, S5 malformed rows -------------------------------------------

  describe("S3. a deleted or disabled vault secret is never READY and never re-minted", () => {
    it("soft-deleting the agent's secret makes the reference NULL, drifts the entry to a terminal error with no POST and no recreation, and the gateway cannot read it", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const agent = await provisionReady(companyId, ownerId, "Revoked Bot");
      const entry = await entryOf(agent.id);
      const secretId = entry.binding!.secretId!;
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).not.toBeNull();
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, entry.connectionId!));
      await toolAccessService(db).putConnectionInstalls(entry.connectionId!, { installs: [{ targetType: "agent", targetId: agent.id }] });
      const { gateway, session, remote } = await gatewaySetup(companyId, agent.id);
      const toolName = toolNamesFor(await gateway.listToolsForSession(session.token), entry.connectionId!)[0]!;

      await secretService(db).remove(secretId); // the existing soft-delete (status=deleted, deletedAt set)

      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).toBeNull();
      // The gateway cannot read the revoked secret: the call fails and nothing goes out.
      await expect(gateway.executeTool({ sessionToken: session.token, tool: toolName, parameters: {} })).rejects.toBeDefined();
      expect(remote).not.toHaveBeenCalled();

      // A setup pass detects the drift; it is terminal (intentionally revoked), with no register/mint/recreate.
      const fetchMock = downstreamFetch();
      await runDefaultMcpSetupForAgent({ db, env: downstreamEnv(), fetchImpl: fetchMock, now: AFTER_BACKOFF }, { companyId, agentId: agent.id });
      expect((await entryOf(agent.id)).setup).toMatchObject({ state: "error", reason: "secret_unavailable" });
      expect(fetchMock).not.toHaveBeenCalled();
      const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
      expect(secrets.filter((row) => row.key.startsWith("comms_board.") && row.status === "active")).toHaveLength(0);
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).toBeNull();
      // A later pass never retries automatically.
      await runDefaultMcpSetupForAgent({ db, env: downstreamEnv(), fetchImpl: fetchMock, now: () => new Date(Date.now() + 48 * 3_600_000) }, { companyId, agentId: agent.id });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a disabled (non-active) secret status is also not ready", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const agent = await provisionReady(companyId, ownerId, "Disabled Bot");
      const secretId = (await entryOf(agent.id)).binding!.secretId!;
      await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, secretId));
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).toBeNull();
      await db.update(companySecrets).set({ status: "active" }).where(eq(companySecrets.id, secretId));
      expect(await resolveCommsBoardBinding(db, companyId, agent.id)).not.toBeNull();
    });
  });

  describe("S5. one malformed row can never take the whole sweep down", () => {
    const insertAgent = (companyId: string, metadata: unknown) =>
      db.insert(agents).values({ companyId, name: `A ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, metadata: metadata as never }).returning().then((r) => r[0]!);
    const setup = (over: Record<string, unknown> = {}) => ({ state: "pending", reason: null, attemptCount: 0, nextAttemptAt: null, leaseUntil: null, claimId: null, registerAttemptedAt: null, mintAttemptedAt: null, updatedAt: new Date().toISOString(), ...over });
    const entry = (over: Record<string, unknown> = {}) => ({ key: "comms-board", templateKey: "rh-comms-board", dedicated: true, enabled: false, templateConnectionId: null, connectionId: null, ownerUserId: null, binding: null, setup: setup(), ...over });

    it("scalar/array/null/ill-typed defaultMcp values and entries, and garbage timestamps, are skipped or ignored while valid pending agents are processed", async () => {
      const companyId = await seedCompany();
      enableFeature();
      const malformed = [
        { defaultMcp: "scalar" },
        { defaultMcp: [1, 2] },
        { defaultMcp: null },
        { defaultMcp: { version: 1, entries: "nope" } },
        { defaultMcp: { version: 1, entries: [1, 2] } },
        { defaultMcp: { version: 1, entries: { "comms-board": 5 } } },
        { defaultMcp: { version: 1, entries: { "comms-board": null } } },
        { defaultMcp: { version: 1, entries: { "comms-board": { key: "comms-board", setup: "x" } } } },
        { defaultMcp: { version: 1, entries: { "comms-board": entry({ setup: setup({ nextAttemptAt: "garbage", attemptCount: "abc", leaseUntil: 5 }) }) } } },
        ["array-metadata"],
        "scalar-metadata",
        null,
      ];
      const bad = [];
      for (const metadata of malformed) bad.push(await insertAgent(companyId, metadata));
      const badMetadataBefore = await db.select({ id: agents.id, metadata: agents.metadata }).from(agents).where(eq(agents.companyId, companyId));
      const valid = await insertAgent(companyId, { defaultMcp: { version: 1, entries: { "comms-board": entry() } } });
      const nullStamp = await insertAgent(companyId, { defaultMcp: { version: 1, entries: { "comms-board": entry({ setup: setup({ nextAttemptAt: null, attemptCount: "abc" }) }) } } });

      const calls: string[] = [];
      const hook: DefaultMcpSetupHook = async ({ agentId }) => {
        calls.push(agentId);
        return { kind: "waiting", reason: "provisioner_not_configured" };
      };
      const processed = await sweepDefaultMcpSetups({ db, hooks: { comms_board_identity: hook }, now: AFTER_BACKOFF });

      expect(processed).toBeGreaterThanOrEqual(2);
      expect(calls).toEqual(expect.arrayContaining([valid.id, nullStamp.id]));
      for (const row of bad.filter((_, i) => i !== 8)) expect(calls).not.toContain(row.id); // malformed entries are never handed to a hook
      // Malformed rows were left exactly as they were (no write, no crash).
      const after = await db.select({ id: agents.id, metadata: agents.metadata }).from(agents).where(eq(agents.companyId, companyId));
      for (const before of badMetadataBefore) {
        if (before.id === bad[8]!.id) continue; // the object entry with garbage values may legitimately be claimed or skipped
        expect(after.find((row) => row.id === before.id)!.metadata).toEqual(before.metadata);
      }
      // The garbage-timestamp entry is handled without throwing (claimed or ignored), and a stored non-numeric attemptCount counts from zero.
      expect((await entryOf(nullStamp.id)).setup.attemptCount).toBe(1);
    });

    it("the connection-update lookup of managed agents ignores malformed metadata too", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const agent = await provisionReady(companyId, ownerId, "Update Bot");
      for (const metadata of [{ defaultMcp: "scalar" }, { defaultMcp: { version: 1, entries: [1] } }, { defaultMcp: { version: 1, entries: { x: { connectionId: "x", dedicated: "not-a-bool" } } } }]) {
        await insertAgent(companyId, metadata);
      }
      const entry2 = await entryOf(agent.id);
      const dedicated = await db.select().from(toolConnections).where(eq(toolConnections.id, entry2.connectionId!)).then((r) => r[0]!);
      const header = dedicated.credentialRefs.find((r) => r.placement === "header")!;
      await toolAccessService(db).updateConnection(dedicated.id, { credentialRefs: [{ ...header, name: "credentials.renamed" }] }, companyId);
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id));
      expect(grant!.credentialSecretRefs[0]!.configPath).toBe("credentials.renamed"); // the managed agent was still found and reconciled
    });
  });

  // ---- Argus R2 ----------------------------------------------------------------------------------

  describe("R2-S3. a missing/foreign agent row or a corrupted protected key fails closed at the gateway", () => {
    it("an agent id that is no longer in the session's company is NOT treated as a legacy agent: 404 agent_not_found, 0 HTTP, 0 secret reads", async () => {
      const companyId = await seedCompany();
      const otherCompany = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: false });
      await companyWideInstallAndAccess(companyId, template);
      const legacy = await createAgent(companyId, ownerId); // a legacy agent: would normally pass the gate
      const sibling = await createAgent(companyId, ownerId);
      const probe = await gatewaySetup(companyId, sibling.id);
      const toolName = toolNamesFor(await probe.gateway.listToolsForSession(probe.session.token), template.connection.id)[0]!;

      const { gateway, session, remote } = await gatewaySetup(companyId, legacy.id);
      await db.update(agents).set({ companyId: otherCompany }).where(eq(agents.id, legacy.id)); // the session now names a foreign agent row
      const reads = await secretReads();
      await expect(gateway.executeTool({ sessionToken: session.token, tool: toolName, parameters: {} })).rejects.toMatchObject({ status: 404, reasonCode: "agent_not_found" });
      expect(remote).not.toHaveBeenCalled();
      expect(await secretReads()).toBe(reads);
    });

    it("a corrupted protected key blocks every connection (403 installation_required); an agent without the key, with unrelated metadata, is unchanged", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: false });
      await companyWideInstallAndAccess(companyId, template);
      const probe = await createAgent(companyId, ownerId);
      const probeSession = await gatewaySetup(companyId, probe.id);
      const toolName = toolNamesFor(await probeSession.gateway.listToolsForSession(probeSession.session.token), template.connection.id)[0]!;

      const corrupted = await createAgent(companyId, ownerId);
      const withUnrelated = await createAgent(companyId, ownerId, { metadata: { team: "ops", defaultMcpNote: "not the reserved key" } });
      await db.update(agents).set({ metadata: { defaultMcp: "corrupted" } }).where(eq(agents.id, corrupted.id));

      const bad = await gatewaySetup(companyId, corrupted.id);
      const reads = await secretReads();
      expect(toolNamesFor(await bad.gateway.listToolsForSession(bad.session.token), template.connection.id)).toEqual([]);
      await expect(bad.gateway.executeTool({ sessionToken: bad.session.token, tool: toolName, parameters: {} })).rejects.toMatchObject({ reasonCode: "installation_required" });
      expect(bad.remote).not.toHaveBeenCalled();
      expect(await secretReads()).toBe(reads);

      const ok = await gatewaySetup(companyId, withUnrelated.id);
      expect(toolNamesFor(await ok.gateway.listToolsForSession(ok.session.token), template.connection.id).length).toBeGreaterThan(0);
      const outcome = await ok.gateway.executeTool({ sessionToken: ok.session.token, tool: toolName, parameters: {} }).then(() => "executed", (e: { reasonCode?: string }) => e.reasonCode);
      expect(outcome).not.toBe("installation_required");
    });

    it("corrupt legacy agent key fails closed across heartbeat projection, effective profiles and token mint; unrelated metadata and defaultMcp:null retain legacy behavior", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: false });
      await companyWideInstallAndAccess(companyId, template);

      const [gwProfile] = await db.insert(toolProfiles).values({ companyId, profileKey: `gw:${randomUUID()}`, name: "gw", defaultAction: "deny" }).returning();
      await db.insert(toolProfileEntries).values({ companyId, profileId: gwProfile!.id, selectorType: "connection", effect: "include", connectionId: template.connection.id });
      await db.insert(toolMcpGateways).values({ companyId, name: "test gw", slug: `gw-${randomUUID().slice(0, 8)}`, profileId: gwProfile!.id, status: "active" });

      const corrupted = await createAgent(companyId, ownerId);
      await db.update(agents).set({ metadata: { defaultMcp: "corrupted" }, adapterType: "codex_local" }).where(eq(agents.id, corrupted.id));

      const withUnrelated = await createAgent(companyId, ownerId, { metadata: { team: "ops" }, adapterType: "codex_local" });
      const withNull = await createAgent(companyId, ownerId, { metadata: { defaultMcp: null }, adapterType: "codex_local" });

      const runConfig = (id: string) => createManagedMcpRunConfig({ db, agent: { id, companyId, name: "a", adapterType: "codex_local" }, runId: randomUUID(), config: {}, projectId: null, issueId: null });

      // Corrupted agent: createManagedMcpRunConfig null, effective installed excludes, mint reject 403 installation_required
      expect(await runConfig(corrupted.id)).toBeNull();
      const effectiveCorrupted = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, corrupted.id);
      expect(effectiveCorrupted.installedConnections.map((c) => c.id)).not.toContain(template.connection.id);
      const [runCorrupted] = await db.insert(heartbeatRuns).values({ companyId, agentId: corrupted.id, status: "running", contextSnapshot: {}, responsibleUserId: ownerId }).returning();
      await expect(
        toolAccessService(db).mintConnectionTokenForAgent({ connectionId: template.connection.id, companyId, agentId: corrupted.id, runId: runCorrupted!.id, body: { scope: "x" } }),
      ).rejects.toMatchObject({ status: 403, details: { code: "installation_required" } });

      // Unrelated metadata control: retains prior gateway count 1 / installed behavior
      expect((await runConfig(withUnrelated.id))?.gateways ?? []).toHaveLength(1);
      const effectiveUnrelated = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, withUnrelated.id);
      expect(effectiveUnrelated.installedConnections.map((c) => c.id)).toContain(template.connection.id);
      const [runUnrelated] = await db.insert(heartbeatRuns).values({ companyId, agentId: withUnrelated.id, status: "running", contextSnapshot: {}, responsibleUserId: ownerId }).returning();
      const outcomeUnrelated = await toolAccessService(db)
        .mintConnectionTokenForAgent({ connectionId: template.connection.id, companyId, agentId: withUnrelated.id, runId: runUnrelated!.id, body: { scope: "x" } })
        .then(() => "minted", (e: { details?: { code?: string } }) => e.details?.code);
      expect(outcomeUnrelated).not.toBe("installation_required");

      // defaultMcp: null legacy control: retains prior gateway count 1 / installed behavior
      expect((await runConfig(withNull.id))?.gateways ?? []).toHaveLength(1);
      const effectiveNull = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, withNull.id);
      expect(effectiveNull.installedConnections.map((c) => c.id)).toContain(template.connection.id);
      const [runNull] = await db.insert(heartbeatRuns).values({ companyId, agentId: withNull.id, status: "running", contextSnapshot: {}, responsibleUserId: ownerId }).returning();
      const outcomeNull = await toolAccessService(db)
        .mintConnectionTokenForAgent({ connectionId: template.connection.id, companyId, agentId: withNull.id, runId: runNull!.id, body: { scope: "x" } })
        .then(() => "minted", (e: { details?: { code?: string } }) => e.details?.code);
      expect(outcomeNull).not.toBe("installation_required");
    });

    it("foreign or missing agent row causes runconfig to be null and search_tools to return 404 agent_not_found", async () => {
      const companyId = await seedCompany();
      const otherCompany = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: false, tools: ["comms_post"] });
      await db.update(toolConnections).set({ config: { url: URL_LITERAL, onDemandTools: true }, transportConfig: { url: URL_LITERAL, onDemandTools: true }, healthStatus: "ok" }).where(eq(toolConnections.companyId, companyId));
      await companyWideInstallAndAccess(companyId, template);

      const agent = await createAgent(companyId, ownerId, { adapterType: "codex_local" });

      // Missing agent: runconfig is null
      const missingId = randomUUID();
      const missingRunConfig = await createManagedMcpRunConfig({ db, agent: { id: missingId, companyId, name: "missing", adapterType: "codex_local" }, runId: randomUUID(), config: {}, projectId: null, issueId: null });
      expect(missingRunConfig).toBeNull();

      // Foreign agent: runconfig is null and search_tools returns 404 agent_not_found
      const foreignAgent = await createAgent(companyId, ownerId, { adapterType: "codex_local" });
      const { gateway: gwForeign, session: sessForeign } = await gatewaySetup(companyId, foreignAgent.id);
      await db.update(agents).set({ companyId: otherCompany }).where(eq(agents.id, foreignAgent.id));

      const foreignRunConfig = await createManagedMcpRunConfig({ db, agent: { id: foreignAgent.id, companyId, name: "foreign", adapterType: "codex_local" }, runId: randomUUID(), config: {}, projectId: null, issueId: null });
      expect(foreignRunConfig).toBeNull();

      await expect(
        gwForeign.executeTool({ sessionToken: sessForeign.token, tool: "search_tools", parameters: { query: "" } }),
      ).rejects.toMatchObject({ status: 404, reasonCode: "agent_not_found" });
    });

    it("direct loadAgentDefaultMcpState, agentInstallsRefused and managedInstallCheck verify missing, legacy, malformed, and valid states", async () => {
      const companyId = await seedCompany();
      const otherCompany = await seedCompany();
      const ownerId = await seedOwner(companyId);

      const connA = { id: randomUUID(), companyId, name: "rh-comms-board" };
      const connB = { id: randomUUID(), companyId, name: "other-tool" };
      const conns = [connA, connB];

      // 1. Missing / foreign agent
      const missingId = randomUUID();
      const loadedMissing = await loadAgentDefaultMcpState(db, companyId, missingId);
      expect(loadedMissing).toEqual({ found: false, state: null, malformed: false });
      expect(agentInstallsRefused(loadedMissing)).toBe(true);
      const checkMissing = await managedInstallCheck(db, { companyId, agentId: missingId, connections: conns });
      expect(checkMissing.agentFound).toBe(false);
      expect(checkMissing.blocked).toEqual(new Set([connA.id, connB.id]));

      const foreignAgent = await createAgent(otherCompany, null);
      const loadedForeign = await loadAgentDefaultMcpState(db, companyId, foreignAgent.id);
      expect(loadedForeign).toEqual({ found: false, state: null, malformed: false });
      expect(agentInstallsRefused(loadedForeign)).toBe(true);
      const checkForeign = await managedInstallCheck(db, { companyId, agentId: foreignAgent.id, connections: conns });
      expect(checkForeign.agentFound).toBe(false);
      expect(checkForeign.blocked).toEqual(new Set([connA.id, connB.id]));

      // 2. Legacy states: metadata null, {}, and { defaultMcp: null } (not malformed, not blocked)
      const agentNullMeta = await createAgent(companyId, ownerId);
      await db.update(agents).set({ metadata: null }).where(eq(agents.id, agentNullMeta.id));
      const loadedNullMeta = await loadAgentDefaultMcpState(db, companyId, agentNullMeta.id);
      expect(loadedNullMeta).toEqual({ found: true, state: null, malformed: false });
      expect(agentInstallsRefused(loadedNullMeta)).toBe(false);
      const checkNullMeta = await managedInstallCheck(db, { companyId, agentId: agentNullMeta.id, connections: conns });
      expect(checkNullMeta.agentFound).toBe(true);
      expect(checkNullMeta.blocked).toEqual(new Set());

      const agentEmptyMeta = await createAgent(companyId, ownerId);
      await db.update(agents).set({ metadata: {} }).where(eq(agents.id, agentEmptyMeta.id));
      const loadedEmptyMeta = await loadAgentDefaultMcpState(db, companyId, agentEmptyMeta.id);
      expect(loadedEmptyMeta).toEqual({ found: true, state: null, malformed: false });
      expect(agentInstallsRefused(loadedEmptyMeta)).toBe(false);
      const checkEmptyMeta = await managedInstallCheck(db, { companyId, agentId: agentEmptyMeta.id, connections: conns });
      expect(checkEmptyMeta.agentFound).toBe(true);
      expect(checkEmptyMeta.blocked).toEqual(new Set());

      const agentNullKey = await createAgent(companyId, ownerId);
      await db.update(agents).set({ metadata: { defaultMcp: null } }).where(eq(agents.id, agentNullKey.id));
      const loadedNullKey = await loadAgentDefaultMcpState(db, companyId, agentNullKey.id);
      expect(loadedNullKey).toEqual({ found: true, state: null, malformed: false });
      expect(agentInstallsRefused(loadedNullKey)).toBe(false);
      const checkNullKey = await managedInstallCheck(db, { companyId, agentId: agentNullKey.id, connections: conns });
      expect(checkNullKey.agentFound).toBe(true);
      expect(checkNullKey.blocked).toEqual(new Set());

      // 3. Malformed state: defaultMcp: 'x' (malformed, all blocked)
      const agentMalformed = await createAgent(companyId, ownerId);
      await db.update(agents).set({ metadata: { defaultMcp: "x" } }).where(eq(agents.id, agentMalformed.id));
      const loadedMalformed = await loadAgentDefaultMcpState(db, companyId, agentMalformed.id);
      expect(loadedMalformed).toEqual({ found: true, state: null, malformed: true });
      expect(agentInstallsRefused(loadedMalformed)).toBe(true);
      const checkMalformed = await managedInstallCheck(db, { companyId, agentId: agentMalformed.id, connections: conns });
      expect(checkMalformed.agentFound).toBe(true);
      expect(checkMalformed.blocked).toEqual(new Set([connA.id, connB.id]));

      // 4. Valid state: own connection uninstalled blocked, explicit installed not blocked, forbidden template blocked even installed
      const dedicatedTemplate = await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const readyAgent = await provisionReady(companyId, ownerId, "Ready Tester");
      const ownConnId = (await entryOf(readyAgent.id)).connectionId!;
      const ownConn = { id: ownConnId, companyId, name: "rh-comms-board:ready-tester" };
      const templateConn = { id: dedicatedTemplate.connection.id, companyId, name: "rh-comms-board" };

      // Own connection initially uninstalled -> blocked
      const checkUninstalled = await managedInstallCheck(db, { companyId, agentId: readyAgent.id, connections: [ownConn, templateConn] });
      expect(checkUninstalled.blocked.has(ownConn.id)).toBe(true);
      expect(checkUninstalled.blocked.has(templateConn.id)).toBe(true); // dedicated template is forbidden

      // Explicit install on own connection -> own connection not blocked, forbidden template still blocked
      await toolAccessService(db).putConnectionInstalls(ownConn.id, { installs: [{ targetType: "agent", targetId: readyAgent.id }] });
      const checkInstalled = await managedInstallCheck(db, { companyId, agentId: readyAgent.id, connections: [ownConn, templateConn] });
      expect(checkInstalled.blocked.has(ownConn.id)).toBe(false);
      expect(checkInstalled.blocked.has(templateConn.id)).toBe(true);

      // Even if an install row existed for forbidden template, it remains blocked
      await db.insert(toolConnectionInstalls).values({ companyId, connectionId: templateConn.id, targetType: "agent", targetId: readyAgent.id });
      const checkForbiddenInstalled = await managedInstallCheck(db, { companyId, agentId: readyAgent.id, connections: [templateConn] });
      expect(checkForbiddenInstalled.blocked.has(templateConn.id)).toBe(true);
    });

    it("executeTestCall early refuses managed connection without an explicit install (403 installation_required)", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: true, tools: ["send_note"] });
      const readyAgent = await provisionReady(companyId, ownerId, "TestCall Bot");
      const ownConnId = (await entryOf(readyAgent.id)).connectionId!;

      const gateway = createToolGatewayService(db);

      // Uninstalled managed connection: early rejected with 403 installation_required
      await expect(
        gateway.executeTestCall({
          companyId,
          connectionId: ownConnId,
          agentId: readyAgent.id,
          userId: ownerId,
          toolName: "send_note",
          parameters: { text: "hello" },
        }),
      ).rejects.toMatchObject({ status: 403, reasonCode: "installation_required" });

      // After explicit install: passes the early managed check
      await toolAccessService(db).putConnectionInstalls(ownConnId, { installs: [{ targetType: "agent", targetId: readyAgent.id }] });
      const outcome = await gateway.executeTestCall({
        companyId,
        connectionId: ownConnId,
        agentId: readyAgent.id,
        userId: ownerId,
        toolName: "send_note",
        parameters: { text: "hello" },
      }).then(() => "ok", (err: { reasonCode?: string }) => err.reasonCode);
      expect(outcome).not.toBe("installation_required");
    });
  });

  describe("R2-S1. on-demand search never reveals a managed OFF or foreign connection", () => {
    it("search_tools lists names/schemas only for what the agent may use: OFF none, ON its own connection only; legacy baseline unchanged", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: true, tools: ["comms_post", "comms_read"] });
      const a = await provisionReady(companyId, ownerId, "Agent A");
      const b = await provisionReady(companyId, ownerId, "Agent B");
      const ownA = (await entryOf(a.id)).connectionId!;
      const ownB = (await entryOf(b.id)).connectionId!;
      // Every comms connection loads its tools on demand (search_tools / run_tool).
      await db.update(toolConnections).set({ config: { url: URL_LITERAL, onDemandTools: true }, transportConfig: { url: URL_LITERAL, onDemandTools: true }, healthStatus: "ok" }).where(eq(toolConnections.companyId, companyId));
      await companyWideInstallAndAccess(companyId, template);
      const legacy = await createAgent(companyId, ownerId);
      // The legacy agent was created after the flag was enabled by provisionReady; make it a true legacy agent.
      await db.update(agents).set({ metadata: null }).where(eq(agents.id, legacy.id));

      const search = async (agentId: string) => {
        const { gateway, session } = await gatewaySetup(companyId, agentId);
        const result = await gateway.executeTool({ sessionToken: session.token, tool: "search_tools", parameters: { query: "" } });
        const content = (result as { result: { content: string } }).result.content;
        return (JSON.parse(content) as { tools: Array<{ connectionId: string; name: string; parametersSchema?: unknown }> }).tools;
      };
      const ids = (tools: Array<{ connectionId: string }>) => [...new Set(tools.map((t) => t.connectionId))];

      expect(ids(await search(legacy.id))).toEqual([template.connection.id]); // baseline: the shared template, as before
      expect(await search(a.id)).toEqual([]); // OFF: no names, no schemas, nothing from the template, own or foreign connections
      await toolAccessService(db).putConnectionInstalls(ownA, { installs: [{ targetType: "agent", targetId: a.id }] });
      const onA = await search(a.id);
      expect(ids(onA)).toEqual([ownA]); // its OWN connection only
      expect(JSON.stringify(onA)).not.toContain(ownB);
      expect(JSON.stringify(onA)).not.toContain(template.connection.id);
    });
  });

  describe("R2-S2. install guards are transactional and ownership comes from the protected binding", () => {
    it("a managed dedicated connection can be added only for the agent its binding names: not the company, not another agent; the owner works; lookalike names stay ordinary", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const a = await provisionReady(companyId, ownerId, "Agent A");
      const b = await provisionReady(companyId, ownerId, "Agent B");
      const ownA = (await entryOf(a.id)).connectionId!;
      const service = toolAccessService(db);
      const refused = { status: 422, details: { code: "managed_connection_not_installable" } };

      await expect(service.putConnectionInstalls(ownA, { installs: [{ targetType: "company", targetId: companyId }] })).rejects.toMatchObject(refused);
      await expect(service.putConnectionInstalls(ownA, { installs: [{ targetType: "agent", targetId: b.id }] })).rejects.toMatchObject(refused);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, ownA))).toHaveLength(0);
      await service.putConnectionInstalls(ownA, { installs: [{ targetType: "agent", targetId: a.id }] });
      expect((await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, ownA))).map((i) => i.targetId)).toEqual([a.id]);

      // A display name that merely looks like a dedicated connection is not ownership proof either way:
      // an ordinary connection with such a name stays installable for a legacy agent.
      const legacy = await createAgent(companyId, ownerId);
      await db.update(agents).set({ metadata: null }).where(eq(agents.id, legacy.id));
      const lookalike = await seedTemplate(companyId, "rh-comms-board:lookalike-not-an-agent", { curated: false });
      await service.putConnectionInstalls(lookalike.connection.id, { installs: [{ targetType: "agent", targetId: legacy.id }] });
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, lookalike.connection.id))).toHaveLength(1);
    });

    it("install guard reads target state inside transaction / refuses dedicated template", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const template = await seedTemplate(companyId, "rh-comms-board", { curated: true });
      enableFeature();
      const agent = await createAgent(companyId, ownerId); // dedicated entry: the template is forbidden
      await expect(
        toolAccessService(db).putConnectionInstalls(template.connection.id, { installs: [{ targetType: "agent", targetId: agent.id }] }),
      ).rejects.toMatchObject({ status: 422 });
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, template.connection.id))).toHaveLength(0);
    });

    it("a legacy per-agent row cannot use a private token without its own agent grant (0 HTTP, agent_authorization_required)", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      const legacyConn = await seedTemplate(companyId, "legacy-per-agent", { policy: "per_agent", curated: true });
      const legacy = await createAgent(companyId, ownerId);
      await toolAccessService(db).putConnectionInstalls(legacyConn.connection.id, { installs: [{ targetType: "agent", targetId: legacy.id }] });
      const { gateway, session, remote } = await gatewaySetup(companyId, legacy.id);
      const toolName = toolNamesFor(await gateway.listToolsForSession(session.token), legacyConn.connection.id)[0]!;
      expect(toolName).toBeTruthy();
      await expect(gateway.executeTool({ sessionToken: session.token, tool: toolName, parameters: {} })).rejects.toMatchObject({ reasonCode: "agent_authorization_required" });
      expect(remote).not.toHaveBeenCalled();
    });
  });

  describe("R2-S8. a managed dedicated connection's credential cannot be replaced or adopted", () => {
    async function readyDedicated(name: string) {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId, "rh-comms-board", { curated: true });
      const agent = await provisionReady(companyId, ownerId, name);
      const entry = await entryOf(agent.id);
      const dedicated = await db.select().from(toolConnections).where(eq(toolConnections.id, entry.connectionId!)).then((r) => r[0]!);
      const grant = await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id)).then((r) => r[0]!);
      return { companyId, agent, entry, dedicated, grant, header: dedicated.credentialRefs.find((r) => r.placement === "header")! };
    }
    const unchanged = async (f: Awaited<ReturnType<typeof readyDedicated>>) => {
      expect(await db.select().from(toolConnections).where(eq(toolConnections.id, f.dedicated.id)).then((r) => r[0]!)).toEqual(f.dedicated);
      expect(await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id)).then((r) => r[0]!.credentialSecretRefs)).toEqual(f.grant.credentialSecretRefs);
      expect(await resolveCommsBoardBinding(db, f.companyId, f.agent.id)).not.toBeNull();
    };

    it("a foreign header secret (same path or a new path) is rejected 422 with the connection, grant and READY binding untouched", async () => {
      const f = await readyDedicated("Adopt Bot");
      const foreign = await secretService(db).create(f.companyId, { name: "foreign", key: `s.${randomUUID()}`, provider: "local_encrypted", value: "someone-elses" });
      const service = toolAccessService(db);
      for (const name of [f.header.name, "credentials.moved"]) {
        await expect(
          service.updateConnection(f.dedicated.id, { credentialRefs: [{ ...f.header, name, secretId: foreign.id }] }, f.companyId),
        ).rejects.toMatchObject({ status: 422, details: { code: "managed_credential_secret_immutable" } });
      }
      await unchanged(f);
    });

    it("replacing connection-level secret refs, losing/duplicating the header, or flipping the policy off per_agent is rejected; the agent token is never adopted as shared", async () => {
      const f = await readyDedicated("Policy Bot");
      const service = toolAccessService(db);
      await expect(service.updateConnection(f.dedicated.id, { credentialSecretRefs: [{ secretId: f.entry.binding!.secretId!, configPath: "credentials.shared", versionSelector: "latest" }] }, f.companyId))
        .rejects.toMatchObject({ details: { code: "managed_credential_secret_immutable" } });
      await expect(service.updateConnection(f.dedicated.id, { credentialRefs: [] }, f.companyId)).rejects.toMatchObject({ details: { code: "managed_credential_path_ambiguous" } });
      await expect(service.updateConnection(f.dedicated.id, { credentialRefs: [f.header, { ...f.header, name: "credentials.two", key: "X-Two" }] }, f.companyId))
        .rejects.toMatchObject({ details: { code: "managed_credential_path_ambiguous" } });
      for (const credentialPolicy of ["shared", "per_user"] as const) {
        await expect(service.updateConnection(f.dedicated.id, { credentialPolicy }, f.companyId)).rejects.toMatchObject({ details: { code: "managed_credential_policy_immutable" } });
      }
      await unchanged(f);
      // Nothing opened a shared fallback: the company still cannot install the connection.
      await expect(service.putConnectionInstalls(f.dedicated.id, { installs: [{ targetType: "company", targetId: f.companyId }] })).rejects.toMatchObject({ status: 422 });
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.dedicated.id))).toHaveLength(0);
    });

    it("harmless updates still work: path-only move, name/config edits; an unmanaged per-agent connection is untouched by these rules", async () => {
      const f = await readyDedicated("Move Bot");
      const service = toolAccessService(db);
      await service.updateConnection(f.dedicated.id, { credentialRefs: [{ ...f.header, name: "credentials.moved" }] }, f.companyId);
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id)).then((r) => r[0]!)).credentialSecretRefs[0]!.configPath).toBe("credentials.moved");
      expect(await resolveCommsBoardBinding(db, f.companyId, f.agent.id)).not.toBeNull();

      const unmanaged = await seedTemplate(f.companyId, "ordinary-per-agent", { policy: "per_agent" });
      const replacement = await secretService(db).create(f.companyId, { name: "rotated", key: `s.${randomUUID()}`, provider: "local_encrypted", value: "new" });
      await service.updateConnection(unmanaged.connection.id, { credentialRefs: [{ ...unmanaged.connection.credentialRefs[0]!, secretId: replacement.id }], credentialPolicy: "shared" }, f.companyId);
      const after = await db.select().from(toolConnections).where(eq(toolConnections.id, unmanaged.connection.id)).then((r) => r[0]!);
      expect(after.credentialPolicy).toBe("shared");
      expect(after.credentialRefs[0]!.secretId).toBe(replacement.id);
    });

    it("reverse-key credentialSecretRefs resubmission passes; env or url refs addition rejects managed_credential_secret_immutable; ordinary connection allows env ref", async () => {
      const f = await readyDedicated("Ref Check Bot");
      const service = toolAccessService(db);

      // 1. Reverse key order in credentialSecretRefs resubmission passes
      const secretRef = { configPath: "credentials.shared", secretId: f.entry.binding!.secretId!, versionSelector: "latest" };
      await db.update(toolConnections).set({ credentialSecretRefs: [secretRef] }).where(eq(toolConnections.id, f.dedicated.id));
      const reversedKeyRef = {
        versionSelector: secretRef.versionSelector,
        secretId: secretRef.secretId,
        configPath: secretRef.configPath,
      };
      await service.updateConnection(f.dedicated.id, { credentialSecretRefs: [reversedKeyRef] }, f.companyId);
      const afterReverse = await db.select().from(toolConnections).where(eq(toolConnections.id, f.dedicated.id)).then((r) => r[0]!);
      expect(afterReverse.credentialSecretRefs).toEqual([secretRef]);
      f.dedicated = afterReverse;
      await unchanged(f);

      // 2. Env ref addition even with own secret alongside unchanged header ref rejects managed_credential_secret_immutable
      const envRef = {
        name: "credentials.env",
        placement: "env" as const,
        envVar: "API_TOKEN",
        secretId: f.header.secretId,
      };
      await expect(
        service.updateConnection(f.dedicated.id, { credentialRefs: [f.header, envRef] }, f.companyId),
      ).rejects.toMatchObject({ status: 422, details: { code: "managed_credential_secret_immutable" } });
      await unchanged(f);

      // 3. URL ref addition alongside unchanged header ref rejects managed_credential_secret_immutable
      const urlRef = {
        name: "credentials.url",
        placement: "url" as const,
        queryParam: "token",
        secretId: f.header.secretId,
      };
      await expect(
        service.updateConnection(f.dedicated.id, { credentialRefs: [f.header, urlRef] }, f.companyId),
      ).rejects.toMatchObject({ status: 422, details: { code: "managed_credential_secret_immutable" } });
      await unchanged(f);

      // 4. Ordinary connection still allows env ref addition
      const unmanaged = await seedTemplate(f.companyId, "ordinary-env-conn", { policy: "shared" });
      const ordinaryHeader = unmanaged.connection.credentialRefs[0]!;
      const ordinaryEnvRef = {
        name: "credentials.ordinary_env",
        placement: "env" as const,
        envVar: "ORD_TOKEN",
        secretId: ordinaryHeader.secretId,
      };
      await service.updateConnection(unmanaged.connection.id, { credentialRefs: [ordinaryHeader, ordinaryEnvRef] }, f.companyId);
      const afterOrdinary = await db.select().from(toolConnections).where(eq(toolConnections.id, unmanaged.connection.id)).then((r) => r[0]!);
      expect(afterOrdinary.credentialRefs).toHaveLength(2);
      expect(afterOrdinary.credentialRefs.map((r) => r.placement)).toEqual(["header", "env"]);
    });
  });

  describe("R2-S5/S6. provisioner endpoints and the mint response are strictly validated", () => {
    it("an invalid endpoint config waits (provisioner_config_invalid) before ANY fetch", async () => {
      const companyId = await seedCompany();
      const ownerId = await seedOwner(companyId);
      await seedTemplate(companyId, "rh-comms-board", { curated: true });
      enableFeature();
      const agent = await createAgent(companyId, ownerId);
      const fetchMock = downstreamFetch();
      for (const bad of ["http://board.example.test/mcp", "https://user:pw@board.example.test/mcp", "https://board.example.test/mcp?x=1", "https://board.example.test/mcp#frag", "ftp://board.example.test/mcp"]) {
        const env = { ...downstreamEnv(), [COMMS_BOARD_MCP_URL_ENV]: bad };
        await runDefaultMcpSetupForAgent({ db, env, fetchImpl: fetchMock, now: AFTER_BACKOFF }, { companyId, agentId: agent.id });
        expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "provisioner_config_invalid" });
        expect(JSON.stringify(await rowOf(agent.id))).not.toContain(bad);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      // A valid config on the next pass proceeds (the wait was automatic, not terminal).
      await runDefaultMcpSetupForAgent({ db, env: downstreamEnv(), fetchImpl: fetchMock, now: () => new Date(Date.now() + 5 * 3_600_000) }, { companyId, agentId: agent.id });
      expect((await entryOf(agent.id)).setup.state).toBe("ready");
    });

    it("a mint response for the wrong sub, owner, or an inactive row is an UNKNOWN outcome: terminal, no secret, connection or grant, one POST", async () => {
      for (const override of [{ sub: "paperclip-agent-someone-else" }, { owner_email: "other@redesignhealth.com" }, { active: false }, { owner_email: undefined }]) {
        const companyId = await seedCompany();
        const ownerId = await seedOwner(companyId);
        await seedTemplate(companyId, "rh-comms-board", { curated: true });
        enableFeature();
        const agent = await createAgent(companyId, ownerId);
        const fetchMock = downstreamFetch({ mint: (sub) => ownershipResponse(sub, override as Record<string, unknown>) });
        await runDefaultMcpSetupForAgent({ db, env: downstreamEnv(), fetchImpl: fetchMock, now: AFTER_BACKOFF }, { companyId, agentId: agent.id });
        expect((await entryOf(agent.id)).setup).toMatchObject({ state: "error", reason: "mint_unknown" });
        expect(fetchMock.calls.mint).toHaveLength(1);
        expect((await secretKeysOf(companyId)).some((k) => k.startsWith("comms_board."))).toBe(false);
        expect(await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id))).toHaveLength(0);
        await runDefaultMcpSetupForAgent({ db, env: downstreamEnv(), fetchImpl: fetchMock, now: () => new Date(Date.now() + 48 * 3_600_000) }, { companyId, agentId: agent.id });
        expect(fetchMock.calls.mint).toHaveLength(1); // never retried or rotated
      }
    });
  });

  it("(sanity) the secrets used by these tests are the ones the redaction scans look for", () => {
    expect(SECRETS).toEqual(expect.arrayContaining([BOARD_TOKEN, BOARD_ADMIN_TOKEN, OWNERSHIP_TOKEN]));
    expect(credentialRefConfigPath({ name: "authorization" })).toBe("credentials.authorization");
  });
});

export type _Unused = DefaultMcpEntryState;
