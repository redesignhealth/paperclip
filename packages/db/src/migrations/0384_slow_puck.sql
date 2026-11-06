ALTER TABLE "company_memory_databases" ADD COLUMN "scope_migration_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN "scope_migration_mode" text;--> statement-breakpoint
ALTER TABLE "company_memory_databases" ADD COLUMN "scope_migration_agent_scope_observed_at" timestamp with time zone;