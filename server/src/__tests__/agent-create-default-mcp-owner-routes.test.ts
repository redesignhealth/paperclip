import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { agentService } from "../services/agents.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import { resolveCreatorOwnerUserId, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping default-MCP creator owner route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
}

// The local implicit board actor always passes authorization and carries a userId.
function userActor(): Express.Request["actor"] {
  return { type: "board", userId: "local-board", source: "local_implicit" };
}

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

describeEmbeddedPostgres("agent-created agents inherit the creating agent's default-MCP owner", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousFeature = process.env[FEATURE_ENV];
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-creator-owner-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-creator-owner-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    process.env[FEATURE_ENV] = "true";
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousFeature === undefined) delete process.env[FEATURE_ENV];
    else process.env[FEATURE_ENV] = previousFeature;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Creator Owner Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedMember(companyId: string, email = `owner-${randomUUID().slice(0, 6)}@redesignhealth.com`) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  /** A creator agent created the way a human-driven route does: its entries record `ownerUserId` (null when none). */
  async function seedCreator(companyId: string, ownerUserId: string | null) {
    const created = await agentService(db).create(
      companyId,
      {
        name: `Creator ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  const ownerOf = async (agentId: string): Promise<string | null | undefined> => {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return readDefaultMcpState(row?.metadata)?.entries["comms-board"]?.ownerUserId;
  };

  const hire = (actor: Express.Request["actor"], companyId: string) =>
    request(createApp(db, actor))
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({ name: `Child ${randomUUID().slice(0, 6)}`, role: "engineer", adapterType: "process", adapterConfig: {} });

  const create = (actor: Express.Request["actor"], companyId: string) =>
    request(createApp(db, actor))
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: `Child ${randomUUID().slice(0, 6)}`, role: "engineer", adapterType: "process", adapterConfig: {} });

  it("an agent hiring an agent: the child inherits the creator's owner", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId);
    const creator = await seedCreator(companyId, owner);
    expect(await ownerOf(creator.id)).toBe(owner);

    const res = await hire(agentActor(companyId, creator.id), companyId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await ownerOf(res.body.agent.id)).toBe(owner);
  });

  it("an agent creating an agent through the create route inherits the same owner", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId);
    const creator = await seedCreator(companyId, owner);

    const res = await create(agentActor(companyId, creator.id), companyId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childId = res.body.id ?? res.body.agent?.id;
    expect(childId).toEqual(expect.any(String));
    expect(await ownerOf(childId)).toBe(owner);
  });

  it("a creator with no owner of its own leaves the child ownerless (unchanged)", async () => {
    const companyId = await seedCompany();
    const creator = await seedCreator(companyId, null);
    expect(await ownerOf(creator.id)).toBeNull();

    const res = await hire(agentActor(companyId, creator.id), companyId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await ownerOf(res.body.agent.id)).toBeNull();
  });

  it("a creator whose owner is no longer an active member leaves the child ownerless", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId);
    const creator = await seedCreator(companyId, owner);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, owner));

    const res = await hire(agentActor(companyId, creator.id), companyId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await ownerOf(res.body.agent.id)).toBeNull();
  });

  it("a creator whose owner has an unverified email leaves the child ownerless", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId);
    const creator = await seedCreator(companyId, owner);
    await db.update(authUsers).set({ emailVerified: false }).where(eq(authUsers.id, owner));

    const res = await hire(agentActor(companyId, creator.id), companyId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await ownerOf(res.body.agent.id)).toBeNull();
  });

  it("with board approval required the child is pending_approval and still inherits the creator's owner", async () => {
    const companyId = await seedCompany();
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    const owner = await seedMember(companyId);
    const creator = await seedCreator(companyId, owner);

    const res = await hire(agentActor(companyId, creator.id), companyId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.status).toBe("pending_approval");
    expect(await ownerOf(res.body.agent.id)).toBe(owner);
  });

  it("a human actor is unchanged: the verified user is the owner", async () => {
    const companyId = await seedCompany();
    const res = await hire(userActor(), companyId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await ownerOf(res.body.agent.id)).toBe("local-board");
  });
});

describeEmbeddedPostgres("resolveCreatorOwnerUserId", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousFeature = process.env[FEATURE_ENV];
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-creator-owner-helper-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    process.env[FEATURE_ENV] = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-creator-owner-helper-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await waitForScheduledDefaultMcpSetups();
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousFeature === undefined) delete process.env[FEATURE_ENV];
    else process.env[FEATURE_ENV] = previousFeature;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Helper Co ${id.slice(0, 8)}`,
      issuePrefix: `H${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function member(companyId: string) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "O", email: `${userId}@redesignhealth.com`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  async function agentWithOwner(companyId: string, ownerUserId: string | null) {
    const created = await agentService(db).create(
      companyId,
      { name: `A ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId } },
    );
    await waitForScheduledDefaultMcpSetups();
    return created;
  }

  it("returns the creator's owner only for an active member of the same company", async () => {
    const companyId = await company();
    const otherCompanyId = await company();
    const owner = await member(companyId);
    const creator = await agentWithOwner(companyId, owner);
    const ownerless = await agentWithOwner(companyId, null);

    expect(await resolveCreatorOwnerUserId(db, companyId, creator.id)).toBe(owner);
    expect(await resolveCreatorOwnerUserId(db, companyId, ownerless.id)).toBeNull();
    expect(await resolveCreatorOwnerUserId(db, companyId, null)).toBeNull();
    expect(await resolveCreatorOwnerUserId(db, companyId, randomUUID())).toBeNull();
    // A creator id from another company is never read.
    expect(await resolveCreatorOwnerUserId(db, otherCompanyId, creator.id)).toBeNull();

    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, owner));
    expect(await resolveCreatorOwnerUserId(db, companyId, creator.id)).toBeNull();
  });

  it("an owner with an unverified email is not inherited", async () => {
    const companyId = await company();
    const owner = await member(companyId);
    const creator = await agentWithOwner(companyId, owner);
    expect(await resolveCreatorOwnerUserId(db, companyId, creator.id)).toBe(owner);
    await db.update(authUsers).set({ emailVerified: false }).where(eq(authUsers.id, owner));
    expect(await resolveCreatorOwnerUserId(db, companyId, creator.id)).toBeNull();
  });
});
