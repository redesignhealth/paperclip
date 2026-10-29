import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { clearBootProvisionerSnapshot, installBootProvisionerSnapshot, OWNERSHIP_TOKEN, OWNERSHIP_URL } from "./helpers/comms-board-downstream.js";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
} from "../services/comms-board-provisioner-client.js";
import { BOARD_ADMIN_TOKEN, BOARD_URL } from "./helpers/comms-board-downstream.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import {
  COMMS_OWNER_SYNC_CONFIRMATION,
  CommsOwnerSyncConfirmationError,
  CommsOwnerSyncInProgressError,
  syncCommsOwner,
} from "../services/comms-owner-sync.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const envKeys = [COMMS_BOARD_MCP_URL_ENV, COMMS_BOARD_ADMIN_TOKEN_ENV, COMMS_BOARD_OWNERSHIP_API_URL_ENV, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV];

describeEmbeddedPostgres("comms-board owner sync follows the ownership registry", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("comms-owner-sync");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    clearBootProvisionerSnapshot();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
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

  function configure() {
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
  }

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

  async function seedUser(
    companyId: string | null,
    email: string,
    opts: { verified?: boolean; membership?: "active" | "suspended" | "none" } = {},
  ) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "User", email, emailVerified: opts.verified ?? true, createdAt: now, updatedAt: now });
    if (companyId && (opts.membership ?? "active") !== "none") {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: opts.membership ?? "active", membershipRole: "owner" });
    }
    return userId;
  }

  function entry(ownerUserId: string | null, overrides: { setup?: Record<string, unknown>; binding?: Record<string, unknown> | null; dedicated?: boolean } = {}) {
    return {
      key: "comms-board",
      enabled: true,
      dedicated: overrides.dedicated ?? true,
      ownerUserId,
      connectionId: randomUUID(),
      setup: { state: "ready", reason: null, claimId: null, leaseUntil: null, attemptCount: 0, nextAttemptAt: null, ...overrides.setup },
      binding:
        overrides.binding === null
          ? null
          : {
              boardAgentId: randomUUID(),
              baseSub: "paperclip-agent-abc",
              boardSub: "paperclip-agent-abc",
              secretId: "secret-1",
              connectionId: randomUUID(),
              grantId: randomUUID(),
              ...overrides.binding,
            },
    };
  }

  async function seedAgent(companyId: string, commsEntry: unknown, opts: { status?: string } = {}) {
    const metadata = commsEntry ? { defaultMcp: { version: 1, entries: { "comms-board": commsEntry } } } : {};
    const [row] = await db
      .insert(agents)
      .values({ companyId, name: `agent-${randomUUID().slice(0, 6)}`, role: "general", adapterType: "process", adapterConfig: {}, status: (opts.status ?? "idle") as never, metadata })
      .returning();
    return row!.id;
  }

  async function ownerOf(agentId: string) {
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId));
    return readDefaultMcpState(row!.metadata)!.entries["comms-board"]!.ownerUserId ?? null;
  }

  function registryFetch(reply: { status?: number; body?: Record<string, unknown> | string }) {
    return vi.fn(async (_url: string, _init: RequestInit) => {
      const status = reply.status ?? 200;
      const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    });
  }

  const ok = (email: string, extra: Record<string, unknown> = {}) => ({
    body: { sub: "paperclip-agent-abc", owner_email: email, active: true, token_expires_at: null, ...extra },
  });
  const real = { dryRun: false, confirm: COMMS_OWNER_SYNC_CONFIRMATION };

  it("a census (the default) reads the registry, reports would_sync and writes nothing", async () => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    await seedUser(companyId, "new@redesignhealth.com");
    const a = await seedAgent(companyId, entry(oldOwner));
    const fetchImpl = registryFetch(ok("new@redesignhealth.com"));
    const report = await syncCommsOwner(db, { companyId, fetchImpl });
    expect(report.dryRun).toBe(true);
    expect(report.outcomes).toEqual([{ agentId: a, companyId, result: "would_sync", registrySub: "paperclip-agent-abc" }]);
    expect(await ownerOf(a)).toBe(oldOwner);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${OWNERSHIP_URL}/ownership/paperclip-agent-abc`);
    expect(init.method).toBe("GET");
  });

  it("a real run needs the exact confirmation string and makes no call without it", async () => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    const a = await seedAgent(companyId, entry(oldOwner));
    const fetchImpl = registryFetch(ok("old@redesignhealth.com"));
    await expect(syncCommsOwner(db, { companyId, dryRun: false, fetchImpl })).rejects.toBeInstanceOf(CommsOwnerSyncConfirmationError);
    await expect(syncCommsOwner(db, { companyId, dryRun: false, confirm: "nope", fetchImpl })).rejects.toBeInstanceOf(CommsOwnerSyncConfirmationError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await ownerOf(a)).toBe(oldOwner);
  });

  it("moves the stored owner to the registry owner (case-insensitive email) and logs the change", async () => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    const newOwner = await seedUser(companyId, "New.Person@RedesignHealth.com");
    const a = await seedAgent(companyId, entry(oldOwner));
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl: registryFetch(ok("new.person@redesignhealth.com")) });
    expect(report.counts.synced).toBe(1);
    expect(await ownerOf(a)).toBe(newOwner);
    const logs = await db.select().from(activityLog).where(eq(activityLog.action, "agent.default_mcp.comms_owner_synced"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.details).toEqual({ key: "comms-board", fromUserId: oldOwner, toUserId: newOwner });
    expect(JSON.stringify(logs[0]!.details)).not.toContain("@");
  });

  it("is idempotent: a second run reports already_current and makes no write", async () => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    await seedUser(companyId, "new@redesignhealth.com");
    await seedAgent(companyId, entry(oldOwner));
    const fetchImpl = registryFetch(ok("new@redesignhealth.com"));
    await syncCommsOwner(db, { companyId, ...real, fetchImpl });
    const second = await syncCommsOwner(db, { companyId, ...real, fetchImpl });
    expect(second.counts.already_current).toBe(1);
    expect(second.counts.synced).toBe(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "agent.default_mcp.comms_owner_synced"))).toHaveLength(1);
  });

  it("reports already_current when the registry owner is the stored owner", async () => {
    configure();
    const companyId = await seedCompany();
    const owner = await seedUser(companyId, "same@redesignhealth.com");
    await seedAgent(companyId, entry(owner));
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl: registryFetch(ok(" SAME@redesignhealth.com ")) });
    expect(report.counts.already_current).toBe(1);
  });

  it("fills an entry that has no stored owner when the registry owner is a member", async () => {
    configure();
    const companyId = await seedCompany();
    const newOwner = await seedUser(companyId, "new@redesignhealth.com");
    const a = await seedAgent(companyId, entry(null));
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl: registryFetch(ok("new@redesignhealth.com")) });
    expect(report.counts.synced).toBe(1);
    expect(await ownerOf(a)).toBe(newOwner);
  });

  it.each([
    ["no such user", async (_c: string) => undefined],
    ["unverified email", async (c: string) => { await seedUser(c, "new@redesignhealth.com", { verified: false }); }],
    ["suspended membership", async (c: string) => { await seedUser(c, "new@redesignhealth.com", { membership: "suspended" }); }],
    ["member of another company only", async (_c: string) => { await seedUser(await seedCompany(), "new@redesignhealth.com"); }],
    ["user without membership", async (c: string) => { await seedUser(c, "new@redesignhealth.com", { membership: "none" }); }],
  ])("changes nothing when the registry owner is not an eligible member (%s)", async (_label, arrange) => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    await arrange(companyId);
    const a = await seedAgent(companyId, entry(oldOwner));
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl: registryFetch(ok("new@redesignhealth.com")) });
    expect(report.counts.registry_owner_not_member).toBe(1);
    expect(await ownerOf(a)).toBe(oldOwner);
  });

  it("changes nothing when two members share the registry email", async () => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    await seedUser(companyId, "new@redesignhealth.com");
    await seedUser(companyId, "NEW@redesignhealth.com");
    const a = await seedAgent(companyId, entry(oldOwner));
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl: registryFetch(ok("new@redesignhealth.com")) });
    expect(report.counts.registry_owner_ambiguous).toBe(1);
    expect(await ownerOf(a)).toBe(oldOwner);
  });

  it.each([
    ["unknown sub", { status: 404, body: { detail: "unknown sub" } }, "registry_sub_unknown"],
    ["rejected token", { status: 403, body: { detail: "forbidden" } }, "registry_rejected"],
    ["unauthorized token", { status: 401, body: {} }, "registry_rejected"],
    ["server error", { status: 503, body: {} }, "registry_failed"],
    ["non-JSON body", { status: 200, body: "not json" }, "registry_failed"],
    ["reply for a different sub", { status: 200, body: { sub: "someone-else", owner_email: "new@redesignhealth.com", active: true } }, "registry_failed"],
    ["missing owner", { status: 200, body: { sub: "paperclip-agent-abc", active: true } }, "registry_failed"],
    ["inactive sub", { status: 200, body: { sub: "paperclip-agent-abc", owner_email: "new@redesignhealth.com", active: false } }, "registry_sub_inactive"],
  ])("classifies a registry %s without changing anything", async (_label, reply, expected) => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    await seedUser(companyId, "new@redesignhealth.com");
    const a = await seedAgent(companyId, entry(oldOwner));
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl: registryFetch(reply) });
    expect(report.outcomes[0]!.result).toBe(expected);
    expect(await ownerOf(a)).toBe(oldOwner);
  });

  it("classifies a network failure as registry_failed", async () => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    await seedAgent(companyId, entry(oldOwner));
    const fetchImpl = vi.fn(async () => { throw new Error("boom https://secret.example"); });
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl });
    expect(report.counts.registry_failed).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret.example");
  });

  it("fails closed with no HTTP call when the provisioner is not configured", async () => {
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    await seedAgent(companyId, entry(oldOwner));
    const fetchImpl = registryFetch(ok("new@redesignhealth.com"));
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl });
    expect(report.counts.provisioner_not_configured).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips ineligible agents without a registry call", async () => {
    configure();
    const companyId = await seedCompany();
    const owner = await seedUser(companyId, "old@redesignhealth.com");
    await seedAgent(companyId, entry(owner), { status: "terminated" });
    await seedAgent(companyId, null);
    await seedAgent(companyId, entry(owner, { setup: { state: "pending", reason: "owner_required" } }));
    await seedAgent(companyId, entry(owner, { dedicated: false }));
    await seedAgent(companyId, entry(owner, { binding: null }));
    const fetchImpl = registryFetch(ok("new@redesignhealth.com"));
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.counts.skipped_terminated).toBe(1);
    expect(report.counts.skipped_no_entry).toBe(1);
    expect(report.counts.skipped_not_ready).toBe(2);
    expect(report.counts.skipped_not_dedicated).toBe(1);
  });

  it("skips agents of an archived company", async () => {
    configure();
    const companyId = await seedCompany("archived");
    const owner = await seedUser(companyId, "old@redesignhealth.com");
    await seedAgent(companyId, entry(owner));
    const fetchImpl = registryFetch(ok("new@redesignhealth.com"));
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl });
    expect(report.counts.skipped_company_archived).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loses cleanly when the entry is rebound between the read and the write", async () => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    const newOwner = await seedUser(companyId, "new@redesignhealth.com");
    const a = await seedAgent(companyId, entry(oldOwner));
    const fetchImpl = vi.fn(async () => {
      // A concurrent reissue rebinds the entry to a different managed secret after the registry read started.
      await db.execute(sql`update agents set metadata = jsonb_set(metadata, '{defaultMcp,entries,comms-board,binding,secretId}', '"secret-2"') where id = ${a}`);
      return new Response(JSON.stringify(ok("new@redesignhealth.com").body), { status: 200 });
    });
    const report = await syncCommsOwner(db, { companyId, ...real, fetchImpl });
    expect(report.counts.lost_race).toBe(1);
    expect(await ownerOf(a)).toBe(oldOwner);
    expect(newOwner).not.toBe(oldOwner);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "agent.default_mcp.comms_owner_synced"))).toHaveLength(0);
  });

  it("only touches the owner: the binding and secret are unchanged", async () => {
    configure();
    const companyId = await seedCompany();
    const oldOwner = await seedUser(companyId, "old@redesignhealth.com");
    await seedUser(companyId, "new@redesignhealth.com");
    const a = await seedAgent(companyId, entry(oldOwner));
    const [before] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, a));
    await syncCommsOwner(db, { companyId, ...real, fetchImpl: registryFetch(ok("new@redesignhealth.com")) });
    const [after] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, a));
    const strip = (m: unknown) => {
      const clone = JSON.parse(JSON.stringify(m));
      delete clone.defaultMcp.entries["comms-board"].ownerUserId;
      return clone;
    };
    expect(strip(after!.metadata)).toEqual(strip(before!.metadata));
  });

  it("pages with a cursor, never beyond the batch limit", async () => {
    configure();
    const companyId = await seedCompany();
    const owner = await seedUser(companyId, "old@redesignhealth.com");
    for (let i = 0; i < 3; i += 1) await seedAgent(companyId, entry(owner));
    const first = await syncCommsOwner(db, { companyId, limit: 2, fetchImpl: registryFetch(ok("old@redesignhealth.com")) });
    expect(first.scanned).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await syncCommsOwner(db, { companyId, limit: 2, afterId: first.nextCursor!, fetchImpl: registryFetch(ok("old@redesignhealth.com")) });
    expect(second.scanned).toBe(1);
    expect(second.nextCursor).toBeNull();
  });

  it("does not touch another company's agents", async () => {
    configure();
    const companyId = await seedCompany();
    const otherCompany = await seedCompany();
    const owner = await seedUser(companyId, "old@redesignhealth.com");
    const otherOwner = await seedUser(otherCompany, "old@redesignhealth.com");
    await seedUser(companyId, "new@redesignhealth.com");
    const other = await seedAgent(otherCompany, entry(otherOwner));
    await seedAgent(companyId, entry(owner));
    await syncCommsOwner(db, { companyId, ...real, fetchImpl: registryFetch(ok("new@redesignhealth.com")) });
    expect(await ownerOf(other)).toBe(otherOwner);
  });

  it("refuses a second concurrent real run for the same company", async () => {
    configure();
    const companyId = await seedCompany();
    const owner = await seedUser(companyId, "old@redesignhealth.com");
    await seedAgent(companyId, entry(owner));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(ok("old@redesignhealth.com").body), { status: 200 });
    });
    const firstRun = syncCommsOwner(db, { companyId, ...real, fetchImpl: slow });
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    await expect(syncCommsOwner(db, { companyId, ...real, fetchImpl: registryFetch(ok("old@redesignhealth.com")) })).rejects.toBeInstanceOf(CommsOwnerSyncInProgressError);
    release();
    await firstRun;
  });
});
