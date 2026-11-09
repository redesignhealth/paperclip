ALTER TABLE "company_memory_upgrades" ALTER COLUMN "llm_input_tokens" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "company_memory_upgrades" ALTER COLUMN "llm_output_tokens" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "company_memory_upgrades" ALTER COLUMN "embedding_tokens" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "company_memory_upgrades" ALTER COLUMN "estimated_cost_nanodollars" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "deletion_started_at" timestamp with time zone;