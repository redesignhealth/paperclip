/**
 * Upstream-sync ledger (TECH-7978, upstream-sync plan rev 3 phase P0).
 *
 * These three tables are GLOBAL, not tenant-scoped: there is deliberately no
 * `company_id` column. The ledger records commits to the upstream
 * `paperclipai/paperclip` repository relative to this deployment, which is an
 * instance-level concern shared by every company on the instance. Because there
 * is no tenant scope column, `listRlsTargets()` in ./rls.ts will not pick them
 * up, and they are intentionally not RLS targets -- there is no company whose
 * rows could leak to another company.
 *
 * Schema ownership: this file, plus migration
 * `0380_upstream_sync_ledger.sql`, is the only authority for the production
 * shape. `tools/upstream-sync/schema.sql` is now only the test fixture for
 * `tools/upstream-sync/__tests__/db.test.mjs`, and
 * `tools/upstream-sync/cli.mjs migrate` no longer writes DDL -- it verifies
 * that these tables exist and points the operator at `packages/db`
 * migrations. `tools/upstream-sync/__tests__/schema-parity.test.mjs` asserts
 * the fixture and the migration agree.
 *
 * The `upstream_sync_log_view` read model is created by hand in the same
 * migration: Drizzle does not model views, so it has no snapshot entry.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/** The queue: one row per upstream commit the detector has seen. */
export const upstreamSyncLog = pgTable(
  "upstream_sync_log",
  {
    // Assigned in upstream commit order, so `id` ordering is the sync queue.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    upstreamSha: text("upstream_sha").notNull(),
    upstreamPr: integer("upstream_pr"),
    title: text("title").notNull(),
    // Commit message body; this is the classifier's input.
    body: text("body"),
    author: text("author"),
    files: text("files").array().notNull().default(sql`'{}'::text[]`),
    upstreamMergedAt: timestamp("upstream_merged_at", { withTimezone: true }),
    category: text("category").$type<UpstreamSyncCategory>(),
    summary: text("summary"),
    classifiedBy: text("classified_by"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    // Files matching FORK_OWNED.md at insert time.
    forkOwnedHits: text("fork_owned_hits").array().notNull().default(sql`'{}'::text[]`),
    // Drizzle migrations / schema touched by the commit.
    touchesMigrations: boolean("touches_migrations").notNull().default(false),
    forkPr: text("fork_pr"),
    path: text("path").$type<"clean" | "conflict">(),
    argusVerdict: text("argus_verdict"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    prodPinnedAt: timestamp("prod_pinned_at", { withTimezone: true }),
    status: text("status").$type<UpstreamSyncStatus>().notNull().default("pending"),
    skipReason: text("skip_reason"),
    // Worker claim/lease (RED-583). `claimedBy` is the Paperclip run id of the
    // worker that holds (or last held) the row; `leaseExpiresAt` is non-null
    // exactly while status = 'claimed'; `attempt` counts claims.
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(0),
    // Merge-into-`integration` result: the merge commit and the sha256 of its
    // resolution delta (null for an empty delta, i.e. a clean merge).
    integrationSha: text("integration_sha"),
    resolutionDeltaSha256: text("resolution_delta_sha256"),
    // Argus review PR for a conflict resolution, and the human-merged
    // `integration` -> `master` promotion PR plus the resulting master sha.
    reviewPr: integer("review_pr"),
    promotePr: integer("promote_pr"),
    masterSha: text("master_sha"),
    // Append-only array of `{ round, sha, verdict, ... }` objects.
    argusRounds: jsonb("argus_rounds").$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
    // Upstream revert linked back to the original commit it reverts.
    revertsSha: text("reverts_sha"),
    alertState: text("alert_state").$type<"sent" | "suppressed">(),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Names match PostgreSQL's implicit names for the fixture's column-level
    // UNIQUE / CHECK clauses, so schema.sql and this migration stay diffable.
    unique("upstream_sync_log_upstream_sha_key").on(table.upstreamSha),
    // Queue scan: pending rows in upstream order.
    index("upstream_sync_log_status_idx").on(table.status, table.id),
    index("upstream_sync_log_category_idx").on(table.category),
    check(
      "upstream_sync_log_category_check",
      sql`${table.category} in ('feature', 'fix', 'perf', 'security', 'infra', 'breaking')`,
    ),
    check("upstream_sync_log_path_check", sql`${table.path} in ('clean', 'conflict')`),
    check(
      "upstream_sync_log_status_check",
      sql`${table.status} in ('pending', 'claimed', 'assessed', 'skipped', 'in_review', 'integrated', 'promoted', 'needs_human', 'failed')`,
    ),
    check("upstream_sync_log_attempt_check", sql`${table.attempt} >= 0`),
    // A lease exists exactly while the row is claimed.
    check(
      "upstream_sync_log_claim_check",
      sql`(${table.status} = 'claimed' and ${table.claimedBy} is not null and ${table.claimedAt} is not null and ${table.leaseExpiresAt} is not null) or (${table.status} <> 'claimed' and ${table.leaseExpiresAt} is null)`,
    ),
    check("upstream_sync_log_integration_sha_check", sql`${table.integrationSha} ~ '^[0-9a-f]{40}$'`),
    check("upstream_sync_log_master_sha_check", sql`${table.masterSha} ~ '^[0-9a-f]{40}$'`),
    check("upstream_sync_log_delta_sha256_check", sql`${table.resolutionDeltaSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "upstream_sync_log_pr_numbers_check",
      sql`(${table.reviewPr} is null or ${table.reviewPr} > 0) and (${table.promotePr} is null or ${table.promotePr} > 0)`,
    ),
    check("upstream_sync_log_argus_rounds_check", sql`jsonb_typeof(${table.argusRounds}) = 'array'`),
    // Evidence a row must carry in each state. The guard trigger (hand-written
    // in migration 0382) enforces the transition graph and the Argus binding.
    check(
      "upstream_sync_log_state_path_check",
      sql`${table.status} not in ('assessed', 'in_review', 'integrated', 'promoted') or ${table.path} is not null`,
    ),
    // A conflict resolution always has a non-empty delta, a clean merge never does.
    check(
      "upstream_sync_log_state_integrated_check",
      sql`${table.status} not in ('integrated', 'promoted') or (${table.integrationSha} is not null and (${table.path} = 'conflict') = (${table.resolutionDeltaSha256} is not null))`,
    ),
    check(
      "upstream_sync_log_state_promoted_check",
      sql`${table.status} <> 'promoted' or (${table.promotePr} is not null and ${table.masterSha} is not null)`,
    ),
    check(
      "upstream_sync_log_state_review_check",
      sql`${table.status} <> 'in_review' or ${table.reviewPr} is not null`,
    ),
    check(
      "upstream_sync_log_state_skipped_check",
      sql`${table.status} <> 'skipped' or ${table.skipReason} is not null`,
    ),
    check(
      "upstream_sync_log_alert_state_check",
      sql`${table.alertState} in ('sent', 'suppressed')`,
    ),
  ],
);

/**
 * Small key/value state: `upstream_synced_marker`, `detector_paused`, and the
 * ops-alert episode flags.
 */
export const upstreamSyncState = pgTable("upstream_sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Alert outbox. One row per alert; the unique `dedup_key` is what makes
 * ENQUEUE exactly-once. Delivery is at-least-once: each row is sent then marked
 * delivered, so a crash between the two resends it on the next flush. Keys are
 * `row:<sha>`, `ops:<name>:<episode>` or `overflow:<run>`.
 */
export const upstreamSyncAlerts = pgTable("upstream_sync_alerts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  // 'row:<sha>' | 'ops:<name>:<episode>' | 'overflow:<run>'
  dedupKey: text("dedup_key").notNull(),
  kind: text("kind").notNull(),
  upstreamSha: text("upstream_sha"),
  channel: text("channel").notNull(),
  sink: text("sink").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  deliveryRef: text("delivery_ref"),
  lastError: text("last_error"),
}, (table) => [
  // Exactly-once ENQUEUE anchor; name matches the fixture's implicit
  // PostgreSQL column-level UNIQUE constraint name.
  unique("upstream_sync_alerts_dedup_key_key").on(table.dedupKey),
]);

/**
 * Append-only audit trail for `upstream_sync_log` (TECH-7978 follow-up).
 *
 * Rows are written ONLY by the `upstream_sync_log_audit()` trigger, which is
 * SECURITY DEFINER, so the restricted `upstream_sync_runner` login needs (and
 * gets) SELECT only: it cannot forge, edit or delete events. `old_values` /
 * `new_values` hold only the changed columns for an UPDATE and the full row for
 * an INSERT / DELETE. `actor` is `session_user` (the login that connected),
 * because `current_user` inside a SECURITY DEFINER function is the owner.
 * `run_ref` comes from the `upstream_sync.run_ref` setting the worker sets per
 * run (for example the Paperclip run issue identifier). The trigger functions
 * and triggers are hand-written in the migration; Drizzle does not model them.
 */
export const upstreamSyncEvents = pgTable(
  "upstream_sync_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    logId: bigint("log_id", { mode: "number" }).notNull(),
    upstreamSha: text("upstream_sha").notNull(),
    operation: text("operation").$type<"insert" | "update" | "delete">().notNull(),
    changedColumns: text("changed_columns").array().notNull(),
    oldValues: jsonb("old_values").$type<Record<string, unknown>>(),
    newValues: jsonb("new_values").$type<Record<string, unknown>>(),
    oldStatus: text("old_status"),
    newStatus: text("new_status"),
    actor: text("actor").notNull(),
    runRef: text("run_ref"),
    applicationName: text("application_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("upstream_sync_events_sha_idx").on(table.upstreamSha, table.id),
    index("upstream_sync_events_status_idx").on(table.newStatus, table.id),
    index("upstream_sync_events_created_idx").on(table.createdAt),
    check(
      "upstream_sync_events_operation_check",
      sql`${table.operation} in ('insert', 'update', 'delete')`,
    ),
  ],
);

export type UpstreamSyncCategory = "feature" | "fix" | "perf" | "security" | "infra" | "breaking";

export type UpstreamSyncStatus =
  | "pending"
  | "claimed"
  | "assessed"
  | "skipped"
  | "in_review"
  | "integrated" // merged into `integration`
  | "promoted" // in `master`
  | "needs_human"
  | "failed";
