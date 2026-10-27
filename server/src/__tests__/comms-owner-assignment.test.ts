import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import {
  COMMS_OWNER_ASSIGNMENT_CONFIRMATION,
  CommsOwnerAssignmentConfirmationError,
  CommsOwnerAssignmentInvalidInputError,
  assignCommsBoardOwner,
} from "../services/comms-owner-assignment.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

describeEmbeddedPostgres("comms-board owner assignment for stuck entries", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("comms-owner-assignment");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(principalPermissionGrants);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(status: "active" | "archived" = "active") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status,
    });
    return companyId;
  }

  async function seedUser(companyId: string | null, opts: { verified?: boolean; membership?: "active" | "suspended" | "none" } = {}) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Dan", email: `dan-${userId}@redesignhealth.com`, emailVerified: opts.verified ?? true, createdAt: now, updatedAt: now });
    if (companyId && (opts.membership ?? "active") !== "none") {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: opts.membership ?? "active", membershipRole: "owner" });
    }
    return userId;
  }

  function entry(setup: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      key: "comms-board",
      enabled: false,
      dedicated: true,
      ownerUserId: null,
      connectionId: null,
      setup: { state: "pending", reason: "owner_required", claimId: null, leaseUntil: null, attemptCount: 124, nextAttemptAt: FAR_FUTURE, ...setup },
      ...extra,
    };
  }

  async function seedAgent(companyId: string, commsEntry: unknown | null, opts: { status?: string; name?: string } = {}) {
    const metadata = commsEntry ? { defaultMcp: { version: 1, entries: { "comms-board": commsEntry, "arcana-brain": { key: "arcana-brain", setup: { state: "ready", reason: null } } } } } : {};
    const [row] = await db
      .insert(agents)
      .values({ companyId, name: opts.name ?? `agent-${randomUUID().slice(0, 6)}`, role: "general", adapterType: "process", adapterConfig: {}, status: (opts.status ?? "idle") as never, metadata })
      .returning();
    return row!.id;
  }

  async function commsOf(agentId: string) {
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId));
    return readDefaultMcpState(row!.metadata)!.entries["comms-board"]!;
  }

  const real = { dryRun: false, confirm: COMMS_OWNER_ASSIGNMENT_CONFIRMATION };

  it("a census (the default) reports would_assign and writes nothing", async () => {
    const companyId = await seedCompany();
    const caller = await seedUser(companyId);
    const a = await seedAgent(companyId, entry({}));
    const report = await assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [a] });
    expect(report.dryRun).toBe(true);
    expect(report.outcomes).toEqual([{ agentId: a, result: "would_assign" }]);
    expect((await commsOf(a)).ownerUserId).toBeNull();
  });

  it("a real run needs the exact confirmation string", async () => {
    const companyId = await seedCompany();
    const caller = await seedUser(companyId);
    const a = await seedAgent(companyId, entry({}));
    await expect(assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [a], dryRun: false })).rejects.toBeInstanceOf(CommsOwnerAssignmentConfirmationError);
    await expect(assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [a], dryRun: false, confirm: "nope" })).rejects.toBeInstanceOf(CommsOwnerAssignmentConfirmationError);
    expect((await commsOf(a)).ownerUserId).toBeNull();
  });

  it("assigns the caller and resets only the retry schedule for exactly the listed agents", async () => {
    const companyId = await seedCompany();
    const caller = await seedUser(companyId);
    const listed = await seedAgent(companyId, entry({}));
    const notListed = await seedAgent(companyId, entry({}));
    const now = new Date("2026-10-18T12:00:00.000Z");
    const report = await assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [listed], ...real, now: () => now });
    expect(report.outcomes).toEqual([{ agentId: listed, result: "assigned" }]);
    expect(report.counts.assigned).toBe(1);
    const after = await commsOf(listed);
    expect(after.ownerUserId).toBe(caller);
    expect(after.setup).toMatchObject({ state: "pending", reason: "owner_required", attemptCount: 0, nextAttemptAt: now.toISOString() });
    expect(after.binding ?? null).toBeNull();
    // Untouched: the other agent, and the sibling arcana-brain entry of the listed one.
    expect((await commsOf(notListed)).ownerUserId).toBeNull();
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, listed));
    expect(readDefaultMcpState(row!.metadata)!.entries["arcana-brain"]).toEqual({ key: "arcana-brain", setup: { state: "ready", reason: null } });
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, listed));
    expect(events.map((e) => e.action)).toEqual(["agent.default_mcp.comms_owner_assigned"]);
    expect(events[0]!.details).toEqual({ key: "comms-board", ownerUserId: caller });
  });

  it("is idempotent: a second run reports already_has_owner and changes nothing", async () => {
    const companyId = await seedCompany();
    const caller = await seedUser(companyId);
    const a = await seedAgent(companyId, entry({}));
    await assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [a], ...real });
    const first = await commsOf(a);
    const again = await assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [a], ...real });
    expect(again.outcomes).toEqual([{ agentId: a, result: "already_has_owner" }]);
    expect(await commsOf(a)).toEqual(first);
  });

  it("never replaces an existing owner", async () => {
    const companyId = await seedCompany();
    const caller = await seedUser(companyId);
    const a = await seedAgent(companyId, entry({}, { ownerUserId: "someone-else" }));
    const report = await assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [a], ...real });
    expect(report.outcomes).toEqual([{ agentId: a, result: "already_has_owner" }]);
    expect((await commsOf(a)).ownerUserId).toBe("someone-else");
  });

  it("an ineligible caller (not a member, suspended, unverified email, no user id) changes nothing", async () => {
    const companyId = await seedCompany();
    const a = await seedAgent(companyId, entry({}));
    const outsider = await seedUser(null);
    const suspended = await seedUser(companyId, { membership: "suspended" });
    const unverified = await seedUser(companyId, { verified: false });
    for (const ownerUserId of [outsider, suspended, unverified, null]) {
      const report = await assignCommsBoardOwner(db, { companyId, ownerUserId, agentIds: [a], ...real });
      expect(report.outcomes).toEqual([{ agentId: a, result: "owner_ineligible" }]);
    }
    expect((await commsOf(a)).ownerUserId).toBeNull();
  });

  it("only touches entries that are pending with reason owner_required", async () => {
    const companyId = await seedCompany();
    const caller = await seedUser(companyId);
    const ready = await seedAgent(companyId, entry({ state: "ready", reason: null }));
    const conflict = await seedAgent(companyId, entry({ reason: "board_conflict" }));
    const errored = await seedAgent(companyId, entry({ state: "error", reason: "mint_unknown" }));
    const noEntry = await seedAgent(companyId, null);
    const report = await assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [ready, conflict, errored, noEntry], ...real });
    expect(Object.fromEntries(report.outcomes.map((o) => [o.agentId, o.result]))).toEqual({
      [ready]: "skipped_not_owner_required",
      [conflict]: "skipped_not_owner_required",
      [errored]: "skipped_not_owner_required",
      [noEntry]: "skipped_no_entry",
    });
    for (const id of [ready, conflict, errored]) expect((await commsOf(id)).ownerUserId).toBeNull();
  });

  it("skips terminated agents and archived companies, and treats a foreign-company id as not in the company", async () => {
    const companyId = await seedCompany();
    const caller = await seedUser(companyId);
    const terminated = await seedAgent(companyId, entry({}), { status: "terminated" });
    const otherCompany = await seedCompany();
    const foreign = await seedAgent(otherCompany, entry({}));
    const report = await assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [terminated, foreign, randomUUID()], ...real });
    expect(report.outcomes.map((o) => o.result)).toEqual(["skipped_terminated", "agent_not_in_company", "agent_not_in_company"]);
    expect((await commsOf(foreign)).ownerUserId).toBeNull();

    const archivedCompany = await seedCompany("archived");
    const archivedCaller = await seedUser(archivedCompany);
    const inArchived = await seedAgent(archivedCompany, entry({}));
    const archivedReport = await assignCommsBoardOwner(db, { companyId: archivedCompany, ownerUserId: archivedCaller, agentIds: [inArchived], ...real });
    expect(archivedReport.outcomes).toEqual([{ agentId: inArchived, result: "skipped_company_archived" }]);
  });

  it("a concurrent change between the read and the write loses cleanly (no overwrite)", async () => {
    const companyId = await seedCompany();
    const caller = await seedUser(companyId);
    const a = await seedAgent(companyId, entry({}));
    // Two runs racing: exactly one assigns, the other observes the owner (already_has_owner) or loses the guarded write.
    const [one, two] = await Promise.all([
      assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [a], ...real }),
      assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [a], ...real }),
    ]);
    const results = [one.outcomes[0]!.result, two.outcomes[0]!.result];
    expect(results.filter((r) => r === "assigned")).toHaveLength(1);
    expect((await commsOf(a)).ownerUserId).toBe(caller);
  });

  it("validates the agent id list", async () => {
    const companyId = await seedCompany();
    const caller = await seedUser(companyId);
    await expect(assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: [] })).rejects.toBeInstanceOf(CommsOwnerAssignmentInvalidInputError);
    await expect(assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: ["nope"] })).rejects.toBeInstanceOf(CommsOwnerAssignmentInvalidInputError);
    await expect(assignCommsBoardOwner(db, { companyId, ownerUserId: caller, agentIds: Array.from({ length: 26 }, () => randomUUID()) })).rejects.toBeInstanceOf(CommsOwnerAssignmentInvalidInputError);
  });
});
