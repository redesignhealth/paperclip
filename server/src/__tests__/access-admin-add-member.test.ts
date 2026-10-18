import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import { tenantContextMiddleware } from "../middleware/tenant-context.js";
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
  // Production mounts this before the routes; without it setAmbientCompanyId is a no-op in tests.
  app.use(tenantContextMiddleware());
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
  const seededUserIds: string[] = [];
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
    await db.execute(sql`DROP FUNCTION IF EXISTS fail_activity_fn()`);
    await db.delete(activityLog);
    await db.delete(instanceUserRoles);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    if (seededUserIds.length > 0) await db.delete(authUsers).where(inArray(authUsers.id, seededUserIds.splice(0)));
  });
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedUser(prefix: string) {
    const id = `${prefix}-${randomUUID()}`;
    seededUserIds.push(id);
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

  it("refuses a brand-new membership in a private company (TECH-7390) but may reactivate an archived one", async () => {
    const { company, adminId, adminApp } = await seed();
    await db.update(companies).set({ visibility: "private" }).where(eq(companies.id, company.id));
    const before = await activityCount(company.id);
    const denied = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId));
    expect(denied.status, JSON.stringify(denied.body)).toBe(409);
    expect(denied.body.error).toContain("private company");
    expect(await membershipsFor(company.id, adminId)).toHaveLength(0);
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, adminId))).toHaveLength(0);
    expect(await activityCount(company.id)).toBe(before);

    const targetId = await seedUser("returning");
    const [row] = await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: targetId, status: "archived", membershipRole: "viewer",
    }).returning();
    const reactivated = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(targetId, { role: "operator" }));
    expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(201);
    expect(await membershipsFor(company.id, targetId)).toMatchObject([{ id: row!.id, status: "active", membershipRole: "operator" }]);
  });

  it("resets stale elevated grants when an archived owner is re-added as viewer", async () => {
    const { company, adminApp } = await seed();
    const baselineId = await seedUser("baseline");
    await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(baselineId, { role: "viewer" })).expect(201);
    const keysFor = async (userId: string) =>
      (await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId)))
        .map((g) => g.permissionKey).sort();
    const viewerKeys = await keysFor(baselineId);
    expect(viewerKeys).not.toContain("users:manage_permissions");

    const targetId = await seedUser("former-owner");
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: targetId, status: "archived", membershipRole: "owner",
    });
    await db.insert(principalPermissionGrants).values(
      ["users:manage_permissions", "agents:create"].map((permissionKey) => ({
        companyId: company.id, principalType: "user", principalId: targetId, permissionKey,
      })),
    );
    await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(targetId, { role: "viewer" })).expect(201);
    expect(await keysFor(targetId)).toEqual(viewerKeys);
  });

  it.each([
    ["missing reason", { reason: undefined }, 400],
    ["blank reason", { reason: "   " }, 400],
    ["oversized reason", { reason: "x".repeat(501) }, 400],
    ["wrong confirm", { confirm: "yes" }, 400],
    ["missing confirm", { confirm: undefined }, 400],
    ["invalid role", { role: "superuser" }, 400],
    ["unknown field", { extra: true }, 400],
    ["unknown user", { userId: "no-such-user" }, 404],
  ])("rejects %s and writes nothing", async (_name, override, expectedStatus) => {
    const { company, adminId, adminApp } = await seed();
    const before = await activityCount(company.id);
    const res = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId, override));
    expect(res.status, JSON.stringify(res.body)).toBe(expectedStatus);
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
    let res: request.Response;
    try {
      await db.execute(sql`CREATE OR REPLACE FUNCTION fail_activity_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END; $$ LANGUAGE plpgsql`);
      await db.execute(sql`CREATE TRIGGER fail_activity BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_activity_fn()`);
      res = await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId));
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS fail_activity ON activity_log`);
      await db.execute(sql`DROP FUNCTION IF EXISTS fail_activity_fn()`);
    }
    expect(res.status).toBe(500);
    expect(await membershipsFor(company.id, adminId)).toHaveLength(0);
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, adminId))).toHaveLength(0);
  });

  describe("POST is instance-admin only", () => {
    it("rejects ordinary company owners, spoofed flags, agents and anonymous callers", async () => {
      const { company, ownerId, adminId } = await seed();
      const attackerId = await seedUser("attacker");
      const actors: Array<[string, Record<string, unknown>, number]> = [
        ["company owner", sessionActor(ownerId, { isInstanceAdmin: false, memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }] }), 403],
        ["spoofed isInstanceAdmin flag", sessionActor(attackerId, { isInstanceAdmin: true }), 403],
        ["agent", { type: "agent", agentId: randomUUID(), companyId: company.id, source: "agent_key", isInstanceAdmin: true }, 401],
        ["anonymous", { type: "none", source: "none" }, 401],
      ];
      for (const [name, actor, expectedStatus] of actors) {
        const res = await request(await createApp(db, actor)).post(`/api/companies/${company.id}/members`).send(body(adminId));
        expect(res.status, name).toBe(expectedStatus);
        expect(await membershipsFor(company.id, adminId), name).toHaveLength(0);
      }
      expect(await db.select().from(activityLog).where(eq(activityLog.action, ADDED_ACTION))).toHaveLength(0);
    });
  });

  /**
   * TECH-7635 B3. The actor is produced by the REAL resolveCloudTenantActor on every request
   * (trusted Cloud headers, enableOwnerInstanceAdmin on, no instance_user_roles row), so authority
   * comes from the attested Cloud context and never from a request-body flag. LIMIT: this injects
   * the actor in place of the full actorMiddleware/BetterAuth stack; the header->actor step is real.
   */
  describe("Cloud-attested instance admin with a non-owner membership (B3)", () => {
    const TOKEN = "tech7635-b3-token";
    let priorToken: string | undefined;
    beforeEach(async () => {
      priorToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = TOKEN;
      const { instanceSettingsService } = await import("../services/instance-settings.js");
      await instanceSettingsService(db).updateExperimental({ enableOwnerInstanceAdmin: true });
    });
    afterEach(async () => {
      if (priorToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = priorToken;
      const { instanceSettingsService } = await import("../services/instance-settings.js");
      await instanceSettingsService(db).updateExperimental({ enableOwnerInstanceAdmin: false });
    });

    async function cloudAdmin(stackRole: "owner" | "member" = "owner") {
      const { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } = await import("../middleware/auth.js");
      const { instanceSettingsService } = await import("../services/instance-settings.js");
      const userId = `cloud-${randomUUID()}`;
      const source = () => cloudActorHeaderSourceFromHeaders({
        "x-paperclip-cloud-tenant-token": TOKEN,
        "x-paperclip-cloud-user-id": userId,
        "x-paperclip-cloud-user-email": `${userId}@example.com`,
        "x-paperclip-cloud-stack-id": `stack-${userId}`,
        "x-paperclip-cloud-stack-role": stackRole,
      });
      const resolve = () => resolveCloudTenantActor(db, source());
      const { accessRoutes } = await import("../routes/access.js");
      const app = express();
      app.use(express.json());
      app.use(tenantContextMiddleware());
      app.use(async (req, _res, next) => {
        try { req.actor = (await resolve()) as never; next(); } catch (err) { next(err); }
      });
      app.use("/api", accessRoutes(db, {
        deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [],
      }));
      app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err.name === "ZodError" ? 400 : err.status ?? 500).json({ error: err.message ?? "Internal server error" });
      });
      const first = await resolve();
      const elevated = stackRole === "owner" && (await instanceSettingsService(db).getExperimental()).enableOwnerInstanceAdmin === true;
      expect(first, "setup: trusted Cloud actor").toMatchObject({ source: "cloud_tenant", userId, isInstanceAdmin: elevated });
      expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, userId)), "setup: no DB role").toHaveLength(0);
      return { userId, app, resolve };
    }

    it.each(["viewer", "operator", "admin"])(
      "keeps member management and self-leave for a Cloud admin who joined as %s",
      async (role) => {
        const { company } = await seed();
        const { userId, app, resolve } = await cloudAdmin();
        const base = `/api/companies/${company.id}/members`;
        expect((await resolve())!.companyIds).not.toContain(company.id);

        const added = await request(app).post(base).send(body(userId, { role }));
        expect(added.status, JSON.stringify(added.body)).toBe(201);
        const fresh = await resolve();
        expect(fresh!.companyIds).toContain(company.id);
        expect(fresh!.memberships).toContainEqual({ companyId: company.id, membershipRole: role, status: "active" });

        const list = await request(app).get(base);
        expect(list.status, JSON.stringify(list.body)).toBe(200);
        const self = list.body.members.find((m: any) => m.principalId === userId);
        expect(self).toMatchObject({ membershipRole: role, removal: { canArchive: true, reason: null } });
        expect(list.body.access).toMatchObject({ currentUserRole: role, canManageMembers: true });

        const archived = await request(app).post(`${base}/${self.id}/archive`).send({});
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        expect((await membershipsFor(company.id, userId))[0]!.status).toBe("archived");
      },
    );

    it("supports nonmember -> member -> leave, keeping the roster reachable but never the user-directory", async () => {
      const { company } = await seed();
      const { userId, app } = await cloudAdmin();
      const base = `/api/companies/${company.id}/members`;
      expect((await request(app).get(base)).status).toBe(200);
      expect((await request(app).get(`/api/companies/${company.id}/user-directory`)).status).toBe(403);

      await request(app).post(base).send(body(userId, { role: "operator" })).expect(201);
      const [row] = await membershipsFor(company.id, userId);
      const left = await request(app).post(`${base}/${row!.id}/archive`).send({});
      expect(left.status, JSON.stringify(left.body)).toBe(200);

      const roster = await request(app).get(base);
      expect(roster.status).toBe(200);
      expect(roster.body.members.find((m: any) => m.principalId === userId)).toBeUndefined();
      expect((await request(app).get(`/api/companies/${company.id}/user-directory`)).status).toBe(403);
      expect((await request(app).post(base).send(body(userId, { role: "viewer" }))).status).toBe(201);
    });

    it("still blocks the last active owner, other instance admins, company admins, and own role changes", async () => {
      const { company, ownerId, adminId } = await seed();
      const { userId, app } = await cloudAdmin();
      const base = `/api/companies/${company.id}/members`;
      await request(app).post(base).send(body(userId, { role: "operator" })).expect(201);
      const [self] = await membershipsFor(company.id, userId);

      const otherAdminRow = await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: adminId, status: "active", membershipRole: "operator",
      }).returning().then((r) => r[0]!);
      const companyAdminId = await seedUser("company-admin");
      const companyAdminRow = await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: companyAdminId, status: "active", membershipRole: "admin",
      }).returning().then((r) => r[0]!);
      const denied = async (row: { id: string }, error: string) => {
        const res = await request(app).post(`${base}/${row.id}/archive`).send({});
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toBe(error);
        expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, row.id)))[0]!.status).toBe("active");
      };
      await denied(otherAdminRow, "Instance admins cannot be removed from company access.");
      await denied(companyAdminRow, "Company admins cannot be removed from company access.");

      const roleChange = await request(app).patch(`${base}/${self!.id}`).send({ membershipRole: "owner" });
      expect(roleChange.status, JSON.stringify(roleChange.body)).toBe(403);
      expect(roleChange.body.error).toBe("You cannot remove yourself.");
      expect((await membershipsFor(company.id, userId))[0]!.membershipRole).toBe("operator");

      await db.update(companyMemberships).set({ status: "archived" }).where(and(
        eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalId, ownerId),
      ));
      await db.update(companyMemberships).set({ membershipRole: "owner" }).where(eq(companyMemberships.id, self!.id));
      await denied(self!, "Cannot remove the last active owner.");
    });

    it("applies the private-company rule to a Cloud-attested admin: refuses a new membership, reactivates an archived one", async () => {
      const { company } = await seed();
      await db.update(companies).set({ visibility: "private" }).where(eq(companies.id, company.id));
      const { userId, app } = await cloudAdmin();
      const base = `/api/companies/${company.id}/members`;
      const denied = await request(app).post(base).send(body(userId, { role: "operator" }));
      expect(denied.status, JSON.stringify(denied.body)).toBe(409);
      expect(denied.body.error).toContain("private company");
      expect(await membershipsFor(company.id, userId)).toHaveLength(0);

      const [row] = await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: userId, status: "archived", membershipRole: "viewer",
      }).returning();
      const reactivated = await request(app).post(base).send(body(userId, { role: "operator" }));
      expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(201);
      expect(await membershipsFor(company.id, userId)).toMatchObject([{ id: row!.id, status: "active", membershipRole: "operator" }]);
    });

    it("grants nothing to a Cloud stack role member even with elevation ON: a valid body is forbidden, a spoofed body is a separate 400", async () => {
      const { company } = await seed();
      const base = `/api/companies/${company.id}/members`;
      const { userId, app, resolve } = await cloudAdmin("member");
      const { instanceSettingsService } = await import("../services/instance-settings.js");
      expect((await instanceSettingsService(db).getExperimental()).enableOwnerInstanceAdmin, "setup: elevation ON").toBe(true);
      expect(await resolve(), "setup: stack member is not elevated").toMatchObject({ source: "cloud_tenant", isInstanceAdmin: false });

      const valid = await request(app).post(base).send(body(userId, { role: "viewer" }));
      expect(valid.status, JSON.stringify(valid.body)).toBe(403);
      expect(valid.body.error).toBe("Instance admin required");
      const spoof = await request(app).post(base).send({ ...body(userId, { role: "viewer" }), isInstanceAdmin: true });
      expect(spoof.status, JSON.stringify(spoof.body)).toBe(400);
      expect(await membershipsFor(company.id, userId)).toHaveLength(0);
      expect((await request(app).get(base)).status).toBe(403);
    });

    it("grants nothing to a stack-owner whose Cloud elevation was switched off: valid body forbidden, spoofed body 400, no self-archive authority", async () => {
      const { company } = await seed();
      const base = `/api/companies/${company.id}/members`;
      const stale = await cloudAdmin("owner");
      const { instanceSettingsService } = await import("../services/instance-settings.js");
      await instanceSettingsService(db).updateExperimental({ enableOwnerInstanceAdmin: false });

      const valid = await request(stale.app).post(base).send(body(stale.userId, { role: "viewer" }));
      expect(valid.status, JSON.stringify(valid.body)).toBe(403);
      expect(valid.body.error).toBe("Instance admin required");
      const spoof = await request(stale.app).post(base).send({ ...body(stale.userId, { role: "viewer" }), isInstanceAdmin: true });
      expect(spoof.status, JSON.stringify(spoof.body)).toBe(400);
      expect(await membershipsFor(company.id, stale.userId)).toHaveLength(0);
      expect((await request(stale.app).get(base)).status).toBe(403);

      // A real operator membership (viewers are blocked earlier as read-only) gives no self-archive authority without the attested flag; the explicit
      // manage grant gets past the permission check so only the self-removal guard can produce the 403.
      const [row] = await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: stale.userId, status: "active", membershipRole: "operator",
      }).returning();
      await db.insert(principalPermissionGrants).values({
        companyId: company.id, principalType: "user", principalId: stale.userId,
        permissionKey: "users:manage_permissions", grantedByUserId: stale.userId,
      });
      const res = await request(stale.app).post(`${base}/${row!.id}/archive`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("You cannot remove yourself.");
      expect((await membershipsFor(company.id, stale.userId))[0]!.status).toBe("active");
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

    it("follows the cloud_tenant policy: only the attested flag counts, never a stale DB role row", async () => {
      const { company, adminId } = await seed();
      const staleId = await seedUser("stale");
      await db.insert(instanceUserRoles).values({ userId: staleId, role: "instance_admin" });
      const attestedId = await seedUser("attested");
      const cloud = (userId: string, isInstanceAdmin: boolean) =>
        ({ type: "board", userId, source: "cloud_tenant", companyIds: [], memberships: [], isInstanceAdmin });
      const base = `/api/companies/${company.id}/members`;

      const staleApp = await createApp(db, cloud(staleId, false));
      expect((await request(staleApp).post(base).send(body(staleId))).status).toBe(403);
      expect((await request(staleApp).get(base)).status).toBe(403);
      expect(await membershipsFor(company.id, staleId)).toHaveLength(0);

      const attestedApp = await createApp(db, cloud(attestedId, true));
      expect((await request(attestedApp).get(base)).status).toBe(200);
      const added = await request(attestedApp).post(base).send(body(attestedId));
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      expect(await membershipsFor(company.id, attestedId)).toMatchObject([{ status: "active", membershipRole: "owner" }]);
      void adminId;
    });

    it("denies an ordinary non-admin board member of another company on every entry point", async () => {
      const { company, adminId } = await seed();
      const otherCompany = await db.insert(companies).values({ name: `Other ${randomUUID()}`, issuePrefix: `OT${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning().then((r) => r[0]!);
      const ordinaryId = await seedUser("ordinary");
      await db.insert(companyMemberships).values({ companyId: otherCompany.id, principalType: "user", principalId: ordinaryId, status: "active", membershipRole: "owner" });
      const app = await createApp(db, sessionActor(ordinaryId, {
        isInstanceAdmin: false, memberships: [{ companyId: otherCompany.id, membershipRole: "owner", status: "active" }],
      }));
      const base = `/api/companies/${company.id}/members`;
      expect((await request(app).get(base)).status).toBe(403);
      expect((await request(app).post(base).send(body(adminId))).status).toBe(403);
    });

    it("keeps the bypass isolated per company: it does not reach another company's members or access routes", async () => {
      const { company: companyA, adminApp } = await seedTeam();
      const { company: companyB, viewer: viewerB } = await seedTeam();
      const baseA = `/api/companies/${companyA.id}/members`;

      // A member id from company B addressed through company A's path is not found, and B is untouched.
      const crossArchive = await request(adminApp).post(`${baseA}/${viewerB.id}/archive`).send({});
      expect(crossArchive.status, JSON.stringify(crossArchive.body)).toBe(404);
      const crossPatch = await request(adminApp).patch(`${baseA}/${viewerB.id}`).send({ membershipRole: "admin" });
      expect(crossPatch.status, JSON.stringify(crossPatch.body)).toBe(404);
      expect((await membershipsFor(companyB.id, viewerB.principalId))[0]).toMatchObject({ status: "active", membershipRole: "viewer" });

      // Roster access never widens into the company-scoped routes of either company.
      for (const id of [companyA.id, companyB.id]) {
        expect((await request(adminApp).get(`/api/companies/${id}/user-directory`)).status).toBe(403);
      }
      // An unknown company is still 404, not an implicit grant.
      expect((await request(adminApp).get(`/api/companies/${randomUUID()}/members`)).status).toBe(404);
    });

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
      expect(res.body.error).toBe("Cannot remove the last active owner.");

      const otherAdmin = await seedUser("admin2");
      await db.insert(instanceUserRoles).values({ userId: otherAdmin, role: "instance_admin" });
      const m = await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: otherAdmin, status: "active", membershipRole: "operator",
      }).returning().then((r) => r[0]!);
      const res2 = await request(adminApp).post(`/api/companies/${company.id}/members/${m.id}/archive`).send({});
      expect(res2.status).toBe(403);
      expect(res2.body.error).toBe("Instance admins cannot be removed from company access.");
      expect((await membershipsFor(company.id, otherAdmin))[0]!.status).toBe("active");
      expect((await membershipsFor(company.id, ownerId))[0]!.status).toBe("active");
    });

    it.each(["viewer", "operator", "admin", "owner"])(
      "lets an instance admin added as %s remove only their own membership",
      async (role) => {
        const { company, adminId, adminApp } = await seedTeam();
        await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId, { role })).expect(201);
        const [self] = await membershipsFor(company.id, adminId);
        const protectedAdmin = await seedUser("protected-admin");
        const adminRow = await db.insert(companyMemberships).values({
          companyId: company.id, principalType: "user", principalId: protectedAdmin, status: "active", membershipRole: "admin",
        }).returning().then((r) => r[0]!);
        const memberApp = await createApp(db, sessionActor(adminId, {
          isInstanceAdmin: true, memberships: [{ companyId: company.id, membershipRole: role, status: "active" }],
        }));
        const base = `/api/companies/${company.id}/members`;

        const protectedRes = await request(memberApp).post(`${base}/${adminRow.id}/archive`).send({});
        expect(protectedRes.status, JSON.stringify(protectedRes.body)).toBe(403);
        expect(protectedRes.body.error).toBe("Company admins cannot be removed from company access.");
        const res = await request(memberApp).post(`${base}/${self!.id}/archive`).send({});
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((await membershipsFor(company.id, adminId))[0]!.status).toBe("archived");
        expect((await membershipsFor(company.id, protectedAdmin))[0]!.status).toBe("active");
        expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, adminId))).toHaveLength(0);
      },
    );

    it("still refuses to let an instance admin change their own role through the update route", async () => {
      const { company, adminId, adminApp } = await seedTeam();
      await request(adminApp).post(`/api/companies/${company.id}/members`).send(body(adminId, { role: "operator" })).expect(201);
      const [self] = await membershipsFor(company.id, adminId);
      const memberApp = await createApp(db, sessionActor(adminId, {
        isInstanceAdmin: true, memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
      }));
      const res = await request(memberApp).patch(`/api/companies/${company.id}/members/${self!.id}`).send({ membershipRole: "owner" });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("You cannot remove yourself.");
      const suspend = await request(memberApp).patch(`/api/companies/${company.id}/members/${self!.id}`).send({ status: "suspended" });
      expect(suspend.status, JSON.stringify(suspend.body)).toBe(403);
      expect(suspend.body.error).toBe("You cannot remove yourself.");
      expect((await membershipsFor(company.id, adminId))[0]).toMatchObject({ membershipRole: "operator", status: "active" });
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
