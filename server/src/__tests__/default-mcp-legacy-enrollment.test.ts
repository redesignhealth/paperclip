import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  routines,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
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
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import { sweepDefaultMcpSetups, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { backfillArcanaBrains } from "../services/arcana-brain-backfill.js";
import { toolAccessService } from "../services/tool-access.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { sweepAgentProfileRoutines } from "../services/default-agent-profile-routine.js";
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
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-legacy-enrollment-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-legacy-enrollment");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
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

  async function seedConnection(companyId: string, name: string, opts: { status?: "active" | "draft" } = {}) {
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

  function apiAs(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return request(app);
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
    expect(state!.entries["arcana-brain"]).toBeDefined();
  });

  it.each(["comms-only-enrollment", "comms-only-enrollment/", "COMMS-ONLY-ENROLLMENT"])("enrolls only the selected agent without a brain or memory routine through %s", async (route) => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const selected = await createLegacyAgent(companyId, ownerId);
    const other = await createLegacyAgent(companyId, ownerId);
    const google = await seedConnection(companyId, "rh-google-mcp");
    await grantInstall(companyId, google.id, { targetType: "company", targetId: companyId });
    const otherBefore = (await rowOf(other.id)).metadata;
    enableFeature();

    const api = apiAs({ type: "board", userId: ownerId, source: "local_implicit" });
    const endpoint = `/api/companies/${companyId}/default-mcp/${route}`;
    const dryResponse = await api.post(endpoint).send({ agentId: selected.id, dryRun: true }).expect(200);
    const dry = dryResponse.body;
    expect(dry.outcomes).toEqual([{ agentId: selected.id, companyId, result: "would_enroll" }]);
    expect(dry.nextCursor).toBeNull();
    expect(readDefaultMcpState((await rowOf(selected.id)).metadata)).toBeNull();

    const response = await api.post(endpoint).send({ agentId: selected.id }).expect(200);
    const report = response.body;
    await waitForScheduledDefaultMcpSetups();
    expect(report.outcomes).toEqual([{ agentId: selected.id, companyId, result: "enrolled" }]);
    const state = readDefaultMcpState((await rowOf(selected.id)).metadata)!;
    expect(state.entries["comms-board"]!.ownerUserId).toBe(ownerId);
    expect(state.entries["arcana-brain"]).toMatchObject({
      enabled: false, connectionId: null, binding: null,
      setup: { state: "not_required", reason: "operator_excluded", registerAttemptedAt: null, mintAttemptedAt: null },
    });
    expect(await installedConnectionNames(companyId, selected.id)).toEqual(["rh-google-mcp"]);
    expect((await rowOf(other.id)).metadata).toEqual(otherBefore);

    // Even once comms is ready, the daily private-brain routine must stay absent.
    state.entries["comms-board"]!.setup.state = "ready";
    await db.update(agents).set({ metadata: { defaultMcp: state } }).where(eq(agents.id, selected.id));
    const result = await sweepAgentProfileRoutines(db, {
      env: { [FEATURE_ENV]: "true", PAPERCLIP_DEFAULT_AGENT_PROFILE_ROUTINE_ENABLED: "true" },
    });
    expect(result.created).toBe(0);
    expect(await db.select().from(routines).where(eq(routines.companyId, companyId))).toEqual([]);
    expect(await sweepDefaultMcpSetups({ db, env: { [FEATURE_ENV]: "true" }, templateScope: { mode: "allowlist", companyIds: [companyId] } })).toBe(0);
    const backfill = await backfillArcanaBrains(db, { companyId, dryRun: true });
    expect(backfill.outcomes.find((outcome) => outcome.agentId === selected.id)).toMatchObject({ result: "skipped", reason: "operator_excluded" });

    const repeat = await enrollLegacyAgentsWithDefaultMcp(db, { companyId, agentId: selected.id, limit: 1 });
    expect(repeat.outcomes).toEqual([{ agentId: selected.id, companyId, result: "skipped", reason: "already_enrolled" }]);
    expect(repeat.nextCursor).toBeNull();
    expect(readDefaultMcpState((await rowOf(selected.id)).metadata)!.entries["arcana-brain"]!.setup.reason).toBe("operator_excluded");
  });

  it("leaves an already-enrolled agent and its existing brain intact through HTTP", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const selected = await createLegacyAgent(companyId, ownerId);
    enableFeature();
    await enrollLegacyAgentsWithDefaultMcp(db, { companyId });
    await waitForScheduledDefaultMcpSetups();
    const before = (await rowOf(selected.id)).metadata;
    expect(readDefaultMcpState(before)!.entries["arcana-brain"]).toBeDefined();
    const result = await apiAs({ type: "board", userId: ownerId, source: "local_implicit" })
      .post(`/api/companies/${companyId}/default-mcp/comms-only-enrollment`).send({ agentId: selected.id }).expect(200);
    expect(result.body.outcomes).toEqual([{ agentId: selected.id, companyId, result: "skipped", reason: "already_enrolled" }]);
    expect((await rowOf(selected.id)).metadata).toEqual(before);
  });

  it.each(["terminated", "out_of_scope"])("skips targeted comms-only enrollment for %s", async (condition) => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const selected = await createLegacyAgent(companyId, ownerId);
    enableFeature();
    if (condition === "terminated") {
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, selected.id));
    } else {
      const inScope = await seedCompany();
      __resetDefaultMcpTemplateScopeForTests();
      captureDefaultMcpTemplateScope({ PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS: inScope });
    }
    const result = await apiAs({ type: "board", userId: ownerId, source: "local_implicit" })
      .post(`/api/companies/${companyId}/default-mcp/comms-only-enrollment`).send({ agentId: selected.id }).expect(200);
    expect(result.body.outcomes).toEqual([{ agentId: selected.id, companyId, result: "skipped", reason: condition === "terminated" ? "agent_terminated" : "company_out_of_scope" }]);
    expect(readDefaultMcpState((await rowOf(selected.id)).metadata)).toBeNull();
  });

  it.each([[], ["bad"], "bad", 1, null])("rejects non-object enrollment bodies: %j", async (body) => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const selected = await createLegacyAgent(companyId, ownerId);
    enableFeature();
    await apiAs({ type: "board", userId: ownerId, source: "local_implicit" })
      .post(`/api/companies/${companyId}/default-mcp/comms-only-enrollment`)
      .set("Content-Type", "application/json").send(JSON.stringify(body)).expect(400);
    expect(readDefaultMcpState((await rowOf(selected.id)).metadata)).toBeNull();
  });

  it("does not enroll an agent selected from another company", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const selected = await createLegacyAgent(companyId, ownerId);
    const otherCompanyId = await seedCompany();
    enableFeature();

    const report = await enrollLegacyAgentsWithDefaultMcp(db, { companyId: otherCompanyId, agentId: selected.id, commsOnly: true });
    expect(report).toEqual({ scanned: 0, outcomes: [], nextCursor: null });
    expect(readDefaultMcpState((await rowOf(selected.id)).metadata)).toBeNull();
  });

  it.each([
    ["comms-only-enrollment", {}],
    ["comms-only-enrollment/", {}],
    ["COMMS-ONLY-ENROLLMENT", {}],
    ["comms-only-enrollment", { agentId: "not-a-uuid" }],
  ])("requires an explicit valid target through %s: %j", async (route, body) => {
    const companyId = await seedCompany();
    await apiAs({ type: "board", userId: "local-board", source: "local_implicit" })
      .post(`/api/companies/${companyId}/default-mcp/${route}`).send(body).expect(400);
  });

  it("rejects agent callers from the comms-only administrative route", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, ownerId);
    enableFeature();
    await apiAs({ type: "agent", companyId, agentId: legacy.id, source: "agent_jwt" })
      .post(`/api/companies/${companyId}/default-mcp/comms-only-enrollment`)
      .send({ agentId: legacy.id }).expect(403);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
  });

  it.each([{ limit: 1 }, { afterId: randomUUID() }])("rejects pagination on comms-only requests: %j", async (pagination) => {
    const companyId = await seedCompany();
    await apiAs({ type: "board", userId: "local-board", source: "local_implicit" })
      .post(`/api/companies/${companyId}/default-mcp/comms-only-enrollment`)
      .send({ agentId: randomUUID(), ...pagination }).expect(400);
  });

  it("rejects a restrictive target option on the legacy HTTP route", async () => {
    const companyId = await seedCompany();
    await apiAs({ type: "board", userId: "local-board", source: "local_implicit" })
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ agentId: randomUUID() }).expect(400);
  });

  it("initializes an unowned comms-only entry for the existing verified-caller ownership flow", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const legacy = await createLegacyAgent(companyId, null);
    enableFeature();
    const api = apiAs({ type: "board", userId: ownerId, source: "local_implicit" });
    const path = `/api/companies/${companyId}/default-mcp/comms-only-enrollment`;

    const dry = await api.post(path).send({ agentId: legacy.id, dryRun: true }).expect(200);
    expect(dry.body.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "would_enroll", ownerAssignmentRequired: true }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)).toBeNull();
    const result = await api.post(path).send({ agentId: legacy.id }).expect(200);
    expect(result.body.outcomes).toEqual([{ agentId: legacy.id, companyId, result: "enrolled", ownerAssignmentRequired: true }]);
    await waitForScheduledDefaultMcpSetups();
    const state = readDefaultMcpState((await rowOf(legacy.id)).metadata)!;
    expect(state.entries["comms-board"]).toMatchObject({ ownerUserId: null, connectionId: null, binding: null, setup: { state: "pending", reason: "owner_required", registerAttemptedAt: null, mintAttemptedAt: null } });
    expect(state.entries["arcana-brain"]!.setup).toMatchObject({ state: "not_required", reason: "operator_excluded" });

    const assignmentPath = `/api/companies/${companyId}/default-mcp/comms-owner-assignment`;
    const unverified = await seedMember(companyId, { verified: false });
    const denied = await apiAs({ type: "board", userId: unverified, source: "local_implicit" })
      .post(assignmentPath).send({ agentIds: [legacy.id], dryRun: false, confirm: "assign-comms-board-owner" }).expect(200);
    expect(denied.body.outcomes).toEqual([{ agentId: legacy.id, result: "owner_ineligible" }]);
    expect(readDefaultMcpState((await rowOf(legacy.id)).metadata)!.entries["comms-board"]!.ownerUserId).toBeNull();
    const assigned = await api.post(assignmentPath).send({ agentIds: [legacy.id], dryRun: false, confirm: "assign-comms-board-owner" }).expect(200);
    expect(assigned.body.outcomes).toEqual([{ agentId: legacy.id, result: "assigned" }]);
    const after = readDefaultMcpState((await rowOf(legacy.id)).metadata)!;
    expect(after.entries["comms-board"]!.ownerUserId).toBe(ownerId);
    expect(after.entries["arcana-brain"]!.setup.reason).toBe("operator_excluded");
    expect(after.entries["arcana-brain"]!.connectionId).toBeNull();
  });

  it("rejects an owner supplied in the comms-only request body", async () => {
    const companyId = await seedCompany();
    await apiAs({ type: "board", userId: "local-board", source: "local_implicit" })
      .post(`/api/companies/${companyId}/default-mcp/comms-only-enrollment`)
      .send({ agentId: randomUUID(), ownerUserId: "someone-else" }).expect(400);
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
});
