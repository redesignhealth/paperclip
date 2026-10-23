/**
 * TECH-7228 bootstrap regressions, at the setup-hook level.
 *
 * The resolver seam (frozen boot snapshot vs live env vs injected env) is pinned by
 * secrets/__tests__/comms-board-provisioner-credentials.test.ts, and the bootstrap import order
 * (capture before dotenv, re-scrub after each dotenv load, default-env children see no tokens) by
 * comms-board-provisioner-startup-order.test.ts. Neither drives the composition this file pins:
 * the REAL setup hook resolving config through the live `process.env` branch while the live
 * environment holds a later hostile repopulation — the shape a `.env` load on writable storage
 * produces after boot. Regression targets:
 *
 * - zero unintended config adoption: only the frozen boot snapshot supplies the four settings,
 *   whatever the live environment later holds (attacker endpoints, replacement tokens, blanks);
 * - zero unintended fetch adoption: every board/ownership request goes to the frozen endpoints
 *   with the frozen bearers, and an attacker host receives nothing;
 * - classification (missing vs invalid) is computed from the snapshot, never the live values;
 * - no hostile value and no credential appears in any diagnostic (agent row, entry state, audit).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { DEFAULT_MCP_SPEC_ENABLED_ENV, readDefaultMcpState } from "../services/default-mcp-spec.js";
import { runDefaultMcpSetupForAgent, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { captureAndScrubCommsBoardProvisionerCredentials } from "../secrets/comms-board-provisioner-credentials.js";
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
  SECRETS,
  clearBootProvisionerSnapshot,
  downstreamFetch,
  installBootProvisionerSnapshot,
} from "./helpers/comms-board-downstream.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TEMPLATE_URL = "https://8.8.8.8/mcp";
/** A test clock three hours ahead: past every waiting backoff written at creation (a legitimate future time, not a past one). */
const AFTER_BACKOFF = () => new Date(Date.now() + 3 * 3_600_000);

// Realistic non-empty fixture values for the hostile LATER write (a dotenv-style repopulation).
// Distinct from the frozen helper fixtures so every assertion can tell them apart.
const ATTACKER_MCP_URL = "https://attacker.regression.test/mcp";
const ATTACKER_OWNERSHIP_URL = "https://attacker.regression.test/ownership";
/** Plain HTTP on a non-loopback host: a valid-shaped env that would classify provisioner_config_invalid. */
const INVALID_LATE_MCP_URL = "http://attacker.regression.test/mcp";
const LATE_ADMIN_TOKEN = "late-admin-token-regression-fixture-83f1c2";
const LATE_OWNERSHIP_TOKEN = "late-ownership-token-regression-fixture-90ab4d";
const ATTACKER_HOST_MARKER = "attacker.regression.test";

describeEmbeddedPostgres("comms-board provisioner bootstrap regressions (TECH-7228)", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmp = path.join(os.tmpdir(), `paperclip-comms-bootstrap-regressions-${randomUUID()}`);
  const envKeys = [
    DEFAULT_MCP_SPEC_ENABLED_ENV,
    COMMS_BOARD_MCP_URL_ENV,
    COMMS_BOARD_ADMIN_TOKEN_ENV,
    COMMS_BOARD_OWNERSHIP_API_URL_ENV,
    COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  ];

  beforeAll(async () => {
    mkdirSync(tmp, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmp, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("comms-board-provisioner-bootstrap");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
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
    rmSync(tmp, { recursive: true, force: true });
  });

  // ---- fixtures ------------------------------------------------------------------------------

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
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  /** The org's read-only template connection, with one reviewed action and its access profile. */
  async function seedTemplate(
    companyId: string,
    name: string,
    opts: { authKind?: "api_key" | "oauth"; status?: "active" | "draft"; withAccess?: boolean } = {},
  ) {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${name} ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const sharedSecret = await secretService(db).create(companyId, {
      name: `shared ${name} ${randomUUID()}`,
      key: `shared.${randomUUID()}`,
      provider: "local_encrypted",
      value: "org-shared-template-token",
    });
    const apiKey = (opts.authKind ?? "api_key") === "api_key";
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name,
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind: opts.authKind ?? "api_key",
        credentialPolicy: apiKey ? "shared" : "per_user",
        status: opts.status ?? "active",
        enabled: true,
        config: { url: TEMPLATE_URL },
        transportConfig: { url: TEMPLATE_URL },
        credentialRefs: apiKey
          ? [{ name: "credentials.authorization", secretId: sharedSecret.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }]
          : [],
      })
      .returning()
      .then((rows) => rows[0]!);
    let catalogEntryId: string | null = null;
    let profileId: string | null = null;
    if (opts.withAccess !== false) {
      const [entry] = await db
        .insert(toolCatalogEntries)
        .values({ companyId, applicationId: application.id, connectionId: connection.id, name: "send_note", toolName: "send_note", versionHash: "v1" })
        .returning();
      catalogEntryId = entry!.id;
      const [profile] = await db
        .insert(toolProfiles)
        .values({ companyId, profileKey: `app:${connection.id}`, name: `${name} access`, defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: connection.id } })
        .returning();
      profileId = profile!.id;
      await db.insert(toolProfileEntries).values({ companyId, profileId, selectorType: "catalog_entry", effect: "include", connectionId: connection.id, catalogEntryId });
    }
    return { connection, application, catalogEntryId, profileId, sharedSecretId: sharedSecret.id };
  }

  async function seedBothTemplates(companyId: string) {
    const comms = await seedTemplate(companyId, "rh-comms-board");
    const google = await seedTemplate(companyId, "rh-google-mcp", { authKind: "oauth" });
    return { comms, google };
  }

  async function createAgent(companyId: string, ownerUserId: string) {
    const created = await agentService(db).create(
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
      },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  const rowOf = (agentId: string) => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
  const entryOf = async (agentId: string, key = "comms-board") => readDefaultMcpState((await rowOf(agentId)).metadata)!.entries[key]!;

  /** The four deployment settings the server booted with (captured into the frozen snapshot). */
  function bootEnv(): NodeJS.ProcessEnv {
    return {
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    };
  }

  // ---- the scenario under regression ---------------------------------------------------------

  /**
   * The production shape: the agent is created while unconfigured (its first scheduled attempt lands
   * visibly pending and makes zero external calls), the server then "boots" with the four deployment
   * settings (a frozen snapshot; `process.env` itself stays clean), and the pass under test is the
   * next one, which resolves config through the live environment branch.
   */
  async function bootServerWithPendingAgent(fetchMock: ReturnType<typeof downstreamFetch>) {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedBothTemplates(companyId);
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";
    const agent = await createAgent(companyId, ownerId);

    // Unconfigured at creation: nothing external was called and the entry is visibly pending.
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await entryOf(agent.id)).setup).toMatchObject({ state: "pending", reason: "provisioner_not_configured" });

    // The boot capture. installBootProvisionerSnapshot captures from a copy: process.env is untouched.
    installBootProvisionerSnapshot(bootEnv());
    return { companyId, agentId: agent.id };
  }

  // The hostile LATER writes into the live environment (a dotenv load on writable storage).

  function writeFullHostileLiveEnv() {
    process.env[COMMS_BOARD_MCP_URL_ENV] = ATTACKER_MCP_URL;
    process.env[COMMS_BOARD_OWNERSHIP_API_URL_ENV] = ATTACKER_OWNERSHIP_URL;
    process.env[COMMS_BOARD_ADMIN_TOKEN_ENV] = LATE_ADMIN_TOKEN;
    process.env[COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV] = LATE_OWNERSHIP_TOKEN;
  }

  function writeTokenOnlyLiveEnv() {
    process.env[COMMS_BOARD_ADMIN_TOKEN_ENV] = LATE_ADMIN_TOKEN;
    process.env[COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV] = LATE_OWNERSHIP_TOKEN;
  }

  function writeInvalidLateUrlLiveEnv() {
    process.env[COMMS_BOARD_MCP_URL_ENV] = INVALID_LATE_MCP_URL;
    process.env[COMMS_BOARD_OWNERSHIP_API_URL_ENV] = ATTACKER_OWNERSHIP_URL;
    process.env[COMMS_BOARD_ADMIN_TOKEN_ENV] = LATE_ADMIN_TOKEN;
    process.env[COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV] = LATE_OWNERSHIP_TOKEN;
  }

  function writeBlankTokenLiveEnv() {
    process.env[COMMS_BOARD_MCP_URL_ENV] = ATTACKER_MCP_URL;
    process.env[COMMS_BOARD_OWNERSHIP_API_URL_ENV] = ATTACKER_OWNERSHIP_URL;
    process.env[COMMS_BOARD_ADMIN_TOKEN_ENV] = "  \t";
    process.env[COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV] = "";
  }

  const HOSTILE_LIVE_ENV_WRITES: Array<[string, () => void]> = [
    ["a full hostile replacement (both endpoints and both tokens)", writeFullHostileLiveEnv],
    ["a token-only repopulation (the endpoint keys are absent from the live env)", writeTokenOnlyLiveEnv],
    // If the classification read the live env, this shape would be provisioner_config_invalid (pending, zero fetches).
    ["an invalid later endpoint URL", writeInvalidLateUrlLiveEnv],
    // If the resolver read the live env, blanks are missing: provisioner_not_configured (pending, zero fetches).
    ["blank later tokens", writeBlankTokenLiveEnv],
  ];

  /** Zero unintended adoption of anything the hostile live environment holds, plus sanitized diagnostics. */
  async function expectFrozenAdoption(companyId: string, agentId: string, fetchMock: ReturnType<typeof downstreamFetch>) {
    const entry = await entryOf(agentId);
    expect(entry.setup.state).toBe("ready");
    expect(entry.setup.reason).toBeNull();
    expect(entry.binding?.boardAgentId).toBeTruthy();

    // Exactly one board identity registration and one credential mint, both from the frozen snapshot.
    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(1);

    // Zero unintended fetch adoption: every request went to a frozen endpoint, so the attacker host
    // received nothing (downstreamFetch also throws on any URL but the two frozen ones).
    const urls = fetchMock.mock.calls.map(([url]) => url);
    const boardUrls = urls.filter((u) => u === BOARD_URL);
    const mintUrls = urls.filter((u) => u === `${OWNERSHIP_URL}/agents`);
    expect(boardUrls.length).toBeGreaterThan(0);
    expect(mintUrls.length).toBeGreaterThan(0);
    expect(boardUrls.length + mintUrls.length).toBe(urls.length);
    expect(urls.some((u) => u.includes(ATTACKER_HOST_MARKER))).toBe(false);

    // The bearers that actually rode the requests are the frozen boot tokens, never the late ones.
    const boardBearers: string[] = [];
    for (const [url, init] of fetchMock.mock.calls) {
      const authorization = ((init.headers ?? {}) as Record<string, string | undefined>).authorization;
      if (authorization === undefined) continue;
      expect(authorization).not.toContain(LATE_ADMIN_TOKEN);
      expect(authorization).not.toContain(LATE_OWNERSHIP_TOKEN);
      if (url === `${OWNERSHIP_URL}/agents`) expect(authorization).toBe(`Bearer ${OWNERSHIP_TOKEN}`);
      else boardBearers.push(authorization);
    }
    expect(boardBearers).toContain(`Bearer ${BOARD_ADMIN_TOKEN}`);
    expect(boardBearers.every((bearer) => bearer === `Bearer ${BOARD_ADMIN_TOKEN}`)).toBe(true);

    // No hostile value and no credential in any diagnostic: the agent row, the entry state, the audit log.
    const row = await rowOf(agentId);
    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    for (const blob of [JSON.stringify(row), JSON.stringify(entry), JSON.stringify(audit)]) {
      expect(blob).not.toContain(ATTACKER_HOST_MARKER);
      expect(blob).not.toContain(LATE_ADMIN_TOKEN);
      expect(blob).not.toContain(LATE_OWNERSHIP_TOKEN);
      for (const secret of SECRETS) expect(blob).not.toContain(secret);
    }
  }

  // ---- the regressions -----------------------------------------------------------------------

  it.each(HOSTILE_LIVE_ENV_WRITES)(
    "live-path setup under %s adopts the frozen boot snapshot only",
    async (_label, writeHostileLiveEnv) => {
      const fetchMock = downstreamFetch();
      vi.stubGlobal("fetch", fetchMock);
      const { companyId, agentId } = await bootServerWithPendingAgent(fetchMock);

      // The live environment turns hostile AFTER the boot capture.
      writeHostileLiveEnv();

      // The production call shape: no injected env, so the hook's env IS process.env and the resolver
      // takes the boot-snapshot branch (TECH-7228) — never the hostile live values.
      await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, now: AFTER_BACKOFF }, { companyId, agentId });

      await expectFrozenAdoption(companyId, agentId, fetchMock);
    },
  );

  it("an explicit env: process.env pass (same object by identity) still resolves the frozen snapshot, never the hostile live values", async () => {
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { companyId, agentId } = await bootServerWithPendingAgent(fetchMock);
    writeFullHostileLiveEnv();

    // Only a genuinely separate injected env object is converted purely; the global env object, even
    // passed explicitly, keeps the snapshot branch.
    await runDefaultMcpSetupForAgent({ db, env: process.env, fetchImpl: fetchMock, now: AFTER_BACKOFF }, { companyId, agentId });

    await expectFrozenAdoption(companyId, agentId, fetchMock);
  });

  it("a post-boot re-scrub (the config.ts dotenv re-scrub shape) deletes the repopulated tokens from the live env and the setup still runs from the snapshot", async () => {
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { companyId, agentId } = await bootServerWithPendingAgent(fetchMock);
    writeFullHostileLiveEnv();

    // config.ts re-scrubs after each dotenv load: unconditional deletion, never adoption.
    expect(captureAndScrubCommsBoardProvisionerCredentials()).toEqual({ configured: true });
    expect(COMMS_BOARD_ADMIN_TOKEN_ENV in process.env).toBe(false);
    expect(COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV in process.env).toBe(false);
    // The endpoint keys are NOT secrets and stay in the live env, but the snapshot still wins.
    expect(process.env[COMMS_BOARD_MCP_URL_ENV]).toBe(ATTACKER_MCP_URL);

    await runDefaultMcpSetupForAgent({ db, fetchImpl: fetchMock, now: AFTER_BACKOFF }, { companyId, agentId });

    await expectFrozenAdoption(companyId, agentId, fetchMock);
  });
});
