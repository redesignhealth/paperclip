import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  agentOwnershipGrants,
  agentOwnershipTransfers,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { agentOwnershipService } from "../services/agent-ownership.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent ownership tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent ownership (TECH-4929 stage 1: data model + write-on-create)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-ownership");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentOwnershipTransfers);
    await db.delete(agentOwnershipGrants);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function activeOwnerRows(agentId: string) {
    return db
      .select()
      .from(agentOwnershipGrants)
      .where(
        and(
          eq(agentOwnershipGrants.agentId, agentId),
          eq(agentOwnershipGrants.role, "owner"),
          isNull(agentOwnershipGrants.revokedAt),
        ),
      );
  }

  it("writes an owner on every svc.create call that supplies ownerUserId, including the agent-created-agent path", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const humanUserId = `user-${randomUUID()}`;
    const agentActorUserId = `run-responsible-user-${randomUUID()}`;

    const humanCreated = await svc.create(
      companyId,
      {
        name: "Human-Created Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId: humanUserId, ownershipSource: "agent_create" },
    );

    const agentCreatedAgent = await svc.create(
      companyId,
      {
        name: "Agent-Created Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId: agentActorUserId, ownershipSource: "agent_created_default" },
    );

    const humanOwnerRows = await activeOwnerRows(humanCreated.id);
    expect(humanOwnerRows).toHaveLength(1);
    expect(humanOwnerRows[0]).toMatchObject({ principalId: humanUserId, principalType: "user" });

    const agentOwnerRows = await activeOwnerRows(agentCreatedAgent.id);
    expect(agentOwnerRows).toHaveLength(1);
    expect(agentOwnerRows[0]).toMatchObject({
      principalId: agentActorUserId,
      source: "agent_created_default",
    });
  });

  it("refuses to write ownership without a resolvable owner user id", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    await expect(
      svc.create(
        companyId,
        {
          name: "No Owner Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        { ownerUserId: "   " },
      ),
    ).rejects.toThrow();
  });

  it("enforces exactly one active owner per agent at the database level", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const agent = await svc.create(
      companyId,
      {
        name: "Owned Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId: `user-${randomUUID()}` },
    );

    // A second concurrent "active owner" row for the same agent must be
    // rejected by the partial unique index, not merely by application code.
    await expect(
      db.insert(agentOwnershipGrants).values({
        id: randomUUID(),
        companyId,
        agentId: agent.id,
        principalType: "user",
        principalId: `user-${randomUUID()}`,
        role: "owner",
        source: "manual_grant",
      }),
    ).rejects.toThrow();
  });

  it("ownership transfer requires acceptance and never leaves a zero-owner window", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const ownership = agentOwnershipService(db);
    const fromUserId = `user-${randomUUID()}`;
    const toUserId = `user-${randomUUID()}`;

    const agent = await svc.create(
      companyId,
      {
        name: "Transfer Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId: fromUserId },
    );

    const transfer = await ownership.proposeTransfer({
      companyId,
      agentId: agent.id,
      toUserId,
      proposedByUserId: fromUserId,
    });
    expect(transfer.status).toBe("pending");

    // Ownership has NOT moved yet -- proposing alone must not change who
    // owns the agent.
    const ownerBeforeAccept = await ownership.getActiveOwner(agent.id);
    expect(ownerBeforeAccept?.principalId).toBe(fromUserId);

    // A non-recipient cannot accept on the recipient's behalf.
    await expect(
      ownership.acceptTransfer({ transferId: transfer.id, acceptingUserId: fromUserId }),
    ).rejects.toThrow();

    await ownership.acceptTransfer({ transferId: transfer.id, acceptingUserId: toUserId });

    const ownerAfterAccept = await ownership.getActiveOwner(agent.id);
    expect(ownerAfterAccept?.principalId).toBe(toUserId);

    // Exactly one active owner at all times -- never zero, never two.
    const activeOwners = await activeOwnerRows(agent.id);
    expect(activeOwners).toHaveLength(1);

    // The outgoing owner's grant is revoked, not deleted.
    const allGrants = await db
      .select()
      .from(agentOwnershipGrants)
      .where(eq(agentOwnershipGrants.agentId, agent.id));
    const revokedGrant = allGrants.find((row) => row.principalId === fromUserId);
    expect(revokedGrant).toBeTruthy();
    expect(revokedGrant?.revokedAt).not.toBeNull();
  });

  it("revocation of a non-owner role sets revoked_at rather than deleting the row", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const ownership = agentOwnershipService(db);
    const ownerUserId = `user-${randomUUID()}`;
    const memberUserId = `user-${randomUUID()}`;

    const agent = await svc.create(
      companyId,
      {
        name: "Role Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId },
    );

    const granted = await ownership.setRole({
      companyId,
      agentId: agent.id,
      principalType: "user",
      principalId: memberUserId,
      role: "user",
      grantedByUserId: ownerUserId,
    });

    await ownership.revokeRole({
      agentId: agent.id,
      principalType: "user",
      principalId: memberUserId,
      revokedByUserId: ownerUserId,
    });

    const rows = await db
      .select()
      .from(agentOwnershipGrants)
      .where(eq(agentOwnershipGrants.id, granted.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();

    // Owner role can never be revoked through this path.
    await expect(
      ownership.revokeRole({
        agentId: agent.id,
        principalType: "user",
        principalId: ownerUserId,
        revokedByUserId: ownerUserId,
      }).then(async () => activeOwnerRows(agent.id)),
    ).resolves.toHaveLength(1);
  });

  it("role changes are recorded as a new transition row, not an overwrite of the old one", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const ownership = agentOwnershipService(db);
    const ownerUserId = `user-${randomUUID()}`;
    const memberUserId = `user-${randomUUID()}`;

    const agent = await svc.create(
      companyId,
      {
        name: "Transition Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId },
    );

    const asUser = await ownership.setRole({
      companyId,
      agentId: agent.id,
      principalType: "user",
      principalId: memberUserId,
      role: "user",
      grantedByUserId: ownerUserId,
    });
    const asAdmin = await ownership.setRole({
      companyId,
      agentId: agent.id,
      principalType: "user",
      principalId: memberUserId,
      role: "admin",
      grantedByUserId: ownerUserId,
    });

    expect(asAdmin.transitionFromGrantId).toBe(asUser.id);

    const rows = await db
      .select()
      .from(agentOwnershipGrants)
      .where(eq(agentOwnershipGrants.id, asUser.id));
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[0].revokedReason).toBe("role_change");
  });
});
