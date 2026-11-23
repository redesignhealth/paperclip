import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySecrets,
  connectionGrants,
  createDb,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveManagedGitHubCredential } from "../services/git-credentials.js";
import { resetGitHubAppCachesForTest } from "../services/github-app-installation.js";

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(),
  resolveSecretValue: vi.fn(async () => "oauth-dedicated-token"),
}));

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const appEnv = {
  PAPERCLIP_GITHUB_APP_ID: "12345",
  PAPERCLIP_GITHUB_APP_INSTALLATION_ID: "678",
  PAPERCLIP_GITHUB_APP_PRIVATE_KEY: privateKey,
} as NodeJS.ProcessEnv;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitHub App installation grant selection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-app-grant-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllGlobals();
  }, 60_000);

  async function seed(kind: "app" | "oauth", repositories: string[] = ["redesignhealth/alpha"]) {
    const companyId = randomUUID(), agentId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Bot", role: "engineer", adapterType: "codex_local" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: applicationId, type: "mcp_http" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: connectionId, uid: connectionId, transport: "mcp_remote",
      status: "active", enabled: true, credentialPolicy: "per_agent", config: { sourceTemplateKey: "github" },
    });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: "agent", targetId: agentId });
    const secretId = randomUUID();
    let credentialSecretRefs: Array<{ secretId: string; configPath: string; versionSelector: string }> = [];
    if (kind === "oauth") {
      await db.insert(companySecrets).values({ id: secretId, companyId, key: secretId, name: secretId, scope: "company" });
      credentialSecretRefs = [{ secretId, configPath: "oauth.access_token", versionSelector: "latest" }];
    }
    await db.insert(connectionGrants).values({
      companyId, connectionId, kind: "agent", subjectAgentId: agentId, status: "active", credentialSecretRefs,
      providerTenant: {
        github: {
          userId: "99", login: "dedicated-login", installationCount: 1, repositoryCount: repositories.length,
          repositorySelection: "selected", installationIds: ["1"], installationOwnerLogins: ["o"],
          repositories: repositories.map((fullName) => ({ id: fullName, fullName, installationId: "app" })),
          ...(kind === "app" ? { appInstallation: true } : {}),
        },
      },
    });
    return { companyId, agentId };
  }

  function stubGitHub() {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return url.endsWith("/app")
        ? new Response(JSON.stringify({ slug: "rh-code-factory" }))
        : new Response(JSON.stringify({ token: "ghs_minted_token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
    }));
    return calls;
  }

  it("mints a scoped installation token with the app bot identity and reads no OAuth secret", async () => {
    resetGitHubAppCachesForTest();
    const calls = stubGitHub();
    const { companyId, agentId } = await seed("app", ["redesignhealth/alpha"]);
    vault.resolveSecretValue.mockClear();
    const result = await resolveManagedGitHubCredential(db, vault as never, companyId, { agentId }, appEnv);
    expect(result.credential).toMatchObject({
      token: "ghs_minted_token", identitySource: "dedicated",
      githubIdentity: { userId: "12345", login: "rh-code-factory[bot]" },
    });
    expect(calls.find((call) => call.url.endsWith("/access_tokens"))?.body).toEqual({
      repositories: ["alpha"], permissions: { contents: "write", pull_requests: "write" },
    });
    expect(vault.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("fails closed with a redacted reason when env is missing or the grant has no repositories", async () => {
    resetGitHubAppCachesForTest();
    const calls = stubGitHub();
    const missingEnv = await seed("app");
    const a = await resolveManagedGitHubCredential(db, vault as never, missingEnv.companyId, { agentId: missingEnv.agentId }, {});
    expect(a).toMatchObject({ configured: true, error: expect.stringMatching(/not configured/) });
    const noRepos = await seed("app", []);
    const b = await resolveManagedGitHubCredential(db, vault as never, noRepos.companyId, { agentId: noRepos.agentId }, appEnv);
    expect(b.credential).toBeUndefined();
    expect(b.error).toMatch(/unscoped/);
    expect(calls.some((call) => call.url.endsWith("/access_tokens"))).toBe(false);
  });

  it("leaves the OAuth dedicated-grant path unchanged", async () => {
    const calls = stubGitHub();
    const { companyId, agentId } = await seed("oauth");
    const result = await resolveManagedGitHubCredential(db, vault as never, companyId, { agentId }, appEnv);
    expect(result.credential).toMatchObject({
      token: "oauth-dedicated-token", identitySource: "dedicated",
      githubIdentity: { userId: "99", login: "dedicated-login" },
    });
    expect(calls).toHaveLength(0);
  });
});
