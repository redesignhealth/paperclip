-- This ALTER TABLE ADD COLUMN targets an existing, potentially high-traffic
-- table and briefly acquires an ACCESS EXCLUSIVE lock. Postgres 11+ adds a
-- constant-default column as a metadata-only change, but the lock must still
-- wait for any open transaction on the table to finish. Fail fast under
-- contention instead of stalling the deploy indefinitely.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "sso" jsonb DEFAULT '{}'::jsonb NOT NULL;