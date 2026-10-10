import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolProfiles,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __resetDefaultMcpTemplateScopeForTests,
  captureDefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import { agentService } from "../services/agents.js";
import { DEFAULT_MCP_SPEC, readDefaultMcpState } from "../services/default-mcp-spec.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  censusLegacyAgentsPendingDefaultMcp,
  enrollLegacyAgentsWithDefaultMcp,
} from "../services/default-mcp-legacy-enrollment.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

describeEmbeddedPostgres("TECH-7339: legacy agent enrollment into the default MCP spec", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let raceDb!: ReturnType<typeof createDb>;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-legacy-enrollment-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-legacy-enrollment");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    // Independent pool for the race tests: a commit from here lands between statements of the
    // enrollment transaction (Postgres READ COMMITTED re-snapshots every statement).
    raceDb = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
    delete process.env[FEATURE_ENV];
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    delete process.env[FEATURE_ENV];
  });

  afterAll(async () => {
    await stopDb?.();
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  // ---- seeding ------------------------------------------------------------------------------

  async function seedCompany(opts: { status?: "active" | "paused" | "archived" } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: opts.status ?? "active",
    });
    return companyId;
  }

  async function seedMember(companyId: string, opts: { email?: string; role?: string; verified?: boolean } = {}) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Member",
      email: opts.email ?? `${userId}@redesignhealth.com`,
      emailVerified: opts.verified ?? true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: opts.role ?? "member" });
    return userId;
  }

  const seedOwner = (companyId: string, email = "owner@redesignhealth.com") => seedMember(companyId, { email, role: "owner" });

  /** Creates an agent the way the routes do, with the feature flag however it currently is. */
  async function createAgent(companyId: string, ownerUserId: string | null = null) {
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
      },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
  }

  /** The real route writes this on `agentService.create`/`.hire` -- the service call this test suite
   * uses directly does not, so tests reproduce it explicitly to control what evidence exists. */
  async function logAgentCreated(companyId: string, agentId: string, creatorUserId: string) {
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: creatorUserId, action: "agent.created", entityType: "agent", entityId: agentId });
  }

  /**
   * A "legacy" agent: created while the feature flag was off, so it has no `defaultMcp` key at all.
   * `creatorUserId` logs the `agent.created` activity a real creation request would have produced;
   * pass `null` to simulate an agent with no recorded creator (the common case for truly old agents
   * predating activity logging, or ones created by a non-human actor with no later approval either).
   */
  async function createLegacyAgent(companyId: string, creatorUserId: string | null) {
    delete process.env[FEATURE_ENV];
    const created = await createAgent(companyId);
    if (creatorUserId) await logAgentCreated(companyId, created.id, creatorUserId);
    const row = await rowOf(created.id);
    expect(readDefaultMcpState(row.metadata)).toBeNull();
    return created;
  }

  async function seedConnection(companyId: string, name: string, opts: { status?: "active" | "draft" | "archived" } = {}) {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${name} ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    return db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name,
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "shared",
        status: opts.status ?? "active",
        enabled: true,
        config: {},
        transportConfig: { url: "https://8.8.8.8/mcp" },
        credentialRefs: [],
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function grantInstall(companyId: string, connectionId: string, target: { targetType: "company" | "agent"; targetId: string }) {
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: target.targetType, targetId: target.targetId });
  }

  const installedConnectionNames = async (companyId: string, agentId: string) =>
    (await toolAccessService(db).getEffectiveProfilesForAgent(companyId, agentId)).installedConnections.map((c) => c.name).sort();

  const rowOf = (agentId: string) => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);

  function enableFeature() {
    process.env[FEATURE_ENV] = "true";
  }

  // ---- gating ---------------------------------------------------------------------------------

  it("feature flag off: scans nothing and writes nothing", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await createLegacyAgent(companyId, ownerId);

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report).toEqual({ scanned: 0, outcomes: [], nextCursor: null });
  });

  it("dry run performs a census with zero writes", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    enableFeature();

    const report = await censusLegacyAgentsPendingDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "would_enroll" }]);
    const row = await rowOf(legacy.id);
    expect(readDefaultMcpState(row.metadata)).toBeNull();
  });

  // ---- enrollment -------------------------------------------------------------------------

  it("enrolls a legacy agent through the same snapshot path new agents get, and schedules setup", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    const row = await rowOf(legacy.id);
    const state = readDefaultMcpState(row.metadata);
    expect(state).not.toBeNull();
    expect(state!.entries["comms-board"]!.ownerUserId).toBe(ownerId);
  });

  it("a second pass over the same agent is a no-op: no duplicate enrollment, no outcome reported", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    enableFeature();

    await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();
    const firstState = readDefaultMcpState((await rowOf(legacy.id)).metadata);

    const second = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(second.outcomes).toEqual([]);
    const secondState = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(secondState).toEqual(firstState);
  });

  it("an agent created after the feature already shipped is left alone (nothing to enroll)", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    enableFeature();
    const modern = await createAgent(companyId, null);
    await waitForScheduledDefaultMcpSetups();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes.find((o) => o.agentId === modern.id)).toBeUndefined();
  });

  it("reports and skips a corrupted defaultMcp key instead of overwriting it", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    await db.update(agents).set({ metadata: { defaultMcp: { version: 2 } } }).where(eq(agents.id, legacy.id));
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "corrupted_existing_state" }]);
    const row = await rowOf(legacy.id);
    expect(row.metadata).toEqual({ defaultMcp: { version: 2 } });
  });

  it("skips and reports an archived company without enrolling its agents", async () => {
    const companyId = await seedCompany({ status: "active" });
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "company_archived" }]);
  });

  it("skips and reports a company outside the frozen rollout scope", async () => {
    const inScope = await seedCompany();
    const outOfScope = await seedCompany();
    await seedOwner(inScope);
    const outOwnerId = await seedOwner(outOfScope);
    const legacyOut = await createLegacyAgent(outOfScope, outOwnerId);
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS: inScope });
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId: outOfScope });

    expect(report.outcomes).toEqual([{ agentId: legacyOut.id, companyId: outOfScope, result: "skipped", reason: "company_out_of_scope" }]);
  });

  it("reports owner_required when the company has no eligible verified owner", async () => {
    const companyId = await seedCompany();
    const legacy = await createLegacyAgent(companyId, null);
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
  });

  it("a dry-run census agrees with the live outcome when the company has no eligible owner", async () => {
    const companyId = await seedCompany();
    const legacy = await createLegacyAgent(companyId, null);
    enableFeature();

    const report = await censusLegacyAgentsPendingDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
  });

  it("skips and reports a terminated legacy agent without enrolling it", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, legacy.id));
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "agent_terminated" }]);
  });

  it("sets awaiting_approval on an enrolled pending-approval agent, matching new-agent behavior", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, legacy.id));
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["comms-board"]!.setup.reason).toBe("awaiting_approval");
  });

  it("reports non-object metadata (array/scalar) as corrupted rather than treating it as absent", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    await db.update(agents).set({ metadata: [] as unknown as Record<string, unknown> }).where(eq(agents.id, legacy.id));
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "corrupted_existing_state" }]);
    const row = await rowOf(legacy.id);
    expect(row.metadata).toEqual([]);
  });

  it("pages through more legacy agents than fit in one batch via nextCursor", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacyIds: string[] = [];
    for (let i = 0; i < 3; i++) legacyIds.push((await createLegacyAgent(companyId, ownerId)).id);
    enableFeature();

    const first = await enrollLegacyAgentsWithDefaultMcp(db, { companyId, limit: 2 });
    expect(first.outcomes).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await enrollLegacyAgentsWithDefaultMcp(db, { companyId, limit: 2, afterId: first.nextCursor! });
    expect(second.outcomes).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const enrolledIds = [...first.outcomes, ...second.outcomes].map((o) => o.agentId).sort();
    expect(enrolledIds).toEqual([...legacyIds].sort());
  });

  it("two overlapping batches racing the same agent enroll it exactly once", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    enableFeature();

    const [first, second] = await Promise.all([
      enrollLegacyAgentsWithDefaultMcp(db, { companyId }),
      enrollLegacyAgentsWithDefaultMcp(db, { companyId }),
    ]);

    const enrolledOutcomes = [...first.outcomes, ...second.outcomes].filter((o) => o.result === "enrolled");
    expect(enrolledOutcomes).toHaveLength(1);
    expect(enrolledOutcomes[0]!.agentId).toBe(legacy.id);
  });

  // ---- owner attribution (post-merge review HIGH2) -----------------------------------------

  it("attributes an enrolled agent to its actual creator, not an arbitrary company owner", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId, "owner@redesignhealth.com");
    const creatorId = await seedMember(companyId, { email: "creator@redesignhealth.com", role: "member" });
    expect(creatorId).not.toBe(ownerId);
    const legacy = await createLegacyAgent(companyId, creatorId);
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["comms-board"]!.ownerUserId).toBe(creatorId);
  });

  it("reports owner_required for an agent with no recorded creator, even when the company has an owner -- never substitutes the company owner", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, null); // no agent.created/hire_created/approved evidence
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  it("falls back to the earliest agent.approved human actor when creation had no human actor", async () => {
    const companyId = await seedCompany();
    const approverId = await seedMember(companyId, { email: "approver@redesignhealth.com" });
    const legacy = await createLegacyAgent(companyId, null); // created by an agent/system, no human actor
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: approverId, action: "agent.approved", entityType: "agent", entityId: legacy.id });
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["comms-board"]!.ownerUserId).toBe(approverId);
  });

  it("reports owner_required when the recorded creator is no longer an active company member", async () => {
    const companyId = await seedCompany();
    const formerMemberId = await seedMember(companyId);
    const legacy = await createLegacyAgent(companyId, formerMemberId);
    await db.update(companyMemberships).set({ status: "removed" }).where(eq(companyMemberships.principalId, formerMemberId));
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
  });

  // ---- access preservation (post-merge review HIGH1) ---------------------------------------

  it("preserves a legacy agent's company-wide-install access as an explicit agent install after enrollment", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const google = await seedConnection(companyId, "rh-google-mcp");
    await grantInstall(companyId, google.id, { targetType: "company", targetId: companyId });

    // Baseline: before enrollment, the agent has no defaultMcp state, so the company install already
    // grants it effective access (this is the exact compatibility behavior the regression would break).
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual(["rh-google-mcp"]);

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    // After enrollment the agent is snapshot-managed; access must still resolve to the same connection,
    // now via an explicit per-agent install rather than the company-wide one.
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual(["rh-google-mcp"]);
    const agentInstalls = await db
      .select()
      .from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, google.id));
    expect(agentInstalls.some((row) => row.targetType === "agent" && row.targetId === legacy.id)).toBe(true);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["rh-google-mcp"]!.enabled).toBe(true);
  });

  it("preserves a legacy agent's own prior explicit install the same way (idempotent, not duplicated)", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const google = await seedConnection(companyId, "rh-google-mcp");
    await grantInstall(companyId, google.id, { targetType: "agent", targetId: legacy.id });

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual(["rh-google-mcp"]);
    const agentInstalls = await db
      .select()
      .from(toolConnectionInstalls)
      .where(and(eq(toolConnectionInstalls.connectionId, google.id), eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, legacy.id)));
    expect(agentInstalls).toHaveLength(1); // no duplicate row from the preservation path
  });

  it("a legacy agent with no prior install is unaffected: still OFF after enrollment", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    await seedConnection(companyId, "rh-google-mcp"); // exists, but nothing installed it

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual([]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["rh-google-mcp"]!.enabled).toBe(false);
  });

  it("reports legacy_access_conflict and leaves the agent unchanged when an existing install can't be safely preserved", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    // Two active connections share the entry's name -- ambiguous, same reason snapshotDefaultMcpForNewAgent
    // itself treats this as "no valid template" for a brand-new agent.
    const first = await seedConnection(companyId, "rh-google-mcp");
    await seedConnection(companyId, "rh-google-mcp");
    await grantInstall(companyId, first.id, { targetType: "agent", targetId: legacy.id });

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "legacy_access_conflict" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  it("a dry-run census reports legacy_access_conflict too, with zero writes", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const first = await seedConnection(companyId, "rh-google-mcp");
    await seedConnection(companyId, "rh-google-mcp");
    await grantInstall(companyId, first.id, { targetType: "agent", targetId: legacy.id });
    enableFeature();

    const report = await censusLegacyAgentsPendingDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "legacy_access_conflict" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  it("falls back to approved hire_agent record in approvals table when no activityLog exists", async () => {
    const companyId = await seedCompany();
    const approverId = await seedMember(companyId, { email: "hireapprover@redesignhealth.com" });
    const legacy = await createLegacyAgent(companyId, null);
    await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      status: "approved",
      payload: { agentId: legacy.id },
      decidedByUserId: approverId,
      decidedAt: new Date(),
    });
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["comms-board"]!.ownerUserId).toBe(approverId);
  });

  it("reports owner_required when the creator email is not verified", async () => {
    const companyId = await seedCompany();
    const unverifiedCreatorId = await seedMember(companyId, { verified: false });
    const legacy = await createLegacyAgent(companyId, unverifiedCreatorId);
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
  });

  it("reports owner_required when creation actor is the board sentinel", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, null);
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board",
      action: "agent.created",
      entityType: "agent",
      entityId: legacy.id,
    });
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
  });

  it("reports legacy_access_conflict and leaves agent unchanged when an existing comms install exists", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const commsConn = await seedConnection(companyId, "rh-comms-board");
    await grantInstall(companyId, commsConn.id, { targetType: "company", targetId: companyId });

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "legacy_access_conflict" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  it("reports legacy_access_conflict when an active comms connection grant exists for the agent", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const commsConn = await seedConnection(companyId, "rh-comms-board");
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: commsConn.id,
      kind: "agent",
      subjectAgentId: legacy.id,
      status: "active",
    });

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "legacy_access_conflict" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  it("reports legacy_access_conflict when an installed personal-rh-mcp fails template requirements", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    // rh-mcp-personal requires identityModel: "personal_only" in config; seed one without it
    const invalidPersonal = await seedConnection(companyId, "rh-mcp-personal");
    await grantInstall(companyId, invalidPersonal.id, { targetType: "agent", targetId: legacy.id });

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "legacy_access_conflict" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  it("dry-run census has exact parity with live outcomes across mixed agent states", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);

    // Agent 1: valid, would enroll
    const a1 = await createLegacyAgent(companyId, ownerId);
    // Agent 2: no owner evidence, owner_required
    const a2 = await createLegacyAgent(companyId, null);
    // Agent 3: ambiguous install, legacy_access_conflict
    const a3 = await createLegacyAgent(companyId, ownerId);
    const g1 = await seedConnection(companyId, "rh-google-mcp");
    await seedConnection(companyId, "rh-google-mcp");
    await grantInstall(companyId, g1.id, { targetType: "agent", targetId: a3.id });

    enableFeature();

    const byAgentId = (a: { agentId: string }, b: { agentId: string }) => a.agentId.localeCompare(b.agentId);
    const census = await censusLegacyAgentsPendingDefaultMcp(db, { companyId });
    expect(census.outcomes.slice().sort(byAgentId)).toEqual([
      { agentId: a1.id, companyId, result: "would_enroll" },
      { agentId: a2.id, companyId, result: "skipped", reason: "owner_required" },
      { agentId: a3.id, companyId, result: "skipped", reason: "legacy_access_conflict" },
    ].sort(byAgentId));
    // Census did 0 writes
    expect(readDefaultMcpState((await rowOf(a1.id)).metadata)).toBeNull();
    expect(readDefaultMcpState((await rowOf(a2.id)).metadata)).toBeNull();
    expect(readDefaultMcpState((await rowOf(a3.id)).metadata)).toBeNull();

    // Live run produces matching outcomes
    const live = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    expect(live.outcomes.slice().sort(byAgentId)).toEqual([
      { agentId: a1.id, companyId, result: "enrolled" },
      { agentId: a2.id, companyId, result: "skipped", reason: "owner_required" },
      { agentId: a3.id, companyId, result: "skipped", reason: "legacy_access_conflict" },
    ].sort(byAgentId));
  });

  it("preserves existing OAuth user grants untouched after enrollment", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const google = await seedConnection(companyId, "rh-google-mcp");
    await grantInstall(companyId, google.id, { targetType: "agent", targetId: legacy.id });

    // Seed a user-scoped grant on the connection
    const grant = await db.insert(connectionGrants).values({
      companyId,
      connectionId: google.id,
      kind: "user",
      subjectUserId: ownerId,
      status: "active",
    }).returning().then((r) => r[0]!);

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    const [persistedGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
    expect(persistedGrant?.status).toBe("active");
    expect(persistedGrant?.subjectUserId).toBe(ownerId);
  });

  it("brand new agents created with default MCP feature enabled still start with all entries OFF", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    enableFeature();

    const created = await createAgent(companyId, ownerId);
    const state = readDefaultMcpState((await rowOf(created.id)).metadata);
    expect(state).not.toBeNull();
    expect(state!.entries["rh-google-mcp"]!.enabled).toBe(false);
    expect(state!.entries["personal-rh-mcp"] ?? state!.entries["rh-mcp"]?.enabled ?? false).toBe(false);
    expect(state!.entries["comms-board"]!.enabled).toBe(false);
  });

  it("LegacyPreserveUnsatisfiedError rolls back transaction and schedules zero setups", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    enableFeature();

    // Remove the creator's active membership right before enrollment
    await db.update(companyMemberships).set({ status: "removed" }).where(eq(companyMemberships.principalId, ownerId));

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  // ---- post-B adversarial regressions (TECH-7339 follow-up self-check) ------------------------
  //
  // Four seams the B fix touched, pinned to the behavior the enrollment plan documents:
  // (1) preservation keys on the PRESENCE of an install row (a user grant), never on other
  //     runtime state -- a connection_grants row alone installs nothing for an ordinary entry
  //     (DEFAULT-MCP-SPEC.md: "a company-wide install, a company profile, or an organization
  //     grant does not turn it on"), so it must neither carry an entry ON nor be revoked;
  // (2) a template that stops being usable BETWEEN the row-locked access assessment and
  //     snapshotDefaultMcpForNewAgent's own template lookup must be a typed
  //     LegacyPreserveUnsatisfiedError rollback -- never a silently-written OFF snapshot and
  //     never the old install grafted onto a different replacement connection;
  // (3) attribution evidence that disagrees between the activity log and the approvals table
  //     fails safe to owner_required rather than arbitrarily preferring one source;
  // (4) invalid UUID inputs reject closed at both the service and HTTP boundaries, zero writes.

  const agentTargetedInstallCount = async (companyId: string) =>
    (
      await db
        .select({ id: toolConnectionInstalls.id })
        .from(toolConnectionInstalls)
        .where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.targetType, "agent")))
    ).length;

  const appProfileCount = async (companyId: string) =>
    (await db.select({ id: toolProfiles.id }).from(toolProfiles).where(eq(toolProfiles.companyId, companyId))).length;

  /**
   * Repo-convention race harness (the same Proxy-around-`transaction` pattern as
   * heartbeat-task-drain-admission-release.test.ts): wraps `db` so that the Nth
   * `select ... from tool_connections` statement executed INSIDE the enrollment transaction
   * first awaits `inject()` on the independent pool, simulating a concurrent commit landing in
   * the window between the row-locked `assessLegacyAccess` re-read and
   * `snapshotDefaultMcpForNewAgent`'s own template lookup. The injection fires exactly once,
   * on the statement's first await; `stats().injected === false` after a run means the ordinal
   * no longer matches the query shape, and the test must fail rather than pass vacuously.
   */
  function withInjectedRace(
    ordinal: number,
    inject: () => Promise<void>,
  ): { db: ReturnType<typeof createDb>; stats: () => { toolConnectionsSelects: number; injected: boolean } } {
    let toolConnectionsSelects = 0;
    let injected = false;
    const fireOnce = async () => {
      if (!injected) {
        injected = true;
        await inject();
      }
    };
    const proxyGet =
      (extra: (target: Record<string, unknown>, prop: string | symbol) => unknown) =>
      (target: Record<string, unknown>, prop: string | symbol): unknown => {
        const overridden = extra(target, prop);
        if (overridden !== undefined) return overridden;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      };
    const wrapBuilder = (builder: object): object =>
      new Proxy(builder, {
        get(target: Record<string, unknown>, prop: string | symbol) {
          if (prop === "then") {
            const realThen = Reflect.get(target, "then", target) as (...a: unknown[]) => Promise<unknown>;
            return (onFulfilled: unknown, onRejected: unknown) =>
              fireOnce().then(() => realThen.call(target, onFulfilled, onRejected));
          }
          const value = Reflect.get(target, prop, target);
          if (typeof value !== "function") return value;
          const bound = (value as (...a: unknown[]) => unknown).bind(target);
          return (...args: unknown[]) => {
            const result = bound(...args);
            // Keep the chain wrapped (`.where()`/`.limit()` return the builder itself), so the
            // statement's first await lands on the hooked `then`.
            return result && typeof result === "object" && !(result instanceof Promise) ? wrapBuilder(result) : result;
          };
        },
      });
    const instrumentSelect =
      (realSelect: (...a: unknown[]) => Record<string, unknown>) =>
      (...selectArgs: unknown[]): Record<string, unknown> => {
        const builder = realSelect(...selectArgs);
        const realFrom = builder.from as ((...a: unknown[]) => unknown) | undefined;
        if (typeof realFrom !== "function") return builder;
        return new Proxy(builder, {
          get: proxyGet((target: Record<string, unknown>, prop: string | symbol) => {
            if (prop !== "from") return undefined;
            return (table: unknown) => {
              const chained = realFrom.call(builder, table);
              if (table === toolConnections && ++toolConnectionsSelects === ordinal) return wrapBuilder(chained as object);
              return chained;
            };
          }) as unknown as (target: object, prop: string | symbol) => unknown,
        }) as unknown as Record<string, unknown>;
      };
    const instrumentTx = (tx: object): object =>
      new Proxy(tx, {
        get: proxyGet((target: Record<string, unknown>, prop: string | symbol) => {
          if (prop !== "select") return undefined;
          const realSelect = Reflect.get(target, "select", target) as (...a: unknown[]) => Record<string, unknown>;
          return instrumentSelect(realSelect.bind(target) as (...a: unknown[]) => Record<string, unknown>);
        }) as unknown as (target: object, prop: string | symbol) => unknown,
      });
    const racedDb = new Proxy(db, {
      get: proxyGet((target: Record<string, unknown>, prop: string | symbol) => {
        if (prop !== "transaction") return undefined;
        const realTransaction = Reflect.get(target, "transaction", target) as (
          cb: (tx: unknown) => Promise<unknown>,
          ...rest: unknown[]
        ) => Promise<unknown>;
        return (cb: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          realTransaction.call(target, (tx: unknown) => cb(instrumentTx(tx as object)), ...rest);
      }) as unknown as (target: object, prop: string | symbol) => unknown,
    }) as unknown as ReturnType<typeof createDb>;
    return { db: racedDb, stats: () => ({ toolConnectionsSelects, injected }) };
  }

  /**
   * In-enrollment-transaction tool_connections selects, in order: one per spec entry in
   * `assessLegacyAccess` (dedicated loop, then ordinary loop, spec order), then one per spec
   * entry in `snapshotDefaultMcpForNewAgent` (spec order). Derived from the spec so a spec or
   * query-shape change flips the `injected` guard instead of silently shifting the race window.
   */
  const assessGoogleLookupOrdinal = DEFAULT_MCP_SPEC.findIndex((e) => e.key === "rh-google-mcp") + 1;
  const snapshotGoogleLookupOrdinal = DEFAULT_MCP_SPEC.length + assessGoogleLookupOrdinal;

  async function seedRaceFixture() {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const oldGoogle = await seedConnection(companyId, "rh-google-mcp");
    await grantInstall(companyId, oldGoogle.id, { targetType: "company", targetId: companyId });
    // Real BEFORE proof (the effective-install projection a legacy agent actually gets, not raw
    // row counting): the company-wide install on the ordinary entry is effective access today.
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual(["rh-google-mcp"]);
    return { companyId, ownerId, legacy, oldGoogle };
  }

  const archiveConnection = (connectionId: string) =>
    raceDb.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, connectionId));
  const activateConnection = (connectionId: string) =>
    raceDb.update(toolConnections).set({ status: "active" }).where(eq(toolConnections.id, connectionId));

  // -- seam 1: preservation keys on install rows, never on grant rows alone --------------------

  it("an active agent-kind connection grant with no install row never turns an ordinary entry ON (OFF before, OFF after)", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const google = await seedConnection(companyId, "rh-google-mcp");
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: google.id,
      kind: "agent",
      subjectAgentId: legacy.id,
      status: "active",
    });

    // BEFORE (real runtime proof, not rows): the effective-install projection ignores a lone
    // grant row -- a legacy agent with no install rows and no company install has access OFF.
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual([]);

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    // AFTER: still OFF. The user uninstalled this entry (or never installed it); enrollment
    // must not manufacture access no install row ever granted. A grant row is inert for an
    // ordinary entry and must never be carried forward as an install.
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual([]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["rh-google-mcp"]!.enabled).toBe(false);
    const agentInstalls = await db
      .select({ id: toolConnectionInstalls.id })
      .from(toolConnectionInstalls)
      .where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.targetType, "agent")));
    expect(agentInstalls).toEqual([]);
  });

  it("a revoked agent-kind grant is inert: no comms conflict, nothing preserved, nothing forced ON", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const comms = await seedConnection(companyId, "rh-comms-board");
    const google = await seedConnection(companyId, "rh-google-mcp");
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: comms.id,
      kind: "agent",
      subjectAgentId: legacy.id,
      status: "revoked",
      revokedAt: new Date(),
    });
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: google.id,
      kind: "agent",
      subjectAgentId: legacy.id,
      status: "revoked",
      revokedAt: new Date(),
    });

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    // Only an ACTIVE comms grant conservatively stops enrollment; a revoked one must not.
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual([]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["rh-google-mcp"]!.enabled).toBe(false);
    expect(await agentTargetedInstallCount(companyId)).toBe(0);
  });

  it("an active user-kind OAuth grant row alone neither preserves ON nor is disturbed by enrollment", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    const google = await seedConnection(companyId, "rh-google-mcp");
    const grant = await db
      .insert(connectionGrants)
      .values({ companyId, connectionId: google.id, kind: "user", subjectUserId: ownerId, status: "active" })
      .returning()
      .then((rows) => rows[0]!);

    expect(await installedConnectionNames(companyId, legacy.id)).toEqual([]);

    enableFeature();
    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    // A user-scoped OAuth grant is the owner's own consent, not agent access: it neither turns
    // the entry ON for the agent nor gets revoked/rewritten by enrollment.
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual([]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["rh-google-mcp"]!.enabled).toBe(false);
    const [persisted] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
    expect(persisted?.status).toBe("active");
    expect(persisted?.subjectUserId).toBe(ownerId);
    expect(persisted?.revokedAt).toBeNull();
  });

  // -- seam 2: template drift between the locked assessment and the snapshot -------------------

  it("race control: nothing changing between the locked assessment and the snapshot still preserves ON (harness inert)", async () => {
    const { companyId, legacy, oldGoogle } = await seedRaceFixture();
    enableFeature();
    const race = withInjectedRace(snapshotGoogleLookupOrdinal, async () => {});

    const report = await enrollLegacyAgentsWithDefaultMcp(race.db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    // The harness itself must be inert: same fixture as the plain company-install preservation
    // test, same ON outcome. `injected` true also proves the ordinal lands on a real awaited
    // tool_connections select, so the failing variants below are races, not harness artifacts.
    expect(race.stats().injected).toBe(true);
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    expect(await installedConnectionNames(companyId, legacy.id)).toEqual(["rh-google-mcp"]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["rh-google-mcp"]!.enabled).toBe(true);
    expect(state!.entries["rh-google-mcp"]!.templateConnectionId).toBe(oldGoogle.id);
  });

  it("a template turning ambiguous between the locked assessment and the snapshot is a typed rollback, not a silent OFF enroll", async () => {
    const { companyId, legacy } = await seedRaceFixture();
    const second = await seedConnection(companyId, "rh-google-mcp", { status: "archived" }); // invisible until the race
    enableFeature();
    const race = withInjectedRace(snapshotGoogleLookupOrdinal, async () => {
      await activateConnection(second.id);
    });

    const report = await enrollLegacyAgentsWithDefaultMcp(race.db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    // The locked assessment promised preservation ON (one valid template + install); by the
    // snapshot's own lookup there are two same-name candidates. Silently writing an OFF
    // snapshot is exactly the silent-revocation class this feature exists to prevent: the
    // whole agent must roll back (LegacyPreserveUnsatisfiedError), reported as a conflict,
    // with zero preservation writes.
    expect(race.stats().injected).toBe(true);
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "legacy_access_conflict" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
    expect(await agentTargetedInstallCount(companyId)).toBe(0);
    expect(await appProfileCount(companyId)).toBe(0);
  });

  it("the valid connection archived between the locked assessment and the snapshot is a typed rollback, not a silent OFF enroll", async () => {
    const { companyId, legacy, oldGoogle } = await seedRaceFixture();
    enableFeature();
    const race = withInjectedRace(snapshotGoogleLookupOrdinal, async () => {
      await archiveConnection(oldGoogle.id);
    });

    const report = await enrollLegacyAgentsWithDefaultMcp(race.db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(race.stats().injected).toBe(true);
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "legacy_access_conflict" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
    expect(await agentTargetedInstallCount(companyId)).toBe(0);
    expect(await appProfileCount(companyId)).toBe(0);
  });

  it("the old connection replaced by a different same-name connection mid-snapshot must not graft the old install onto the new connection", async () => {
    const { companyId, legacy, oldGoogle } = await seedRaceFixture();
    const replacement = await seedConnection(companyId, "rh-google-mcp", { status: "archived" });
    enableFeature();
    const race = withInjectedRace(snapshotGoogleLookupOrdinal, async () => {
      await archiveConnection(oldGoogle.id);
      await activateConnection(replacement.id);
    });

    const report = await enrollLegacyAgentsWithDefaultMcp(race.db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    // The user's install row lives on the OLD connection; the replacement never received it.
    // Preserving ON would manufacture a brand-new user grant on a connection the user never
    // installed -- and would pin the snapshot's templateConnectionId to an ID the locked
    // assessment never saw. Whole-agent rollback with zero writes instead.
    expect(race.stats().injected).toBe(true);
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "legacy_access_conflict" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
    expect(await agentTargetedInstallCount(companyId)).toBe(0);
    expect(await appProfileCount(companyId)).toBe(0);
    // The replacement connection itself is untouched: no install, no profile.
    const replacementInstalls = await db
      .select({ id: toolConnectionInstalls.id })
      .from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, replacement.id));
    expect(replacementInstalls).toEqual([]);
  });

  it("race control: the same ambiguity landing before the locked re-assessment is already a typed rollback (the handled gap)", async () => {
    const { companyId, legacy } = await seedRaceFixture();
    const second = await seedConnection(companyId, "rh-google-mcp", { status: "archived" });
    enableFeature();
    const race = withInjectedRace(assessGoogleLookupOrdinal, async () => {
      await activateConnection(second.id);
    });

    const report = await enrollLegacyAgentsWithDefaultMcp(race.db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    // Contrast control for the two variants above: drift landing BEFORE the in-transaction
    // re-assessment is already caught by it (conflict -> LegacyPreserveUnsatisfiedError ->
    // rollback), proving the unhandled window is specifically assessment -> snapshot lookup.
    expect(race.stats().injected).toBe(true);
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "legacy_access_conflict" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
    expect(await agentTargetedInstallCount(companyId)).toBe(0);
  });

  // -- seam 3: attribution evidence that disagrees fails safe -----------------------------------

  it("mismatched approver evidence (activity log vs approvals table) fails safe: owner_required, never an arbitrary pick", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const activityApproverId = await seedMember(companyId, { email: "activity-approver@redesignhealth.com", role: "member" });
    const tableApproverId = await seedMember(companyId, { email: "table-approver@redesignhealth.com", role: "admin" });
    expect(activityApproverId).not.toBe(tableApproverId);
    const legacy = await createLegacyAgent(companyId, null);
    // Both sources record an approval of THIS agent, naming DIFFERENT validated humans. A
    // single approve action writes both sources with the same decider (the route logs
    // agent.approved with the same actor it passes to approvalsSvc.approve), so disagreement
    // is conflicting evidence, not chronological supersession -- and either arbitrary pick
    // (earliest activity vs latest table row) could attribute the credential to the wrong human.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: activityApproverId,
      action: "agent.approved",
      entityType: "agent",
      entityId: legacy.id,
    });
    await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      status: "approved",
      payload: { agentId: legacy.id },
      decidedByUserId: tableApproverId,
      decidedAt: new Date(),
    });
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  it("agreeing dual evidence (activity log and approvals table naming the same user) enrolls with that user", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const approverId = await seedMember(companyId, { email: "agreeing-approver@redesignhealth.com", role: "member" });
    const legacy = await createLegacyAgent(companyId, null);
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: approverId,
      action: "agent.approved",
      entityType: "agent",
      entityId: legacy.id,
    });
    await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      status: "approved",
      payload: { agentId: legacy.id },
      decidedByUserId: approverId,
      decidedAt: new Date(),
    });
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    // The legitimate dual record (one approve action written to both sources) must not be
    // mistaken for a conflict: same decider on both sources is agreeing evidence.
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["comms-board"]!.ownerUserId).toBe(approverId);
  });

  it("an inactive activity-log approver stays owner_required even when the approvals table names a valid approver (never substituted)", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const staleApproverId = await seedMember(companyId, { email: "stale-approver@redesignhealth.com" });
    const validApproverId = await seedMember(companyId, { email: "valid-approver@redesignhealth.com", role: "admin" });
    const legacy = await createLegacyAgent(companyId, null);
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: staleApproverId,
      action: "agent.approved",
      entityType: "agent",
      entityId: legacy.id,
    });
    await db.insert(approvals).values({
      companyId,
      type: "hire_agent",
      status: "approved",
      payload: { agentId: legacy.id },
      decidedByUserId: validApproverId,
      decidedAt: new Date(),
    });
    await db.update(companyMemberships).set({ status: "removed" }).where(eq(companyMemberships.principalId, staleApproverId));
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });

    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  it("a hire_agent approval row from another company is not attribution evidence for this company's agent", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const otherAdminId = await seedMember(otherCompanyId, { email: "other-admin@redesignhealth.com", role: "admin" });
    const legacy = await createLegacyAgent(companyId, null);
    await db.insert(approvals).values({
      companyId: otherCompanyId,
      type: "hire_agent",
      status: "approved",
      payload: { agentId: legacy.id }, // names THIS company's agent, but lives in the other tenant
      decidedByUserId: otherAdminId,
      decidedAt: new Date(),
    });
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    expect(report.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "skipped", reason: "owner_required" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();

    // With same-company evidence present the foreign row stays inert: the local activity log
    // stands on its own and the other tenant's record never overrides or vouches for it.
    const approverId = await seedMember(companyId, { email: "local-approver@redesignhealth.com" });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: approverId,
      action: "agent.approved",
      entityType: "agent",
      entityId: legacy.id,
    });
    const second = await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();
    expect(second.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled" }]);
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata);
    expect(state!.entries["comms-board"]!.ownerUserId).toBe(approverId);
  });

  // -- seam 4: invalid UUID inputs reject closed at the boundaries ------------------------------

  it("invalid UUID options reject at the service boundary with zero writes", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    enableFeature();

    // A non-UUID companyId/afterId must reject closed (the SQL comparison cannot match
    // anything sensible), never scan-and-write on some coerced boundary, and never leave a
    // partially-enrolled agent behind.
    await expect(enrollLegacyAgentsWithDefaultMcp(db, { companyId: "not-a-uuid" })).rejects.toThrow();
    await expect(enrollLegacyAgentsWithDefaultMcp(db, { afterId: "not-a-uuid" })).rejects.toThrow();
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
    expect(await agentTargetedInstallCount(companyId)).toBe(0);
  });
});
