import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  toolAccessAuditEvents,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolCatalogEntries,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPaperclipRuntimeMcpServers, createManagedMcpRunConfig } from "../services/heartbeat.js";

import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat runtime MCP servers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-runtime-mcp-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await db.delete(toolMcpGatewayTokens);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(heartbeatRuns);
    await db.delete(toolMcpGateways);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("provisions one aggregate gateway and omits unavailable access without blocking any runtime", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Runtime MCP ${randomUUID()}`,
      issuePrefix: `RM${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Runtime MCP Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `runtime-${randomUUID().slice(0, 8)}`,
      name: "Runtime MCP App",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [installedConnection, uninstalledConnection] = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Installed MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { url: "https://installed.example.test/mcp" },
      },
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Uninstalled MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        config: { url: "https://uninstalled.example.test/mcp" },
      },
    ]).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${installedConnection!.id}`,
      name: "Installed MCP",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: application!.id,
      connectionId: installedConnection!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id,
      connectionId: installedConnection!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolCatalogEntries).values({
      companyId: company!.id,
      applicationId: application!.id,
      connectionId: installedConnection!.id,
      name: "installed_tool",
      toolName: "installed_tool",
      versionHash: "fixture",
      status: "active",
    });

    const before = Date.now();
    const first = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: randomUUID() });
    const second = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: randomUUID() });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      name: "paperclip-assigned",
      connectionId: expect.stringMatching(/^assignment:[a-f0-9]{64}$/),
      url: expect.stringMatching(/^https:\/\/paperclip\.example\.test\/mcp\/gateways\/gw_[a-f0-9]{32}$/),
      token: expect.stringMatching(/^pcgw_/),
    });
    expect(first[0]!.allowedTools).toBeDefined();
    // Verify no discovery audit log was written during heartbeat server assembly (no live discovery)
    const discoveryLogs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.discovery"));
    expect(discoveryLogs).toHaveLength(0);
    expect(JSON.stringify(first)).not.toContain(uninstalledConnection!.id);
    expect(second).toHaveLength(1);
    expect(second[0]!.connectionId).toBe(first[0]!.connectionId);

    const gateways = await db.select().from(toolMcpGateways);
    expect(gateways).toHaveLength(1);
    expect(gateways[0]!.metadata).toMatchObject({
      nativeRuntimeAssignmentDigest: first[0]!.connectionId.slice("assignment:".length),
      agentId: agent!.id,
    });
    const tokens = await db.select().from(toolMcpGatewayTokens);
    expect(tokens).toHaveLength(2);
    for (const token of tokens) {
      expect(token.subjectType).toBe("heartbeat_run");
      expect(token.subjectId).toMatch(/^[0-9a-f-]{36}$/);
      expect(token.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
      expect(token.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1000);
    }
    expect(JSON.stringify(tokens)).not.toContain(first[0]!.token);

    await expect(
      buildPaperclipRuntimeMcpServers({
        db,
        agent: agent!,
        runId: randomUUID(),
        expectedAssignmentDigest: "0".repeat(64),
      }),
    ).resolves.toEqual([]);
    expect(await db.select().from(toolMcpGatewayTokens)).toHaveLength(2);

    await db.update(toolConnections)
      .set({ healthStatus: "degraded", healthMessage: "fixture unavailable" })
      .where(eq(toolConnections.id, installedConnection!.id));
    const unavailableReports: Array<Array<{ id: string; name: string }>> = [];
    await expect(
      buildPaperclipRuntimeMcpServers({
        db,
        agent: agent!,
        runId: randomUUID(),
        expectedAssignmentDigest: first[0]!.connectionId.slice("assignment:".length),
        onUnavailableAssignedConnections: (connections) => {
          unavailableReports.push(connections);
        },
      }),
    ).resolves.toEqual([]);
    expect(unavailableReports).toEqual([[
      { id: installedConnection!.id, name: installedConnection!.name },
    ]]);
    expect(await db.select().from(toolMcpGatewayTokens)).toHaveLength(2);
    await expect(
      createManagedMcpRunConfig({
        db,
        agent: agent!,
        runId: randomUUID(),
        config: {},
        projectId: null,
        issueId: null,
      }),
    ).resolves.toBeNull();
  });

  it("preserves exact permissions when an aggregate assignment exceeds the public 250-entry edit limit", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: "Large MCP assignment",
      issuePrefix: `LM${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent, gatewayReader] = await db.insert(agents).values([
      { companyId: company!.id, name: "Cursor Cloud", role: "engineer", adapterType: "cursor_cloud" },
      { companyId: company!.id, name: "Gateway reader", role: "engineer", adapterType: "cursor_cloud" },
    ]).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id, applicationKey: "large-mcp", name: "Large MCP", type: "mcp_http",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id, applicationId: application!.id,
      name: "Large MCP", uid: `test/${randomUUID()}`, transport: "mcp_remote", status: "active", enabled: true,
      healthStatus: "ok",
      config: { url: "https://large.example.test/mcp" },
    }).returning();
    const catalogInput = (name: string) => ({
      companyId: company!.id, applicationId: application!.id, connectionId: connection!.id,
      name, toolName: name, versionHash: "fixture", status: "active" as const,
    });
    const catalog = await db.insert(toolCatalogEntries).values([
      ...Array.from({ length: 251 }, (_, index) => catalogInput(`allowed_${index}`)),
      catalogInput("excluded"), catalogInput("unassigned"),
    ]).returning();
    const allowed = catalog.slice(0, 251);
    const excluded = catalog[251]!;
    // Multiple valid profiles can each have fewer than 250 entries while their
    // union exceeds the HTTP edit-request limit.
    const profiles = await db.insert(toolProfiles).values(["first", "second"].map((key) => ({
      companyId: company!.id, profileKey: key, name: key, defaultAction: "deny" as const,
    }))).returning();
    await db.insert(toolProfileEntries).values([
      ...[...allowed, excluded].map((tool, index) => ({
        companyId: company!.id, profileId: profiles[index < 200 ? 0 : 1]!.id,
        selectorType: "catalog_entry" as const, effect: "include" as const,
        applicationId: application!.id, connectionId: connection!.id, catalogEntryId: tool.id,
      })),
      {
        companyId: company!.id, profileId: profiles[1]!.id,
        selectorType: "catalog_entry" as const, effect: "exclude" as const,
        applicationId: application!.id, connectionId: connection!.id, catalogEntryId: excluded.id,
      },
    ]);
    await db.insert(toolProfileBindings).values(profiles.map((profile) => ({
      companyId: company!.id, profileId: profile.id, targetType: "agent" as const, targetId: agent!.id,
    })));
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id, connectionId: connection!.id, targetType: "agent", targetId: agent!.id,
    });

    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: randomUUID() });
    expect(servers).toHaveLength(1);
    const [gateway] = await db.select().from(toolMcpGateways);
    const generatedEntries = await db.select().from(toolProfileEntries)
      .where(eq(toolProfileEntries.profileId, gateway!.profileId!));
    expect(generatedEntries).toHaveLength(251);
    expect(generatedEntries.every((entry) => entry.selectorType === "catalog_entry")).toBe(true);
    expect(generatedEntries.map((entry) => entry.catalogEntryId).sort()).toEqual(allowed.map((tool) => tool.id).sort());

    // Evaluate the generated profile independently of the original assignments,
    // including a tool discovered after the immutable profile was created.
    await db.insert(toolCatalogEntries).values(catalogInput("new_after_snapshot"));
    await db.insert(toolProfileBindings).values({
      companyId: company!.id, profileId: gateway!.profileId!, targetType: "agent", targetId: gatewayReader!.id,
    });
    const effective = await toolAccessService(db).getEffectiveProfilesForAgent(company!.id, gatewayReader!.id);
    expect(effective.allowedTools.map((tool) => tool.id).sort()).toEqual(allowed.map((tool) => tool.id).sort());
    expect(effective.allowedToolNames).not.toContain("excluded");
    expect(effective.allowedToolNames).not.toContain("unassigned");
    expect(effective.allowedToolNames).not.toContain("new_after_snapshot");

    const reused = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: randomUUID() });
    expect(reused[0]!.connectionId).toBe(servers[0]!.connectionId);
    expect(await db.select().from(toolMcpGateways)).toHaveLength(1);
  });

  it("exposes only the dedicated GitHub connection when a personal connection is also installed", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Runtime GitHub identity ${randomUUID()}`,
      issuePrefix: `RG${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Dedicated GitHub Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `github-${randomUUID().slice(0, 8)}`,
      name: "GitHub",
      type: "mcp_http",
      status: "active",
      metadata: { sourceTemplateKey: "github" },
    }).returning();
    const [personal, dedicated] = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Responsible user's GitHub",
        uid: `github/${randomUUID()}`,
        transport: "mcp_remote",
        credentialPolicy: "per_user",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: {},
        transportConfig: { sourceTemplateKey: "github" },
      },
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Dedicated GitHub",
        uid: `github/${randomUUID()}`,
        transport: "mcp_remote",
        credentialPolicy: "per_agent",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: {},
        transportConfig: { sourceTemplateKey: "github" },
      },
    ]).returning();
    await db.insert(connectionGrants).values([
      {
        companyId: company!.id,
        connectionId: personal!.id,
        kind: "user",
        subjectUserId: "responsible-user",
        status: "active",
        isDefault: false,
      },
      {
        companyId: company!.id,
        connectionId: dedicated!.id,
        kind: "agent",
        subjectAgentId: agent!.id,
        status: "active",
        isDefault: false,
      },
    ]);
    await db.insert(toolConnectionInstalls).values([
      {
        companyId: company!.id,
        connectionId: personal!.id,
        targetType: "company",
        targetId: company!.id,
      },
      {
        companyId: company!.id,
        connectionId: dedicated!.id,
        targetType: "agent",
        targetId: agent!.id,
      },
    ]);
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `github-identities:${agent!.id}`,
      name: "GitHub identities",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values([personal!, dedicated!].map((connection) => ({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection" as const,
      effect: "include" as const,
      applicationId: application!.id,
      connectionId: connection.id,
    })));
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolCatalogEntries).values({
      companyId: company!.id,
      applicationId: application!.id,
      connectionId: dedicated!.id,
      name: "create_issue",
      toolName: "create_issue",
      versionHash: "fixture",
      status: "active",
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      responsibleUserId: "responsible-user",
      contextSnapshot: {},
    }).returning();

    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: run!.id });

    expect(servers).toHaveLength(1);
    const [runtimeGateway] = await db.select().from(toolMcpGateways);
    expect(runtimeGateway).toBeTruthy();
    const runtimeEntries = await db.select().from(toolProfileEntries)
      .where(eq(toolProfileEntries.profileId, runtimeGateway!.profileId!));
    expect(runtimeEntries.map((entry) => entry.connectionId)).toEqual([dedicated!.id]);
  });

  it("audits permitted remote MCP connections that were not installed when delivery is empty", async () => {
    const [company] = await db.insert(companies).values({
      name: `Runtime MCP diagnostic ${randomUUID()}`,
      issuePrefix: `RD${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Runtime MCP Diagnostic Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `runtime-diagnostic-${randomUUID().slice(0, 8)}`,
      name: "Zapier",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id,
      applicationId: application!.id,
      name: "Zapier",
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      config: { url: "https://zapier.example.test/mcp" },
    }).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${connection!.id}`,
      name: "Zapier",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: application!.id,
      connectionId: connection!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: {},
    });

    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId });

    expect(servers).toEqual([]);
    const [activity] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.runtime_mcp_delivery"));
    expect(activity).toMatchObject({
      companyId: company!.id,
      agentId: agent!.id,
      runId,
      details: expect.objectContaining({
        reasonCode: "permitted_connections_not_installed",
        deliveredServerCount: 0,
        permittedNotInstalledCount: 1,
        permittedNotInstalledConnections: [{ id: connection!.id, name: "Zapier" }],
      }),
    });
    const [audit] = await db.select().from(toolAccessAuditEvents);
    expect(audit).toMatchObject({
      companyId: company!.id,
      actorType: "agent",
      actorId: agent!.id,
      reasonCode: "permitted_connections_not_installed",
      details: expect.objectContaining({ runId, deliveredServerCount: 0 }),
    });
  });

  it("injects only managed gateways whose profile connections are installed for the agent", async () => {
    const [company] = await db.insert(companies).values({
      name: `Managed gateway installs ${randomUUID()}`,
      issuePrefix: `MG${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Managed Gateway Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `managed-gateway-${randomUUID().slice(0, 8)}`,
      name: "Managed Gateway App",
      type: "mcp_http",
      status: "active",
    }).returning();
    const connections = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Installed gateway connection",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
      },
      {
        companyId: company!.id,
        applicationId: application!.id,
        name: "Uninstalled gateway connection",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
      },
    ]).returning();
    const profiles = await db.insert(toolProfiles).values(connections.map((connection) => ({
      companyId: company!.id,
      profileKey: `gateway:${connection.id}`,
      name: connection.name,
      defaultAction: "deny" as const,
    }))).returning();
    await db.insert(toolProfileEntries).values(profiles.map((profile, index) => ({
      companyId: company!.id,
      profileId: profile.id,
      selectorType: "connection" as const,
      effect: "include" as const,
      connectionId: connections[index]!.id,
    })));
    const gateways = await db.insert(toolMcpGateways).values(profiles.map((profile, index) => ({
      companyId: company!.id,
      name: `${connections[index]!.name} gateway`,
      slug: `gateway-${index}-${randomUUID().slice(0, 8)}`,
      profileId: profile.id,
      status: "active" as const,
    }))).returning();
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id,
      connectionId: connections[0]!.id,
      targetType: "agent",
      targetId: agent!.id,
    });

    const config = await createManagedMcpRunConfig({
      db,
      agent: agent!,
      runId: randomUUID(),
      config: {},
      projectId: null,
      issueId: null,
    });

    expect(config?.gateways).toHaveLength(1);
    expect(config?.gateways[0]).toMatchObject({
      id: gateways[0]!.id,
      name: gateways[0]!.name,
      endpointPath: `/mcp/gateways/${gateways[0]!.gatewayPublicId}`,
    });
    expect(config?.gateways.some((gateway) => gateway.id === gateways[1]!.id)).toBe(false);
  });

  it("emits no runtime MCP server and mints no token when agent has assigned connection but empty assigned tools", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Empty assigned tools ${randomUUID()}`,
      issuePrefix: `EA${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Empty Tools Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [app, otherApp] = await db.insert(toolApplications).values([
      {
        companyId: company!.id,
        applicationKey: `app-${randomUUID().slice(0, 8)}`,
        name: "App",
        type: "mcp_http",
        status: "active",
      },
      {
        companyId: company!.id,
        applicationKey: `other-app-${randomUUID().slice(0, 8)}`,
        name: "Other App",
        type: "mcp_http",
        status: "active",
      },
    ]).returning();
    const [connection, otherConnection] = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: app!.id,
        name: "Connection",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { url: "https://example.test/mcp" },
      },
      {
        companyId: company!.id,
        applicationId: otherApp!.id,
        name: "Other Connection",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { url: "https://example.test/mcp" },
      },
    ]).returning();
    const [otherTool] = await db.insert(toolCatalogEntries).values({
      companyId: company!.id,
      applicationId: otherApp!.id,
      connectionId: otherConnection!.id,
      name: "other_tool",
      toolName: "other_tool",
      versionHash: "fixture",
      status: "active",
    }).returning();

    // Profile grants a tool on otherConnection, but only connection is installed for agent
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${connection!.id}`,
      name: "Connection",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "catalog_entry",
      effect: "include",
      applicationId: otherApp!.id,
      connectionId: otherConnection!.id,
      catalogEntryId: otherTool!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id,
      connectionId: connection!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    const runId = randomUUID();
    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId });
    expect(servers).toEqual([]);
    const tokens = await db.select().from(toolMcpGatewayTokens);
    expect(tokens).toHaveLength(0);
    const gateways = await db.select().from(toolMcpGateways);
    expect(gateways).toHaveLength(0);
  });

  it("emits no runtime MCP server and mints no token when assigned connection has no visible tools in catalog", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `No visible tools ${randomUUID()}`,
      issuePrefix: `NV${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "No Visible Tools Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `app-${randomUUID().slice(0, 8)}`,
      name: "App",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id,
      applicationId: application!.id,
      name: "Connection",
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: { url: "https://example.test/mcp" },
    }).returning();
    // Full connection grant, but zero catalog entries exist
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${connection!.id}`,
      name: "Connection",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: application!.id,
      connectionId: connection!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id,
      connectionId: connection!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    const runId = randomUUID();
    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId });
    expect(servers).toEqual([]);
    const tokens = await db.select().from(toolMcpGatewayTokens);
    expect(tokens).toHaveLength(0);
    const gateways = await db.select().from(toolMcpGateways);
    expect(gateways).toHaveLength(0);
  });

  it("ensures Hermes allowlist equals gateway tools/list surface for on-demand and mixed assignments", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `On-Demand & Mixed MCP ${randomUUID()}`,
      issuePrefix: `OD${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "On-Demand Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [appRegular, appOnDemand] = await db.insert(toolApplications).values([
      {
        companyId: company!.id,
        applicationKey: `regular-${randomUUID().slice(0, 8)}`,
        name: "Regular App",
        type: "mcp_http",
        status: "active",
      },
      {
        companyId: company!.id,
        applicationKey: `ondemand-${randomUUID().slice(0, 8)}`,
        name: "OnDemand App",
        type: "mcp_http",
        status: "active",
      },
    ]).returning();
    const [connRegular, connOnDemand] = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: appRegular!.id,
        name: "Regular MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { url: "https://regular.example.test/mcp" },
      },
      {
        companyId: company!.id,
        applicationId: appOnDemand!.id,
        name: "OnDemand MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { url: "https://ondemand.example.test/mcp", onDemandTools: { enabled: true } },
      },
    ]).returning();

    const [toolRegular, toolOnDemand] = await db.insert(toolCatalogEntries).values([
      {
        companyId: company!.id,
        applicationId: appRegular!.id,
        connectionId: connRegular!.id,
        name: "regular_tool",
        toolName: "regular_tool",
        versionHash: "fixture",
        status: "active",
      },
      {
        companyId: company!.id,
        applicationId: appOnDemand!.id,
        connectionId: connOnDemand!.id,
        name: "ondemand_tool",
        toolName: "ondemand_tool",
        versionHash: "fixture",
        status: "active",
      },
    ]).returning();

    // 1. Test purely on-demand assignment
    const [profileOnDemand] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${connOnDemand!.id}`,
      name: "OnDemand MCP",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profileOnDemand!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: appOnDemand!.id,
      connectionId: connOnDemand!.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profileOnDemand!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id,
      connectionId: connOnDemand!.id,
      targetType: "agent",
      targetId: agent!.id,
    });

    const runId1 = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId1,
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: {},
    });
    const serversOnDemand = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: runId1 });
    expect(serversOnDemand).toHaveLength(1);
    expect(serversOnDemand[0]!.allowedTools).toEqual(["run_tool", "search_tools"]);

    const gatewayPublicIdOnDemand = serversOnDemand[0]!.url.slice(serversOnDemand[0]!.url.lastIndexOf("/") + 1);
    const gatewayService = createToolGatewayService(db);
    const listResultOnDemand = await gatewayService.listToolsForNamedGateway({
      gatewayPublicId: gatewayPublicIdOnDemand,
      bearerToken: serversOnDemand[0]!.token,
    });
    const visibleToolNamesOnDemand = [
      ...listResultOnDemand.tools.map((t) => t.name),
      ...listResultOnDemand.contextTools.map((t) => t.name),
    ].sort();
    expect(visibleToolNamesOnDemand).toEqual(serversOnDemand[0]!.allowedTools.slice().sort());
    expect(visibleToolNamesOnDemand.some((t) => t.includes("ondemand-tool"))).toBe(false);

    // 2. Test mixed assignment (regular + ondemand)
    await db.insert(toolProfileEntries).values({
      companyId: company!.id,
      profileId: profileOnDemand!.id,
      selectorType: "connection",
      effect: "include",
      applicationId: appRegular!.id,
      connectionId: connRegular!.id,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id,
      connectionId: connRegular!.id,
      targetType: "agent",
      targetId: agent!.id,
    });

    const runId2 = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId2,
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: {},
    });
    const serversMixed = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId: runId2 });
    expect(serversMixed).toHaveLength(1);
    expect(serversMixed[0]!.allowedTools).toContain("run_tool");
    expect(serversMixed[0]!.allowedTools).toContain("search_tools");
    expect(serversMixed[0]!.allowedTools.some((t) => t.includes("regular-tool"))).toBe(true);

    const gatewayPublicIdMixed = serversMixed[0]!.url.slice(serversMixed[0]!.url.lastIndexOf("/") + 1);
    const listResultMixed = await gatewayService.listToolsForNamedGateway({
      gatewayPublicId: gatewayPublicIdMixed,
      bearerToken: serversMixed[0]!.token,
    });
    const visibleToolNamesMixed = [
      ...listResultMixed.tools.map((t) => t.name),
      ...listResultMixed.contextTools.map((t) => t.name),
    ].sort();
    expect(visibleToolNamesMixed).toEqual(serversMixed[0]!.allowedTools.slice().sort());
    expect(visibleToolNamesMixed.some((t) => t.includes("ondemand-tool"))).toBe(false);
  });

  it("maintains gateway tools/list parity when assigned connections are unhealthy", async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Unhealthy MCP ${randomUUID()}`,
      issuePrefix: `UH${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Unhealthy Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [appRegular, appOnDemand] = await db.insert(toolApplications).values([
      {
        companyId: company!.id,
        applicationKey: `uh-reg-${randomUUID().slice(0, 8)}`,
        name: "UH Regular App",
        type: "mcp_http",
        status: "active",
      },
      {
        companyId: company!.id,
        applicationKey: `uh-od-${randomUUID().slice(0, 8)}`,
        name: "UH OnDemand App",
        type: "mcp_http",
        status: "active",
      },
    ]).returning();
    const [connHealthy, connUnhealthyOnDemand] = await db.insert(toolConnections).values([
      {
        companyId: company!.id,
        applicationId: appRegular!.id,
        name: "Healthy Regular MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { url: "https://healthy.example.test/mcp" },
      },
      {
        companyId: company!.id,
        applicationId: appOnDemand!.id,
        name: "Unhealthy OnDemand MCP",
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "error",
        config: { url: "https://unhealthy-od.example.test/mcp", onDemandTools: { enabled: true } },
      },
    ]).returning();

    await db.insert(toolCatalogEntries).values([
      {
        companyId: company!.id,
        applicationId: appRegular!.id,
        connectionId: connHealthy!.id,
        name: "healthy_tool",
        toolName: "healthy_tool",
        versionHash: "fixture",
        status: "active",
      },
      {
        companyId: company!.id,
        applicationId: appOnDemand!.id,
        connectionId: connUnhealthyOnDemand!.id,
        name: "unhealthy_ondemand_tool",
        toolName: "unhealthy_ondemand_tool",
        versionHash: "fixture",
        status: "active",
      },
    ]);

    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `app:${connHealthy!.id}`,
      name: "Mixed Profile",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values([
      {
        companyId: company!.id,
        profileId: profile!.id,
        selectorType: "connection",
        effect: "include",
        applicationId: appRegular!.id,
        connectionId: connHealthy!.id,
      },
      {
        companyId: company!.id,
        profileId: profile!.id,
        selectorType: "connection",
        effect: "include",
        applicationId: appOnDemand!.id,
        connectionId: connUnhealthyOnDemand!.id,
      },
    ]);
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolConnectionInstalls).values([
      {
        companyId: company!.id,
        connectionId: connHealthy!.id,
        targetType: "agent",
        targetId: agent!.id,
      },
      {
        companyId: company!.id,
        connectionId: connUnhealthyOnDemand!.id,
        targetType: "agent",
        targetId: agent!.id,
      },
    ]);

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: {},
    });

    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.allowedTools).not.toContain("search_tools");
    expect(servers[0]!.allowedTools).not.toContain("run_tool");
    expect(servers[0]!.allowedTools.some((t) => t.includes("healthy-tool"))).toBe(true);

    const gatewayPublicId = servers[0]!.url.slice(servers[0]!.url.lastIndexOf("/") + 1);
    const gatewayService = createToolGatewayService(db);
    const listResult = await gatewayService.listToolsForNamedGateway({
      gatewayPublicId,
      bearerToken: servers[0]!.token,
    });
    const visibleToolNames = [
      ...listResult.tools.map((t) => t.name),
      ...listResult.contextTools.map((t) => t.name),
    ].sort();

    expect(visibleToolNames).toEqual(servers[0]!.allowedTools.slice().sort());
    expect(visibleToolNames.some((t) => t.includes("unhealthy"))).toBe(false);
  });
});
