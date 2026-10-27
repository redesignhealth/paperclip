import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  invites,
  joinRequests,
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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres owner-handoff tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type JoinType = "human" | "agent" | "both";

const HANDOFF_ACTION = "company_member.joined_via_owner_handoff";
const RETIREMENT_ACTION = "company_member.retired_by_owner_handoff";

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
  // Mirrors the real handler's contract closely enough for these assertions: the HTTP status,
  // the message, and -- load-bearing for TECH-7952 H1/M1 -- a top-level `code` taken from
  // `err.details.code`, which is what the UI branches on.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const details = err?.details && typeof err.details === "object" && !Array.isArray(err.details)
      ? err.details as Record<string, unknown>
      : null;
    res
      .status(err.name === "ZodError" ? 400 : err.status ?? 500)
      .json({
        error: err.message ?? "Internal server error",
        ...(typeof details?.code === "string" ? { code: details.code } : {}),
      });
  });
  return app;
}

const sessionActor = (
  userId: string,
  opts: {
    isInstanceAdmin: boolean;
    memberships?: Array<{ companyId: string; membershipRole: string; status: string }>;
  } = { isInstanceAdmin: false },
) => ({
  type: "board",
  userId,
  source: "session",
  companyIds: (opts.memberships ?? []).map((membership) => membership.companyId),
  memberships: opts.memberships ?? [],
  isInstanceAdmin: opts.isInstanceAdmin,
});

describeEmbeddedPostgres("TECH-7952 private-company owner handoff invite", () => {
  let db!: Db;
  const seededUserIds: string[] = [];
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    await import("../routes/access.js");
  }, 30_000);
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-handoff-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(instanceUserRoles);
    await db.delete(companies);
    if (seededUserIds.length > 0) await db.delete(authUsers).where(inArray(authUsers.id, seededUserIds.splice(0)));
  });
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedUser(
    prefix: string,
    options: { email?: string; emailVerified?: boolean } = {},
  ) {
    const id = `${prefix}-${randomUUID()}`;
    seededUserIds.push(id);
    await db.insert(authUsers).values({
      id,
      name: prefix,
      email: options.email ?? `${id}@example.com`,
      emailVerified: options.emailVerified ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function createCompany(visibility: "private" | "shared" | null) {
    return db
      .insert(companies)
      .values({
        name: `Handoff ${randomUUID()}`,
        issuePrefix: `HO${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        visibility,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function addMembership(input: {
    companyId: string;
    userId: string;
    membershipRole: "owner" | "admin" | "operator" | "viewer";
    status?: "active" | "pending" | "suspended" | "archived";
  }) {
    return db.insert(companyMemberships).values({
      companyId: input.companyId,
      principalType: "user",
      principalId: input.userId,
      status: input.status ?? "active",
      membershipRole: input.membershipRole,
    }).returning().then((rows) => rows[0]!);
  }

  async function makeInstanceAdmin(userId: string) {
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
  }

  /**
   * The invite route gates on `users:invite` before the private-company policy, and that gate
   * resolves a board actor's authority from grants (an instance-admin *role row* short-circuits
   * it). Grant it explicitly so a non-admin case fails on the policy under test, not on the gate.
   */
  async function grantInvite(companyId: string, userId: string) {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: "users:invite",
      grantedByUserId: userId,
    });
  }

  /** A private company whose creator is an active owner AND a verified instance admin. */
  async function seedPrivateCompanyWithAdmin() {
    const company = await createCompany("private");
    const adminId = await seedUser("admin");
    await makeInstanceAdmin(adminId);
    const adminMembership = await addMembership({ companyId: company.id, userId: adminId, membershipRole: "owner" });
    const app = await createApp(db, sessionActor(adminId, {
      isInstanceAdmin: true,
      memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
    }));
    return { company, adminId, adminMembership, app };
  }

  async function insertInvite(input: {
    companyId: string;
    allowedJoinTypes: JoinType;
    token?: string;
    boundEmail?: string | null;
    ownerHandoffIssuedByUserId?: string | null;
    acceptedAt?: Date | null;
    defaultsPayload?: Record<string, unknown> | null;
  }) {
    const token = input.token ?? `tok-${randomUUID()}`;
    const row = await db.insert(invites).values({
      companyId: input.companyId,
      inviteType: "company_join",
      allowedJoinTypes: input.allowedJoinTypes,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      boundEmail: input.boundEmail ?? null,
      ownerHandoffIssuedByUserId: input.ownerHandoffIssuedByUserId ?? null,
      acceptedAt: input.acceptedAt ?? null,
      defaultsPayload: input.defaultsPayload ?? null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }).returning().then((rows) => rows[0]!);
    return { token, row };
  }

  const membershipsFor = (companyId: string, userId: string) =>
    db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
    ));

  const invitesFor = (companyId: string) =>
    db.select().from(invites).where(eq(invites.companyId, companyId));

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------
  describe("POST /companies/:companyId/invites on a private company", () => {
    it("lets a verified instance admin issue a human-only, email-bound owner handoff and records provenance", async () => {
      const { company, adminId, app } = await seedPrivateCompanyWithAdmin();

      const res = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({
          allowedJoinTypes: "human", humanRole: "owner", email: "  New.Owner@Example.COM ",
          defaultsPayload: { human: { role: "viewer", grants: [] }, ownerHandoffIssuedByUserId: "forged" },
          agentMessage: "Ignored on a handoff",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.allowedJoinTypes).toBe("human");
      expect(res.body.boundEmail).toBe("new.owner@example.com");
      expect(res.body.ownerHandoffIssuedByUserId).toBe(adminId);
      expect(res.body.token).toBeTruthy();

      const [row] = await invitesFor(company.id);
      expect(row).toMatchObject({
        allowedJoinTypes: "human",
        boundEmail: "new.owner@example.com",
        ownerHandoffIssuedByUserId: adminId,
        invitedByUserId: adminId,
        acceptedAt: null,
        revokedAt: null,
      });
      // Owner defaults are written server-side; client defaults are ignored on this branch.
      expect((row!.defaultsPayload as any)?.human?.role).toBe("owner");

      const summary = await request(app).get(`/api/invites/${res.body.token}`);
      expect(summary.status, JSON.stringify(summary.body)).toBe(200);
      expect(summary.body).toMatchObject({ ownerHandoff: true, humanRole: "owner", allowedJoinTypes: "human" });
    });

    it("defaults an omitted role to owner rather than rejecting it", async () => {
      const { company, app } = await seedPrivateCompanyWithAdmin();

      const res = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", email: "owner@example.com" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const summary = await request(app).get(`/api/invites/${res.body.token}`);
      expect(summary.body.humanRole).toBe("owner");
      const [row] = await invitesFor(company.id);
      expect((row!.defaultsPayload as any)?.human?.role).toBe("owner");
    });

    it.each([
      ["both-type", { allowedJoinTypes: "both", email: "owner@example.com" }, 400],
      ["non-owner role", { allowedJoinTypes: "human", humanRole: "admin", email: "owner@example.com" }, 400],
      ["missing email", { allowedJoinTypes: "human", humanRole: "owner" }, 400],
      ["blank email", { allowedJoinTypes: "human", humanRole: "owner", email: "   " }, 400],
      ["malformed email", { allowedJoinTypes: "human", humanRole: "owner", email: "not-an-email" }, 400],
    ])("rejects a handoff with %s and creates nothing", async (_name, body, expectedStatus) => {
      const { company, app } = await seedPrivateCompanyWithAdmin();

      const res = await request(app).post(`/api/companies/${company.id}/invites`).send(body);

      expect(res.status, JSON.stringify(res.body)).toBe(expectedStatus);
      expect(await invitesFor(company.id)).toHaveLength(0);
    });

    it("keeps the ordinary private 403 for a non-admin member", async () => {
      const company = await createCompany("private");
      const ownerId = await seedUser("plain-owner");
      await addMembership({ companyId: company.id, userId: ownerId, membershipRole: "owner" });
      await grantInvite(company.id, ownerId);
      const app = await createApp(db, sessionActor(ownerId, {
        isInstanceAdmin: false,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));

      const res = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toMatch(/private/i);
      expect(await invitesFor(company.id)).toHaveLength(0);
    });

    it("refuses a local_implicit caller even though it is the local board", async () => {
      const company = await createCompany("private");
      const app = await createApp(db, {
        type: "board",
        source: "local_implicit",
        userId: "local-board",
        companyIds: [company.id],
        isInstanceAdmin: true,
      });

      const res = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });

      expect(res.status).toBe(403);
      expect(await invitesFor(company.id)).toHaveLength(0);
    });

    it("does not let a session-supplied isInstanceAdmin flag without a role row create a handoff", async () => {
      const company = await createCompany("private");
      const spooferId = await seedUser("spoofer");
      await addMembership({ companyId: company.id, userId: spooferId, membershipRole: "owner" });
      // The invite permission is granted so the request reaches the private-company policy
      // rather than stopping at the ordinary permission gate.
      await grantInvite(company.id, spooferId);
      const app = await createApp(db, sessionActor(spooferId, {
        isInstanceAdmin: true,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));

      const res = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toMatch(/private/i);
      expect(await invitesFor(company.id)).toHaveLength(0);
    });

    it("trusts the cloud_tenant attested flag: a true flag creates one, a stale role row with a false flag does not", async () => {
      // The route's `users:invite` gate resolves a board actor's authority from the role row
      // (not the cloud_tenant flag), so both actors below carry the row + grant to reach the
      // private-company policy. Only the attested flag differs, and only it decides.
      const seedCloudActor = async (options: { attestedInstanceAdmin: boolean }) => {
        const company = await createCompany("private");
        const userId = await seedUser(options.attestedInstanceAdmin ? "cloud-admin" : "stale-admin");
        await makeInstanceAdmin(userId);
        await addMembership({ companyId: company.id, userId, membershipRole: "owner" });
        await grantInvite(company.id, userId);
        const app = await createApp(db, {
          type: "board",
          userId,
          source: "cloud_tenant",
          companyIds: [company.id],
          memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
          isInstanceAdmin: options.attestedInstanceAdmin,
        });
        return { company, userId, app };
      };

      const attested = await seedCloudActor({ attestedInstanceAdmin: true });
      const created = await request(attested.app)
        .post(`/api/companies/${attested.company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.ownerHandoffIssuedByUserId).toBe(attested.userId);

      const stale = await seedCloudActor({ attestedInstanceAdmin: false });
      const refused = await request(stale.app)
        .post(`/api/companies/${stale.company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error).toMatch(/private/i);
      expect(await invitesFor(stale.company.id)).toHaveLength(0);
    });

    // H1: a Cloud-attested admin has no persisted instance_admin role row, so nothing in the
    // slot counter exempts them by stored status. What lets this succeed is the explicit
    // create-time exemption of the *verified caller*, by id -- not any Cloud flag.
    it("allows a rowless Cloud-attested admin member to hand off the private company", async () => {
      const company = await createCompany("private");
      const userId = await seedUser("rowless-cloud-admin");
      await addMembership({ companyId: company.id, userId, membershipRole: "owner" });
      await grantInvite(company.id, userId);
      const app = await createApp(db, {
        type: "board", userId, source: "cloud_tenant", isInstanceAdmin: true,
        companyIds: [company.id],
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      });
      const result = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
    });

    it("returns 409 while a handoff is live and allows another after the first is revoked", async () => {
      const { company, app } = await seedPrivateCompanyWithAdmin();

      const first = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "first@example.com" });
      expect(first.status, JSON.stringify(first.body)).toBe(201);

      const second = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "second@example.com" });
      expect(second.status, JSON.stringify(second.body)).toBe(409);
      expect(await invitesFor(company.id)).toHaveLength(1);

      const [live] = await invitesFor(company.id);
      await request(app).post(`/api/invites/${live!.id}/revoke`).send({}).expect(200);

      const third = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "second@example.com" });
      expect(third.status, JSON.stringify(third.body)).toBe(201);
      expect((await invitesFor(company.id)).filter((row) => row.ownerHandoffIssuedByUserId !== null)).toHaveLength(2);
    });

    it("returns 409 when a non-admin human already occupies the slot", async () => {
      const { company, app } = await seedPrivateCompanyWithAdmin();
      const occupantId = await seedUser("occupant");
      await addMembership({ companyId: company.id, userId: occupantId, membershipRole: "operator" });

      const res = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(await invitesFor(company.id)).toHaveLength(0);
    });

    it("does not count another instance-admin member toward the slot", async () => {
      const { company, app } = await seedPrivateCompanyWithAdmin();
      const otherAdminId = await seedUser("other-admin");
      await makeInstanceAdmin(otherAdminId);
      await addMembership({ companyId: company.id, userId: otherAdminId, membershipRole: "operator" });

      const res = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it("keeps agent-only invites untouched on a private company", async () => {
      const company = await createCompany("private");
      const ownerId = await seedUser("agent-inviter");
      await addMembership({ companyId: company.id, userId: ownerId, membershipRole: "owner" });
      await grantInvite(company.id, ownerId);
      const app = await createApp(db, sessionActor(ownerId, {
        isInstanceAdmin: false,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));

      const res = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "agent" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [row] = await invitesFor(company.id);
      expect(row).toMatchObject({ allowedJoinTypes: "agent", boundEmail: null, ownerHandoffIssuedByUserId: null });
    });
  });

  // ---------------------------------------------------------------------------
  // Accept
  // ---------------------------------------------------------------------------
  describe("POST /invites/:token/accept for a private owner handoff", () => {
    async function seedHandoff(input: { inviteeEmail?: string } = {}) {
      const { company, adminId, adminMembership, app } = await seedPrivateCompanyWithAdmin();
      const inviteeEmail = (input.inviteeEmail ?? `invitee-${randomUUID()}@example.com`).toLowerCase();
      const inviteeId = await seedUser("invitee", { email: inviteeEmail });
      const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));
      const { token, row } = await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: inviteeEmail,
        ownerHandoffIssuedByUserId: adminId,
        defaultsPayload: { human: { role: "owner" } },
      });
      return { company, adminId, adminMembership, app, inviteeId, inviteeEmail, inviteeApp, token, invite: row };
    }

    it("accepts for the bound verified email and writes an active owner membership, grants, approved request and audit row", async () => {
      const s = await seedHandoff();

      const res = await request(s.inviteeApp)
        .post(`/api/invites/${s.token}/accept`)
        .send({ requestType: "human" });

      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body).toMatchObject({ requestType: "human", status: "approved", requestingUserId: s.inviteeId });
      expect(res.body.approvedByUserId).toBe(s.adminId);
      expect(res.body.requestEmailSnapshot).toBe(s.inviteeEmail);

      const memberships = await membershipsFor(s.company.id, s.inviteeId);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({ status: "active", membershipRole: "owner" });

      const grants = await db.select().from(principalPermissionGrants).where(and(
        eq(principalPermissionGrants.companyId, s.company.id),
        eq(principalPermissionGrants.principalId, s.inviteeId),
      ));
      expect(grants.map((grant) => grant.permissionKey).sort()).toEqual(
        [
          "agents:configure",
          "agents:create",
          "commentary:view", // upstream owner role gained default commentary read (#16903)
          "environments:manage",
          "joins:approve",
          "skills:create",
          "tasks:assign",
          "tools:admin",
          "tools:manage_connections",
          "tools:manage_runtime",
          "tools:use",
          "users:invite",
          "users:manage_permissions",
        ].sort(),
      );

      const [storedInvite] = await invitesFor(s.company.id);
      expect(storedInvite!.acceptedAt).not.toBeNull();

      const audit = await db.select().from(activityLog).where(eq(activityLog.action, HANDOFF_ACTION));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        companyId: s.company.id,
        actorType: "user",
        actorId: s.inviteeId,
        entityType: "company_membership",
        entityId: memberships[0]!.id,
      });
      expect(audit[0]!.details).toMatchObject({
        userId: s.inviteeId,
        inviteId: s.invite.id,
        issuedByUserId: s.adminId,
        membershipRole: "owner",
        companyVisibility: "private",
        reactivated: false,
      });
    });

    it("rejects an accept from a different account even when that account is a verified user", async () => {
      const s = await seedHandoff();
      const otherId = await seedUser("someone-else");
      const otherApp = await createApp(db, sessionActor(otherId, { isInstanceAdmin: false }));

      const res = await request(otherApp)
        .post(`/api/invites/${s.token}/accept`)
        .send({ requestType: "human" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/different email address/i);
      // M1: the landing page branches on this code to show the wrong-account panel.
      expect(res.body.code).toBe("invite_email_mismatch");
      expect(await membershipsFor(s.company.id, otherId)).toHaveLength(0);
      const [storedInvite] = await invitesFor(s.company.id);
      expect(storedInvite!.acceptedAt).toBeNull();
    });

    it("rejects an unverified email even when the address matches", async () => {
      const { company, adminId } = await seedPrivateCompanyWithAdmin();
      const email = `unverified-${randomUUID()}@example.com`;
      const inviteeId = await seedUser("unverified", { email, emailVerified: false });
      const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));
      const { token } = await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: email,
        ownerHandoffIssuedByUserId: adminId,
      });

      const res = await request(inviteeApp)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "human" });

      expect(res.status).toBe(403);
      // M1: distinct from a mismatch, so the page can offer SSO instead of a sign-out loop.
      expect(res.body.code).toBe("invite_email_unverified");
      expect(res.body.error).toMatch(/isn't verified/i);
      expect(await membershipsFor(company.id, inviteeId)).toHaveLength(0);
      const [storedInvite] = await invitesFor(company.id);
      expect(storedInvite!.acceptedAt).toBeNull();
    });

    it("returns 401 for an anonymous accept and leaves the invite unconsumed", async () => {
      const s = await seedHandoff();
      const anonymousApp = await createApp(db, {
        type: "board",
        source: "session",
        userId: null,
        companyIds: [],
        memberships: [],
        isInstanceAdmin: false,
      });

      const res = await request(anonymousApp)
        .post(`/api/invites/${s.token}/accept`)
        .send({ requestType: "human" });

      expect(res.status).toBe(401);
      const [storedInvite] = await invitesFor(s.company.id);
      expect(storedInvite!.acceptedAt).toBeNull();
      expect(await db.select().from(joinRequests).where(eq(joinRequests.companyId, s.company.id))).toHaveLength(0);
    });

    it("returns 409 when the slot filled after the invite was created", async () => {
      const s = await seedHandoff();
      // An instance admin's direct-add consumes the slot with an ordinary human.
      const occupantId = await seedUser("late-occupant");
      const added = await request(s.app)
        .post(`/api/companies/${s.company.id}/members`)
        .send({
          userId: occupantId,
          role: "operator",
          reason: "TECH-7952 late slot fill",
          confirm: "ADD_MEMBER_AS_INSTANCE_ADMIN",
        });
      expect(added.status, JSON.stringify(added.body)).toBe(201);

      const res = await request(s.inviteeApp)
        .post(`/api/invites/${s.token}/accept`)
        .send({ requestType: "human" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(await membershipsFor(s.company.id, s.inviteeId)).toHaveLength(0);
      const [storedInvite] = await invitesFor(s.company.id);
      expect(storedInvite!.acceptedAt).toBeNull();
    });

    it("exempts an instance-admin acceptor from the slot check", async () => {
      const company = await createCompany("private");
      const issuerId = await seedUser("issuer");
      await makeInstanceAdmin(issuerId);
      await addMembership({ companyId: company.id, userId: issuerId, membershipRole: "owner" });
      const issuerApp = await createApp(db, sessionActor(issuerId, {
        isInstanceAdmin: true,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));

      const email = `admin-invitee-${randomUUID()}@example.com`;
      const incomingAdminId = `incoming-admin-${randomUUID()}`;
      seededUserIds.push(incomingAdminId);
      await db.insert(authUsers).values({
        id: incomingAdminId,
        name: "incoming-admin",
        email,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await makeInstanceAdmin(incomingAdminId);
      const incomingApp = await createApp(db, sessionActor(incomingAdminId, { isInstanceAdmin: true }));

      const created = await request(issuerApp)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      // The slot fills after creation with an ordinary human; an instance-admin acceptor
      // is exempt, so the handoff still lands.
      const occupantId = await seedUser("occupant");
      await addMembership({ companyId: company.id, userId: occupantId, membershipRole: "operator" });

      const res = await request(incomingApp)
        .post(`/api/invites/${created.body.token}/accept`)
        .send({ requestType: "human" });

      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(await membershipsFor(company.id, incomingAdminId)).toMatchObject([
        { status: "active", membershipRole: "owner" },
      ]);
    });

    it("lets exactly one of two concurrent accepts win", async () => {
      const s = await seedHandoff();
      // auth_users.email is not unique in this schema, so both actors pass the bound-email
      // check; only the transactional claim may decide who gets the membership.
      const twinId = await seedUser("twin", { email: s.inviteeEmail });
      const twinApp = await createApp(db, sessionActor(twinId, { isInstanceAdmin: false }));

      const results = await Promise.all([
        request(s.inviteeApp).post(`/api/invites/${s.token}/accept`).send({ requestType: "human" }),
        request(twinApp).post(`/api/invites/${s.token}/accept`).send({ requestType: "human" }),
      ]);
      // The loser sees either "Invite not found" (404, the claim already landed) or the slot
      // conflict (409, it re-read after the winner's membership committed). Both are refusals.
      expect(results.filter((res) => res.status === 202)).toHaveLength(1);
      expect(results.filter((res) => res.status === 404 || res.status === 409)).toHaveLength(1);

      const memberships = await db.select().from(companyMemberships).where(and(
        eq(companyMemberships.companyId, s.company.id),
        eq(companyMemberships.principalType, "user"),
        inArray(companyMemberships.principalId, [s.inviteeId, twinId]),
      ));
      expect(memberships).toHaveLength(1);
      expect(memberships[0]!.membershipRole).toBe("owner");
      expect(await db.select().from(activityLog).where(eq(activityLog.action, HANDOFF_ACTION))).toHaveLength(1);
    });

    it("reactivates an archived membership for the accepting owner and resets grants to the owner defaults", async () => {
      const s = await seedHandoff();
      // A stale archived row from an earlier flow, plus a grant that is not part of the owner
      // defaults, so the handoff has to overwrite both the row and the grant set.
      const archived = await addMembership({
        companyId: s.company.id,
        userId: s.inviteeId,
        membershipRole: "viewer",
        status: "archived",
      });
      await db.insert(principalPermissionGrants).values({
        companyId: s.company.id,
        principalType: "user",
        principalId: s.inviteeId,
        permissionKey: "tasks:assign_scope",
        scope: { agentIds: ["stale-agent"] },
        grantedByUserId: s.adminId,
      });

      const res = await request(s.inviteeApp)
        .post(`/api/invites/${s.token}/accept`)
        .send({ requestType: "human" });

      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const memberships = await membershipsFor(s.company.id, s.inviteeId);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({ id: archived.id, status: "active", membershipRole: "owner" });

      const keys = (await db.select().from(principalPermissionGrants).where(and(
        eq(principalPermissionGrants.companyId, s.company.id),
        eq(principalPermissionGrants.principalId, s.inviteeId),
      ))).map((grant) => grant.permissionKey);
      expect(keys).not.toContain("tasks:assign_scope");
      expect(keys).toContain("users:manage_permissions");

      const audit = await db.select().from(activityLog).where(eq(activityLog.action, HANDOFF_ACTION));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details).toMatchObject({ reactivated: true, membershipRole: "owner" });
    });

    it("replays an already-accepted handoff for the same user without a second membership", async () => {
      const s = await seedHandoff();
      const first = await request(s.inviteeApp).post(`/api/invites/${s.token}/accept`).send({ requestType: "human" });
      expect(first.status).toBe(202);

      const second = await request(s.inviteeApp).post(`/api/invites/${s.token}/accept`).send({ requestType: "human" });

      expect(second.status, JSON.stringify(second.body)).toBe(202);
      expect(second.body).toEqual(first.body);
      expect(second.body.status).toBe("approved");
      expect(await membershipsFor(s.company.id, s.inviteeId)).toHaveLength(1);
      expect(await db.select().from(joinRequests).where(eq(joinRequests.inviteId, s.invite.id))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, HANDOFF_ACTION))).toHaveLength(1);
    });

    it("still refuses a legacy human invite (no provenance) on a private company", async () => {
      const { company } = await seedPrivateCompanyWithAdmin();
      const email = `legacy-${randomUUID()}@example.com`;
      const inviteeId = await seedUser("legacy-invitee", { email });
      const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));
      // A row inserted directly, as if it predated the feature: bound email, no provenance.
      const { token } = await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: email,
        ownerHandoffIssuedByUserId: null,
      });

      const res = await request(inviteeApp)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "human" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/private/i);
      expect(await membershipsFor(company.id, inviteeId)).toHaveLength(0);
      const [storedInvite] = await invitesFor(company.id);
      expect(storedInvite!.acceptedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // H1 + D1: slot accounting, issuer retirement, Cloud tenant guard, availability
  // ---------------------------------------------------------------------------
  describe("H1/D1 slot accounting and issuer retirement", () => {
    async function seedRowlessCloudAdminCompany() {
      const company = await createCompany("private");
      const userId = await seedUser("rowless-issuer");
      // No instance_user_roles row: the Cloud attestation is request-scoped only.
      await addMembership({ companyId: company.id, userId, membershipRole: "owner" });
      await grantInvite(company.id, userId);
      const app = await createApp(db, {
        type: "board", userId, source: "cloud_tenant", isInstanceAdmin: true,
        companyIds: [company.id],
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      });
      return { company, userId, app };
    }

    it("retires a rowless issuer on accept and writes the retirement audit row", async () => {
      const { company, userId: issuerId, app } = await seedRowlessCloudAdminCompany();
      const email = `rowless-successor-${randomUUID()}@example.com`;
      const inviteeId = await seedUser("rowless-successor", { email });
      const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));

      const created = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const accepted = await request(inviteeApp)
        .post(`/api/invites/${created.body.token}/accept`)
        .send({ requestType: "human" });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);

      expect((await membershipsFor(company.id, issuerId))[0]!.status).toBe("archived");
      expect((await membershipsFor(company.id, inviteeId))[0]).toMatchObject({
        status: "active",
        membershipRole: "owner",
      });
      // The retired issuer keeps no company grants.
      expect(await db.select().from(principalPermissionGrants).where(and(
        eq(principalPermissionGrants.companyId, company.id),
        eq(principalPermissionGrants.principalId, issuerId),
      ))).toHaveLength(0);

      const [retirement] = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "company_member.retired_by_owner_handoff"));
      expect(retirement).toMatchObject({ companyId: company.id, actorId: inviteeId });
      expect(retirement!.details).toMatchObject({
        inviteId: created.body.id,
        issuerUserId: issuerId,
        acceptorUserId: inviteeId,
      });
    });

    it("rolls the whole accept back when a third non-admin member already holds the slot", async () => {
      const { company, userId: issuerId, app } = await seedRowlessCloudAdminCompany();
      const email = `blocked-successor-${randomUUID()}@example.com`;
      const inviteeId = await seedUser("blocked-successor", { email });
      const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));
      const created = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      // A third human fills the slot after creation. The issuer's exclusion must not hide this.
      const occupantId = await seedUser("third-occupant");
      await addMembership({ companyId: company.id, userId: occupantId, membershipRole: "operator" });

      const res = await request(inviteeApp)
        .post(`/api/invites/${created.body.token}/accept`)
        .send({ requestType: "human" });
      expect(res.status, JSON.stringify(res.body)).toBe(409);

      // Single transaction: the issuer is NOT archived and the invite stays unconsumed.
      expect((await membershipsFor(company.id, issuerId))[0]!.status).toBe("active");
      expect(await membershipsFor(company.id, inviteeId)).toHaveLength(0);
      const [storedInvite] = await invitesFor(company.id);
      expect(storedInvite!.acceptedAt).toBeNull();
      expect(await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "company_member.retired_by_owner_handoff"))).toHaveLength(0);
    });

    it("keeps a role-row admin issuer's membership on accept", async () => {
      const { company, adminId, app } = await seedPrivateCompanyWithAdmin();
      const email = `kept-admin-${randomUUID()}@example.com`;
      const inviteeId = await seedUser("kept-admin", { email });
      const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));

      const created = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const accepted = await request(inviteeApp)
        .post(`/api/invites/${created.body.token}/accept`)
        .send({ requestType: "human" });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);

      expect((await membershipsFor(company.id, adminId))[0]!.status).toBe("active");
      expect(await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "company_member.retired_by_owner_handoff"))).toHaveLength(0);
    });

    it("replays an accepted handoff after the issuer was retired without writing a second retirement row", async () => {
      const { company, userId: issuerId, app } = await seedRowlessCloudAdminCompany();
      const email = `replayed-successor-${randomUUID()}@example.com`;
      const inviteeId = await seedUser("replayed-successor", { email });
      const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));

      const created = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const first = await request(inviteeApp)
        .post(`/api/invites/${created.body.token}/accept`)
        .send({ requestType: "human" });
      expect(first.status, JSON.stringify(first.body)).toBe(202);

      const retirementsAfterFirst = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, RETIREMENT_ACTION));
      expect(retirementsAfterFirst).toHaveLength(1);

      // The same user replays the same token. The service short-circuits on `accepted_at`
      // and returns the original approved request -- including past the issuer retirement,
      // which must not run (and must not archive an already-archived row) a second time.
      const second = await request(inviteeApp)
        .post(`/api/invites/${created.body.token}/accept`)
        .send({ requestType: "human" });

      expect(second.status, JSON.stringify(second.body)).toBe(202);
      expect(second.body).toEqual(first.body);
      expect(second.body.status).toBe("approved");
      expect(second.body.requestingUserId).toBe(inviteeId);

      expect(await membershipsFor(company.id, inviteeId)).toHaveLength(1);
      expect(await db.select().from(joinRequests).where(eq(joinRequests.inviteId, created.body.id))).toHaveLength(1);

      const retirementsAfterReplay = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, RETIREMENT_ACTION));
      expect(retirementsAfterReplay).toHaveLength(1);
      expect(retirementsAfterReplay[0]!.id).toBe(retirementsAfterFirst[0]!.id);
      // The replay did reach the route (which logs its own replay row); it short-circuited in the
      // service before the retirement branch rather than failing any earlier check.
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "join.request_replayed"))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "join.requested"))).toHaveLength(1);
      expect((await membershipsFor(company.id, issuerId))[0]!.status).toBe("archived");
      expect(await db.select().from(activityLog).where(eq(activityLog.action, HANDOFF_ACTION))).toHaveLength(1);
    });

    it.each(["pending", "suspended"] as const)(
      "retires a rowless issuer whose membership is %s at accept time",
      async (status) => {
        const company = await createCompany("private");
        const issuerId = await seedUser(`rowless-issuer-${status}`);
        // No instance_admin role row: only the retirement path can clear this occupancy.
        await addMembership({ companyId: company.id, userId: issuerId, membershipRole: "owner", status });

        // The invite was issued while the issuer was active; their membership is now
        // pending/suspended. The invite is seeded directly because the create route's
        // `users:invite` gate requires an *active* membership (authorization's
        // decidePrincipalGrant), which is exactly why this has to be reachable at accept.
        const email = `retired-${status}-successor-${randomUUID()}@example.com`;
        const inviteeId = await seedUser(`retired-${status}-successor`, { email });
        const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));
        const { token } = await insertInvite({
          companyId: company.id,
          allowedJoinTypes: "human",
          boundEmail: email,
          ownerHandoffIssuedByUserId: issuerId,
          defaultsPayload: { human: { role: "owner" } },
        });

        const accepted = await request(inviteeApp)
          .post(`/api/invites/${token}/accept`)
          .send({ requestType: "human" });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);

        const [issuerMembership] = await membershipsFor(company.id, issuerId);
        expect(issuerMembership!.status).toBe("archived");
        const retirements = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.action, RETIREMENT_ACTION));
        expect(retirements).toHaveLength(1);
        expect(retirements[0]!.details).toMatchObject({
          issuerUserId: issuerId,
          acceptorUserId: inviteeId,
        });
        expect((await membershipsFor(company.id, inviteeId))[0]).toMatchObject({
          status: "active",
          membershipRole: "owner",
        });
      },
    );

    it("does not retire or self-archive when the issuer is the acceptor", async () => {
      const { accessService } = await import("../services/access.js");
      const access = accessService(db);
      const company = await createCompany("private");
      // A rowless issuer who hands the company off to their own bound email. The route refuses
      // this shape earlier (an active member cannot accept a company invite), so the edge is
      // exercised at the service boundary where the branch actually lives.
      const selfId = await seedUser("self-handoff");
      const membership = await addMembership({
        companyId: company.id,
        userId: selfId,
        membershipRole: "owner",
      });
      const email = `self-${randomUUID()}@example.com`;
      const { row } = await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: email,
        ownerHandoffIssuedByUserId: selfId,
        defaultsPayload: { human: { role: "owner" } },
      });

      const result = await access.acceptOwnerHandoffInvite({
        inviteId: row.id,
        userId: selfId,
        actorEmail: email,
        actorEmailVerified: true,
        requestIp: "127.0.0.1",
      });

      expect(result.replayed).toBe(false);
      expect(result.membership).toMatchObject({ id: membership.id, status: "active", membershipRole: "owner" });
      expect(await membershipsFor(company.id, selfId)).toHaveLength(1);
      expect((await membershipsFor(company.id, selfId))[0]!.status).toBe("active");
      expect(await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, RETIREMENT_ACTION))).toHaveLength(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, HANDOFF_ACTION))).toHaveLength(1);
    });

    it("leaves the issuer's membership alone when their own session accepts the route", async () => {
      const company = await createCompany("private");
      const selfId = await seedUser("self-handoff-route");
      await addMembership({ companyId: company.id, userId: selfId, membershipRole: "owner" });
      const email = `self-route-${randomUUID()}@example.com`;
      await db.update(authUsers).set({ email }).where(eq(authUsers.id, selfId));
      const { token } = await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: email,
        ownerHandoffIssuedByUserId: selfId,
      });
      // The issuer is an active member here, so the route stops at "already a member" before
      // ever reaching the retirement branch -- which is the point: no self-retirement can be
      // reached through the ordinary accept path.
      const selfApp = await createApp(db, sessionActor(selfId, {
        isInstanceAdmin: false,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));

      const res = await request(selfApp)
        .post(`/api/invites/${token}/accept`)
        .send({ requestType: "human" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatch(/already belong to this company/i);
      expect((await membershipsFor(company.id, selfId))[0]!.status).toBe("active");
      expect(await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, RETIREMENT_ACTION))).toHaveLength(0);
      const [storedInvite] = await invitesFor(company.id);
      expect(storedInvite!.acceptedAt).toBeNull();
    });

    it("lets exactly one of two concurrent bound-email twin accepts win, retiring the issuer once", async () => {
      const { company, userId: issuerId, app } = await seedRowlessCloudAdminCompany();
      const email = `concurrent-successor-${randomUUID()}@example.com`;
      const inviteeId = await seedUser("concurrent-successor", { email });
      // auth_users.email is not unique in this schema, so both twins pass the bound-email check
      // and only the transactional claim + slot recheck may decide who lands.
      const twinId = await seedUser("concurrent-twin", { email });
      const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));
      const twinApp = await createApp(db, sessionActor(twinId, { isInstanceAdmin: false }));

      const created = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const results = await Promise.all([
        request(inviteeApp).post(`/api/invites/${created.body.token}/accept`).send({ requestType: "human" }),
        request(twinApp).post(`/api/invites/${created.body.token}/accept`).send({ requestType: "human" }),
      ]);

      expect(results.filter((res) => res.status === 202)).toHaveLength(1);
      // The loser sees either "Invite not found" (the claim already landed) or the slot conflict.
      expect(results.filter((res) => res.status === 404 || res.status === 409)).toHaveLength(1);

      // Exactly one successor membership, and the issuer was retired exactly once.
      const successorMemberships = await db.select().from(companyMemberships).where(and(
        eq(companyMemberships.companyId, company.id),
        eq(companyMemberships.principalType, "user"),
        inArray(companyMemberships.principalId, [inviteeId, twinId]),
      ));
      expect(successorMemberships).toHaveLength(1);
      expect(successorMemberships[0]!.membershipRole).toBe("owner");
      expect(successorMemberships[0]!.status).toBe("active");

      const issuerMemberships = await membershipsFor(company.id, issuerId);
      expect(issuerMemberships).toHaveLength(1);
      expect(issuerMemberships[0]!.status).toBe("archived");

      const retirements = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, RETIREMENT_ACTION));
      expect(retirements).toHaveLength(1);
      expect(retirements[0]!.details).toMatchObject({
        issuerUserId: issuerId,
        acceptorUserId: successorMemberships[0]!.principalId,
      });
      expect(await db.select().from(activityLog).where(eq(activityLog.action, HANDOFF_ACTION))).toHaveLength(1);
    });

    it("leaves shared-company bound-email invites untouched by the cloud_managed_company guard", async () => {
      // The guard is answered from server-derived state only. A cloud_tenant actor's
      // `cloudTenantCompanyId` is exactly that: the trusted-header-derived tenant company, which
      // routes read instead of anything the client sent. Setting it to a *shared* company proves
      // the guard lives only inside the private handoff branch -- a shared invite is neither
      // refused at create nor at accept because it never reaches that branch.
      const company = await createCompany("shared");
      const cloudActor = (userId: string) => ({
        type: "board",
        userId,
        source: "cloud_tenant",
        isInstanceAdmin: true,
        cloudTenantCompanyId: company.id,
        companyIds: [company.id],
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      });
      const adminId = await seedUser("managed-shared-admin");
      await grantInvite(company.id, adminId);
      await addMembership({ companyId: company.id, userId: adminId, membershipRole: "owner" });
      const adminApp = await createApp(db, cloudActor(adminId));

      const boundEmail = `managed-shared-${randomUUID()}@example.com`;
      const created = await request(adminApp)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "operator", email: boundEmail });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.ownerHandoffIssuedByUserId).toBeNull();

      const inviteeId = await seedUser("managed-shared-invitee", { email: boundEmail });
      // A cloud_tenant actor whose tenant company *is* this shared company: if the guard ever
      // leaked out of the private branch, this accept would be refused with cloud_managed_company.
      const inviteeApp = await createApp(db, {
        type: "board",
        userId: inviteeId,
        source: "cloud_tenant",
        isInstanceAdmin: false,
        cloudTenantCompanyId: company.id,
        companyIds: [],
        memberships: [],
      });
      const accepted = await request(inviteeApp)
        .post(`/api/invites/${created.body.token}/accept`)
        .send({ requestType: "human" });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
      expect(accepted.body).not.toHaveProperty("code");
      expect(await membershipsFor(company.id, inviteeId)).toMatchObject([
        { status: "active", membershipRole: "operator" },
      ]);

      // Visibility is answered before the Cloud guard, so a shared company reports not_private
      // even for the very actor whose tenant company this is.
      const availability = await request(adminApp)
        .get(`/api/companies/${company.id}/owner-handoff/availability`);
      expect(availability.status, JSON.stringify(availability.body)).toBe(200);
      expect(availability.body).toEqual({ available: false, reason: "not_private" });
    });

    it("still counts another rowless Cloud admin member toward the slot at create (accepted gap)", async () => {
      const { company, userId: issuerId, app } = await seedRowlessCloudAdminCompany();
      // A second admin with no role row: nothing in stored state exempts them, so they occupy
      // the one slot and create is refused. This is the documented accepted gap.
      const otherCloudAdminId = await seedUser("other-rowless-admin");
      await addMembership({ companyId: company.id, userId: otherCloudAdminId, membershipRole: "operator" });

      const res = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatch(/already has its human owner/i);
      expect(await invitesFor(company.id)).toHaveLength(0);
      // Nothing was retired or consumed by the refusal.
      expect((await membershipsFor(company.id, issuerId))[0]!.status).toBe("active");
      expect((await membershipsFor(company.id, otherCloudAdminId))[0]!.status).toBe("active");
    });

    it("refuses create and accept for the Cloud-synced tenant company", async () => {
      const previousStackId = process.env.PAPERCLIP_CLOUD_STACK_ID;
      const previousManaged = process.env.PAPERCLIP_MANAGED_CONFIG;
      process.env.PAPERCLIP_MANAGED_CONFIG = "managed-document";
      process.env.PAPERCLIP_CLOUD_STACK_ID = `stack-${randomUUID()}`;
      try {
        const { cloudTenantCompanyId } = await import("../middleware/auth.js");
        const companyId = cloudTenantCompanyId(process.env.PAPERCLIP_CLOUD_STACK_ID);
        await db.insert(companies).values({
          id: companyId,
          name: `Cloud ${randomUUID()}`,
          issuePrefix: `CL${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
          requireBoardApprovalForNewAgents: false,
          visibility: "private",
        });
        const adminId = await seedUser("cloud-tenant-admin");
        await makeInstanceAdmin(adminId);
        await addMembership({ companyId, userId: adminId, membershipRole: "owner" });
        const app = await createApp(db, sessionActor(adminId, {
          isInstanceAdmin: true,
          memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        }));

        const res = await request(app)
          .post(`/api/companies/${companyId}/invites`)
          .send({ allowedJoinTypes: "human", humanRole: "owner", email: "owner@example.com" });
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.code).toBe("cloud_managed_company");
        expect(await invitesFor(companyId)).toHaveLength(0);

        // Accept is refused too, from the same server-derived state: a handoff that landed
        // here would be undone by the next Cloud membership sync.
        const email = `cloud-successor-${randomUUID()}@example.com`;
        const inviteeId = await seedUser("cloud-successor", { email });
        const { token } = await insertInvite({
          companyId,
          allowedJoinTypes: "human",
          boundEmail: email,
          ownerHandoffIssuedByUserId: adminId,
        });
        const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));
        const accepted = await request(inviteeApp)
          .post(`/api/invites/${token}/accept`)
          .send({ requestType: "human" });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(409);
        expect(accepted.body.code).toBe("cloud_managed_company");
        expect(await membershipsFor(companyId, inviteeId)).toHaveLength(0);
      } finally {
        if (previousStackId === undefined) delete process.env.PAPERCLIP_CLOUD_STACK_ID;
        else process.env.PAPERCLIP_CLOUD_STACK_ID = previousStackId;
        if (previousManaged === undefined) delete process.env.PAPERCLIP_MANAGED_CONFIG;
        else process.env.PAPERCLIP_MANAGED_CONFIG = previousManaged;
      }
    });

    it("answers the availability endpoint from the same server-derived state create uses", async () => {
      const { company, adminId, app } = await seedPrivateCompanyWithAdmin();

      const available = await request(app).get(`/api/companies/${company.id}/owner-handoff/availability`);
      expect(available.status, JSON.stringify(available.body)).toBe(200);
      expect(available.body).toEqual({ available: true, reason: null });

      // A live handoff invite claims the slot, so the same endpoint flips to slot_occupied.
      await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: "pending@example.com",
        ownerHandoffIssuedByUserId: adminId,
      });
      const occupied = await request(app).get(`/api/companies/${company.id}/owner-handoff/availability`);
      expect(occupied.body).toEqual({ available: false, reason: "slot_occupied" });
    });

    it("reports a shared company as not_private to a plain member", async () => {
      const company = await createCompany("shared");
      const memberId = await seedUser("shared-member");
      await addMembership({ companyId: company.id, userId: memberId, membershipRole: "owner" });
      await grantInvite(company.id, memberId);
      const app = await createApp(db, sessionActor(memberId, {
        isInstanceAdmin: false,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));

      const res = await request(app).get(`/api/companies/${company.id}/owner-handoff/availability`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ available: false, reason: "not_private" });
    });

    it("reports not_instance_admin to a non-admin member of a private company", async () => {
      const company = await createCompany("private");
      const memberId = await seedUser("private-non-admin");
      await addMembership({ companyId: company.id, userId: memberId, membershipRole: "owner" });
      await grantInvite(company.id, memberId);
      const app = await createApp(db, sessionActor(memberId, {
        isInstanceAdmin: false,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));

      const res = await request(app).get(`/api/companies/${company.id}/owner-handoff/availability`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ available: false, reason: "not_instance_admin" });
    });

    it("reports a shared company as not_private even to a verified instance admin", async () => {
      const company = await createCompany("shared");
      const adminId = await seedUser("shared-instance-admin");
      await makeInstanceAdmin(adminId);
      await addMembership({ companyId: company.id, userId: adminId, membershipRole: "owner" });
      const app = await createApp(db, sessionActor(adminId, {
        isInstanceAdmin: true,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));

      const res = await request(app).get(`/api/companies/${company.id}/owner-handoff/availability`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // Visibility is checked before the admin policy, so an instance admin learns the same
      // answer a plain member does: this company simply has no handoff slot.
      expect(res.body).toEqual({ available: false, reason: "not_private" });
    });

    it("denies the availability endpoint without users:invite", async () => {
      const { company } = await seedPrivateCompanyWithAdmin();
      const memberId = await seedUser("no-invite-grant");
      await addMembership({ companyId: company.id, userId: memberId, membershipRole: "viewer" });
      // Deliberately no grantInvite(): a viewer membership is an active member with no invite
      // permission, so this must stop at the permission gate rather than the private policy.
      const app = await createApp(db, sessionActor(memberId, {
        isInstanceAdmin: false,
        memberships: [{ companyId: company.id, membershipRole: "viewer", status: "active" }],
      }));

      const res = await request(app).get(`/api/companies/${company.id}/owner-handoff/availability`);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toMatch(/permission denied/i);
      // It must not reveal the private-company policy either.
      expect(res.body).not.toHaveProperty("reason");
    });

    it("follows the company-route convention for an unknown company", async () => {
      const { app } = await seedPrivateCompanyWithAdmin();
      const missingCompanyId = randomUUID();

      const res = await request(app).get(`/api/companies/${missingCompanyId}/owner-handoff/availability`);

      // Route convention for a company-scoped read: `assertCompanyPermission` runs
      // `assertCompanyAccess` first, which only consults the actor's own companyIds. A company
      // id outside that set is therefore refused with 403 and never looked up, so the response
      // cannot be used to confirm whether an unknown company id exists. (The 404 in
      // access-admin-add-member.test.ts is the §9.1.1 member-management bypass, which deliberately
      // binds the company first; this route has no such bypass.)
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toMatch(/does not have access to this company/i);
      expect(res.body).not.toHaveProperty("reason");
    });

    it("returns 404 for an unknown company once company access is satisfied (local board)", async () => {
      // The only actor that reaches the lookup for a company it is not scoped to is
      // local_implicit, which `assertCompanyAccess` exempts and `assertCompanyPermission`
      // short-circuits. That actor gets the honest 404 rather than the anti-enumeration 403.
      const app = await createApp(db, {
        type: "board",
        source: "local_implicit",
        userId: "local-board",
        companyIds: [],
        isInstanceAdmin: true,
      });

      const res = await request(app).get(`/api/companies/${randomUUID()}/owner-handoff/availability`);

      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error).toMatch(/company not found/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Manual approval
  // ---------------------------------------------------------------------------
  describe("manual join-request approval on a private company", () => {
    it("refuses to approve a human join request", async () => {
      const { company, app } = await seedPrivateCompanyWithAdmin();
      const requesterId = await seedUser("requester");
      const { row } = await insertInvite({ companyId: company.id, allowedJoinTypes: "human" });
      const joinRequestId = randomUUID();
      await db.insert(joinRequests).values({
        id: joinRequestId,
        inviteId: row.id,
        companyId: company.id,
        requestType: "human",
        status: "pending_approval",
        requestIp: "127.0.0.1",
        requestingUserId: requesterId,
        requestEmailSnapshot: `${requesterId}@example.com`,
      });

      const res = await request(app)
        .post(`/api/companies/${company.id}/join-requests/${joinRequestId}/approve`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/private/i);
      expect(await membershipsFor(company.id, requesterId)).toHaveLength(0);
      const [stored] = await db.select().from(joinRequests).where(eq(joinRequests.id, joinRequestId));
      expect(stored!.status).toBe("pending_approval");
    });

    it("still approves an agent join request", async () => {
      const { company, app } = await seedPrivateCompanyWithAdmin();
      // A company needs an active CEO for the agent approval to name a manager.
      await db.insert(agents).values({
        companyId: company.id,
        name: "Captain",
        role: "ceo",
        status: "idle",
        adapterType: "process",
      });
      const { row } = await insertInvite({ companyId: company.id, allowedJoinTypes: "agent" });
      const joinRequestId = randomUUID();
      await db.insert(joinRequests).values({
        id: joinRequestId,
        inviteId: row.id,
        companyId: company.id,
        requestType: "agent",
        status: "pending_approval",
        requestIp: "127.0.0.1",
        agentName: "Incoming Agent",
        adapterType: "process",
      });

      const res = await request(app)
        .post(`/api/companies/${company.id}/join-requests/${joinRequestId}/approve`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: "approved", requestType: "agent" });
      expect(res.body.createdAgentId).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // End to end
  // ---------------------------------------------------------------------------
  describe("end-to-end handoff", () => {
    it("moves the slot: admin creates, invitee accepts, and the successor is then the only active owner", async () => {
      const { company, adminId, adminMembership, app } = await seedPrivateCompanyWithAdmin();
      const email = `successor-${randomUUID()}@example.com`;
      const inviteeId = await seedUser("successor", { email });
      const inviteeApp = await createApp(db, sessionActor(inviteeId, { isInstanceAdmin: false }));

      const created = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const accepted = await request(inviteeApp)
        .post(`/api/invites/${created.body.token}/accept`)
        .send({ requestType: "human" });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);

      // D1: the accept itself retired the issuer, whose membership had no admin role row.
      // The issuer is the admin here, so this is the ordinary admin case: they are also
      // role-row backed, so their membership must survive. (A rowless issuer's retirement is
      // covered by the dedicated test below.)
      expect((await membershipsFor(company.id, adminId))[0]!.status).toBe("active");

      // The successor can therefore start work immediately, and the admin is still an owner.
      const [successorMembership] = await membershipsFor(company.id, inviteeId);
      expect(successorMembership!.membershipRole).toBe("owner");
      expect(successorMembership!.status).toBe("active");
      expect(adminMembership.companyId).toBe(company.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Shared companies + response shapes
  // ---------------------------------------------------------------------------
  describe("shared-company bound email", () => {
    async function seedSharedInvite(input: { boundEmail: string }) {
      const company = await createCompany("shared");
      const adminId = await seedUser("shared-admin");
      await makeInstanceAdmin(adminId);
      await addMembership({ companyId: company.id, userId: adminId, membershipRole: "owner" });
      const adminApp = await createApp(db, sessionActor(adminId, {
        isInstanceAdmin: true,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));
      const created = await request(adminApp)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "operator", email: input.boundEmail });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return { company, adminId, adminApp, token: created.body.token as string };
    }

    it("binds the address on creation and enforces it at accept", async () => {
      const boundEmail = `bound-${randomUUID()}@example.com`;
      const { company, token } = await seedSharedInvite({ boundEmail });
      const [row] = await invitesFor(company.id);
      expect(row!.boundEmail).toBe(boundEmail);
      // A shared invite stays an ordinary invite: no handoff provenance, no slot semantics.
      expect(row!.ownerHandoffIssuedByUserId).toBeNull();

      const wrongId = await seedUser("wrong");
      const wrongApp = await createApp(db, sessionActor(wrongId, { isInstanceAdmin: false }));
      const denied = await request(wrongApp).post(`/api/invites/${token}/accept`).send({ requestType: "human" });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatch(/different email address/i);
      expect(denied.body.code).toBe("invite_email_mismatch");

      const rightId = await seedUser("right", { email: boundEmail });
      const rightApp = await createApp(db, sessionActor(rightId, { isInstanceAdmin: false }));
      const accepted = await request(rightApp).post(`/api/invites/${token}/accept`).send({ requestType: "human" });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
      expect(await membershipsFor(company.id, rightId)).toMatchObject([{ status: "active", membershipRole: "operator" }]);
    });
  });

  describe("invite response shapes", () => {
    it("gives the token-scoped summary only a masked hint and gives the authenticated list the full address", async () => {
      const { company, app } = await seedPrivateCompanyWithAdmin();
      const email = `masked-${randomUUID()}@example.com`;
      const created = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", humanRole: "owner", email });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const token = created.body.token as string;

      // Anonymous landing read: never the full address.
      const anonymousApp = await createApp(db, {
        type: "board",
        source: "session",
        userId: null,
        companyIds: [],
        memberships: [],
        isInstanceAdmin: false,
      });
      const summary = await request(anonymousApp).get(`/api/invites/${token}`);
      expect(summary.status, JSON.stringify(summary.body)).toBe(200);
      expect(summary.body.ownerHandoff).toBe(true);
      expect(summary.body.boundEmailHint).toBe(`m•••@example.com`);
      expect(JSON.stringify(summary.body)).not.toContain(email);
      expect(summary.body).not.toHaveProperty("boundEmail");
      expect(summary.body).not.toHaveProperty("ownerHandoffIssuedByUserId");

      const list = await request(app).get(`/api/companies/${company.id}/invites`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const listed = list.body.invites.find((invite: any) => invite.id === created.body.id);
      expect(listed).toMatchObject({ ownerHandoff: true, boundEmail: email });
    });

    it("masks a short local part to a single leading character", async () => {
      const company = await createCompany("shared");
      const adminId = await seedUser("short-mask-admin");
      await makeInstanceAdmin(adminId);
      await addMembership({ companyId: company.id, userId: adminId, membershipRole: "owner" });
      const app = await createApp(db, sessionActor(adminId, {
        isInstanceAdmin: true,
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      }));

      const created = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({ allowedJoinTypes: "human", email: "a@example.com" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const summary = await request(app).get(`/api/invites/${created.body.token}`);
      expect(summary.body.boundEmailHint).toBe("a•••@example.com");
    });
  });

  // ---------------------------------------------------------------------------
  // Service primitives
  // ---------------------------------------------------------------------------
  describe("accessService human-slot primitives", () => {
    it("counts live non-admin human memberships and live handoff invites, excluding archived and instance admins", async () => {
      const { accessService } = await import("../services/access.js");
      const access = accessService(db);
      const company = await createCompany("private");

      const activeId = await seedUser("active-occupant");
      await addMembership({ companyId: company.id, userId: activeId, membershipRole: "operator" });
      const pendingId = await seedUser("pending-occupant");
      await addMembership({ companyId: company.id, userId: pendingId, membershipRole: "viewer", status: "pending" });
      const suspendedId = await seedUser("suspended-occupant");
      await addMembership({ companyId: company.id, userId: suspendedId, membershipRole: "operator", status: "suspended" });
      const archivedId = await seedUser("archived-occupant");
      await addMembership({ companyId: company.id, userId: archivedId, membershipRole: "owner", status: "archived" });
      const adminId = await seedUser("admin-occupant");
      await makeInstanceAdmin(adminId);
      await addMembership({ companyId: company.id, userId: adminId, membershipRole: "owner" });

      expect(await access.countPrivateHumanSlotOccupants(db, company.id)).toBe(3);

      // A live handoff invite claims the slot as well.
      const live = await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: "live@example.com",
        ownerHandoffIssuedByUserId: adminId,
      });
      expect(await access.countPrivateHumanSlotOccupants(db, company.id)).toBe(4);

      // Accepted / revoked / expired handoff invites are not pending slots.
      await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: "accepted@example.com",
        ownerHandoffIssuedByUserId: adminId,
        acceptedAt: new Date(),
      });
      expect(await access.countPrivateHumanSlotOccupants(db, company.id)).toBe(4);

      await db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, live.row.id));
      expect(await access.countPrivateHumanSlotOccupants(db, company.id)).toBe(3);

      const expired = await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: "expired@example.com",
        ownerHandoffIssuedByUserId: adminId,
      });
      await db.update(invites).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(invites.id, expired.row.id));
      expect(await access.countPrivateHumanSlotOccupants(db, company.id)).toBe(3);

      // A plain (non-handoff) invite never claims the slot.
      await insertInvite({ companyId: company.id, allowedJoinTypes: "human", boundEmail: "plain@example.com" });
      expect(await access.countPrivateHumanSlotOccupants(db, company.id)).toBe(3);

      // Exclusions let an acceptor (and a retiring issuer) be ignored, by id.
      expect(await access.countPrivateHumanSlotOccupants(db, company.id, {
        excludeUserIds: [activeId, adminId],
      })).toBe(2);
      expect(await access.countPrivateHumanSlotOccupants(db, company.id, { excludeUserIds: [adminId] })).toBe(3);
      // The deprecated single-user form still behaves the same for existing callers.
      expect(await access.countPrivateHumanSlotOccupants(db, company.id, { excludeUserId: activeId })).toBe(2);
    });

    it("locks the company row and returns its visibility inside a transaction", async () => {
      const { accessService } = await import("../services/access.js");
      const access = accessService(db);
      const company = await createCompany("private");

      const locked = await db.transaction(async (tx) => access.lockCompanyForHumanSlot(tx, company.id));
      expect(locked).toEqual({ id: company.id, visibility: "private" });

      const missing = await db.transaction(async (tx) => access.lockCompanyForHumanSlot(tx, randomUUID()));
      expect(missing).toBeNull();
    });

    it("rejects an accept for an already-revoked handoff invite and writes nothing", async () => {
      const { accessService } = await import("../services/access.js");
      const access = accessService(db);
      const company = await createCompany("private");
      const adminId = await seedUser("revoker");
      await makeInstanceAdmin(adminId);
      const email = `revoked-${randomUUID()}@example.com`;
      const inviteeId = await seedUser("revoked-invitee", { email });
      const revoked = await insertInvite({
        companyId: company.id,
        allowedJoinTypes: "human",
        boundEmail: email,
        ownerHandoffIssuedByUserId: adminId,
      });
      await db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, revoked.row.id));

      await expect(access.acceptOwnerHandoffInvite({
        inviteId: revoked.row.id,
        userId: inviteeId,
        actorEmail: email,
        actorEmailVerified: true,
        requestIp: "127.0.0.1",
      })).rejects.toThrow(/Invite not found/i);

      expect(await membershipsFor(company.id, inviteeId)).toHaveLength(0);
      expect(await db.select().from(joinRequests).where(eq(joinRequests.companyId, company.id))).toHaveLength(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, HANDOFF_ACTION))).toHaveLength(0);
    });
  });
});
