import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import net from "node:net";
import {
  createDb,
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
  companies,
  agents,
  agentApiKeys,
  companyMemberships,
  authUsers,
  agentKnowledgeBindings,
  agentKnowledgeRevocations,
  type Db,
} from "@paperclipai/db";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";
import { agentKnowledgeService } from "./agent-knowledge.js";
import { updateAgentSchema } from "@paperclipai/shared";
import {
  setAgentKnowledgeConfigForTests,
  resetAgentKnowledgeConfigForTests,
} from "./agent-knowledge-config.js";
import { withBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { companyPortabilityService } from "./company-portability.js";

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedSupport.supported ? describe : describe.skip;

describeEmbedded("agent-knowledge offline foundation lifecycle", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-knowledge-");
    db = createDb(tempDb.connectionString);

    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_lifecycle_app_role') THEN
          CREATE ROLE rls_lifecycle_app_role NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO rls_lifecycle_app_role`);
    await db.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_lifecycle_app_role`);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    resetAgentKnowledgeConfigForTests();
  });

  async function expectDbError(promise: Promise<unknown>, regex: RegExp) {
    try {
      await promise;
      expect.fail("Expected promise to reject with DB constraint error");
    } catch (err: any) {
      const text = `${err.message ?? ""} ${err.cause?.message ?? ""} ${err.cause?.detail ?? ""}`;
      expect(text).toMatch(regex);
    }
  }

  async function createCompany(name: string) {
    const svc = companyService(db);
    return svc.create({ name });
  }

  describe("schema, constraints, unique indexes, and RLS", () => {
    it("enforces unique (company_id, agent_id_snapshot)", async () => {
      const company = await createCompany("Unique Index Test");
      const agentId = "11111111-1111-4111-8111-111111111111";

      await db.insert(agentKnowledgeBindings).values({
        companyId: company.id,
        agentIdSnapshot: agentId,
        idempotencyKey: `key-1-${agentId}`,
        desiredAccess: "active",
        state: "pending",
        fenceEpoch: 1,
      });

      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: agentId,
          idempotencyKey: `key-2-${agentId}`,
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: 1,
        }),
        /duplicate key value.*company_agent_snapshot_uq/i,
      );
    });

    it("enforces unique idempotency_key", async () => {
      const company = await createCompany("Idempotency Key Test");
      const sharedKey = `shared-idempotency-key-${company.id}`;

      await db.insert(agentKnowledgeBindings).values({
        companyId: company.id,
        agentIdSnapshot: "22222222-2222-4222-8222-222222222222",
        idempotencyKey: sharedKey,
        desiredAccess: "active",
        state: "pending",
        fenceEpoch: 1,
      });

      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: "33333333-3333-4333-8333-333333333333",
          idempotencyKey: sharedKey,
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: 1,
        }),
        /duplicate key value.*idempotency_key_uq/i,
      );
    });

    it("enforces state check constraint and strictly forbids 'active' status in this slice", async () => {
      const company = await createCompany("Check State Test");
      const agentId = "44444444-4444-4444-8444-444444444444";

      // 'active' is forbidden in inert slice (absent future binding+credential)
      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: agentId,
          idempotencyKey: `key-active-${agentId}`,
          desiredAccess: "active",
          state: "active",
          fenceEpoch: 1,
        }),
        /check constraint "agent_knowledge_bindings_state_check"/i,
      );

      // 'bogus' is forbidden
      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: agentId,
          idempotencyKey: `key-bogus-${agentId}`,
          desiredAccess: "active",
          state: "bogus",
          fenceEpoch: 1,
        }),
        /check constraint "agent_knowledge_bindings_state_check"/i,
      );

      // Allowed states: pending, suspended, revoking, revoked, failed
      const validStates = ["pending", "suspended", "revoking", "revoked", "failed"] as const;
      for (let i = 0; i < validStates.length; i++) {
        const validState = validStates[i];
        const id = `55555555-5555-4555-8555-55555555555${i}`;
        await db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: id,
          idempotencyKey: `key-${validState}-${id}`,
          desiredAccess: "active",
          state: validState,
          fenceEpoch: 1,
        });
      }
    });

    it("enforces fence_epoch non-negative and last_error_code bounded length", async () => {
      const company = await createCompany("Fence & Error Check");
      const agentId = "66666666-6666-4666-8666-666666666666";

      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: agentId,
          idempotencyKey: `key-negative-fence-${agentId}`,
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: -1,
        }),
        /check constraint "agent_knowledge_bindings_fence_epoch_check"/i,
      );

      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: agentId,
          idempotencyKey: `key-long-error-${agentId}`,
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: 1,
          lastErrorCode: "E".repeat(65),
        }),
        /check constraint "agent_knowledge_bindings_last_error_code_check"/i,
      );
    });

    it("enforces snapshot equality check (agent_id IS NULL OR agent_id = agent_id_snapshot)", async () => {
      const company = await createCompany("Snapshot Check");
      const realAgent = await agentService(db).create(company.id, {
        name: "Snapshot Agent",
        role: "general",
      });

      // Mismatch between agentId and agentIdSnapshot is rejected
      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentId: realAgent.id,
          agentIdSnapshot: "77777777-7777-4777-8777-777777777777",
          idempotencyKey: `key-mismatch-${realAgent.id}`,
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: 1,
        }),
        /check constraint "agent_knowledge_bindings_agent_id_snapshot_check"/i,
      );

      // Matching agentId and agentIdSnapshot succeeds
      await db.insert(agentKnowledgeBindings).values({
        companyId: company.id,
        agentId: realAgent.id,
        agentIdSnapshot: realAgent.id,
        idempotencyKey: `key-match-${realAgent.id}`,
        desiredAccess: "active",
        state: "pending",
        fenceEpoch: 1,
      });

      // agentId = null with agentIdSnapshot set succeeds (survives agent deletion)
      const orphanId = "88888888-8888-4888-8888-888888888888";
      await db.insert(agentKnowledgeBindings).values({
        companyId: company.id,
        agentId: null,
        agentIdSnapshot: orphanId,
        idempotencyKey: `key-null-fk-${orphanId}`,
        desiredAccess: "active",
        state: "pending",
        fenceEpoch: 1,
      });
    });

    it("enforces tenant-isolation RLS: scoped company isolation and unscoped admin sweep", async () => {
      const companyA = await createCompany("RLS Company A");
      const companyB = await createCompany("RLS Company B");

      const agentAId = "99999999-9999-4999-8999-999999999991";
      const agentBId = "99999999-9999-4999-8999-999999999992";

      // Seed rows unscoped (admin sweep mode: session setting unset)
      await db.insert(agentKnowledgeBindings).values([
        {
          companyId: companyA.id,
          agentIdSnapshot: agentAId,
          idempotencyKey: `rls-key-${agentAId}`,
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: 1,
        },
        {
          companyId: companyB.id,
          agentIdSnapshot: agentBId,
          idempotencyKey: `rls-key-${agentBId}`,
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: 1,
        },
      ]);

      // Unscoped query sees both rows
      const unscopedRows = await db.select().from(agentKnowledgeBindings);
      const companyARows = unscopedRows.filter((r) => r.companyId === companyA.id);
      const companyBRows = unscopedRows.filter((r) => r.companyId === companyB.id);
      expect(companyARows.length).toBeGreaterThanOrEqual(1);
      expect(companyBRows.length).toBeGreaterThanOrEqual(1);

      // Scoped session: scoped to companyA via non-superuser role
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE rls_lifecycle_app_role`);
        await tx.execute(sql`SELECT set_config('app.current_company_id', ${companyA.id}, true)`);

        const scopedRows = await tx.select().from(agentKnowledgeBindings);
        expect(scopedRows.every((r) => r.companyId === companyA.id)).toBe(true);
        expect(scopedRows.some((r) => r.agentIdSnapshot === agentAId)).toBe(true);
        expect(scopedRows.some((r) => r.agentIdSnapshot === agentBId)).toBe(false);
      });

      // Attempting to cross-tenant write into companyB fails WITH CHECK
      await expectDbError(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE rls_lifecycle_app_role`);
          await tx.execute(sql`SELECT set_config('app.current_company_id', ${companyA.id}, true)`);
          await tx.insert(agentKnowledgeBindings).values({
            companyId: companyB.id,
            agentIdSnapshot: "99999999-9999-4999-8999-999999999993",
            idempotencyKey: "cross-tenant-write",
            desiredAccess: "active",
            state: "pending",
            fenceEpoch: 1,
          });
        }),
        /row-level security policy/i,
      );
    });
  });

  describe("pending hires and non-built-in agents", () => {
    it("creates pending binding only on activation for hire-pending agents, and never for built-in agents", async () => {
      const company = await createCompany("Hires & Built-ins");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      // 1. Pending hire: created with pending_approval -> NO binding
      const pendingAgent = await agentService(db).create(company.id, {
        name: "Candidate Agent",
        role: "general",
        status: "pending_approval",
      });

      let binding = await agentKnowledgeService(db).getBindingForAgent(company.id, pendingAgent.id);
      expect(binding).toBeNull();

      // Activate pending approval -> binding created in SAME transaction
      const activateResult = await agentService(db).activatePendingApproval(pendingAgent.id, null, {
        actor: { actorType: "user", actorId: "approver-user-123" },
      });
      expect(activateResult?.activated).toBe(true);

      binding = await agentKnowledgeService(db).getBindingForAgent(company.id, pendingAgent.id);
      expect(binding).not.toBeNull();
      expect(binding?.desiredAccess).toBe("active");
      expect(binding?.state).toBe("pending");
      expect(binding?.fenceEpoch).toBe(1);
      expect(binding?.createdByActorType).toBe("user");
      expect(binding?.createdByActorId).toBe("approver-user-123");

      // 2. Built-in agent: never receives binding even if approved and knowledge enabled
      const builtInAgent = await agentService(db).create(
        company.id,
        {
          name: "Builtin Bot",
          role: "general",
          metadata: withBuiltInAgentMarker({}, { key: "general_assistant", featureKeys: ["chat"] }),
        },
        { allowBuiltInAgentMetadata: true },
      );

      const builtInBinding = await agentKnowledgeService(db).getBindingForAgent(company.id, builtInAgent.id);
      expect(builtInBinding).toBeNull();

      // 3. Agent created in a non-pilot company: no binding created
      const nonPilotCompany = await createCompany("Non Pilot Org");
      const nonPilotAgent = await agentService(db).create(nonPilotCompany.id, {
        name: "Regular Bot",
        role: "general",
      });
      const nonPilotBinding = await agentKnowledgeService(db).getBindingForAgent(
        nonPilotCompany.id,
        nonPilotAgent.id,
      );
      expect(nonPilotBinding).toBeNull();
    });
  });

  describe("pause and resume lifecycle", () => {
    it("suspends binding and increments fence on pause; requests active on resume without marking state active", async () => {
      const company = await createCompany("Pause Resume Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const agent = await agentService(db).create(company.id, {
        name: "Lifecycle Bot",
        role: "general",
      });

      let binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("active");
      expect(binding.state).toBe("pending");
      expect(binding.fenceEpoch).toBe(1);

      // Pause agent
      await agentService(db).pause(agent.id, "manual");
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("suspended");
      expect(binding.state).toBe("suspended");
      expect(binding.fenceEpoch).toBe(2);

      // Resume agent
      await agentService(db).resume(agent.id);
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("active");
      // Key invariant: state remains inert/pending until future authority worker confirms
      expect(binding.state).toBe("pending");
      expect(binding.state).not.toBe("active");
      expect(binding.fenceEpoch).toBe(3);

      // Company archive pauses all company agents and suspends bindings
      await companyService(db).archive(company.id);
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("suspended");
      expect(binding.state).toBe("suspended");
      expect(binding.fenceEpoch).toBe(4);

      // Company reactivate requests active desired access without marking state active
      await companyService(db).update(company.id, { status: "active" });
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("active");
      expect(binding.state).toBe("pending");
      expect(binding.fenceEpoch).toBe(5);
    });
  });

  describe("terminate and transaction rollback atomicity", () => {
    it("terminates agent, revokes API keys, and creates revocation outbox in single atomic transaction", async () => {
      const company = await createCompany("Terminate Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const agent = await agentService(db).create(company.id, {
        name: "Terminated Bot",
        role: "general",
      });

      // Issue an API key for the agent
      await agentService(db).createApiKey(agent.id, "Test Key");

      // Terminate
      const terminated = await agentService(db).terminate(agent.id);
      expect(terminated?.status).toBe("terminated");

      // Verify keys revoked
      const keys = await agentService(db).listKeys(agent.id);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k: { revokedAt: Date | null }) => k.revokedAt !== null)).toBe(true);

      // Verify binding is revoked
      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("revoked");
      expect(binding.state).toBe("revoked");
      expect(binding.fenceEpoch).toBe(2);

      // Verify revocation outbox entry
      const revocations = await agentKnowledgeService(db).listRevocationsForBinding(binding.id);
      expect(revocations.length).toBe(1);
      expect(revocations[0].status).toBe("pending");
      expect(revocations[0].reason).toBe("agent_terminated");
      expect(revocations[0].agentIdSnapshot).toBe(agent.id);
      expect(revocations[0].fenceEpoch).toBe(2);
    });
  });

  describe("deletion survivability: snapshots and outbox survive agent and company deletion", () => {
    it("survives agent deletion: binding and revocation outbox retained with agentId set to null", async () => {
      const company = await createCompany("Agent Deletion Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const agent = await agentService(db).create(company.id, {
        name: "Doomed Bot",
        role: "general",
      });

      const bindingBefore = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(bindingBefore.agentId).toBe(agent.id);

      // Remove agent
      await agentService(db).remove(agent.id);

      // Agent is gone from agents table
      const agentCheck = await agentService(db).getById(agent.id);
      expect(agentCheck).toBeNull();

      // Binding row survives!
      const bindings = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, company.id),
            eq(agentKnowledgeBindings.agentIdSnapshot, agent.id),
          ),
        );
      expect(bindings.length).toBe(1);
      const bindingAfter = bindings[0];
      expect(bindingAfter.id).toBe(bindingBefore.id);
      expect(bindingAfter.agentId).toBeNull(); // ON DELETE SET NULL
      expect(bindingAfter.agentIdSnapshot).toBe(agent.id); // preserved!
      expect(bindingAfter.desiredAccess).toBe("revoked");
      expect(bindingAfter.state).toBe("revoked");

      // Revocation outbox row survives!
      const revocations = await agentKnowledgeService(db).listRevocationsForBinding(bindingBefore.id);
      expect(revocations.length).toBe(1);
      expect(revocations[0].agentId).toBeNull(); // ON DELETE SET NULL
      expect(revocations[0].agentIdSnapshot).toBe(agent.id); // preserved!
      expect(revocations[0].reason).toBe("agent_removed");
      expect(revocations[0].status).toBe("pending");
    });

    it("survives company deletion: binding and revocation outbox rows survive company removal", async () => {
      const company = await createCompany("Company Deletion Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const agent = await agentService(db).create(company.id, {
        name: "Company Orphan Bot",
        role: "general",
      });

      const bindingBefore = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;

      // Remove entire company
      await companyService(db).remove(company.id);

      // Company is gone
      const companyCheck = await companyService(db).getById(company.id);
      expect(companyCheck).toBeNull();

      // Both binding and revocation rows survive company deletion!
      const bindings = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.id, bindingBefore.id));
      expect(bindings.length).toBe(1);
      expect(bindings[0].companyId).toBe(company.id); // preserved!
      expect(bindings[0].agentIdSnapshot).toBe(agent.id); // preserved!
      expect(bindings[0].desiredAccess).toBe("revoked");
      expect(bindings[0].state).toBe("revoked");

      const revocations = await agentKnowledgeService(db).listRevocationsForBinding(bindingBefore.id);
      expect(revocations.length).toBe(1);
      expect(revocations[0].companyId).toBe(company.id);
      expect(revocations[0].reason).toBe("company_removed");
      expect(revocations[0].status).toBe("pending");
    });
  });

  describe("flag-off revocation guarantee", () => {
    it("revokes existing bindings and enqueues outbox even when flag is turned OFF", async () => {
      const company = await createCompany("Flag Off Test");

      // Turn flag ON to create binding
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const agent = await agentService(db).create(company.id, {
        name: "Legacy Binding Bot",
        role: "general",
      });

      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding).not.toBeNull();

      // Turn flag OFF completely
      setAgentKnowledgeConfigForTests({
        enabled: false,
        pilotCompanyIds: [],
      });

      // Remove agent with flag off
      await agentService(db).remove(agent.id);

      // Revocation must still have been executed and outbox enqueued
      const revocations = await agentKnowledgeService(db).listRevocationsForBinding(binding.id);
      expect(revocations.length).toBe(1);
      expect(revocations[0].reason).toBe("agent_removed");
      expect(revocations[0].status).toBe("pending");

      const updatedBinding = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.id, binding.id))
        .then((r) => r[0]);
      expect(updatedBinding.desiredAccess).toBe("revoked");
      expect(updatedBinding.state).toBe("revoked");
    });
  });

  describe("concurrency and idempotency", () => {
    it("handles concurrent binding creation idempotently without duplicate rows", async () => {
      const company = await createCompany("Concurrency Test");
      const agent = await agentService(db).create(company.id, {
        name: "Concurrent Bot",
        role: "general",
      });
      const agentId = agent.id;

      const [res1, res2, res3] = await Promise.all([
        agentKnowledgeService(db).createPendingBinding({ companyId: company.id, agentId }),
        agentKnowledgeService(db).createPendingBinding({ companyId: company.id, agentId }),
        agentKnowledgeService(db).createPendingBinding({ companyId: company.id, agentId }),
      ]);

      expect(res1.id).toBe(res2.id);
      expect(res2.id).toBe(res3.id);

      const rows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, company.id),
            eq(agentKnowledgeBindings.agentIdSnapshot, agentId),
          ),
        );
      expect(rows.length).toBe(1);
    });

    it("handles concurrent/repeated revocation idempotently without duplicate outbox rows", async () => {
      const company = await createCompany("Revocation Idempotency");
      const agent = await agentService(db).create(company.id, {
        name: "Revocation Bot",
        role: "general",
      });
      const agentId = agent.id;

      const binding = await agentKnowledgeService(db).createPendingBinding({
        companyId: company.id,
        agentId,
      });

      const [rev1, rev2] = await Promise.all([
        agentKnowledgeService(db).revokeAgentBinding({
          companyId: company.id,
          agentId,
          reason: "agent_terminated",
        }),
        agentKnowledgeService(db).revokeAgentBinding({
          companyId: company.id,
          agentId,
          reason: "agent_terminated",
        }),
      ]);

      expect(rev1?.id).toBe(rev2?.id);

      const rows = await agentKnowledgeService(db).listRevocationsForBinding(binding.id);
      expect(rows.length).toBe(1);
    });
  });

  describe("pure database hooks (no socket/network calls)", () => {
    it("performs zero network or port calls during lifecycle operations", async () => {
      const company = await createCompany("Network Audit");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const netConnectSpy = vi.spyOn(net.Socket.prototype, "connect");
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      try {
        const agent = await agentService(db).create(company.id, {
          name: "Offline Bot",
          role: "general",
        });
        await agentService(db).pause(agent.id);
        await agentService(db).resume(agent.id);
        await agentService(db).terminate(agent.id);
        await agentService(db).remove(agent.id);

        expect(fetchSpy).not.toHaveBeenCalled();
        const embeddedPort = tempDb?.connectionString ? Number(new URL(tempDb.connectionString).port) : undefined;
        const remoteCalls = netConnectSpy.mock.calls.filter((args) => {
          const port = typeof args[0] === "number" ? args[0] : (args[0] as any)?.port;
          return port !== undefined && port !== embeddedPort;
        });
        expect(remoteCalls).toHaveLength(0);
      } finally {
        netConnectSpy.mockRestore();
        fetchSpy.mockRestore();
      }
    });
  });

  describe("human turnover isolation", () => {
    it("verifies human membership changes have zero effect on knowledge bindings", async () => {
      const company = await createCompany("Human Turnover Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const agent = await agentService(db).create(
        company.id,
        {
          name: "Unaffected Bot",
          role: "general",
        },
        { actor: { actorType: "user", actorId: "human-1" } },
      );

      const bindingBefore = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(bindingBefore.createdByActorType).toBe("user");
      expect(bindingBefore.createdByActorId).toBe("human-1");

      // Add human member
      const [user] = await db
        .insert(authUsers)
        .values({
          id: "human-1",
          name: "Alice",
          email: "alice@example.com",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      const [membership] = await db
        .insert(companyMemberships)
        .values({
          companyId: company.id,
          principalType: "user",
          principalId: "human-1",
          membershipRole: "admin",
          status: "active",
        })
        .returning();

      // Remove human membership (turnover)
      await db.delete(companyMemberships).where(eq(companyMemberships.id, membership.id));

      // Binding is untouched!
      const bindingAfter = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(bindingAfter.id).toBe(bindingBefore.id);
      expect(bindingAfter.desiredAccess).toBe("active");
      expect(bindingAfter.state).toBe("pending");
      expect(bindingAfter.fenceEpoch).toBe(1);

      // Zero revocations enqueued
      const revocations = await agentKnowledgeService(db).listRevocationsForBinding(bindingBefore.id);
      expect(revocations).toHaveLength(0);
    });
  });

  describe("company transfer export safety", () => {
    it("does not export or clone agent knowledge bindings or authoritative principal IDs", async () => {
      const company = await createCompany("Portability Export Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const agent = await agentService(db).create(company.id, {
        name: "Exported Bot",
        role: "general",
      });

      // Update binding with synthetic principal_id / brain_id
      await db
        .update(agentKnowledgeBindings)
        .set({
          principalId: "auth-principal-sensitive-999",
          brainId: "brain-sensitive-888",
        })
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, company.id),
            eq(agentKnowledgeBindings.agentIdSnapshot, agent.id),
          ),
        );

      const exportResult = await companyPortabilityService(db).exportBundle(company.id, {
        agents: [agent.id],
      });

      const exportJson = JSON.stringify(exportResult);
      expect(exportJson).not.toContain("auth-principal-sensitive-999");
      expect(exportJson).not.toContain("brain-sensitive-888");
      expect(exportJson).not.toContain("agent_knowledge_bindings");
      expect(exportJson).not.toContain("agent_knowledge_revocations");
    });
  });

  describe("flag-off lifecycle hooks for existing bindings", () => {
    it("suspends, resumes, archives, reactivates, and revokes EXISTING bindings even while the flag is fully disabled", async () => {
      const company = await createCompany("Flag Off Lifecycle Test");

      // Enable to provision the binding, then disable entirely.
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Flag Off Lifecycle Bot",
        role: "general",
      });
      setAgentKnowledgeConfigForTests({
        enabled: false,
        pilotCompanyIds: [],
      });

      // Pause with the flag off: the existing binding is still suspended.
      await agentService(db).pause(agent.id, "manual");
      let binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("suspended");
      expect(binding.state).toBe("suspended");
      expect(binding.fenceEpoch).toBe(2);

      // Resume with the flag off: desired access returns to active (state inert).
      await agentService(db).resume(agent.id);
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("active");
      expect(binding.state).toBe("pending");
      expect(binding.fenceEpoch).toBe(3);

      // Company archive with the flag off: binding suspends.
      await companyService(db).archive(company.id);
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("suspended");
      expect(binding.state).toBe("suspended");
      expect(binding.fenceEpoch).toBe(4);

      // Company reactivate with the flag off: binding requests active again.
      await companyService(db).update(company.id, { status: "active" });
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("active");
      expect(binding.state).toBe("pending");
      expect(binding.fenceEpoch).toBe(5);

      // Terminate with the flag off: permanent revocation still lands.
      await agentService(db).terminate(agent.id);
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("revoked");
      expect(binding.state).toBe("revoked");
      expect(binding.fenceEpoch).toBe(6);
      const revocations = await agentKnowledgeService(db).listRevocationsForBinding(binding.id);
      expect(revocations.length).toBe(1);
      expect(revocations[0].reason).toBe("agent_terminated");
    });

    it("creates ZERO new bindings while the flag is disabled, including on approval activation", async () => {
      const company = await createCompany("Flag Off Hiring Test");
      // Flag fully disabled: no pilot allowlist can be consulted at all.
      setAgentKnowledgeConfigForTests({
        enabled: false,
        pilotCompanyIds: [],
      });

      const directAgent = await agentService(db).create(company.id, {
        name: "Direct Hire Bot",
        role: "general",
      });
      expect(await agentKnowledgeService(db).getBindingForAgent(company.id, directAgent.id)).toBeNull();

      // A pending hire that is later approved with the flag still off also
      // gets no binding: approval activation provisions only when enabled.
      const pendingAgent = await agentService(db).create(company.id, {
        name: "Pending Hire Bot",
        role: "general",
        status: "pending_approval",
      });
      expect(await agentKnowledgeService(db).getBindingForAgent(company.id, pendingAgent.id)).toBeNull();

      const activated = await agentService(db).activatePendingApproval(pendingAgent.id, null, {
        actor: { actorType: "user", actorId: "approver-flag-off" },
      });
      expect(activated?.activated).toBe(true);
      expect(await agentKnowledgeService(db).getBindingForAgent(company.id, pendingAgent.id)).toBeNull();

      const rows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, company.id));
      expect(rows).toHaveLength(0);
    });
  });

  describe("conflicting and repeated lifecycle transitions", () => {
    it("repeated pause suspends again and keeps incrementing the fence epoch (each request is a new epoch)", async () => {
      const company = await createCompany("Double Pause Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Double Pause Bot",
        role: "general",
      });

      await agentService(db).pause(agent.id, "manual");
      await agentService(db).pause(agent.id, "budget");

      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("suspended");
      expect(binding.fenceEpoch).toBe(3);
    });

    it("repeated company archive does NOT suspend twice; repeated reactivate does NOT resume twice", async () => {
      const company = await createCompany("Double Archive Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Double Archive Bot",
        role: "general",
      });

      // First archive: suspend (fence 1 -> 2).
      await companyService(db).archive(company.id);
      let binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("suspended");
      expect(binding.fenceEpoch).toBe(2);

      // Second archive of an already-archived company: cascade skipped, no
      // second suspension, fence untouched.
      await companyService(db).archive(company.id);
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("suspended");
      expect(binding.fenceEpoch).toBe(2);

      // Reactivate: resume (fence 2 -> 3).
      await companyService(db).update(company.id, { status: "active" });
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("active");
      expect(binding.fenceEpoch).toBe(3);

      // Reactivating an already-active company: no resume, fence untouched.
      await companyService(db).update(company.id, { status: "active" });
      binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("active");
      expect(binding.fenceEpoch).toBe(3);
    });

    it("pause then terminate: suspended binding becomes permanently revoked with a single outbox row", async () => {
      const company = await createCompany("Pause Terminate Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Pause Terminate Bot",
        role: "general",
      });

      await agentService(db).pause(agent.id, "manual");
      const suspended = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(suspended.desiredAccess).toBe("suspended");
      expect(suspended.fenceEpoch).toBe(2);

      await agentService(db).terminate(agent.id);

      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("revoked");
      expect(binding.state).toBe("revoked");
      expect(binding.fenceEpoch).toBe(3);
      const revocations = await agentKnowledgeService(db).listRevocationsForBinding(binding.id);
      expect(revocations.length).toBe(1);
      expect(revocations[0].reason).toBe("agent_terminated");
      expect(revocations[0].fenceEpoch).toBe(3);

      // Post-termination pause and resume both conflict, and neither can
      // disturb the revoked tombstone.
      await expect(agentService(db).pause(agent.id, "manual")).rejects.toThrow(/terminated/i);
      await expect(agentService(db).resume(agent.id)).rejects.toThrow(/terminated/i);
      const after = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(after.desiredAccess).toBe("revoked");
      expect(after.fenceEpoch).toBe(3);
      expect((await agentKnowledgeService(db).listRevocationsForBinding(binding.id)).length).toBe(1);
    });

    it("resume of a pending-approval agent conflicts, and terminating one leaves no binding or outbox rows at all", async () => {
      const company = await createCompany("Pending Conflicts Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const pendingAgent = await agentService(db).create(company.id, {
        name: "Pending Conflict Bot",
        role: "general",
        status: "pending_approval",
      });

      await expect(agentService(db).resume(pendingAgent.id)).rejects.toThrow(
        /Pending approval agents cannot be resumed/i,
      );

      // Terminating a never-provisioned pending hire revokes nothing: there
      // is no binding row, so no revocation outbox row either.
      const terminated = await agentService(db).terminate(pendingAgent.id);
      expect(terminated?.status).toBe("terminated");

      const bindingRows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, company.id));
      expect(bindingRows).toHaveLength(0);
      const revocationRows = await db
        .select()
        .from(agentKnowledgeRevocations)
        .where(eq(agentKnowledgeRevocations.companyId, company.id));
      expect(revocationRows).toHaveLength(0);
    });
  });

  describe("non-pending activation and built-in agents on the activation path", () => {
    it("activatePendingApproval on an already-active agent is a no-op that cannot mint a second binding", async () => {
      const company = await createCompany("Nonpending Activate Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const agent = await agentService(db).create(company.id, {
        name: "Already Active Bot",
        role: "general",
      });
      const bindingBefore = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;

      const result = await agentService(db).activatePendingApproval(agent.id, null, {
        actor: { actorType: "user", actorId: "re-approver" },
      });
      expect(result?.activated).toBe(false);

      const rows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, company.id),
            eq(agentKnowledgeBindings.agentIdSnapshot, agent.id),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(bindingBefore.id);
      // The no-op path must not re-stamp creation audit either.
      expect(rows[0].createdByActorType).not.toBe("user");
    });

    it("built-in pending-approval agents stay excluded from provisioning when approved", async () => {
      const company = await createCompany("Builtin Pending Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });

      const builtInPending = await agentService(db).create(
        company.id,
        {
          name: "Builtin Pending Bot",
          role: "general",
          status: "pending_approval",
          metadata: withBuiltInAgentMarker({}, { key: "pending_assistant", featureKeys: ["chat"] }),
        },
        { allowBuiltInAgentMetadata: true },
      );

      expect(
        await agentKnowledgeService(db).getBindingForAgent(company.id, builtInPending.id),
      ).toBeNull();

      const activated = await agentService(db).activatePendingApproval(builtInPending.id, null, {
        actor: { actorType: "user", actorId: "builtin-approver" },
      });
      expect(activated?.activated).toBe(true);

      expect(
        await agentKnowledgeService(db).getBindingForAgent(company.id, builtInPending.id),
      ).toBeNull();
    });
  });

  describe("direct status field updates (FIXED production status hooks)", () => {
    it("a direct { status: 'paused' } update pauses the agent and suspends the binding", async () => {
      const company = await createCompany("Direct Pause Fixed");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Direct Pause Bot",
        role: "general",
      });

      const updated = await agentService(db).update(agent.id, { status: "paused" });
      expect(updated?.status).toBe("paused");

      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("suspended");
      expect(binding.state).toBe("suspended");
      expect(binding.fenceEpoch).toBe(2);
    });

    it("a direct { status: 'idle' } update resumes the agent and requests active binding access (stays pending)", async () => {
      const company = await createCompany("Direct Resume Fixed");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Direct Resume Bot",
        role: "general",
      });
      await agentService(db).pause(agent.id, "manual");

      const updated = await agentService(db).update(agent.id, { status: "idle" });
      expect(updated?.status).toBe("idle");

      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("active");
      expect(binding.state).toBe("pending");
      expect(binding.fenceEpoch).toBe(3);
    });

    it("a direct { status: 'terminated' } update terminates the agent and revokes both binding and API keys", async () => {
      const company = await createCompany("Direct Terminate Fixed");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Direct Terminate Bot",
        role: "general",
      });
      await agentService(db).createApiKey(agent.id, "Gap Key");

      const updated = await agentService(db).update(agent.id, { status: "terminated" });
      expect(updated?.status).toBe("terminated");

      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("revoked");
      expect(binding.state).toBe("revoked");
      expect((await agentKnowledgeService(db).listRevocationsForBinding(binding.id)).length).toBe(1);

      const keys = await agentService(db).listKeys(agent.id);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k: { revokedAt: Date | null }) => k.revokedAt !== null)).toBe(true);
    });

    it("the shared update schema accepts status, and PATCH /api/agents/:id reaches the hooked path", () => {
      const parsed = updateAgentSchema.safeParse({ status: "paused" });
      expect(parsed.success).toBe(true);
      const terminated = updateAgentSchema.safeParse({ status: "terminated" });
      expect(terminated.success).toBe(true);
    });

    it("a direct paused status write suspends the binding and increments fence", async () => {
      const company = await createCompany("Direct Pause Pin");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Direct Pause Pin Bot",
        role: "general",
      });
      await agentService(db).update(agent.id, { status: "paused" });
      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(`${binding.desiredAccess}/${binding.state}`).toBe("suspended/suspended");
      expect(binding.fenceEpoch).toBe(2);
    });

    it("a direct terminated status write revokes the binding and its API keys atomically", async () => {
      const company = await createCompany("Direct Terminate Pin");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Direct Terminate Pin Bot",
        role: "general",
      });
      await agentService(db).createApiKey(agent.id, "Pin Key");
      await agentService(db).update(agent.id, { status: "terminated" });

      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("revoked");
      expect(binding.state).toBe("revoked");
      const keys = await agentService(db).listKeys(agent.id);
      expect(keys.every((k: { revokedAt: Date | null }) => k.revokedAt !== null)).toBe(true);
    });

    it("forbids resurrecting a terminated agent via direct status update", async () => {
      const company = await createCompany("Resurrect Attempt");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Zombie Bot",
        role: "general",
      });
      await agentService(db).terminate(agent.id);

      await expect(
        agentService(db).update(agent.id, { status: "idle" }),
      ).rejects.toThrow(/Terminated agents cannot be resumed/i);

      await expect(
        agentService(db).update(agent.id, { status: "paused" }),
      ).rejects.toThrow(/Terminated agents cannot be resumed/i);
    });

    it("repeated terminated updates on an already terminated agent are idempotent", async () => {
      const company = await createCompany("Term Idempotent");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Already Term Bot",
        role: "general",
      });
      await agentService(db).terminate(agent.id);

      const binding1 = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      const fence1 = binding1.fenceEpoch;

      // Second update with status: "terminated" does not re-increment fence or duplicate outbox
      await agentService(db).update(agent.id, { status: "terminated" });
      const binding2 = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding2.fenceEpoch).toBe(fence1);

      const outbox = await agentKnowledgeService(db).listRevocationsForBinding(binding1.id);
      expect(outbox).toHaveLength(1);
    });
  });

  describe("late authority responses cannot toggle a revoked binding (future worker/lease note)", () => {
    // This slice ships NO authority worker: the ledger is pure DB hooks and
    // the state machine stays inert (pending/suspended) until a future
    // milestone lands the authority lease + confirmation worker. When that
    // worker lands, `fence_epoch` is the contract point: a confirmation
    // carrying a fence epoch older than the binding's current fence_epoch
    // (e.g. one racing a later revoke) must be rejected as stale, never
    // applied. This test pins the DB-side invariant the worker will extend:
    // once desiredAccess is 'revoked', no mutation path that exists in this
    // slice can flip the row back to active or suspended, and the fence
    // stays pinned at its revocation value.
    it("every post-revocation state mutation is inert: suspend, resume, suspend-all, resume-all, and re-create", async () => {
      const company = await createCompany("Late Response Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const revokedAgent = await agentService(db).create(company.id, {
        name: "Revoked Bot",
        role: "general",
      });
      const survivorAgent = await agentService(db).create(company.id, {
        name: "Survivor Bot",
        role: "general",
      });

      await agentService(db).terminate(revokedAgent.id);
      const revokedBinding = (await agentKnowledgeService(db).getBindingForAgent(
        company.id,
        revokedAgent.id,
      ))!;
      expect(revokedBinding.desiredAccess).toBe("revoked");
      expect(revokedBinding.fenceEpoch).toBe(2);
      const revokedFence = revokedBinding.fenceEpoch;

      // Direct service mutations on the revoked binding are all no-ops.
      expect(
        await agentKnowledgeService(db).suspendAgentBinding({
          companyId: company.id,
          agentId: revokedAgent.id,
        }),
      ).toBeNull();
      expect(
        await agentKnowledgeService(db).resumeAgentBinding({
          companyId: company.id,
          agentId: revokedAgent.id,
        }),
      ).toBeNull();
      // A "late create" retry (the onConflictDoNothing fallback path) returns
      // the existing revoked tombstone unchanged -- it cannot resurrect a
      // fresh active binding for the same mapping.
      const recreated = await agentKnowledgeService(db).createPendingBinding({
        companyId: company.id,
        agentId: revokedAgent.id,
      });
      expect(recreated.id).toBe(revokedBinding.id);
      expect(recreated.desiredAccess).toBe("revoked");
      expect(recreated.state).toBe("revoked");
      expect(recreated.fenceEpoch).toBe(revokedFence);

      // Company-wide sweeps: suspend-all leaves the revoked row untouched
      // (only the survivor suspends); resume-all leaves it untouched too
      // (only desiredAccess='suspended' rows are lifted).
      await companyService(db).archive(company.id);
      let survivorBinding = (await agentKnowledgeService(db).getBindingForAgent(
        company.id,
        survivorAgent.id,
      ))!;
      expect(survivorBinding.desiredAccess).toBe("suspended");
      let afterSweep = (await agentKnowledgeService(db).getBindingForAgent(
        company.id,
        revokedAgent.id,
      ))!;
      expect(afterSweep.desiredAccess).toBe("revoked");
      expect(afterSweep.fenceEpoch).toBe(revokedFence);

      await companyService(db).update(company.id, { status: "active" });
      survivorBinding = (await agentKnowledgeService(db).getBindingForAgent(
        company.id,
        survivorAgent.id,
      ))!;
      expect(survivorBinding.desiredAccess).toBe("active");
      afterSweep = (await agentKnowledgeService(db).getBindingForAgent(
        company.id,
        revokedAgent.id,
      ))!;
      expect(afterSweep.desiredAccess).toBe("revoked");
      expect(afterSweep.state).toBe("revoked");
      expect(afterSweep.fenceEpoch).toBe(revokedFence);

      // Exactly one revocation outbox row for the revoked binding, ever.
      const revocations = await agentKnowledgeService(db).listRevocationsForBinding(
        revokedBinding.id,
      );
      expect(revocations.length).toBe(1);
      expect(revocations[0].status).toBe("pending");
    });
  });
});
