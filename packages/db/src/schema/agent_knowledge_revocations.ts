import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { agentKnowledgeBindings } from "./agent_knowledge_bindings.js";

export const agentKnowledgeRevocations = pgTable(
  "agent_knowledge_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => agentKnowledgeBindings.id, { onDelete: "restrict" }),
    companyId: uuid("company_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    agentIdSnapshot: uuid("agent_id_snapshot").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    reason: text("reason").notNull(),
    principalIdSnapshot: text("principal_id_snapshot"),
    brainIdSnapshot: text("brain_id_snapshot"),
    fenceEpoch: integer("fence_epoch").notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    stalledAt: timestamp("stalled_at", { withTimezone: true }),
  },
  (table) => ({
    bindingIdUq: uniqueIndex("agent_knowledge_revocations_binding_id_uq").on(table.bindingId),
    companyBindingFk: foreignKey({
      name: "agent_knowledge_revocations_company_id_binding_id_fk",
      columns: [table.companyId, table.bindingId],
      foreignColumns: [
        agentKnowledgeBindings.companyId,
        agentKnowledgeBindings.id,
      ],
    }).onDelete("restrict"),
    idempotencyKeyUq: uniqueIndex("agent_knowledge_revocations_idempotency_key_uq").on(table.idempotencyKey),
    companyIdIdx: index("agent_knowledge_revocations_company_id_idx").on(table.companyId),
    agentIdIdx: index("agent_knowledge_revocations_agent_id_idx").on(table.agentId),
    statusIdx: index("agent_knowledge_revocations_status_idx").on(table.status),
    agentIdSnapshotCheck: check(
      "agent_knowledge_revocations_agent_id_snapshot_check",
      sql`${table.agentId} IS NULL OR ${table.agentId} = ${table.agentIdSnapshot}`,
    ),
    statusCheck: check(
      "agent_knowledge_revocations_status_check",
      sql`${table.status} in ('pending', 'confirmed', 'stalled')`,
    ),
    reasonCheck: check(
      "agent_knowledge_revocations_reason_check",
      sql`${table.reason} in ('agent_terminated', 'agent_removed', 'company_removed', 'manual_revocation', 'policy_revoked')`,
    ),
    fenceEpochCheck: check(
      "agent_knowledge_revocations_fence_epoch_check",
      sql`${table.fenceEpoch} >= 0`,
    ),
    lastErrorCodeCheck: check(
      "agent_knowledge_revocations_last_error_code_check",
      sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} ~ '^[a-z0-9_]{1,64}$'`,
    ),
  }),
);
