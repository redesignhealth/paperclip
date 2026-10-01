-- TECH-6969 Phase 2: Dedicated per-company PostgreSQL database and role for tenant-isolated mem0 memory.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE TABLE "company_memory_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"database_name" text NOT NULL,
	"database_role" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 5432 NOT NULL,
	"sslmode" text DEFAULT 'require' NOT NULL,
	"collection_name" text DEFAULT 'mem0_memories' NOT NULL,
	"embedding_model" text DEFAULT 'text-embedding-3-small' NOT NULL,
	"embedding_dimensions" integer DEFAULT 1536 NOT NULL,
	"secret_id" uuid,
	"secret_version" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_provisioned_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"last_error" text,
	"operation" text DEFAULT 'idle' NOT NULL,
	"lease_token" text,
	"lease_owner" text,
	"lease_acquired_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"backoff_until" timestamp with time zone,
	"credential_epoch" integer DEFAULT 1 NOT NULL,
	"pending_secret_id" uuid,
	"pending_secret_version" integer,
	"pending_scram_salt" text,
	"pending_scram_iterations" integer,
	"pending_scram_verifier" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_memory_databases_status_check" CHECK ("company_memory_databases"."status" in ('pending', 'ready', 'failed', 'deprovisioning', 'deprovisioned', 'archived')),
	CONSTRAINT "company_memory_databases_operation_check" CHECK ("company_memory_databases"."operation" in ('idle', 'provision', 'rotate', 'archive', 'unarchive', 'deprovision')),
	CONSTRAINT "company_memory_databases_sslmode_check" CHECK ("company_memory_databases"."sslmode" = 'require'),
	CONSTRAINT "company_memory_databases_port_check" CHECK ("company_memory_databases"."port" >= 1 and "company_memory_databases"."port" <= 65535)
);
--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD CONSTRAINT "company_memory_databases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD CONSTRAINT "company_memory_databases_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD CONSTRAINT "company_memory_databases_pending_secret_id_company_secrets_id_fk" FOREIGN KEY ("pending_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_memory_databases_company_id_uq" ON "company_memory_databases" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_memory_databases_database_name_uq" ON "company_memory_databases" USING btree ("database_name");--> statement-breakpoint
CREATE UNIQUE INDEX "company_memory_databases_database_role_uq" ON "company_memory_databases" USING btree ("database_role");--> statement-breakpoint
CREATE INDEX "company_memory_databases_status_idx" ON "company_memory_databases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "company_memory_databases_secret_id_idx" ON "company_memory_databases" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "company_memory_databases_operation_idx" ON "company_memory_databases" USING btree ("operation");--> statement-breakpoint
CREATE INDEX "company_memory_databases_lease_expires_idx" ON "company_memory_databases" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "company_memory_databases_backoff_until_idx" ON "company_memory_databases" USING btree ("backoff_until");--> statement-breakpoint
ALTER TABLE "company_memory_databases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_memory_databases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "company_memory_databases";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "company_memory_databases" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
