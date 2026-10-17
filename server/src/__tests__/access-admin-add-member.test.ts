import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
const CONFIRM = "ADD_MEMBER_AS_INSTANCE_ADMIN";
const ADDED_ACTION = "company_member.added_by_instance_admin";

async function createApp(db: Db, actor: Record<string, unknown>) {
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.name === "ZodError" ? 400 : err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

const sessionActor = (
  userId: string,
  opts: { isInstanceAdmin: boolean; memberships?: Array<{ companyId: string; membershipRole: string; status: string }> },
) => ({
  type: "board",
  userId,
  source: "session",
  companyIds: (opts.memberships ?? []).map((m) => m.companyId),
  memberships: opts.memberships ?? [],
  isInstanceAdmin: opts.isInstanceAdmin,
});

describeEmbeddedPostgres("TECH-7635 instance-admin member management", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    await import("../routes/access.js");
  }, 30_000);
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-admin-add-member-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.execute(sql`DROP TRIGGER IF EXISTS fail_activity ON activity_log`);
    await db.delete(activityLog);
    await db.delete(instanceUserRoles);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedUser(prefix: string) {
    const id = `${prefix}-${randomUUID()}`;
    await db.insert(authUsers).values({
      id,
      name: prefix,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function seed() {
    const company = await db
      .insert(companies)
      .values({ name: `Admin Add ${randomUUID()}`, issuePrefix: `AA${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const ownerId = await seedUser("owner");
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner",
    });
    const adminId = await seedUser("admin");
    await db.insert(instanceUserRoles).values({ userId: adminId, role: "instance_admin" });
    return { company, ownerId, adminId, adminApp: await createApp(db, sessionActor(adminId, { isInstanceAdmin: true })) };
  }

  const body = (userId: string, extra: Record<string, unknown> = {}) => ({
    userId, role: "owner", reason: "TECH-7635 offboarding support", confirm: CONFIRM, ...extra,
  });
  const membershipsFor = (companyId: string, userId: string) =>
    db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
    ));
  const activityCount = async (companyId: string) =>
    (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).length;

  it("adds an active owner membership, writes the audit row, grants, and marks the member list", async () => {
    const { company, adminId, adminApp } = await seed();
    const res = await request(adminApp).post(`/api/companies/${company.id}/members`).send({
      userId: adminId, reason: "  Need to help the team  ", confirm: CONFIRM,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.member.membershipRole).toBe("owner");
    expect(res.body.member.addedBy).toBe("instance_admin");

    const rows = await membershipsFor(company.id, adminId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active", membershipRole: "owner" });
    const grants = await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, adminId));
    expect(grants.length).toBeGreaterThan(0);

    const audit = await db.select().from(activityLog).where(eq(activityLog.action, ADDED_ACTION));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ companyId: company.id, actorType: "user", actorId: adminId, entityType: "company_membership", entityId: rows[0]!.id });
    expect(audit[0]!.details).toMatchObject({
      userId: adminId, membershipRole: "owner", reason: "Need to help the team", addedBy: "instance_admin",
    });

    const list = await request(await createApp(db, sessionActor(adminId, {
      isInstanceAdmin: true, memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
    }))).get(`/api/companies/${company.id}/members`);
    expect(list.status).toBe(200);
    const marked = list.body.members.find((m: any) => m.principalId === adminId);
    expect(marked.addedBy).toBe("instance_admin");
    expect(list.body.members.find((m: any) => m.principalType === "user" && m.principalId !== adminId).addedBy).toBeNull();
  });

  it("is idempotent: a repeat call (even with another role) leaves the membership unchanged", async () => {
    const { company, adminId, adminApp } = await seed();
    await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId, { role: "operator" })).expect(201);
    const [before] = await membershipsFor(company.id, adminId);
    const again = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId, { role: "owner" }));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.member.membershipRole).toBe("operator");
    const rows = await membershipsFor(company.id, adminId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before!.id, membershipRole: "operator", status: "active" });
    expect(rows[0]!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it("concurrent adds create exactly one membership and one 201", async () => {
    const { company, adminId, adminApp } = await seed();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(await membershipsFor(company.id, adminId)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, ADDED_ACTION))).toHaveLength(1);
  });

  it("reactivates an archived membership but refuses suspended ones", async () => {
    const { company, adminId, adminApp } = await seed();
    const targetId = await seedUser("target");
    const [row] = await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: targetId, status: "archived", membershipRole: "viewer",
    }).returning();
    const res = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(targetId, { role: "admin" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await membershipsFor(company.id, targetId)).toMatchObject([{ id: row!.id, status: "active", membershipRole: "admin" }]);

    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, row!.id));
    const refused = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(targetId));
    expect(refused.status).toBe(409);
    expect((await membershipsFor(company.id, targetId))[0]!.status).toBe("suspended");
    void adminId;
  });

  it.each([
    ["missing reason", { reason: undefined }],
    ["blank reason", { reason: "   " }],
    ["oversized reason", { reason: "x".repeat(501) }],
    ["wrong confirm", { confirm: "yes" }],
    ["missing confirm", { confirm: undefined }],
    ["invalid role", { role: "superuser" }],
    ["unknown user", { userId: "no-such-user" }],
  ])("rejects %s and writes nothing", async (_name, override) => {
    const { company, adminId, adminApp } = await seed();
    const before = await activityCount(company.id);
    const res = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId, override));
    expect([400, 404]).toContain(res.status);
    expect(await membershipsFor(company.id, adminId)).toHaveLength(0);
    expect(await activityCount(company.id)).toBe(before);
  });

  it("returns 404 for an unknown company and writes nothing", async () => {
    const { adminId, adminApp } = await seed();
    const res = await request(adminApp).post(`/api/companies/${randomUUID()}/members`).send(body(adminId));
    expect(res.status).toBe(404);
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, adminId))).toHaveLength(0);
  });

  it("rolls the membership back when the audit write fails", async () => {
    const { company, adminId, adminApp } = await seed();
    await db.execute(sql`CREATE OR REPLACE FUNCTION fail_activity_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END; $$ LANGUAGE plpgsql`);
    await db.execute(sql`CREATE TRIGGER fail_activity BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_activity_fn()`);
    const res = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId));
    expect(res.status).toBe(500);
    expect(await membershipsFor(company.id, adminId)).toHaveLength(0);
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, adminId))).toHaveLength(0);
  });

  describe("POST is instance-admin only", () => {
    it("rejects ordinary company owners, spoofed flags, agents and anonymous callers", async () => {
      const { company, ownerId, adminId } = await seed();
      const attackerId = await seedUser("attacker");
      const actors: Array<[string, Record<string, unknown>]> = [
        ["company owner", sessionActor(ownerId, { isInstanceAdmin: false, memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }] })],
        ["spoofed isInstanceAdmin flag", sessionActor(attackerId, { isInstanceAdmin: true })],
        ["agent", { type: "agent", agentId: randomUUID(), companyId: company.id, source: "agent_key", isInstanceAdmin: true }],
        ["anonymous", { type: "none", source: "none" }],
      ];
      for (const [name, actor] of actors) {
        const res = await request(await createApp(db, actor)).post(`/api/companies/${company.id}/members`).send(body(adminId));
        expect([401, 403], name).toContain(res.status);
        expect(await membershipsFor(company.id, adminId), name).toHaveLength(0);
      }
      expect(await db.select().from(activityLog).where(eq(activityLog.action, ADDED_ACTION))).toHaveLength(0);
    });
  });

  describe("narrow member-management bypass for instance admins", () => {
    async function seedTeam() {
      const base = await seed();
      const viewerId = await seedUser("viewer");
      const viewer = await db.insert(companyMemberships).values({
        companyId: base.company.id, principalType: "user", principalId: viewerId, status: "active", membershipRole: "viewer",
      }).returning().then((r) => r[0]!);
      const secondOwnerId = await seedUser("owner2");
      await db.insert(companyMemberships).values({
        companyId: base.company.id, principalType: "user", principalId: secondOwnerId, status: "active", membershipRole: "owner",
      });
      return { ...base, viewer };
    }

    it("lets a non-member instance admin list, change role, set grants, and archive", async () => {
      const { company, viewer, adminApp } = await seedTeam();
      const base = `/api/companies/${company.id}/members`;
      const list = await request(adminApp).get(base);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.members.length).toBeGreaterThan(1);
      expect((await request(adminApp).patch(`${base}/${viewer.id}`).send({ membershipRole: "operator" })).status).toBe(200);
      expect((await request(adminApp).patch(`${base}/${viewer.id}/role-and-grants`).send({ membershipRole: "operator", grants: [] })).status).toBe(200);
      expect((await request(adminApp).patch(`${base}/${viewer.id}/permissions`).send({ grants: [] })).status).toBe(200);
      const archived = await request(adminApp).post(`${base}/${viewer.id}/archive`).send({});
      expect(archived.status, JSON.stringify(archived.body)).toBe(200);
      expect((await membershipsFor(company.id, viewer.principalId))[0]!.status).toBe("archived");
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "company_member.archived"))).toHaveLength(1);
    });

    it("denies every bypassed route to a non-member who is not a real instance admin", async () => {
      const { company, viewer } = await seedTeam();
      const attackerId = await seedUser("attacker");
      const apps = [
        await createApp(db, sessionActor(attackerId, { isInstanceAdmin: false })),
        await createApp(db, sessionActor(attackerId, { isInstanceAdmin: true })), // spoofed: no DB role
        await createApp(db, { type: "agent", agentId: randomUUID(), companyId: company.id, source: "agent_key", isInstanceAdmin: true }),
      ];
      const base = `/api/companies/${company.id}/members`;
      for (const app of apps) {
        const calls = [
          request(app).get(base),
          request(app).patch(`${base}/${viewer.id}`).send({ membershipRole: "admin" }),
          request(app).patch(`${base}/${viewer.id}/role-and-grants`).send({ membershipRole: "admin", grants: [] }),
          request(app).patch(`${base}/${viewer.id}/permissions`).send({ grants: [] }),
          request(app).post(`${base}/${viewer.id}/archive`).send({}),
        ];
        for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
      }
      expect((await membershipsFor(company.id, viewer.principalId))[0]).toMatchObject({ status: "active", membershipRole: "viewer" });
    });

    it("does not widen company access: user-directory stays denied for a non-member admin", async () => {
      const { company, adminApp } = await seedTeam();
      const res = await request(adminApp).get(`/api/companies/${company.id}/user-directory`);
      expect(res.status).toBe(403);
    });

    it("keeps last-owner and instance-admin protections for the bypass actor", async () => {
      const { company, ownerId, adminApp } = await seed();
      const [owner] = await membershipsFor(company.id, ownerId);
      const res = await request(adminApp).post(`/api/companies/${company.id}/members/${owner!.id}/archive`).send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("last active owner");

      const otherAdmin = await seedUser("admin2");
      await db.insert(instanceUserRoles).values({ userId: otherAdmin, role: "instance_admin" });
      const m = await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: otherAdmin, status: "active", membershipRole: "operator",
      }).returning().then((r) => r[0]!);
      const res2 = await request(adminApp).post(`/api/companies/${company.id}/members/${m.id}/archive`).send({});
      expect(res2.status).toBe(403);
      expect(res2.body.error).toContain("Instance admins cannot be removed");
    });

    it("lets the added instance admin remove themselves afterwards, then clears the marker", async () => {
      const { company, adminId, adminApp } = await seedTeam();
      await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId)).expect(201);
      const [self] = await membershipsFor(company.id, adminId);
      const freshApp = await createApp(db, sessionActor(adminId, {
        isInstanceAdmin: true, memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));
      const res = await request(freshApp).post(`/api/companies/${company.id}/members/${self!.id}/archive`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await membershipsFor(company.id, adminId))[0]!.status).toBe("archived");
      const list = await request(adminApp).get(`/api/companies/${company.id}/members`);
      expect(list.body.members.find((m: any) => m.principalId === adminId)).toBeUndefined();
      const reAdd = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId));
      expect(reAdd.status).toBe(201);
    });
  });
});
