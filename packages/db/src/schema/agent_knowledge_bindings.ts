import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentKnowledgeBindings = pgTable(
  "agent_knowledge_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    agentIdSnapshot: uuid("agent_id_snapshot").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    desiredAccess: text("desired_access").notNull().default("active"),
    state: text("state").notNull().default("pending"),
    principalId: text("principal_id"),
    brainId: text("brain_id"),
    fenceEpoch: integer("fence_epoch").notNull().default(1),
    lastErrorCode: text("last_error_code"),
    createdByActorType: text("created_by_actor_type").notNull().default("system"),
    createdByActorId: text("created_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentSnapshotUq: uniqueIndex("agent_knowledge_bindings_company_agent_snapshot_uq").on(
      table.companyId,
      table.agentIdSnapshot,
    ),
    companyIdIdUq: unique("agent_knowledge_bindings_company_id_id_uq").on(
      table.companyId,
      table.id,
    ),
    idempotencyKeyUq: uniqueIndex("agent_knowledge_bindings_idempotency_key_uq").on(table.idempotencyKey),
    companyIdIdx: index("agent_knowledge_bindings_company_id_idx").on(table.companyId),
    agentIdIdx: index("agent_knowledge_bindings_agent_id_idx").on(table.agentId),
    stateIdx: index("agent_knowledge_bindings_state_idx").on(table.state),
    agentIdSnapshotCheck: check(
      "agent_knowledge_bindings_agent_id_snapshot_check",
      sql`${table.agentId} IS NULL OR ${table.agentId} = ${table.agentIdSnapshot}`,
    ),
    desiredAccessCheck: check(
      "agent_knowledge_bindings_desired_access_check",
      sql`${table.desiredAccess} in ('active', 'suspended', 'revoked')`,
    ),
    stateCheck: check(
      "agent_knowledge_bindings_state_check",
      sql`${table.state} in ('pending', 'suspended', 'revoking', 'revoked', 'failed')`,
    ),
    fenceEpochCheck: check(
      "agent_knowledge_bindings_fence_epoch_check",
      sql`${table.fenceEpoch} >= 0`,
    ),
    lastErrorCodeCheck: check(
      "agent_knowledge_bindings_last_error_code_check",
      sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} ~ '^[a-z0-9_]{1,64}$'`,
    ),
  }),
);
