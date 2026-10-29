CREATE TABLE "upstream_sync_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"log_id" bigint NOT NULL,
	"upstream_sha" text NOT NULL,
	"operation" text NOT NULL,
	"changed_columns" text[] NOT NULL,
	"old_values" jsonb,
	"new_values" jsonb,
	"old_status" text,
	"new_status" text,
	"actor" text NOT NULL,
	"run_ref" text,
	"application_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upstream_sync_events_operation_check" CHECK ("upstream_sync_events"."operation" in ('insert', 'update', 'delete'))
);
--> statement-breakpoint
CREATE INDEX "upstream_sync_events_sha_idx" ON "upstream_sync_events" USING btree ("upstream_sha","id");--> statement-breakpoint
CREATE INDEX "upstream_sync_events_status_idx" ON "upstream_sync_events" USING btree ("new_status","id");--> statement-breakpoint
CREATE INDEX "upstream_sync_events_created_idx" ON "upstream_sync_events" USING btree ("created_at");
--> statement-breakpoint
-- HAND-WRITTEN, NOT drizzle-generated (TECH-7978 follow-up). Drizzle does not
-- model functions or triggers, so none of what follows has a snapshot entry.
--
-- Audit trigger for upstream_sync_log. SECURITY DEFINER so the restricted
-- upstream_sync_runner login only needs SELECT on upstream_sync_events: it can
-- cause events (by changing the log) but cannot forge, edit or delete them.
-- search_path is pinned to pg_catalog + pg_temp (no user schema can shadow a
-- built-in) and the events table is addressed through the TRIGGERING table's
-- schema, so this works in `public` and in the scratch schemas the tool tests
-- apply the migration into. Inside a SECURITY DEFINER function current_user is
-- the function owner, so the actor is session_user (the connected login).
CREATE OR REPLACE FUNCTION "upstream_sync_log_audit"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_cols text[];
  v_op text := lower(TG_OP);
  v_run text := nullif(current_setting('upstream_sync.run_ref', true), '');
  v_app text := nullif(current_setting('application_name', true), '');
  v_row record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_row := NEW;
    v_new := to_jsonb(NEW);
    v_cols := ARRAY(SELECT jsonb_object_keys(v_new) ORDER BY 1);
  ELSIF TG_OP = 'DELETE' THEN
    v_row := OLD;
    v_old := to_jsonb(OLD);
    v_cols := ARRAY(SELECT jsonb_object_keys(v_old) ORDER BY 1);
  ELSE
    v_row := NEW;
    SELECT array_agg(n.key ORDER BY n.key),
           jsonb_object_agg(n.key, o.value),
           jsonb_object_agg(n.key, n.value)
      INTO v_cols, v_old, v_new
      FROM jsonb_each(to_jsonb(NEW)) n
      JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value
       AND n.key <> 'updated_at';
    -- A no-op UPDATE, or one that only bumped updated_at, is not an event.
    IF v_cols IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  EXECUTE format(
    'INSERT INTO %I.upstream_sync_events '
    '(log_id, upstream_sha, operation, changed_columns, old_values, new_values, '
    ' old_status, new_status, actor, run_ref, application_name) '
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    TG_TABLE_SCHEMA
  ) USING
    v_row.id,
    v_row.upstream_sha,
    v_op,
    v_cols,
    v_old,
    v_new,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) ->> 'status' END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) ->> 'status' END,
    session_user::text,
    v_run,
    v_app;

  RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "upstream_sync_events_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'upstream_sync_events is append-only (% is not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
-- Baseline: one synthetic insert event per row that already exists, so history
-- starts from a known state. Done BEFORE the audit trigger exists (it would
-- otherwise double-log) and before the immutability trigger.
INSERT INTO "upstream_sync_events"
  ("log_id", "upstream_sha", "operation", "changed_columns", "old_values", "new_values",
   "old_status", "new_status", "actor", "run_ref", "application_name")
SELECT l."id", l."upstream_sha", 'insert',
       ARRAY(SELECT jsonb_object_keys(to_jsonb(l)) ORDER BY 1),
       NULL, to_jsonb(l), NULL, l."status",
       'migration:0381_baseline', NULL, NULL
  FROM "upstream_sync_log" l
 ORDER BY l."id";
--> statement-breakpoint
CREATE TRIGGER "upstream_sync_log_audit_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "upstream_sync_log"
  FOR EACH ROW EXECUTE FUNCTION "upstream_sync_log_audit"();
--> statement-breakpoint
CREATE TRIGGER "upstream_sync_events_immutable_trg"
  BEFORE UPDATE OR DELETE ON "upstream_sync_events"
  FOR EACH ROW EXECUTE FUNCTION "upstream_sync_events_immutable"();
--> statement-breakpoint
CREATE TRIGGER "upstream_sync_events_no_truncate_trg"
  BEFORE TRUNCATE ON "upstream_sync_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "upstream_sync_events_immutable"();
