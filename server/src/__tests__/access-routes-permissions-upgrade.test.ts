import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  connectionGrantDelegations,
  connectionGrants,
  createDb,
  principalPermissionGrants,
  toolApplications,
  toolConnections,
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

async function createApp(db: Db, companyId: string, userId: string) {
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      source: "local_implicit",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

/**
 * Unlike `createApp`, this actor is NOT `isInstanceAdmin`/`local_implicit`, so
 * `resolveActorHumanRole` resolves its role from its real company membership
 * instead of short-circuiting to "owner" -- needed to test role-rank checks
 * against a non-owner actor.
 */
async function createAppWithMembershipActor(
  db: Db,
  companyId: string,
  userId: string,
  membershipRole: string,
) {
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole, status: "active" }],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createCompanyWithOwner(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Access Routes ${randomUUID()}`,
      issuePrefix: `AR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const owner = await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    })
    .returning()
    .then((rows) => rows[0]!);
  return { company, owner };
}

describeEmbeddedPostgres("access routes permissions upgrade compatibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Load the large router graph during setup so a cold CI transform does not
  // consume the first permission assertion's timeout budget.
  beforeAll(async () => {
    await import("../routes/access.js");
  }, 30_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-routes-permissions-upgrade-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connectionGrantDelegations);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects owner self-lockout through the member route after the permissions upgrade", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${owner.id}`)
      .send({ membershipRole: "admin" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("You cannot remove yourself");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.membershipRole).toBe("owner");
  }, 10_000);

  it("keeps custom grants when the role-only member route changes a member role", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `admin-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);
    const customScope = { projectIds: ["project-1"] };
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.principalId,
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ membershipRole: "operator" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.membershipRole).toBe("operator");

    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, company.id),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, member.principalId),
        ),
      );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });
  });

  it("sweeps personal connection access when the member route suspends a user", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `member-${randomUUID()}`,
      status: "active",
      membershipRole: "member",
    }).returning().then((rows) => rows[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Delegated route agent",
      role: "worker",
      adapterType: "process",
      adapterConfig: {},
    }).returning().then((rows) => rows[0]!);
    const application = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `route-app-${randomUUID()}`,
      name: "Route personal app",
      type: "mcp",
      status: "active",
    }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Route personal connection",
      uid: `route-connection-${randomUUID()}`,
      connectionKind: "managed",
      ownership: "customer",
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
    }).returning().then((rows) => rows[0]!);
    const grant = await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: connection.id,
      kind: "user",
      subjectUserId: member.principalId,
      status: "active",
    }).returning().then((rows) => rows[0]!);
    await db.insert(connectionGrantDelegations).values({
      companyId: company.id,
      grantId: grant.id,
      agentId: agent.id,
      createdByUserId: member.principalId,
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ status: "suspended" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("suspended");
    expect(await db.select().from(connectionGrantDelegations)).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))
      .toEqual([expect.objectContaining({ status: "revoked" })]);

    await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}/role-and-grants`)
      .send({ status: "active", grants: [] })
      .expect(200);
    await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, grant.id));
    await db.insert(connectionGrantDelegations).values({
      companyId: company.id,
      grantId: grant.id,
      agentId: agent.id,
      createdByUserId: member.principalId,
    });

    const permissionsRoute = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}/role-and-grants`)
      .send({ status: "suspended", grants: [] });
    expect(permissionsRoute.status, JSON.stringify(permissionsRoute.body)).toBe(200);
    expect(await db.select().from(connectionGrantDelegations)).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))
      .toEqual([expect.objectContaining({ status: "revoked" })]);
  });

  it("allows an owner to remove themselves via the member archive route when another active owner remains", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .post(`/api/companies/${company.id}/members/${owner.id}/archive`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const archived = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(archived.status).toBe("archived");
  });

  it("allows one owner to remove a different owner via the member archive route when another active owner remains", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const secondOwner = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `owner-${randomUUID()}`,
        status: "active",
        membershipRole: "owner",
      })
      .returning()
      .then((rows) => rows[0]!);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .post(`/api/companies/${company.id}/members/${secondOwner.id}/archive`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const archived = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, secondOwner.id))
      .then((rows) => rows[0]!);
    expect(archived.status).toBe("archived");
  });

  it("blocks removing the last active owner via the member archive route, including self-removal", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .post(`/api/companies/${company.id}/members/${owner.id}/archive`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Cannot remove the last active owner.");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.status).toBe("active");
  });

  it("still blocks a non-owner from removing themselves via the member archive route", async () => {
    const { company } = await createCompanyWithOwner(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `operator-${randomUUID()}`,
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);

    const res = await request(await createApp(db, company.id, member.principalId))
      .post(`/api/companies/${company.id}/members/${member.id}/archive`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("You cannot remove yourself.");
  });

  it("blocks a non-owner actor from archiving an owner via the member archive route, even with 2+ active owners", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    });
    const admin = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `admin-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);
    // admin's role-default grants don't include users:manage_permissions (only owner's do) --
    // grant it explicitly to exercise the actorRole!=="owner" rank check in getProtectedMemberReason
    // itself, simulating a company that has customized grants for a non-owner member manager.
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: admin.principalId,
      permissionKey: "users:manage_permissions",
      grantedByUserId: owner.principalId,
    });

    const res = await request(await createAppWithMembershipActor(db, company.id, admin.principalId, "admin"))
      .post(`/api/companies/${company.id}/members/${owner.id}/archive`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("You can only remove users below your company role.");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.status).toBe("active");
  });

  it("still blocks a non-archive role update that would self-demote the sole owner, even via the new archive-aware guard", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${owner.id}`)
      .send({ membershipRole: "admin" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("You cannot remove yourself.");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.membershipRole).toBe("owner");
  });

  it("reports removal.canArchive/removal.reason correctly for an owner row depending on the active owner count", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    const soleOwnerRes = await request(await createApp(db, company.id, owner.principalId))
      .get(`/api/companies/${company.id}/members`)
      .send();
    expect(soleOwnerRes.status, JSON.stringify(soleOwnerRes.body)).toBe(200);
    const soleOwnerRow = soleOwnerRes.body.members.find((m: { id: string }) => m.id === owner.id);
    expect(soleOwnerRow.removal).toEqual({
      canArchive: false,
      reason: "Cannot remove the last active owner.",
    });

    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    });

    const twoOwnersRes = await request(await createApp(db, company.id, owner.principalId))
      .get(`/api/companies/${company.id}/members`)
      .send();
    expect(twoOwnersRes.status, JSON.stringify(twoOwnersRes.body)).toBe(200);
    const twoOwnersRow = twoOwnersRes.body.members.find((m: { id: string }) => m.id === owner.id);
    expect(twoOwnersRow.removal).toEqual({ canArchive: true, reason: null });
  });
});
