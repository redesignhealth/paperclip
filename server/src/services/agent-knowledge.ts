import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentKnowledgeBindings, agentKnowledgeRevocations } from "@paperclipai/db";
import { isAgentKnowledgeEnabledForCompany } from "./agent-knowledge-config.js";

export type KnowledgeRevocationReason =
  | "agent_terminated"
  | "agent_removed"
  | "company_removed"
  | "manual_revocation"
  | "policy_revoked";

export interface KnowledgeActorAudit {
  actorType: string;
  actorId?: string | null;
}

export function deterministicBindingIdempotencyKey(companyId: string, agentId: string): string {
  return `agent-knowledge-binding:${companyId}:${agentId}`;
}

export function deterministicRevocationIdempotencyKey(
  companyId: string,
  agentId: string,
  fenceEpoch: number,
): string {
  return `agent-knowledge-revocation:${companyId}:${agentId}:${fenceEpoch}`;
}

async function execUpdateReturning<T>(query: any): Promise<T[]> {
  if (typeof query?.returning === "function") {
    return query.returning();
  }
  const res = await query;
  return Array.isArray(res) ? res : [];
}

export function agentKnowledgeService(db: Db) {
  return {
    getBindingForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, companyId),
            eq(agentKnowledgeBindings.agentIdSnapshot, agentId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    listRevocationsForBinding: async (bindingId: string) => {
      return db
        .select()
        .from(agentKnowledgeRevocations)
        .where(eq(agentKnowledgeRevocations.bindingId, bindingId));
    },

    createPendingBinding: async (input: {
      companyId: string;
      agentId: string;
      actor?: KnowledgeActorAudit | null;
    }) => {
      const idempotencyKey = deterministicBindingIdempotencyKey(input.companyId, input.agentId);
      const existing = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, input.companyId),
            eq(agentKnowledgeBindings.agentIdSnapshot, input.agentId),
          ),
        )
        .limit(1);

      if (existing[0]) {
        return existing[0];
      }

      try {
        const [inserted] = await db
          .insert(agentKnowledgeBindings)
          .values({
            companyId: input.companyId,
            agentId: input.agentId,
            agentIdSnapshot: input.agentId,
            idempotencyKey,
            desiredAccess: "active",
            state: "pending",
            fenceEpoch: 1,
            createdByActorType: input.actor?.actorType ?? "system",
            createdByActorId: input.actor?.actorId ?? null,
          })
          .onConflictDoNothing()
          .returning();

        if (inserted) return inserted;
      } catch (err: any) {
        if (err?.code === "23505" || err?.cause?.code === "23505") {
          // Unique constraint race condition handled by fallback query below
        } else {
          throw err;
        }
      }

      const fallback = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, input.companyId),
            eq(agentKnowledgeBindings.agentIdSnapshot, input.agentId),
          ),
        )
        .limit(1);
      return fallback[0]!;
    },

    suspendAgentBinding: async (input: { companyId: string; agentId: string }) => {
      const q = db
        .update(agentKnowledgeBindings)
        .set({
          desiredAccess: "suspended",
          state: "suspended",
          fenceEpoch: sql`${agentKnowledgeBindings.fenceEpoch} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, input.companyId),
            eq(agentKnowledgeBindings.agentIdSnapshot, input.agentId),
            sql`${agentKnowledgeBindings.desiredAccess} != 'revoked'`,
          ),
        );
      const rows = await execUpdateReturning<typeof agentKnowledgeBindings.$inferSelect>(q);
      return rows[0] ?? null;
    },

    suspendAllCompanyBindings: async (input: { companyId: string }) => {
      const q = db
        .update(agentKnowledgeBindings)
        .set({
          desiredAccess: "suspended",
          state: "suspended",
          fenceEpoch: sql`${agentKnowledgeBindings.fenceEpoch} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, input.companyId),
            sql`${agentKnowledgeBindings.desiredAccess} != 'revoked'`,
          ),
        );
      const rows = await execUpdateReturning<{ id: string }>(q);
      return rows.length;
    },

    resumeAgentBinding: async (input: { companyId: string; agentId: string }) => {
      // Desired access is requested as active, but state is NOT marked active
      // (stays pending / inert until future authority worker confirms live authority).
      const q = db
        .update(agentKnowledgeBindings)
        .set({
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: sql`${agentKnowledgeBindings.fenceEpoch} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, input.companyId),
            eq(agentKnowledgeBindings.agentIdSnapshot, input.agentId),
            sql`${agentKnowledgeBindings.desiredAccess} != 'revoked'`,
          ),
        );
      const rows = await execUpdateReturning<typeof agentKnowledgeBindings.$inferSelect>(q);
      return rows[0] ?? null;
    },

    resumeAgentBindingsForAgents: async (input: { companyId: string; agentIds: string[] }) => {
      if (input.agentIds.length === 0) return 0;
      const q = db
        .update(agentKnowledgeBindings)
        .set({
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: sql`${agentKnowledgeBindings.fenceEpoch} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, input.companyId),
            inArray(agentKnowledgeBindings.agentIdSnapshot, input.agentIds),
            eq(agentKnowledgeBindings.desiredAccess, "suspended"),
          ),
        );
      const rows = await execUpdateReturning<{ id: string }>(q);
      return rows.length;
    },

    resumeAllCompanyBindings: async (input: { companyId: string }) => {
      const q = db
        .update(agentKnowledgeBindings)
        .set({
          desiredAccess: "active",
          state: "pending",
          fenceEpoch: sql`${agentKnowledgeBindings.fenceEpoch} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, input.companyId),
            eq(agentKnowledgeBindings.desiredAccess, "suspended"),
          ),
        );
      const rows = await execUpdateReturning<{ id: string }>(q);
      return rows.length;
    },

    revokeAgentBinding: async (input: {
      companyId: string;
      agentId: string;
      reason: KnowledgeRevocationReason;
    }) => {
      // Atomic CAS / update of binding: increments fence if not already revoked
      const [updated] = await db
        .update(agentKnowledgeBindings)
        .set({
          desiredAccess: "revoked",
          state: "revoked",
          fenceEpoch: sql`CASE WHEN ${agentKnowledgeBindings.desiredAccess} = 'revoked' THEN ${agentKnowledgeBindings.fenceEpoch} ELSE ${agentKnowledgeBindings.fenceEpoch} + 1 END`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentKnowledgeBindings.companyId, input.companyId),
            eq(agentKnowledgeBindings.agentIdSnapshot, input.agentId),
          ),
        )
        .returning();

      const binding = updated ?? (
        await db
          .select()
          .from(agentKnowledgeBindings)
          .where(
            and(
              eq(agentKnowledgeBindings.companyId, input.companyId),
              eq(agentKnowledgeBindings.agentIdSnapshot, input.agentId),
            ),
          )
          .limit(1)
          .then((r) => r[0] ?? null)
      );

      if (!binding) return null;

      // Enqueue revocation outbox row idempotently
      const existingRevocation = await db
        .select()
        .from(agentKnowledgeRevocations)
        .where(eq(agentKnowledgeRevocations.bindingId, binding.id))
        .limit(1);

      if (existingRevocation[0]) {
        return existingRevocation[0];
      }

      const idempotencyKey = deterministicRevocationIdempotencyKey(
        binding.companyId,
        binding.agentIdSnapshot,
        binding.fenceEpoch,
      );

      try {
        const [revocation] = await db
          .insert(agentKnowledgeRevocations)
          .values({
            bindingId: binding.id,
            companyId: binding.companyId,
            agentId: binding.agentId,
            agentIdSnapshot: binding.agentIdSnapshot,
            idempotencyKey,
            status: "pending",
            reason: input.reason,
            principalIdSnapshot: binding.principalId,
            brainIdSnapshot: binding.brainId,
            fenceEpoch: binding.fenceEpoch,
          })
          .onConflictDoNothing()
          .returning();

        if (revocation) return revocation;
      } catch (err: any) {
        if (err?.code === "23505" || err?.cause?.code === "23505") {
          // Unique constraint race condition handled by fallback query below
        } else {
          throw err;
        }
      }

      const fallback = await db
        .select()
        .from(agentKnowledgeRevocations)
        .where(eq(agentKnowledgeRevocations.bindingId, binding.id))
        .limit(1);
      return fallback[0] ?? null;
    },

    revokeAllCompanyBindings: async (input: {
      companyId: string;
      reason: KnowledgeRevocationReason;
    }) => {
      const bindings = await db
        .select()
        .from(agentKnowledgeBindings)
        .where(eq(agentKnowledgeBindings.companyId, input.companyId))
        .orderBy(agentKnowledgeBindings.id);

      for (const binding of bindings) {
        await agentKnowledgeService(db).revokeAgentBinding({
          companyId: binding.companyId,
          agentId: binding.agentIdSnapshot,
          reason: input.reason,
        });
      }
    },
  };
}
