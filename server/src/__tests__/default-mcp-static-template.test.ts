import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { eq } from "drizzle-orm";
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
import { ARCANA_BRAIN_REVIEWED_TOOLS, ARCANA_STATIC_TEMPLATE_UID, DEFAULT_MCP_SPEC, readDefaultMcpState } from "../services/default-mcp-spec.js";
import { runDefaultMcpSetupForAgent, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { ARCANA_MCP_URL_ENV, ARCANA_PROVISION_TOKEN_ENV, ARCANA_URL_ENV } from "../services/arcana-provisioner-client.js";
import { ensureStaticCompanyTemplates, sweepStaticCompanyTemplates } from "../services/default-mcp-static-template.js";
import { ensureCompanyTemplate, sweepCompanyTemplates } from "../services/default-mcp-template.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";
const ARCANA_URL = "https://arcana.example.test";
const PROVISION_TOKEN = "synthetic-provision-token-0123456789abcdef";
const ARCANA_ENTRY = DEFAULT_MCP_SPEC.find((entry) => entry.key === "arcana-brain")!;
const later = (ms = 2 * 3_600_000) => () => new Date(Date.now() + ms);

const MCP_URL = "https://arcana-mcp.example.test/mcp";

describeEmbeddedPostgres("default MCP static-catalog template bootstrap (TECH-7253)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-static-template-${randomUUID()}`);
  const env: NodeJS.ProcessEnv = { [FEATURE_ENV]: "true", [ARCANA_URL_ENV]: ARCANA_URL, [ARCANA_PROVISION_TOKEN_ENV]: PROVISION_TOKEN, [ARCANA_MCP_URL_ENV]: MCP_URL };
  const ctx = (over: Partial<Parameters<typeof ensureStaticCompanyTemplates>[0]> = {}) => ({
    db,
    env,
    spec: [ARCANA_ENTRY],
    scope: { mode: "all" } as const,
    ...over,
  });

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("static-template");
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

  async function seedCompany(status: "active" | "archived" = "active") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status,
    });
    return companyId;
  }
  const rowsOf = (companyId: string) => db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
  const catalogOf = (connectionId: string) => db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId));

  it("creates the template once, idempotently, with exactly the five reviewed verbs active", async () => {
    const companyId = await seedCompany();
    const first = await ensureStaticCompanyTemplates(ctx(), { companyId });
    expect(first).toEqual([{ kind: "ready", created: true }]);
    const second = await ensureStaticCompanyTemplates(ctx(), { companyId });
    expect(second).toEqual([{ kind: "ready", created: false }]);

    const rows = await rowsOf(companyId);
    expect(rows).toHaveLength(1);
    const template = rows[0]!;
    expect(template).toMatchObject({ name: "rh-arcana-brain", uid: ARCANA_STATIC_TEMPLATE_UID, transport: "mcp_remote", authKind: "api_key", status: "active" });
    expect((template.config as { url: string }).url).toBe(MCP_URL);
    const headers = (template.credentialRefs ?? []).filter((ref) => ref.placement === "header");
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ key: "Authorization", prefix: "Bearer " });

    const catalog = await catalogOf(template.id);
    expect(catalog.map((row) => row.toolName).sort()).toEqual([...ARCANA_BRAIN_REVIEWED_TOOLS].sort());
    expect(catalog.every((row) => row.status === "active" && row.isReadOnly && !row.isWrite)).toBe(true);
    // Exactly one default-deny profile that includes exactly those entries, and no bindings.
    const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId));
    expect(profile!.defaultAction).toBe("deny");
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile!.id))).toHaveLength(5);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId))).toHaveLength(0);
    // One placeholder secret, reused rather than duplicated.
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(1);
  });

  it("narrows drift: a tool outside the reviewed verbs is disabled and a disabled reviewed verb is restored", async () => {
    const companyId = await seedCompany();
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    const [template] = await rowsOf(companyId);
    await db.insert(toolCatalogEntries).values({ companyId, applicationId: template!.applicationId, connectionId: template!.id, name: "delete_everything", toolName: "delete_everything", versionHash: "x", status: "active" });
    await db.update(toolCatalogEntries).set({ status: "disabled" }).where(eq(toolCatalogEntries.toolName, "recall"));
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    const catalog = await catalogOf(template!.id);
    expect(catalog.find((row) => row.toolName === "delete_everything")!.status).toBe("disabled");
    expect(catalog.find((row) => row.toolName === "recall")!.status).toBe("active");
  });

  it("adopts an org-authored same-named template unchanged", async () => {
    const companyId = await seedCompany();
    const application = await db.insert(toolApplications).values({ companyId, applicationKey: "org-app", name: "org arcana", type: "mcp_http", status: "active" }).returning().then((r) => r[0]!);
    await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "rh-arcana-brain", uid: `uid-${randomUUID()}`, transport: "mcp_remote", authKind: "api_key", credentialPolicy: "shared", status: "active", enabled: true, config: { url: "https://org.example.test/mcp" }, transportConfig: { url: "https://org.example.test/mcp" } });
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId })).toEqual([{ kind: "adopted" }]);
    const rows = await rowsOf(companyId);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.config as { url: string }).url).toBe("https://org.example.test/mcp");
    expect(await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(0);
  });

  it("reports an ambiguous pair of same-named templates and writes nothing", async () => {
    const companyId = await seedCompany();
    const application = await db.insert(toolApplications).values({ companyId, applicationKey: "org-app", name: "org arcana", type: "mcp_http", status: "active" }).returning().then((r) => r[0]!);
    for (let i = 0; i < 2; i += 1) {
      await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "rh-arcana-brain", uid: `uid-${randomUUID()}`, transport: "mcp_remote", authKind: "api_key", credentialPolicy: "shared", status: "active", enabled: true, config: {}, transportConfig: {} });
    }
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId })).toEqual([{ kind: "collision", reason: "template_ambiguous" }]);
    expect(await rowsOf(companyId)).toHaveLength(2);
  });

  it("never recreates a template an operator archived", async () => {
    const companyId = await seedCompany();
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.companyId, companyId));
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId })).toEqual([{ kind: "revoked" }]);
    expect(await rowsOf(companyId)).toHaveLength(1);
  });

  it("waits, writing nothing, when the MCP URL is missing or invalid", async () => {
    const companyId = await seedCompany();
    const missing = { ...env, [ARCANA_MCP_URL_ENV]: "" };
    expect(await ensureStaticCompanyTemplates(ctx({ env: missing }), { companyId })).toEqual([{ kind: "waiting", reason: "mcp_url_not_configured" }]);
    for (const bad of ["http://evil.example.test/mcp", "not a url", "https://user:pw@h.example.test/mcp", "https://h.example.test/mcp?x=1"]) {
      const result = await ensureStaticCompanyTemplates(ctx({ env: { ...env, [ARCANA_MCP_URL_ENV]: bad } }), { companyId });
      expect(result).toEqual([{ kind: "waiting", reason: "mcp_url_invalid" }]);
    }
    expect(await rowsOf(companyId)).toHaveLength(0);
  });

  it("allows an http loopback MCP URL and nothing else over http", async () => {
    const companyId = await seedCompany();
    const out = await ensureStaticCompanyTemplates(ctx({ env: { ...env, [ARCANA_MCP_URL_ENV]: "http://127.0.0.1:8000/mcp" } }), { companyId });
    expect(out).toEqual([{ kind: "ready", created: true }]);
  });

  it("is skipped when the feature is off, the company is out of scope or archived", async () => {
    const companyId = await seedCompany();
    const archived = await seedCompany("archived");
    const { [FEATURE_ENV]: _off, ...noFeature } = env;
    expect(await ensureStaticCompanyTemplates(ctx({ env: noFeature }), { companyId })).toEqual([{ kind: "skipped", reason: "feature_disabled" }]);
    expect(await ensureStaticCompanyTemplates(ctx({ scope: { mode: "none" } }), { companyId })).toEqual([{ kind: "skipped", reason: "out_of_scope" }]);
    expect(await ensureStaticCompanyTemplates(ctx(), { companyId: archived })).toEqual([{ kind: "skipped", reason: "company_archived" }]);
    expect(await rowsOf(companyId)).toHaveLength(0);
    expect(await rowsOf(archived)).toHaveLength(0);
  });

  it("the sweep creates missing templates once and leaves existing ones alone", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const swept = await sweepStaticCompanyTemplates(ctx());
    expect(swept).toBe(2);
    expect(await rowsOf(a)).toHaveLength(1);
    expect(await rowsOf(b)).toHaveLength(1);
    expect(await sweepStaticCompanyTemplates(ctx())).toBe(0);
  });

  it("the combined sweep and comms ensure ignore the static entry (comms behavior unchanged)", async () => {
    const companyId = await seedCompany();
    // With only the static entry in the spec the comms bootstrap has nothing to do and writes nothing.
    expect(await ensureCompanyTemplate(ctx(), { companyId })).toEqual({ kind: "skipped", reason: "no_bootstrap_entry" });
    expect(await rowsOf(companyId)).toHaveLength(0);
    expect(await sweepCompanyTemplates(ctx())).toBe(1); // only the static half acts
    const rows = await rowsOf(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uid).toBe(ARCANA_STATIC_TEMPLATE_UID);
  });

  it("the created template passes the arcana_brain hook's template resolution and clones only the five verbs", async () => {
    const companyId = await seedCompany();
    await ensureStaticCompanyTemplates(ctx(), { companyId });
    const owner = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: owner, name: "Owner", email: "owner@redesignhealth.com", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "owner" });
    process.env[FEATURE_ENV] = "true";
    const created = await agentService(db).create(
      companyId,
      { name: "Agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId: owner } },
    );
    await waitForScheduledDefaultMcpSetups();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { agent_principal_id: string };
      return new Response(JSON.stringify({ brain_id: `agent:${body.agent_principal_id}`, status: "active" }), { status: 201 });
    }) as unknown as typeof fetch;
    await runDefaultMcpSetupForAgent({ db, env, fetchImpl, spec: [ARCANA_ENTRY], now: () => new Date(Date.now() + 2 * 3_600_000) }, { companyId, agentId: created.id });
    delete process.env[FEATURE_ENV];
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, created.id));
    const state = readDefaultMcpState(agentRow!.metadata)!.entries["arcana-brain"]!;
    expect(state.setup.state).toBe("ready");
    const dedicated = (await rowsOf(companyId)).find((row) => row.name === `rh-arcana-brain:${created.id}`)!;
    expect(dedicated.credentialPolicy).toBe("per_agent");
    const clonedTools = (await catalogOf(dedicated.id)).filter((row) => row.status === "active").map((row) => row.toolName).sort();
    expect(clonedTools).toEqual([...ARCANA_BRAIN_REVIEWED_TOOLS].sort());
  });
});
