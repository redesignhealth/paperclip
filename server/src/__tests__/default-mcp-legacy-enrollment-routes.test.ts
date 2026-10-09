import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("POST /api/companies/:companyId/default-mcp/legacy-enrollment HTTP boundary", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `legacy-enrollment-routes-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("legacy-enrollment-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    process.env[FEATURE_ENV] = "true";
  });

  afterEach(async () => {
    delete process.env[FEATURE_ENV];
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Route Test Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
    });
    return companyId;
  }

  async function seedUser(companyId: string, role: "owner" | "admin" | "member" = "owner") {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Test User",
      email: `${userId}@redesignhealth.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
    return userId;
  }

  // --- HTTP 400 Bad Request validation tests ---

  it("returns 400 when companyId is not a valid UUID", async () => {
    const app = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-user",
    });

    const res = await request(app)
      .post("/api/companies/not-a-uuid/default-mcp/legacy-enrollment")
      .send({ dryRun: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UUID/i);
  });

  it("returns 400 when afterId is not a valid UUID", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser(companyId, "owner");
    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ afterId: "invalid-uuid" });

    expect(res.status).toBe(400);
  });

  it("returns the structured 400 for an invalid afterId BEFORE any enrollment write (source unchanged)", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser(companyId, "owner");
    // A legacy agent whose creator evidence is intact, so with a valid request this agent
    // WOULD be enrolled -- proving the 400 itself, not a lack of eligible targets, kept it
    // untouched.
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Agent",
      role: "general",
      adapterType: "process",
      status: "idle",
      metadata: null,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: userId,
      action: "agent.created",
      entityType: "agent",
      entityId: agentId,
    });
    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ afterId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    // Source unchanged: the rejected request never reached the service, so the would-be-enrolled
    // legacy agent still has no defaultMcp snapshot.
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(readDefaultMcpState(agentRow?.metadata)).toBeNull();
  });

  it("returns 400 when limit is out of bounds (< 1 or > 25)", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser(companyId, "owner");
    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    });

    const resZero = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ limit: 0 });
    expect(resZero.status).toBe(400);

    const resTooLarge = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ limit: 26 });
    expect(resTooLarge.status).toBe(400);

    const resFloat = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ limit: 2.5 });
    expect(resFloat.status).toBe(400);

    const resString = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ limit: "10" });
    expect(resString.status).toBe(400);
  });

  it("returns 400 when dryRun is not a boolean", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser(companyId, "owner");
    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: "true" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when unknown keys are present in request body (strict validation)", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser(companyId, "owner");
    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: true, extraKey: "not_allowed" });

    expect(res.status).toBe(400);
  });

  // --- HTTP 403 Forbidden authorization tests ---

  it("returns 403 when caller is an agent (machine key)", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    const app = createApp(db, {
      type: "agent",
      source: "agent_jwt",
      agentId,
      companyId,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: true });

    expect(res.status).toBe(403);
  });

  it("returns 403 when caller does not have access to the target company (cross-company)", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const userId = await seedUser(companyId, "owner");
    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId], // only companyId, not otherCompanyId
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/companies/${otherCompanyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: true });

    expect(res.status).toBe(403);
  });

  it("returns 403 when caller is a member without tools:manage_connections permission", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser(companyId, "member"); // role: member
    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/connection manager/i);
  });

  // --- HTTP 200 OK authorization and dry-run tests ---

  it("returns 200 for company owner and performs dry-run census with zero writes", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser(companyId, "owner");

    // Create a legacy agent in the company
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Agent",
      role: "general",
      adapterType: "process",
      status: "idle",
      metadata: null,
    });

    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("scanned", 1);
    expect(res.body).toHaveProperty("outcomes");
    expect(res.body).toHaveProperty("nextCursor", null);

    // Verify dry-run performed zero writes
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(readDefaultMcpState(agentRow?.metadata)).toBeNull();
  });

  it("returns 200 for company admin", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser(companyId, "admin");
    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
  });

  it("returns 200 for instance admin", async () => {
    const companyId = await seedCompany();
    const app = createApp(db, {
      type: "board",
      source: "session",
      userId: "admin-user",
      companyIds: [companyId],
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
  });

  it("returns 200 for local implicit board actor", async () => {
    const companyId = await seedCompany();
    const app = createApp(db, {
      type: "board",
      source: "local_implicit",
      userId: "local-user",
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
  });

  it("returns 200 for member with explicit tools:manage_connections permission", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser(companyId, "member");

    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: "tools:manage_connections",
    });

    const app = createApp(db, {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/default-mcp/legacy-enrollment`)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
  });
});
