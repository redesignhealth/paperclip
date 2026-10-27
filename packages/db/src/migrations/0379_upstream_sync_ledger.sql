CREATE TABLE "upstream_sync_alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dedup_key" text NOT NULL,
	"kind" text NOT NULL,
	"upstream_sha" text,
	"channel" text NOT NULL,
	"sink" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_ref" text,
	"last_error" text,
	CONSTRAINT "upstream_sync_alerts_dedup_key_key" UNIQUE("dedup_key")
);
--> statement-breakpoint
CREATE TABLE "upstream_sync_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"upstream_sha" text NOT NULL,
	"upstream_pr" integer,
	"title" text NOT NULL,
	"body" text,
	"author" text,
	"files" text[] DEFAULT '{}'::text[] NOT NULL,
	"upstream_merged_at" timestamp with time zone,
	"category" text,
	"summary" text,
	"classified_by" text,
	"classified_at" timestamp with time zone,
	"fork_owned_hits" text[] DEFAULT '{}'::text[] NOT NULL,
	"touches_migrations" boolean DEFAULT false NOT NULL,
	"fork_pr" text,
	"path" text,
	"argus_verdict" text,
	"merged_at" timestamp with time zone,
	"prod_pinned_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"reverts_sha" text,
	"alert_state" text,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upstream_sync_log_upstream_sha_key" UNIQUE("upstream_sha"),
	CONSTRAINT "upstream_sync_log_category_check" CHECK ("upstream_sync_log"."category" in ('feature', 'fix', 'perf', 'security', 'infra', 'breaking')),
	CONSTRAINT "upstream_sync_log_path_check" CHECK ("upstream_sync_log"."path" in ('clean', 'conflict')),
	CONSTRAINT "upstream_sync_log_status_check" CHECK ("upstream_sync_log"."status" in ('pending', 'in_progress', 'merged', 'skipped', 'conflict', 'needs-human', 'reverted')),
	CONSTRAINT "upstream_sync_log_alert_state_check" CHECK ("upstream_sync_log"."alert_state" in ('sent', 'suppressed'))
);
--> statement-breakpoint
CREATE TABLE "upstream_sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "upstream_sync_log_status_idx" ON "upstream_sync_log" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "upstream_sync_log_category_idx" ON "upstream_sync_log" USING btree ("category");

--> statement-breakpoint
-- HAND-WRITTEN, NOT drizzle-generated (TECH-7978). Drizzle does not model
-- views, so `upstream_sync_log_view` has no entry in 0379_snapshot.json and
-- this statement is appended by hand after `drizzle-kit generate`. Keep it in
-- sync with tools/upstream-sync/schema.sql (asserted by
-- tools/upstream-sync/__tests__/schema-parity.test.mjs). Seed the ledger from
-- tools/upstream-sync; this view is the read surface for `cli.mjs view|report`.
CREATE OR REPLACE VIEW "upstream_sync_log_view" AS
SELECT
  id                                                           AS seq,
  left(upstream_sha, 9)                                        AS sha,
  upstream_pr                                                  AS pr,
  'https://github.com/paperclipai/paperclip/commit/' || upstream_sha AS url,
  status,
  category,
  summary,
  title,
  author,
  upstream_merged_at,
  (cardinality(fork_owned_hits) > 0)                           AS touches_fork_owned,
  touches_migrations,
  fork_pr, path, argus_verdict, merged_at, prod_pinned_at, skip_reason,
  CASE WHEN status = 'pending' THEN now() - created_at END     AS pending_age
FROM upstream_sync_log
ORDER BY id;
