/**
 * TECH-7204 regression: the Test-tab agent impersonation route must refuse a
 * managed default-MCP OFF connection before any policy decision, invocation
 * recording, secret read, or outbound HTTP.
 *
 * `POST /api/tool-connections/:connectionId/test-calls` is the one surface that
 * runs an agent-scoped gateway session with NO active heartbeat run
 * (`runId: null`), so it needs its own OFF-gate coverage next to the session
 * (`default-mcp-hardening`) and setup (`default-mcp-setup`) suites — for BOTH
 * transports: the remote-HTTP path and the local_stdio path, whose gate must
 * fire before any policy decision, invocation recording, secret read, or child
 * process spawn. The managed state here is written by the real production
 * snapshot writer against ORDINARY (non-dedicated) spec entries, so no
 * comms-board provisioning, handshake, or identity machinery is involved.
 *
 * Uses an ordinary spec entry rather than the comms-board entry deliberately:
 * the dedicated provisioning contract is a separate rollout with its own
 * fixtures, and an ordinary entry exercises exactly the OFF contract under
 * test ("a company install never authorizes; only an explicit per-agent
 * install does").
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  connectionGrants,
  connectionTokenIssuances,
  createDb,
  principalPermissionGrants,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolGatewaySessions,
  toolInvocations,
  toolOauthStates,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService, type ToolGatewayService } from "../services/tool-gateway.js";
import { snapshotDefaultMcpForNewAgent } from "../services/default-mcp-setup.js";
import type { DefaultMcpEntrySpec } from "../services/default-mcp-spec.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

/** Public IP literal, same convention as the hardening suite: no DNS, no loopback. */
const URL_LITERAL = "https://8.8.8.8/mcp";
const SHARED_SECRET_VALUE = "org-shared-credential";
const TOOL_NAME = "do_thing";

/**
 * An ORDINARY default-MCP entry: no setup hook, so the org template connection
 * itself is the agent's `managed` connection (never a dedicated one).
 */
const ORDINARY_ENTRY: DefaultMcpEntrySpec = {
  key: "rh-ordinary-mcp",
  displayName: "RH Ordinary MCP",
  connectionName: "rh-ordinary-mcp",
  authKind: "none",
  defaultEnabled: false,
};

/** Same OFF contract for a local_stdio org template connection. */
const ORDINARY_STDIO_ENTRY: DefaultMcpEntrySpec = {
  key: "rh-ordinary-stdio-mcp",
  displayName: "RH Ordinary Stdio MCP",
  connectionName: "rh-ordinary-stdio-mcp",
  authKind: "none",
  defaultEnabled: false,
};

describeEmbeddedPostgres("default-MCP test-calls OFF gate (TECH-7204)", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmp = path.join(os.tmpdir(), `paperclip-default-mcp-test-calls-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmp, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmp, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-test-calls");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(toolGatewaySessions);
    await db.delete(toolCallEvents);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolActionRequests);
    await db.delete(connectionTokenIssuances);
    await db.delete(toolInvocations);
    await db.delete(toolPolicies);
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
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
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
    await db.insert(companies).values({
      id,
      name: `Co-${id.slice(0, 8)}`,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  /** A board user with an active operator membership and the tools:use permission. */
  async function seedBoardUser(companyId: string, permissionKeys: string[] = ["tools:use"]) {
    const userId = `tool-tester-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    if (permissionKeys.length > 0) {
      await db.insert(principalPermissionGrants).values(
        permissionKeys.map((permissionKey) => ({
          companyId,
          principalType: "user",
          principalId: userId,
          permissionKey,
          scope: null,
          grantedByUserId: "owner",
        })),
      );
    }
    return userId;
  }

  function boardSessionActor(
    companyId: string,
    userId: string,
  ): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      sessionId: `session-${randomUUID()}`,
      userName: "Tool tester",
      userEmail: null,
      isInstanceAdmin: false,
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    };
  }

  /**
   * An org template connection carrying a real shared header credential, an
   * organization grant that mirrors it, and a catalog tool. Everything a test
   * call needs to reach secret decryption + outbound HTTP when permitted.
   */
  async function seedTemplateConnection(companyId: string, name: string, toolName: string) {
    const [application] = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${name}`, type: "mcp_http", status: "active" })
      .returning();
    const secret = await secretService(db).create(companyId, {
      name: `shared ${randomUUID()}`,
      key: `shared.${randomUUID()}`,
      provider: "local_encrypted",
      value: SHARED_SECRET_VALUE,
    });
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application!.id,
        name,
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        authKind: "api_key",
        credentialPolicy: "shared",
        config: { url: URL_LITERAL },
        transportConfig: { url: URL_LITERAL },
        credentialRefs: [
          {
            name: "credentials.authorization",
            secretId: secret.id,
            version: "latest",
            placement: "header",
            key: "Authorization",
            prefix: "Bearer ",
          },
        ],
        credentialSecretRefs: [
          {
            secretId: secret.id,
            versionSelector: "latest",
            configPath: "credentials.authorization",
            required: true,
            label: "Org token",
          },
        ],
      })
      .returning();
    // Binding configPath mirrors the gateway's resolution context
    // (`credentials.${credentialRef.name}`), the convention the gateway suite uses.
    await db.insert(companySecretBindings).values({
      companyId,
      secretId: secret.id,
      targetType: "tool_connection",
      targetId: connection!.id,
      configPath: "credentials.credentials.authorization",
    });
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: connection!.id,
      kind: "organization",
      status: "active",
      isDefault: true,
      credentialSecretRefs: connection!.credentialSecretRefs,
    });
    const [catalogEntry] = await db
      .insert(toolCatalogEntries)
      .values({
        companyId,
        applicationId: application!.id,
        connectionId: connection!.id,
        entryKind: "tool",
        name: toolName,
        toolName,
        title: toolName,
        description: `Fixture tool ${toolName}.`,
        riskLevel: "read",
        isReadOnly: true,
        isWrite: false,
        isDestructive: false,
        status: "active",
        versionHash: randomUUID(),
        schemaHash: randomUUID(),
      })
      .returning();
    return { application: application!, connection: connection!, catalogEntry: catalogEntry! };
  }

  /** A company-wide install: the strongest NON-authorizing install for a managed connection. */
  async function companyWideInstall(companyId: string, connectionId: string) {
    await db
      .insert(toolConnectionInstalls)
      .values({ companyId, connectionId, targetType: "company", targetId: companyId });
  }

  async function allowPolicy(companyId: string, connectionId: string, policyType: "allow" | "require_approval" = "allow") {
    await db.insert(toolPolicies).values({
      companyId,
      name: `${policyType} ${randomUUID()}`,
      policyType,
      priority: 100,
      selectors: { connectionId },
    });
  }

  /**
   * A minimal local_stdio org template connection: just enough metadata for
   * the tool lookup to find the tool (application mcp_stdio + connection
   * local_stdio + an active catalog entry). Deliberately NO `templateId` and
   * NO `toolStdioCommandTemplates` row: execution never happens (the managed
   * gate refuses first), and with no template even a fully regressed gate
   * fails closed (`local_stdio_template_missing`, or the execution-time
   * managed gate in resolveConnectedLocalStdioTool) before any child process
   * could spawn — so this test can never start a process by construction.
   */
  async function seedStdioTemplateConnection(companyId: string, name: string, toolName: string) {
    const [application] = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${name}`, type: "mcp_stdio", status: "active" })
      .returning();
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application!.id,
        name,
        uid: `uid-${randomUUID()}`,
        transport: "local_stdio",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        authKind: "none",
        credentialPolicy: "shared",
        config: {},
        transportConfig: {},
      })
      .returning();
    const [catalogEntry] = await db
      .insert(toolCatalogEntries)
      .values({
        companyId,
        applicationId: application!.id,
        connectionId: connection!.id,
        entryKind: "tool",
        name: toolName,
        toolName,
        title: toolName,
        description: `Fixture stdio tool ${toolName}.`,
        riskLevel: "read",
        isReadOnly: true,
        isWrite: false,
        isDestructive: false,
        status: "active",
        versionHash: randomUUID(),
        schemaHash: randomUUID(),
      })
      .returning();
    return { application: application!, connection: connection!, catalogEntry: catalogEntry! };
  }

  /**
   * An agent row carrying a real default-MCP state, written by the production
   * snapshot writer. `ownerUserId` is recorded but never drives the OFF gate.
   * No setup is scheduled (no agentService.create), so nothing here touches
   * the comms-board provisioning contract.
   */
  async function seedSnapshotAgent(
    companyId: string,
    ownerUserId: string | null,
    spec: readonly DefaultMcpEntrySpec[] = [ORDINARY_ENTRY],
  ) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Snapshot Agent ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();
    await snapshotDefaultMcpForNewAgent(db, {
      companyId,
      agentId: agent!.id,
      ownerUserId,
      spec,
    });
    return agent!;
  }

  function mcpToolCallResponse() {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "ok" }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  /**
   * The remote-HTTP transport seam, typed like the real one so call arguments
   * (url, headers) stay assertable on `mock.calls`.
   */
  function remoteTransport() {
    return vi.fn(async (_url: string, _init: RequestInit) => mcpToolCallResponse());
  }

  /** Reads a header from any RequestInit.headers shape (record, Headers, or pairs). */
  function readHeader(init: RequestInit, name: string): string | null {
    const raw = init.headers;
    if (!raw) return null;
    if (raw instanceof Headers) return raw.get(name);
    if (Array.isArray(raw)) {
      const hit = raw.find(([key]) => String(key).toLowerCase() === name.toLowerCase());
      return hit ? String(hit[1]) : null;
    }
    if (typeof raw === "object") {
      for (const [key, value] of Object.entries(raw as Record<string, string>)) {
        if (key.toLowerCase() === name.toLowerCase()) return value;
      }
    }
    return null;
  }

  /**
   * The route app with every remote-HTTP seam pointed at one spy: the gateway
   * transport AND the tool-access service transport both flow through
   * `remoteHttpRequest`, and global fetch stays a plain spy as a backstop.
   */
  function createRouteApp(
    actor: Express.Request["actor"],
    remote: (url: string, init: RequestInit) => Promise<Response>,
    toolGateway?: ToolGatewayService,
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(
      "/api",
      toolAccessRoutes(db, {
        toolGateway:
          toolGateway ??
          createToolGatewayService(db, {
            toolActionSigningSecret: "default-mcp-test-calls-signing-secret",
            remoteHttpRequest: remote,
          }),
        remoteHttpRequest: remote,
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function secretReads(companyId: string) {
    return db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.companyId, companyId));
  }

  async function invocations(companyId: string) {
    return db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.companyId, companyId));
  }

  async function actionRequests(companyId: string) {
    return db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.companyId, companyId));
  }

  /**
   * The full "everything else says yes" scenario: company install, organization
   * grant, allow policy, valid state — only the explicit per-agent install is
   * missing, so the managed OFF gate is the sole thing standing between the
   * request and secret decryption + outbound HTTP.
   */
  async function seedOffScenario(policyType: "allow" | "require_approval" = "allow") {
    const companyId = await seedCompany();
    const ownerUserId = `owner-${randomUUID()}`;
    const boardUserId = await seedBoardUser(companyId);
    const template = await seedTemplateConnection(companyId, ORDINARY_ENTRY.connectionName, TOOL_NAME);
    await companyWideInstall(companyId, template.connection.id);
    await allowPolicy(companyId, template.connection.id, policyType);
    const agent = await seedSnapshotAgent(companyId, ownerUserId);
    return { companyId, boardUserId, template, agent };
  }

  function postTestCall(
    app: express.Express,
    connectionId: string,
    agentId: string,
    toolName = TOOL_NAME,
  ) {
    return request(app)
      .post(`/api/tool-connections/${connectionId}/test-calls`)
      .send({ agentId, toolName, parameters: {} });
  }

  // ---- the gate ------------------------------------------------------------------------------

  it("refuses a managed OFF connection before any policy decision, invocation, secret read, or outbound HTTP", async () => {
    const { companyId, boardUserId, template, agent } = await seedOffScenario();
    const remote = remoteTransport();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = createRouteApp(boardSessionActor(companyId, boardUserId), remote);

    const res = await postTestCall(app, template.connection.id, agent.id).expect(403);

    expect(res.body).toEqual({
      error: "This app is not installed for this agent.",
      reasonCode: "installation_required",
      connectionId: template.connection.id,
    });
    // 0 outbound HTTP: neither transport seam nor global fetch.
    expect(remote).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // 0 secret reads (a failed resolution attempt would also be recorded).
    expect(await secretReads(companyId)).toHaveLength(0);
    // Before the policy decision: no invocation, no approval request.
    expect(await invocations(companyId)).toHaveLength(0);
    expect(await actionRequests(companyId)).toHaveLength(0);
    // The refusal is attributed to the managed gate, with no run to blame.
    // (The activity log records the agent as entityId; the dedicated audit
    // table below carries the agent id inside its details.)
    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "tool_gateway.managed_install_required",
          actorType: "user",
          actorId: boardUserId,
          entityType: "agent",
          entityId: agent.id,
          details: expect.objectContaining({
            connectionId: template.connection.id,
            reason: "installation_required",
            runId: null,
          }),
        }),
      ]),
    );
    const dedicated = await db
      .select()
      .from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.companyId, companyId));
    expect(dedicated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "installation_required",
          connectionId: template.connection.id,
          details: expect.objectContaining({
            agentId: agent.id,
            reason: "installation_required",
            runId: null,
          }),
        }),
      ]),
    );
  });

  it("refuses a managed OFF connection before an ask-first approval snapshot resolves credentials", async () => {
    const { companyId, boardUserId, template, agent } = await seedOffScenario("require_approval");
    const remote = remoteTransport();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = createRouteApp(boardSessionActor(companyId, boardUserId), remote);

    // The OFF gate must win over the approval path: a 403 refusal, never an
    // ask_first action request (whose snapshot resolves credentials).
    const res = await postTestCall(app, template.connection.id, agent.id).expect(403);

    expect(res.body).toMatchObject({ reasonCode: "installation_required" });
    expect(remote).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await secretReads(companyId)).toHaveLength(0);
    expect(await invocations(companyId)).toHaveLength(0);
    expect(await actionRequests(companyId)).toHaveLength(0);
  });

  const corruptedMetadataCases: Array<[string, Record<string, unknown>]> = [
    ["a non-object protected key", { defaultMcp: "corrupted" }],
    ["a wrong-version protected key", { defaultMcp: { version: 2, entries: {} } }],
  ];

  it.each(corruptedMetadataCases)(
    "fails closed on corrupted protected defaultMcp metadata (%s)",
    async (_label, corruptedMetadata) => {
      const { companyId, boardUserId, template, agent } = await seedOffScenario();
      await db.update(agents).set({ metadata: corruptedMetadata }).where(eq(agents.id, agent.id));
      const remote = remoteTransport();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const app = createRouteApp(boardSessionActor(companyId, boardUserId), remote);

      const res = await postTestCall(app, template.connection.id, agent.id).expect(403);

      // The tool itself is found (not tool_not_found): the refusal is the
      // fail-closed install gate, not a broken fixture.
      expect(res.body).toEqual({
        error: "This app is not installed for this agent.",
        reasonCode: "installation_required",
        connectionId: template.connection.id,
      });
      expect(remote).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await secretReads(companyId)).toHaveLength(0);
      expect(await invocations(companyId)).toHaveLength(0);
    },
  );

  it("refuses a managed OFF local_stdio test call before any policy decision, invocation, secret read, or stdio dispatch", async () => {
    const companyId = await seedCompany();
    const ownerUserId = `owner-${randomUUID()}`;
    const boardUserId = await seedBoardUser(companyId);
    const stdio = await seedStdioTemplateConnection(
      companyId,
      ORDINARY_STDIO_ENTRY.connectionName,
      "do_stdio_thing",
    );
    await companyWideInstall(companyId, stdio.connection.id);
    await allowPolicy(companyId, stdio.connection.id);
    const agent = await seedSnapshotAgent(companyId, ownerUserId, [ORDINARY_STDIO_ENTRY]);
    const remote = remoteTransport();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = createRouteApp(boardSessionActor(companyId, boardUserId), remote);

    // The transport-agnostic early gate fires for local_stdio too: the tool is
    // found (never tool_not_found) and the managed OFF refusal precedes the
    // policy decision, so nothing is recorded and nothing leaves the box.
    const res = await postTestCall(app, stdio.connection.id, agent.id, "do_stdio_thing").expect(403);

    expect(res.body).toEqual({
      error: "This app is not installed for this agent.",
      reasonCode: "installation_required",
      connectionId: stdio.connection.id,
    });
    expect(remote).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await secretReads(companyId)).toHaveLength(0);
    expect(await invocations(companyId)).toHaveLength(0);
    expect(await actionRequests(companyId)).toHaveLength(0);
    // No injectable stdio dispatch seam exists (callLocalStdioMcp spawns a
    // child process directly), so spawn-prevention is pinned structurally: the
    // fixture seeds no command template and no templateId, so even with every
    // managed gate removed the transport refuses with 422
    // `local_stdio_template_missing` before any child process can start.
  });

  it("an explicit per-agent install allows the test call; revoking it refuses again while a company install alone never authorizes", async () => {
    const { companyId, boardUserId, template, agent } = await seedOffScenario();
    const actor = boardSessionActor(companyId, boardUserId);
    const service = toolAccessService(db);
    const remote = remoteTransport();
    // Mocked as well so an accidental global-fetch path still answers, while
    // staying visible to the assertion below.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => mcpToolCallResponse());
    const app = createRouteApp(actor, remote);

    // OFF: the company-wide install alone never authorizes.
    await postTestCall(app, template.connection.id, agent.id).expect(403);
    expect(remote).not.toHaveBeenCalled();
    expect(await secretReads(companyId)).toHaveLength(0);

    // ON: keep the company install and add the explicit per-agent install.
    await service.putConnectionInstalls(template.connection.id, {
      installs: [
        { targetType: "company", targetId: companyId },
        { targetType: "agent", targetId: agent.id },
      ],
    });
    const allowed = await postTestCall(app, template.connection.id, agent.id).expect(200);
    expect(allowed.body).toMatchObject({
      decision: "allowed",
      invocationId: expect.any(String),
      result: expect.objectContaining({
        data: expect.objectContaining({ isError: false, transport: "mcp_http" }),
      }),
    });
    // The allowed path dispatches exactly once, through the seam, with the
    // decrypted org credential — proving the earlier zeros were the gate, not
    // a fixture that can never read secrets or dispatch.
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote.mock.calls[0]![0]).toBe(URL_LITERAL);
    expect(readHeader(remote.mock.calls[0]![1], "Authorization")).toBe(
      `Bearer ${SHARED_SECRET_VALUE}`,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await secretReads(companyId)).toHaveLength(1);
    const [invocation] = await invocations(companyId);
    expect(invocation).toMatchObject({
      companyId,
      connectionId: template.connection.id,
      agentId: agent.id,
      runId: null,
      actorType: "user",
      actorId: boardUserId,
      status: "succeeded",
    });

    // REVOKED: removing the per-agent install (company install kept) refuses again.
    await service.putConnectionInstalls(template.connection.id, {
      installs: [{ targetType: "company", targetId: companyId }],
    });
    const revoked = await postTestCall(app, template.connection.id, agent.id).expect(403);
    expect(revoked.body).toMatchObject({ reasonCode: "installation_required" });
    expect(remote).toHaveBeenCalledTimes(1); // unchanged: no new dispatch
    expect(await secretReads(companyId)).toHaveLength(1); // unchanged: no new read
    expect(await invocations(companyId)).toHaveLength(1); // unchanged
  });

  it("preserves the board, permission, company, and agent gates in front of the managed check", async () => {
    const { companyId, boardUserId, template, agent } = await seedOffScenario();
    const otherCompanyId = await seedCompany();
    const otherTemplate = await seedTemplateConnection(
      otherCompanyId,
      "rh-ordinary-mcp",
      TOOL_NAME,
    );
    const foreignAgent = await db
      .insert(agents)
      .values({
        companyId: otherCompanyId,
        name: `Foreign Agent ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const remote = remoteTransport();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Agent actors never reach the test-calls route: board access is required.
    const agentActorApp = createRouteApp(
      {
        type: "agent",
        companyId,
        agentId: agent.id,
        runId: randomUUID(),
        source: "agent_jwt",
      },
      remote,
    );
    const agentActorRes = await postTestCall(agentActorApp, template.connection.id, agent.id).expect(403);
    expect(agentActorRes.body).toEqual({ error: "Board access required" });

    // A board user without tools:use / tools:manage_connections is refused.
    const unpermissionedUserId = await seedBoardUser(companyId, []);
    const unpermissionedApp = createRouteApp(
      boardSessionActor(companyId, unpermissionedUserId),
      remote,
    );
    const unpermissionedRes = await postTestCall(
      unpermissionedApp,
      template.connection.id,
      agent.id,
    ).expect(403);
    expect(unpermissionedRes.body).toEqual({
      error: "Missing one of permissions: tools:use, tools:manage_connections",
    });

    // Another tenant's connection is a uniform 404 (no cross-tenant oracle).
    const app = createRouteApp(boardSessionActor(companyId, boardUserId), remote);
    const crossTenantRes = await postTestCall(app, otherTemplate.connection.id, agent.id).expect(404);
    expect(crossTenantRes.body).toEqual({ error: "Tool connection not found" });

    // A missing or foreign agent id is not testable, even for a permitted user.
    const missingRes = await postTestCall(app, template.connection.id, randomUUID()).expect(403);
    expect(missingRes.body).toEqual({ error: "This agent is not available for testing" });
    const foreignRes = await postTestCall(app, template.connection.id, foreignAgent.id).expect(403);
    expect(foreignRes.body).toEqual({ error: "This agent is not available for testing" });

    // None of the auth-gate refusals may touch the network, secrets, or invocations.
    expect(remote).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await secretReads(companyId)).toHaveLength(0);
    expect(await invocations(companyId)).toHaveLength(0);
    expect(await actionRequests(companyId)).toHaveLength(0);
  });

  it("leaves legacy agents and unrelated connections on the normal allow path", async () => {
    const companyId = await seedCompany();
    const boardUserId = await seedBoardUser(companyId);
    const template = await seedTemplateConnection(companyId, ORDINARY_ENTRY.connectionName, TOOL_NAME);
    const unrelated = await seedTemplateConnection(companyId, "rh-unrelated-mcp", "do_unrelated");
    await companyWideInstall(companyId, template.connection.id);
    await companyWideInstall(companyId, unrelated.connection.id);
    await allowPolicy(companyId, template.connection.id);
    await allowPolicy(companyId, unrelated.connection.id);

    // A legacy agent (no defaultMcp state) is unchanged: company install + allow.
    const [legacyAgent] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Legacy Agent ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();
    // An agent with defaultMcp state is also unchanged for a connection its
    // state does not manage.
    const snapshotAgent = await seedSnapshotAgent(companyId, null);
    const remote = remoteTransport();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = createRouteApp(boardSessionActor(companyId, boardUserId), remote);

    const legacyRes = await postTestCall(app, template.connection.id, legacyAgent!.id).expect(200);
    expect(legacyRes.body).toMatchObject({ decision: "allowed" });

    const unrelatedRes = await postTestCall(
      app,
      unrelated.connection.id,
      snapshotAgent.id,
      "do_unrelated",
    ).expect(200);
    expect(unrelatedRes.body).toMatchObject({ decision: "allowed" });

    expect(remote).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await secretReads(companyId)).toHaveLength(2);
    const rows = await invocations(companyId);
    expect(rows.map((row) => row.agentId).sort()).toEqual(
      [legacyAgent!.id, snapshotAgent.id].sort(),
    );
    expect(rows.every((row) => row.runId === null && row.status === "succeeded")).toBe(true);
  });
});
