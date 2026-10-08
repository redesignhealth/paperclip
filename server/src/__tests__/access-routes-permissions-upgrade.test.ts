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
  instanceUserRoles,
  principalPermissionGrants,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

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

/** A company with no members at all, for tests that build the roster themselves. */
async function createCompanyOnly(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `Access Routes ${randomUUID()}`,
      issuePrefix: `AR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function insertCompanyMembership(
  db: Db,
  companyId: string,
  principalId: string,
  membershipRole: string,
  status: "pending" | "active" | "suspended" = "active",
) {
  return db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId,
      status,
      membershipRole,
    })
    .returning()
    .then((rows) => rows[0]!);
}

/** Real `instance_user_roles` row so `access.isInstanceAdmin`/authz see the user as a global admin. */
async function insertInstanceAdminRole(db: Db, userId: string) {
  await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
}

type SessionActorMembership = { companyId: string; membershipRole?: string | null; status?: string };

/**
 * A browser-session board actor: `source: "session"` with an `isInstanceAdmin`
 * flag mirrored from a real `instance_user_roles` row, exactly the shape the
 * authenticated actor middleware builds. Unlike `createApp` (local_implicit),
 * TECH-7325's self-leave exception only opens for this source.
 */
async function createAppWithSessionActor(
  db: Db,
  userId: string,
  memberships: SessionActorMembership[],
  isInstanceAdmin: boolean,
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
      companyIds: memberships.map((membership) => membership.companyId),
      memberships,
      isInstanceAdmin,
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
 * Rebuild the session actor from live database state via the same
 * `boardAuth.resolveBoardAccess` the real authenticated middleware and
 * `/api/cli-auth/me` use — never a hand-pinned companyIds/isInstanceAdmin.
 */
async function createFreshSessionActorApp(db: Db, userId: string) {
  const { boardAuthService } = await import("../services/index.js");
  const boardAuth = boardAuthService(db);
  const snapshot = await boardAuth.resolveBoardAccess(userId);
  const app = await createAppWithSessionActor(db, userId, snapshot.memberships, snapshot.isInstanceAdmin);
  return { snapshot, app };
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
    // TECH-7325 tests insert real instance_user_roles rows; wipe them so no
    // role leaks between tests (the table has no FK parents, order is free).
    await db.delete(instanceUserRoles);
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

  it("allows an owner to archive a suspended owner even while they are the only active owner", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const suspendedOwner = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `owner-suspended-${randomUUID()}`,
        status: "suspended",
        membershipRole: "owner",
      })
      .returning()
      .then((rows) => rows[0]!);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .post(`/api/companies/${company.id}/members/${suspendedOwner.id}/archive`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const archived = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, suspendedOwner.id))
      .then((rows) => rows[0]!);
    expect(archived.status).toBe("archived");

    // The sole ACTIVE owner is untouched and still active -- archiving the suspended owner
    // never reduced the active owner count.
    const activeOwner = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(activeOwner.status).toBe("active");
  });

  describeEmbeddedPostgres("instance admin owner self-leave (TECH-7325)", () => {
    it("allows an authenticated instance admin to archive their own owner membership when another active owner remains", async () => {
      // The bootstrap owner stays as the required second active owner; the instance admin self-joins as an owner.
      const { company, owner } = await createCompanyWithOwner(db);
      const selfPrincipalId = `instance-admin-${randomUUID()}`;
      const selfMember = await insertCompanyMembership(db, company.id, selfPrincipalId, "owner");
      await insertInstanceAdminRole(db, selfPrincipalId);
      await db.insert(principalPermissionGrants).values({
        companyId: company.id,
        principalType: "user",
        principalId: selfPrincipalId,
        permissionKey: "tasks:assign",
        grantedByUserId: owner.principalId,
      });

      const res = await request(
        await createAppWithSessionActor(db, selfPrincipalId, [
          { companyId: company.id, membershipRole: "owner", status: "active" },
        ], true),
      )
        .post(`/api/companies/${company.id}/members/${selfMember.id}/archive`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.member.status).toBe("archived");

      const archivedRow = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.id, selfMember.id))
        .then((rows) => rows[0]!);
      expect(archivedRow.status).toBe("archived");

      // The global instance_admin role row survives the self-leave untouched.
      const roleRow = await db
        .select()
        .from(instanceUserRoles)
        .where(
          and(
            eq(instanceUserRoles.userId, selfPrincipalId),
            eq(instanceUserRoles.role, "instance_admin"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      expect(roleRow).not.toBeNull();

      // The member's custom grants are swept by the ordinary archive flow.
      const remainingGrants = await db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalId, selfPrincipalId),
          ),
        );
      expect(remainingGrants).toHaveLength(0);

      // The peer owner remains active.
      const peerRow = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.id, owner.id))
        .then((rows) => rows[0]!);
      expect(peerRow.status).toBe("active");

      // Audit trail: the archived member is their own actor, with the server-computed selfRemoval flag.
      const activity = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, company.id),
            eq(activityLog.entityId, selfMember.id),
          ),
        )
        .then((rows) => rows[0] ?? null);
      expect(activity).not.toBeNull();
      expect(activity!.action).toBe("company_member.archived");
      expect(activity!.actorType).toBe("user");
      expect(activity!.actorId).toBe(selfPrincipalId);
      expect(activity!.details?.selfRemoval).toBe(true);
    }, 15_000);

    it("blocks an instance admin's owner self-leave while they are the only ACTIVE owner; pending and suspended owners do not count", async () => {
      const company = await createCompanyOnly(db);
      const selfPrincipalId = `instance-admin-${randomUUID()}`;
      const selfMember = await insertCompanyMembership(db, company.id, selfPrincipalId, "owner");
      await insertCompanyMembership(db, company.id, `owner-pending-${randomUUID()}`, "owner", "pending");
      await insertCompanyMembership(db, company.id, `owner-suspended-${randomUUID()}`, "owner", "suspended");
      await insertInstanceAdminRole(db, selfPrincipalId);

      const res = await request(
        await createAppWithSessionActor(db, selfPrincipalId, [
          { companyId: company.id, membershipRole: "owner", status: "active" },
        ], true),
      )
        .post(`/api/companies/${company.id}/members/${selfMember.id}/archive`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Cannot remove the last active owner.");

      const unchanged = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.id, selfMember.id))
        .then((rows) => rows[0]!);
      expect(unchanged.status).toBe("active");
    }, 15_000);

    it("keeps peer instance-admin owner targets protected from normal owners and from company admins with an explicit manage grant", async () => {
      const { company, owner } = await createCompanyWithOwner(db);
      const adminTargetPrincipalId = `instance-admin-${randomUUID()}`;
      const adminTarget = await insertCompanyMembership(db, company.id, adminTargetPrincipalId, "owner");
      await insertInstanceAdminRole(db, adminTargetPrincipalId);
      // Seed the owner's role-default grants the way POST /companies does, so the
      // session-source owner actor passes assertCompanyPermission without local_implicit.
      await ensureHumanRoleDefaultGrants(db, {
        companyId: company.id,
        principalId: owner.principalId,
        membershipRole: "owner",
        grantedByUserId: owner.principalId,
      });

      // A normal owner would otherwise be allowed to archive another owner with 2+ active owners;
      // only the instance-admin target guard explains this 403.
      const ownerActorRes = await request(
        await createAppWithMembershipActor(db, company.id, owner.principalId, "owner"),
      )
        .post(`/api/companies/${company.id}/members/${adminTarget.id}/archive`)
        .send({});
      expect(ownerActorRes.status, JSON.stringify(ownerActorRes.body)).toBe(403);
      expect(ownerActorRes.body.error).toBe("Instance admins cannot be removed from company access.");

      // A company admin with an explicit users:manage_permissions grant hits the instance-admin
      // guard before the role-rank check, so the message stays the instance-admin one.
      const companyAdmin = await insertCompanyMembership(db, company.id, `admin-${randomUUID()}`, "admin");
      await db.insert(principalPermissionGrants).values({
        companyId: company.id,
        principalType: "user",
        principalId: companyAdmin.principalId,
        permissionKey: "users:manage_permissions",
        grantedByUserId: owner.principalId,
      });
      const adminActorRes = await request(
        await createAppWithMembershipActor(db, company.id, companyAdmin.principalId, "admin"),
      )
        .post(`/api/companies/${company.id}/members/${adminTarget.id}/archive`)
        .send({});
      expect(adminActorRes.status, JSON.stringify(adminActorRes.body)).toBe(403);
      expect(adminActorRes.body.error).toBe("Instance admins cannot be removed from company access.");

      const unchanged = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.id, adminTarget.id))
        .then((rows) => rows[0]!);
      expect(unchanged.status).toBe("active");
    }, 15_000);

    it("blocks an instance admin's self-archive when their own membership role is admin or operator", async () => {
      for (const membershipRole of ["admin", "operator"] as const) {
        const company = await createCompanyOnly(db);
        const selfPrincipalId = `instance-admin-${membershipRole}-${randomUUID()}`;
        const selfMember = await insertCompanyMembership(db, company.id, selfPrincipalId, membershipRole);
        await insertInstanceAdminRole(db, selfPrincipalId);

        const res = await request(
          await createAppWithSessionActor(db, selfPrincipalId, [
            { companyId: company.id, membershipRole, status: "active" },
          ], true),
        )
          .post(`/api/companies/${company.id}/members/${selfMember.id}/archive`)
          .send({});

        expect(res.status, `${membershipRole}: ${JSON.stringify(res.body)}`).toBe(403);
        expect(res.body.error).toBe("You cannot remove yourself.");

        const unchanged = await db
          .select()
          .from(companyMemberships)
          .where(eq(companyMemberships.id, selfMember.id))
          .then((rows) => rows[0]!);
        expect(unchanged.status).toBe("active");
      }
    }, 15_000);

    it("blocks every other self-directed member operation for an instance admin owner and preserves the company-access service guards", async () => {
      const { company } = await createCompanyWithOwner(db);
      const selfPrincipalId = `instance-admin-${randomUUID()}`;
      const selfMember = await insertCompanyMembership(db, company.id, selfPrincipalId, "owner");
      await insertInstanceAdminRole(db, selfPrincipalId);
      const app = await createAppWithSessionActor(db, selfPrincipalId, [
        { companyId: company.id, membershipRole: "owner", status: "active" },
      ], true);

      const suspendRes = await request(app)
        .patch(`/api/companies/${company.id}/members/${selfMember.id}`)
        .send({ status: "suspended" });
      expect(suspendRes.status, JSON.stringify(suspendRes.body)).toBe(403);
      expect(suspendRes.body.error).toBe("You cannot remove yourself.");

      const demoteRes = await request(app)
        .patch(`/api/companies/${company.id}/members/${selfMember.id}`)
        .send({ membershipRole: "admin" });
      expect(demoteRes.status, JSON.stringify(demoteRes.body)).toBe(403);
      expect(demoteRes.body.error).toBe("You cannot remove yourself.");

      const roleAndGrantsRes = await request(app)
        .patch(`/api/companies/${company.id}/members/${selfMember.id}/role-and-grants`)
        .send({ membershipRole: "admin", grants: [] });
      expect(roleAndGrantsRes.status, JSON.stringify(roleAndGrantsRes.body)).toBe(403);
      expect(roleAndGrantsRes.body.error).toBe("You cannot remove yourself.");

      const permissionsRes = await request(app)
        .patch(`/api/companies/${company.id}/members/${selfMember.id}/permissions`)
        .send({ grants: [] });
      expect(permissionsRes.status, JSON.stringify(permissionsRes.body)).toBe(403);
      expect(permissionsRes.body.error).toBe("You cannot remove yourself.");

      const unchanged = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.id, selfMember.id))
        .then((rows) => rows[0]!);
      expect(unchanged.status).toBe("active");
      expect(unchanged.membershipRole).toBe("owner");

      // The self-leave exception is archive-only: PUT company-access dropping the actor's own
      // company still trips the service's self-removal guard (409).
      const selfDropRes = await request(app)
        .put(`/api/admin/users/${selfPrincipalId}/company-access`)
        .send({ companyIds: [] });
      expect(selfDropRes.status, JSON.stringify(selfDropRes.body)).toBe(409);
      expect(selfDropRes.body.error).toBe("You cannot remove yourself");

      // The pre-existing service guard for OTHER instance-admin targets is unchanged.
      const peerAdminPrincipalId = `instance-admin-peer-${randomUUID()}`;
      const peerAdminMember = await insertCompanyMembership(db, company.id, peerAdminPrincipalId, "owner");
      await insertInstanceAdminRole(db, peerAdminPrincipalId);
      const peerDropRes = await request(app)
        .put(`/api/admin/users/${peerAdminPrincipalId}/company-access`)
        .send({ companyIds: [] });
      expect(peerDropRes.status, JSON.stringify(peerDropRes.body)).toBe(409);
      expect(peerDropRes.body.error).toBe("Instance admins cannot be removed from company access");

      const rows = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.companyId, company.id));
      expect(rows.find((row) => row.id === selfMember.id)?.status).toBe("active");
      expect(rows.find((row) => row.id === peerAdminMember.id)?.status).toBe("active");
    }, 20_000);

    it("reports removal.canArchive/reason for an instance-admin owner row from the self, peer, and sole-owner views", async () => {
      const { company, owner } = await createCompanyWithOwner(db);
      const selfPrincipalId = `instance-admin-${randomUUID()}`;
      const selfMember = await insertCompanyMembership(db, company.id, selfPrincipalId, "owner");
      await insertInstanceAdminRole(db, selfPrincipalId);
      // Seed the peer owner's role-default grants so the session actor can list members.
      await ensureHumanRoleDefaultGrants(db, {
        companyId: company.id,
        principalId: owner.principalId,
        membershipRole: "owner",
        grantedByUserId: owner.principalId,
      });

      // Self view with two active owners: the instance admin may leave.
      const selfRes = await request(
        await createAppWithSessionActor(db, selfPrincipalId, [
          { companyId: company.id, membershipRole: "owner", status: "active" },
        ], true),
      )
        .get(`/api/companies/${company.id}/members`)
        .send();
      expect(selfRes.status, JSON.stringify(selfRes.body)).toBe(200);
      const selfRow = selfRes.body.members.find((member: { id: string }) => member.id === selfMember.id);
      expect(selfRow.removal).toEqual({ canArchive: true, reason: null });

      // Peer view: a normal owner cannot remove the instance admin.
      const peerRes = await request(
        await createAppWithMembershipActor(db, company.id, owner.principalId, "owner"),
      )
        .get(`/api/companies/${company.id}/members`)
        .send();
      expect(peerRes.status, JSON.stringify(peerRes.body)).toBe(200);
      const adminRowAsPeer = peerRes.body.members.find(
        (member: { id: string }) => member.id === selfMember.id,
      );
      expect(adminRowAsPeer.removal).toEqual({
        canArchive: false,
        reason: "Instance admins cannot be removed from company access.",
      });

      // Sole-owner view: the last-active-owner reason wins for the self row.
      const soleCompany = await createCompanyOnly(db);
      await insertCompanyMembership(db, soleCompany.id, selfPrincipalId, "owner");
      const soleRes = await request(
        await createAppWithSessionActor(db, selfPrincipalId, [
          { companyId: soleCompany.id, membershipRole: "owner", status: "active" },
        ], true),
      )
        .get(`/api/companies/${soleCompany.id}/members`)
        .send();
      expect(soleRes.status, JSON.stringify(soleRes.body)).toBe(200);
      const soleRow = soleRes.body.members.find(
        (member: { principalId: string }) => member.principalId === selfPrincipalId,
      );
      expect(soleRow.removal).toEqual({
        canArchive: false,
        reason: "Cannot remove the last active owner.",
      });
    }, 15_000);

    it("recomputes board access after an instance-admin owner self-leave: the company drops out, the global role persists, members 403", async () => {
      const { company } = await createCompanyWithOwner(db);
      const selfPrincipalId = `instance-admin-${randomUUID()}`;
      const selfMember = await insertCompanyMembership(db, company.id, selfPrincipalId, "owner");
      await insertInstanceAdminRole(db, selfPrincipalId);
      // A second company the self only operates in, so the recomputed access set stays non-empty.
      const otherCompany = await createCompanyOnly(db);
      await insertCompanyMembership(db, otherCompany.id, selfPrincipalId, "operator");

      const archiveRes = await request(
        await createAppWithSessionActor(db, selfPrincipalId, [
          { companyId: company.id, membershipRole: "owner", status: "active" },
          { companyId: otherCompany.id, membershipRole: "operator", status: "active" },
        ], true),
      )
        .post(`/api/companies/${company.id}/members/${selfMember.id}/archive`)
        .send({});
      expect(archiveRes.status, JSON.stringify(archiveRes.body)).toBe(200);

      // Recompute the actor from live DB state exactly like the authenticated session middleware.
      const { snapshot, app: freshApp } = await createFreshSessionActorApp(db, selfPrincipalId);
      expect(snapshot.isInstanceAdmin).toBe(true);
      expect(snapshot.companyIds).toContain(otherCompany.id);
      expect(snapshot.companyIds).not.toContain(company.id);

      // The real /cli-auth/me surface reports the same recomputed access.
      const meRes = await request(freshApp).get("/api/cli-auth/me");
      expect(meRes.status, JSON.stringify(meRes.body)).toBe(200);
      expect(meRes.body.isInstanceAdmin).toBe(true);
      expect(meRes.body.companyIds).toContain(otherCompany.id);
      expect(meRes.body.companyIds).not.toContain(company.id);

      // The removed company's members list is forbidden for the self despite the global role.
      const membersRes = await request(freshApp)
        .get(`/api/companies/${company.id}/members`)
        .send();
      expect(membersRes.status, JSON.stringify(membersRes.body)).toBe(403);
      expect(membersRes.body.error).toBe("User does not have access to this company");
    }, 20_000);

    it("serializes parallel owner self-archives from two instance admins: exactly one succeeds and one active owner remains", async () => {
      const company = await createCompanyOnly(db);
      const principalA = `instance-admin-a-${randomUUID()}`;
      const principalB = `instance-admin-b-${randomUUID()}`;
      const memberA = await insertCompanyMembership(db, company.id, principalA, "owner");
      const memberB = await insertCompanyMembership(db, company.id, principalB, "owner");
      await insertInstanceAdminRole(db, principalA);
      await insertInstanceAdminRole(db, principalB);

      const [appA, appB] = await Promise.all([
        createAppWithSessionActor(db, principalA, [
          { companyId: company.id, membershipRole: "owner", status: "active" },
        ], true),
        createAppWithSessionActor(db, principalB, [
          { companyId: company.id, membershipRole: "owner", status: "active" },
        ], true),
      ]);

      // Each supertest request runs in its own HTTP handler on its own pooled
      // connection, so these are genuinely concurrent archiveMember
      // transactions -- no shared connection or serialised queue to mask the
      // race. archiveMember's SELECT ... FOR UPDATE over the company's active
      // owner rows serialises the two transactions: the loser re-counts
      // active owners after the winner commits and gets the transactional 409
      // conflict (or the 403 pre-check if it starts late enough to see the
      // winner's commit first). Either way the company can never end up
      // ownerless.
      const [resA, resB] = await Promise.all([
        request(appA)
          .post(`/api/companies/${company.id}/members/${memberA.id}/archive`)
          .send({}),
        request(appB)
          .post(`/api/companies/${company.id}/members/${memberB.id}/archive`)
          .send({}),
      ]);

      const outcomes = [resA, resB];
      const successes = outcomes.filter((res) => res.status === 200);
      expect(successes, JSON.stringify([resA.body, resB.body])).toHaveLength(1);
      const failure = outcomes.find((res) => res.status !== 200)!;
      expect([403, 409]).toContain(failure.status);

      const rows = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.companyId, company.id));
      const rowA = rows.find((row) => row.id === memberA.id)!;
      const rowB = rows.find((row) => row.id === memberB.id)!;
      expect([rowA.status, rowB.status].sort()).toEqual(["active", "archived"]);
      const activeOwners = rows.filter(
        (row) => row.status === "active" && row.membershipRole === "owner",
      );
      expect(activeOwners).toHaveLength(1);
    }, 20_000);
  });
});
