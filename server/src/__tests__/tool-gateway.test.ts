import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const actualDefaultMcpInstallGate = await vi.importActual<typeof import("../services/default-mcp-install-gate.js")>(
  "../services/default-mcp-install-gate.js",
);

vi.mock("../services/default-mcp-install-gate.js", async (orig) => {
  const a = await orig<typeof import("../services/default-mcp-install-gate.js")>();
  return { ...a, managedInstallCheck: vi.fn(a.managedInstallCheck) };
});

import { managedInstallCheck } from "../services/default-mcp-install-gate.js";
import {
  activityLog,
  agents,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  companyMemberships,
  companies,
  connectionGrantMembers,
  connectionGrantDelegations,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  projects,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCatalogEntries,
  toolCallEvents,
  toolConnectionInstalls,
  toolConnections,
  toolGatewayRateLimitCounters,
  toolGatewaySessions,
  toolInvocations,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolStdioCommandTemplates,
  toolRuntimeSlots,
  secretAccessEvents,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import {
  canonicalToolArguments,
  readSignedToolArgumentsPayload,
  signToolArguments,
  summarizeToolValue,
} from "../services/tool-content-guards.js";
import { createToolGatewayService, ToolGatewayHttpError } from "../services/tool-gateway.js";
import type { ComposioClient } from "../services/composio.js";
import { secretService } from "../services/secrets.js";
import * as appDefinitions from "@paperclipai/shared";
import { createKvDemoHttpServer, type KvDemoHttpServer } from "../../../packages/kv-demo-mcp-server/src/http.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const testToolActionSigningSecret = "test-tool-action-signing-secret";

type Db = ReturnType<typeof createDb>;
type ToolGatewayServiceOptions = NonNullable<Parameters<typeof createToolGatewayService>[1]>;

/**
 * TECH-7276: shared cleanup for the `managedInstallCheck` mock. `mockClear()` only wipes call
 * history — verified against the installed @vitest/spy (4.1.11), a queued `mockImplementationOnce`
 * survives both `mockClear()` and a fresh `mockImplementation()`. A scenario that fails before the
 * gateway consumes its queued once would therefore leak the stale callback into the next test,
 * where the first gate call would run it against rows this suite's cleanup already deleted.
 * `mockReset()` clears the once queue AND the history, and the follow-up `mockImplementation()`
 * restores the real gate as the pass-through implementation. Both cleanup paths (the suite
 * afterEach and the raw-backstop finally) use this helper so the reset is testable directly.
 */
function resetManagedInstallCheckMock() {
  vi.mocked(managedInstallCheck).mockReset().mockImplementation(actualDefaultMcpInstallGate.managedInstallCheck);
}

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `Gateway ${randomUUID()}`,
      issuePrefix: `TG${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string, permissions: Record<string, unknown> = {}) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssueAndRun(db: Db, companyId: string, agentId: string) {
  const project = await db
    .insert(projects)
    .values({ companyId, name: `Project ${randomUUID()}` })
    .returning()
    .then((rows) => rows[0]!);
  const issue = await db
    .insert(issues)
    .values({
      companyId,
      projectId: project.id,
      title: `Gateway issue ${randomUUID()}`,
      status: "in_progress",
      assigneeAgentId: agentId,
    })
    .returning()
    .then((rows) => rows[0]!);
  const run = await db
    .insert(heartbeatRuns)
    .values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue.id, projectId: project.id },
    })
    .returning()
    .then((rows) => rows[0]!);
  return { project, issue, run };
}

async function createActiveMember(db: Db, companyId: string, userId: string) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "member",
  });
}

async function allowToolsForAgent(db: Db, companyId: string, agentId: string, toolNames: string[]) {
  const profile = await db
    .insert(toolProfiles)
    .values({
      companyId,
      profileKey: `gateway-${randomUUID()}`,
      name: `Gateway profile ${randomUUID()}`,
      defaultAction: "deny",
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(toolProfileBindings).values({
    companyId,
    profileId: profile.id,
    targetType: "agent",
    targetId: agentId,
  });
  if (toolNames.length > 0) {
    await db.insert(toolProfileEntries).values(toolNames.map((toolName) => ({
      companyId,
      profileId: profile.id,
      selectorType: "tool_name" as const,
      effect: "include" as const,
      toolName,
    })));
  }
  return profile;
}

async function allowAllToolsForAgent(db: Db, companyId: string, agentId: string) {
  const profile = await db
    .insert(toolProfiles)
    .values({
      companyId,
      profileKey: `gateway-all-${randomUUID()}`,
      name: `Gateway all profile ${randomUUID()}`,
      defaultAction: "allow",
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(toolProfileBindings).values({
    companyId,
    profileId: profile.id,
    targetType: "agent",
    targetId: agentId,
  });
  return profile;
}

async function createRemoteMcpTool(
  db: Db,
  companyId: string,
  input: {
    applicationKey?: string | null;
    connectionName?: string;
    url?: string;
    toolName?: string;
    title?: string | null;
    connectionEnabled?: boolean;
    connectionStatus?: "draft" | "active" | "disabled" | "archived";
    healthStatus?: "unknown" | "healthy" | "degraded" | "failed" | "unchecked" | "ok" | "error" | "missing_secret";
    catalogStatus?: "active" | "disabled" | "quarantined" | "removed";
    quarantinedAt?: Date | null;
    credentialRefs?: typeof toolConnections.$inferInsert["credentialRefs"];
    credentialSecretRefs?: typeof toolConnections.$inferInsert["credentialSecretRefs"];
    riskLevel?: "read" | "write" | "destructive";
    stdioScript?: string;
    envKeys?: string[];
    connectionConfig?: Record<string, unknown>;
  } = {},
) {
  const applicationKey = input.applicationKey ?? `app-${randomUUID().slice(0, 8)}`;
  let application = await db
    .select()
    .from(toolApplications)
    .where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.applicationKey, applicationKey)))
    .limit(1)
    .then((rows) => rows[0]);
  if (!application) {
    [application] = await db.insert(toolApplications).values({
      companyId,
      applicationKey,
      name: `Remote app ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    }).returning();
  }
  const [connection] = await db.insert(toolConnections).values({
    companyId,
    applicationId: application.id,
    name: input.connectionName ?? `Remote connection ${randomUUID()}`,
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: input.connectionStatus ?? "active",
    enabled: input.connectionEnabled ?? true,
    healthStatus: input.healthStatus ?? "ok",
    config: { url: input.url ?? "https://mcp.example.test/mcp", ...(input.connectionConfig ?? {}) },
    transportConfig: { url: input.url ?? "https://mcp.example.test/mcp", ...(input.connectionConfig ?? {}) },
    credentialRefs: input.credentialRefs ?? [],
    credentialSecretRefs: input.credentialSecretRefs ?? [],
  }).returning();
  await db.insert(connectionGrants).values({
    companyId,
    connectionId: connection.id,
    kind: "organization",
    credentialSecretRefs: connection.credentialSecretRefs,
    status: "active",
    isDefault: true,
  });
  if (input.credentialRefs?.length || input.credentialSecretRefs?.length) {
    await db.insert(companySecretBindings).values([
      ...(input.credentialRefs ?? []).map((ref) => ({
        companyId,
        secretId: ref.secretId,
        targetType: "tool_connection" as const,
        targetId: connection!.id,
        configPath: `credentials.${ref.name}`,
      })),
      ...(input.credentialSecretRefs ?? []).map((ref) => ({
        companyId,
        secretId: ref.secretId,
        targetType: "tool_connection" as const,
        targetId: connection!.id,
        configPath: ref.configPath,
        versionSelector: String(ref.versionSelector ?? "latest"),
        required: ref.required ?? true,
        label: ref.label ?? null,
      })),
    ]).onConflictDoNothing();
  }
  const toolName = input.toolName ?? "kv_set";
  const [catalogEntry] = await db.insert(toolCatalogEntries).values({
    companyId,
    applicationId: application.id,
    connectionId: connection!.id,
    entryKind: "tool",
    name: `${toolName}-${randomUUID()}`,
    toolName,
    title: input.title ?? "KV Set",
    description: `Call ${toolName}`,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    riskLevel: input.riskLevel ?? "write",
    isReadOnly: (input.riskLevel ?? "write") === "read",
    isWrite: (input.riskLevel ?? "write") === "write",
    isDestructive: (input.riskLevel ?? "write") === "destructive",
    status: input.catalogStatus ?? "active",
    versionHash: randomUUID(),
    quarantinedAt: input.quarantinedAt ?? null,
  }).returning();
  return { application, connection: connection!, catalogEntry: catalogEntry! };
}

async function createLocalStdioMcpTool(
  db: Db,
  companyId: string,
  input: {
    applicationKey?: string | null;
    connectionName?: string;
    toolName?: string;
    title?: string | null;
    connectionEnabled?: boolean;
    connectionStatus?: "draft" | "active" | "disabled" | "archived";
    healthStatus?: "unknown" | "healthy" | "degraded" | "failed" | "unchecked" | "ok" | "error" | "missing_secret";
    catalogStatus?: "active" | "disabled" | "quarantined" | "removed";
    riskLevel?: "read" | "write" | "destructive";
    credentialPolicy?: "shared" | "per_user" | "per_user_with_fallback";
    credentialSecretRefs?: typeof toolConnections.$inferInsert["credentialSecretRefs"];
    stdioScript?: string;
    envKeys?: string[];
    connectionConfig?: Record<string, unknown>;
  } = {},
) {
  const applicationKey = input.applicationKey ?? `local-app-${randomUUID().slice(0, 8)}`;
  const [application] = await db.insert(toolApplications).values({
    companyId,
    applicationKey,
    name: `Local stdio app ${randomUUID()}`,
    type: "mcp_stdio",
    status: "active",
  }).returning();
  const toolName = input.toolName ?? "echo";
  const templateKey = `test.local-stdio.${randomUUID()}`;
  const stdioScript = input.stdioScript ?? `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test-stdio", version: "0.0.0" } } }) + "\\n");
    return;
  }
  if (message.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "local:" + String(message.params?.arguments?.message ?? "") }], structuredContent: { echoed: message.params?.arguments?.message ?? null } } }) + "\\n");
  }
});
`;
  await db.insert(toolStdioCommandTemplates).values({
    companyId,
    templateKey,
    name: `Local stdio template ${randomUUID()}`,
    command: process.execPath,
    args: ["-e", stdioScript],
    envKeys: input.envKeys ?? [],
    tools: [
      {
        name: toolName,
        title: input.title ?? "Local Echo",
        description: `Call ${toolName}`,
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
    ],
  });
  const [connection] = await db.insert(toolConnections).values({
    companyId,
    applicationId: application!.id,
    name: input.connectionName ?? `Local stdio connection ${randomUUID()}`,
    uid: `test/${randomUUID()}`,
    transport: "local_stdio",
    status: input.connectionStatus ?? "active",
    enabled: input.connectionEnabled ?? true,
    healthStatus: input.healthStatus ?? "ok",
    credentialPolicy: input.credentialPolicy ?? "shared",
    config: { templateId: templateKey, ...(input.connectionConfig ?? {}) },
    transportConfig: { templateId: templateKey, ...(input.connectionConfig ?? {}) },
    credentialSecretRefs: input.credentialSecretRefs ?? [],
  }).returning();
  await db.insert(connectionGrants).values({
    companyId,
    connectionId: connection.id,
    kind: "organization",
    credentialSecretRefs: connection.credentialSecretRefs,
    status: "active",
    isDefault: true,
  });
  if (input.credentialSecretRefs?.length) {
    await db.insert(companySecretBindings).values(input.credentialSecretRefs.map((ref) => ({
      companyId,
      secretId: ref.secretId,
      targetType: "tool_connection" as const,
      targetId: connection.id,
      configPath: ref.configPath,
      versionSelector: String(ref.versionSelector ?? "latest"),
      required: ref.required ?? true,
      label: ref.label ?? null,
    }))).onConflictDoNothing();
  }
  const [catalogEntry] = await db.insert(toolCatalogEntries).values({
    companyId,
    applicationId: application!.id,
    connectionId: connection!.id,
    entryKind: "tool",
    name: `${toolName}-${randomUUID()}`,
    toolName,
    title: input.title ?? "Local Echo",
    description: `Call ${toolName}`,
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    riskLevel: input.riskLevel ?? "read",
    isReadOnly: (input.riskLevel ?? "read") === "read",
    isWrite: (input.riskLevel ?? "read") === "write",
    isDestructive: (input.riskLevel ?? "read") === "destructive",
    status: input.catalogStatus ?? "active",
    versionHash: randomUUID(),
  }).returning();
  return { application: application!, connection: connection!, catalogEntry: catalogEntry!, templateKey };
}

function expectedConnectedToolName(input: { applicationKey: string | null; connectionId: string; toolName: string }) {
  const applicationSegment = (input.applicationKey ?? "mcp")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "mcp";
  const toolSegment = input.toolName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "tool";
  return `mcp.${applicationSegment}-${input.connectionId.replace(/-/g, "").slice(0, 8)}:${toolSegment}`;
}

const RH_MCP_READ_TOOLS = [
  "mdm_granola_status",
  "mdm_list_my_granola_notes",
  "mdm_list_shared_granola_notes",
  "mdm_get_granola_note",
  "mdm_get_granola_transcript",
];
const RH_MCP_WRITE_TOOLS = ["mdm_erase_granola_note", "mdm_disconnect_granola", "mdm_write_annotation"];

/**
 * TECH-7276: a personal `rh-mcp-personal` connection exposing the five read tools plus writers, with the
 * responsible user's own OAuth grant. `tagged: false` models a same-named connection that is NOT the template.
 */
async function seedRhMcpPersonal(
  db: Db,
  companyId: string,
  input: { url: string; userId: string; tagged?: boolean; onDemand?: boolean; name?: string },
) {
  const remote = await createRemoteMcpTool(db, companyId, {
    applicationKey: "rh-mcp-personal",
    connectionName: input.name ?? "rh-mcp-personal",
    toolName: RH_MCP_READ_TOOLS[0]!,
    url: input.url,
    riskLevel: "read",
  });
  const config = {
    url: input.url,
    identityModel: "personal_only",
    ...(input.tagged === false ? {} : { paperclipDefaultMcpEntry: "rh-mcp" }),
    ...(input.onDemand ? { onDemandTools: { enabled: true } } : {}),
  };
  await db
    .update(toolConnections)
    .set({ authKind: "oauth", credentialPolicy: "per_user", config, transportConfig: config })
    .where(eq(toolConnections.id, remote.connection.id));
  const entries = [remote.catalogEntry];
  for (const toolName of [...RH_MCP_READ_TOOLS.slice(1), ...RH_MCP_WRITE_TOOLS]) {
    const [entry] = await db.insert(toolCatalogEntries).values({
      companyId,
      applicationId: remote.application.id,
      connectionId: remote.connection.id,
      entryKind: "tool",
      name: `${toolName}-${randomUUID()}`,
      toolName,
      title: toolName,
      description: `Call ${toolName}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      riskLevel: "read",
      isReadOnly: true,
      isWrite: false,
      isDestructive: false,
      status: "active",
      versionHash: randomUUID(),
    }).returning();
    entries.push(entry!);
  }
  const personalToken = `personal-rh-mcp-${randomUUID()}`;
  const secret = await secretService(db).create(companyId, {
    name: `Personal RH MCP token ${randomUUID()}`,
    key: `personal_rh_mcp_${randomUUID().replace(/-/g, "")}`,
    provider: "local_encrypted",
    value: personalToken,
  });
  const [grant] = await db.insert(connectionGrants).values({
    companyId,
    connectionId: remote.connection.id,
    kind: "user",
    subjectUserId: input.userId,
    status: "active",
    credentialSecretRefs: [{
      secretId: secret.id,
      versionSelector: "latest",
      configPath: "oauth.access_token",
      required: true,
      label: "Access token",
    }],
  }).returning();
  await db.insert(companySecretBindings).values({
    companyId,
    secretId: secret.id,
    targetType: "connection_grant",
    targetId: grant!.id,
    configPath: "oauth.access_token",
  });
  const nameOf = (toolName: string) =>
    expectedConnectedToolName({
      applicationKey: remote.application.applicationKey,
      connectionId: remote.connection.id,
      toolName,
    });
  return { ...remote, entries, personalToken, nameOf };
}

async function createRunForResponsibleUser(db: Db, companyId: string, agentId: string, userId: string) {
  const { run } = await createIssueAndRun(db, companyId, agentId);
  await createActiveMember(db, companyId, userId);
  await db.update(heartbeatRuns)
    .set({ responsibleUserId: userId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId: userId } })
    .where(eq(heartbeatRuns.id, run.id));
  return run;
}

function expectGatewayError(error: unknown, status: number, reasonCode: string) {
  expect(error).toBeInstanceOf(ToolGatewayHttpError);
  const gatewayError = error as ToolGatewayHttpError;
  expect(gatewayError.status).toBe(status);
  expect(gatewayError.reasonCode).toBe(reasonCode);
}

function tamperToken(token: string) {
  const replacement = token.endsWith("A") ? "B" : "A";
  return `${token.slice(0, -1)}${replacement}`;
}

function createTestToolGatewayService(db: Db, options: ToolGatewayServiceOptions = {}) {
  return createToolGatewayService(db, {
    ...options,
    toolActionSigningSecret: options.toolActionSigningSecret ?? testToolActionSigningSecret,
  });
}

function createGatewayRouteApp(
  db: Db,
  gateway = createTestToolGatewayService(db),
  actor?: Express.Request["actor"],
) {
  const app = express();
  app.use(express.json());
  if (actor) {
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
  }
  app.use(mcpGatewayProtocolRoutes(gateway));
  app.use("/api", toolGatewayRoutes(db, gateway));
  return app;
}

type FakeMcpRequest = {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
};

async function startFakeRemoteMcpServer(handler: (request: FakeMcpRequest) => Promise<{
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}> | {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}) {
  const requests: FakeMcpRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      } catch {
        body = null;
      }
      const requestRecord = { headers: req.headers, body };
      requests.push(requestRecord);
      const response = await handler(requestRecord);
      if (response.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      }
      res.statusCode = response.status ?? 200;
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        res.setHeader(key, value);
      }
      if (response.rawBody !== undefined) {
        res.end(response.rawBody);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(response.body ?? {
          jsonrpc: "2.0",
          id: body?.id ?? "test",
          result: { content: [{ type: "text", text: "ok" }] },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fake MCP server address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

describeEmbeddedPostgres("tool gateway acceptance", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gateway-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    resetManagedInstallCheckMock();
    await db.delete(activityLog);
    await db.delete(toolCallEvents);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolGatewaySessions);
    await db.delete(toolGatewayRateLimitCounters);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolPolicies);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(secretAccessEvents);
    await db.delete(userSecretDeclarations);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("exposes a named gateway with scoped bearer-token auth and revocation", async () => {
    const company = await createCompany(db);
    const remote = await startFakeRemoteMcpServer(async () => ({
      body: {
        jsonrpc: "2.0",
        id: "test",
        result: { content: [{ type: "text", text: "read ok" }], structuredContent: { ok: true } },
      },
    }));
    try {
      const { application, connection, catalogEntry } = await createRemoteMcpTool(db, company.id, {
        url: remote.url,
        applicationKey: "named-gateway-app",
        toolName: "read_note",
        title: "Read note",
        riskLevel: "read",
      });
      const gatewayToolName = expectedConnectedToolName({
        applicationKey: application.applicationKey,
        connectionId: connection.id,
        toolName: catalogEntry.toolName,
      });
      const [profile] = await db.insert(toolProfiles).values({
        companyId: company.id,
        profileKey: `named-gateway-${randomUUID()}`,
        name: `Named gateway ${randomUUID()}`,
        defaultAction: "deny",
      }).returning();
      await db.insert(toolProfileEntries).values({
        companyId: company.id,
        profileId: profile.id,
        selectorType: "tool_name",
        effect: "include",
        toolName: gatewayToolName,
      });

      const gateway = createTestToolGatewayService(db);
      const created = await gateway.createNamedGateway({
        companyId: company.id,
        body: { name: "External reader", profileId: profile.id },
      });
      expect(created.gatewayPublicId).toMatch(/^gw_[a-f0-9]{32}$/);
      expect(created.endpointPath).toBe(`/mcp/gateways/${created.gatewayPublicId}`);
      expect(created.clientSnippets.length).toBeGreaterThan(0);
      const token = await gateway.createNamedGatewayToken({
        companyId: company.id,
        gatewayId: created.id,
        body: { name: "Cursor", clientLabel: "Cursor desktop", ownerNote: "QA fixture token" },
      });
      expect(token.subjectType).toBe("gateway_client");
      expect(token.clientLabel).toBe("Cursor desktop");
      expect(token.ownerNote).toBe("QA fixture token");
      expect(token.tokenPrefix).toMatch(/^pcgw_[a-f0-9]{8}$/);

      const app = createGatewayRouteApp(db, gateway);
      const publicEndpoint = created.endpointPath;
      const queryOnly = await request(app)
        .post(`${publicEndpoint}?paperclip_capability=${encodeURIComponent(token.token)}`)
        .send({ jsonrpc: "2.0", id: "query-only", method: "tools/list" })
        .expect(401);
      expect(queryOnly.body.error).toBe("Bearer token is required");

      const listed = await request(app)
        .post(publicEndpoint)
        .set("authorization", `Bearer ${token.token}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        .expect(200);
      const visibleToolNames = listed.body.result.tools.map((tool: { name: string }) => tool.name);
      expect(visibleToolNames).toContain(gatewayToolName);
      expect(visibleToolNames).not.toContain("mcp-remote-fixture:update_note");

      const toolOnlyResources = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${token.token}`)
        .send({ jsonrpc: "2.0", id: "resources", method: "resources/list" })
        .expect(200);
      expect(toolOnlyResources.body.result.resources).toEqual([]);

      const called = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${token.token}`)
        .send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: gatewayToolName, arguments: { key: "a", value: "b" } },
        })
        .expect(200);
      expect(called.body.result.content).toEqual([{ type: "text", text: "read ok" }]);
      const upstreamRequestCountAfterAllowedCall = remote.requests.length;

      const denied = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${token.token}`)
        .send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "mcp-remote-fixture:update_note", arguments: { noteId: "n1", body: "blocked" } },
        })
        .expect(403);
      expect(denied.body.error.data.reasonCode).toBe("deny_default");
      expect(remote.requests.length).toBe(upstreamRequestCountAfterAllowedCall);
      const deniedAuditRows = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, "tool_gateway.call_completed")));
      expect(JSON.stringify(deniedAuditRows)).not.toContain("blocked");

      const listOnlyToken = await gateway.createNamedGatewayToken({
        companyId: company.id,
        gatewayId: created.id,
        body: {
          name: "Discovery only",
          clientLabel: "Discovery client",
          ownerNote: "List-only regression token",
          allowedActions: ["tools/list"],
        },
      });
      await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${listOnlyToken.token}`)
        .send({ jsonrpc: "2.0", id: 4, method: "tools/list" })
        .expect(200);
      const scopedDenied = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${listOnlyToken.token}`)
        .send({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: gatewayToolName, arguments: { key: "a", value: "b" } },
        })
        .expect(403);
      expect(scopedDenied.body.error.data.reasonCode).toBe("gateway_token_action_denied");

      await gateway.revokeNamedGatewayToken({ companyId: company.id, tokenId: token.id });
      const revoked = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${token.token}`)
        .send({ jsonrpc: "2.0", id: 6, method: "tools/list" })
        .expect(401);
      expect(revoked.body.error.data.reasonCode).toBe("gateway_token_revoked");
    } finally {
      await remote.close();
    }
  });

  it("keeps additive app-gallery assignments out of gateway-only runtimes", async () => {
    const company = await createCompany(db);
    const assigned = await createRemoteMcpTool(db, company.id, {
      applicationKey: "gateway-assigned-app",
      connectionName: "Dedicated GitHub identity",
      toolName: "get_me",
      riskLevel: "read",
    });
    const unassigned = await createRemoteMcpTool(db, company.id, {
      applicationKey: "gateway-unassigned-app",
      connectionName: "Personal GitHub identity",
      toolName: "get_me",
      riskLevel: "read",
    });
    const assignedToolName = expectedConnectedToolName({
      applicationKey: assigned.application.applicationKey,
      connectionId: assigned.connection.id,
      toolName: assigned.catalogEntry.toolName,
    });
    const unassignedToolName = expectedConnectedToolName({
      applicationKey: unassigned.application.applicationKey,
      connectionId: unassigned.connection.id,
      toolName: unassigned.catalogEntry.toolName,
    });
    const [gatewayProfile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `runtime-gateway-${randomUUID()}`,
      name: "Resolved runtime identity",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: gatewayProfile.id,
      selectorType: "connection",
      effect: "include",
      connectionId: assigned.connection.id,
    });
    const [appProfile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `app:${unassigned.connection.id}`,
      name: "Personal GitHub",
      defaultAction: "deny",
      metadata: { source: "app_gallery_finish", connectionId: unassigned.connection.id },
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: appProfile.id,
      selectorType: "connection",
      effect: "include",
      connectionId: unassigned.connection.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company.id,
      profileId: appProfile.id,
      targetType: "company",
      targetId: company.id,
      priority: 100,
      metadata: { source: "app_gallery_finish" },
    });

    const gateway = createTestToolGatewayService(db);
    const created = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: "Resolved runtime GitHub",
        profileId: gatewayProfile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: created.id,
      body: { name: "Runtime token" },
    });
    const app = createGatewayRouteApp(db, gateway);

    const listed = await request(app)
      .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
      .set("authorization", `Bearer ${token.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(200);
    const visibleToolNames = listed.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(visibleToolNames).toContain(assignedToolName);
    expect(visibleToolNames).not.toContain(unassignedToolName);

    const denied = await request(app)
      .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
      .set("authorization", `Bearer ${token.token}`)
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: unassignedToolName, arguments: {} },
      })
      .expect(403);
    expect(denied.body.error.data.reasonCode).toBe("deny_default");
  });

  it("proxies namespaced resources and prompts only for fully assigned MCP connections", async () => {
    const company = await createCompany(db);
    const remote = await startFakeRemoteMcpServer(async ({ body }) => {
      const method = body?.method;
      if (method === "resources/list") {
        return { body: { jsonrpc: "2.0", id: body?.id, result: { resources: [{ uri: "notes://one", name: "Note one", mimeType: "text/plain" }] } } };
      }
      if (method === "resources/read") {
        return { body: { jsonrpc: "2.0", id: body?.id, result: { contents: [{ uri: String((body?.params as Record<string, unknown>)?.uri), mimeType: "text/plain", text: "resource body" }] } } };
      }
      if (method === "prompts/list") {
        return { body: { jsonrpc: "2.0", id: body?.id, result: { prompts: [{ name: "summarize", title: "Summarize note" }] } } };
      }
      if (method === "prompts/get") {
        return { body: { jsonrpc: "2.0", id: body?.id, result: { description: "Summary prompt", messages: [{ role: "user", content: { type: "text", text: "Summarize it" } }] } } };
      }
      return { body: { jsonrpc: "2.0", id: body?.id, result: {} } };
    });
    try {
      const assigned = await createRemoteMcpTool(db, company.id, {
        url: remote.url,
        applicationKey: "context-app",
        connectionName: "Assigned context",
        toolName: "search_notes",
        riskLevel: "read",
      });
      await createRemoteMcpTool(db, company.id, {
        url: remote.url,
        applicationKey: "unassigned-context-app",
        connectionName: "Unassigned context",
        toolName: "private_search",
        riskLevel: "read",
      });
      const [profile] = await db.insert(toolProfiles).values({
        companyId: company.id,
        profileKey: `context-${randomUUID()}`,
        name: `Context ${randomUUID()}`,
        defaultAction: "deny",
      }).returning();
      await db.insert(toolProfileEntries).values({
        companyId: company.id,
        profileId: profile.id,
        selectorType: "connection",
        effect: "include",
        connectionId: assigned.connection.id,
      });
      const gateway = createTestToolGatewayService(db);
      const created = await gateway.createNamedGateway({
        companyId: company.id,
        body: { name: "Context gateway", profileId: profile.id },
      });
      const token = await gateway.createNamedGatewayToken({
        companyId: company.id,
        gatewayId: created.id,
        body: { name: "Native runner" },
      });
      const app = createGatewayRouteApp(db, gateway);

      const resources = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${token.token}`)
        .send({ jsonrpc: "2.0", id: 1, method: "resources/list" })
        .expect(200);
      expect(resources.body.result.resources).toHaveLength(1);
      expect(resources.body.result.resources[0]).toMatchObject({
        uri: expect.stringMatching(new RegExp(`^paperclip-resource://${assigned.connection.id}/`)),
        name: "Assigned context: Note one",
      });
      const resourceUri = resources.body.result.resources[0].uri as string;

      const read = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${token.token}`)
        .send({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: resourceUri } })
        .expect(200);
      expect(read.body.result.contents[0]).toMatchObject({ uri: resourceUri, text: "resource body" });

      const prompts = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${token.token}`)
        .send({ jsonrpc: "2.0", id: 3, method: "prompts/list" })
        .expect(200);
      expect(prompts.body.result.prompts).toHaveLength(1);
      expect(prompts.body.result.prompts[0].title).toBe("Assigned context: Summarize note");
      const promptName = prompts.body.result.prompts[0].name as string;

      const wrapper = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${token.token}`)
        .send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "paperclip_get_prompt", arguments: { name: promptName } } })
        .expect(200);
      expect(wrapper.body.result.structuredContent).toMatchObject({ description: "Summary prompt" });
      expect(remote.requests.filter((entry) => entry.body?.method === "resources/read")[0]?.body?.params).toEqual({ uri: "notes://one" });
      expect(remote.requests.filter((entry) => entry.body?.method === "prompts/get")[0]?.body?.params).toEqual({ name: "summarize", arguments: {} });
    } finally {
      await remote.close();
    }
  });

  it("omits archived gateways from listNamedGateways", async () => {
    const company = await createCompany(db);
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `archived-list-${randomUUID()}`,
      name: `Archived list ${randomUUID()}`,
      defaultAction: "deny",
    }).returning();
    const gateway = createTestToolGatewayService(db);

    const kept = await gateway.createNamedGateway({
      companyId: company.id,
      body: { name: "Kept gateway", profileId: profile.id },
    });
    const retired = await gateway.createNamedGateway({
      companyId: company.id,
      body: { name: "Retired gateway", profileId: profile.id },
    });

    // Both are visible while active.
    let listed = await gateway.listNamedGateways(company.id);
    expect(listed.map((g) => g.id).sort()).toEqual([kept.id, retired.id].sort());

    // Archiving one drops it from the list (but not the active one).
    await gateway.updateNamedGateway({
      companyId: company.id,
      gatewayId: retired.id,
      body: { status: "archived" },
    });
    listed = await gateway.listNamedGateways(company.id);
    expect(listed.map((g) => g.id)).toEqual([kept.id]);
  });

  it("throttles named gateway bearer auth failures without leaking bearer material", async () => {
    const company = await createCompany(db);
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `auth-throttle-${randomUUID()}`,
      name: `Auth throttle ${randomUUID()}`,
      defaultAction: "deny",
    }).returning();
    const gateway = createTestToolGatewayService(db, {
      mcpGatewayProtocolLimits: {
        authFailures: { max: 1, windowMs: 60_000 },
      },
    });
    const created = await gateway.createNamedGateway({
      companyId: company.id,
      body: { name: "Public auth throttle", profileId: profile.id },
    });
    const app = createGatewayRouteApp(db, gateway);
    const badToken = `pcgw_${randomUUID()}.not-a-real-secret`;

    const first = await request(app)
      .post(`/mcp/gateways/${created.gatewayPublicId}`)
      .set("authorization", `Bearer ${badToken}`)
      .set("x-paperclip-client-name", "Noisy client")
      .set("x-request-id", "auth-throttle-test")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(401);
    expect(first.body.error.data.reasonCode).toBe("gateway_token_invalid");

    const throttled = await request(app)
      .post(`/mcp/gateways/${created.gatewayPublicId}`)
      .set("authorization", `Bearer ${badToken}`)
      .set("x-paperclip-client-name", "Noisy client")
      .set("x-request-id", "auth-throttle-test")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      .expect(429);
    expect(throttled.body.error.data).toMatchObject({
      reasonCode: "gateway_auth_throttled",
      reasonText: "The MCP gateway authentication attempt was throttled after repeated failures.",
    });

    const audits = await db
      .select()
      .from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.reasonCode, "gateway_auth_throttled"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      companyId: company.id,
      gatewayId: created.id,
      gatewayPublicId: created.gatewayPublicId,
      clientName: "Noisy client",
      correlationId: "auth-throttle-test",
    });
    expect(audits[0]!.details).toMatchObject({
      limiterKeyClass: "gateway_auth",
      tokenPrefix: `pcgw_${badToken.slice(5, 13)}`,
    });
    expect(JSON.stringify(audits)).not.toContain(badToken);
    expect(JSON.stringify(audits)).not.toContain("authorization");
  });

  it("prunes expired persisted public gateway auth limiter counters", async () => {
    let now = Date.now();
    const company = await createCompany(db);
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `auth-limiter-prune-${randomUUID()}`,
      name: `Auth limiter prune ${randomUUID()}`,
      defaultAction: "deny",
    }).returning();
    const gateway = createTestToolGatewayService(db, {
      now: () => now,
      mcpGatewayProtocolLimits: {
        authFailures: { max: 100, windowMs: 100 },
      },
    });
    const created = await gateway.createNamedGateway({
      companyId: company.id,
      body: { name: "Public auth limiter prune", profileId: profile.id },
    });
    const app = createGatewayRouteApp(db, gateway);
    const endpoint = `/mcp/gateways/${created.gatewayPublicId}`;

    await request(app)
      .post(endpoint)
      .set("authorization", `Bearer pcgw_${randomUUID()}.bad-secret`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(401);
    const initialCounters = await db.select().from(toolGatewayRateLimitCounters);
    expect(initialCounters.length).toBeGreaterThan(0);

    now += 60_001;
    await request(app)
      .post(endpoint)
      .set("authorization", `Bearer pcgw_${randomUUID()}.bad-secret`)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      .expect(401);

    const remainingCounters = await db.select().from(toolGatewayRateLimitCounters);
    expect(remainingCounters.every((counter) => counter.resetAt.getTime() > now)).toBe(true);
  });

  it("shares public gateway auth limiter counters across service instances", async () => {
    const company = await createCompany(db);
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `auth-limiter-shared-${randomUUID()}`,
      name: `Auth limiter shared ${randomUUID()}`,
      defaultAction: "deny",
    }).returning();
    const serviceA = createTestToolGatewayService(db, {
      mcpGatewayProtocolLimits: {
        authFailures: { max: 1, windowMs: 60_000 },
      },
    });
    const created = await serviceA.createNamedGateway({
      companyId: company.id,
      body: { name: "Public auth limiter shared", profileId: profile.id },
    });
    const serviceB = createTestToolGatewayService(db, {
      mcpGatewayProtocolLimits: {
        authFailures: { max: 1, windowMs: 60_000 },
      },
    });
    const badToken = `pcgw_${randomUUID()}.not-a-real-secret`;

    await request(createGatewayRouteApp(db, serviceA))
      .post(`/mcp/gateways/${created.gatewayPublicId}`)
      .set("authorization", `Bearer ${badToken}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(401);

    const throttled = await request(createGatewayRouteApp(db, serviceB))
      .post(`/mcp/gateways/${created.gatewayPublicId}`)
      .set("authorization", `Bearer ${badToken}`)
      .set("x-paperclip-client-name", "Shared counter client")
      .set("x-request-id", "auth-limiter-shared-test")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      .expect(429);
    expect(throttled.body.error.data).toMatchObject({
      reasonCode: "gateway_auth_throttled",
      reasonText: "The MCP gateway authentication attempt was throttled after repeated failures.",
    });

    const audits = await db
      .select()
      .from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.reasonCode, "gateway_auth_throttled"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      companyId: company.id,
      gatewayId: created.id,
      gatewayPublicId: created.gatewayPublicId,
      clientName: "Shared counter client",
      correlationId: "auth-limiter-shared-test",
    });
    expect(audits[0]!.details).toMatchObject({
      limiterKeyClass: "gateway_auth",
      tokenPrefix: `pcgw_${badToken.slice(5, 13)}`,
    });
    expect(JSON.stringify(audits)).not.toContain(badToken);
    expect(JSON.stringify(audits)).not.toContain("authorization");
  });

  it("rate limits public named gateway session setup, discovery, and calls with redacted audits", async () => {
    const company = await createCompany(db);
    const remote = await startFakeRemoteMcpServer(async () => ({
      body: {
        jsonrpc: "2.0",
        id: "test",
        result: { content: [{ type: "text", text: "read ok" }], structuredContent: { ok: true } },
      },
    }));
    try {
      const { application, connection, catalogEntry } = await createRemoteMcpTool(db, company.id, {
        url: remote.url,
        applicationKey: "limited-named-gateway-app",
        toolName: "read_note",
        title: "Read note",
        riskLevel: "read",
      });
      const gatewayToolName = expectedConnectedToolName({
        applicationKey: application.applicationKey,
        connectionId: connection.id,
        toolName: catalogEntry.toolName,
      });
      const [profile] = await db.insert(toolProfiles).values({
        companyId: company.id,
        profileKey: `protocol-limit-${randomUUID()}`,
        name: `Protocol limit ${randomUUID()}`,
        defaultAction: "deny",
      }).returning();
      await db.insert(toolProfileEntries).values({
        companyId: company.id,
        profileId: profile.id,
        selectorType: "tool_name",
        effect: "include",
        toolName: gatewayToolName,
      });
      // Pin the clock so every request in this test shares one rate-limit
      // window. The window boundary aligns to wall-clock time, so a real clock
      // can advance past the boundary between two paired requests and reset the
      // counter. That reset makes the second request return 200 instead of 429.
      const fixedNow = Date.now();
      const gateway = createTestToolGatewayService(db, {
        now: () => fixedNow,
        mcpGatewayProtocolLimits: {
          gatewayRequests: { max: 1, windowMs: 60_000 },
          tokenRequests: { max: 1, windowMs: 60_000 },
          sessionSetup: { max: 1, windowMs: 60_000 },
        },
      });
      const created = await gateway.createNamedGateway({
        companyId: company.id,
        body: { name: "Public protocol limits", profileId: profile.id },
      });
      const tokenA = await gateway.createNamedGatewayToken({
        companyId: company.id,
        gatewayId: created.id,
        body: { name: "Client A", clientLabel: "Client A" },
      });
      const tokenB = await gateway.createNamedGatewayToken({
        companyId: company.id,
        gatewayId: created.id,
        body: { name: "Client B", clientLabel: "Client B" },
      });
      const app = createGatewayRouteApp(db, gateway);
      const endpoint = `/mcp/gateways/${created.gatewayPublicId}`;

      const initialized = await request(app)
        .post(endpoint)
        .set("authorization", `Bearer ${tokenA.token}`)
        .send({ jsonrpc: "2.0", id: 1, method: "initialize" })
        .expect(200);
      expect(initialized.body.result).toMatchObject({
        capabilities: { tools: {}, resources: {}, prompts: {} },
        _meta: { "paperclip/mcp-app-ui": "unsupported" },
      });
      const setupLimited = await request(app)
        .post(endpoint)
        .set("authorization", `Bearer ${tokenA.token}`)
        .send({ jsonrpc: "2.0", id: 2, method: "initialize" })
        .expect(429);
      expect(setupLimited.body.error.data).toMatchObject({
        reasonCode: "gateway_rate_limited",
        limiterKeyClass: "token",
        protocolMethod: "initialize",
      });

      await request(app)
        .post(endpoint)
        .set("authorization", `Bearer ${tokenA.token}`)
        .send({ jsonrpc: "2.0", id: 3, method: "tools/list" })
        .expect(200);
      const discoveryLimited = await request(app)
        .post(endpoint)
        .set("authorization", `Bearer ${tokenB.token}`)
        .send({ jsonrpc: "2.0", id: 4, method: "tools/list" })
        .expect(429);
      expect(discoveryLimited.body.error.data).toMatchObject({
        reasonCode: "gateway_rate_limited",
        limiterKeyClass: "gateway",
        protocolMethod: "tools/list",
      });

      await request(app)
        .post(endpoint)
        .set("authorization", `Bearer ${tokenB.token}`)
        .send({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: gatewayToolName, arguments: { key: "a", value: "b" } },
        })
        .expect(200);
      const callLimited = await request(app)
        .post(endpoint)
        .set("authorization", `Bearer ${tokenB.token}`)
        .send({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: gatewayToolName, arguments: { key: "a", value: "b" } },
        })
        .expect(429);
      expect(callLimited.body.error.data).toMatchObject({
        reasonCode: "gateway_rate_limited",
        limiterKeyClass: "token",
        protocolMethod: "tools/call",
      });

      const audits = await db
        .select()
        .from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.reasonCode, "gateway_rate_limited"));
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({ gatewayId: created.id, gatewayPublicId: created.gatewayPublicId }),
      ]));
      expect(audits.map((audit) => audit.details)).toEqual(expect.arrayContaining([
        expect.objectContaining({ protocolMethod: "initialize", limiterKeyClass: "token" }),
        expect.objectContaining({ protocolMethod: "tools/list", limiterKeyClass: "gateway" }),
        expect.objectContaining({ protocolMethod: "tools/call", limiterKeyClass: "token" }),
      ]));
      const serializedAudits = JSON.stringify(audits);
      expect(serializedAudits).not.toContain(tokenA.token);
      expect(serializedAudits).not.toContain(tokenB.token);
      expect(serializedAudits).not.toContain("authorization");
    } finally {
      await remote.close();
    }
  });

  it("hides and denies every external tool when an agent has no gateway profile", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { idleTtlMs: 25 } });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    await expect(gateway.listToolsForSession(session.token)).resolves.toEqual([]);
    await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:echo",
      parameters: { message: "not allowed" },
    }).then(
      () => {
        throw new Error("Expected unauthorized tool call to fail");
      },
      (error) => expectGatewayError(error, 403, "deny_default"),
    );

    const [deniedAudit] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.call_denied"));
    expect(deniedAudit).toMatchObject({
      companyId: company.id,
      entityType: "issue",
      entityId: issue.id,
      agentId: agent.id,
      runId: run.id,
    });
  });

  it("filters discovery, executes a remote HTTP fixture, and audits run and issue links", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, [
      "mcp-remote-fixture:add",
      "mcp-stdio-fixture:increment_counter",
      "mcp-stdio-fixture:runtime_status",
    ]);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { idleTtlMs: 25 } });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const toolNames = (await gateway.listToolsForSession(session.token)).map((tool) => tool.name);
    expect(toolNames).toContain("mcp-remote-fixture:add");
    expect(toolNames).toContain("mcp-stdio-fixture:increment_counter");
    expect(toolNames).not.toContain("mcp-remote-fixture:echo");

    const result = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:add",
      parameters: { a: 4, b: 7 },
    });
    expect(result).toMatchObject({
      status: "completed",
      tool: "mcp-remote-fixture:add",
      result: {
        content: "11",
        data: {
          result: 11,
          transport: "mcp_http",
          spawnedLocalProcess: false,
        },
      },
    });

    const [invocation] = await db.select().from(toolInvocations);
    expect(invocation).toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      runId: run.id,
      toolName: "mcp-remote-fixture:add",
      status: "succeeded",
    });
    const [callEvent] = await db.select().from(toolCallEvents);
    expect(callEvent).toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      runId: run.id,
      toolName: "mcp-remote-fixture:add",
      outcome: "success",
    });
    const [dedicatedAudit] = await db
      .select()
      .from(toolCallEvents)
      .where(eq(toolCallEvents.eventType, "call_completed"));
    expect(dedicatedAudit).toMatchObject({
      issueId: issue.id,
      runId: run.id,
      toolName: "mcp-remote-fixture:add",
    });
  });

  it("lists connected remote MCP catalog tools only for the scoped company and agent policy", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const unprofiledAgent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const { run: unprofiledRun } = await createIssueAndRun(db, company.id, unprofiledAgent.id);
    const remoteTool = await createRemoteMcpTool(db, company.id, {
      applicationKey: "kv-demo",
      connectionName: "KV Demo",
      toolName: "kv_set",
      title: "Set KV value",
    });
    const otherCompany = await createCompany(db);
    const otherAgent = await createAgent(db, otherCompany.id);
    const { run: otherRun } = await createIssueAndRun(db, otherCompany.id, otherAgent.id);
    const otherRemoteTool = await createRemoteMcpTool(db, otherCompany.id, {
      applicationKey: "kv-demo",
      connectionName: "KV Demo",
      toolName: "kv_set",
      title: "Set KV value",
    });
    const profile = await allowToolsForAgent(db, company.id, agent.id, []);
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: profile.id,
      selectorType: "catalog_entry",
      effect: "include",
      catalogEntryId: remoteTool.catalogEntry.id,
    });
    const otherProfile = await allowToolsForAgent(db, otherCompany.id, otherAgent.id, []);
    await db.insert(toolProfileEntries).values({
      companyId: otherCompany.id,
      profileId: otherProfile.id,
      selectorType: "connection",
      effect: "include",
      connectionId: otherRemoteTool.connection.id,
    });

    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const unprofiledSession = await gateway.createSession({
      companyId: company.id,
      agentId: unprofiledAgent.id,
      runId: unprofiledRun.id,
    });
    const otherSession = await gateway.createSession({
      companyId: otherCompany.id,
      agentId: otherAgent.id,
      runId: otherRun.id,
    });

    const tools = await gateway.listToolsForSession(session.token);
    const connectedTool = tools.find((tool) => tool.providerType === "mcp_remote_http");
    expect(connectedTool).toMatchObject({
      name: expect.stringMatching(/^mcp\.kv-demo-[0-9a-f]{8}:kv-set$/),
      displayName: "Set KV value",
      providerType: "mcp_remote_http",
      risk: "write",
      applicationId: remoteTool.application.id,
      applicationKey: "kv-demo",
      connectionId: remoteTool.connection.id,
      catalogEntryId: remoteTool.catalogEntry.id,
      upstreamToolName: "kv_set",
      parametersSchema: expect.objectContaining({ type: "object" }),
      providerMetadata: expect.objectContaining({
        applicationKey: "kv-demo",
        connectionId: remoteTool.connection.id,
        catalogEntryId: remoteTool.catalogEntry.id,
        transport: "mcp_remote",
        upstreamToolName: "kv_set",
        annotations: { readOnlyHint: false },
        risk: expect.objectContaining({ level: "write", isWrite: true }),
      }),
    });

    await expect(gateway.listToolsForSession(unprofiledSession.token)).resolves.toEqual([]);
    const otherTools = await gateway.listToolsForSession(otherSession.token);
    expect(otherTools).toEqual([
      expect.objectContaining({
        providerType: "mcp_remote_http",
        connectionId: otherRemoteTool.connection.id,
        catalogEntryId: otherRemoteTool.catalogEntry.id,
      }),
    ]);
    expect(otherTools.map((tool) => tool.catalogEntryId)).not.toContain(remoteTool.catalogEntry.id);
  });

  it("invokes an installed Composio child through a tool-scoped session and re-mints once on 401", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const remoteTool = await createRemoteMcpTool(db, company.id, {
      applicationKey: "composio",
      connectionName: "GitHub (via Composio)",
      toolName: "GITHUB_LIST_REPOS",
      title: "List repositories",
      riskLevel: "read",
    });
    const apiKey = await secretService(db).create(company.id, {
      name: "Composio API key",
      key: `tool_app.${randomUUID()}.composio_api_key`,
      provider: "local_encrypted",
      value: "ak_composio_gateway_fixture",
    });
    const [parent] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: remoteTool.application.id,
      name: "Composio",
      uid: `composio/${randomUUID()}`,
      transport: "rest_api",
      authKind: "api_key",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "composio" },
      transportConfig: { sourceTemplateKey: "composio" },
      credentialRefs: [{
        name: "credentials.apiKey",
        secretId: apiKey.id,
        version: "latest",
        placement: "header",
        key: "x-api-key",
        prefix: null,
      }],
      credentialSecretRefs: [{
        secretId: apiKey.id,
        versionSelector: "latest",
        configPath: "credentials.apiKey",
        required: true,
        label: "Composio API key",
      }],
    }).returning();
    await db.insert(companySecretBindings).values({
      companyId: company.id,
      secretId: apiKey.id,
      targetType: "tool_connection",
      targetId: parent!.id,
      configPath: "credentials.apiKey",
    });
    const childConfig = {
      provider: "composio",
      parentConnectionId: parent!.id,
      toolkitSlug: "github",
      connectedAccountId: "ca_github_fixture",
    };
    await db.update(toolConnections).set({ config: childConfig, transportConfig: childConfig })
      .where(eq(toolConnections.id, remoteTool.connection.id));
    await db.insert(toolConnectionInstalls).values({
      companyId: company.id,
      connectionId: remoteTool.connection.id,
      targetType: "agent",
      targetId: agent.id,
    });
    const profile = await allowToolsForAgent(db, company.id, agent.id, []);
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: profile.id,
      selectorType: "catalog_entry",
      effect: "include",
      catalogEntryId: remoteTool.catalogEntry.id,
    });

    const sessionRequests: Array<{ apiKey: string; userId: string; options: unknown }> = [];
    let upstreamCalls = 0;
    const gateway = createTestToolGatewayService(db, {
      composioClientFactory: (resolvedApiKey) => ({
        createSession: async (userId, sessionOptions) => {
          sessionRequests.push({ apiKey: resolvedApiKey, userId, options: sessionOptions });
          const suffix = sessionRequests.length;
          return {
            session_id: `composio-session-${suffix}`,
            mcp: {
              url: `https://mcp.composio.test/session-${suffix}`,
              headers: { Authorization: `Bearer composio-session-token-${suffix}` },
            },
          };
        },
      }) as unknown as ComposioClient,
      remoteHttpRequest: async (url, init) => {
        upstreamCalls += 1;
        expect(url).toBe(`https://mcp.composio.test/session-${upstreamCalls}`);
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer composio-session-token-${upstreamCalls}`);
        if (upstreamCalls === 1) return new Response("unauthorized", { status: 401 });
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: "fixture",
          result: { content: [{ type: "text", text: "repo-a" }], structuredContent: { repositories: ["repo-a"] } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const tool = (await gateway.listToolsForSession(session.token)).find((candidate) => candidate.connectionId === remoteTool.connection.id);
    expect(tool).toBeDefined();
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters: {} })).resolves.toMatchObject({
      status: "completed",
      result: { content: "repo-a", data: { structuredContent: { repositories: ["repo-a"] } } },
    });
    await db.update(connectionGrants).set({ updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(connectionGrants.connectionId, remoteTool.connection.id));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters: {} })).resolves.toMatchObject({
      status: "completed",
      result: { content: "repo-a" },
    });
    expect(sessionRequests).toEqual([
      expect.objectContaining({
        apiKey: "ak_composio_gateway_fixture",
        userId: `paperclip:${company.id}`,
        options: expect.objectContaining({
          mcp: true,
          toolkits: ["github"],
          tools: { github: { enable: ["GITHUB_LIST_REPOS"] } },
        }),
      }),
      expect.objectContaining({ options: expect.objectContaining({ tools: { github: { enable: ["GITHUB_LIST_REPOS"] } } }) }),
      expect.objectContaining({ options: expect.objectContaining({ tools: { github: { enable: ["GITHUB_LIST_REPOS"] } } }) }),
    ]);
    const [persistedChild] = await db.select().from(toolConnections).where(eq(toolConnections.id, remoteTool.connection.id));
    expect(JSON.stringify(persistedChild!.config)).not.toContain("session-");
    expect(JSON.stringify(persistedChild!.transportConfig)).not.toContain("mcp.composio.test");
    expect(persistedChild!.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^composio\.session\.[a-f0-9]+\.url$/),
      expect.stringMatching(/^composio\.session\.[a-f0-9]+\.header\.[a-f0-9]+$/),
    ]));
  });

  it("lists and executes connected local stdio MCP catalog tools through the gateway", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const unprofiledAgent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const { run: unprofiledRun } = await createIssueAndRun(db, company.id, unprofiledAgent.id);
    const localTool = await createLocalStdioMcpTool(db, company.id, {
      applicationKey: "local-demo",
      connectionName: "Local Demo",
      toolName: "echo",
      title: "Local echo",
    });
    const expectedName = expectedConnectedToolName({
      applicationKey: "local-demo",
      connectionId: localTool.connection.id,
      toolName: "echo",
    });
    const profile = await allowToolsForAgent(db, company.id, agent.id, []);
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: profile.id,
      selectorType: "catalog_entry",
      effect: "include",
      catalogEntryId: localTool.catalogEntry.id,
    });

    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { idleTtlMs: 10_000 } });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const unprofiledSession = await gateway.createSession({
      companyId: company.id,
      agentId: unprofiledAgent.id,
      runId: unprofiledRun.id,
    });

    const tools = await gateway.listToolsForSession(session.token);
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: expectedName,
        displayName: "Local echo",
        providerType: "mcp_local_stdio",
        risk: "read",
        applicationId: localTool.application.id,
        applicationKey: "local-demo",
        connectionId: localTool.connection.id,
        catalogEntryId: localTool.catalogEntry.id,
        upstreamToolName: "echo",
        providerMetadata: expect.objectContaining({
          transport: "local_stdio",
          connectionId: localTool.connection.id,
          catalogEntryId: localTool.catalogEntry.id,
          upstreamToolName: "echo",
        }),
      }),
    ]));
    await expect(gateway.listToolsForSession(unprofiledSession.token)).resolves.toEqual([]);

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: expectedName,
      parameters: { message: "hello" },
    })).resolves.toMatchObject({
      status: "completed",
      result: {
        content: "local:hello",
        data: {
          structuredContent: { echoed: "hello" },
          transport: "local_stdio",
          spawnedLocalProcess: true,
        },
      },
    });

    const [slot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.connectionId, localTool.connection.id));
    expect(slot).toMatchObject({
      status: "idle",
      commandTemplateKey: localTool.templateKey,
      healthStatus: "ok",
    });
  });

  it("passes only approved env values to local stdio MCP processes", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://server-secret.example/paperclip";
    try {
      const company = await createCompany(db);
      const agent = await createAgent(db, company.id);
      const { run } = await createIssueAndRun(db, company.id, agent.id);
      const allowedToken = await secretService(db).create(company.id, {
        name: `Local stdio token ${randomUUID()}`,
        key: `local_stdio_token_${randomUUID().replace(/-/g, "")}`,
        provider: "local_encrypted",
        value: "allowed-token",
      });
      const localTool = await createLocalStdioMcpTool(db, company.id, {
        applicationKey: "local-env-demo",
        connectionName: "Local Env Demo",
        toolName: "inspect_env",
        title: "Inspect env",
        envKeys: ["ALLOWED_TOKEN"],
        credentialSecretRefs: [{
          secretId: allowedToken.id,
          versionSelector: "latest",
          configPath: "env.ALLOWED_TOKEN",
          required: true,
          label: "Allowed token",
        }],
        connectionConfig: { env: { ALLOWED_TOKEN: "connection-level-token", EXTRA_CONFIG: "extra-value", NODE_OPTIONS: "--trace-warnings" } },
        stdioScript: `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "env-stdio", version: "0.0.0" } } }) + "\\n");
    return;
  }
  if (message.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "env" }],
        structuredContent: {
          databaseUrl: process.env.DATABASE_URL ?? null,
          allowedToken: process.env.ALLOWED_TOKEN ?? null,
          extraConfig: process.env.EXTRA_CONFIG ?? null,
          nodeOptions: process.env.NODE_OPTIONS ?? null,
          hasPath: Boolean(process.env.PATH || process.env.Path),
        },
      },
    }) + "\\n");
  }
});
`,
      });
      const expectedName = expectedConnectedToolName({
        applicationKey: "local-env-demo",
        connectionId: localTool.connection.id,
        toolName: "inspect_env",
      });
      const profile = await allowToolsForAgent(db, company.id, agent.id, []);
      await db.insert(toolProfileEntries).values({
        companyId: company.id,
        profileId: profile.id,
        selectorType: "catalog_entry",
        effect: "include",
        catalogEntryId: localTool.catalogEntry.id,
      });

      const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { idleTtlMs: 10_000 } });
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

      await expect(gateway.executeTool({
        sessionToken: session.token,
        tool: expectedName,
        parameters: { message: "hello" },
      })).resolves.toMatchObject({
        status: "completed",
        result: {
          data: {
            structuredContent: {
              databaseUrl: null,
              allowedToken: "***REDACTED***",
              extraConfig: null,
              nodeOptions: null,
              hasPath: true,
            },
          },
        },
      });
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it("passes only the selected grant identity to local stdio MCP processes", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await createActiveMember(db, company.id, "alice");
    await createActiveMember(db, company.id, "bob");
    await db.update(heartbeatRuns).set({ responsibleUserId: "alice" }).where(eq(heartbeatRuns.id, run.id));
    const values = {
      organization: `organization-${randomUUID()}`,
      alice: `alice-${randomUUID()}`,
      bob: `bob-${randomUUID()}`,
    };
    const organizationSecret = await secretService(db).create(company.id, {
      name: `Organization stdio token ${randomUUID()}`,
      key: `organization_stdio_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: values.organization,
    });
    const secrets = secretService(db);
    const identityDefinition = await secrets.createUserSecretDefinition(company.id, {
      name: `Personal stdio token ${randomUUID()}`,
      key: `personal_stdio_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
    });
    const aliceSecret = await secrets.createCurrentUserSecretValue(company.id, "alice", {
      definitionId: identityDefinition.id,
      value: values.alice,
    });
    const bobSecret = await secrets.createCurrentUserSecretValue(company.id, "bob", {
      definitionId: identityDefinition.id,
      value: values.bob,
    });
    const localTool = await createLocalStdioMcpTool(db, company.id, {
      applicationKey: "local-grant-identity",
      toolName: "identity",
      title: "Grant identity",
      envKeys: ["IDENTITY_TOKEN"],
      credentialSecretRefs: [{
        secretId: organizationSecret.id,
        versionSelector: "latest",
        configPath: "env.IDENTITY_TOKEN",
        required: true,
        label: "Organization identity",
      }],
      connectionConfig: { env: { IDENTITY_TOKEN: "legacy-connection-identity" } },
      stdioScript: `
const readline = require("node:readline");
const identities = ${JSON.stringify(values)};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "identity-stdio", version: "0.0.0" } } }) + "\\n");
    return;
  }
  if (message.method === "tools/call") {
    const identity = Object.entries(identities).find(([, value]) => value === process.env.IDENTITY_TOKEN)?.[0] ?? "unknown";
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: identity }], structuredContent: { identity } } }) + "\\n");
  }
});
`,
    });
    await secrets.syncUserSecretDeclarationsForTarget(
      company.id,
      { targetType: "tool_connection", targetId: localTool.connection.id },
      [{
        definitionKey: identityDefinition.key,
        configPath: "env.IDENTITY_TOKEN",
        envKey: "IDENTITY_TOKEN",
        versionSelector: "latest",
        required: true,
        label: "Personal identity",
      }],
      { replaceAll: true },
    );
    const grantRef = (secretId: string, label: string) => ({
      secretId,
      versionSelector: "latest" as const,
      configPath: "env.IDENTITY_TOKEN",
      required: true,
      label,
    });
    const [aliceGrant] = await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: localTool.connection.id,
      kind: "user",
      subjectUserId: "alice",
      credentialSecretRefs: [grantRef(aliceSecret.id, "Alice identity")],
      status: "active",
      isDefault: false,
    }).returning();
    await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: localTool.connection.id,
      kind: "user",
      subjectUserId: "bob",
      credentialSecretRefs: [grantRef(bobSecret.id, "Bob identity")],
      status: "active",
      isDefault: false,
    });
    await allowAllToolsForAgent(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { idleTtlMs: 10_000 } });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const tool = (await gateway.listToolsForSession(session.token)).find((item) => item.connectionId === localTool.connection.id)!;
    const executeIdentity = async () => {
      const result = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} });
      return (result.result as { data?: { structuredContent?: { identity?: string } } }).data?.structuredContent?.identity;
    };

    expect(await executeIdentity()).toBe("organization");
    await db.update(toolConnections).set({ credentialPolicy: "per_user" }).where(eq(toolConnections.id, localTool.connection.id));
    expect(await executeIdentity()).toBe("alice");
    await db.update(toolConnections).set({ credentialPolicy: "per_user_with_fallback" }).where(eq(toolConnections.id, localTool.connection.id));
    expect(await executeIdentity()).toBe("alice");
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, aliceGrant.id));
    expect(await executeIdentity()).toBe("organization");

    await db.delete(toolRuntimeSlots).where(eq(toolRuntimeSlots.connectionId, localTool.connection.id));
    await db.update(toolConnections).set({ credentialPolicy: "per_user" }).where(eq(toolConnections.id, localTool.connection.id));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} }))
      .rejects.toMatchObject({ status: 409, reasonCode: "user_authorization_required" });
    expect(await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.connectionId, localTool.connection.id))).toHaveLength(0);

    const [organizationGrant] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.connectionId, localTool.connection.id),
      eq(connectionGrants.kind, "organization"),
    ));
    await db.insert(connectionGrantMembers).values({
      companyId: company.id,
      grantId: organizationGrant.id,
      subjectType: "user",
      subjectId: "sales-user",
    });
    await db.update(toolConnections).set({ credentialPolicy: "shared" }).where(eq(toolConnections.id, localTool.connection.id));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} }))
      .rejects.toMatchObject({ status: 403, reasonCode: "grant_audience_denied" });
    expect(await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.connectionId, localTool.connection.id))).toHaveLength(0);

    await db.insert(connectionGrantMembers).values({
      companyId: company.id,
      grantId: organizationGrant.id,
      subjectType: "user",
      subjectId: "alice",
    });
    expect(await executeIdentity()).toBe("organization");

    await db.delete(toolRuntimeSlots).where(eq(toolRuntimeSlots.connectionId, localTool.connection.id));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, organizationGrant.id));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} }))
      .rejects.toMatchObject({ status: 409, reasonCode: "organization_authorization_required" });

    await db.delete(connectionGrantMembers).where(eq(connectionGrantMembers.grantId, organizationGrant.id));
    await db.update(toolConnections).set({ credentialPolicy: "per_user" }).where(eq(toolConnections.id, localTool.connection.id));
    await db.update(heartbeatRuns).set({ responsibleUserId: null }).where(eq(heartbeatRuns.id, run.id));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} }))
      .rejects.toMatchObject({ status: 409, reasonCode: "user_authorization_required" });
    expect(await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.connectionId, localTool.connection.id))).toHaveLength(0);
  });

  it("uses the signed-in tester's personal grant for Test-tab calls", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const userId = `test-user-${randomUUID()}`;
    await createActiveMember(db, company.id, userId);
    const personalValue = `personal-${randomUUID()}`;
    const definitionKey = `personal_test_${randomUUID().replace(/-/g, "")}`;
    const [definition] = await db.insert(userSecretDefinitions).values({
      companyId: company.id,
      key: definitionKey,
      name: `Personal Test token ${randomUUID()}`,
      provider: "local_encrypted",
      managedMode: "paperclip_managed",
    }).returning();
    const personalSecret = await secretService(db).createCurrentUserSecretValue(company.id, userId, {
      definitionId: definition.id,
      value: personalValue,
    });
    const localTool = await createLocalStdioMcpTool(db, company.id, {
      applicationKey: "personal-test-tab",
      toolName: "identity",
      title: "Personal test identity",
      envKeys: ["IDENTITY_TOKEN"],
      stdioScript: `
const readline = require("node:readline");
const expected = ${JSON.stringify(personalValue)};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test-identity", version: "0.0.0" } } }) + "\\n");
    return;
  }
  if (message.method === "tools/call") {
    const identity = process.env.IDENTITY_TOKEN === expected ? "personal" : "wrong";
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: identity }], structuredContent: { identity } } }) + "\\n");
  }
});
`,
    });
    await db.update(toolConnections).set({ credentialPolicy: "per_user" }).where(eq(
      toolConnections.id,
      localTool.connection.id,
    ));
    await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: localTool.connection.id,
      kind: "user",
      subjectUserId: userId,
      credentialSecretRefs: [{
        secretId: personalSecret.id,
        versionSelector: "latest",
        configPath: "env.IDENTITY_TOKEN",
        required: true,
        label: "Personal identity",
      }],
      status: "active",
      isDefault: false,
    });
    await secretService(db).syncUserSecretDeclarationsForTarget(
      company.id,
      { targetType: "tool_connection", targetId: localTool.connection.id },
      [{
        definitionKey,
        configPath: "env.IDENTITY_TOKEN",
        envKey: "IDENTITY_TOKEN",
        versionSelector: "latest",
        required: true,
        label: "Personal identity",
      }],
      { replaceAll: true },
    );
    await allowAllToolsForAgent(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { idleTtlMs: 10_000 } });

    await expect(gateway.executeTestCall({
      companyId: company.id,
      connectionId: localTool.connection.id,
      agentId: agent.id,
      userId,
      toolName: "identity",
      parameters: {},
    })).resolves.toMatchObject({
      decision: "allowed",
      result: { data: { structuredContent: { identity: "personal" } } },
    });
  });

  it("keeps connected remote MCP gateway names collision-safe and excludes inactive catalog sources", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const first = await createRemoteMcpTool(db, company.id, {
      applicationKey: "kv-demo",
      connectionName: "KV Demo Primary",
      toolName: "kv_set",
      title: "Set KV value",
    });
    const second = await createRemoteMcpTool(db, company.id, {
      applicationKey: "kv-demo",
      connectionName: "KV Demo Secondary",
      toolName: "kv_set",
      title: "Set KV value",
    });
    await createRemoteMcpTool(db, company.id, {
      applicationKey: "disabled-demo",
      connectionName: "Disabled Demo",
      toolName: "kv_set",
      connectionEnabled: false,
    });
    await createRemoteMcpTool(db, company.id, {
      applicationKey: "unhealthy-demo",
      connectionName: "Unhealthy Demo",
      toolName: "kv_set",
      healthStatus: "error",
    });
    await createRemoteMcpTool(db, company.id, {
      applicationKey: "quarantined-demo",
      connectionName: "Quarantined Demo",
      toolName: "kv_set",
      catalogStatus: "quarantined",
      quarantinedAt: new Date(),
    });
    await allowAllToolsForAgent(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

    const connectedTools = (await gateway.listToolsForSession(session.token))
      .filter((tool) => tool.providerType === "mcp_remote_http");
    expect(connectedTools).toHaveLength(2);
    expect(connectedTools.map((tool) => tool.catalogEntryId).sort()).toEqual([
      first.catalogEntry.id,
      second.catalogEntry.id,
    ].sort());
    expect(new Set(connectedTools.map((tool) => tool.name)).size).toBe(2);
    expect(connectedTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^mcp\\.kv-demo-${first.connection.id.replace(/-/g, "").slice(0, 8)}:kv-set$`)),
      expect.stringMatching(new RegExp(`^mcp\\.kv-demo-${second.connection.id.replace(/-/g, "").slice(0, 8)}:kv-set$`)),
    ]));
  });

  it.each([
    ["local_trusted", { deploymentMode: "local_trusted" as const, deploymentExposure: "private" as const }],
    ["authenticated/private", { deploymentMode: "authenticated" as const, deploymentExposure: "private" as const }],
    ["authenticated/public", { deploymentMode: "authenticated" as const, deploymentExposure: "public" as const }],
  ])("always blocks link-local gateway dispatch in %s before fetch", async (_label, deployment) => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await createRemoteMcpTool(db, company.id, {
      applicationKey: "private-endpoint",
      toolName: "kv_set",
      url: "http://169.254.169.254/mcp",
    });
    await allowAllToolsForAgent(db, company.id, agent.id);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not be called"));
    try {
      const gateway = createTestToolGatewayService(db, deployment);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: { key: "alpha", value: "one" },
      }).then(
        () => {
          throw new Error("Expected private endpoint to be blocked");
        },
        (error) => expectGatewayError(error, 422, "remote_http_private_endpoint"),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("executes a connected remote HTTP MCP tool with stored credentials and redacted audit state", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const credentialValue = `remote-secret-${randomUUID()}`;
    const secret = await secretService(db).create(company.id, {
      name: `Remote MCP token ${randomUUID()}`,
      key: `remote_mcp_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: credentialValue,
    });
    const fake = await startFakeRemoteMcpServer((fakeRequest) => {
      expect(fakeRequest.headers.authorization).toBe(`Bearer ${credentialValue}`);
      expect(fakeRequest.headers["x-posthog-project-id"]).toBe("12345");
      const params = fakeRequest.body?.params as Record<string, unknown>;
      const args = params.arguments as Record<string, unknown>;
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: {
            content: [{ type: "text", text: `stored ${String(args.key)}=${String(args.value)}` }],
            structuredContent: { saved: true, key: args.key },
          },
        },
      };
    });
    try {
      await createRemoteMcpTool(db, company.id, {
        applicationKey: "kv-demo",
        connectionName: "KV Demo",
        toolName: "kv_set",
        title: "Set KV value",
        url: fake.url,
        credentialRefs: [{
          name: "credentials.authorization",
          secretId: secret.id,
          version: "latest",
          placement: "header",
          key: "Authorization",
          prefix: "Bearer ",
        }],
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "credentials.authorization",
          required: true,
          label: "Remote MCP token",
        }],
        connectionConfig: {
          sourceTemplateKey: "posthog",
          connectionMethodKey: "mcp-api-key",
          methodConfig: {
            projectId: "12345",
            readOnly: true,
            features: "insights",
            mode: "tools",
          },
        },
      });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: { key: "alpha", value: "one" },
      });
      expect(result).toMatchObject({
        status: "completed",
        tool: connectedTool!.name,
        result: {
          content: "stored alpha=one",
          data: {
            structuredContent: { saved: true, key: "alpha" },
            isError: false,
            transport: "mcp_http",
            spawnedLocalProcess: false,
          },
        },
      });
      expect(fake.requests).toHaveLength(1);
      // Streamable HTTP requires advertising both JSON and SSE on the call (PAP-11096).
      expect(fake.requests[0]!.headers.accept).toBe("application/json, text/event-stream");
      expect(fake.requests[0]!.body).toMatchObject({
        method: "tools/call",
        params: {
          name: "kv_set",
          arguments: { key: "alpha", value: "one" },
        },
      });

      const [invocation] = await db.select().from(toolInvocations);
      expect(invocation).toMatchObject({
        companyId: company.id,
        agentId: agent.id,
        issueId: issue.id,
        runId: run.id,
        toolName: connectedTool!.name,
        providerType: "mcp_remote_http",
        applicationKey: "kv-demo",
        upstreamToolName: "kv_set",
        riskLevel: "write",
        status: "succeeded",
      });
      expect(invocation.applicationId).toBe(connectedTool!.applicationId);
      expect(invocation.connectionId).toBe(connectedTool!.connectionId);
      expect(invocation.catalogEntryId).toBe(connectedTool!.catalogEntryId);
      expect(invocation.argumentsSummary).toMatchObject({
        summary: expect.stringContaining("\"key\":\"alpha\""),
      });
      expect(invocation.resultSummary).toMatchObject({
        summary: expect.stringContaining("\"saved\":true"),
      });

      const callEvents = await db.select().from(toolCallEvents);
      expect(callEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventType: "policy_decision",
          applicationId: connectedTool!.applicationId,
          connectionId: connectedTool!.connectionId,
          catalogEntryId: connectedTool!.catalogEntryId,
          toolName: connectedTool!.name,
          decision: "allow",
          reasonCode: "allow_profile",
        }),
        expect.objectContaining({
          eventType: "call_completed",
          applicationId: connectedTool!.applicationId,
          connectionId: connectedTool!.connectionId,
          catalogEntryId: connectedTool!.catalogEntryId,
          toolName: connectedTool!.name,
          metadata: expect.objectContaining({
            applicationKey: "kv-demo",
            providerType: "mcp_remote_http",
            upstreamToolName: "kv_set",
            risk: "write",
          }),
        }),
      ]));

      const gatewayAudits = await db.select().from(toolAccessAuditEvents);
      expect(gatewayAudits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "tool_access.policy_decision",
          connectionId: connectedTool!.connectionId,
          catalogEntryId: connectedTool!.catalogEntryId,
          reasonCode: "allow_profile",
          details: expect.objectContaining({
            applicationKey: "kv-demo",
            providerType: "mcp_remote_http",
            upstreamToolName: "kv_set",
            riskLevel: "write",
          }),
        }),
        expect.objectContaining({
          action: "call_completed",
          connectionId: connectedTool!.connectionId,
          catalogEntryId: connectedTool!.catalogEntryId,
          reasonCode: "tool_completed",
          details: expect.objectContaining({
            applicationKey: "kv-demo",
            providerType: "mcp_remote_http",
            upstreamToolName: "kv_set",
            risk: "write",
            resultSummary: expect.objectContaining({ summary: expect.stringContaining("\"saved\":true") }),
          }),
        }),
      ]));

      const persisted = JSON.stringify({
        invocations: await db.select().from(toolInvocations),
        callEvents: await db.select().from(toolCallEvents),
        audits: await db.select().from(toolAccessAuditEvents),
        activity: await db.select().from(activityLog),
      });
      expect(persisted).not.toContain(credentialValue);
    } finally {
      await fake.close();
    }
  });

  it("creates a personal authorization card and resumes after the user grant exists", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    await createActiveMember(db, company.id, "carol");
    await db.update(heartbeatRuns).set({ responsibleUserId: "carol" }).where(eq(heartbeatRuns.id, run.id));
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: { content: [{ type: "text", text: "connected" }] },
      },
    }));
    try {
      const { connection } = await createRemoteMcpTool(db, company.id, {
        url: fake.url,
        toolName: "whoami",
        riskLevel: "read",
      });
      // Personal credentials live on grants, so a company-level health probe
      // may be unable to authenticate even though this user's grant is valid.
      // The cached catalog must remain visible so grant resolution can happen.
      await db.update(toolConnections).set({
        credentialPolicy: "per_user",
        healthStatus: "error",
        healthMessage: "This app needs you to sign in.",
      }).where(eq(toolConnections.id, connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const tool = (await gateway.listToolsForSession(session.token)).find((item) => item.providerType === "mcp_remote_http")!;

      await db.insert(issueThreadInteractions).values({
        companyId: company.id,
        issueId: issue.id,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "none",
        requestedResolverPolicy: "anyone",
        effectiveResolverPolicy: "anyone",
        idempotencyKey: `connection-authorization:${connection.id}:carol`,
        title: "Connect your account",
        summary: `Connect ${connection.name} to continue`,
        payload: {
          version: 1,
          prompt: `Connect your account to ${connection.name}`,
          acceptLabel: "Open authorization",
          rejectLabel: "Not now",
        },
      });

      await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} }))
        .rejects.toMatchObject({ status: 409, reasonCode: "user_authorization_required" });
      const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issue.id));
      expect(interaction).toMatchObject({
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        addresseeUserId: "carol",
      });
      expect(interaction!.payload).toMatchObject({
        prompt: `Connect your ${connection.name} account to continue`,
        target: { key: `connection:${connection.uid}:user:carol` },
      });

      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: connection.id,
        kind: "user",
        subjectUserId: "carol",
        credentialSecretRefs: [],
        status: "active",
        isDefault: false,
      });
      const result = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} });
      expect(result).toMatchObject({ status: "completed", result: { content: "connected" } });
      expect(fake.requests).toHaveLength(1);
      await expect(db.select({ healthStatus: toolConnections.healthStatus }).from(toolConnections).where(
        eq(toolConnections.id, connection.id),
      )).resolves.toEqual([{ healthStatus: "ok" }]);
    } finally {
      await fake.close();
    }
  });

  it("refuses a personal_only connection call with no grant for the run's responsible user, and posts a connect prompt", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with no grant");
    });
    let authorizationStarted: unknown = null;
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-2",
        connectionName: "Personal Google (test, no grant)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      gateway.configureUserAuthorization(async (input) => {
        authorizationStarted = input;
      });
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      // subjectUserId is deliberately not in the public error details (an
      // internal identifier, not something the caller needs echoed back) --
      // it's still on the connect-card hook input below, which is the
      // internal channel that actually needs it.
      expect((error as ToolGatewayHttpError).details).toMatchObject({ connectionId: remoteTool.connection.id });
      expect((error as ToolGatewayHttpError).details).not.toHaveProperty("subjectUserId");
      expect(fake.requests).toHaveLength(0);
      expect(authorizationStarted).toMatchObject({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        agentId: agent.id,
        runId: run.id,
        subjectUserId: responsibleUserId,
      });
    } finally {
      await fake.close();
    }
  });

  it("uses the responsible user's own grant, not the connection's own credentials, for a personal_only connection", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const personalAccessToken = `personal-token-${randomUUID()}`;
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: personalAccessToken,
    });
    const fake = await startFakeRemoteMcpServer(async (fakeRequest) => {
      expect(fakeRequest.headers.authorization).toBe(`Bearer ${personalAccessToken}`);
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: { content: [{ type: "text", text: "ok" }], structuredContent: { calendars: [] } },
        },
      };
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-3",
        connectionName: "Personal Google (test, with grant)",
        toolName: "list_calendars",
        url: fake.url,
        // Deliberately no connection-level credentialRefs -- a personal_only
        // connection must never fall back to these even if present.
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      const [grant] = await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
        }],
      }).returning();
      // Bindings target the grant, not the connection -- company_secret_
      // bindings has a unique index on (companyId, targetType, targetId,
      // configPath), so a second user's grant on this same connection
      // couldn't get its own binding at the same configPath if these
      // targeted the connection itself.
      await db.insert(companySecretBindings).values({
        companyId: company.id,
        secretId: secret.id,
        targetType: "connection_grant",
        targetId: grant!.id,
        configPath: "oauth.access_token",
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      });
      expect(result).toMatchObject({ status: "completed" });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${personalAccessToken}`);
    } finally {
      await fake.close();
    }
  });

  // Regression test for a bug distinct from the RLS tenant-scoping fix above:
  // resolveUserGrantAuthHeader called the generic secrets.resolveSecretValue
  // without allowUserSecretScope, so it always threw secret_scope_invalid for
  // a genuinely user-scoped OAuth token (scope: "user", with ownerUserId and
  // userSecretDefinitionId set) -- the real shape Slack personal grants use,
  // as opposed to the company-scoped secret the test above exercises. The
  // company_secret_bindings row targeting (connection_grant, grant.id,
  // oauth.access_token) already authorizes this read; allowUserSecretScope
  // just needed to be passed through.
  it("resolves a personal_only connection's user-scoped OAuth token, not just a company-scoped one", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const personalAccessToken = `personal-token-${randomUUID()}`;
    const definitionKey = `personal_slack_token_${randomUUID().replace(/-/g, "")}`;
    const [definition] = await db.insert(userSecretDefinitions).values({
      companyId: company.id,
      key: definitionKey,
      name: `Personal Slack token ${randomUUID()}`,
      provider: "local_encrypted",
      managedMode: "paperclip_managed",
    }).returning();
    const secret = await secretService(db).createCurrentUserSecretValue(company.id, responsibleUserId, {
      definitionId: definition.id,
      value: personalAccessToken,
    });
    const fake = await startFakeRemoteMcpServer(async (fakeRequest) => {
      expect(fakeRequest.headers.authorization).toBe(`Bearer ${personalAccessToken}`);
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: { content: [{ type: "text", text: "ok" }], structuredContent: { channels: [] } },
        },
      };
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-slack-user-scoped",
        connectionName: "Personal Slack (test, user-scoped secret)",
        toolName: "list_channels",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      const [grant] = await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
        }],
      }).returning();
      await db.insert(companySecretBindings).values({
        companyId: company.id,
        secretId: secret.id,
        targetType: "connection_grant",
        targetId: grant!.id,
        configPath: "oauth.access_token",
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      });
      expect(result).toMatchObject({ status: "completed" });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${personalAccessToken}`);
    } finally {
      await fake.close();
    }
  });

  it("refuses a personal_only connection's user-scoped secret when no company_secret_bindings row authorizes the grant", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const definitionKey = `personal_slack_token_${randomUUID().replace(/-/g, "")}`;
    const [definition] = await db.insert(userSecretDefinitions).values({
      companyId: company.id,
      key: definitionKey,
      name: `Personal Slack token ${randomUUID()}`,
      provider: "local_encrypted",
      managedMode: "paperclip_managed",
    }).returning();
    const secret = await secretService(db).createCurrentUserSecretValue(company.id, responsibleUserId, {
      definitionId: definition.id,
      value: `personal-token-${randomUUID()}`,
    });
    const remoteTool = await createRemoteMcpTool(db, company.id, {
      applicationKey: "personal-slack-no-binding",
      connectionName: "Personal Slack (test, no binding row)",
      toolName: "list_channels",
      url: "https://example.invalid/mcp",
    });
    await db.update(toolConnections)
      .set({
        config: { url: "https://example.invalid/mcp", identityModel: "personal_only" },
        transportConfig: { url: "https://example.invalid/mcp", identityModel: "personal_only" },
      })
      .where(eq(toolConnections.id, remoteTool.connection.id));
    await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: remoteTool.connection.id,
      kind: "user",
      subjectUserId: responsibleUserId,
      status: "active",
      credentialSecretRefs: [{
        secretId: secret.id,
        versionSelector: "latest",
        configPath: "oauth.access_token",
        required: true,
        label: "Access token",
      }],
    }).returning();
    // Deliberately no companySecretBindings row for this grant.
    await allowAllToolsForAgent(db, company.id, agent.id);

    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const connectedTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.providerType === "mcp_remote_http");
    expect(connectedTool).toBeTruthy();

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: connectedTool!.name,
      parameters: {},
    })).rejects.toMatchObject({ status: 403, reasonCode: "user_authorization_required" });

    const auditEvents = await db.select().from(toolAccessAuditEvents)
      .where(and(
        eq(toolAccessAuditEvents.companyId, company.id),
        eq(toolAccessAuditEvents.reasonCode, "secret_resolution_failed"),
      ));
    expect(auditEvents.length).toBeGreaterThan(0);
  });

  it("refuses a personal_only connection's user-scoped secret when the secret is owned by a different user than the grant subject", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await createActiveMember(db, company.id, otherUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const definitionKey = `personal_slack_token_${randomUUID().replace(/-/g, "")}`;
    const [definition] = await db.insert(userSecretDefinitions).values({
      companyId: company.id,
      key: definitionKey,
      name: `Personal Slack token ${randomUUID()}`,
      provider: "local_encrypted",
      managedMode: "paperclip_managed",
    }).returning();
    // Owned by otherUserId, not the grant's subjectUserId (responsibleUserId).
    const secret = await secretService(db).createCurrentUserSecretValue(company.id, otherUserId, {
      definitionId: definition.id,
      value: `personal-token-${randomUUID()}`,
    });
    const remoteTool = await createRemoteMcpTool(db, company.id, {
      applicationKey: "personal-slack-cross-owner",
      connectionName: "Personal Slack (test, cross-owner secret)",
      toolName: "list_channels",
      url: "https://example.invalid/mcp",
    });
    await db.update(toolConnections)
      .set({
        config: { url: "https://example.invalid/mcp", identityModel: "personal_only" },
        transportConfig: { url: "https://example.invalid/mcp", identityModel: "personal_only" },
      })
      .where(eq(toolConnections.id, remoteTool.connection.id));
    const [grant] = await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: remoteTool.connection.id,
      kind: "user",
      subjectUserId: responsibleUserId,
      status: "active",
      credentialSecretRefs: [{
        secretId: secret.id,
        versionSelector: "latest",
        configPath: "oauth.access_token",
        required: true,
        label: "Access token",
      }],
    }).returning();
    // A binding row exists (e.g. mis-created or stale), but the secret's
    // owner no longer matches the grant's subject -- the ownership check
    // must refuse even though the binding alone would otherwise authorize it.
    await db.insert(companySecretBindings).values({
      companyId: company.id,
      secretId: secret.id,
      targetType: "connection_grant",
      targetId: grant!.id,
      configPath: "oauth.access_token",
    });
    await allowAllToolsForAgent(db, company.id, agent.id);

    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const connectedTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.providerType === "mcp_remote_http");
    expect(connectedTool).toBeTruthy();

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: connectedTool!.name,
      parameters: {},
    })).rejects.toMatchObject({ status: 403, reasonCode: "user_authorization_required" });

    const auditEvents = await db.select().from(toolAccessAuditEvents)
      .where(and(
        eq(toolAccessAuditEvents.companyId, company.id),
        eq(toolAccessAuditEvents.reasonCode, "grant_credential_owner_mismatch"),
      ));
    expect(auditEvents.length).toBeGreaterThan(0);
  });

  it("refreshes an expired grant's access token via the configured refresh hook instead of prompting to reconnect", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const staleAccessToken = `stale-token-${randomUUID()}`;
    const refreshedAccessToken = `refreshed-token-${randomUUID()}`;
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: staleAccessToken,
    });
    const fake = await startFakeRemoteMcpServer(async (fakeRequest) => {
      expect(fakeRequest.headers.authorization).toBe(`Bearer ${refreshedAccessToken}`);
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: { content: [{ type: "text", text: "ok" }], structuredContent: {} },
        },
      };
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-4",
        connectionName: "Personal Google (test, expired token)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      const [grant] = await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [
          {
            secretId: secret.id,
            versionSelector: "latest",
            configPath: "oauth.access_token",
            required: true,
            label: "Access token",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          },
          {
            secretId: secret.id,
            versionSelector: "latest",
            configPath: "oauth.refresh_token",
            required: true,
            label: "Refresh token",
          },
        ],
      }).returning();
      await db.insert(companySecretBindings).values({
        companyId: company.id,
        secretId: secret.id,
        targetType: "connection_grant",
        targetId: grant!.id,
        configPath: "oauth.access_token",
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      let refreshHookInput: unknown = null;
      gateway.configureGrantRefresh(async (input) => {
        refreshHookInput = input;
        return { accessToken: refreshedAccessToken, expiresAt: null };
      });
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      });
      expect(result).toMatchObject({ status: "completed" });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${refreshedAccessToken}`);
      expect(refreshHookInput).toMatchObject({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        subjectUserId: responsibleUserId,
      });
    } finally {
      await fake.close();
    }
  });

  it("falls through to the connect prompt when a grant is expired and no refresh hook is configured", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: `stale-token-${randomUUID()}`,
    });
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with an expired, unrefreshable grant");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-5",
        connectionName: "Personal Google (test, expired, no refresh hook)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("uses the responsible user's identity directly and requires delegation only without one", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    await createActiveMember(db, company.id, "alice");
    await db.update(heartbeatRuns).set({
      responsibleUserId: "alice",
      invocationSource: "automation",
    }).where(eq(heartbeatRuns.id, run.id));
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: { content: [{ type: "text", text: "delegated" }] },
      },
    }));
    try {
      const { connection } = await createRemoteMcpTool(db, company.id, {
        url: fake.url,
        toolName: "whoami",
        riskLevel: "read",
      });
      await db.update(toolConnections).set({ credentialPolicy: "per_user" }).where(eq(toolConnections.id, connection.id));
      const grant = await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: connection.id,
        kind: "user",
        subjectUserId: "alice",
        credentialSecretRefs: [],
        status: "active",
        isDefault: false,
      }).returning().then((rows) => rows[0]!);
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const tool = (await gateway.listToolsForSession(session.token)).find((item) => item.providerType === "mcp_remote_http")!;

      await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} }))
        .resolves.toMatchObject({ status: "completed", result: { content: "delegated" } });
      expect(fake.requests).toHaveLength(1);
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issue.id)))
        .toEqual([]);

      await db.update(heartbeatRuns).set({ responsibleUserId: null }).where(eq(heartbeatRuns.id, run.id));
      const unattendedSession = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const unattendedTool = (await gateway.listToolsForSession(unattendedSession.token))
        .find((item) => item.providerType === "mcp_remote_http")!;
      await expect(gateway.executeTool({
        sessionToken: unattendedSession.token,
        tool: unattendedTool.name,
        parameters: {},
      })).rejects.toMatchObject({ status: 409, reasonCode: "user_authorization_required" });
      expect(fake.requests).toHaveLength(1);

      await db.insert(connectionGrantDelegations).values({
        companyId: company.id,
        grantId: grant.id,
        agentId: agent.id,
        createdByUserId: "alice",
      });
      await expect(gateway.executeTool({
        sessionToken: unattendedSession.token,
        tool: unattendedTool.name,
        parameters: {},
      }))
        .resolves.toMatchObject({ status: "completed", result: { content: "delegated" } });
      expect(fake.requests).toHaveLength(2);

      await db.update(companyMemberships).set({ status: "suspended" }).where(and(
        eq(companyMemberships.companyId, company.id),
        eq(companyMemberships.principalId, "alice"),
      ));
      await expect(gateway.executeTool({
        sessionToken: unattendedSession.token,
        tool: unattendedTool.name,
        parameters: {},
      }))
        .rejects.toMatchObject({ status: 403, reasonCode: "grant_owner_membership_inactive" });
      expect(fake.requests).toHaveLength(2);
    } finally {
      await fake.close();
    }
  });

  it("falls through to the connect prompt when a configured refresh hook returns null", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: `stale-token-${randomUUID()}`,
    });
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called when refresh fails");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-6",
        connectionName: "Personal Google (test, refresh hook returns null)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      gateway.configureGrantRefresh(async () => null);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("refuses a personal_only connection call when the run has no responsible user at all", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    // Deliberately no responsibleUserId anywhere in the run's contextSnapshot
    // or its typed column -- e.g. a run kicked off without ownership context.
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with no responsible user");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-7",
        connectionName: "Personal Google (test, no responsible user)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "responsible_user_unknown");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("ignores a responsibleUserId in contextSnapshot when the typed column is unset", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    // The typed column is deliberately left unset -- only contextSnapshot
    // carries a responsibleUserId. Before the JSONB fallback was removed,
    // this would have resolved (and used) that snapshot value; now it must
    // be treated the same as no responsible user at all.
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId: `user-${randomUUID()}` } })
      .where(eq(heartbeatRuns.id, run.id));
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called when only the JSONB snapshot has a responsible user");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-9",
        connectionName: "Personal Google (test, snapshot-only responsible user)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "responsible_user_unknown");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("rejects a refreshed access token that fails the bearer-token header check", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: `stale-token-${randomUUID()}`,
    });
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with a rejected refreshed token");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-10",
        connectionName: "Personal Google (test, refreshed token rejected)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      // A null byte has no legitimate reason to be in a bearer token --
      // simulates a corrupted or adversarial refresh hook response.
      gateway.configureGrantRefresh(async () => ({ accessToken: "refreshed-token-\u0000-bad", expiresAt: null }));
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("falls through to user_authorization_required when the grant refresh hook throws", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: `stale-token-${randomUUID()}`,
    });
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called when the refresh hook throws");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-11",
        connectionName: "Personal Google (test, refresh hook throws)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      gateway.configureGrantRefresh(async () => {
        throw new Error("refresh hook exploded\x01\x0a");
      });
      let authorizationStarted: unknown = null;
      gateway.configureUserAuthorization(async (input) => {
        authorizationStarted = input;
      });
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
      expect(authorizationStarted).toMatchObject({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        agentId: agent.id,
        runId: run.id,
        subjectUserId: responsibleUserId,
      });
      const audits = await db.select().from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.connectionId, remoteTool.connection.id));
      expect(audits).toContainEqual(expect.objectContaining({
        outcome: "failure",
        reasonCode: "grant_refresh_hook_failed",
        details: expect.objectContaining({
          source: "tool_gateway.personal_credential_resolution_error",
          reason: "grant_refresh_hook_failed",
          error: "refresh hook exploded",
        }),
      }));
    } finally {
      await fake.close();
    }
  });

  it("audits secret_resolution_failed when the grant's stored secret can't be resolved", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called when secret resolution fails");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-12",
        connectionName: "Personal Google (test, secret resolution fails)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          // Deliberately a secret that doesn't exist, so resolveSecretValue
          // throws instead of returning a token -- not expired, so this
          // exercises the resolveSecretValue try/catch, not the refresh path.
          secretId: randomUUID(),
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
          expiresAt: null,
        }],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
      const audits = await db.select().from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.connectionId, remoteTool.connection.id));
      // The underlying error ("Secret not found", from resolveSecretValue's
      // own not-found guard) is already clean ASCII, so this doesn't exercise
      // control-char stripping -- that's covered directly by
      // sanitize-logged-error.test.ts, and end-to-end by the sibling
      // grant_refresh_hook_failed/connect_card_post_failed tests above.
      // Pinned to the exact string so a future change to the leaked error
      // text (e.g. a raw provider/DB message replacing this clean one) isn't
      // masked by a loose expect.any(String).
      expect(audits).toContainEqual(expect.objectContaining({
        outcome: "failure",
        reasonCode: "secret_resolution_failed",
        details: expect.objectContaining({
          source: "tool_gateway.personal_credential_resolution_error",
          reason: "secret_resolution_failed",
          error: "Secret not found",
        }),
      }));
    } finally {
      await fake.close();
    }
  });

  it("rejects a stored access token containing a space and audits token_header_value_rejected", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    // RFC 6750 section 2.1's token68 format excludes ASCII whitespace, so a
    // space-bearing stored token must be rejected here rather than allowed
    // through into a malformed `Authorization: Bearer <token>` header that
    // some downstream HTTP/1.1 parsers could truncate at.
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: `token with a space ${randomUUID()}`,
    });
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with a rejected token");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-space-token",
        connectionName: "Personal Google (test, space in token)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      const [grant] = await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
        }],
      }).returning();
      await db.insert(companySecretBindings).values({
        companyId: company.id,
        secretId: secret.id,
        targetType: "connection_grant",
        targetId: grant!.id,
        configPath: "oauth.access_token",
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
      const audits = await db.select().from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.connectionId, remoteTool.connection.id));
      expect(audits).toContainEqual(expect.objectContaining({
        details: expect.objectContaining({
          source: "tool_gateway.personal_credential_resolution_error",
          reason: "token_header_value_rejected",
        }),
      }));
    } finally {
      await fake.close();
    }
  });

  it("audits connect_card_post_failed when the connect-card hook throws", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with no grant");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-13",
        connectionName: "Personal Google (test, connect card hook throws)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      gateway.configureUserAuthorization(async () => {
        throw new Error("connect card service unavailable\x01\x0a");
      });
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
      const audits = await db.select().from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.connectionId, remoteTool.connection.id));
      expect(audits).toContainEqual(expect.objectContaining({
        details: expect.objectContaining({
          source: "tool_gateway.personal_credential_resolution_error",
          reason: "connect_card_post_failed",
          error: "connect card service unavailable",
        }),
      }));
    } finally {
      await fake.close();
    }
  });

  it("derives personal_only from the gallery AppDefinition even when connection.config omits identityModel", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const personalAccessToken = `personal-token-${randomUUID()}`;
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: personalAccessToken,
    });
    const fake = await startFakeRemoteMcpServer(async (fakeRequest) => {
      // If the gallery-derived branch were skipped, this connection would
      // fall through to the ordinary shared-credential path (no
      // credentialRefs configured) and the upstream call would carry no
      // Authorization header at all -- so seeing the personal grant's
      // bearer token here is the signal that isPersonalOnlyConnection took
      // the gallery branch despite config.identityModel being absent.
      expect(fakeRequest.headers.authorization).toBe(`Bearer ${personalAccessToken}`);
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: { content: [{ type: "text", text: "ok" }], structuredContent: {} },
        },
      };
    });
    const getConnectableAppDefinitionSpy = vi.spyOn(appDefinitions, "getConnectableAppDefinition");
    const getAvailableConnectionMethodSpy = vi.spyOn(appDefinitions, "getAvailableConnectionMethod");
    try {
      getConnectableAppDefinitionSpy.mockImplementation((slug) =>
        slug === "gallery-personal-only-app" ? ({ slug, methods: [{ key: "default", transport: "mcp_remote", auth: "none", ownershipModes: ["company"], whenToUse: "test", riskTier: "S1" }] } as any) : null);
      getAvailableConnectionMethodSpy.mockReturnValue({ identityModel: "personal_only" } as any);

      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-gallery-a",
        connectionName: "Personal Google (gallery says personal_only)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          // Deliberately no identityModel here -- only sourceTemplateKey.
          // The gallery lookup above is what must decide this is personal_only.
          config: { url: fake.url, sourceTemplateKey: "gallery-personal-only-app" },
          transportConfig: { url: fake.url, sourceTemplateKey: "gallery-personal-only-app" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      const [grant] = await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
        }],
      }).returning();
      await db.insert(companySecretBindings).values({
        companyId: company.id,
        secretId: secret.id,
        targetType: "connection_grant",
        targetId: grant!.id,
        configPath: "oauth.access_token",
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      });
      expect(result).toMatchObject({ status: "completed" });
      expect(fake.requests).toHaveLength(1);
    } finally {
      getConnectableAppDefinitionSpy.mockRestore();
      getAvailableConnectionMethodSpy.mockRestore();
      await fake.close();
    }
  });

  it("still treats a connection as personal_only from its pinned config when the gallery method exists but omits identityModel", async () => {
    // A gallery method that's found but simply omits identityModel (doesn't
    // specify it either way -- e.g. after a gallery edit removes the field,
    // or a method reorder resolves a different method) must NOT silently
    // downgrade an existing, pinned personal_only connection to shared
    // credentials. An explicit gallery identityModel value wins in either
    // direction over the pinned config (it can upgrade or downgrade), but an
    // omission never overrides the pinned config -- see
    // isPersonalOnlyConnection in tool-gateway.ts.
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called when the pinned config says personal_only and there's no personal grant");
    });
    const getConnectableAppDefinitionSpy = vi.spyOn(appDefinitions, "getConnectableAppDefinition");
    const getAvailableConnectionMethodSpy = vi.spyOn(appDefinitions, "getAvailableConnectionMethod");
    try {
      getConnectableAppDefinitionSpy.mockImplementation((slug) =>
        slug === "gallery-no-identity-model-app" ? ({ slug, methods: [{ key: "default", transport: "mcp_remote", auth: "none", ownershipModes: ["company"], whenToUse: "test", riskTier: "S1" }] } as any) : null);
      // A real method definition, just one that doesn't specify identityModel.
      getAvailableConnectionMethodSpy.mockReturnValue({} as any);

      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "gallery-no-identity-model",
        connectionName: "App with a gallery entry but no identityModel on its method",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          // Pinned personal_only via config -- must still be honored even
          // though the resolved gallery method doesn't specify identityModel
          // either way.
          config: { url: fake.url, sourceTemplateKey: "gallery-no-identity-model-app", identityModel: "personal_only" },
          transportConfig: { url: fake.url, sourceTemplateKey: "gallery-no-identity-model-app", identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      // No personal grant exists for this connection -- with the
      // personal_only classification correctly honored, this must 403 as
      // user_authorization_required rather than falling back to (nonexistent)
      // shared credentials.
      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "responsible_user_unknown");
      expect(fake.requests).toHaveLength(0);
    } finally {
      getConnectableAppDefinitionSpy.mockRestore();
      getAvailableConnectionMethodSpy.mockRestore();
      await fake.close();
    }
  });

  it("keeps personal_only classification monotonic: a connection pinned as personal_only is never downgraded by a gallery change", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer(async (fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: { content: [{ type: "text", text: "ok" }], structuredContent: {} },
      },
    }));
    const getConnectableAppDefinitionSpy = vi.spyOn(appDefinitions, "getConnectableAppDefinition");
    const getAvailableConnectionMethodSpy = vi.spyOn(appDefinitions, "getAvailableConnectionMethod");
    try {
      getConnectableAppDefinitionSpy.mockImplementation((slug) =>
        slug === "gallery-reclassified-app" ? ({ slug, methods: [{ key: "default", transport: "mcp_remote", auth: "none", ownershipModes: ["company"], whenToUse: "test", riskTier: "S1" }] } as any) : null);
      // Gallery attempts to say "company_or_personal":
      getAvailableConnectionMethodSpy.mockReturnValue({ identityModel: "company_or_personal" } as any);

      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "gallery-reclassified",
        connectionName: "App pinned personal_only, gallery attempts downgrade",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, sourceTemplateKey: "gallery-reclassified-app", identityModel: "personal_only" },
          transportConfig: { url: fake.url, sourceTemplateKey: "gallery-reclassified-app", identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      // Because classification is monotonic, the connection remains personal_only.
      // With no responsible user/grant on the run, it must refuse execution (fail closed),
      // never executing with shared credentials on fake.url.
      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);

      expectGatewayError(error, 403, "responsible_user_unknown");
      expect(fake.requests).toHaveLength(0);
    } finally {
      getConnectableAppDefinitionSpy.mockRestore();
      getAvailableConnectionMethodSpy.mockRestore();
      await fake.close();
    }
  });

  it("resolves the exact stored connectionMethodKey for personal-only classification rather than recommended method", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer(async (fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: { content: [{ type: "text", text: "ok" }], structuredContent: {} },
      },
    }));
    const getConnectableAppDefinitionSpy = vi.spyOn(appDefinitions, "getConnectableAppDefinition");
    try {
      getConnectableAppDefinitionSpy.mockImplementation((slug) =>
        slug === "gallery-multi-method-app" ? ({
          slug,
          methods: [
            { key: "method-shared", transport: "mcp_remote", auth: "none", ownershipModes: ["customer"], whenToUse: "test", riskTier: "S1", identityModel: "company_or_personal" },
            { key: "method-personal", transport: "mcp_remote", auth: "none", ownershipModes: ["customer"], whenToUse: "test", riskTier: "S1", identityModel: "personal_only" },
          ],
        } as any) : null);

      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "gallery-multi-method",
        connectionName: "Multi-method app",
        toolName: "list_calendars",
        url: fake.url,
      });
      // Connection stores connectionMethodKey: "method-personal" (no identityModel in config)
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, sourceTemplateKey: "gallery-multi-method-app", connectionMethodKey: "method-personal" },
          transportConfig: { url: fake.url, sourceTemplateKey: "gallery-multi-method-app", connectionMethodKey: "method-personal" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      // Should be classified as personal_only because method-personal has identityModel: "personal_only"
      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);

      expectGatewayError(error, 403, "responsible_user_unknown");
      expect(fake.requests).toHaveLength(0);
    } finally {
      getConnectableAppDefinitionSpy.mockRestore();
      await fake.close();
    }
  });

  it("refuses a personal_only connection call when the grant-holder has a revoked or suspended company membership", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    // User is suspended in the company:
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "suspended",
      membershipRole: "member",
    });
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));

    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: `personal-token-${randomUUID()}`,
    });
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called for suspended user");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-suspended",
        connectionName: "Personal Google (suspended user)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      const [grant] = await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
        }],
      }).returning();
      await db.insert(companySecretBindings).values({
        companyId: company.id,
        secretId: secret.id,
        targetType: "connection_grant",
        targetId: grant!.id,
        configPath: "oauth.access_token",
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);

      expectGatewayError(error, 403, "grant_owner_membership_inactive");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("exercises actual production definitions: gmail, google-calendar, and slack are classified as personal_only", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("must not be called");
    });
    try {
      const gateway = createTestToolGatewayService(db);
      for (const [slug, methodKey] of [
        ["gmail", "customer-read-oauth"],
        ["google-calendar", "customer-read-oauth"],
        ["slack", "mcp-oauth"],
      ] as const) {
        const remoteTool = await createRemoteMcpTool(db, company.id, {
          applicationKey: `prod-${slug}`,
          connectionName: `Prod ${slug}`,
          toolName: "some_tool",
          url: fake.url,
        });
        await db.update(toolConnections)
          .set({
            config: { url: fake.url, sourceTemplateKey: slug, connectionMethodKey: methodKey },
            transportConfig: { url: fake.url, sourceTemplateKey: slug, connectionMethodKey: methodKey },
          })
          .where(eq(toolConnections.id, remoteTool.connection.id));
        await allowAllToolsForAgent(db, company.id, agent.id);

        const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
        const connectedTool = (await gateway.listToolsForSession(session.token))
          .find((tool) => tool.connectionId === remoteTool.connection.id);
        expect(connectedTool).toBeTruthy();

        // With no responsible user/grant, each real provider must be classified as personal_only
        // directly from its production AppDefinition and refuse execution:
        const error = await gateway.executeTool({
          sessionToken: session.token,
          tool: connectedTool!.name,
          parameters: {},
        }).catch((err: unknown) => err);
        expectGatewayError(error, 403, "responsible_user_unknown");
      }
    } finally {
      await fake.close();
    }
  });

  it("falls back to the stored config identityModel when sourceTemplateKey is stale and resolves no gallery entry", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    // Deliberately no responsibleUserId -- this is enough to prove the
    // personal_only (config-fallback) path was taken, mirroring "refuses a
    // personal_only connection call when the run has no responsible user at
    // all" above, but with a stale/removed sourceTemplateKey instead of no
    // sourceTemplateKey at all.
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with no responsible user");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "gallery-stale-template-key",
        connectionName: "Personal Google (stale sourceTemplateKey)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          // No mocking here: this exercises the real getConnectableAppDefinition,
          // which returns null for a slug that was never (or is no longer) a
          // connectable gallery entry.
          config: { url: fake.url, sourceTemplateKey: "a-removed-app-that-was-never-in-the-gallery", identityModel: "personal_only" },
          transportConfig: { url: fake.url, sourceTemplateKey: "a-removed-app-that-was-never-in-the-gallery", identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "responsible_user_unknown");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("falls back to the stored config identityModel when getAvailableConnectionMethod returns null for a resolvable template key", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    // Deliberately no responsibleUserId, same signal as the stale-key case
    // above: reaching responsible_user_unknown proves the connection was
    // (correctly) treated as personal_only via the config fallback.
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with no responsible user");
    });
    const getAvailableConnectionMethodSpy = vi.spyOn(appDefinitions, "getAvailableConnectionMethod").mockReturnValue(null);
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "gallery-null-method",
        connectionName: "Personal Google (gallery entry resolves, method does not)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          // "slack" is a real, resolvable gallery slug (getConnectableAppDefinition
          // is left unmocked), but getAvailableConnectionMethod is stubbed above
          // to return null for it, as if none of slack's connection methods
          // were available under this deployment's ownership availability.
          config: { url: fake.url, sourceTemplateKey: "slack", connectionMethodKey: "mcp-oauth", identityModel: "personal_only" },
          transportConfig: { url: fake.url, sourceTemplateKey: "slack", connectionMethodKey: "mcp-oauth", identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "responsible_user_unknown");
      expect(fake.requests).toHaveLength(0);
    } finally {
      getAvailableConnectionMethodSpy.mockRestore();
      await fake.close();
    }
  });

  it("audits grant_missing_credential_ref when the responsible user's grant has no oauth.access_token ref", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with a grant missing its credential ref");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-missing-ref",
        connectionName: "Personal Google (test, grant missing credential ref)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        // Deliberately no ref with configPath "oauth.access_token" -- an
        // active grant that was never actually wired to a credential.
        credentialSecretRefs: [{
          secretId: randomUUID(),
          versionSelector: "latest",
          configPath: "oauth.refresh_token",
          required: true,
          label: "Refresh token",
        }],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
      const audits = await db.select().from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.connectionId, remoteTool.connection.id));
      expect(audits).toContainEqual(expect.objectContaining({
        outcome: "failure",
        details: expect.objectContaining({
          source: "tool_gateway.personal_credential_resolution_error",
          reason: "grant_missing_credential_ref",
          connectionId: remoteTool.connection.id,
        }),
      }));
    } finally {
      await fake.close();
    }
  });

  it("audits token_expired_no_refresh_hook when the token is expired and no refresh hook is wired", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: `stale-token-${randomUUID()}`,
    });
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called with an expired token and no refresh hook");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-no-refresh-hook",
        connectionName: "Personal Google (test, expired token, no refresh hook)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      // Deliberately no gateway.configureGrantRefresh call -- refreshUserGrantHook
      // is left unwired, which is the condition this reason code covers.
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
      const audits = await db.select().from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.connectionId, remoteTool.connection.id));
      expect(audits).toContainEqual(expect.objectContaining({
        outcome: "failure",
        details: expect.objectContaining({
          source: "tool_gateway.personal_credential_resolution_error",
          reason: "token_expired_no_refresh_hook",
          connectionId: remoteTool.connection.id,
        }),
      }));
    } finally {
      await fake.close();
    }
  });

  it("audits grant_refresh_returned_null when the refresh hook itself reports failure by returning null", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, responsibleUserId);
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const secret = await secretService(db).create(company.id, {
      name: `Personal Google token ${randomUUID()}`,
      key: `personal_google_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: `stale-token-${randomUUID()}`,
    });
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called when the refresh hook returns null");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-refresh-null",
        connectionName: "Personal Google (test, refresh hook returns null)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await db.insert(connectionGrants).values({
        companyId: company.id,
        connectionId: remoteTool.connection.id,
        kind: "user",
        subjectUserId: responsibleUserId,
        status: "active",
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.access_token",
          required: true,
          label: "Access token",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db);
      // The hook's contract is "never throws, returns null on failure" --
      // this exercises that null-return branch specifically, as distinct
      // from the grant_refresh_hook_failed (throwing) case covered above.
      gateway.configureGrantRefresh(async () => null);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 403, "user_authorization_required");
      expect(fake.requests).toHaveLength(0);
      const audits = await db.select().from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.connectionId, remoteTool.connection.id));
      expect(audits).toContainEqual(expect.objectContaining({
        outcome: "failure",
        details: expect.objectContaining({
          source: "tool_gateway.personal_credential_resolution_error",
          reason: "grant_refresh_returned_null",
          connectionId: remoteTool.connection.id,
        }),
      }));
    } finally {
      await fake.close();
    }
  });

  it("audits runid_invariant_violation and returns a generic error when the session.runId invariant guard fires", async () => {
    // resolveResponsibleUserId's own `!session.runId` early return makes it
    // impossible, through any real request, to reach
    // resolvePersonalOrConnectionCredentialHeaders' runId-invariant guard
    // with a non-null responsibleUserId -- by the time that guard runs,
    // session.runId is guaranteed non-null or the request already failed
    // earlier with responsible_user_unknown. The guard exists purely to fail
    // loudly if a future refactor breaks that guarantee, so this test uses
    // the simulateRunIdInvariantViolationForTesting test seam (see
    // createToolGatewayService's options) to force the guard's "violated"
    // branch for an otherwise-valid personal-only-connection request, and
    // asserts it (a) throws a typed ToolGatewayHttpError with a generic,
    // non-leaking message -- not the plain Error this guard used to throw,
    // which sendGatewayError (server/src/routes/tool-gateway.ts) would have
    // echoed verbatim into a 500 response body -- and (b) still records the
    // specific runid_invariant_violation reason on the audit trail.
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const responsibleUserId = `user-${randomUUID()}`;
    await db.update(heartbeatRuns)
      .set({ responsibleUserId, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>), responsibleUserId } })
      .where(eq(heartbeatRuns.id, run.id));
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called when the runId invariant guard fires");
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-runid-invariant",
        connectionName: "Personal Google (test, runId invariant guard)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      // Deliberately no connectionGrants row -- resolveUserGrantAuthHeader
      // returns null (no grant), which is what lets execution reach the
      // startUserAuthorizationHook branch where the invariant guard lives.
      await allowAllToolsForAgent(db, company.id, agent.id);

      const gateway = createTestToolGatewayService(db, { simulateRunIdInvariantViolationForTesting: true });
      let authorizationStarted = false;
      gateway.configureUserAuthorization(async () => {
        authorizationStarted = true;
      });
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const error = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: {},
      }).catch((err: unknown) => err);
      expectGatewayError(error, 500, "runid_invariant_violation");
      expect((error as ToolGatewayHttpError).message).toBe("Internal error: session invariant violated");
      expect((error as ToolGatewayHttpError).message).not.toMatch(/session\.runId|resolvePersonalOrConnectionCredentialHeaders/);
      expect(authorizationStarted).toBe(false);
      expect(fake.requests).toHaveLength(0);
      const audits = await db.select().from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.connectionId, remoteTool.connection.id));
      expect(audits).toContainEqual(expect.objectContaining({
        outcome: "failure",
        action: "call_failed",
        reasonCode: "runid_invariant_violation",
        details: expect.objectContaining({
          source: "tool_gateway.personal_credential_resolution_error",
          reason: "runid_invariant_violation",
          connectionId: remoteTool.connection.id,
        }),
      }));
      // The guard above (inside resolvePersonalOrConnectionCredentialHeaders)
      // isn't the only place this reason code lands: the throw it produces
      // propagates up through executeTool's outer try/catch, which writes a
      // SECOND, independent audit event for the same failed call --
      // "tool_gateway.call_failed" carrying the ToolGatewayHttpError's own
      // reasonCode ("runid_invariant_violation") in its details. Both rows
      // are asserted here so a future change that alters either mapping
      // (e.g. reverting the writeAudit `details.reason` fallback, or
      // changing what reasonCode the outer catch forwards) gets caught by
      // this test instead of silently regressing.
      expect(audits).toContainEqual(expect.objectContaining({
        outcome: "failure",
        action: "call_failed",
        reasonCode: "runid_invariant_violation",
        details: expect.objectContaining({
          source: "tool_gateway.call_failed",
          reasonCode: "runid_invariant_violation",
          connectionId: remoteTool.connection.id,
        }),
      }));
    } finally {
      await fake.close();
    }
  });

  it("refuses to construct the gateway service when simulateRunIdInvariantViolationForTesting is set under NODE_ENV=production", () => {
    // The guard is a denylist of the one forbidden value (production), not an
    // allowlist of "test" -- see the comment at the guard's call site in
    // tool-gateway.ts. This locks in that a real production NODE_ENV always
    // trips it, regardless of what other test frameworks set it to.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        createTestToolGatewayService(db, { simulateRunIdInvariantViolationForTesting: true }),
      ).toThrow(/simulateRunIdInvariantViolationForTesting must not be set in production/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("audits agent_not_personal and denies a personal_only connection call made through an agentless named gateway", async () => {
    const company = await createCompany(db);
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `agent-not-personal-${randomUUID()}`,
      name: `Agent not personal ${randomUUID()}`,
      defaultAction: "allow",
    }).returning();
    const fake = await startFakeRemoteMcpServer(async () => {
      throw new Error("fake remote MCP server should not be called without an acting agent");
    });
    try {
      const { application, connection, catalogEntry } = await createRemoteMcpTool(db, company.id, {
        applicationKey: "personal-google-agentless-gateway",
        connectionName: "Personal Google (test, agentless named gateway)",
        toolName: "list_calendars",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: { url: fake.url, identityModel: "personal_only" },
          transportConfig: { url: fake.url, identityModel: "personal_only" },
        })
        .where(eq(toolConnections.id, connection.id));
      const gatewayToolName = expectedConnectedToolName({
        applicationKey: application.applicationKey,
        connectionId: connection.id,
        toolName: catalogEntry.toolName,
      });

      const gateway = createTestToolGatewayService(db);
      // A named gateway created without an agentId, authenticated via a
      // gateway_client bearer token -- this is the one session shape whose
      // agentId is null, which is the precondition
      // resolvePersonalOrConnectionCredentialHeaders' agent_not_personal
      // guard exists to catch: there is no agent to act as a specific
      // person's delegate.
      const created = await gateway.createNamedGateway({
        companyId: company.id,
        body: { name: "Agentless gateway", profileId: profile!.id },
      });
      const token = await gateway.createNamedGatewayToken({
        companyId: company.id,
        gatewayId: created.id,
        body: { name: "Agentless client", clientLabel: "Agentless client" },
      });
      const app = createGatewayRouteApp(db, gateway);

      const called = await request(app)
        .post(`/api/tool-gateway/gateways/${created.id}/mcp`)
        .set("authorization", `Bearer ${token.token}`)
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: gatewayToolName, arguments: {} },
        });
      expect(called.status).toBe(403);
      expect(called.body.error.data.reasonCode).toBe("agent_not_personal");
      expect(fake.requests).toHaveLength(0);
      const audits = await db.select().from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.connectionId, connection.id));
      expect(audits).toContainEqual(expect.objectContaining({
        outcome: "denied",
        action: "call_denied",
        reasonCode: "agent_not_personal",
        details: expect.objectContaining({
          source: "tool_gateway.personal_credential_resolution_error",
          reason: "agent_not_personal",
          connectionId: connection.id,
        }),
      }));
    } finally {
      await fake.close();
    }
  });

  it("keeps managed credentials authoritative even when legacy override flags are set", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const credentialValue = `managed-credential-${randomUUID()}`;
    const secret = await secretService(db).create(company.id, {
      name: `Header policy token ${randomUUID()}`,
      key: `header_policy_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: credentialValue,
    });
    const fake = await startFakeRemoteMcpServer((fakeRequest) => {
      expect(fakeRequest.headers.authorization).toBe(`Bearer ${credentialValue}`);
      expect(fakeRequest.headers["x-client-request-id"]).toBe("caller-123");
      expect(fakeRequest.headers["x-static-mode"]).toBe("canary");
      expect(fakeRequest.headers["x-paperclip-agent-id"]).toBe(agent.id);
      expect(fakeRequest.headers["x-paperclip-issue-id"]).toBe(issue.id);
      expect(fakeRequest.headers["x-paperclip-tool-gateway-token"]).toBeUndefined();
      expect(fakeRequest.headers["x-unlisted-header"]).toBeUndefined();
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: { content: [{ type: "text", text: "headers ok" }] },
        },
      };
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "header-policy",
        toolName: "kv_set",
        url: fake.url,
        credentialRefs: [{
          name: "authorization",
          secretId: secret.id,
          version: "latest",
          placement: "header",
          key: "Authorization",
          prefix: "Bearer ",
        }],
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "credentials.authorization",
          required: true,
          label: "Remote MCP token",
        }],
      });
      await db.update(toolConnections)
        .set({
          config: {
            url: fake.url,
            headerPolicy: {
              allowManagedCredentialOverride: true,
              passthrough: {
                allowedHeaders: ["x-client-request-id", "authorization", "x-paperclip-tool-gateway-token"],
                allowManagedCredentialOverride: true,
              },
              staticHeaders: [{ name: "x-static-mode", value: "canary" }],
              metadata: { forward: ["agent_id", "issue_id"] },
            },
          },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.connectionId === remoteTool.connection.id);
      expect(connectedTool).toBeTruthy();

      await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: { key: "alpha", value: "one" },
        callerHeaders: {
          authorization: "Bearer caller-must-not-win",
          "x-client-request-id": "caller-123",
          "x-paperclip-tool-gateway-token": "caller-session-token",
          "x-unlisted-header": "drop-me",
        },
      });

      const [activity] = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "tool_gateway.call_completed"));
      expect(activity.details).toMatchObject({
        headerSummary: {
          credentialHeaderNames: "***REDACTED***",
          passthroughHeaderNames: ["x-client-request-id"],
          droppedPassthroughHeaderNames: expect.arrayContaining([
            "authorization",
            "x-paperclip-tool-gateway-token",
            "x-unlisted-header",
          ]),
          staticHeaderNames: ["x-static-mode"],
          metadataHeaderNames: ["x-paperclip-agent-id", "x-paperclip-issue-id"],
          collisionRules: expect.arrayContaining([
            { header: "authorization", source: "caller", action: "kept_managed_credential" },
            { header: "x-paperclip-tool-gateway-token", source: "caller", action: "dropped_sensitive_header" },
          ]),
        },
      });
      const persisted = JSON.stringify({
        activity: await db.select().from(activityLog),
        events: await db.select().from(toolCallEvents),
        invocations: await db.select().from(toolInvocations),
      });
      expect(persisted).not.toContain(credentialValue);
      expect(persisted).not.toContain("caller-must-not-win");
      expect(persisted).not.toContain("caller-123");
      expect(persisted).not.toContain("caller-session-token");
    } finally {
      await fake.close();
    }
  });

  it("drops auth-bearing and Paperclip session headers from passthrough allowlists", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => {
      expect(fakeRequest.headers.authorization).toBeUndefined();
      expect(fakeRequest.headers["x-auth-token"]).toBeUndefined();
      expect(fakeRequest.headers["x-paperclip-tool-gateway-token"]).toBeUndefined();
      expect(fakeRequest.headers["x-client-request-id"]).toBe("caller-456");
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: { content: [{ type: "text", text: "headers ok" }] },
        },
      };
    });
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "header-policy-sensitive",
        toolName: "kv_set",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({
          config: {
            url: fake.url,
            headerPolicy: {
              passthrough: {
                allowedHeaders: [
                  "authorization",
                  "x-auth-token",
                  "x-client-request-id",
                  "x-paperclip-tool-gateway-token",
                ],
              },
            },
          },
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.connectionId === remoteTool.connection.id);
      expect(connectedTool).toBeTruthy();

      await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: { key: "beta", value: "two" },
        callerHeaders: {
          authorization: "Bearer caller-should-drop",
          "x-auth-token": "drop-auth-token",
          "x-client-request-id": "caller-456",
          "x-paperclip-tool-gateway-token": "drop-gateway-token",
        },
      });

      const [activity] = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "tool_gateway.call_completed"));
      expect(activity.details).toMatchObject({
        headerSummary: {
          credentialHeaderNames: "***REDACTED***",
          passthroughHeaderNames: ["x-client-request-id"],
          droppedPassthroughHeaderNames: expect.arrayContaining([
            "authorization",
            "x-auth-token",
            "x-paperclip-tool-gateway-token",
          ]),
          collisionRules: expect.arrayContaining([
            { header: "authorization", source: "caller", action: "dropped_sensitive_header" },
            { header: "x-auth-token", source: "caller", action: "dropped_sensitive_header" },
            { header: "x-paperclip-tool-gateway-token", source: "caller", action: "dropped_sensitive_header" },
          ]),
        },
      });
      const persisted = JSON.stringify({
        activity: await db.select().from(activityLog),
        events: await db.select().from(toolCallEvents),
        invocations: await db.select().from(toolInvocations),
      });
      expect(persisted).not.toContain("caller-should-drop");
      expect(persisted).not.toContain("drop-auth-token");
      expect(persisted).not.toContain("drop-gateway-token");
    } finally {
      await fake.close();
    }
  });

  it("uses virtual on-demand run_tool while applying target tool policy and audit metadata", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: {
          content: [{ type: "text", text: "virtual ok" }],
          structuredContent: { receivedArguments: (fakeRequest.body?.params as Record<string, unknown>).arguments },
        },
      },
    }));
    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "virtual-demo",
        toolName: "kv_set",
        url: fake.url,
      });
      await db.update(toolConnections)
        .set({ config: { url: fake.url, onDemandTools: { enabled: true } } })
        .where(eq(toolConnections.id, remoteTool.connection.id));
      const targetToolName = expectedConnectedToolName({
        applicationKey: remoteTool.application.applicationKey,
        connectionId: remoteTool.connection.id,
        toolName: remoteTool.catalogEntry.toolName,
      });
      await allowToolsForAgent(db, company.id, agent.id, [targetToolName]);

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const visibleTools = await gateway.listToolsForSession(session.token);
      expect(visibleTools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["search_tools", "run_tool"]));
      expect(visibleTools.map((tool) => tool.name)).not.toContain(targetToolName);

      const search = await gateway.executeTool({
        sessionToken: session.token,
        tool: "search_tools",
        parameters: { query: "kv", limit: 5 },
      });
      expect(JSON.stringify(search.result)).toContain(targetToolName);

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: "run_tool",
        parameters: {
          tool: targetToolName,
          arguments: { key: "virtual-key", value: "virtual-value" },
        },
      });
      expect(result).toMatchObject({
        status: "completed",
        tool: "run_tool",
        targetTool: targetToolName,
      });
      expect(fake.requests.at(-1)!.body).toMatchObject({
        params: {
          name: "kv_set",
          arguments: { key: "virtual-key", value: "virtual-value" },
        },
      });

      const [invocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.toolName, targetToolName));
      expect(invocation).toMatchObject({
        providerType: "mcp_remote_http",
        connectionId: remoteTool.connection.id,
        catalogEntryId: remoteTool.catalogEntry.id,
        status: "succeeded",
      });
      const completedEvents = await db
        .select()
        .from(toolCallEvents)
        .where(eq(toolCallEvents.eventType, "call_completed"));
      expect(completedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          toolName: targetToolName,
          metadata: expect.objectContaining({
            virtualToolName: "run_tool",
            targetToolName,
          }),
        }),
      ]));
      const completedActivity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "tool_gateway.call_completed"));
      expect(completedActivity).toEqual(expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            virtualToolName: "run_tool",
            targetToolName,
            connectionId: remoteTool.connection.id,
          }),
        }),
      ]));
    } finally {
      await fake.close();
    }
  });

  it("decodes an SSE-framed tools/call response from a spec-compliant Streamable HTTP server", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    // Spec-compliant server: 406 unless the request advertises both content
    // types, and replies with an SSE-framed body (PAP-11096).
    const fake = await startFakeRemoteMcpServer((fakeRequest) => {
      const accept = String(fakeRequest.headers.accept ?? "");
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        return { status: 406, rawBody: "Not Acceptable" };
      }
      const message = {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: { content: [{ type: "text", text: "sse ok" }], structuredContent: { via: "sse" } },
      };
      return {
        headers: { "content-type": "text/event-stream" },
        rawBody: `event: message\ndata: ${JSON.stringify(message)}\n\n`,
      };
    });
    try {
      await createRemoteMcpTool(db, company.id, {
        applicationKey: "kv-demo",
        connectionName: "KV Demo SSE",
        toolName: "kv_set",
        title: "Set KV value",
        url: fake.url,
        credentialRefs: [],
        credentialSecretRefs: [],
      });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http");
      expect(connectedTool).toBeTruthy();

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: { key: "alpha", value: "one" },
      });
      expect(result).toMatchObject({
        status: "completed",
        result: { content: "sse ok", data: { structuredContent: { via: "sse" }, transport: "mcp_http" } },
      });
    } finally {
      await fake.close();
    }
  });

  it("discovers and calls the SDK-backed KV demo MCP server over Streamable HTTP", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const kvDemo: KvDemoHttpServer = createKvDemoHttpServer();
    const port = await kvDemo.listen(0, "127.0.0.1");
    try {
      const access = toolAccessService(db);
      const connection = await access.createConnection(company.id, {
        name: "KV demo SDK fixture",
        transport: "mcp_remote",
        config: { url: `http://127.0.0.1:${port}/mcp` },
        enabled: true,
        status: "active",
      });
      const refresh = await access.refreshCatalog(connection.id, { actorType: "user", actorId: "board" });
      expect(refresh.catalog.map((entry) => entry.toolName).sort()).toEqual([
        "kv_delete",
        "kv_get",
        "kv_list",
        "kv_set",
      ]);

      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const connectedTool = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.providerType === "mcp_remote_http" && tool.upstreamToolName === "kv_set");
      expect(connectedTool).toBeTruthy();

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: connectedTool!.name,
        parameters: { key: "streamable-key", value: "streamable-value" },
      });

      expect(result).toMatchObject({
        status: "completed",
        tool: connectedTool!.name,
        result: {
          data: {
            isError: false,
            transport: "mcp_http",
            spawnedLocalProcess: false,
          },
        },
      });
      expect(kvDemo.store.snapshot().entries).toEqual([
        expect.objectContaining({ key: "streamable-key", value: "streamable-value" }),
      ]);
    } finally {
      await kvDemo.close();
    }
  });

  it("expires legacy managed-connector approvals before provider dispatch", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: { content: [{ type: "text", text: "should not run" }] },
      },
    }));

    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "shopify",
        toolName: "kv_set",
        url: fake.url,
        connectionConfig: {
          sourceTemplateKey: "shopify",
          connectionMethodKey: "ucp-commerce",
          methodConfig: { storeDomain: "paperclip-demo.myshopify.com" },
        },
      });
      const toolName = expectedConnectedToolName({
        applicationKey: remoteTool.application.applicationKey,
        connectionId: remoteTool.connection.id,
        toolName: remoteTool.catalogEntry.toolName,
      });
      await allowToolsForAgent(db, company.id, agent.id, [toolName]);
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "Review managed Shopify writes",
        policyType: "require_approval",
        selectors: { connectionId: remoteTool.connection.id },
        priority: 10,
      });

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      await gateway.executeTool({
        sessionToken: session.token,
        tool: toolName,
        parameters: { key: "legacy", value: "reviewed" },
      }).then(
        () => {
          throw new Error("Expected managed Shopify call to require approval");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );

      const [actionRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));
      const signedPayload = readSignedToolArgumentsPayload({
        signedArguments: actionRequest.signedArguments,
        invocationId: actionRequest.invocationId,
        toolName,
        signingSecret: testToolActionSigningSecret,
      });
      expect(signedPayload?.executionOnApprove).toBe(true);

      // Model an approval signed before Shopify's UCP agent profile became a
      // required managed argument. Its signature and hash are valid for that
      // historical payload, but it is no longer compatible with dispatch.
      const legacyParameters = { key: "legacy", value: "reviewed" };
      const legacyCanonical = canonicalToolArguments(legacyParameters);
      const legacySummary = summarizeToolValue(legacyParameters);
      await db
        .update(toolActionRequests)
        .set({
          signedArguments: signToolArguments({
            invocationId: actionRequest.invocationId,
            toolName,
            canonicalArguments: legacyCanonical,
            approvalSnapshot: signedPayload?.approvalSnapshot,
            executionOnApprove: true,
            signingSecret: testToolActionSigningSecret,
          }),
          canonicalArgumentsHash: legacySummary.sha256,
          canonicalArgumentsSummary: legacySummary,
          updatedAt: new Date(),
        })
        .where(eq(toolActionRequests.id, actionRequest.id));

      await expect(gateway.approveActionRequest({
        companyId: company.id,
        issueId: issue.id,
        interactionId: actionRequest.interactionId!,
        actionRequestId: actionRequest.id,
        actor: { userId: "board-user" },
      })).resolves.toMatchObject({ status: "expired" });

      expect(fake.requests).toHaveLength(0);
      const [expiredRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, actionRequest.id));
      expect(expiredRequest.status).toBe("expired");
      const [failedInvocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.id, actionRequest.invocationId));
      expect(failedInvocation).toMatchObject({
        status: "failed",
        approvalState: "expired",
        errorCode: "approved_tool_managed_arguments_changed",
      });
    } finally {
      await fake.close();
    }
  });

  it("does not expire a managed-connector provider execution already in flight", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: { content: [{ type: "text", text: "concurrent execution won" }] },
      },
    }));

    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "shopify",
        toolName: "kv_set",
        url: fake.url,
        connectionConfig: {
          sourceTemplateKey: "shopify",
          connectionMethodKey: "ucp-commerce",
          methodConfig: { storeDomain: "paperclip-demo.myshopify.com" },
        },
      });
      const toolName = expectedConnectedToolName({
        applicationKey: remoteTool.application.applicationKey,
        connectionId: remoteTool.connection.id,
        toolName: remoteTool.catalogEntry.toolName,
      });
      await allowToolsForAgent(db, company.id, agent.id, [toolName]);
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "Review raced managed Shopify writes",
        policyType: "require_approval",
        selectors: { connectionId: remoteTool.connection.id },
        priority: 10,
      });

      let driftExpiryReached!: () => void;
      const driftExpiryStarted = new Promise<void>((resolve) => {
        driftExpiryReached = resolve;
      });
      let resumeDriftExpiry!: () => void;
      const driftExpiryResume = new Promise<void>((resolve) => {
        resumeDriftExpiry = resolve;
      });
      const gateway = createTestToolGatewayService(db, {
        beforeManagedArgumentDriftExpiry: async () => {
          driftExpiryReached();
          await driftExpiryResume;
        },
      });
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      await gateway.executeTool({
        sessionToken: session.token,
        tool: toolName,
        parameters: { key: "raced", value: "reviewed" },
      }).then(
        () => {
          throw new Error("Expected managed Shopify call to require approval");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );

      const [actionRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));
      const signedPayload = readSignedToolArgumentsPayload({
        signedArguments: actionRequest.signedArguments,
        invocationId: actionRequest.invocationId,
        toolName,
        signingSecret: testToolActionSigningSecret,
      });
      const legacyParameters = { key: "raced", value: "reviewed" };
      const legacyCanonical = canonicalToolArguments(legacyParameters);
      const legacySummary = summarizeToolValue(legacyParameters);
      await db
        .update(toolActionRequests)
        .set({
          signedArguments: signToolArguments({
            invocationId: actionRequest.invocationId,
            toolName,
            canonicalArguments: legacyCanonical,
            approvalSnapshot: signedPayload?.approvalSnapshot,
            executionOnApprove: true,
            signingSecret: testToolActionSigningSecret,
          }),
          canonicalArgumentsHash: legacySummary.sha256,
          canonicalArgumentsSummary: legacySummary,
          updatedAt: new Date(),
        })
        .where(eq(toolActionRequests.id, actionRequest.id));

      const approvedAt = new Date();
      await db
        .update(issueThreadInteractions)
        .set({ status: "accepted", resolvedByAgentId: agent.id, resolvedAt: approvedAt, updatedAt: approvedAt })
        .where(eq(issueThreadInteractions.id, actionRequest.interactionId!));
      await db
        .update(toolActionRequests)
        .set({ status: "approved", resolvedByAgentId: agent.id, resolvedAt: approvedAt, updatedAt: approvedAt })
        .where(eq(toolActionRequests.id, actionRequest.id));
      await db
        .update(toolInvocations)
        .set({ approvalState: "approved", updatedAt: approvedAt })
        .where(eq(toolInvocations.id, actionRequest.invocationId));

      const retrying = gateway.executeTool({
        sessionToken: session.token,
        tool: toolName,
        parameters: legacyParameters,
        approvedActionRequestId: actionRequest.id,
      });
      await driftExpiryStarted;

      const executingAt = new Date();
      await db
        .update(toolActionRequests)
        .set({ status: "executing", updatedAt: executingAt })
        .where(eq(toolActionRequests.id, actionRequest.id));
      await db
        .update(toolInvocations)
        .set({
          status: "executing",
          approvalState: "approved",
          errorCode: null,
          errorMessage: null,
          startedAt: executingAt,
          completedAt: null,
          updatedAt: executingAt,
        })
        .where(eq(toolInvocations.id, actionRequest.invocationId));
      resumeDriftExpiry();

      await retrying.then(
        () => {
          throw new Error("Expected the stale approved retry to request a new approval");
        },
        (error) => expectGatewayError(error, 409, "approved_tool_managed_arguments_changed"),
      );
      const [inFlightRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, actionRequest.id));
      const [inFlightInvocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.id, actionRequest.invocationId));
      expect(inFlightRequest.status).toBe("executing");
      expect(inFlightInvocation).toMatchObject({
        status: "executing",
        approvalState: "approved",
        errorCode: null,
        errorMessage: null,
      });

      const completedAt = new Date();
      const winnerSummary = summarizeToolValue({ winner: "concurrent execution" });
      await db
        .update(toolActionRequests)
        .set({ status: "executed", resolvedAt: completedAt, updatedAt: completedAt })
        .where(eq(toolActionRequests.id, actionRequest.id));
      await db
        .update(toolInvocations)
        .set({
          status: "completed",
          resultSummary: winnerSummary,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(toolInvocations.id, actionRequest.invocationId));
      const [winnerInvocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.id, actionRequest.invocationId));
      expect(winnerInvocation).toMatchObject({
        status: "completed",
        approvalState: "approved",
        resultSummary: winnerSummary,
        errorCode: null,
        errorMessage: null,
      });
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("enforces policy, approvals, retries, rate limits, and company boundaries for connected remote MCP calls", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const otherCompany = await createCompany(db);
    const otherAgent = await createAgent(db, otherCompany.id);
    const { run: otherRun } = await createIssueAndRun(db, otherCompany.id, otherAgent.id);
    let pauseApprovedExecution = false;
    let approvedExecutionReached!: () => void;
    const approvedExecutionStarted = new Promise<void>((resolve) => {
      approvedExecutionReached = resolve;
    });
    let releaseApprovedExecution = () => {};
    const approvedExecutionRelease = new Promise<void>((resolve) => {
      releaseApprovedExecution = resolve;
    });
    const fake = await startFakeRemoteMcpServer(async (fakeRequest) => {
      const requestArguments = (fakeRequest.body?.params as Record<string, unknown> | undefined)?.arguments;
      if (
        pauseApprovedExecution
        && requestArguments
        && typeof requestArguments === "object"
        && (requestArguments as Record<string, unknown>).key === "approved"
      ) {
        pauseApprovedExecution = false;
        approvedExecutionReached();
        await approvedExecutionRelease;
      }
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: {
            content: [{ type: "text", text: "connected ok" }],
            structuredContent: {
              receivedArguments: requestArguments,
              leakedToken: "sk-connected-mcp-secret-123456",
            },
          },
        },
      };
    });

    try {
      const denyTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "deny-app",
        toolName: "kv_set",
        url: fake.url,
      });
      const denyToolName = expectedConnectedToolName({
        applicationKey: denyTool.application.applicationKey,
        connectionId: denyTool.connection.id,
        toolName: denyTool.catalogEntry.toolName,
      });

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

      await gateway.executeTool({
        sessionToken: session.token,
        tool: denyToolName,
        parameters: { key: "blocked", value: "secret=sk-denied-secret-123456" },
      }).then(
        () => {
          throw new Error("Expected connected MCP call to be denied by default");
        },
        (error) => expectGatewayError(error, 403, "deny_default"),
      );

      const [deniedInvocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.toolName, denyToolName));
      expect(deniedInvocation).toMatchObject({
        companyId: company.id,
        status: "denied",
        errorCode: "deny_default",
        providerType: "mcp_remote_http",
        applicationKey: "deny-app",
        upstreamToolName: "kv_set",
        riskLevel: "write",
      });
      expect(JSON.stringify(deniedInvocation)).not.toContain("sk-denied-secret-123456");

      const approvalTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "shopify",
        toolName: "kv_set",
        url: fake.url,
        connectionConfig: {
          sourceTemplateKey: "shopify",
          connectionMethodKey: "ucp-commerce",
          methodConfig: { storeDomain: "paperclip-demo.myshopify.com" },
        },
      });
      await allowToolsForAgent(db, company.id, agent.id, [
        expectedConnectedToolName({
          applicationKey: approvalTool.application.applicationKey,
          connectionId: approvalTool.connection.id,
          toolName: approvalTool.catalogEntry.toolName,
        }),
      ]);
      const approvalToolName = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.connectionId === approvalTool.connection.id)!.name;
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "Review connected writes",
        policyType: "require_approval",
        selectors: { connectionId: approvalTool.connection.id },
        description: "Connected MCP writes need review.",
        priority: 10,
      });

      await gateway.executeTool({
        sessionToken: session.token,
        tool: approvalToolName,
        parameters: { key: "approved", value: "original" },
      }).then(
        () => {
          throw new Error("Expected connected MCP call to require approval");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );
      const [approvalRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));
      expect(approvalRequest).toMatchObject({
        issueId: issue.id,
        status: "pending",
        canonicalArgumentsHash: expect.any(String),
        canonicalArgumentsSummary: {
          summary: expect.stringContaining("valid-with-capabilities.json"),
        },
      });
      const [approvalInteraction] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, approvalRequest.interactionId!));
      expect(approvalInteraction).toMatchObject({
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Approve KV Set?",
          detailsMarkdown: expect.stringContaining('"value":"original"'),
          target: {
            type: "custom",
            key: `tool-action:${approvalRequest.id}`,
          },
          toolAction: {
            version: 1,
            actionRequestId: approvalRequest.id,
            invocationId: approvalRequest.invocationId,
            toolName: approvalToolName,
            toolDisplayName: expect.any(String),
            connectionId: approvalTool.connection.id,
            applicationId: approvalTool.application.id,
            appDisplayName: approvalTool.application.name,
            risk: "write",
            previewMarkdown: approvalRequest.previewMarkdown,
            argumentsSummaryJson: expect.stringContaining('"value":"original"'),
            argumentsHash: approvalRequest.canonicalArgumentsHash,
            expiresAt: approvalRequest.expiresAt!.toISOString(),
          },
        },
      });
      const [approvalInvocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.id, approvalRequest.invocationId));
      expect(approvalInvocation).toMatchObject({
        status: "awaiting_approval",
        policyDecision: "require_approval",
        connectionId: approvalTool.connection.id,
        providerType: "mcp_remote_http",
        applicationKey: "shopify",
        upstreamToolName: "kv_set",
      });

      await db
        .update(issueThreadInteractions)
        .set({
          status: "accepted",
          result: { version: 1, outcome: "accepted" },
          resolvedByAgentId: agent.id,
          resolvedAt: new Date(),
        })
        .where(eq(issueThreadInteractions.id, approvalRequest.interactionId!));

      pauseApprovedExecution = true;
      const approvedExecution = gateway.executeTool({
        sessionToken: session.token,
        tool: approvalToolName,
        parameters: { key: "approved", value: "tampered" },
        approvedActionRequestId: approvalRequest.id,
      });
      await approvedExecutionStarted;
      const [executingApproval] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, approvalRequest.id));
      expect(executingApproval.status).toBe("executing");

      const concurrentRetry = gateway.executeTool({
        sessionToken: session.token,
        tool: approvalToolName,
        parameters: { key: "approved", value: "original" },
      });
      releaseApprovedExecution();

      await expect(approvedExecution).resolves.toMatchObject({
        status: "completed",
        tool: approvalToolName,
        result: {
          data: {
            structuredContent: {
              leakedToken: "***REDACTED***",
            },
          },
        },
      });
      await expect(concurrentRetry).resolves.toMatchObject({
        status: "replayed",
        result: expect.anything(),
      });
      expect(fake.requests.at(-1)!.body).toMatchObject({
        params: {
          name: "kv_set",
          arguments: {
            key: "approved",
            value: "original",
            meta: {
              "ucp-agent": {
                profile: "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json",
              },
            },
          },
        },
      });
      const [executedApproval] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, approvalRequest.id));
      expect(executedApproval.status).toBe("executed");
      const [completedInteraction] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, approvalRequest.interactionId!));
      expect(completedInteraction.result).toMatchObject({
        version: 1,
        outcome: "accepted",
        toolAction: {
          version: 1,
          status: "executed",
          errorCode: null,
          errorMessage: null,
          updatedAt: expect.any(String),
        },
      });
      const approvedCompletion = (await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "tool_gateway.call_completed")))
        .find((event) => event.details?.invocationId === approvalRequest.invocationId);
      expect(approvedCompletion?.details).toMatchObject({
        argumentsSummary: {
          summary: expect.stringContaining('"value":"original"'),
        },
        execution: {
          transport: "mcp_remote",
          request: {
            protocol: "MCP JSON-RPC 2.0",
            httpMethod: "POST",
            endpoint: fake.url,
            mcpMethod: "tools/call",
            requestId: expect.stringMatching(/^paperclip-tool-/),
            upstreamToolName: "kv_set",
            dispatched: true,
          },
          response: {
            httpStatus: 200,
            contentType: "application/json",
            bodySizeBytes: expect.any(Number),
          },
        },
      });

      const rejectedTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "rejected-app",
        toolName: "kv_set",
        url: fake.url,
      });
      await allowToolsForAgent(db, company.id, agent.id, [
        expectedConnectedToolName({
          applicationKey: rejectedTool.application.applicationKey,
          connectionId: rejectedTool.connection.id,
          toolName: rejectedTool.catalogEntry.toolName,
        }),
      ]);
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "Reject connected writes",
        policyType: "require_approval",
        selectors: { connectionId: rejectedTool.connection.id },
        description: "This approval will be rejected.",
        priority: 5,
      });
      const rejectedToolName = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.connectionId === rejectedTool.connection.id)!.name;
      await gateway.executeTool({
        sessionToken: session.token,
        tool: rejectedToolName,
        parameters: { key: "rejected", value: "never-run" },
      }).then(
        () => {
          throw new Error("Expected connected MCP call to require approval before rejection");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );
      const rejectedRequest = (await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id)))
        .find((requestRow) => requestRow.id !== approvalRequest.id)!;
      await gateway.declineActionRequest({
        companyId: company.id,
        actionRequestId: rejectedRequest.id,
        actor: { userId: "board-user" },
      });
      await gateway.executeTool({
        sessionToken: session.token,
        tool: rejectedToolName,
        parameters: { key: "rejected", value: "retry" },
        approvedActionRequestId: rejectedRequest.id,
      }).then(
        () => {
          throw new Error("Expected rejected approval to block retry");
        },
        (error) => expectGatewayError(error, 409, "action_not_approved"),
      );

      const rateTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "rate-app",
        toolName: "kv_set",
        url: fake.url,
      });
      await allowToolsForAgent(db, company.id, agent.id, [
        expectedConnectedToolName({
          applicationKey: rateTool.application.applicationKey,
          connectionId: rateTool.connection.id,
          toolName: rateTool.catalogEntry.toolName,
        }),
      ]);
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "One connected call",
        policyType: "rate_limit",
        selectors: { connectionId: rateTool.connection.id },
        config: { limit: 1, windowSeconds: 60 },
        priority: 1,
      });
      const rateToolName = (await gateway.listToolsForSession(session.token))
        .find((tool) => tool.connectionId === rateTool.connection.id)!.name;
      await expect(gateway.executeTool({
        sessionToken: session.token,
        tool: rateToolName,
        parameters: { key: "rate", value: "first" },
      })).resolves.toMatchObject({ status: "completed" });
      await gateway.executeTool({
        sessionToken: session.token,
        tool: rateToolName,
        parameters: { key: "rate", value: "second" },
      }).then(
        () => {
          throw new Error("Expected connected MCP call to be rate limited");
        },
        (error) => expectGatewayError(error, 429, "rate_limited"),
      );
      const [rateLimitedInvocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.toolName, rateToolName))
        .then((rows) => rows.filter((row) => row.status === "rate_limited"));
      expect(rateLimitedInvocation).toMatchObject({
        connectionId: rateTool.connection.id,
        providerType: "mcp_remote_http",
        applicationKey: "rate-app",
        errorCode: "rate_limited",
      });

      const otherTool = await createRemoteMcpTool(db, otherCompany.id, {
        applicationKey: "other-company-app",
        toolName: "kv_set",
        url: fake.url,
      });
      await allowAllToolsForAgent(db, otherCompany.id, otherAgent.id);
      const otherGateway = createTestToolGatewayService(db);
      const otherSession = await otherGateway.createSession({ companyId: otherCompany.id, agentId: otherAgent.id, runId: otherRun.id });
      const otherToolName = (await otherGateway.listToolsForSession(otherSession.token))
        .find((tool) => tool.connectionId === otherTool.connection.id)!.name;
      await gateway.executeTool({
        sessionToken: session.token,
        tool: otherToolName,
        parameters: { key: "cross", value: "company" },
      }).then(
        () => {
          throw new Error("Expected cross-company connected MCP tool name to be hidden");
        },
        (error) => expectGatewayError(error, 404, "tool_not_found"),
      );

      const persisted = JSON.stringify({
        invocations: await db.select().from(toolInvocations),
        callEvents: await db.select().from(toolCallEvents),
        audits: await db.select().from(toolAccessAuditEvents),
        activity: await db.select().from(activityLog),
      });
      expect(persisted).not.toContain("sk-connected-mcp-secret-123456");
      expect(persisted).not.toContain("sk-denied-secret-123456");
      expect(persisted).toContain("mcp_remote_http");
      expect(persisted).toContain("shopify");
      expect(persisted).toContain("kv_set");
    } finally {
      releaseApprovedExecution();
      await fake.close();
    }
  });

  it("requires re-review when an approved connected MCP replay target changed", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: {
          content: [{ type: "text", text: "should not run after target drift" }],
        },
      },
    }));

    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "approval-drift-app",
        toolName: "kv_set",
        url: fake.url,
      });
      const remoteToolName = expectedConnectedToolName({
        applicationKey: remoteTool.application.applicationKey,
        connectionId: remoteTool.connection.id,
        toolName: remoteTool.catalogEntry.toolName,
      });
      await allowToolsForAgent(db, company.id, agent.id, [remoteToolName]);
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "Review driftable connected writes",
        policyType: "require_approval",
        selectors: { connectionId: remoteTool.connection.id },
        priority: 10,
      });

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      await gateway.executeTool({
        sessionToken: session.token,
        tool: remoteToolName,
        parameters: { key: "approved", value: "original" },
      }).then(
        () => {
          throw new Error("Expected connected MCP call to require approval");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );

      const [actionRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));
      await db
        .update(issueThreadInteractions)
        .set({
          status: "accepted",
          resolvedByAgentId: agent.id,
          resolvedAt: new Date(),
        })
        .where(eq(issueThreadInteractions.id, actionRequest.interactionId!));

      await db
        .update(toolConnections)
        .set({
          config: { url: "https://changed.example.invalid/mcp" },
          updatedAt: new Date(),
        })
        .where(eq(toolConnections.id, remoteTool.connection.id));

      await gateway.executeTool({
        sessionToken: session.token,
        tool: remoteToolName,
        parameters: { key: "approved", value: "tampered" },
        approvedActionRequestId: actionRequest.id,
      }).then(
        () => {
          throw new Error("Expected approved connected MCP retry to fail after target drift");
        },
        (error) => expectGatewayError(error, 409, "approved_tool_target_changed"),
      );

      expect(fake.requests).toHaveLength(0);
      const [afterReplayAttempt] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, actionRequest.id));
      expect(afterReplayAttempt).toMatchObject({
        issueId: issue.id,
        status: "approved",
      });
    } finally {
      await fake.close();
    }
  });

  it("expires an abandoned unsigned ask-first request so a later retry can proceed", async () => {
    // The gateway builds an ask-first request in two steps inside one call: it
    // inserts the row with a null signature and a null expiry, then signs the
    // row. If the gateway stops between the two steps, the row stays pending
    // and unsigned forever, and the review queue hides it. A later retry of the
    // same tool call must not replay that dead row. It must expire the row and
    // create a fresh, signable request.
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: { content: [{ type: "text", text: "should not run while pending approval" }] },
      },
    }));

    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "abandoned-unsigned-app",
        toolName: "kv_set",
        url: fake.url,
      });
      const remoteToolName = expectedConnectedToolName({
        applicationKey: remoteTool.application.applicationKey,
        connectionId: remoteTool.connection.id,
        toolName: remoteTool.catalogEntry.toolName,
      });
      await allowToolsForAgent(db, company.id, agent.id, [remoteToolName]);
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "Review abandoned connected writes",
        policyType: "require_approval",
        selectors: { connectionId: remoteTool.connection.id },
        priority: 10,
      });

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      await gateway.executeTool({
        sessionToken: session.token,
        tool: remoteToolName,
        parameters: { key: "abandoned", value: "original" },
      }).then(
        () => {
          throw new Error("Expected connected MCP call to require approval");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );

      const [firstRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));

      // Rewind the row to the abandoned state: created long ago, pending, never
      // signed. The old createdAt proves the create stopped, not that a parallel
      // create still runs, so a later retry can expire the row.
      await db
        .update(toolActionRequests)
        .set({
          signedArguments: null,
          expiresAt: null,
          interactionId: null,
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          updatedAt: new Date(),
        })
        .where(eq(toolActionRequests.id, firstRequest.id));

      // Retry the same tool call. The gateway must not replay the dead row.
      await gateway.executeTool({
        sessionToken: session.token,
        tool: remoteToolName,
        parameters: { key: "abandoned", value: "original" },
      }).then(
        () => {
          throw new Error("Expected retry to require a fresh approval");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );

      // The abandoned row is expired, not replayed as a live approval.
      const [afterRetry] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, firstRequest.id));
      expect(afterRetry.status).toBe("expired");

      // The retry created a fresh, signed request that the queue can show.
      const allRequests = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));
      const freshRequest = allRequests.find((request) => request.id !== firstRequest.id);
      expect(freshRequest).toBeTruthy();
      expect(freshRequest!.status).toBe("pending");
      expect(freshRequest!.signedArguments).not.toBeNull();
      expect(freshRequest!.expiresAt).not.toBeNull();

      // The tool never executed while the approval stayed pending.
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("does not expire a recent unsigned ask-first request that a parallel create still owns", async () => {
    // The create signs the row in two steps. A concurrent matching call can see
    // the row after the insert but before the sign. A recent createdAt means a
    // parallel create still runs, so the concurrent call must replay the live
    // request. It must not expire the row and must not create a duplicate.
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: {
        jsonrpc: "2.0",
        id: fakeRequest.body?.id,
        result: { content: [{ type: "text", text: "should not run while pending approval" }] },
      },
    }));

    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "inflight-unsigned-app",
        toolName: "kv_set",
        url: fake.url,
      });
      const remoteToolName = expectedConnectedToolName({
        applicationKey: remoteTool.application.applicationKey,
        connectionId: remoteTool.connection.id,
        toolName: remoteTool.catalogEntry.toolName,
      });
      await allowToolsForAgent(db, company.id, agent.id, [remoteToolName]);
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "Review inflight connected writes",
        policyType: "require_approval",
        selectors: { connectionId: remoteTool.connection.id },
        priority: 10,
      });

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      await gateway.executeTool({
        sessionToken: session.token,
        tool: remoteToolName,
        parameters: { key: "inflight", value: "original" },
      }).then(
        () => {
          throw new Error("Expected connected MCP call to require approval");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );

      const [firstRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));

      // Rewind to the in-flight window: unsigned, but created just now. This is
      // the state a concurrent matching call sees while the create still runs.
      await db
        .update(toolActionRequests)
        .set({ signedArguments: null, expiresAt: null, interactionId: null, updatedAt: new Date() })
        .where(eq(toolActionRequests.id, firstRequest.id));

      // The concurrent matching call replays the live request; it does not expire.
      await gateway.executeTool({
        sessionToken: session.token,
        tool: remoteToolName,
        parameters: { key: "inflight", value: "original" },
      }).then(
        () => {
          throw new Error("Expected the concurrent call to require approval");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );

      // The row stays pending and is not expired.
      const [afterRetry] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, firstRequest.id));
      expect(afterRetry.status).toBe("pending");

      // No duplicate request was created for the same tool call.
      const allRequests = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));
      expect(allRequests).toHaveLength(1);

      // The tool never executed while the approval stayed pending.
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("requires re-review when an approved connected MCP replay credential latest version changed", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const originalCredential = `approved-replay-token-${randomUUID()}`;
    const rotatedCredential = `rotated-replay-token-${randomUUID()}`;
    const secret = await secretService(db).create(company.id, {
      name: `Approved replay MCP token ${randomUUID()}`,
      key: `approved_replay_mcp_token_${randomUUID().replace(/-/g, "")}`,
      provider: "local_encrypted",
      value: originalCredential,
    });
    const fake = await startFakeRemoteMcpServer((fakeRequest) => {
      expect(fakeRequest.headers.authorization).toBe(`Bearer ${originalCredential}`);
      return {
        body: {
          jsonrpc: "2.0",
          id: fakeRequest.body?.id,
          result: {
            content: [{ type: "text", text: "should not run after credential drift" }],
          },
        },
      };
    });

    try {
      const remoteTool = await createRemoteMcpTool(db, company.id, {
        applicationKey: "approval-credential-drift-app",
        toolName: "kv_set",
        url: fake.url,
        credentialRefs: [{
          name: "authorization",
          secretId: secret.id,
          version: "latest",
          placement: "header",
          key: "Authorization",
          prefix: "Bearer ",
        }],
        credentialSecretRefs: [{
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "credentials.authorization",
          required: true,
          label: "Remote MCP token",
        }],
      });
      const remoteToolName = expectedConnectedToolName({
        applicationKey: remoteTool.application.applicationKey,
        connectionId: remoteTool.connection.id,
        toolName: remoteTool.catalogEntry.toolName,
      });
      await allowToolsForAgent(db, company.id, agent.id, [remoteToolName]);
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "Review credential driftable connected writes",
        policyType: "require_approval",
        selectors: { connectionId: remoteTool.connection.id },
        priority: 10,
      });

      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      await gateway.executeTool({
        sessionToken: session.token,
        tool: remoteToolName,
        parameters: { key: "approved", value: "original" },
      }).then(
        () => {
          throw new Error("Expected connected MCP call to require approval");
        },
        (error) => expectGatewayError(error, 409, "approval_required"),
      );

      const [actionRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));
      await db
        .update(issueThreadInteractions)
        .set({
          status: "accepted",
          resolvedByAgentId: agent.id,
          resolvedAt: new Date(),
        })
        .where(eq(issueThreadInteractions.id, actionRequest.interactionId!));

      await secretService(db).rotate(secret.id, { value: rotatedCredential });

      await gateway.executeTool({
        sessionToken: session.token,
        tool: remoteToolName,
        parameters: { key: "approved", value: "tampered" },
        approvedActionRequestId: actionRequest.id,
      }).then(
        () => {
          throw new Error("Expected approved connected MCP retry to fail after credential drift");
        },
        (error) => expectGatewayError(error, 409, "approved_tool_target_changed"),
      );

      expect(fake.requests).toHaveLength(0);
      const [afterReplayAttempt] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, actionRequest.id));
      expect(afterReplayAttempt).toMatchObject({
        issueId: issue.id,
        status: "approved",
      });
      const persisted = JSON.stringify({
        actionRequests: await db.select().from(toolActionRequests),
        callEvents: await db.select().from(toolCallEvents),
      });
      expect(persisted).not.toContain(originalCredential);
      expect(persisted).not.toContain(rotatedCredential);
    } finally {
      await fake.close();
    }
  });

  const remoteFailureCases = [
    {
      name: "HTTP status",
      reasonCode: "mcp_remote_status",
      status: 502,
      response: () => ({ status: 503, body: { error: "unavailable" } }),
    },
    {
      name: "invalid JSON",
      reasonCode: "mcp_remote_invalid_json",
      status: 502,
      response: () => ({ rawBody: "not json" }),
    },
    {
      name: "malformed MCP response",
      reasonCode: "remote_mcp_malformed_response",
      status: 502,
      response: () => ({ body: { jsonrpc: "2.0", id: "bad", result: { content: { type: "text", text: "bad" } } } }),
    },
    {
      name: "response size",
      reasonCode: "mcp_remote_response_too_large",
      status: 502,
      response: () => {
        const rawBody = "x".repeat(1_000_001);
        return { rawBody, headers: { "content-length": String(Buffer.byteLength(rawBody)) } };
      },
    },
    {
      name: "timeout abort",
      reasonCode: "tool_timeout",
      status: 504,
      timeoutMs: 10,
      response: () => ({ delayMs: 75, body: { jsonrpc: "2.0", id: "slow", result: { content: [{ type: "text", text: "late" }] } } }),
    },
  ];

  for (const scenario of remoteFailureCases) {
    it(`returns a controlled gateway error for remote MCP ${scenario.name}`, async () => {
      const company = await createCompany(db);
      const agent = await createAgent(db, company.id);
      const { run } = await createIssueAndRun(db, company.id, agent.id);
      const fake = await startFakeRemoteMcpServer(() => scenario.response());
      try {
        await createRemoteMcpTool(db, company.id, {
          applicationKey: `failure-${scenario.reasonCode}`,
          toolName: "kv_set",
          url: fake.url,
        });
        await allowAllToolsForAgent(db, company.id, agent.id);
        const gateway = createTestToolGatewayService(db);
        const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
        const connectedTool = (await gateway.listToolsForSession(session.token))
          .find((tool) => tool.providerType === "mcp_remote_http");
        expect(connectedTool).toBeTruthy();

        await gateway.executeTool({
          sessionToken: session.token,
          tool: connectedTool!.name,
          parameters: { key: "alpha", value: "one" },
          timeoutMs: scenario.timeoutMs,
        }).then(
          () => {
            throw new Error("Expected remote MCP call to fail");
          },
          (error) => expectGatewayError(error, scenario.status, scenario.reasonCode),
        );

        const [invocation] = await db.select().from(toolInvocations);
        expect(invocation).toMatchObject({
          status: scenario.status === 504 ? "timed_out" : "failed",
          errorCode: scenario.reasonCode,
        });
        const [failureAudit] = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.action, scenario.status === 504 ? "tool_gateway.call_deferred" : "tool_gateway.call_failed"));
        expect(failureAudit.details).toMatchObject({
          argumentsSummary: {
            summary: expect.stringContaining('"key":"alpha"'),
          },
          execution: {
            transport: "mcp_remote",
            request: {
              endpoint: fake.url,
              mcpMethod: "tools/call",
              dispatched: true,
            },
          },
        });
        if (scenario.reasonCode === "mcp_remote_status") {
          expect(failureAudit.details).toMatchObject({
            execution: { response: { httpStatus: 503 } },
          });
        }
      } finally {
        await fake.close();
      }
    });
  }

  it("persists hashed sessions and accepts them across gateway service instances", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-remote-fixture:add"]);

    const gatewayA = createTestToolGatewayService(db);
    const session = await gatewayA.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const [storedSession] = await db
      .select()
      .from(toolGatewaySessions)
      .where(eq(toolGatewaySessions.id, session.id));
    expect(storedSession).toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      issueId: issue.id,
      tokenHash: createHash("sha256").update(session.token).digest("hex"),
    });
    expect(JSON.stringify(storedSession)).not.toContain(session.token);

    const gatewayB = createTestToolGatewayService(db);
    await expect(gatewayB.listToolsForSession(session.token)).resolves.toEqual([
      expect.objectContaining({ name: "mcp-remote-fixture:add" }),
    ]);
    await expect(gatewayB.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:add",
      parameters: { a: 2, b: 5 },
    })).resolves.toMatchObject({
      status: "completed",
      result: { content: "7" },
    });

    const [usedSession] = await db
      .select()
      .from(toolGatewaySessions)
      .where(eq(toolGatewaySessions.id, session.id));
    expect(usedSession.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects gateway session tokens passed through query strings", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const app = createGatewayRouteApp(db, gateway);

    const listWithQueryToken = await request(app)
      .get("/api/tool-gateway/tools")
      .query({ sessionToken: session.token });
    expect(listWithQueryToken.status).toBe(401);
    expect(listWithQueryToken.body).toEqual({ error: "Tool gateway session token is required" });

    const callWithQueryToken = await request(app)
      .post("/api/tool-gateway/tools/call")
      .query({ sessionToken: session.token })
      .send({ tool: "mcp-remote-fixture:add", parameters: { a: 1, b: 2 } });
    expect(callWithQueryToken.status).toBe(401);
    expect(callWithQueryToken.body).toEqual({ error: "Tool gateway session token is required" });

    const listWithHeaderToken = await request(app)
      .get("/api/tool-gateway/tools")
      .set("x-paperclip-tool-gateway-token", session.token);
    expect(listWithHeaderToken.status).toBe(200);
  });

  it("revokes a gateway session through the authenticated route and audits without token values", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const app = createGatewayRouteApp(db, gateway, {
      type: "board",
      userId: "board-user",
      source: "session",
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    });

    const beforeRevoke = await request(app)
      .get("/api/tool-gateway/tools")
      .set("x-paperclip-tool-gateway-token", session.token);
    expect(beforeRevoke.status).toBe(200);

    const revoked = await request(app)
      .post(`/api/tool-gateway/sessions/${session.id}/revoke`)
      .send({ companyId: company.id });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({
      sessionId: session.id,
      revokedAt: expect.any(String),
    });
    expect(JSON.stringify(revoked.body)).not.toContain(session.token);

    const afterRevoke = await request(app)
      .get("/api/tool-gateway/tools")
      .set("x-paperclip-tool-gateway-token", session.token);
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.reasonCode).toBe("session_revoked");

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.session_revoked"));
    expect(activity).toMatchObject({
      companyId: company.id,
      actorType: "user",
      actorId: "board-user",
      agentId: agent.id,
      runId: run.id,
    });
    expect(activity.details).toMatchObject({
      gatewaySessionId: session.id,
      reasonCode: "session_revoked",
      previousRevokedAt: null,
    });

    const [accessAudit] = await db
      .select()
      .from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.action, "session_revoked"));
    expect(accessAudit).toMatchObject({
      companyId: company.id,
      actorType: "user",
      actorId: "board-user",
      action: "session_revoked",
      outcome: "success",
      reasonCode: "session_revoked",
    });
    const serializedAudits = JSON.stringify({ activity, accessAudit });
    expect(serializedAudits).not.toContain(session.token);
  });

  it("denies wrong-company gateway session revocation without revoking the session", async () => {
    const company = await createCompany(db);
    const otherCompany = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const app = createGatewayRouteApp(db, gateway, {
      type: "board",
      userId: "other-board-user",
      source: "session",
      companyIds: [otherCompany.id],
      memberships: [{ companyId: otherCompany.id, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    });

    const revoked = await request(app)
      .post(`/api/tool-gateway/sessions/${session.id}/revoke`)
      .send({ companyId: otherCompany.id });
    expect(revoked.status).toBe(404);
    expect(revoked.body.reasonCode).toBe("session_not_found");

    const stillActive = await request(app)
      .get("/api/tool-gateway/tools")
      .set("x-paperclip-tool-gateway-token", session.token);
    expect(stillActive.status).toBe(200);

    const revokedRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.session_revoked"));
    expect(revokedRows).toHaveLength(0);
  });

  it("scopes agent gateway session revocation to the authenticated run", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const { run: otherRun } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const otherRunSession = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: otherRun.id,
    });
    const app = createGatewayRouteApp(db, gateway, {
      type: "agent",
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      source: "agent_jwt",
    });

    const wrongRun = await request(app)
      .post(`/api/tool-gateway/sessions/${otherRunSession.id}/revoke`)
      .send();
    expect(wrongRun.status).toBe(403);
    expect(wrongRun.body.reasonCode).toBe("session_scope_mismatch");

    const otherRunStillActive = await request(app)
      .get("/api/tool-gateway/tools")
      .set("x-paperclip-tool-gateway-token", otherRunSession.token);
    expect(otherRunStillActive.status).toBe(200);

    const ownRun = await request(app)
      .post(`/api/tool-gateway/sessions/${session.id}/revoke`)
      .send();
    expect(ownRun.status).toBe(200);

    const ownRunDenied = await request(app)
      .get("/api/tool-gateway/tools")
      .set("x-paperclip-tool-gateway-token", session.token);
    expect(ownRunDenied.status).toBe(401);
    expect(ownRunDenied.body.reasonCode).toBe("session_revoked");
  });

  it("keeps action request approval routes viewer-safe", async () => {
    const company = await createCompany(db);
    const gateway = createTestToolGatewayService(db);
    const app = createGatewayRouteApp(db, gateway, {
      type: "board",
      userId: "viewer-user",
      source: "session",
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "viewer", status: "active" }],
      isInstanceAdmin: false,
    });

    const approve = await request(app)
      .post(`/api/tool-gateway/action-requests/${randomUUID()}/approve`)
      .send({ companyId: company.id });
    const decline = await request(app)
      .post(`/api/tool-gateway/action-requests/${randomUUID()}/decline`)
      .send({ companyId: company.id });

    for (const res of [approve, decline]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Viewer access is read-only");
    }
  });

  it("denies agent actors from runtime control and raw gateway audit routes", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const app = createGatewayRouteApp(db, gateway, {
      type: "agent",
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      source: "agent_jwt",
    });

    const list = await request(app)
      .get("/api/tool-gateway/runtime-slots")
      .query({ companyId: company.id });
    expect(list.status).toBe(403);
    expect(list.body.error).toBe("Board access required");

    const stop = await request(app)
      .post("/api/tool-gateway/runtime-slots/slot-1/stop")
      .send({ companyId: company.id });
    expect(stop.status).toBe(403);
    expect(stop.body.error).toBe("Board access required");

    const restart = await request(app)
      .post("/api/tool-gateway/runtime-slots/slot-1/restart")
      .send({ companyId: company.id });
    expect(restart.status).toBe(403);
    expect(restart.body.error).toBe("Board access required");

    const audit = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id });
    expect(audit.status).toBe(403);
    expect(audit.body.error).toBe("Board access required");
  });

  it("allows board runtime control and audit reads through explicit board permissions", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const userId = `board-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values([
      {
        companyId: company.id,
        principalType: "user",
        principalId: userId,
        permissionKey: "tools:manage_runtime",
        scope: null,
        grantedByUserId: "owner",
      },
      {
        companyId: company.id,
        principalType: "user",
        principalId: userId,
        permissionKey: "tools:view_audit",
        scope: null,
        grantedByUserId: "owner",
      },
    ]);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const gateway = createTestToolGatewayService(db, {
      runtimeSupervisor: { restartBackoffMs: 0, idleTtlMs: 10_000 },
    });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const slotId = (first.result as { data: { slotId: string } }).data.slotId;

    const app = createGatewayRouteApp(db, gateway, {
      type: "board",
      userId,
      source: "session",
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    });

    const list = await request(app)
      .get("/api/tool-gateway/runtime-slots")
      .query({ companyId: company.id });
    expect(list.status).toBe(200);
    expect(list.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: slotId, status: "idle" }),
    ]));

    const stop = await request(app)
      .post(`/api/tool-gateway/runtime-slots/${slotId}/stop`)
      .send({ companyId: company.id });
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ id: slotId, status: "stopped" });

    const restart = await request(app)
      .post(`/api/tool-gateway/runtime-slots/${slotId}/restart`)
      .send({ companyId: company.id });
    expect(restart.status).toBe(200);
    expect(restart.body).toMatchObject({ id: slotId, status: "running" });

    const audit = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id, limit: 20 });
    expect(audit.status).toBe(200);
    expect(audit.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId: company.id,
        action: expect.stringMatching(/^tool_gateway\./),
      }),
    ]));
    expect(audit.body).toHaveProperty("nextCursor");
  });

  it("aggregates connection activity with server-side filters, pagination, and enrichment", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const otherAgent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: "Plugin: acme.plugin-mail",
      type: "mcp_stdio",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application!.id,
      name: "Plugin: acme.plugin-mail",
      uid: `test/${randomUUID()}`,
      transport: "local_stdio",
      status: "active",
      enabled: true,
    }).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `audit-${randomUUID()}`,
      name: `Audit ${randomUUID()}`,
    }).returning();
    const [gateway, otherGateway] = await db.insert(toolMcpGateways).values([
      {
        companyId: company.id,
        name: `Audit gateway ${randomUUID()}`,
        slug: `audit-${randomUUID()}`,
        profileId: profile!.id,
      },
      {
        companyId: company.id,
        name: `Other gateway ${randomUUID()}`,
        slug: `other-${randomUUID()}`,
        profileId: profile!.id,
      },
    ]).returning();
    const [newerInvocation, olderInvocation, otherInvocation] = await db.insert(toolInvocations).values([
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        gatewayId: gateway!.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        toolName: "mail:send_email",
        argumentsSummary: { summary: JSON.stringify({ to: "person@example.test", token: "***REDACTED***" }) },
        resultSummary: { summary: JSON.stringify({ delivered: true }) },
        policyDecision: "allow",
        status: "succeeded",
        startedAt: new Date(Date.now() - 1_500),
        completedAt: new Date(Date.now() - 1_000),
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        gatewayId: gateway!.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        toolName: "mail:read_email",
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: otherAgent.id,
        agentId: otherAgent.id,
        runId: run.id,
        gatewayId: otherGateway!.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        toolName: "other:delete_everything",
      },
    ]).returning();
    const now = Date.now();
    const callEvents = await db.insert(toolCallEvents).values([
      {
        companyId: company.id,
        eventType: "call_completed",
        actorType: "agent",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        gatewayId: gateway!.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        invocationId: newerInvocation!.id,
        toolName: "mail:send_email",
        decision: "allow",
        reasonCode: "tool_completed",
        outcome: "success",
        metadata: { upstreamToolName: "fixture.todo.list" },
        createdAt: new Date(now - 1_000),
      },
      {
        companyId: company.id,
        eventType: "call_completed",
        actorType: "agent",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        gatewayId: gateway!.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        invocationId: olderInvocation!.id,
        toolName: "mail:read_email",
        decision: "allow",
        reasonCode: "profile_allows_tool",
        outcome: "success",
        createdAt: new Date(now - 2_000),
      },
      {
        companyId: company.id,
        eventType: "call_denied",
        actorType: "agent",
        actorId: otherAgent.id,
        agentId: otherAgent.id,
        runId: run.id,
        gatewayId: otherGateway!.id,
        applicationId: application!.id,
        connectionId: connection!.id,
        invocationId: otherInvocation!.id,
        toolName: "other:delete_everything",
        decision: "deny",
        reasonCode: "deny_policy_block",
        outcome: "denied",
        createdAt: new Date(now - 500),
      },
    ]).returning();
    const [connectedEvent] = await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "tool_app.connected",
      entityType: "tool_connection",
      entityId: connection!.id,
      details: { galleryKey: "mail" },
      createdAt: new Date(now - 45 * 24 * 60 * 60 * 1000),
    }).returning();

    const app = createGatewayRouteApp(db, createTestToolGatewayService(db), {
      type: "board",
      userId: "instance-admin",
      source: "session",
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    });

    const allActivity = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id });
    expect(allActivity.status).toBe(200);
    expect(allActivity.body.events.map((event: { id: string }) => event.id)).toEqual([
      callEvents[2]!.id,
      callEvents[0]!.id,
      callEvents[1]!.id,
      connectedEvent!.id,
    ]);
    expect(allActivity.body.events.find((event: { id: string }) => event.id === connectedEvent!.id)).toMatchObject({
      action: "tool_connection.app_connected",
      connectionId: connection!.id,
      applicationId: application!.id,
      appDisplayName: "Mail",
      lifecycleType: "app_connected",
    });

    const firstPage = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id, gateway: gateway!.id, app: connection!.id, agent: agent.id, outcome: "allowed", window: "24h", limit: 1 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.events).toEqual([
      expect.objectContaining({
        action: "tool_gateway.call_completed",
        agentId: agent.id,
        agentDisplayName: agent.name,
        applicationId: application!.id,
        connectionId: connection!.id,
        appDisplayName: "Mail",
        toolDisplayName: "Send Email",
        normalizedOutcome: "allowed",
        invocation: expect.objectContaining({
          id: newerInvocation!.id,
          toolName: "mail:send_email",
          status: "succeeded",
          policyDecision: "allow",
          argumentsSummary: expect.objectContaining({ summary: expect.stringContaining("***REDACTED***") }),
          resultSummary: expect.objectContaining({ summary: expect.stringContaining("delivered") }),
        }),
      }),
    ]);
    expect(typeof firstPage.body.nextCursor).toBe("string");

    const secondPage = await request(app)
      .get("/api/tool-gateway/audit")
      .query({
        companyId: company.id,
        gateway: gateway!.id,
        app: connection!.id,
        agent: agent.id,
        outcome: "allowed",
        window: "24h",
        limit: 1,
        cursor: firstPage.body.nextCursor,
      });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.events).toEqual([
      expect.objectContaining({
        action: "tool_gateway.call_completed",
        toolDisplayName: "Read Email",
      }),
    ]);
    expect(secondPage.body.nextCursor).toBeNull();

    // Free-text search resolves against the raw tool name server-side.
    const byToolName = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id, window: "24h", search: "delete_everything" });
    expect(byToolName.status).toBe(200);
    expect(byToolName.body.events).toEqual([
      expect.objectContaining({ action: "tool_gateway.call_denied", toolDisplayName: "Delete Everything" }),
    ]);

    const byUpstreamToolName = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id, window: "24h", search: "fixture.todo.list" });
    expect(byUpstreamToolName.status).toBe(200);
    expect(byUpstreamToolName.body.events).toEqual([
      expect.objectContaining({ action: "tool_gateway.call_completed", toolDisplayName: "Send Email" }),
    ]);

    // ...and against the humanized agent name (resolved to the agent's events).
    const byAgentName = await request(app)
      .get("/api/tool-gateway/audit")
      .query({ companyId: company.id, window: "24h", search: otherAgent.name });
    expect(byAgentName.status).toBe(200);
    expect(byAgentName.body.events).toEqual([
      expect.objectContaining({ agentId: otherAgent.id }),
    ]);
  });

  it("rejects durable sessions after the heartbeat run is no longer active", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", completedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));

    await expect(gateway.listToolsForSession(session.token)).rejects.toMatchObject({
      status: 401,
      reasonCode: "session_run_inactive",
    });
    await expect(gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    })).rejects.toMatchObject({
      status: 403,
      reasonCode: "run_inactive",
    });

    const [audit] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.session_rejected"));
    expect(audit).toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    expect(audit.details).toMatchObject({
      decision: "deny",
      reasonCode: "session_run_inactive",
      runStatus: "succeeded",
    });
    expect(JSON.stringify(audit)).not.toContain(session.token);
  });

  it("binds runtime gateway tokens to active runs and preserves run attribution", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { project, issue, run } = await createIssueAndRun(db, company.id, agent.id);
    await db.update(heartbeatRuns).set({ responsibleUserId: "runtime-owner" }).where(eq(heartbeatRuns.id, run.id));
    const profile = await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:runtime_status"]);
    const gateway = createTestToolGatewayService(db);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Runtime gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Runtime token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        clientLabel: "Heartbeat runtime",
        ownerNote: "Run-bound regression token",
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(Date.now() + 60_000),
      },
      actor: { agentId: agent.id },
    });
    const app = createGatewayRouteApp(db, gateway);
    await expect(gateway.initializeNamedGatewayProtocol({
      gatewayId: namedGateway.id,
      bearerToken: token.token,
    })).resolves.toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      issueId: issue.id,
      projectId: project.id,
      responsibleUserId: "runtime-owner",
    });

    await request(app)
      .post(`/api/tool-gateway/gateways/${namedGateway.id}/mcp`)
      .set("authorization", `Bearer ${token.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(200);
    await request(app)
      .post(`/api/tool-gateway/gateways/${namedGateway.id}/mcp`)
      .set("authorization", `Bearer ${token.token}`)
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "mcp-stdio-fixture:runtime_status", arguments: {} },
      })
      .expect(200);

    const [invocation] = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.runId, run.id))
      .limit(1);
    expect(invocation).toMatchObject({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      issueId: issue.id,
    });
    const attributedActivity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.runId, run.id), eq(activityLog.action, "tool_gateway.discovery")));
    expect(attributedActivity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
        entityId: issue.id,
        details: expect.objectContaining({ issueId: issue.id, runId: run.id }),
      }),
    ]));
    const attributedToolEvents = await db
      .select()
      .from(toolCallEvents)
      .where(eq(toolCallEvents.runId, run.id));
    expect(attributedToolEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
        issueId: issue.id,
        metadata: expect.objectContaining({ projectId: project.id }),
      }),
    ]));

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", completedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));

    const replay = await request(app)
      .post(`/api/tool-gateway/gateways/${namedGateway.id}/mcp`)
      .set("authorization", `Bearer ${token.token}`)
      .send({ jsonrpc: "2.0", id: 3, method: "tools/list" })
      .expect(401);
    expect(replay.body.error.data.reasonCode).toBe("gateway_token_run_inactive");
  });

  it("rejects expired, revoked, and tampered durable sessions without auditing token values", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);

    const expired = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    await db
      .update(toolGatewaySessions)
      .set({ expiresAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(eq(toolGatewaySessions.id, expired.id));
    await expect(gateway.listToolsForSession(expired.token)).rejects.toMatchObject({
      status: 401,
      reasonCode: "session_expired",
    });

    const revoked = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    await gateway.revokeSession({ companyId: company.id, sessionId: revoked.id });
    await expect(gateway.listToolsForSession(revoked.token)).rejects.toMatchObject({
      status: 401,
      reasonCode: "session_revoked",
    });

    const tampered = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const badToken = tamperToken(tampered.token);
    await expect(gateway.listToolsForSession(badToken)).rejects.toMatchObject({
      status: 401,
      reasonCode: "session_invalid",
    });

    const audits = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "tool_gateway.session_rejected"));
    expect(audits).toHaveLength(3);
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).toContain("session_expired");
    expect(serializedAudits).toContain("session_revoked");
    expect(serializedAudits).toContain("session_invalid");
    expect(serializedAudits).not.toContain(expired.token);
    expect(serializedAudits).not.toContain(revoked.token);
    expect(serializedAudits).not.toContain(tampered.token);
    expect(serializedAudits).not.toContain(badToken);

    const dedicatedAudits = await db
      .select()
      .from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.action, "call_denied"));
    expect(dedicatedAudits).toHaveLength(3);
    expect(dedicatedAudits.every((event) => event.outcome === "denied")).toBe(true);
  });

  it("cleans up expired durable sessions explicitly", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db);
    const oldSession = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    await db
      .update(toolGatewaySessions)
      .set({ expiresAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(eq(toolGatewaySessions.id, oldSession.id));

    await expect(gateway.cleanupExpiredSessions()).resolves.toEqual({ deletedCount: 1 });

    const remaining = await db.select().from(toolGatewaySessions);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).not.toBe(oldSession.id);
  });

  it("lazy-starts, reuses, and idles down the local stdio fixture slot", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, [
      "mcp-stdio-fixture:increment_counter",
      "mcp-stdio-fixture:runtime_status",
    ]);
    // Drive idle-down off an injected clock so the assertions below do not
    // depend on real wall-clock elapsing under 25ms (the source of the flake).
    // The supervisor computes idleDeadlineAt = now() + idleTtlMs and reaps lazily
    // on every listRuntimeSlots call, so a fixed clock keeps the slot alive until
    // we deliberately advance past the TTL.
    let clockMs = Date.now();
    const gateway = createTestToolGatewayService(db, {
      runtimeSupervisor: { idleTtlMs: 25, now: () => new Date(clockMs) },
    });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const second = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:runtime_status",
      parameters: {},
    });

    const firstData = (first.result as { data: Record<string, unknown> }).data;
    const secondData = (second.result as { data: Record<string, unknown> }).data;
    expect(firstData).toMatchObject({ lazyStarted: true, reusedRuntimeSlot: false, counter: 1 });
    expect(secondData).toMatchObject({ lazyStarted: false, reusedRuntimeSlot: true, counter: 1 });
    expect(secondData.slotId).toBe(firstData.slotId);
    // Clock has not advanced past the deadline, so the slot is deterministically present.
    await expect(gateway.listRuntimeSlots(company.id)).resolves.toHaveLength(1);
    const [idleSlot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.companyId, company.id));
    expect(idleSlot).toMatchObject({
      status: "idle",
      commandTemplateKey: "paperclip.slow-stateful-stdio",
      healthStatus: "ok",
    });
    expect(idleSlot.metadata).toMatchObject({
      counter: 1,
      useCount: 2,
      process: expect.objectContaining({ simulated: true }),
      resourceLimits: expect.objectContaining({ memoryCeilingSupported: expect.any(Boolean) }),
    });

    // Advance the injected clock past the idle TTL to deterministically reap the slot.
    clockMs += 35;
    await expect(gateway.listRuntimeSlots(company.id)).resolves.toEqual([]);
    const [stoppedSlot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.id, idleSlot.id));
    expect(stoppedSlot).toMatchObject({
      status: "stopped",
      healthMessage: "Stopped after idle TTL.",
    });
  });

  it("supports explicit stop and restart actions for local stdio slots", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { restartBackoffMs: 0 } });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const slotId = (first.result as { data: { slotId: string } }).data.slotId;

    await expect(gateway.stopRuntimeSlot({ companyId: company.id, slotId, actor: { agentId: agent.id, runId: run.id } }))
      .resolves.toMatchObject({ id: slotId, status: "stopped" });
    await expect(gateway.listRuntimeSlots(company.id)).resolves.toEqual([]);

    await expect(gateway.restartRuntimeSlot({ companyId: company.id, slotId, actor: { agentId: agent.id, runId: run.id } }))
      .resolves.toMatchObject({ id: slotId, status: "running" });
  });

  it("returns structured runtime defer when local stdio host capacity is exhausted", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const otherCompany = await createCompany(db);
    const otherAgent = await createAgent(db, otherCompany.id);
    const { run: otherRun } = await createIssueAndRun(db, otherCompany.id, otherAgent.id);
    await allowToolsForAgent(db, otherCompany.id, otherAgent.id, ["mcp-stdio-fixture:increment_counter"]);
    const gateway = createTestToolGatewayService(db, {
      runtimeSupervisor: { idleTtlMs: 10_000, maxHostSlots: 1, hostId: "shared-host" },
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const otherSession = await gateway.createSession({ companyId: otherCompany.id, agentId: otherAgent.id, runId: otherRun.id });

    await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });

    await gateway.executeTool({
      sessionToken: otherSession.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    }).then(
      () => {
        throw new Error("Expected host capacity to defer the second stdio slot");
      },
      (error) => expectGatewayError(error, 429, "runtime_capacity_unavailable"),
    );

    const [invocation] = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.companyId, otherCompany.id));
    const [deferAudit] = await db
      .select()
      .from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.action, "runtime_deferred"));
    expect(invocation).toMatchObject({
      status: "rate_limited",
      errorCode: "runtime_capacity_unavailable",
    });
    expect(deferAudit).toMatchObject({
      outcome: "failure",
      reasonCode: "runtime_host_capacity_exhausted",
    });
  });

  it("fails closed for hosted public local stdio unless a trusted runtime host is configured", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const hostedGateway = createTestToolGatewayService(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      trustedLocalStdioRuntimeHost: null,
    });
    const session = await hostedGateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

    await hostedGateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    }).then(
      () => {
        throw new Error("Expected public hosted local stdio to fail closed");
      },
      (error) => expectGatewayError(error, 403, "local_stdio_unavailable_in_public_mode"),
    );

    const trustedGateway = createTestToolGatewayService(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      trustedLocalStdioRuntimeHost: "trusted-worker-1",
      runtimeSupervisor: { idleTtlMs: 10_000 },
    });
    const trustedSession = await trustedGateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    await expect(trustedGateway.executeTool({
      sessionToken: trustedSession.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    })).resolves.toMatchObject({ status: "completed" });
  });

  it("suppresses restart storms with backoff-visible slot health", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, ["mcp-stdio-fixture:increment_counter"]);
    const gateway = createTestToolGatewayService(db, {
      runtimeSupervisor: {
        restartBackoffMs: 0,
        restartStormLimit: 1,
        restartStormWindowMs: 10_000,
      },
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const slotId = (first.result as { data: { slotId: string } }).data.slotId;

    await gateway.restartRuntimeSlot({ companyId: company.id, slotId, actor: { agentId: agent.id, runId: run.id } });
    await gateway.restartRuntimeSlot({ companyId: company.id, slotId, actor: { agentId: agent.id, runId: run.id } }).then(
      () => {
        throw new Error("Expected restart storm suppression");
      },
      (error) => expectGatewayError(error, 429, "runtime_restart_suppressed"),
    );

    const [slot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.id, slotId));
    expect(slot).toMatchObject({
      status: "failed",
      healthStatus: "error",
      lastError: "restart_storm_suppressed",
    });
    expect(slot.metadata).toMatchObject({
      restartSuppressedUntil: expect.any(String),
    });
  });

  it("recovers stuck local stdio slots before reuse", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, [
      "mcp-stdio-fixture:increment_counter",
      "mcp-stdio-fixture:runtime_status",
    ]);
    const gateway = createTestToolGatewayService(db, { runtimeSupervisor: { stuckSlotMs: 1, idleTtlMs: 10_000 } });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const first = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:increment_counter",
      parameters: {},
    });
    const slotId = (first.result as { data: { slotId: string } }).data.slotId;
    const staleAt = new Date(Date.now() - 60_000);
    await db
      .update(toolRuntimeSlots)
      .set({
        status: "running",
        lastUsedAt: staleAt,
        startedAt: staleAt,
        idleDeadlineAt: null,
        idleExpiresAt: null,
        updatedAt: staleAt,
      })
      .where(eq(toolRuntimeSlots.id, slotId));

    const recovered = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-stdio-fixture:runtime_status",
      parameters: {},
    });

    expect((recovered.result as { data: { slotId: string; reusedRuntimeSlot: boolean } }).data).toMatchObject({
      slotId,
      reusedRuntimeSlot: true,
    });
    const [slot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.id, slotId));
    expect(slot).toMatchObject({
      status: "idle",
      healthStatus: "ok",
    });
    expect(slot.metadata).toMatchObject({
      stuckRecoveries: 1,
      lastRestartReason: "stuck_slot_recovered",
    });
  });

  it("defers write-risk tool calls into issue-thread approval requests", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    await allowToolsForAgent(db, company.id, agent.id, [
      "mcp-remote-fixture:echo",
      "mcp-remote-fixture:update_note",
    ]);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review note updates",
      policyType: "require_approval",
      selectors: { toolName: "mcp-remote-fixture:update_note" },
      description: "Note updates require review.",
    });
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });

    const listedTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.name === "mcp-remote-fixture:update_note");
    expect(listedTool?.description).toBe(
      "Remote HTTP MCP fixture that simulates a side-effecting write. Requires human approval: calling it posts an approval card on your task and you will be woken with the result once decided.",
    );
    expect((await gateway.listToolsForSession(session.token))
      .find((tool) => tool.name === "mcp-remote-fixture:echo")?.description).toBe(
      "Remote HTTP MCP fixture that echoes a message without spawning a local process.",
    );

    await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "review this write" },
    }).then(
      () => {
        throw new Error("Expected write-risk tool call to request approval");
      },
      (error) => expectGatewayError(error, 409, "approval_required"),
    );

    const [actionRequest] = await db.select().from(toolActionRequests);
    const [interaction] = await db.select().from(issueThreadInteractions);
    expect(actionRequest).toMatchObject({
      companyId: company.id,
      issueId: issue.id,
      status: "pending",
      requestedByAgentId: agent.id,
    });
    expect(interaction).toMatchObject({
      companyId: company.id,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
    });
  });

  it("wraps plugin tool discovery and execution behind the same gateway policy", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run, project } = await createIssueAndRun(db, company.id, agent.id);
    const calls: unknown[] = [];
    const dispatcher: PluginToolDispatcher = {
      initialize: async () => {},
      teardown: () => {},
      listToolsForAgent: () => [
        {
          name: "demo-plugin:read_status",
          displayName: "Read status",
          description: "Read status through a plugin tool.",
          parametersSchema: { type: "object" },
          pluginId: "demo-plugin",
        },
      ],
      getTool: () => null,
      executeTool: async (tool, parameters, runContext) => {
        calls.push({ tool, parameters, runContext });
        return {
          pluginId: "demo-plugin",
          toolName: "read_status",
          result: { content: "plugin ok", data: { ok: true } },
        };
      },
      registerPluginTools: () => {},
      unregisterPluginTools: () => {},
      toolCount: () => 1,
      getRegistry: () => {
        throw new Error("not used");
      },
    };
    const gateway = createTestToolGatewayService(db, { pluginToolDispatcher: dispatcher });

    await expect(gateway.listPluginToolsForAgent({ companyId: company.id, agentId: agent.id })).resolves.toEqual([]);
    await gateway.executePluginTool({
      actor: { type: "agent", companyId: company.id, agentId: agent.id, runId: run.id },
      tool: "demo-plugin:read_status",
      parameters: {},
      runContext: { companyId: company.id, agentId: agent.id, runId: run.id, projectId: project.id },
    }).then(
      () => {
        throw new Error("Expected plugin tool call without profile to fail");
      },
      (error) => expectGatewayError(error, 403, "deny_default"),
    );

    await allowToolsForAgent(db, company.id, agent.id, ["demo-plugin:read_status"]);

    await expect(gateway.listPluginToolsForAgent({ companyId: company.id, agentId: agent.id })).resolves.toEqual([
      expect.objectContaining({ name: "demo-plugin:read_status" }),
    ]);
    await expect(gateway.executePluginTool({
      actor: { type: "agent", companyId: company.id, agentId: agent.id, runId: run.id },
      tool: "demo-plugin:read_status",
      parameters: { id: "1" },
      runContext: { companyId: company.id, agentId: agent.id, runId: run.id, projectId: project.id },
    })).resolves.toMatchObject({
      pluginId: "demo-plugin",
      toolName: "read_status",
      result: { content: "plugin ok", data: { ok: true } },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        tool: "demo-plugin:read_status",
        parameters: { id: "1" },
      }),
    ]);
  });

  it("rejects caller-supplied issue context outside the run company", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const otherCompany = await createCompany(db);
    const otherAgent = await createAgent(db, otherCompany.id);
    const { issue: otherIssue } = await createIssueAndRun(db, otherCompany.id, otherAgent.id);
    const gateway = createTestToolGatewayService(db);

    await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      issueId: otherIssue.id,
    }).then(
      () => {
        throw new Error("Expected cross-company issue context to fail");
      },
      (error) => expectGatewayError(error, 403, "run_context_mismatch"),
    );
  });
  // ---- TECH-7276: personal rh-mcp default entry, agent read ceiling ---------------------------

  it("TECH-7276: an agent sees and runs only the five read tools of the personal rh-mcp template, as the responsible user", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const userId = `user-${randomUUID()}`;
    const run = await createRunForResponsibleUser(db, company.id, agent.id, userId);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: { jsonrpc: "2.0", id: fakeRequest.body?.id, result: { content: [{ type: "text", text: "ok" }] } },
    }));
    try {
      const seeded = await seedRhMcpPersonal(db, company.id, { url: fake.url, userId });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

      const listed = (await gateway.listToolsForSession(session.token)).filter((tool) => tool.providerType === "mcp_remote_http");
      expect(listed.map((tool) => tool.upstreamToolName).sort()).toEqual([...RH_MCP_READ_TOOLS].sort());

      // The runtime allowlist (Hermes preflight expects exact equality with the live list) is the same set.
      const expected = await gateway.getAssignedGatewayToolNames({
        companyId: company.id,
        assignedConnections: [{ id: seeded.connection.id }],
        assignedTools: [],
        fullConnectionIds: new Set([seeded.connection.id]),
        allowedActions: ["tools/list", "tools/call"],
      });
      expect(expected).toEqual(listed.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)));

      // A ceiling tool runs with the responsible user's own grant.
      const result = await gateway.executeTool({ sessionToken: session.token, tool: seeded.nameOf("mdm_get_granola_note"), parameters: {} });
      expect(result).toMatchObject({ status: "completed" });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${seeded.personalToken}`);
      const invocationsBefore = await db.select().from(toolInvocations);
      const secretReadsBefore = await db.select().from(secretAccessEvents);

      // A writer is a plain 404 before policy, approval, rate limit, credentials or upstream.
      for (const writer of RH_MCP_WRITE_TOOLS) {
        await gateway.executeTool({ sessionToken: session.token, tool: seeded.nameOf(writer), parameters: {} }).then(
          () => { throw new Error(`Expected ${writer} to be refused`); },
          (error) => expectGatewayError(error, 404, "tool_not_found"),
        );
      }
      expect(fake.requests).toHaveLength(1);
      expect(await db.select().from(toolInvocations)).toHaveLength(invocationsBefore.length);
      expect(await db.select().from(secretAccessEvents)).toHaveLength(secretReadsBefore.length);
    } finally {
      await fake.close();
    }
  });

  it("TECH-7276: on-demand search_tools and run_tool apply the same ceiling", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const userId = `user-${randomUUID()}`;
    const run = await createRunForResponsibleUser(db, company.id, agent.id, userId);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: { jsonrpc: "2.0", id: fakeRequest.body?.id, result: { content: [{ type: "text", text: "ok" }] } },
    }));
    try {
      const seeded = await seedRhMcpPersonal(db, company.id, { url: fake.url, userId, onDemand: true });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

      const search = await gateway.executeTool({ sessionToken: session.token, tool: "search_tools", parameters: { query: "mdm", limit: 50 } });
      const found = (search.result as { data: { tools: Array<{ upstreamToolName: string }> } }).data.tools.map((tool) => tool.upstreamToolName);
      expect(found.sort()).toEqual([...RH_MCP_READ_TOOLS].sort());

      await gateway.executeTool({
        sessionToken: session.token,
        tool: "run_tool",
        parameters: { tool: seeded.nameOf("mdm_erase_granola_note"), arguments: {} },
      }).then(
        () => { throw new Error("Expected the writer to be refused"); },
        (error) => expectGatewayError(error, 404, "tool_not_found"),
      );
      expect(fake.requests).toHaveLength(0);

      const allowed = await gateway.executeTool({
        sessionToken: session.token,
        tool: "run_tool",
        parameters: { tool: seeded.nameOf("mdm_granola_status"), arguments: {} },
      });
      expect(allowed).toMatchObject({ status: "completed" });
      expect(fake.requests).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("TECH-7276: a same-named but untagged connection is an ordinary one and is never capped", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const userId = `user-${randomUUID()}`;
    const run = await createRunForResponsibleUser(db, company.id, agent.id, userId);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: { jsonrpc: "2.0", id: fakeRequest.body?.id, result: { content: [{ type: "text", text: "ok" }] } },
    }));
    try {
      const seeded = await seedRhMcpPersonal(db, company.id, { url: fake.url, userId, tagged: false });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

      const listed = (await gateway.listToolsForSession(session.token)).filter((tool) => tool.providerType === "mcp_remote_http");
      expect(listed.map((tool) => tool.upstreamToolName).sort()).toEqual([...RH_MCP_READ_TOOLS, ...RH_MCP_WRITE_TOOLS].sort());
      await expect(
        gateway.executeTool({ sessionToken: session.token, tool: seeded.nameOf("mdm_erase_granola_note"), parameters: {} }),
      ).resolves.toMatchObject({ status: "completed" });
    } finally {
      await fake.close();
    }
  });

  it("TECH-7276: a run with no typed responsible user is refused 403 on the personal template, with no workspace fallback", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const grantOwner = `user-${randomUUID()}`;
    await createActiveMember(db, company.id, grantOwner);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: { jsonrpc: "2.0", id: fakeRequest.body?.id, result: { content: [{ type: "text", text: "ok" }] } },
    }));
    try {
      // The only usable credential belongs to someone else, and an organization grant exists too.
      const seeded = await seedRhMcpPersonal(db, company.id, { url: fake.url, userId: grantOwner });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

      await gateway.executeTool({ sessionToken: session.token, tool: seeded.nameOf("mdm_get_granola_note"), parameters: {} }).then(
        () => { throw new Error("Expected refusal without a responsible user"); },
        (error) => expectGatewayError(error, 403, "responsible_user_unknown"),
      );
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("TECH-7276: a user session (agentId null) keeps the profile-permitted non-Granola tool under the normal user controls; the same tool is ceiling-excluded with a pre-credential 404 only for the agent session", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const userId = `user-${randomUUID()}`;
    const run = await createRunForResponsibleUser(db, company.id, agent.id, userId);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: { jsonrpc: "2.0", id: fakeRequest.body?.id, result: { content: [{ type: "text", text: "ok" }] } },
    }));
    try {
      // The VALID tagged personal template, with a non-Granola catalog tool (mdm_get_org) next to the
      // five allowed Granola reads and the Granola writers.
      const seeded = await seedRhMcpPersonal(db, company.id, { url: fake.url, userId });
      const nonGranolaTool = "mdm_get_org";
      const [nonGranolaEntry] = await db.insert(toolCatalogEntries).values({
        companyId: company.id,
        applicationId: seeded.application.id,
        connectionId: seeded.connection.id,
        entryKind: "tool",
        name: `${nonGranolaTool}-${randomUUID()}`,
        toolName: nonGranolaTool,
        title: nonGranolaTool,
        description: `Call ${nonGranolaTool}`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        riskLevel: "read",
        isReadOnly: true,
        isWrite: false,
        isDestructive: false,
        status: "active",
        versionHash: randomUUID(),
      }).returning();
      const catalog = await db
        .select({ toolName: toolCatalogEntries.toolName })
        .from(toolCatalogEntries)
        .where(eq(toolCatalogEntries.connectionId, seeded.connection.id));
      expect(catalog.map((entry) => entry.toolName).sort()).toEqual(
        [...RH_MCP_READ_TOOLS, nonGranolaTool, ...RH_MCP_WRITE_TOOLS].sort(),
      );

      // The user control surface for a session with no agent: a named gateway whose profile permits
      // the five reads plus the non-Granola tool, and deliberately nothing else.
      const [userProfile] = await db.insert(toolProfiles).values({
        companyId: company.id,
        profileKey: `rh-mcp-user-gateway-${randomUUID()}`,
        name: `RH MCP user gateway ${randomUUID()}`,
        defaultAction: "deny",
      }).returning();
      const permittedEntries = [
        ...seeded.entries.filter((entry) => RH_MCP_READ_TOOLS.includes(entry.toolName!)),
        nonGranolaEntry!,
      ];
      await db.insert(toolProfileEntries).values(
        permittedEntries.map((entry) => ({
          companyId: company.id,
          profileId: userProfile!.id,
          selectorType: "catalog_entry" as const,
          effect: "include" as const,
          applicationId: seeded.application.id,
          connectionId: seeded.connection.id,
          catalogEntryId: entry.id,
        })),
      );
      const gateway = createTestToolGatewayService(db);
      const created = await gateway.createNamedGateway({
        companyId: company.id,
        body: { name: `RH MCP user gateway ${randomUUID()}`, profileId: userProfile!.id },
      });
      // The user session is genuinely agent-less: the gateway row carries no agent.
      const [gatewayRow] = await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.id, created.id));
      expect(gatewayRow!.agentId).toBeNull();
      const userToken = await gateway.createNamedGatewayToken({
        companyId: company.id,
        gatewayId: created.id,
        body: { name: "User desktop client" },
      });
      expect(userToken.subjectType).toBe("gateway_client");

      const invocationsBefore = await db.select().from(toolInvocations);
      const secretReadsBefore = await db.select().from(secretAccessEvents);

      // USER session (agentId null): the ceiling never shapes the list. The non-Granola tool is
      // listed next to the five reads, and the profile-excluded Granola writer is not -- the user's
      // own profile, not the agent read ceiling, is the only boundary.
      const userTools = (await gateway.listToolsForNamedGateway({
        gatewayPublicId: created.gatewayPublicId,
        bearerToken: userToken.token,
      })).tools.filter((tool) => tool.providerType === "mcp_remote_http");
      expect(userTools.map((tool) => tool.upstreamToolName).sort()).toEqual(
        [...RH_MCP_READ_TOOLS, nonGranolaTool].sort(),
      );

      // The user call on the non-Granola tool is never the ceiling 404: it passes the backstop and
      // the profile decision, and lands on the normal personal-only control for a session with no
      // responsible user -- a governed, recorded refusal with no credential decryption, no upstream.
      await gateway.executeTool({
        sessionToken: userToken.token,
        gatewayPublicId: created.gatewayPublicId,
        tool: seeded.nameOf(nonGranolaTool),
        parameters: {},
      }).then(
        () => { throw new Error("Expected the user-session call to hit the normal personal-only control"); },
        (error) => expectGatewayError(error, 403, "agent_not_personal"),
      );
      // A profile-excluded writer is refused by the user's own profile (the normal deny), not 404:
      // the ceiling grants the user session nothing, not even an unconditional permission.
      await gateway.executeTool({
        sessionToken: userToken.token,
        gatewayPublicId: created.gatewayPublicId,
        tool: seeded.nameOf("mdm_erase_granola_note"),
        parameters: {},
      }).then(
        () => { throw new Error("Expected the profile-excluded writer to be refused for the user session"); },
        (error) => expectGatewayError(error, 403, "deny_default"),
      );
      const userInvocations = await db.select().from(toolInvocations);
      expect(userInvocations).toHaveLength(invocationsBefore.length + 2);
      expect(userInvocations.find((invocation) => invocation.upstreamToolName === nonGranolaTool)).toMatchObject({
        agentId: null,
        runId: null,
        toolName: seeded.nameOf(nonGranolaTool),
        status: "failed",
        errorCode: "agent_not_personal",
      });
      expect(userInvocations.find((invocation) => invocation.upstreamToolName === "mdm_erase_granola_note")).toMatchObject({
        agentId: null,
        runId: null,
        toolName: seeded.nameOf("mdm_erase_granola_note"),
        status: "denied",
        errorCode: "deny_default",
      });
      expect(fake.requests).toHaveLength(0);
      expect(await db.select().from(secretAccessEvents)).toHaveLength(secretReadsBefore.length);

      // AGENT session on the same connection: the ceiling -- not a profile -- cuts the same
      // non-Granola tool the user session just used (the agent's own profile allows everything),
      // and its call is a plain 404 before any policy, invocation, credential or upstream work.
      await allowAllToolsForAgent(db, company.id, agent.id);
      const agentSession = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      const agentTools = (await gateway.listToolsForSession(agentSession.token)).filter(
        (tool) => tool.providerType === "mcp_remote_http",
      );
      expect(agentTools.map((tool) => tool.upstreamToolName).sort()).toEqual([...RH_MCP_READ_TOOLS].sort());
      await gateway.executeTool({
        sessionToken: agentSession.token,
        tool: seeded.nameOf(nonGranolaTool),
        parameters: {},
      }).then(
        () => { throw new Error("Expected the agent-session call on the non-Granola tool to be refused"); },
        (error) => expectGatewayError(error, 404, "tool_not_found"),
      );
      expect(fake.requests).toHaveLength(0);
      expect(await db.select().from(secretAccessEvents)).toHaveLength(secretReadsBefore.length);
      expect(await db.select().from(toolInvocations)).toHaveLength(userInvocations.length);
    } finally {
      await fake.close();
    }
  });

  it("TECH-7276: raw backstop in resolveConnectedRemoteTool enforces read ceiling when template tag is applied after initial lookup", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const userId = `user-${randomUUID()}`;
    const run = await createRunForResponsibleUser(db, company.id, agent.id, userId);
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: { jsonrpc: "2.0", id: fakeRequest.body?.id, result: { content: [{ type: "text", text: "ok" }] } },
    }));
    try {
      const seeded = await seedRhMcpPersonal(db, company.id, { url: fake.url, userId, tagged: false });
      await allowAllToolsForAgent(db, company.id, agent.id);
      const gateway = createTestToolGatewayService(db);
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

      const invocationsBefore = await db.select().from(toolInvocations);
      const secretEventsBefore = await db.select().from(secretAccessEvents);

      vi.mocked(managedInstallCheck).mockClear();
      try {
        vi.mocked(managedInstallCheck).mockImplementationOnce(async (dbArg, inputArg) => {
          const [conn] = await dbArg.select().from(toolConnections).where(eq(toolConnections.id, seeded.connection.id));
          const taggedConfig = {
            ...conn!.config,
            identityModel: "personal_only",
            paperclipDefaultMcpEntry: "rh-mcp",
          };
          await dbArg
            .update(toolConnections)
            .set({ config: taggedConfig, transportConfig: taggedConfig })
            .where(eq(toolConnections.id, seeded.connection.id));
          return actualDefaultMcpInstallGate.managedInstallCheck(dbArg, inputArg);
        });

        await gateway.executeTool({
          sessionToken: session.token,
          tool: seeded.nameOf("mdm_erase_granola_note"),
          parameters: {},
        }).then(
          () => { throw new Error("Expected mdm_erase_granola_note to be refused"); },
          (error) => expectGatewayError(error, 404, "tool_not_found"),
        );

        expect(vi.mocked(managedInstallCheck)).toHaveBeenCalledTimes(2);
        for (const call of vi.mocked(managedInstallCheck).mock.calls) {
          expect(call[1]).toEqual(
            expect.objectContaining({
              companyId: company.id,
              agentId: agent.id,
              connections: expect.arrayContaining([
                expect.objectContaining({
                  id: seeded.connection.id,
                  companyId: company.id,
                }),
              ]),
            }),
          );
        }
        expect(fake.requests).toHaveLength(0);
        expect(await db.select().from(toolInvocations)).toHaveLength(invocationsBefore.length);
        expect(await db.select().from(secretAccessEvents)).toHaveLength(secretEventsBefore.length);
      } finally {
        resetManagedInstallCheckMock();
      }
    } finally {
      await fake.close();
    }
  });

  it("TECH-7276: early-failure cleanup drops unconsumed managedInstallCheck once callbacks so later gate calls delegate to the actual gate", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    // The raw-backstop shape: a once callback that rewrites a seeded connection's config before
    // delegating. When a scenario fails before the gateway consumes the callback, the once stays
    // queued while the suite cleanup deletes the seeded rows: the next test's first gate call would
    // run the stale callback against a deleted connection and answer with its fabricated result
    // instead of the real gate's.
    const staleOnceConnectionId = randomUUID();
    let staleOnceExecuted = false;
    vi.mocked(managedInstallCheck).mockImplementationOnce(async (dbArg) => {
      staleOnceExecuted = true;
      await dbArg
        .update(toolConnections)
        .set({ config: {}, transportConfig: {} })
        .where(eq(toolConnections.id, staleOnceConnectionId));
      return { agentFound: false, blocked: new Set([staleOnceConnectionId]) };
    });

    // Early scenario failure: nothing consumed the once. Run the exact cleanup the raw-backstop
    // finally and the suite afterEach run, then prove it dropped the queued callback and history.
    resetManagedInstallCheckMock();
    expect(vi.mocked(managedInstallCheck).mock.calls).toHaveLength(0);

    const input = { companyId: company.id, agentId: agent.id, connections: [] };
    const expected = await actualDefaultMcpInstallGate.managedInstallCheck(db, input);
    const viaMock = await managedInstallCheck(db, input);

    expect(staleOnceExecuted).toBe(false);
    expect(vi.mocked(managedInstallCheck)).toHaveBeenCalledTimes(1);
    expect(viaMock).toEqual(expected);
    expect(viaMock).toEqual({ agentFound: true, blocked: new Set() });
  });

  it("TECH-7276: summarizeConnectionAccessForAgent reports ceiling tools off with agent_read_ceiling and zero matchedPolicyIds", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const userId = `user-${randomUUID()}`;
    const fake = await startFakeRemoteMcpServer((fakeRequest) => ({
      body: { jsonrpc: "2.0", id: fakeRequest.body?.id, result: { content: [{ type: "text", text: "ok" }] } },
    }));
    try {
      const seeded = await seedRhMcpPersonal(db, company.id, { url: fake.url, userId });
      await allowAllToolsForAgent(db, company.id, agent.id);

      let catalogProjections = 0;
      const realPolicy = toolAccessPolicyService(db);
      const evaluatedTools: string[] = [];
      const policyService = {
        ...realPolicy,
        decide: vi.fn(async (policyInput: Parameters<typeof realPolicy.decide>[0]) => {
          evaluatedTools.push(policyInput.request.upstreamToolName);
          return realPolicy.decide(policyInput);
        }),
      };
      const gateway = createTestToolGatewayService(db, {
        onCompanyCatalogProjected: () => {
          catalogProjections++;
        },
        policyService,
      });

      const summary = await gateway.summarizeConnectionAccessForAgent({
        companyId: company.id,
        connectionId: seeded.connection.id,
        agentId: agent.id,
      });

      // Exactly ONE expensive company-wide catalog projection query per summary call
      expect(catalogProjections).toBe(1);

      // Only the 5 within-ceiling tools have policy evaluated; 0 policy calls for the 3 ceiling-capped writers
      expect(evaluatedTools).toHaveLength(5);
      expect(evaluatedTools.sort()).toEqual([...RH_MCP_READ_TOOLS].sort());

      expect(summary.toolCount).toBe(8);
      expect(summary.allowedCount).toBe(5);
      expect(summary.askFirstCount).toBe(0);
      expect(summary.offCount).toBe(3);

      const reads = summary.tools.filter((t) => RH_MCP_READ_TOOLS.includes(t.toolName));
      expect(reads).toHaveLength(5);
      const expectedNormalReason = reads[0]!.reasonCode;
      expect(expectedNormalReason).toBeTruthy();
      for (const readTool of reads) {
        expect(readTool.decision).toBe("allowed");
        expect(readTool.reasonCode).toBe(expectedNormalReason);
      }

      const writers = summary.tools.filter((t) => RH_MCP_WRITE_TOOLS.includes(t.toolName));
      expect(writers).toHaveLength(3);
      for (const writerTool of writers) {
        expect(writerTool.decision).toBe("off");
        expect(writerTool.reasonCode).toBe("agent_read_ceiling");
        expect(writerTool.matchedPolicyIds).toEqual([]);
      }

      // Untagged control: all 8 tools including writers are allowed with the same normal reason
      const untagged = await seedRhMcpPersonal(db, company.id, {
        url: fake.url,
        userId,
        tagged: false,
        name: "rh-mcp-personal-untagged",
      });
      catalogProjections = 0;
      evaluatedTools.length = 0;
      const controlSummary = await gateway.summarizeConnectionAccessForAgent({
        companyId: company.id,
        connectionId: untagged.connection.id,
        agentId: agent.id,
      });

      expect(catalogProjections).toBe(1);
      expect(evaluatedTools).toHaveLength(8);
      expect(evaluatedTools.sort()).toEqual([...RH_MCP_READ_TOOLS, ...RH_MCP_WRITE_TOOLS].sort());
      expect(controlSummary.toolCount).toBe(8);
      expect(controlSummary.allowedCount).toBe(8);
      expect(controlSummary.askFirstCount).toBe(0);
      expect(controlSummary.offCount).toBe(0);
      for (const writerTool of controlSummary.tools.filter((t) => RH_MCP_WRITE_TOOLS.includes(t.toolName))) {
        expect(writerTool.decision).toBe("allowed");
        expect(writerTool.reasonCode).toBe(expectedNormalReason);
      }
    } finally {
      await fake.close();
    }
  });
});
