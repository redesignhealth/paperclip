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
      sql`${table.status} in ('pending', 'in_progress', 'merged', 'skipped', 'conflict', 'needs-human', 'reverted')`,
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

export type UpstreamSyncCategory = "feature" | "fix" | "perf" | "security" | "infra" | "breaking";

export type UpstreamSyncStatus =
  | "pending"
  | "in_progress"
  | "merged"
  | "skipped"
  | "conflict"
  | "needs-human"
  | "reverted";
