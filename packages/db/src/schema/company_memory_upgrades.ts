import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const UPGRADE_STATES = [
  "sweeping",
  "flipping",
  "draining",
  "verified",
  "pruning",
  "completed",
  "rolled_back",
  "aborted",
  "needs_recovery",
] as const;

export type UpgradeState = (typeof UPGRADE_STATES)[number];

export const TERMINAL_UPGRADE_STATES = [
  "completed",
  "rolled_back",
  "aborted",
] as const;

export type TerminalUpgradeState = (typeof TERMINAL_UPGRADE_STATES)[number];

export const companyMemoryUpgrades = pgTable(
  "company_memory_upgrades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    state: text("state").notNull().default("sweeping"),
    recoverToState: text("recover_to_state"),
    converterId: text("converter_id").notNull(),
    converterVersion: integer("converter_version").notNull(),
    collectionName: text("collection_name").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimensions: integer("embedding_dimensions").notNull(),

    // Integer counters (default 0, not null)
    sweepCount: integer("sweep_count").notNull().default(0),
    sourceSeenCount: integer("source_seen_count").notNull().default(0),
    publishedCount: integer("published_count").notNull().default(0),
    droppedNoiseCount: integer("dropped_noise_count").notNull().default(0),
    droppedSensitiveCount: integer("dropped_sensitive_count").notNull().default(0),
    deduplicatedCount: integer("deduplicated_count").notNull().default(0),
    unroutableCount: integer("unroutable_count").notNull().default(0),
    quarantinedCount: integer("quarantined_count").notNull().default(0),
    supersededCount: integer("superseded_count").notNull().default(0),
    sourceDeletedCount: integer("source_deleted_count").notNull().default(0),

    // Bigint counters (default 0n, not null)
    llmInputTokens: bigint("llm_input_tokens", { mode: "bigint" }).notNull().default(sql`0`),
    llmOutputTokens: bigint("llm_output_tokens", { mode: "bigint" }).notNull().default(sql`0`),
    embeddingTokens: bigint("embedding_tokens", { mode: "bigint" }).notNull().default(sql`0`),
    estimatedCostNanodollars: bigint("estimated_cost_nanodollars", { mode: "bigint" }).notNull().default(sql`0`),

    // Timestamps (nullable)
    markedAt: timestamp("marked_at", { withTimezone: true }),
    drainConfirmedAt: timestamp("drain_confirmed_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Timestamp recorded when pruning completes (recorded on transition to 'completed'). Null while in 'pruning' or if aborted/crashed. */
    prunedAt: timestamp("pruned_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    lastError: text("last_error"),
    operatorLabel: text("operator_label"),

    // Durable lease fencing
    leaseToken: text("lease_token"),
    leaseOwner: text("lease_owner"),
    leaseAcquiredAt: timestamp("lease_acquired_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeUq: uniqueIndex("company_memory_upgrades_active_uq")
      .on(table.companyId)
      .where(sql`${table.state} not in ('completed', 'aborted', 'rolled_back')`),
    companyIdx: index("company_memory_upgrades_company_idx").on(table.companyId, table.createdAt),
    leaseIdx: index("company_memory_upgrades_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} not in ('completed', 'aborted', 'rolled_back')`),
    stateCheck: check(
      "company_memory_upgrades_state_check",
      sql`${table.state} in ('sweeping', 'flipping', 'draining', 'verified', 'pruning', 'completed', 'rolled_back', 'aborted', 'needs_recovery')`,
    ),
    recoverToCheck: check(
      "company_memory_upgrades_recover_to_state_check",
      sql`${table.recoverToState} is null or ${table.recoverToState} in ('sweeping', 'flipping', 'draining', 'verified', 'pruning')`,
    ),
  }),
);
