-- TECH-6969 Phase 2: Durable cross-process fenced lease and pending rotation state machine for company memory databases.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "operation" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "lease_token" text;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "lease_owner" text;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "lease_acquired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "backoff_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "credential_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "pending_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "pending_secret_version" integer;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "pending_scram_salt" text;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "pending_scram_iterations" integer;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN IF NOT EXISTS "pending_scram_verifier" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_memory_databases" ADD CONSTRAINT "company_memory_databases_pending_secret_id_company_secrets_id_fk" FOREIGN KEY ("pending_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_memory_databases" ADD CONSTRAINT "company_memory_databases_operation_check" CHECK ("company_memory_databases"."operation" in ('idle', 'provision', 'rotate', 'archive', 'unarchive', 'deprovision'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_memory_databases_operation_idx" ON "company_memory_databases" ("operation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_memory_databases_lease_expires_idx" ON "company_memory_databases" ("lease_expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_memory_databases_backoff_until_idx" ON "company_memory_databases" ("backoff_until");
