/**
 * TECH-7204 adversarial audit (independent test-audit agent), pinned to the final design. OFF is
 * enforced wherever an install is checked: the runtime handout `createManagedMcpRunConfig`, the
 * direct agent token mint `mintConnectionTokenForAgent`, the effective installed lists, and the
 * gateway (session tool listing, execution and credential resolution). A setup-bound profile
 * (`default_mcp_spec` source) only OFFERS the app (permission); the explicit per-agent install row
 * is the gate, and disabling withholds the NEXT mint/run/invocation. No in-flight token or session
 * revocation is promised, and nothing here claims one.
 *
 * All tests in this file pass against the final design; each one pins a contract that an earlier
 * revision got wrong (the third-entry default-ON grant, credential-path drift, array metadata
 * patches, and the gateway OFF gate). Uses the real secret service (real master key file, real
 * encryption + consumer checks) and the real tool-access/gateway services against embedded
 * Postgres — no vi.mock of secrets or permissions anywhere. The downstream comms-board/ownership
 * APIs are faked at the HTTP edge via the shared `downstreamFetch` helper.
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
  companySecrets,
  companySecretVersions,
  connectionGrants,
  createDb,
  heartbeatRuns,
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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { createManagedMcpRunConfig } from "../services/heartbeat.js";
import { secretService } from "../services/secrets.js";
import { credentialRefConfigPath, toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_SPEC_ENABLED_ENV,
  readCommsBoardBindingReference,
  readDefaultMcpState,
  type DefaultMcpEntrySpec,
  type DefaultMcpEntryState,
} from "../services/default-mcp-spec.js";
import {
  bindDefaultMcpOwnerIfUnset,
  runDefaultMcpSetupForAgent,
  snapshotDefaultMcpForNewAgent,
  sweepDefaultMcpSetups,
  waitForScheduledDefaultMcpSetups,
} from "../services/default-mcp-setup.js";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
} from "../services/comms-board-provisioner-client.js";
import {
  BOARD_ADMIN_TOKEN,
  BOARD_AGENT_ID,
  BOARD_TOKEN,
  BOARD_URL,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  SECRETS,
  boardResponse,
  downstreamFetch,
  ownershipResponse,
  clearBootProvisionerSnapshot,
  installBootProvisionerSnapshot,
} from "./helpers/comms-board-downstream.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const COMMS_TOOLS = ["comms_post_message", "comms_get_inbox"];
const GOOGLE_TOOLS = ["gmail_search"];

describeEmbeddedPostgres("default MCP adversarial audit (TECH-7204)", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-audit-${randomUUID()}`);
  const envKeys = [
    DEFAULT_MCP_SPEC_ENABLED_ENV,
    COMMS_BOARD_MCP_URL_ENV,
    COMMS_BOARD_ADMIN_TOKEN_ENV,
    COMMS_BOARD_OWNERSHIP_API_URL_ENV,
    COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  ];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("paperclip-default-mcp-audit-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    // TECH-7271: the boot-frozen rollout scope also bounds per-agent setup; these suites run it for every company.
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
    await db.delete(activityLog);
    await db.delete(toolGatewaySessions);
    await db.delete(toolCallEvents);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolInvocations);
    await db.delete(toolPolicies);
    await db.delete(toolCatalogEntries);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolOauthStates);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(companySecretBindings);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
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

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

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

  async function seedOwner(companyId: string, email = "owner@redesignhealth.com") {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
    // `membershipRole` matters: the agent token-broker context requires a non-viewer member.
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  type SeededConnection = { application: typeof toolApplications.$inferSelect; connection: typeof toolConnections.$inferSelect };

  /** Org template connection: a normal, live, catalogued MCP connection owned by the company. */
  async function seedMcpConnection(
    companyId: string,
    name: string,
    opts: { authKind?: "api_key" | "oauth"; credentialPolicy?: "shared" | "per_agent" | "per_user"; tools?: string[] } = {},
  ): Promise<SeededConnection> {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${name} ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const placeholder = await secretService(db).create(companyId, {
      name: `placeholder ${randomUUID()}`,
      key: `placeholder.${randomUUID()}`,
      provider: "local_encrypted",
      value: "placeholder-not-a-real-token",
    });
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name,
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        authKind: opts.authKind ?? "api_key",
        credentialPolicy: opts.credentialPolicy ?? "shared",
        // A public IP literal so the production egress guard passes without DNS
        // (same trick as the tool-gateway-service fixtures).
        config: { url: "https://8.8.8.8/mcp" },
        transportConfig: { url: "https://8.8.8.8/mcp" },
        credentialRefs: [
          { name: "credentials.authorization", secretId: placeholder.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " },
        ],
      })
      .returning()
      .then((rows) => rows[0]!);
    for (const toolName of opts.tools ?? COMMS_TOOLS) {
      await db.insert(toolCatalogEntries).values({
        companyId,
        applicationId: application.id,
        connectionId: connection.id,
        entryKind: "tool",
        name: toolName,
        toolName,
        title: toolName,
        riskLevel: "read",
        isReadOnly: true,
        status: "active",
        versionHash: randomUUID(),
        schemaHash: randomUUID(),
      });
    }
    return { application, connection };
  }

  /**
   * The app-managed access profile a finished gallery/wizard connection carries:
   * per-catalog-entry includes (the modern authority — a connection-wide include
   * is legacy and is actively removed by the install-toggle path).
   */
  async function seedAppProfileWithCatalogIncludes(companyId: string, connection: typeof toolConnections.$inferSelect) {
    const [profile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `app:${connection.id}`, name: `${connection.name} access ${randomUUID().slice(0, 6)}`, defaultAction: "deny" })
      .onConflictDoNothing()
      .returning();
    const catalogEntries = await db
      .select()
      .from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.connectionId, connection.id)));
    for (const entry of catalogEntries) {
      await db.insert(toolProfileEntries).values({
        companyId,
        profileId: profile!.id,
        selectorType: "catalog_entry",
        effect: "include",
        applicationId: connection.applicationId,
        connectionId: connection.id,
        catalogEntryId: entry.id,
      });
    }
    return profile!;
  }

  /**
   * The inheritedLive scenario from the contract: the company installs the connection for
   * everyone AND a company-bound active profile includes it, so a normal agent gets it live.
   */
  async function seedCompanyInstallAndProfile(companyId: string, connection: typeof toolConnections.$inferSelect) {
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection.id, targetType: "company", targetId: companyId });
    const profile = await seedAppProfileWithCatalogIncludes(companyId, connection);
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "company", targetId: companyId });
    return profile;
  }

  /** A managed-run-config gateway whose profile includes exactly the given connections. */
  async function seedGatewayFor(companyId: string, connections: Array<{ id: string }>) {
    const [profile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `gw:${randomUUID()}`, name: `gateway profile ${randomUUID().slice(0, 6)}`, defaultAction: "deny" })
      .returning();
    for (const connection of connections) {
      await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "connection", effect: "include", connectionId: connection.id });
    }
    const [gateway] = await db
      .insert(toolMcpGateways)
      .values({ companyId, name: `comms gateway ${randomUUID().slice(0, 6)}`, slug: `gw-${randomUUID().slice(0, 12)}`, profileId: profile!.id, status: "active" })
      .returning();
    return gateway!;
  }

  function enableFeature() {
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";
  }

  /** A mutable clock so backoff/lease math is deterministic without waiting real minutes. */
  function fakeClock() {
    let ms = Date.now();
    return {
      now: () => new Date(ms),
      advance: (deltaMs: number) => {
        ms += deltaMs;
      },
    };
  }

  /** Bounded polling: resolves with the first non-null predicate result; throws on timeout. */
  async function waitFor<T>(predicate: () => Promise<T | null | undefined>, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await predicate();
      if (value !== null && value !== undefined) return value;
      if (Date.now() >= deadline) throw new Error("waitFor: timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Past every nextAttemptAt the fire-and-forget create-path run can have written. */
  const PAST_BACKOFF_MS = 61_000;

  function provisionerEnv(): NodeJS.ProcessEnv {
    return {
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    };
  }

  async function createAgent(
    companyId: string,
    opts: {
      ownerUserId?: string | null;
      actor?: { userId?: string | null; agentId?: string | null };
      extra?: Record<string, unknown>;
    } = {},
  ) {
    return agentService(db).create(
      companyId,
      {
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
        ...(opts.extra ?? {}),
      },
      {
        ...(opts.ownerUserId ? { claudeLogin: { storedSessionId: null, ownerUserId: opts.ownerUserId } } : {}),
        ...(opts.actor ? { actor: opts.actor } : {}),
      },
    );
  }

  const agentRow = async (agentId: string) =>
    db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);

  const connectionRow = async (connectionId: string) =>
    db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).then((rows) => rows[0]!);

  const entryFor = async (agentId: string, key = "comms-board"): Promise<DefaultMcpEntryState | undefined> =>
    readDefaultMcpState((await agentRow(agentId)).metadata)?.entries[key];

  const installsFor = (agentId: string) =>
    db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, agentId));

  /** Runtime-config surface: exactly what a run of this agent would be handed. */
  const runConfigFor = (agent: { id: string; companyId: string; name: string }, adapterType = "codex_local") =>
    createManagedMcpRunConfig({
      db,
      agent: { id: agent.id, companyId: agent.companyId, name: agent.name, adapterType },
      runId: randomUUID(),
      config: {},
      projectId: null,
      issueId: null,
    });

  /** Direct gateway tool-permission surface: the tools a live session for the agent's run may call. */
  async function sessionToolsFor(companyId: string, agentId: string) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running", contextSnapshot: {} })
      .returning();
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "audit-test-signing-secret" });
    const session = await gateway.createSession({ companyId, agentId, runId: run!.id });
    return gateway.listToolsForSession(session.token);
  }

  const toolsForConnection = (
    tools: Array<{ connectionId?: string | null; upstreamToolName?: string | null }>,
    connectionId: string,
  ) => tools.filter((tool) => tool.connectionId === connectionId);

  /**
   * The DIRECT agent credential path (`POST /agents/me/connections/:id/token`,
   * `mintConnectionTokenForAgent`): eligibility is checked at mint — this is the "session
   * creation" install check — never per call, and disabling withholds the NEXT mint rather
   * than revoking an in-flight token. Returns the error's `details.code` (or "minted").
   */
  async function mintFor(companyId: string, agentId: string, connectionId: string, ownerId: string) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running", contextSnapshot: {}, responsibleUserId: ownerId })
      .returning();
    return toolAccessService(db)
      .mintConnectionTokenForAgent({ connectionId, companyId, agentId, runId: run!.id, body: { scope: "x" } })
      .then(
        () => ({ code: "minted" as string | undefined, status: undefined as number | undefined, message: undefined as string | undefined }),
        (error: { status?: number; message?: string; details?: { code?: string } }) => ({
          code: error?.details?.code,
          status: error?.status,
          message: error?.message,
        }),
      );
  }

  /** Fully provision a default-OFF agent: create (waiting) then one explicit successful setup pass. */
  async function provisionReadyAgent(companyId: string, ownerUserId: string, extra: Record<string, unknown> = {}) {
    enableFeature();
    const agent = await createAgent(companyId, { ownerUserId, extra });
    await waitForScheduledDefaultMcpSetups(); // waiting: provisioner unconfigured, nothing external called
    const clock = fakeClock();
    clock.advance(PAST_BACKOFF_MS);
    const fetchMock = downstreamFetch();
    await runDefaultMcpSetupForAgent(
      { db, env: provisionerEnv(), fetchImpl: fetchMock, now: clock.now },
      { companyId, agentId: agent.id },
    );
    return { agent, fetchMock, clock };
  }

  /** Same as `provisionReadyAgent` with a caller-provided downstream mock (e.g. per-subject token values). */
  async function provisionReadyAgentWith(companyId: string, ownerUserId: string, fetchImpl: ReturnType<typeof downstreamFetch>, name: string) {
    enableFeature();
    const agent = await createAgent(companyId, { ownerUserId, extra: { name } });
    await waitForScheduledDefaultMcpSetups(); // waiting: provisioner unconfigured, nothing external called
    const clock = fakeClock();
    clock.advance(PAST_BACKOFF_MS);
    await runDefaultMcpSetupForAgent(
      { db, env: provisionerEnv(), fetchImpl, now: clock.now },
      { companyId, agentId: agent.id },
    );
    return { agent };
  }

  /**
   * Deterministic backstop pass past every backoff a scheduled attempt can have written (up to two
   * attempts ahead of this pass: 60s then 120s). The approval path binds the verified approver as
   * owner INSIDE the activation transaction, before the post-commit schedule, so there is no
   * owner-bind race; this pass only makes the tests independent of the scheduler's timing.
   */
  async function runSetupPastBackoff(companyId: string, agentId: string, fetchImpl: ReturnType<typeof downstreamFetch>) {
    const clock = fakeClock();
    clock.advance(15 * 60_000);
    await runDefaultMcpSetupForAgent(
      { db, env: provisionerEnv(), fetchImpl, now: clock.now },
      { companyId, agentId },
    );
  }

  // -------------------------------------------------------------------------
  // OFF enforcement at the two contract surfaces
  // -------------------------------------------------------------------------

  it("runtime config: a company-wide install + company profile of the comms template is withheld from a NEW default-OFF agent while a pre-feature agent keeps it", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { connection: template } = await seedMcpConnection(companyId, "rh-comms-board");
    await seedCompanyInstallAndProfile(companyId, template);
    await seedGatewayFor(companyId, [template]);

    // Pre-feature agent: created while the flag is off — no defaultMcp state, unchanged behavior.
    const existing = await createAgent(companyId, { ownerUserId: ownerId, extra: { adapterType: "codex_local" } });
    expect(readDefaultMcpState((await agentRow(existing.id)).metadata)).toBeNull();

    enableFeature();
    const offAgent = await createAgent(companyId, { ownerUserId: ownerId, extra: { adapterType: "codex_local" } });
    await waitForScheduledDefaultMcpSetups();

    const offEntry = await entryFor(offAgent.id);
    expect(offEntry).toMatchObject({ enabled: false, templateConnectionId: template.id, connectionId: null });

    // The pre-feature agent still gets the comms gateway (existing agents are unchanged)...
    const existingConfig = await runConfigFor(existing);
    expect(existingConfig?.gateways ?? []).toHaveLength(1);
    // ...while the new default-OFF agent's run is handed nothing.
    expect(await runConfigFor(offAgent)).toBeNull();

    // Company rows are never modified by the feature.
    const companyInstalls = await db
      .select()
      .from(toolConnectionInstalls)
      .where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.targetType, "company")));
    expect(companyInstalls).toHaveLength(1);
    expect(readDefaultMcpState((await agentRow(existing.id)).metadata)).toBeNull();
  });

  it("the install row is the OFF gate on every install-checked surface: a company-wide install+permission of the comms template never reaches a NEW default-OFF agent's run handout or direct token mint; an explicit agent install turns both on; toggling it back off denies the NEXT mint", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { connection: template } = await seedMcpConnection(companyId, "rh-comms-board");
    await seedCompanyInstallAndProfile(companyId, template);
    await seedGatewayFor(companyId, [template]);

    const existing = await createAgent(companyId, { ownerUserId: ownerId, extra: { adapterType: "codex_local" } });
    enableFeature();
    const offAgent = await createAgent(companyId, { ownerUserId: ownerId, extra: { adapterType: "codex_local" } });
    await waitForScheduledDefaultMcpSetups();
    const stateBefore = readDefaultMcpState((await agentRow(offAgent.id)).metadata);

    // Runtime handout: the pre-feature agent keeps the comms gateway, the default-OFF agent gets nothing.
    expect((await runConfigFor(existing))?.gateways ?? []).toHaveLength(1);
    expect(await runConfigFor(offAgent)).toBeNull();

    // Direct agent token mint (eligibility checked at mint, not per call):
    // the company-wide install reaches the pre-feature agent but NOT the default-OFF agent.
    expect((await mintFor(companyId, existing.id, template.id, ownerId)).code).not.toBe("installation_required");
    expect((await mintFor(companyId, offAgent.id, template.id, ownerId)).code).toBe("installation_required");

    // The comms entry is DEDICATED, so its org template is provisioning-only for a managed agent: an
    // explicit per-agent install of the SHARED template is refused (it would use the org credential
    // instead of the agent's own board token), and a forced install row authorizes nothing.
    await expect(
      toolAccessService(db).putConnectionInstalls(template.id, {
        installs: [{ targetType: "company", targetId: companyId }, { targetType: "agent", targetId: offAgent.id }],
      }),
    ).rejects.toMatchObject({ details: { code: "managed_connection_not_installable" } });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: template.id, targetType: "agent", targetId: offAgent.id });
    expect((await mintFor(companyId, offAgent.id, template.id, ownerId)).code).toBe("installation_required");
    expect(toolsForConnection(await sessionToolsFor(companyId, offAgent.id), template.id)).toEqual([]);
    await db.delete(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.targetId, offAgent.id), eq(toolConnectionInstalls.connectionId, template.id)));

    // The PUT never syncs the server-managed state: effective ON/OFF is computed from install rows.
    expect(readDefaultMcpState((await agentRow(offAgent.id)).metadata)).toEqual(stateBefore);

    // The gateway enforces the OFF contract too (TECH-7204 review): the org's company-wide permission
    // binding does NOT list the template's tools for a live session of the OFF agent. Only the
    // explicit agent install (above) does.
    const offTools = await sessionToolsFor(companyId, offAgent.id);
    expect(toolsForConnection(offTools, template.id)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Normal per-agent toggle (enable/disable through the existing UI surface)
  // -------------------------------------------------------------------------

  it("the normal per-agent toggle enables only the intended agent (install, permission, runtime config); managed run config is codex_local-only", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { connection: template } = await seedMcpConnection(companyId, "rh-comms-board");
    // The template carries a finished app profile (catalog-entry includes); setup clones it
    // onto the dedicated connection, exactly like a company that connected the app properly.
    await seedAppProfileWithCatalogIncludes(companyId, template);

    const { agent: agentA } = await provisionReadyAgent(companyId, ownerId, { name: "Research Bot" });
    const { agent: agentB } = await provisionReadyAgent(companyId, ownerId, { name: "Sibling Bot" });
    const entryA = (await entryFor(agentA.id))!;
    const entryB = (await entryFor(agentB.id))!;
    expect(entryA.setup.state).toBe("ready");
    expect(entryB.setup.state).toBe("ready");
    const dedicatedA = entryA.connectionId!;
    const dedicatedB = entryB.connectionId!;
    expect(dedicatedA).not.toBe(dedicatedB);

    // The normal health sweep marks a fresh dedicated connection healthy; simulated
    // here so this test isolates the TOGGLE contract from the health pipeline.
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, dedicatedA));

    // A gateway that exposes exactly A's dedicated connection.
    await seedGatewayFor(companyId, [{ id: dedicatedA }]);

    // OFF by default: no install, no gateway in the run config.
    expect(await installsFor(agentA.id)).toHaveLength(0);
    expect(await runConfigFor(agentA)).toBeNull();

    // Normal UI enable for A only (the same service the PUT /tool-connections/:id/installs route uses).
    await toolAccessService(db).putConnectionInstalls(dedicatedA, { installs: [{ targetType: "agent", targetId: agentA.id }] });

    expect((await installsFor(agentA.id)).map((row) => row.connectionId)).toEqual([dedicatedA]);
    const effectiveA = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agentA.id);
    expect(effectiveA.installedConnections.map((connection) => connection.id)).toContain(dedicatedA);
    expect(effectiveA.entries.some((entry) => entry.connectionId === dedicatedA && entry.effect === "include")).toBe(true);

    // Direct gateway permission follows the toggle for A...
    const toolsA = await sessionToolsFor(companyId, agentA.id);
    expect(toolsForConnection(toolsA, dedicatedA)).not.toEqual([]);
    // ...and only for A: the sibling never gets A's dedicated connection.
    expect((await installsFor(agentB.id))).toHaveLength(0);
    const toolsB = await sessionToolsFor(companyId, agentB.id);
    expect(toolsForConnection(toolsB, dedicatedA)).toEqual([]);

    // The runtime config hands A the gateway; B gets nothing.
    const configA = await runConfigFor(agentA);
    expect(configA?.gateways ?? []).toHaveLength(1);
    expect(await runConfigFor(agentB)).toBeNull();

    // Honest runtime guard: the managed run-config path only exists for codex_local. For
    // process/hermes/claude adapters there is no managed MCP path at all, so any
    // "OFF withholds the server" claim for those adapters is vacuous — never claim otherwise.
    for (const adapterType of ["process", "hermes_local", "claude_local"]) {
      expect(await runConfigFor(agentA, adapterType)).toBeNull();
    }
  });

  it("permission-not-install: a provisioned-but-OFF agent is permitted (setup-bound profile) but not installed — the direct token mint and managed run config stay withheld until the normal install toggle, and OFF denies the NEXT mint", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { connection: template } = await seedMcpConnection(companyId, "rh-comms-board");
    await seedAppProfileWithCatalogIncludes(companyId, template);

    const { agent } = await provisionReadyAgent(companyId, ownerId, { name: "Off Bot" });
    const entry = (await entryFor(agent.id))!;
    expect(entry.setup.state).toBe("ready");
    const dedicatedId = entry.connectionId!;

    // The normal health sweep marks a fresh dedicated connection healthy; simulated here so
    // this test isolates the install-toggle contract from the health pipeline.
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, dedicatedId));
    await seedGatewayFor(companyId, [{ id: dedicatedId }]);

    // Permitted but NOT installed: the setup-bound profile gives permission (the Tools tab
    // shows the app as permitted) while the install row — the gate — is absent.
    const effective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agent.id);
    expect(effective.entries.some((e) => e.connectionId === dedicatedId && e.effect === "include")).toBe(true);
    expect(effective.installedConnections.map((c) => c.id)).not.toContain(dedicatedId);
    expect(await installsFor(agent.id)).toHaveLength(0);

    // Both install-checked surfaces are withheld while OFF...
    expect(await runConfigFor(agent)).toBeNull();
    expect((await mintFor(companyId, agent.id, dedicatedId, ownerId)).code).toBe("installation_required");

    // ...and the gateway session withholds the tools too while OFF (permission alone is not enough).
    const toolsBefore = await sessionToolsFor(companyId, agent.id);
    expect(toolsForConnection(toolsBefore, dedicatedId)).toEqual([]);

    // The normal install toggle (the UI checkbox) turns both install-checked surfaces on.
    await toolAccessService(db).putConnectionInstalls(dedicatedId, { installs: [{ targetType: "agent", targetId: agent.id }] });
    expect((await runConfigFor(agent))?.gateways ?? []).toHaveLength(1);
    expect((await mintFor(companyId, agent.id, dedicatedId, ownerId)).code).not.toBe("installation_required");

    // Toggling OFF removes the install row and its own binding (the setup's permission binding
    // deliberately survives), so the NEXT mint and the next run's config are withheld again.
    // No instant revocation of anything already minted is part of the contract.
    await toolAccessService(db).putConnectionInstalls(dedicatedId, { installs: [] });
    expect(await installsFor(agent.id)).toHaveLength(0);
    expect(await runConfigFor(agent)).toBeNull();
    expect((await mintFor(companyId, agent.id, dedicatedId, ownerId)).code).toBe("installation_required");
    // The permission binding tagged default_mcp_spec deliberately remains (permission ≠ install).
    const [dedicatedProfile] = await db
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${dedicatedId}`)));
    const survivingBindings = await db
      .select()
      .from(toolProfileBindings)
      .where(eq(toolProfileBindings.profileId, dedicatedProfile!.id));
    expect(survivingBindings.map((b) => b.targetType)).toEqual(["agent"]);
  });

  it("a LATE company-wide install of the comms template never grants previously-created OFF agents; their recorded default stays OFF", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { connection: template } = await seedMcpConnection(companyId, "rh-comms-board");

    const existing = await createAgent(companyId, { ownerUserId: ownerId, extra: { adapterType: "codex_local" } });
    enableFeature();
    const offAgent = await createAgent(companyId, { ownerUserId: ownerId, extra: { adapterType: "codex_local" } });
    await waitForScheduledDefaultMcpSetups();

    // Late company default change: the operator now installs the template company-wide + binds the company profile.
    await seedCompanyInstallAndProfile(companyId, template);
    await seedGatewayFor(companyId, [template]);

    // The previously-created OFF agent is not granted anything...
    const entry = await entryFor(offAgent.id);
    expect(entry?.enabled).toBe(false);
    expect(await installsFor(offAgent.id)).toHaveLength(0);
    expect(await runConfigFor(offAgent)).toBeNull();
    // ...while the pre-feature agent legitimately keeps getting it (unchanged existing behavior).
    expect((await runConfigFor(existing))?.gateways ?? []).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Approval hook + durable pending retry
  // -------------------------------------------------------------------------

  it("approving a pending-approval hire provisions its comms identity exactly once", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedMcpConnection(companyId, "rh-comms-board");
    enableFeature();
    installBootProvisionerSnapshot(provisionerEnv());
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent(companyId, { ownerUserId: ownerId, extra: { status: "pending_approval" } });
    await waitForScheduledDefaultMcpSetups();

    // Nothing is provisioned while the hire awaits approval.
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await entryFor(agent.id))?.setup).toMatchObject({ state: "pending", reason: "awaiting_approval" });

    // The board approves. (The route/approval service also pass the verified approver to
    // activatePendingApproval, which binds the owner in the activation transaction; this test binds
    // the creation-time owner explicitly to stay independent of that.)
    const approval = await agentService(db).activatePendingApproval(agent.id);
    expect(approval?.activated).toBe(true);
    await bindDefaultMcpOwnerIfUnset(db, agent.id, ownerId);
    await waitForScheduledDefaultMcpSetups();

    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(1);
    const entry = (await entryFor(agent.id))!;
    expect(entry.setup.state).toBe("ready");
    expect(entry.binding?.boardAgentId).toBe(BOARD_AGENT_ID);
    expect(readCommsBoardBindingReference((await agentRow(agent.id)).metadata)).toEqual(entry.binding);
  });

  it("an approving human can bind the owner for an ownerless hire; a foreign company's approver is never used as owner", async () => {
    const companyId = await seedCompany();
    const approverId = await seedOwner(companyId, "approver@redesignhealth.com");
    const otherCompanyId = await seedCompany();
    const foreignApproverId = await seedOwner(otherCompanyId, "foreign@redesignhealth.com");
    await seedMcpConnection(companyId, "rh-comms-board");
    enableFeature();
    installBootProvisionerSnapshot(provisionerEnv());
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    // Ownerless hire (e.g. created by a non-human actor): the approver binds the owner. Bound
    // explicitly before activation here; the real approval flow binds it inside the activation
    // transaction (covered in default-mcp-hardening.test.ts).
    const ownerless = await createAgent(companyId, { extra: { status: "pending_approval" } });
    expect((await entryFor(ownerless.id))?.ownerUserId).toBeNull();
    await bindDefaultMcpOwnerIfUnset(db, ownerless.id, approverId);
    expect((await entryFor(ownerless.id))?.ownerUserId).toBe(approverId);
    await agentService(db).activatePendingApproval(ownerless.id);
    await waitForScheduledDefaultMcpSetups();
    await runSetupPastBackoff(companyId, ownerless.id, fetchMock);

    expect((await entryFor(ownerless.id))?.setup).toMatchObject({ state: "ready" });
    expect(fetchMock.calls.register[0]!.ownerEmail).toBe("approver@redesignhealth.com");

    // A foreign approver binds their id, but the hook never accepts a non-member of THIS company.
    const ownerless2 = await createAgent(companyId, { extra: { status: "pending_approval" } });
    await agentService(db).activatePendingApproval(ownerless2.id);
    await bindDefaultMcpOwnerIfUnset(db, ownerless2.id, foreignApproverId);
    await waitForScheduledDefaultMcpSetups();
    await runSetupPastBackoff(companyId, ownerless2.id, fetchMock);

    expect(await entryFor(ownerless2.id)).toMatchObject({ setup: { state: "pending", reason: "owner_required" } });
    expect(fetchMock.calls.register).toHaveLength(1); // no second provisioning call

    // A malformed approve request (no verified actor / null req.actor.userId) binds no owner.
    const ownerless3 = await createAgent(companyId, { extra: { status: "pending_approval" } });
    await agentService(db).activatePendingApproval(ownerless3.id);
    await bindDefaultMcpOwnerIfUnset(db, ownerless3.id, null);
    await waitForScheduledDefaultMcpSetups();
    await runSetupPastBackoff(companyId, ownerless3.id, fetchMock);

    expect(await entryFor(ownerless3.id)).toMatchObject({ ownerUserId: null, setup: { state: "pending", reason: "owner_required" } });
    expect(fetchMock.calls.register).toHaveLength(1); // nothing provisioned without a verified human
  });

  it("the durable sweep retries a waiting entry once its blocker clears: one identity, one token, composed register sub, '::'-free mint sub", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedMcpConnection(companyId, "rh-comms-board");
    enableFeature();
    const agent = await createAgent(companyId, { ownerUserId: ownerId });
    await waitForScheduledDefaultMcpSetups();
    expect((await entryFor(agent.id))?.setup).toMatchObject({ state: "pending", reason: "provisioner_not_configured" });

    // The operator configures the provisioner; the sweep is the automatic retry.
    const clock = fakeClock();
    clock.advance(PAST_BACKOFF_MS);
    const env = provisionerEnv();
    const fetchMock = downstreamFetch();
    const swept = await sweepDefaultMcpSetups({ db, env, fetchImpl: fetchMock, now: clock.now });
    expect(swept).toBeGreaterThanOrEqual(1);

    expect((await entryFor(agent.id))?.setup.state).toBe("ready");
    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(1);
    // Exact downstream contract: the board row is the bare base sub; the token is
    // minted for the '::'-free base only, with comms:read/write and 365 days.
    const baseSub = `paperclip-agent-${agent.id}`;
    expect(fetchMock.calls.register[0]!.sub).toBe(baseSub);
    expect(fetchMock.calls.register[0]!.sub).not.toContain("::");
    expect(fetchMock.calls.mint[0]).toEqual({ sub: baseSub, scopes: ["comms:read", "comms:write"], expires: 365 });

    // A ready entry is not re-run by the sweep.
    clock.advance(PAST_BACKOFF_MS);
    await sweepDefaultMcpSetups({ db, env, fetchImpl: fetchMock, now: clock.now });
    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("while the provisioner is unconfigured the entry retries past the bounded budget but stays visibly pending (never a silent stop), and the next sweep after configuration reaches ready", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedMcpConnection(companyId, "rh-comms-board");
    enableFeature();
    const agent = await createAgent(companyId, { ownerUserId: ownerId });
    await waitForScheduledDefaultMcpSetups(); // attempt 1: waiting, nothing external called

    // Far more unconfigured sweep passes than the bounded retry budget (8): the ACTUAL
    // contract is that a waiting entry that created nothing external keeps retrying with
    // capped backoff and stays user-visible as `pending/provisioner_not_configured` —
    // it does not silently stop at attempts_exhausted while the operator has not configured it.
    const clock = fakeClock();
    const unconfigured: NodeJS.ProcessEnv = {};
    const fetchMock = downstreamFetch();
    for (let i = 0; i < 9; i++) {
      clock.advance(61 * 60_000); // past every backoff up to the 1h cap
      await sweepDefaultMcpSetups({ db, env: unconfigured, fetchImpl: fetchMock, now: clock.now });
      expect(fetchMock).not.toHaveBeenCalled();
    }
    const waiting = await entryFor(agent.id);
    expect(waiting?.setup).toMatchObject({ state: "pending", reason: "provisioner_not_configured" });
    expect(waiting?.setup.attemptCount).toBeGreaterThanOrEqual(10); // counted, visible, still going

    // Once the operator configures the provisioner, the very next sweep reaches ready.
    clock.advance(61 * 60_000);
    await sweepDefaultMcpSetups({ db, env: provisionerEnv(), fetchImpl: fetchMock, now: clock.now });
    expect((await entryFor(agent.id))?.setup.state).toBe("ready");
    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(1);
  });

  it("parallel claims from several instances produce exactly one identity and one token, and no foreign metadata or other entries are lost", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedMcpConnection(companyId, "rh-comms-board");
    enableFeature();
    const agent = await createAgent(companyId, { ownerUserId: ownerId });
    await waitForScheduledDefaultMcpSetups(); // waiting: provisioner unconfigured

    // Foreign metadata and another entry exist before the parallel claims race on the CAS.
    await agentService(db).update(agent.id, { metadata: { note: "keep" } });
    const before = readDefaultMcpState((await agentRow(agent.id)).metadata);
    expect(before?.entries["rh-google-mcp"]).toBeDefined();

    const slow = (response: Response) => new Promise<Response>((resolve) => setTimeout(() => resolve(response), 25));
    const fetchMock = downstreamFetch({
      register: (sub) => slow(boardResponse(sub)),
      mint: (sub) => slow(ownershipResponse(sub)),
    });
    const clock = fakeClock();
    clock.advance(PAST_BACKOFF_MS);
    await Promise.all([1, 2, 3].map(() =>
      runDefaultMcpSetupForAgent({ db, env: provisionerEnv(), fetchImpl: fetchMock, now: clock.now }, { companyId, agentId: agent.id })));

    expect(fetchMock.calls.register).toHaveLength(1); // exactly one claim wins the whole-entry CAS
    expect(fetchMock.calls.mint).toHaveLength(1);
    const after = readDefaultMcpState((await agentRow(agent.id)).metadata);
    expect(after?.entries["comms-board"].setup.state).toBe("ready");
    expect(after?.entries["rh-google-mcp"]).toEqual(before?.entries["rh-google-mcp"]); // other entries untouched
    expect((await agentRow(agent.id)).metadata).toMatchObject({ note: "keep" }); // foreign metadata preserved
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agent.id));
    expect(grants).toHaveLength(1); // the losers never minted or bound anything
    const secretRows = (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).map((s) => s.key);
    expect(secretRows.filter((key) => key.startsWith("comms_board."))).toEqual([`comms_board.${agent.id}`]);
  });

  it("unknown POST outcomes are terminal: no blind retry, no identity or token rotation, and a stale crashed claim never re-registers", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedMcpConnection(companyId, "rh-comms-board");
    enableFeature();

    // (a) register response lost (HTTP 500): board_unknown is terminal, never retried.
    const agentA = await createAgent(companyId, { ownerUserId: ownerId });
    await waitForScheduledDefaultMcpSetups();
    const clockA = fakeClock();
    clockA.advance(PAST_BACKOFF_MS);
    const fetchA = downstreamFetch({ register: (sub) => boardResponse(sub, { status: 500 }) });
    await runDefaultMcpSetupForAgent({ db, env: provisionerEnv(), fetchImpl: fetchA, now: clockA.now }, { companyId, agentId: agentA.id });
    expect((await entryFor(agentA.id))?.setup).toMatchObject({ state: "error", reason: "board_unknown" });
    clockA.advance(PAST_BACKOFF_MS);
    await runDefaultMcpSetupForAgent({ db, env: provisionerEnv(), fetchImpl: fetchA, now: clockA.now }, { companyId, agentId: agentA.id });
    expect(fetchA.calls.register).toHaveLength(1);
    expect(fetchA).toHaveBeenCalledTimes(4);

    // (b) mint response lost (HTTP 500): mint_unknown is terminal; the captured board UUID stays; no rotation.
    const agentB = await createAgent(companyId, { ownerUserId: ownerId });
    await waitForScheduledDefaultMcpSetups();
    const clockB = fakeClock();
    clockB.advance(PAST_BACKOFF_MS);
    const fetchB = downstreamFetch({ mint: (sub) => ownershipResponse(sub, {}, 500) });
    await runDefaultMcpSetupForAgent({ db, env: provisionerEnv(), fetchImpl: fetchB, now: clockB.now }, { companyId, agentId: agentB.id });
    const entryB = await entryFor(agentB.id);
    expect(entryB?.setup).toMatchObject({ state: "error", reason: "mint_unknown" });
    expect(entryB?.binding).toMatchObject({ boardAgentId: BOARD_AGENT_ID, secretId: null });
    clockB.advance(PAST_BACKOFF_MS);
    await runDefaultMcpSetupForAgent({ db, env: provisionerEnv(), fetchImpl: fetchB, now: clockB.now }, { companyId, agentId: agentB.id });
    expect(fetchB.calls.register).toHaveLength(1); // identity frozen, never re-registered
    expect(fetchB.calls.mint).toHaveLength(1);
    expect(fetchB).toHaveBeenCalledTimes(5); // no second mint, no rotation

    // (c) LIVE crash window: the downstream hangs mid-POST after the durable pre-call checkpoint.
    // Agent creation must resolve before the hanging call; a stale-lease takeover on any instance
    // classifies the checkpoint-without-result as unknown and NEVER repeats the POST, even across
    // repeated sweeps (restarts); the losing original writer abandons without minting (no rotation).
    let releaseHangingRegister: (response: Response) => void = () => {};
    const hangingRegister = new Promise<Response>((resolve) => {
      releaseHangingRegister = resolve;
    });
    let hungRegisterCalls = 0;
    const hangingFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === BOARD_URL) {
        if (init?.method === "DELETE") return new Response(null, { status: 200 });
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        if (body?.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "board", version: "1" } },
            }),
            { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-hang" } },
          );
        }
        if (body?.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        hungRegisterCalls += 1;
        return hangingRegister;
      }
      throw new Error(`unexpected url ${url}`);
    });
    installBootProvisionerSnapshot(provisionerEnv());
    vi.stubGlobal("fetch", hangingFetch);

    const agentC = await createAgent(companyId, { ownerUserId: ownerId }); // schedules the hanging run
    expect(agentC.id).toBeTruthy(); // creation resolved BEFORE the hanging call
    const registeredCheckpoint = await waitFor(async () => {
      const entry = await entryFor(agentC.id);
      return entry?.setup.registerAttemptedAt ?? null;
    });
    expect(registeredCheckpoint).toBeTruthy(); // the checkpoint was durable BEFORE the POST
    expect(hungRegisterCalls).toBe(1);

    // Take over the stale claim from "another process" (clock past the 10-minute lease).
    const clockC = fakeClock();
    clockC.advance(11 * 60_000);
    const fetchC = downstreamFetch();
    await sweepDefaultMcpSetups({ db, env: provisionerEnv(), fetchImpl: fetchC, now: clockC.now });
    expect(fetchC).not.toHaveBeenCalled(); // unknown outcome: never a second register POST
    expect((await entryFor(agentC.id))?.setup).toMatchObject({ state: "error", reason: "board_unknown", attemptCount: 2 });
    // Repeated sweeps (restarts) still never repeat the POST.
    clockC.advance(11 * 60_000);
    await sweepDefaultMcpSetups({ db, env: provisionerEnv(), fetchImpl: fetchC, now: clockC.now });
    expect(fetchC).not.toHaveBeenCalled();
    expect(hungRegisterCalls).toBe(1);

    // The original (hung) writer eventually gets its response: its claim was lost, it abandons
    // without minting — no second identity, no token rotation.
    releaseHangingRegister(boardResponse(`paperclip-agent-${agentC.id}::x`));
    await waitForScheduledDefaultMcpSetups();
    expect(fetchC).not.toHaveBeenCalled();
    expect((await entryFor(agentC.id))?.setup.state).toBe("error");
    const grantsC = await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId));
    expect(grantsC.filter((g) => g.kind === "agent" && g.subjectAgentId === agentC.id)).toHaveLength(0);

    // (d) definitive refusal (HTTP 403): terminal, attempt-counted, never rescheduled.
    const fetchD = downstreamFetch({ register: (sub) => boardResponse(sub, { status: 403 }) });
    vi.stubGlobal("fetch", fetchD);
    const agentD = await createAgent(companyId, { ownerUserId: ownerId });
    await waitForScheduledDefaultMcpSetups(); // the scheduled run takes the 403 and settles
    const entryD = await entryFor(agentD.id);
    expect(entryD?.setup).toMatchObject({ state: "error", reason: "board_rejected", nextAttemptAt: null });
    expect(entryD?.setup.attemptCount).toBeGreaterThan(0);
    const clockD = fakeClock();
    clockD.advance(PAST_BACKOFF_MS);
    await runDefaultMcpSetupForAgent({ db, env: provisionerEnv(), fetchImpl: fetchD, now: clockD.now }, { companyId, agentId: agentD.id });
    expect(fetchD.calls.register).toHaveLength(1);
    expect(fetchD).toHaveBeenCalledTimes(4); // a definitive denial is never rescheduled
  });

  // -------------------------------------------------------------------------
  // Extensibility: one more config entry
  // -------------------------------------------------------------------------

  it("a third ordinary MCP entry with defaultEnabled:true actually grants the new agent the MCP (install AND permission)", async () => {
    const companyId = await seedCompany();
    const { connection: third } = await seedMcpConnection(companyId, "rh-third-mcp", {
      credentialPolicy: "shared",
      tools: ["third_lookup"],
    });
    const thirdEntry: DefaultMcpEntrySpec = {
      key: "third-mcp",
      displayName: "Third MCP",
      connectionName: "rh-third-mcp",
      authKind: "none",
      defaultEnabled: true,
    };
    const agent = await createAgent(companyId, {});
    await db.transaction(async (tx) => {
      await snapshotDefaultMcpForNewAgent(tx as never, {
        companyId,
        agentId: agent.id,
        existingMetadata: (await agentRow(agent.id)).metadata,
        spec: [...DEFAULT_MCP_SPEC, thirdEntry],
        ownerUserId: null,
      });
    });

    const entry = await entryFor(agent.id, "third-mcp");
    expect(entry).toMatchObject({ enabled: true, connectionId: third.id, templateConnectionId: third.id });
    // The install row exists...
    expect((await installsFor(agent.id)).map((row) => row.connectionId)).toEqual([third.id]);
    // ...so a default-ON entry must actually be PERMITTED, exactly like the normal UI enable
    // (which writes the install AND its profile binding). Install-without-permission is a
    // half-grant, not a working "one more entry" extension point.
    const effective = await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agent.id);
    expect(effective.entries.some((e) => e.connectionId === third.id && e.effect === "include")).toBe(true);
    const tools = await sessionToolsFor(companyId, agent.id);
    expect(toolsForConnection(tools, third.id)).not.toEqual([]);
  });

  it("the Google OAuth entry is recorded and inert at creation; the normal consent wiring stays intact and a toggle is not consent", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { connection: google } = await seedMcpConnection(companyId, "rh-google-mcp", {
      authKind: "oauth",
      credentialPolicy: "per_user",
      tools: GOOGLE_TOOLS,
    });
    enableFeature();
    const agent = await createAgent(companyId, { ownerUserId: ownerId });
    await waitForScheduledDefaultMcpSetups();

    const entry = await entryFor(agent.id, "rh-google-mcp");
    expect(entry).toMatchObject({
      enabled: false,
      templateConnectionId: google.id,
      connectionId: google.id,
      ownerUserId: ownerId,
    });
    expect(entry?.setup).toMatchObject({ state: "not_required", reason: null });

    // Creation never starts consent and never provisions anything for the OAuth entry.
    expect(await db.select().from(toolOauthStates)).toHaveLength(0);
    expect(await db.select().from(connectionGrants)).toHaveLength(0);
    expect(await installsFor(agent.id)).toHaveLength(0);
    const secretKeys = (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).map((s) => s.key);
    expect(secretKeys.some((key) => key.startsWith("comms_board."))).toBe(false);

    // Not merely "didn't call consent": the normal wiring stays intact — a finished app
    // profile (catalog-entry includes, as the wizard writes) plus a per-agent toggle makes
    // the tools reachable, and still no consent artifacts exist (a toggle is not consent;
    // consent artifacts only ever come from the user-initiated OAuth flow).
    await seedAppProfileWithCatalogIncludes(companyId, google);
    await toolAccessService(db).putConnectionInstalls(google.id, { installs: [{ targetType: "agent", targetId: agent.id }] });
    const tools = await sessionToolsFor(companyId, agent.id);
    expect(toolsForConnection(tools, google.id)).not.toEqual([]);
    expect(await db.select().from(toolOauthStates)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Grant + secret invariants for the provisioned (ready) state
  // -------------------------------------------------------------------------

  it("ready means the agent's runtime credential is exactly its own provisioned board token: one grant, current configPath, no cross-agent reuse, no leaks", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const { application, connection: template } = await seedMcpConnection(companyId, "rh-comms-board");

    const { agent: agentA, fetchMock: fetchA } = await provisionReadyAgent(companyId, ownerId, { name: "Grant Bot" });
    const { agent: agentB, fetchMock: fetchB } = await provisionReadyAgent(companyId, ownerId, { name: "Other Bot" });
    expect(fetchA.calls.register).toHaveLength(1);
    expect(fetchB.calls.register).toHaveLength(1);

    const entryA = (await entryFor(agentA.id))!;
    const entryB = (await entryFor(agentB.id))!;
    const dedicatedA = await connectionRow(entryA.connectionId!);

    // The dedicated connection reuses the existing machinery — no new service or registry:
    // a normal company-scoped connection row on the template's application, per-agent policy.
    expect(dedicatedA).toMatchObject({
      companyId,
      applicationId: application.id,
      transport: "mcp_remote",
      authKind: "api_key",
      credentialPolicy: "per_agent",
    });
    expect(dedicatedA.name).toBe(`rh-comms-board:${agentA.id}`);
    expect(dedicatedA.applicationId).toBe(template.applicationId);

    // Exactly one agent grant, carrying the provisioned secret at the connection's current ref path.
    const grants = await db
      .select()
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.companyId, companyId),
        eq(connectionGrants.connectionId, dedicatedA.id),
        eq(connectionGrants.kind, "agent"),
        eq(connectionGrants.subjectAgentId, agentA.id),
      ));
    expect(grants).toHaveLength(1);
    const headerRef = (dedicatedA.credentialRefs ?? []).find((ref) => ref.placement === "header")!;
    expect(grants[0]!.credentialSecretRefs).toEqual([
      {
        secretId: entryA.binding!.secretId,
        versionSelector: "latest",
        configPath: credentialRefConfigPath(headerRef),
        required: true,
        label: "Comms board token",
      },
    ]);
    // The connection ref and the grant ref are the same single secret, and it resolves to the token.
    expect(headerRef.secretId).toBe(entryA.binding!.secretId);
    expect(await secretService(db).resolveSecretValue(companyId, entryA.binding!.secretId!, "latest")).toBe(BOARD_TOKEN);

    // No cross-agent token reuse: B has its own base sub, secret and dedicated connection.
    expect(entryB.binding!.baseSub).toBe(`paperclip-agent-${agentB.id}`);
    expect(entryB.binding!.secretId).not.toBe(entryA.binding!.secretId);
    expect(entryB.connectionId).not.toBe(entryA.connectionId);

    // OFF: still no install row and no agent-targeted secret binding; the runtime projection
    // of the agent's own config carries no board credential.
    const rowA = await agentRow(agentA.id);
    expect(await installsFor(agentA.id)).toHaveLength(0);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, agentA.id))).toHaveLength(0);
    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      rowA.adapterConfig as Record<string, unknown>,
      { companyId, consumerType: "agent", consumerId: agentA.id, actorType: "system", actorId: agentA.id } as never,
      { adapterType: rowA.adapterType },
    );
    expect(JSON.stringify(resolved)).not.toContain(BOARD_TOKEN);

    // Nothing secret ever appears in the agent row, audit rows, or the read-only reference.
    const auditRows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const reference = readCommsBoardBindingReference(rowA.metadata);
    expect(reference).toEqual(entryA.binding);
    for (const blob of [JSON.stringify(rowA), JSON.stringify(auditRows), JSON.stringify(reference)]) {
      for (const secret of SECRETS) expect(blob).not.toContain(secret);
    }
  });

  it("two agents' board tokens are isolated by VALUE (no unique index backs the key), and the vault never falls back to an arbitrary company", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedMcpConnection(companyId, "rh-comms-board");
    enableFeature();

    // Each mint returns its OWN token value so isolation is proven by value, not just by id.
    const perSubjectToken = downstreamFetch({
      mint: (sub) => ownershipResponse(sub, { token: `board-token-for-${sub}` }),
    });
    const { agent: agentA } = await provisionReadyAgentWith(companyId, ownerId, perSubjectToken, "Value Bot A");
    const { agent: agentB } = await provisionReadyAgentWith(companyId, ownerId, perSubjectToken, "Value Bot B");
    const entryA = (await entryFor(agentA.id))!;
    const entryB = (await entryFor(agentB.id))!;

    expect(entryA.binding!.secretId).not.toBe(entryB.binding!.secretId); // no shared vault row
    const tokenA = await secretService(db).resolveSecretValue(companyId, entryA.binding!.secretId!, "latest");
    const tokenB = await secretService(db).resolveSecretValue(companyId, entryB.binding!.secretId!, "latest");
    expect(tokenA).toBe(`board-token-for-paperclip-agent-${agentA.id}`);
    expect(tokenB).toBe(`board-token-for-paperclip-agent-${agentB.id}`);
    expect(tokenA).not.toBe(tokenB);

    // The vault never falls back to an arbitrary company: another tenant cannot resolve this secret.
    const otherCompanyId = await seedCompany();
    await expect(secretService(db).resolveSecretValue(otherCompanyId, entryA.binding!.secretId!, "latest")).rejects.toThrow();
    const grantsA = await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agentA.id));
    const grantsB = await db.select().from(connectionGrants).where(eq(connectionGrants.subjectAgentId, agentB.id));
    expect(grantsA[0]!.credentialSecretRefs[0]!.secretId).toBe(entryA.binding!.secretId);
    expect(grantsB[0]!.credentialSecretRefs[0]!.secretId).toBe(entryB.binding!.secretId);
  });

  it("an expired board token is never advertised as ready (rotation stays out of scope: no automatic re-provision)", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedMcpConnection(companyId, "rh-comms-board");

    const { agent, fetchMock } = await provisionReadyAgent(companyId, ownerId, { name: "Expiring Bot" });
    const entry = (await entryFor(agent.id))!;
    expect(entry.setup.state).toBe("ready");
    const row = await agentRow(agent.id);
    expect(readCommsBoardBindingReference(row.metadata)).toEqual(entry.binding); // future expiry: advertised

    // The token expires: the read-only projection must stop advertising a dead
    // credential, without any automatic rotation or re-provisioning kicking in.
    const metadata = { ...(row.metadata as Record<string, unknown>) };
    const state = metadata.defaultMcp as { entries: Record<string, DefaultMcpEntryState> };
    state.entries["comms-board"] = {
      ...state.entries["comms-board"]!,
      binding: { ...state.entries["comms-board"]!.binding!, tokenExpiresAt: new Date(Date.now() - 1_000).toISOString() },
    };
    await db.update(agents).set({ metadata }).where(eq(agents.id, agent.id));

    expect(readCommsBoardBindingReference((await agentRow(agent.id)).metadata)).toBeNull();
    // No automatic rotation: the entry is still ready and nothing was re-minted.
    expect((await entryFor(agent.id))?.setup.state).toBe("ready");
    expect(fetchMock.calls.mint).toHaveLength(1);

    // A null expiry is not treated as expired (the projection keeps working).
    const metadata2 = { ...((await agentRow(agent.id)).metadata as Record<string, unknown>) };
    const state2 = metadata2.defaultMcp as { entries: Record<string, DefaultMcpEntryState> };
    state2.entries["comms-board"] = {
      ...state2.entries["comms-board"]!,
      binding: { ...state2.entries["comms-board"]!.binding!, tokenExpiresAt: null },
    };
    await db.update(agents).set({ metadata: metadata2 }).where(eq(agents.id, agent.id));
    expect(readCommsBoardBindingReference((await agentRow(agent.id)).metadata)).not.toBeNull();
  });

  it("the dedicated clone never inherits an unreviewed allow-all template profile, and quarantined template tools never surface", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    // The template's app profile is allow-all with NO reviewed entries, and its catalog has an
    // active tool plus a quarantined one; the operator's profile includes both catalog entries.
    const { connection: template } = await seedMcpConnection(companyId, "rh-comms-board", {
      tools: ["comms_post_message", "comms_quarantined_tool"],
    });
    const [allowAllProfile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `app:${template.id}`, name: `allow all ${randomUUID().slice(0, 6)}`, defaultAction: "allow" })
      .returning();
    const catalog = await db
      .select()
      .from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.connectionId, template.id)));
    const quarantined = catalog.find((entry) => entry.toolName === "comms_quarantined_tool")!;
    await db.update(toolCatalogEntries).set({ quarantinedAt: new Date(), quarantineReason: "unreviewed" }).where(eq(toolCatalogEntries.id, quarantined.id));
    for (const entry of catalog) {
      await db.insert(toolProfileEntries).values({
        companyId, profileId: allowAllProfile!.id, selectorType: "catalog_entry", effect: "include",
        applicationId: template.applicationId, connectionId: template.id, catalogEntryId: entry.id,
      });
    }

    const { agent } = await provisionReadyAgent(companyId, ownerId, { name: "Clone Safety Bot" });
    const entry = (await entryFor(agent.id))!;
    const dedicatedId = entry.connectionId!;
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, dedicatedId));

    // The dedicated profile is created deny (an unreviewed allow-all is never inherited)...
    const [dedicatedProfile] = await db
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${dedicatedId}`)));
    expect(dedicatedProfile?.defaultAction).toBe("deny");
    // ...so a live session is granted only the reviewed, non-quarantined tool — never the
    // quarantined one, and never everything by default.
    // The clone-safety question is about WHAT a live session may call once the agent has the app, so
    // the agent is turned on through the normal install toggle first (OFF sessions list nothing).
    expect(toolsForConnection(await sessionToolsFor(companyId, agent.id), dedicatedId)).toEqual([]);
    await toolAccessService(db).putConnectionInstalls(dedicatedId, { installs: [{ targetType: "agent", targetId: agent.id }] });
    const tools = await sessionToolsFor(companyId, agent.id);
    expect(toolsForConnection(tools, dedicatedId).map((tool) => tool.upstreamToolName)).toEqual(["comms_post_message"]);
  });

  it("the dedicated clone copies only this company's template catalog: another tenant's same-named tools never reach it", async () => {
    const companyA = await seedCompany();
    const ownerA = await seedOwner(companyA, "a-owner@redesignhealth.com");
    const companyB = await seedCompany();
    await seedOwner(companyB, "b-owner@redesignhealth.com");
    await seedMcpConnection(companyA, "rh-comms-board", { tools: ["comms_a_only_tool"] });
    await seedMcpConnection(companyB, "rh-comms-board", { tools: ["comms_b_tool_1", "comms_b_tool_2"] });
    const bCatalogBefore = await db
      .select()
      .from(toolCatalogEntries)
      .where(eq(toolCatalogEntries.companyId, companyB));

    const { agent } = await provisionReadyAgent(companyA, ownerA, { name: "Clone Tenant Bot" });
    const entry = (await entryFor(agent.id))!;
    const dedicatedId = entry.connectionId!;

    // The clone carries exactly this company's reviewed tools; the other tenant's rows, grants
    // and connections are untouched.
    const dedicatedCatalog = await db
      .select()
      .from(toolCatalogEntries)
      .where(eq(toolCatalogEntries.connectionId, dedicatedId));
    expect(dedicatedCatalog.map((row) => row.toolName)).toEqual(["comms_a_only_tool"]);
    expect(dedicatedCatalog.every((row) => row.companyId === companyA)).toBe(true);
    expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, companyB))).toEqual(bCatalogBefore);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyB))).toHaveLength(0);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyB))).every((row) => row.name === "rh-comms-board")).toBe(true);
  });

  it("a refreshed credential ref on the dedicated connection never leaves a ready entry bound to a stale configPath", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedMcpConnection(companyId, "rh-comms-board");

    const { agent, clock } = await provisionReadyAgent(companyId, ownerId, { name: "Refresh Bot" });
    const entry = (await entryFor(agent.id))!;
    expect(entry.setup.state).toBe("ready");
    const dedicatedId = entry.connectionId!;

    // The operator refreshes the dedicated connection's credential wiring (name/key change).
    const dedicated = await connectionRow(dedicatedId);
    const header = (dedicated.credentialRefs ?? []).find((ref) => ref.placement === "header")!;
    await db
      .update(toolConnections)
      .set({ credentialRefs: [{ ...header, name: "credentials.x-api-key", key: "X-Api-Key" }] })
      .where(eq(toolConnections.id, dedicatedId));

    // A later setup pass must not leave a ready claim that no longer matches the connection's wiring.
    clock.advance(PAST_BACKOFF_MS);
    await runDefaultMcpSetupForAgent(
      { db, env: provisionerEnv(), fetchImpl: downstreamFetch(), now: clock.now },
      { companyId, agentId: agent.id },
    );

    const after = (await entryFor(agent.id))!;
    const grant = (await db
      .select()
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.connectionId, dedicatedId),
        eq(connectionGrants.kind, "agent"),
        eq(connectionGrants.subjectAgentId, agent.id),
      )))[0]!;
    const currentHeader = ((await connectionRow(dedicatedId)).credentialRefs ?? []).find((ref) => ref.placement === "header")!;
    const stillReady = after.setup.state === "ready";
    expect(stillReady ? grant.credentialSecretRefs[0]!.configPath : null).toBe(credentialRefConfigPath(currentHeader));
    expect(stillReady ? currentHeader.secretId : null).toBe(after.binding?.secretId ?? null);
  });

  // -------------------------------------------------------------------------
  // Metadata + owner authority
  // -------------------------------------------------------------------------

  it("caller-supplied metadata cannot forge or wipe the server-managed state; nested and differently-cased keys are inert caller data", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    enableFeature();
    const agent = await createAgent(companyId, {
      ownerUserId: ownerId,
      extra: {
        metadata: { defaultMcp: { forged: true }, keep: { defaultMcp: { nested: true } }, DefaultMcp: "not-reserved", note: "x" },
      },
    });
    await waitForScheduledDefaultMcpSetups();

    const row = await agentRow(agent.id);
    const state = readDefaultMcpState(row.metadata)!;
    expect(Object.keys(state.entries).sort()).toEqual(["comms-board", "rh-google-mcp", "rh-mcp"]); // server state, not the forged object
    expect(row.metadata).toMatchObject({ keep: { defaultMcp: { nested: true } }, DefaultMcp: "not-reserved", note: "x" });
    // The nested/differently-cased keys are inert: only the exact top-level reserved key is read.
    expect(readCommsBoardBindingReference({ keep: state })).toBeNull();
    expect(readCommsBoardBindingReference({ defaultMcp: state })).toEqual(readCommsBoardBindingReference(row.metadata));

    // Updates cannot forge a ready binding or wipe the state.
    const before = readDefaultMcpState((await agentRow(agent.id)).metadata);
    await agentService(db).update(agent.id, {
      metadata: { defaultMcp: { version: 1, entries: { "comms-board": { key: "comms-board", setup: { state: "ready" }, binding: { secretId: "forged" } } } }, note: "y" },
    });
    const afterForge = await agentRow(agent.id);
    expect(readDefaultMcpState(afterForge.metadata)).toEqual(before);
    expect(afterForge.metadata).toMatchObject({ note: "y" }); // the caller's other keys survive a normal patch
    await agentService(db).update(agent.id, { metadata: null });
    const afterNull = await agentRow(agent.id);
    // A null patch clears everything the caller owns, but never the reserved server-managed state.
    expect(afterNull.metadata).toEqual({ [DEFAULT_MCP_METADATA_KEY]: before });
    expect(readDefaultMcpState(afterNull.metadata)).toEqual(before);
  });

  it("an array-shaped metadata patch must not be able to wipe the server-managed defaultMcp state", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    enableFeature();
    const agent = await createAgent(companyId, { ownerUserId: ownerId });
    await waitForScheduledDefaultMcpSetups();
    const before = readDefaultMcpState((await agentRow(agent.id)).metadata);
    expect(before).not.toBeNull();

    // A non-object metadata payload slips past the reserved-key preserve logic (the strip helper
    // returns arrays unchanged), replacing the whole metadata blob and destroying the state the
    // wake bridge and enforcement rule read. Route schemas reject arrays, but the service seam
    // every internal caller uses must not.
    await agentService(db).update(agent.id, { metadata: ["not", "an", "object"] } as never);

    const after = readDefaultMcpState((await agentRow(agent.id)).metadata);
    expect(after).toEqual(before);
  });

  it("the owner is only the route-verified human: options.actor alone never provisions, claudeLogin.ownerUserId does", async () => {
    const companyId = await seedCompany();
    const memberEmail = "actor@redesignhealth.com";
    const memberId = await seedOwner(companyId, memberEmail);
    await seedMcpConnection(companyId, "rh-comms-board");
    enableFeature();

    // An agent-actor-style create (options.actor, no claudeLogin): owner stays null.
    const actorAgent = await createAgent(companyId, { actor: { userId: memberId, agentId: null } });
    await waitForScheduledDefaultMcpSetups();
    expect((await entryFor(actorAgent.id))?.ownerUserId).toBeNull();

    const fetchMock = downstreamFetch();
    const clock = fakeClock();
    clock.advance(PAST_BACKOFF_MS);
    await runDefaultMcpSetupForAgent({ db, env: provisionerEnv(), fetchImpl: fetchMock, now: clock.now }, { companyId, agentId: actorAgent.id });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await entryFor(actorAgent.id))?.setup).toMatchObject({ state: "pending", reason: "owner_required" });

    // The route's verified actor (claudeLogin.ownerUserId) is the owner.
    const routeAgent = await createAgent(companyId, { ownerUserId: memberId });
    await waitForScheduledDefaultMcpSetups();
    await runDefaultMcpSetupForAgent({ db, env: provisionerEnv(), fetchImpl: fetchMock, now: clock.now }, { companyId, agentId: routeAgent.id });
    expect(fetchMock.calls.register.at(-1)!.ownerEmail).toBe(memberEmail);
  });

  it("tenant isolation: another company's same-named template is never matched and nothing crosses tenants", async () => {
    const companyA = await seedCompany();
    const ownerA = await seedOwner(companyA, "a-owner@redesignhealth.com");
    const companyB = await seedCompany();
    await seedOwner(companyB, "b-owner@redesignhealth.com");
    await seedMcpConnection(companyB, "rh-comms-board");

    enableFeature();
    const agentA = await createAgent(companyA, { ownerUserId: ownerA });
    await waitForScheduledDefaultMcpSetups();
    expect((await entryFor(agentA.id))?.templateConnectionId).toBeNull();

    const fetchMock = downstreamFetch();
    const clock = fakeClock();
    clock.advance(PAST_BACKOFF_MS);
    await runDefaultMcpSetupForAgent(
      { db, env: provisionerEnv(), fetchImpl: fetchMock, now: clock.now },
      { companyId: companyA, agentId: agentA.id },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await entryFor(agentA.id))?.setup).toMatchObject({ state: "pending", reason: "template_not_found" });
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyA))).toHaveLength(0);
    const connectionsA = await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyA));
    expect(connectionsA).toHaveLength(0); // no dedicated connection was created in the wrong tenant
  });
});
