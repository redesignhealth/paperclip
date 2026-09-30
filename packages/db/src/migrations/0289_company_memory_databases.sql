-- TECH-6969 Phase 2: Dedicated per-company PostgreSQL database and role for tenant-isolated mem0 memory.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_memory_databases" (
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_memory_databases_status_check" CHECK ("company_memory_databases"."status" in ('pending', 'ready', 'failed', 'deprovisioning', 'deprovisioned')),
	CONSTRAINT "company_memory_databases_sslmode_check" CHECK ("company_memory_databases"."sslmode" = 'require'),
	CONSTRAINT "company_memory_databases_port_check" CHECK ("company_memory_databases"."port" >= 1 and "company_memory_databases"."port" <= 65535)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_memory_databases" ADD CONSTRAINT "company_memory_databases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_memory_databases" ADD CONSTRAINT "company_memory_databases_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_memory_databases_company_id_uq" ON "company_memory_databases" ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_memory_databases_database_name_uq" ON "company_memory_databases" ("database_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_memory_databases_database_role_uq" ON "company_memory_databases" ("database_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_memory_databases_status_idx" ON "company_memory_databases" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_memory_databases_secret_id_idx" ON "company_memory_databases" ("secret_id");--> statement-breakpoint
ALTER TABLE "company_memory_databases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_memory_databases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "company_memory_databases";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "company_memory_databases" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
