import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, invites, joinRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accessRoutes } from "../routes/access.js";
import { accessService } from "../services/access.js";
import { errorHandler } from "../middleware/index.js";

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    ensureMembership: vi.fn(),
    setPrincipalGrants: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-visibility gating tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("TECH-7390: private company blocks human invitations/membership", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(visibility: "private" | "shared" | null) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Acme",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      visibility,
    });
    return id;
  }

  function createApp(currentCompanyId: string, actorOverride?: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actorOverride ?? {
        type: "board",
        source: "local_implicit",
        userId: null,
        companyIds: [currentCompanyId],
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  describe("POST /companies/:companyId/invites", () => {
    it("rejects a human invite on a private company", async () => {
      const companyId = await createCompany("private");
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/companies/${companyId}/invites`)
        .send({ allowedJoinTypes: "human" });

      expect(res.status).toBe(403);
    });

    it("rejects a both-type invite on a private company", async () => {
      const companyId = await createCompany("private");
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/companies/${companyId}/invites`)
        .send({ allowedJoinTypes: "both" });

      expect(res.status).toBe(403);
    });

    it("allows an agent-only invite on a private company (own-agent hiring is unaffected)", async () => {
      const companyId = await createCompany("private");
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/companies/${companyId}/invites`)
        .send({ allowedJoinTypes: "agent" });

      expect(res.status).toBe(201);
    });

    it("allows a human invite on a shared company", async () => {
      const companyId = await createCompany("shared");
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/companies/${companyId}/invites`)
        .send({ allowedJoinTypes: "human" });

      expect(res.status).toBe(201);
    });

    it("allows a human invite on an unclassified (pre-backfill, NULL) company", async () => {
      const companyId = await createCompany(null);
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/companies/${companyId}/invites`)
        .send({ allowedJoinTypes: "human" });

      expect(res.status).toBe(201);
    });
  });

  describe("POST /invites/:token/accept (defense-in-depth on a pre-existing invite)", () => {
    async function createInvite(companyId: string, allowedJoinTypes: "human" | "agent" | "both") {
      const token = randomUUID();
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await db.insert(invites).values({
        companyId,
        inviteType: "company_join",
        allowedJoinTypes,
        tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      return token;
    }

    it("rejects a human accept on a private company even for an invite created before this field shipped", async () => {
      const companyId = await createCompany("private");
      const token = await createInvite(companyId, "human");
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "human" });

      expect(res.status).toBe(403);
    });

    it("rejects a human accept on a private company via a both-type invite (the pre-field default)", async () => {
      const companyId = await createCompany("private");
      const token = await createInvite(companyId, "both");
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "human" });

      expect(res.status).toBe(403);
    });

    it("allows an agent join via a both-type invite on a private company", async () => {
      const companyId = await createCompany("private");
      const token = await createInvite(companyId, "both");
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "agent", agentName: "Test Agent" });

      expect(res.status).toBe(202);
    });

    it("rejects a human accept on a private company from a session user not already a member", async () => {
      const companyId = await createCompany("private");
      const token = await createInvite(companyId, "human");
      const app = createApp(companyId, {
        type: "board",
        source: "session",
        userId: randomUUID(),
        companyIds: [],
      });

      const res = await request(app)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "human" });

      expect(res.status).toBe(403);
    });

    it("still allows an agent join request on a private company", async () => {
      const companyId = await createCompany("private");
      const token = await createInvite(companyId, "agent");
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "agent", agentName: "Test Agent" });

      expect(res.status).toBe(202);
    });

    it("allows an agent join request on a private company from an unauthenticated actor", async () => {
      const companyId = await createCompany("private");
      const token = await createInvite(companyId, "agent");
      const app = createApp(companyId, {
        type: "board",
        source: "session",
        userId: null,
        companyIds: [],
      });

      const res = await request(app)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "agent", agentName: "Test Agent" });

      expect(res.status).toBe(202);
    });

    it("allows a human accept on a shared company", async () => {
      const companyId = await createCompany("shared");
      const token = await createInvite(companyId, "human");
      const app = createApp(companyId);

      const res = await request(app)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "human" });

      expect(res.status).toBe(202);
    });
  });

  describe("access.setUserCompanyAccess", () => {
    it("rejects adding a new human member to a private company", async () => {
      const privateCompanyId = await createCompany("private");
      const svc = accessService(db);
      const userId = randomUUID();

      await expect(
        svc.setUserCompanyAccess(userId, [privateCompanyId]),
      ).rejects.toThrow(/private/i);

      const rows = await db.select().from(companyMemberships);
      expect(rows.filter((row) => row.companyId === privateCompanyId)).toHaveLength(0);
    });

    it("allows adding a new human member to a shared company", async () => {
      const sharedCompanyId = await createCompany("shared");
      const svc = accessService(db);
      const userId = randomUUID();

      await expect(
        svc.setUserCompanyAccess(userId, [sharedCompanyId]),
      ).resolves.toBeDefined();
    });

    it("allows reactivating an existing membership on a private company (not a new addition)", async () => {
      const privateCompanyId = await createCompany("private");
      const svc = accessService(db);
      const userId = randomUUID();
      await db.insert(companyMemberships).values({
        companyId: privateCompanyId,
        principalType: "user",
        principalId: userId,
        status: "archived",
        membershipRole: "operator",
      });

      await expect(
        svc.setUserCompanyAccess(userId, [privateCompanyId]),
      ).resolves.toBeDefined();
    });
  });
});
