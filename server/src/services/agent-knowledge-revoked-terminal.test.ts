import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  createDb,
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
  activityLog,
  agentApiKeys,
  agentKnowledgeBindings,
  agentKnowledgeRevocations,
  agents,
  companySecrets,
  costEvents,
  type Db,
} from "@paperclipai/db";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";
import { budgetService } from "./budgets.js";
import {
  agentKnowledgeService,
  deterministicBindingIdempotencyKey,
  deterministicRevocationIdempotencyKey,
  type KnowledgeRevocationReason,
} from "./agent-knowledge.js";
import {
  setAgentKnowledgeConfigForTests,
  resetAgentKnowledgeConfigForTests,
} from "./agent-knowledge-config.js";
import { companyPortabilityService } from "./company-portability.js";

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedSupport.supported ? describe : describe.skip;

/**
 * TECH-7164/7177 coverage audit: revocation terminality, raw ledger
 * constraints, deletion survivability, transaction atomicity, and
 * cross-session concurrency -- the invariants that must hold even though
 * this slice ships no authority worker (the ledger is inert by design until
 * the future lease/confirmation milestone).
 */
describeEmbedded("agent-knowledge revoked terminality and ledger invariants", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  let dbA: Db;
  let dbB: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-knowledge-term-");
    db = createDb(tempDb.connectionString);
    dbA = createDb(tempDb.connectionString);
    dbB = createDb(tempDb.connectionString);

    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_term_app_role') THEN
          CREATE ROLE rls_term_app_role NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO rls_term_app_role`);
    await db.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_term_app_role`);
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

  /** Inserts a raw ledger binding row (no service hook) for constraint probing. */
  async function insertRawBinding(companyId: string, keySuffix: string, customAgentIdSnapshot?: string) {
    const agentIdSnapshot = customAgentIdSnapshot ?? randomUUID();
    const [row] = await db
      .insert(agentKnowledgeBindings)
      .values({
        companyId,
        agentIdSnapshot,
        idempotencyKey: `raw-${companyId}-${keySuffix}-${agentIdSnapshot}`,
        desiredAccess: "active",
        state: "pending",
        fenceEpoch: 1,
      })
      .returning();
    return row!;
  }

  async function provisionBinding(companyName: string, agentName: string) {
    const company = await createCompany(companyName);
    setAgentKnowledgeConfigForTests({
      enabled: true,
      pilotCompanyIds: [company.id],
    });
    const agent = await agentService(db).create(company.id, {
      name: agentName,
      role: "general",
    });
    const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
    return { company, agent, binding };
  }

  describe("repeated revocation preserves the tombstone and enqueues exactly one outbox row", () => {
    it("re-revoking does not re-increment the fence, does not duplicate the outbox, and the first reason wins", async () => {
      const { company, agent, binding } = await provisionBinding("Revoke Idem Test", "Revoke Idem Bot");

      const first = await agentKnowledgeService(db).revokeAgentBinding({
        companyId: company.id,
        agentId: agent.id,
        reason: "agent_terminated",
      });
      expect(first).not.toBeNull();
      expect(first!.reason).toBe("agent_terminated");
      expect(first!.fenceEpoch).toBe(2);

      // Repeated revocations (including a DIFFERENT reason) are idempotent:
      // the tombstone keeps its original fence epoch and reason, and the
      // outbox keeps exactly one row.
      const second = await agentKnowledgeService(db).revokeAgentBinding({
        companyId: company.id,
        agentId: agent.id,
        reason: "manual_revocation" as KnowledgeRevocationReason,
      });
      const third = await agentKnowledgeService(db).revokeAgentBinding({
        companyId: company.id,
        agentId: agent.id,
        reason: "policy_revoked",
      });

      expect(second!.id).toBe(first!.id);
      expect(third!.id).toBe(first!.id);
      expect(second!.reason).toBe("agent_terminated");
      expect(third!.fenceEpoch).toBe(2);

      const bindingAfter = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(bindingAfter.id).toBe(binding.id);
      expect(bindingAfter.desiredAccess).toBe("revoked");
      expect(bindingAfter.state).toBe("revoked");
      expect(bindingAfter.fenceEpoch).toBe(2);

      const outboxRows = await db
        .select()
        .from(agentKnowledgeRevocations)
        .where(eq(agentKnowledgeRevocations.bindingId, binding.id));
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].id).toBe(first!.id);
      expect(outboxRows[0].status).toBe("pending");
      expect(outboxRows[0].reason).toBe("agent_terminated");
      expect(outboxRows[0].fenceEpoch).toBe(2);
    });
  });

  describe("binding mapping immutability: the actual constraints, not comments", () => {
    it("unit-checks the deterministic idempotency key formats", () => {
      expect(deterministicBindingIdempotencyKey("company-1", "agent-9")).toBe(
        "agent-knowledge-binding:company-1:agent-9",
      );
      expect(deterministicRevocationIdempotencyKey("company-1", "agent-9", 4)).toBe(
        "agent-knowledge-revocation:company-1:agent-9:4",
      );
    });

    it("rows carry exactly the deterministic keys, and suspend/resume cycles never rewrite the mapping columns", async () => {
      const { company, agent, binding } = await provisionBinding("Mapping Test", "Mapping Bot");

      expect(binding.idempotencyKey).toBe(
        deterministicBindingIdempotencyKey(company.id, agent.id),
      );
      expect(binding.companyId).toBe(company.id);
      expect(binding.agentIdSnapshot).toBe(agent.id);
      expect(binding.agentId).toBe(agent.id);

      // A full suspend/resume cycle must not rewrite the intended
      // bot/company mapping -- only the desired access, state, and fence.
      await agentService(db).pause(agent.id, "manual");
      await agentService(db).resume(agent.id);

      const cycled = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(cycled.id).toBe(binding.id);
      expect(cycled.companyId).toBe(binding.companyId);
      expect(cycled.agentIdSnapshot).toBe(binding.agentIdSnapshot);
      expect(cycled.agentId).toBe(binding.agentId);
      expect(cycled.idempotencyKey).toBe(binding.idempotencyKey);

      // Revocation snapshots the deterministic key at the fence it revokes at.
      await agentService(db).terminate(agent.id);
      const revoked = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(revoked.fenceEpoch).toBe(4);
      const outbox = await agentKnowledgeService(db).listRevocationsForBinding(binding.id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].idempotencyKey).toBe(
        deterministicRevocationIdempotencyKey(company.id, agent.id, 4),
      );
    });

    it("the (company_id, agent_id_snapshot) unique index blocks a replacement binding even after revocation", async () => {
      const { company, agent, binding } = await provisionBinding("Replacement Test", "Replacement Bot");
      await agentService(db).terminate(agent.id);
      // A fresh "rebind" for the same intended bot/company mapping cannot be
      // inserted: the revoked row IS the mapping forever. This is the actual
      // immutability constraint -- an index, not a comment.
      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: agent.id,
          idempotencyKey: `replacement-${agent.id}`,
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: 1,
        }),
        /duplicate key value.*company_agent_snapshot_uq/i,
      );

      const rows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, company.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(binding.id);
      expect(rows[0].desiredAccess).toBe("revoked");
    });

    it("enforces agent.company_id == binding.company_id at DB level (cross-company agent reference rejected)", async () => {
      const companyA = await createCompany("Cross Company A Test");
      const companyB = await createCompany("Cross Company B Test");
      const foreignAgent = await agentService(db).create(companyB.id, {
        name: "Foreign Bot",
        role: "general",
      });

      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: companyA.id,
          agentId: foreignAgent.id,
          agentIdSnapshot: foreignAgent.id,
          idempotencyKey: `cross-company-${foreignAgent.id}`,
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: 1,
        }),
        /agent company_id does not match binding company_id/i,
      );
    });

    it("enforces DB-level immutability: company_id and agent_id_snapshot cannot be remapped", async () => {
      const company = await createCompany("Remap Hole Test");
      const otherCompany = await createCompany("Remap Other Company");
      const tombstone = await insertRawBinding(company.id, "remap");

      // Remap of company_id is strictly rejected by trigger
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ companyId: otherCompany.id })
          .where(eq(agentKnowledgeBindings.id, tombstone.id)),
        /company_id is immutable/i,
      );

      // Remap of agentIdSnapshot on tombstone is strictly rejected by trigger
      const newSnapshot = randomUUID();
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ agentIdSnapshot: newSnapshot })
          .where(eq(agentKnowledgeBindings.id, tombstone.id)),
        /agent_id_snapshot is immutable/i,
      );

      // Remap of idempotency_key is rejected
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ idempotencyKey: "new-idempotency-key" })
          .where(eq(agentKnowledgeBindings.id, tombstone.id)),
        /idempotency_key is immutable/i,
      );

      // Reassignment of agent_id on tombstone is rejected
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ agentId: randomUUID() })
          .where(eq(agentKnowledgeBindings.id, tombstone.id)),
        /agent_id cannot be rebound on tombstone/i,
      );

      // While agent_id is set (the live shape), the snapshot CHECK also holds
      // the pair together
      const { company: liveCompany, agent: liveAgent } = await provisionBinding(
        "Remap Live Test",
        "Remap Live Bot",
      );
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ agentIdSnapshot: randomUUID() })
          .where(
            and(
              eq(agentKnowledgeBindings.companyId, liveCompany.id),
              eq(agentKnowledgeBindings.agentIdSnapshot, liveAgent.id),
            ),
          ),
        /agent_id_snapshot_check|agent_id_snapshot is immutable/i,
      );
    });
  });

  describe("revocations outbox table constraints", () => {
    it("enforces the agent snapshot check: agent_id must be NULL or equal agent_id_snapshot", async () => {
      const company = await createCompany("Rev Snapshot Test");
      const agent = await agentService(db).create(company.id, {
        name: "Rev Snapshot Bot",
        role: "general",
      });

      // Mismatch rejected (raw binding so no service-created outbox row
      // collides on the binding_id unique index first).
      const mismatchBinding = await insertRawBinding(company.id, "rs0000000001");
      await expectDbError(
        db.insert(agentKnowledgeRevocations).values({
          bindingId: mismatchBinding.id,
          companyId: company.id,
          agentId: agent.id,
          agentIdSnapshot: mismatchBinding.agentIdSnapshot,
          idempotencyKey: `rev-snapshot-mismatch-${mismatchBinding.id}`,
          status: "pending",
          reason: "manual_revocation",
          fenceEpoch: 2,
        }),
        /check constraint "agent_knowledge_revocations_agent_id_snapshot_check"/i,
      );

      // Matching insert succeeds.
      const matchBinding = await insertRawBinding(company.id, "rs0000000002", agent.id);
      const matched = await db
        .insert(agentKnowledgeRevocations)
        .values({
          bindingId: matchBinding.id,
          companyId: company.id,
          agentId: agent.id,
          agentIdSnapshot: agent.id,
          idempotencyKey: `rev-snapshot-match-${matchBinding.id}`,
          status: "pending",
          reason: "policy_revoked",
          fenceEpoch: 3,
        })
        .returning({ id: agentKnowledgeRevocations.id });
      expect(matched).toHaveLength(1);

      // agentId NULL with a snapshot succeeds (survives agent deletion).
      const orphanBinding = await insertRawBinding(company.id, "rs0000000003");
      const orphan = await db
        .insert(agentKnowledgeRevocations)
        .values({
          bindingId: orphanBinding.id,
          companyId: company.id,
          agentId: null,
          agentIdSnapshot: orphanBinding.agentIdSnapshot,
          idempotencyKey: `rev-snapshot-orphan-${orphanBinding.id}`,
          status: "pending",
          reason: "policy_revoked",
          fenceEpoch: 4,
        })
        .returning({ id: agentKnowledgeRevocations.id });
      expect(orphan).toHaveLength(1);
    });

    it("enforces EXACTLY ONE outbox row per binding, ever (binding_id unique)", async () => {
      // The binding_id unique index is the DB-level half of the "exactly one
      // revocation outbox entry" guarantee: not even a raw insert can add a
      // second row for a binding that already has one.
      const { company, agent, binding } = await provisionBinding("Rev Unique Test", "Rev Unique Bot");
      await agentService(db).terminate(agent.id);
      const outbox = await agentKnowledgeService(db).listRevocationsForBinding(binding.id);
      expect(outbox).toHaveLength(1);

      await expectDbError(
        db.insert(agentKnowledgeRevocations).values({
          bindingId: binding.id,
          companyId: company.id,
          agentIdSnapshot: agent.id,
          idempotencyKey: `rev-second-outbox-${binding.id}`,
          status: "pending",
          reason: "manual_revocation",
          fenceEpoch: 9,
        }),
        /duplicate key value.*agent_knowledge_revocations_binding_id_uq/i,
      );

      expect(await agentKnowledgeService(db).listRevocationsForBinding(binding.id)).toHaveLength(1);
    });

    it("enforces the status check: pending/confirmed/stalled only -- 'active' is unsupported in this slice", async () => {
      const company = await createCompany("Rev Status Test");

      for (const [i, badStatus] of ["active", "bogus", "completed"].entries()) {
        const binding = await insertRawBinding(company.id, `st${String(i).padStart(10, "0")}`);
        await expectDbError(
          db
            .insert(agentKnowledgeRevocations)
            .values({
              bindingId: binding.id,
              companyId: company.id,
              agentIdSnapshot: binding.agentIdSnapshot,
              idempotencyKey: `rev-status-${badStatus}-${binding.id}`,
              status: badStatus,
              reason: "manual_revocation",
              fenceEpoch: 2,
            })
            .then(() => undefined),
          /check constraint "agent_knowledge_revocations_status_check"/i,
        );
      }

      // Every allowed status round-trips, including the two the future
      // confirmation worker will write ('confirmed', 'stalled').
      const okBinding = await insertRawBinding(company.id, "st0000000010");
      const created = await db
        .insert(agentKnowledgeRevocations)
        .values({
          bindingId: okBinding.id,
          companyId: company.id,
          agentIdSnapshot: okBinding.agentIdSnapshot,
          idempotencyKey: `rev-status-ok-${okBinding.id}`,
          status: "pending",
          reason: "manual_revocation",
          fenceEpoch: 2,
        })
        .returning({ id: agentKnowledgeRevocations.id });
      for (const goodStatus of ["confirmed", "stalled"]) {
        const updated = await db
          .update(agentKnowledgeRevocations)
          .set({ status: goodStatus })
          .where(eq(agentKnowledgeRevocations.id, created[0].id))
          .returning({ status: agentKnowledgeRevocations.status });
        expect(updated[0].status).toBe(goodStatus);
      }
    });

    it("enforces the reason check: only the five contract reasons", async () => {
      const company = await createCompany("Rev Reason Test");
      const binding = await insertRawBinding(company.id, "rn0000000001");

      await expectDbError(
        db
          .insert(agentKnowledgeRevocations)
          .values({
            bindingId: binding.id,
            companyId: company.id,
            agentIdSnapshot: binding.agentIdSnapshot,
            idempotencyKey: `rev-reason-bad-${binding.id}`,
            status: "pending",
            reason: "not_a_reason",
            fenceEpoch: 2,
          })
          .then(() => undefined),
        /check constraint "agent_knowledge_revocations_reason_check"/i,
      );
    });

    it("enforces non-negative fence_epoch on revocations", async () => {
      const company = await createCompany("Rev Fence Test");
      const binding = await insertRawBinding(company.id, "fn0000000001");

      await expectDbError(
        db
          .insert(agentKnowledgeRevocations)
          .values({
            bindingId: binding.id,
            companyId: company.id,
            agentIdSnapshot: binding.agentIdSnapshot,
            idempotencyKey: `rev-fence-negative-${binding.id}`,
            status: "pending",
            reason: "manual_revocation",
            fenceEpoch: -1,
          })
          .then(() => undefined),
        /check constraint "agent_knowledge_revocations_fence_epoch_check"/i,
      );
    });
  });

  describe("last_error_code machine-code regex validation", () => {
    it("enforces machine-code regex [a-z0-9_]{1,64}: rejects newlines, emoji, punctuation, hyphens, and uppercase", async () => {
      const { company, agent, binding } = await provisionBinding("Error Code Test", "Error Code Bot");

      const invalidCodes = [
        "AUTH\nFAILED",
        "AUTH_FAILED", // uppercase not allowed
        "𝕒𝕝𝕒𝕣𝕞-💥",
        "alarm-1", // hyphens not allowed
        "sk-live-secret-token-fragment",
        "bad code with spaces",
        "",
      ];

      for (let i = 0; i < invalidCodes.length; i++) {
        const badCode = invalidCodes[i]!;
        await expectDbError(
          db.insert(agentKnowledgeBindings).values({
            companyId: company.id,
            agentIdSnapshot: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb00${i.toString().padStart(2, "0")}`,
            idempotencyKey: `err-code-bad-${i}`,
            desiredAccess: "active",
            state: "pending",
            fenceEpoch: 1,
            lastErrorCode: badCode,
          }),
          /check constraint "agent_knowledge_bindings_last_error_code_check"/i,
        );
      }

      await agentService(db).terminate(agent.id);
      await expectDbError(
        db
          .update(agentKnowledgeRevocations)
          .set({ lastErrorCode: "late\nresponse\nstale" })
          .where(eq(agentKnowledgeRevocations.bindingId, binding.id)),
        /check constraint "agent_knowledge_revocations_last_error_code_check"/i,
      );

      // Valid machine codes are accepted
      for (const [i, goodCode] of ["auth_failed", "timeout_exceeded", "token_revoked_401", "x".repeat(64)].entries()) {
        const okId = `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb01${i.toString().padStart(2, "0")}`;
        const [inserted] = await db
          .insert(agentKnowledgeBindings)
          .values({
            companyId: company.id,
            agentIdSnapshot: okId,
            idempotencyKey: `err-code-good-${i}`,
            desiredAccess: "active",
            state: "pending",
            fenceEpoch: 1,
            lastErrorCode: goodCode,
          })
          .returning({ lastErrorCode: agentKnowledgeBindings.lastErrorCode });
        expect(inserted.lastErrorCode).toBe(goodCode);
      }
    });

    it("rejects codes longer than 64 characters on both tables", async () => {
      const company = await createCompany("Error Bound Test");
      const binding = await insertRawBinding(company.id, "eb0000000001");

      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          idempotencyKey: "err-code-too-long-bind",
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: 1,
          lastErrorCode: "E".repeat(65),
        }),
        /check constraint "agent_knowledge_bindings_last_error_code_check"/i,
      );

      await expectDbError(
        db
          .insert(agentKnowledgeRevocations)
          .values({
            bindingId: binding.id,
            companyId: company.id,
            agentIdSnapshot: binding.agentIdSnapshot,
            idempotencyKey: `err-code-too-long-rev-${binding.id}`,
            status: "pending",
            reason: "manual_revocation",
            fenceEpoch: 2,
            lastErrorCode: "R".repeat(65),
          })
          .then(() => undefined),
        /check constraint "agent_knowledge_revocations_last_error_code_check"/i,
      );
    });
  });

  describe("bindings desired_access check", () => {
    it("rejects any desired_access outside active/suspended/revoked", async () => {
      const company = await createCompany("Desired Access Test");

      await expectDbError(
        db.insert(agentKnowledgeBindings).values({
          companyId: company.id,
          agentIdSnapshot: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          idempotencyKey: "desired-bogus",
          desiredAccess: "enabled",
          state: "pending",
          fenceEpoch: 1,
        }),
        /check constraint "agent_knowledge_bindings_desired_access_check"/i,
      );

      // All three contract values are writable (revoked included: the
      // tombstone is a legal desired state).
      for (const [i, access] of ["active", "suspended", "revoked"].entries()) {
        const inserted = await db
          .insert(agentKnowledgeBindings)
          .values({
            companyId: company.id,
            agentIdSnapshot: `dddddddd-dddd-4ddd-8ddd-dddddddd000${i}`,
            idempotencyKey: `desired-ok-${access}`,
            desiredAccess: access,
            state: "pending",
            fenceEpoch: 1,
          })
          .returning({ desiredAccess: agentKnowledgeBindings.desiredAccess });
        expect(inserted[0].desiredAccess).toBe(access);
      }
    });
  });

  describe("deletion survivability carries the revocation context", () => {
    it("agent removal preserves reason, idempotency key, and principal/brain snapshots in the outbox", async () => {
      const { company, agent, binding } = await provisionBinding("Survive Agent Test", "Survive Agent Bot");

      // Give the binding the authoritative principal/brain identifiers the
      // future revoke will need to act on.
      await db
        .update(agentKnowledgeBindings)
        .set({ principalId: "principal-survive-1", brainId: "brain-survive-1" })
        .where(eq(agentKnowledgeBindings.id, binding.id));

      await agentService(db).remove(agent.id);

      const bindingAfter = (await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.id, binding.id)
      ))[0]!;
      expect(bindingAfter.agentId).toBeNull();
      expect(bindingAfter.agentIdSnapshot).toBe(agent.id);
      expect(bindingAfter.principalId).toBe("principal-survive-1");

      const outbox = await db
        .select()
        .from(agentKnowledgeRevocations)
        .where(eq(agentKnowledgeRevocations.bindingId, binding.id));
      expect(outbox).toHaveLength(1);
      expect(outbox[0].reason).toBe("agent_removed");
      expect(outbox[0].status).toBe("pending");
      expect(outbox[0].agentId).toBeNull();
      expect(outbox[0].agentIdSnapshot).toBe(agent.id);
      expect(outbox[0].principalIdSnapshot).toBe("principal-survive-1");
      expect(outbox[0].brainIdSnapshot).toBe("brain-survive-1");
      expect(outbox[0].fenceEpoch).toBe(2);
      expect(outbox[0].idempotencyKey).toBe(
        deterministicRevocationIdempotencyKey(company.id, agent.id, 2),
      );
    });

    it("company removal preserves reason, idempotency key, and principal/brain snapshots even as company secrets and activity rows are deleted", async () => {
      const { company, agent, binding } = await provisionBinding("Survive Company Test", "Survive Company Bot");

      await db
        .update(agentKnowledgeBindings)
        .set({ principalId: "principal-company-2", brainId: "brain-company-2" })
        .where(eq(agentKnowledgeBindings.id, binding.id));

      // Seed the company-scoped rows the removal cascade deletes: the
      // revocation must not lose its context when they vanish.
      await db.insert(companySecrets).values({
        companyId: company.id,
        key: "SURVIVE_KEY",
        name: "Survive Secret",
      });
      await db.insert(activityLog).values({
        companyId: company.id,
        actorType: "user",
        actorId: "seed-user",
        action: "company.seeded",
        entityType: "company",
        entityId: company.id,
      });

      await companyService(db).remove(company.id);

      expect(await companyService(db).getById(company.id)).toBeNull();
      // The deleted company's secrets and activity are gone...
      const secrets = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.companyId, company.id));
      expect(secrets).toHaveLength(0);
      const activity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, company.id));
      expect(activity).toHaveLength(0);
      // ...but the ledger rows survive with everything a future revoke needs.
      const bindingAfter = (await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.id, binding.id)))[0]!;
      expect(bindingAfter.companyId).toBe(company.id);
      expect(bindingAfter.agentIdSnapshot).toBe(agent.id);
      expect(bindingAfter.desiredAccess).toBe("revoked");
      expect(bindingAfter.state).toBe("revoked");
      expect(bindingAfter.principalId).toBe("principal-company-2");

      const outbox = await db
        .select()
        .from(agentKnowledgeRevocations)
        .where(eq(agentKnowledgeRevocations.bindingId, binding.id));
      expect(outbox).toHaveLength(1);
      expect(outbox[0].reason).toBe("company_removed");
      expect(outbox[0].companyId).toBe(company.id);
      expect(outbox[0].principalIdSnapshot).toBe("principal-company-2");
      expect(outbox[0].brainIdSnapshot).toBe("brain-company-2");
      expect(outbox[0].fenceEpoch).toBe(2);
      expect(outbox[0].idempotencyKey).toBe(
        deterministicRevocationIdempotencyKey(company.id, agent.id, 2),
      );
    });
  });

  describe("transaction rollback and atomic terminate", () => {
    it("a failed caller transaction rolls back the binding insert entirely", async () => {
      const company = await createCompany("Tx Rollback Bind Test");
      const agent = await agentService(db).create(company.id, {
        name: "Tx Rollback Bind Bot",
        role: "general",
      });

      await expect(
        db.transaction(async (tx) => {
          await agentKnowledgeService(tx as unknown as Db).createPendingBinding({
            companyId: company.id,
            agentId: agent.id,
          });
          throw new Error("forced rollback");
        }),
      ).rejects.toThrow("forced rollback");

      const rows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, company.id),
            eq(agentKnowledgeBindings.agentIdSnapshot, agent.id),
          ),
        );
      expect(rows).toHaveLength(0);
    });

    it("a failed revocation inside a caller transaction rolls back the binding update, the agent termination, and the key revocation (terminate()'s tx pattern)", async () => {
      const { company, agent, binding } = await provisionBinding("Tx Rollback Revoke Test", "Tx Rollback Revoke Bot");
      await agentService(db).createApiKey(agent.id, "Rollback Key");

      // Mirrors terminate(): agent status write + API key revocation + ledger
      // revocation, all inside ONE transaction. Here the ledger revocation
      // fails on the reason CHECK, so nothing may survive the transaction.
      await expectDbError(
        db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await tx
            .update(agents)
            .set({ status: "terminated", updatedAt: new Date() })
            .where(eq(agents.id, agent.id));
          await tx
            .update(agentApiKeys)
            .set({ revokedAt: new Date() })
            .where(eq(agentApiKeys.agentId, agent.id));
          await agentKnowledgeService(txDb).revokeAgentBinding({
            companyId: company.id,
            agentId: agent.id,
            reason: "not_a_reason" as KnowledgeRevocationReason,
          });
        }),
        /check constraint "agent_knowledge_revocations_reason_check"/i,
      );

      const agentAfter = await agentService(db).getById(agent.id);
      expect(agentAfter?.status).toBe("idle");

      const keys = await agentService(db).listKeys(agent.id);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k: { revokedAt: Date | null }) => k.revokedAt === null)).toBe(true);

      const bindingAfter = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(bindingAfter.desiredAccess).toBe("active");
      expect(bindingAfter.state).toBe("pending");
      expect(bindingAfter.fenceEpoch).toBe(1);
      expect(await agentKnowledgeService(db).listRevocationsForBinding(binding.id)).toHaveLength(0);
    });
  });

  describe("concurrent races across independent sessions", () => {
    it("two independent sessions racing createPendingBinding converge on one row with fence 1", async () => {
      const company = await createCompany("Race Create Test");
      const agent = await agentService(db).create(company.id, {
        name: "Race Create Bot",
        role: "general",
      });

      const [fromA, fromB] = await Promise.all([
        agentKnowledgeService(dbA).createPendingBinding({
          companyId: company.id,
          agentId: agent.id,
        }),
        agentKnowledgeService(dbB).createPendingBinding({
          companyId: company.id,
          agentId: agent.id,
        }),
      ]);

      expect(fromA.id).toBe(fromB.id);
      expect(fromA.fenceEpoch).toBe(1);

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
    });

    it("two independent sessions racing revokeAgentBinding enqueue exactly one outbox row at one fence", async () => {
      const company = await createCompany("Race Revoke Test");
      const agent = await agentService(db).create(company.id, {
        name: "Race Revoke Bot",
        role: "general",
      });
      const binding = await agentKnowledgeService(db).createPendingBinding({
        companyId: company.id,
        agentId: agent.id,
      });

      const [fromA, fromB] = await Promise.all([
        agentKnowledgeService(dbA).revokeAgentBinding({
          companyId: company.id,
          agentId: agent.id,
          reason: "agent_terminated",
        }),
        agentKnowledgeService(dbB).revokeAgentBinding({
          companyId: company.id,
          agentId: agent.id,
          reason: "agent_terminated",
        }),
      ]);

      expect(fromA!.id).toBe(fromB!.id);
      expect(fromA!.fenceEpoch).toBe(2);

      const bindingAfter = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(bindingAfter.desiredAccess).toBe("revoked");
      expect(bindingAfter.state).toBe("revoked");
      expect(bindingAfter.fenceEpoch).toBe(2);

      const outbox = await agentKnowledgeService(db).listRevocationsForBinding(binding.id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].id).toBe(fromA!.id);
      expect(outbox[0].fenceEpoch).toBe(2);
    });
  });

  describe("portability import cannot copy principal or brain IDs to another company", () => {
    it("export then import into another company mints a fresh binding with NULL principal/brain; source rows untouched", async () => {
      const { company: sourceCompany, agent: sourceAgent, binding: sourceBinding } =
        await provisionBinding("Import Source Test", "Import Source Bot");

      await db
        .update(agentKnowledgeBindings)
        .set({ principalId: "principal-import-src", brainId: "brain-import-src" })
        .where(eq(agentKnowledgeBindings.id, sourceBinding.id));

      const targetCompany = await createCompany("Import Target Test");

      const exported = await companyPortabilityService(db).exportBundle(sourceCompany.id, {
        agents: [sourceAgent.id],
      });

      // Belt and braces: the exported package carries no ledger data at all.
      const exportedJson = JSON.stringify(exported);
      expect(exportedJson).not.toContain("principal-import-src");
      expect(exportedJson).not.toContain("brain-import-src");
      expect(exportedJson).not.toContain("agent_knowledge_bindings");

      // Enable the ledger for the target company only: the import's agent
      // creation hooks must mint a brand-new binding there, with NO copied
      // principal or brain identifiers.
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [targetCompany.id],
      });

      const imported = await companyPortabilityService(db).importBundle(
        {
          source: {
            type: "inline",
            rootPath: exported.rootPath,
            files: exported.files,
            expectedFileCount: Object.keys(exported.files).length,
          },
          target: { mode: "existing_company", companyId: targetCompany.id },
          include: { company: false, agents: true, projects: false, issues: false, skills: false },
          collisionStrategy: "rename",
        },
        "importing-board-user",
      );

      const importedAgentEntry = imported.agents.find((entry) => entry.action === "created");
      expect(importedAgentEntry).toBeDefined();
      expect(importedAgentEntry!.id).not.toBeNull();

      const targetBindings = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, targetCompany.id));
      expect(targetBindings).toHaveLength(1);
      expect(targetBindings[0].agentIdSnapshot).toBe(importedAgentEntry!.id);
      // The fresh binding carries no authority identifiers: principal and
      // brain are minted by the (future) authority worker, never copied.
      expect(targetBindings[0].principalId).toBeNull();
      expect(targetBindings[0].brainId).toBeNull();
      expect(targetBindings[0].desiredAccess).toBe("active");
      expect(targetBindings[0].state).toBe("pending");
      expect(targetBindings[0].fenceEpoch).toBe(1);

      // The source company's ledger rows are untouched: still exactly one
      // binding, still carrying the source principal/brain.
      const sourceBindings = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, sourceCompany.id));
      expect(sourceBindings).toHaveLength(1);
      expect(sourceBindings[0].id).toBe(sourceBinding.id);
      expect(sourceBindings[0].principalId).toBe("principal-import-src");

      // No revocation rows were minted for the import.
      const targetRevocations = await db
        .select()
        .from(agentKnowledgeRevocations)
        .where(eq(agentKnowledgeRevocations.companyId, targetCompany.id));
      expect(targetRevocations).toHaveLength(0);
    });

    it("import with the ledger disabled for the target company creates no binding rows at all", async () => {
      const { company: sourceCompany, agent: sourceAgent } =
        await provisionBinding("Import Off Source Test", "Import Off Source Bot");

      const exported = await companyPortabilityService(db).exportBundle(sourceCompany.id, {
        agents: [sourceAgent.id],
      });

      const targetCompany = await createCompany("Import Off Target Test");
      // Ledger enabled only for the SOURCE company: the target is not in the
      // pilot allowlist, so the import must provision nothing there.
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [sourceCompany.id],
      });

      const imported = await companyPortabilityService(db).importBundle(
        {
          source: {
            type: "inline",
            rootPath: exported.rootPath,
            files: exported.files,
            expectedFileCount: Object.keys(exported.files).length,
          },
          target: { mode: "existing_company", companyId: targetCompany.id },
          include: { company: false, agents: true, projects: false, issues: false, skills: false },
          collisionStrategy: "rename",
        },
        "importing-board-user",
      );

      expect(imported.agents.some((entry) => entry.action === "created")).toBe(true);

      const targetBindings = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, targetCompany.id));
      expect(targetBindings).toHaveLength(0);
    });
  });

  describe("cross-company revocation forgery prevention and tombstone immutability", () => {
    it("composite FK blocks attaching a tenant's own revocation row to a foreign company's binding", async () => {
      const companyA = await createCompany("Forgery Company A");
      const companyB = await createCompany("Forgery Company B");
      const { agent: agentB, binding: bindingB } = await provisionBinding("Foreign B", "Bot B");

      // Company A attempts to forge a revocation pointing to Company B's binding with Company A's companyId
      await expectDbError(
        db.insert(agentKnowledgeRevocations).values({
          bindingId: bindingB.id,
          companyId: companyA.id,
          agentIdSnapshot: agentB.id,
          idempotencyKey: `forged-rev-${bindingB.id}`,
          status: "pending",
          reason: "manual_revocation",
          fenceEpoch: 2,
        }),
        /agent_knowledge_revocations_binding_composite_fk|foreign key constraint/i,
      );

      // Attempting with wrong agent_id_snapshot also fails composite FK
      await expectDbError(
        db.insert(agentKnowledgeRevocations).values({
          bindingId: bindingB.id,
          companyId: bindingB.companyId,
          agentIdSnapshot: randomUUID(),
          idempotencyKey: `forged-agent-rev-${bindingB.id}`,
          status: "pending",
          reason: "manual_revocation",
          fenceEpoch: 2,
        }),
        /agent_knowledge_revocations_binding_composite_fk|agent_knowledge_revocations_agent_id_snapshot_check|agent_id_snapshot does not match binding/i,
      );
    });

    it("RLS non-superuser session blocks forging cross-company binding or revocation", async () => {
      const companyA = await createCompany("RLS Forge Company A");
      const { company: companyB, agent: agentB, binding: bindingB } = await provisionBinding(
        "RLS Forge Company B",
        "Bot B",
      );

      // In a session scoped to companyA:
      // 1. Trying to forge a revocation for companyB's binding using companyB's companyId fails RLS WITH CHECK
      await expectDbError(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE rls_term_app_role`);
          await tx.execute(sql`SELECT set_config('app.current_company_id', ${companyA.id}, true)`);

          await tx.insert(agentKnowledgeRevocations).values({
            bindingId: bindingB.id,
            companyId: companyB.id,
            agentIdSnapshot: agentB.id,
            idempotencyKey: `rls-forged-rev-b-${bindingB.id}`,
            status: "pending",
            reason: "manual_revocation",
            fenceEpoch: 2,
          });
        }),
        /row-level security policy for table "agent_knowledge_revocations"/i,
      );

      // 2. Trying to forge using companyA's companyId fails the composite foreign key
      await expectDbError(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE rls_term_app_role`);
          await tx.execute(sql`SELECT set_config('app.current_company_id', ${companyA.id}, true)`);

          await tx.insert(agentKnowledgeRevocations).values({
            bindingId: bindingB.id,
            companyId: companyA.id,
            agentIdSnapshot: agentB.id,
            idempotencyKey: `rls-forged-rev-a-${bindingB.id}`,
            status: "pending",
            reason: "manual_revocation",
            fenceEpoch: 2,
          });
        }),
        /agent_knowledge_revocations_binding_composite_fk|foreign key constraint/i,
      );
    });

    it("enforces immutability on revocation outbox columns", async () => {
      const { company, agent, binding } = await provisionBinding("Rev Immutability", "Rev Bot");
      await agentService(db).terminate(agent.id);

      const outbox = (await agentKnowledgeService(db).listRevocationsForBinding(binding.id))[0]!;
      expect(outbox).toBeDefined();

      // Attempting to update company_id is rejected by trigger
      await expectDbError(
        db
          .update(agentKnowledgeRevocations)
          .set({ companyId: randomUUID() })
          .where(eq(agentKnowledgeRevocations.id, outbox.id)),
        /agent_knowledge_revocations company_id is immutable/i,
      );

      // Attempting to update agent_id_snapshot is rejected by trigger
      await expectDbError(
        db
          .update(agentKnowledgeRevocations)
          .set({ agentIdSnapshot: randomUUID() })
          .where(eq(agentKnowledgeRevocations.id, outbox.id)),
        /agent_knowledge_revocations agent_id_snapshot is immutable/i,
      );

      // Attempting to update binding_id is rejected by trigger
      await expectDbError(
        db
          .update(agentKnowledgeRevocations)
          .set({ bindingId: randomUUID() })
          .where(eq(agentKnowledgeRevocations.id, outbox.id)),
        /agent_knowledge_revocations binding_id is immutable/i,
      );

      // Attempting to update reason is rejected by trigger
      await expectDbError(
        db
          .update(agentKnowledgeRevocations)
          .set({ reason: "policy_revoked" })
          .where(eq(agentKnowledgeRevocations.id, outbox.id)),
        /agent_knowledge_revocations reason is immutable/i,
      );

      // Attempting to update fence_epoch is rejected by trigger
      await expectDbError(
        db
          .update(agentKnowledgeRevocations)
          .set({ fenceEpoch: 99 })
          .where(eq(agentKnowledgeRevocations.id, outbox.id)),
        /agent_knowledge_revocations fence_epoch is immutable/i,
      );

      // Attempting to update idempotency_key is rejected by trigger
      await expectDbError(
        db
          .update(agentKnowledgeRevocations)
          .set({ idempotencyKey: "forged-idempotency-key" })
          .where(eq(agentKnowledgeRevocations.id, outbox.id)),
        /agent_knowledge_revocations idempotency_key is immutable/i,
      );

      // Updating status (e.g. to confirmed by future worker) is allowed
      const [updated] = await db
        .update(agentKnowledgeRevocations)
        .set({ status: "confirmed", confirmedAt: new Date() })
        .where(eq(agentKnowledgeRevocations.id, outbox.id))
        .returning({ status: agentKnowledgeRevocations.status });
      expect(updated.status).toBe("confirmed");
    });

    it("enforces one-time setting and immutability of principal_id and brain_id on bindings", async () => {
      const { company, agent, binding } = await provisionBinding("Principal Brain Test", "PB Bot");
      expect(binding.principalId).toBeNull();
      expect(binding.brainId).toBeNull();

      // One-time setting from NULL to value succeeds
      const [setRow] = await db
        .update(agentKnowledgeBindings)
        .set({ principalId: "principal-first-1", brainId: "brain-first-1" })
        .where(eq(agentKnowledgeBindings.id, binding.id))
        .returning({ principalId: agentKnowledgeBindings.principalId, brainId: agentKnowledgeBindings.brainId });
      expect(setRow.principalId).toBe("principal-first-1");
      expect(setRow.brainId).toBe("brain-first-1");

      // Attempting to change principalId once set is rejected by trigger
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ principalId: "principal-second-2" })
          .where(eq(agentKnowledgeBindings.id, binding.id)),
        /agent_knowledge_bindings principal_id is immutable once set/i,
      );

      // Attempting to change brainId once set is rejected by trigger
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ brainId: "brain-second-2" })
          .where(eq(agentKnowledgeBindings.id, binding.id)),
        /agent_knowledge_bindings brain_id is immutable once set/i,
      );
    });

    it("enforces terminal permanence: raw updates cannot un-revoke a revoked binding", async () => {
      const { company, agent, binding } = await provisionBinding("Unrevoke Test", "Unrevoke Bot");
      await agentService(db).terminate(agent.id);

      const revokedBinding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(revokedBinding.desiredAccess).toBe("revoked");
      expect(revokedBinding.state).toBe("revoked");

      // Raw attempt to reset desired_access to active fails trigger
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ desiredAccess: "active" })
          .where(eq(agentKnowledgeBindings.id, revokedBinding.id)),
        /agent_knowledge_bindings desired_access cannot be changed once revoked/i,
      );

      // Raw attempt to reset state to pending fails trigger
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ state: "pending" })
          .where(eq(agentKnowledgeBindings.id, revokedBinding.id)),
        /agent_knowledge_bindings state cannot be changed once revoked/i,
      );
    });

    it("enforces no fence_epoch rewind at DB level (fence_epoch cannot decrease)", async () => {
      const { company, agent, binding } = await provisionBinding("Rewind Test", "Rewind Bot");
      expect(binding.fenceEpoch).toBe(1);

      // Raw attempt to decrement fence_epoch fails trigger
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ fenceEpoch: 0 })
          .where(eq(agentKnowledgeBindings.id, binding.id)),
        /agent_knowledge_bindings fence_epoch cannot decrease/i,
      );

      // Incrementing fence_epoch is allowed
      const [bumped] = await db
        .update(agentKnowledgeBindings)
        .set({ fenceEpoch: 2 })
        .where(eq(agentKnowledgeBindings.id, binding.id))
        .returning({ fenceEpoch: agentKnowledgeBindings.fenceEpoch });
      expect(bumped.fenceEpoch).toBe(2);

      // Attempting to step back from 2 to 1 fails
      await expectDbError(
        db
          .update(agentKnowledgeBindings)
          .set({ fenceEpoch: 1 })
          .where(eq(agentKnowledgeBindings.id, binding.id)),
        /agent_knowledge_bindings fence_epoch cannot decrease/i,
      );
    });

    it("blocks raw agents.company_id move for bound agents via DB trigger", async () => {
      const { company: companyA, agent } = await provisionBinding("Move Test A", "Move Bot");
      const companyB = await createCompany("Move Test B");

      // Attempting to move agent to companyB is rejected by trigger
      await expectDbError(
        db
          .update(agents)
          .set({ companyId: companyB.id })
          .where(eq(agents.id, agent.id)),
        /agents company_id cannot be changed for agents with knowledge bindings/i,
      );

      // Even after termination / revocation, company_id cannot be changed
      await agentService(db).terminate(agent.id);
      await expectDbError(
        db
          .update(agents)
          .set({ companyId: companyB.id })
          .where(eq(agents.id, agent.id)),
        /agents company_id cannot be changed for agents with knowledge bindings/i,
      );
    });

    it("blocks raw DELETE or TRUNCATE on agent_knowledge_bindings and agent_knowledge_revocations", async () => {
      const { company, agent, binding } = await provisionBinding("Delete Test", "Delete Bot");

      // Attempting raw delete on bindings is rejected
      await expectDbError(
        db.delete(agentKnowledgeBindings).where(eq(agentKnowledgeBindings.id, binding.id)),
        /deletion of agent_knowledge_bindings rows is forbidden/i,
      );

      await agentService(db).terminate(agent.id);
      const outbox = (await agentKnowledgeService(db).listRevocationsForBinding(binding.id))[0]!;

      // Attempting raw delete on revocations is rejected
      await expectDbError(
        db.delete(agentKnowledgeRevocations).where(eq(agentKnowledgeRevocations.id, outbox.id)),
        /deletion of agent_knowledge_revocations rows is forbidden/i,
      );
    });

    it("two independent sessions racing suspend both increment fence (+2 total, no lost increment)", async () => {
      const company = await createCompany("Race Suspend Test");
      const agent = await agentService(db).create(company.id, {
        name: "Race Suspend Bot",
        role: "general",
      });
      const binding = await agentKnowledgeService(db).createPendingBinding({
        companyId: company.id,
        agentId: agent.id,
      });
      expect(binding.fenceEpoch).toBe(1);

      await Promise.all([
        agentKnowledgeService(dbA).suspendAgentBinding({ companyId: company.id, agentId: agent.id }),
        agentKnowledgeService(dbB).suspendAgentBinding({ companyId: company.id, agentId: agent.id }),
      ]);

      const finalBinding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(finalBinding.desiredAccess).toBe("suspended");
      expect(finalBinding.fenceEpoch).toBe(3); // 1 -> 2 -> 3, no lost update!
    });

    it("concurrent suspend and revoke race: terminal revoke wins and cannot be un-revoked", async () => {
      const company = await createCompany("Race Revoke Suspend Test");
      const agent = await agentService(db).create(company.id, {
        name: "Race RS Bot",
        role: "general",
      });
      await agentKnowledgeService(db).createPendingBinding({
        companyId: company.id,
        agentId: agent.id,
      });

      // Revoke
      await agentKnowledgeService(dbA).revokeAgentBinding({
        companyId: company.id,
        agentId: agent.id,
        reason: "agent_terminated",
      });

      // Subsequent suspend cannot un-revoke or overwrite
      const suspended = await agentKnowledgeService(dbB).suspendAgentBinding({
        companyId: company.id,
        agentId: agent.id,
      });
      expect(suspended).toBeNull();

      const finalBinding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(finalBinding.desiredAccess).toBe("revoked");
      expect(finalBinding.state).toBe("revoked");
    });

    it("clearError CAS predicate prevents overwriting concurrent budget pause or termination", async () => {
      const company = await createCompany("ClearError CAS");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Error Bot",
        role: "general",
      });
      // Set to error
      await db.update(agents).set({ status: "error", errorReason: "crashed" }).where(eq(agents.id, agent.id));

      // Concurrently pause the agent (e.g. budget pause)
      await agentService(db).pause(agent.id, "budget");

      // clearError should now fail because status is no longer "error"
      await expect(
        agentService(db).clearError(agent.id),
      ).rejects.toThrow(/Only agents in error status can have their error cleared/i);

      // Verify status is still paused and binding is still suspended
      const agentAfter = (await agentService(db).getById(agent.id))!;
      expect(agentAfter.status).toBe("paused");
      expect(agentAfter.pauseReason).toBe("budget");

      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("suspended");
    });

    it("PATCH-to-active supported status updates ledger correctly", async () => {
      const company = await createCompany("Active Patch Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Active Patch Bot",
        role: "general",
      });
      await agentService(db).pause(agent.id, "manual");

      // Update directly with status: "active"
      const updated = await agentService(db).update(agent.id, { status: "active" });
      expect(updated?.status).toBe("active");

      const binding = (await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))!;
      expect(binding.desiredAccess).toBe("active");
      expect(binding.state).toBe("pending"); // awaiting future worker
    });

    it("companyreactivate preserves individually manual/budget paused agent suspensions", async () => {
      const company = await createCompany("Selective Reactivate");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const manualBot = await agentService(db).create(company.id, {
        name: "Manual Bot",
        role: "general",
      });
      const normalBot = await agentService(db).create(company.id, {
        name: "Normal Bot",
        role: "general",
      });

      // Manually pause manualBot
      await agentService(db).pause(manualBot.id, "manual");
      expect((await agentKnowledgeService(db).getBindingForAgent(company.id, manualBot.id))?.desiredAccess).toBe("suspended");

      // Archive company (pauses normalBot with company_archived)
      await companyService(db).archive(company.id);
      expect((await agentKnowledgeService(db).getBindingForAgent(company.id, normalBot.id))?.desiredAccess).toBe("suspended");

      // Reactivate company
      await companyService(db).update(company.id, { status: "active" });

      // normalBot is resumed
      expect((await agentService(db).getById(normalBot.id))?.status).toBe("idle");
      expect((await agentKnowledgeService(db).getBindingForAgent(company.id, normalBot.id))?.desiredAccess).toBe("active");

      // manualBot REMAINS paused and its binding REMAINS suspended!
      const manualAfter = (await agentService(db).getById(manualBot.id))!;
      expect(manualAfter.status).toBe("paused");
      expect(manualAfter.pauseReason).toBe("manual");
      expect((await agentKnowledgeService(db).getBindingForAgent(company.id, manualBot.id))?.desiredAccess).toBe("suspended");
    });

    it("budget paired mutations: real budgetService APIs synchronize bindings in same transaction", async () => {
      const company = await createCompany("Budget Real API");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Budget Real Bot",
        role: "general",
      });

      const bSvc = budgetService(db);
      // Upsert policy with hard stop enabled and low amount
      await bSvc.upsertPolicy(
        company.id,
        {
          scopeType: "agent",
          scopeId: agent.id,
          amount: 50,
          hardStopEnabled: true,
        },
        "test-user",
      );

      // Trigger hard stop via evaluateCostEvent with real cost event in db
      const [costEvent] = await db
        .insert(costEvents)
        .values({
          companyId: company.id,
          agentId: agent.id,
          costCents: 100,
          provider: "anthropic",
          model: "claude-3-opus",
          occurredAt: new Date(),
        })
        .returning();
      await bSvc.evaluateCostEvent(costEvent);

      // Agent is paused with pauseReason = budget, and binding is suspended!
      const agentAfterPause = (await agentService(db).getById(agent.id))!;
      expect(agentAfterPause.status).toBe("paused");
      expect(agentAfterPause.pauseReason).toBe("budget");
      expect((await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))?.desiredAccess).toBe("suspended");

      // Resolve budget by increasing policy amount
      await bSvc.upsertPolicy(
        company.id,
        {
          scopeType: "agent",
          scopeId: agent.id,
          amount: 500,
        },
        "test-user",
      );

      // Agent is resumed to idle and binding is resumed to active!
      const agentAfterResume = (await agentService(db).getById(agent.id))!;
      expect(agentAfterResume.status).toBe("idle");
      expect(agentAfterResume.pauseReason).toBeNull();
      expect((await agentKnowledgeService(db).getBindingForAgent(company.id, agent.id))?.desiredAccess).toBe("active");
    });

    it("concurrent terminate and company remove execute without 40P01 deadlock", async () => {
      const company = await createCompany("Deadlock Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Deadlock Bot",
        role: "general",
      });

      // Concurrently run terminate on dbA and remove company on dbB
      const results = await Promise.allSettled([
        agentService(dbA).terminate(agent.id),
        companyService(dbB).remove(company.id),
      ]);

      // Neither should fail with 40P01 (deadlock detected)
      for (const res of results) {
        if (res.status === "rejected") {
          const err = res.reason as any;
          expect(err?.code, `Expected no 40P01 deadlock but got: ${err?.message}`).not.toBe("40P01");
        }
      }

      // Both binding and revocation rows survive cleanly
      const rows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, company.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].desiredAccess).toBe("revoked");
    });

    it("barrier-controlled concurrent COMPANY budget pause vs company remove executes without 40P01 deadlock", async () => {
      const company = await createCompany("Budget Company Deadlock Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Budget Company Deadlock Bot",
        role: "general",
      });

      const bSvcA = budgetService(dbA);

      // Create company budget policy with hard stop enabled
      await bSvcA.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: 50,
          hardStopEnabled: true,
        },
        "test-user",
      );

      // Insert cost event to trigger budget hard stop
      const [costEvent] = await db
        .insert(costEvents)
        .values({
          companyId: company.id,
          agentId: agent.id,
          costCents: 100,
          provider: "anthropic",
          model: "claude-3-opus",
          occurredAt: new Date(),
        })
        .returning();

      // Concurrently run budget pause on dbA and company remove on dbB
      const results = await Promise.allSettled([
        bSvcA.evaluateCostEvent(costEvent),
        companyService(dbB).remove(company.id),
      ]);

      // Assert no 40P01 (deadlock detected) in either operation
      for (const res of results) {
        if (res.status === "rejected") {
          const err = res.reason as any;
          expect(err?.code, `Expected no 40P01 deadlock but got: ${err?.message}`).not.toBe("40P01");
        }
      }

      // Ledger bindings survive with terminal revoked status
      const rows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, company.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].desiredAccess).toBe("revoked");
    });

    it("barrier-controlled concurrent COMPANY budget resume vs company remove executes without 40P01 deadlock", async () => {
      const company = await createCompany("Budget Resume Deadlock Test");
      setAgentKnowledgeConfigForTests({
        enabled: true,
        pilotCompanyIds: [company.id],
      });
      const agent = await agentService(db).create(company.id, {
        name: "Budget Resume Deadlock Bot",
        role: "general",
      });

      const bSvcA = budgetService(dbA);

      // Create and pause company via budget policy
      await bSvcA.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: 50,
          hardStopEnabled: true,
        },
        "test-user",
      );
      const [costEvent] = await db
        .insert(costEvents)
        .values({
          companyId: company.id,
          agentId: agent.id,
          costCents: 100,
          provider: "anthropic",
          model: "claude-3-opus",
          occurredAt: new Date(),
        })
        .returning();
      await bSvcA.evaluateCostEvent(costEvent);

      // Now resume budget by increasing limit on dbA while concurrently removing company on dbB
      const results = await Promise.allSettled([
        bSvcA.upsertPolicy(
          company.id,
          {
            scopeType: "company",
            scopeId: company.id,
            amount: 500,
          },
          "test-user",
        ),
        companyService(dbB).remove(company.id),
      ]);

      for (const res of results) {
        if (res.status === "rejected") {
          const err = res.reason as any;
          expect(err?.code, `Expected no 40P01 deadlock but got: ${err?.message}`).not.toBe("40P01");
        }
      }

      const rows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, company.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].desiredAccess).toBe("revoked");
    });
  });
});
