import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

// Regression coverage for the removal of the upstream (PR #3040)
// auto-provisioning path that used to grant any authenticated user with zero
// company memberships active membership in *every* company on the instance.
// That path fired for brand-new SSO users, invited-but-not-yet-accepted
// users, and users whose memberships had been deliberately revoked alike --
// all three must now land with empty company access instead of being
// re-granted access.

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb(input: { roleRows?: unknown[]; membershipRows?: unknown[] }) {
  const insert = vi.fn(() => {
    throw new Error("actorMiddleware must not write company memberships while resolving a session actor");
  });
  const select = vi
    .fn()
    .mockImplementationOnce(() => createSelectChain(input.roleRows ?? []))
    .mockImplementationOnce(() => createSelectChain(input.membershipRows ?? []));
  return { select, insert } as any;
}

async function actorFor(db: unknown, userId: string) {
  const app = express();
  app.use(
    actorMiddleware(db as any, {
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: `session-${userId}`, userId },
        user: { id: userId, name: "Test User", email: `${userId}@example.com` },
      }),
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return request(app).get("/actor");
}

describe("actorMiddleware / zero-membership users (auto-provisioning removed)", () => {
  it("does not grant a brand-new user with zero memberships access to any company", async () => {
    const db = createDb({ roleRows: [], membershipRows: [] });

    const res = await actorFor(db, "new-user-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "new-user-1",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    });
    // The old code inserted a companyMemberships row per existing company;
    // confirm no writes happen at all on this path any more.
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("leaves an existing active member's access unaffected", async () => {
    const membershipRow = { companyId: "company-1", membershipRole: "member", status: "active" };
    const db = createDb({ roleRows: [], membershipRows: [membershipRow] });

    const res = await actorFor(db, "existing-member-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyIds: ["company-1"],
      memberships: [membershipRow],
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("keeps a user whose membership was revoked without company access", async () => {
    // The active-membership query in actorMiddleware filters on
    // companyMemberships.status === "active", so a user whose sole membership
    // was revoked resolves the same empty membership list as a brand-new
    // user. The defect under test was that *any* empty list triggered
    // re-provisioning into every company -- assert that no longer happens,
    // i.e. the revocation sticks instead of being silently undone on login.
    const db = createDb({ roleRows: [], membershipRows: [] });

    const res = await actorFor(db, "revoked-user-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyIds: [],
      memberships: [],
    });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
