import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Append-only ledger of agent ownership/role grants (TECH-4929).
 *
 * This is deliberately NOT layered onto `principal_permission_grants`:
 * that table enforces one row per (companyId, principalType, principalId,
 * permissionKey) and treats `scope` as a filter narrowing a single
 * capability, not as a per-resource identity. Agent roles need many
 * concurrent rows per principal (one per agent they hold a role on), an
 * append-only transition history per (agent, principal) pair, and a
 * queryable "exactly one active owner per agent" invariant -- none of
 * which fit the existing grants table without weakening guarantees it
 * already provides to `tasks:assign_scope` and friends. See the PR
 * description for the full justification.
 *
 * Rows are never deleted or mutated after the fact:
 *  - granting a role inserts a new row.
 *  - revoking sets `revokedAt` (+ `revokedByUserId` / `revokedReason`) on
 *    the existing row; it never deletes it.
 *  - changing a principal's role revokes the old row and inserts a new
 *    one, linked via `transitionFromGrantId`, so the sequence of role
 *    changes is reconstructable.
 *
 * Enforcement (checking these rows in `decide()`) ships in a later stage.
 * Stage 1 only writes: unconditionally on every agent-creation path (the
 * `owner` role), and — not yet reachable from any route in this stage —
 * the plumbing for admin/user grants used once enforcement lands.
 *
 * KNOWN GAP, tracked by TECH-4930 (stage-2 enforcement): this migration
 * does NOT backfill grants for agents created before it shipped. There is
 * no reliable canonical owner to pick for those agents (no owner concept
 * existed before this table), so choosing one silently here would be
 * worse than leaving the gap explicit. Every pre-existing agent will have
 * zero rows here until TECH-4930 either backfills them or enforcement is
 * taught to tolerate an ownerless agent. Do not assume "zero grants" means
 * "broken data" until that ticket resolves it.
 */
export const agentOwnershipGrants = pgTable(
  "agent_ownership_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Deliberately CASCADE, not RESTRICT/NO ACTION: `agentService.remove()`
    // (server/src/services/agents.ts) performs a real, live-traffic hard
    // DELETE of `agents` rows (DELETE /agents/:id), and every agent has an
    // owner grant from creation onward, so RESTRICT would make agent
    // deletion fail unconditionally the moment this table is populated.
    // The existing `activity_log` precedent for the same agent-delete path
    // already accepts losing agent-scoped audit rows when the agent itself
    // is hard-deleted (agentService.remove() explicitly deletes that
    // agent's activity_log rows first, because activity_log.agent_id has no
    // cascade and would otherwise block the delete). We follow the same
    // trade-off here rather than invent a new one: once an agent is gone,
    // its ownership history has no surviving subject to audit, and the
    // "never deleted or mutated" contract above is scoped to *existing*
    // agents. Same reasoning applies to `agent_ownership_transfers.agent_id`.
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),

    // Principal holding the role. Modeled after principal_permission_grants
    // (principalType/principalId) so it composes with the same actor
    // vocabulary, though stage 1 only ever writes principalType "user" --
    // agent-invokable grants are explicitly out of scope.
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),

    role: text("role").notNull(), // "owner" | "admin" | "user"

    grantedByUserId: text("granted_by_user_id"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    revokedReason: text("revoked_reason"),

    // Set when this grant supersedes a prior role grant for the same
    // principal on the same agent (a "role change" transition), rather
    // than being a brand-new grant. SET NULL (not CASCADE/RESTRICT): the
    // referenced grant only ever belongs to the same agent as this row, so
    // in practice it is only ever removed together with this row (via the
    // agentId cascade above) -- but if a future direct deletion of a single
    // stale grant row ever happens, we want to keep this row and drop the
    // now-dangling pointer rather than silently deleting newer history
    // (CASCADE) or blocking the delete outright (RESTRICT).
    transitionFromGrantId: uuid("transition_from_grant_id").references((): AnyPgColumn => agentOwnershipGrants.id, {
      onDelete: "set null",
    }),

    // Instance-admin break-glass overrides must always be distinguishable
    // from ordinary owner/admin actions in the audit trail.
    isInstanceAdminOverride: boolean("is_instance_admin_override").notNull().default(false),

    // How this row came to exist. Must match exactly what
    // server/src/services/agent-ownership.ts and server/src/services/agents.ts
    // actually write: "agent_create" | "agent_created_default" |
    // "agent_hire" (agent-creation paths, see CreateAgentOptions.ownershipSource)
    // | "manual_grant" (setRole) | "transfer_accept" (acceptTransfer) |
    // "instance_admin_override" (forceTransferByInstanceAdmin).
    source: text("source").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Exactly one *active* owner per agent. Partial unique index: only
    // rows with role = 'owner' and revokedAt IS NULL participate, so the
    // history of past owners (revoked) never collides with the current one.
    oneActiveOwnerPerAgentIdx: uniqueIndex("agent_ownership_grants_one_active_owner_idx")
      .on(table.agentId)
      .where(sql`${table.role} = 'owner' and ${table.revokedAt} is null`),
    // A given principal can only hold one *active* non-owner role per
    // agent at a time (they can hold admin OR user, not both, and not two
    // rows of the same role).
    activeRolePerPrincipalIdx: uniqueIndex("agent_ownership_grants_active_role_idx")
      .on(table.agentId, table.principalType, table.principalId, table.role)
      .where(sql`${table.revokedAt} is null`),
    agentIdx: index("agent_ownership_grants_agent_idx").on(table.agentId),
    companyIdx: index("agent_ownership_grants_company_idx").on(table.companyId),
    principalIdx: index("agent_ownership_grants_principal_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
    principalTypeCheck: check(
      "agent_ownership_grants_principal_type_check",
      sql`${table.principalType} in ('user', 'agent')`,
    ),
    roleCheck: check("agent_ownership_grants_role_check", sql`${table.role} in ('owner', 'admin', 'user')`),
    sourceCheck: check(
      "agent_ownership_grants_source_check",
      sql`${table.source} in (
        'agent_create',
        'agent_created_default',
        'agent_hire',
        'manual_grant',
        'transfer_accept',
        'instance_admin_override'
      )`,
    ),
  }),
);
