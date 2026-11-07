CREATE TABLE "company_memory_upgrades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"state" text DEFAULT 'sweeping' NOT NULL,
	"recover_to_state" text,
	"converter_id" text NOT NULL,
	"converter_version" integer NOT NULL,
	"collection_name" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimensions" integer NOT NULL,
	"sweep_count" integer DEFAULT 0 NOT NULL,
	"source_seen_count" integer DEFAULT 0 NOT NULL,
	"published_count" integer DEFAULT 0 NOT NULL,
	"dropped_noise_count" integer DEFAULT 0 NOT NULL,
	"dropped_sensitive_count" integer DEFAULT 0 NOT NULL,
	"deduplicated_count" integer DEFAULT 0 NOT NULL,
	"unroutable_count" integer DEFAULT 0 NOT NULL,
	"quarantined_count" integer DEFAULT 0 NOT NULL,
	"superseded_count" integer DEFAULT 0 NOT NULL,
	"source_deleted_count" integer DEFAULT 0 NOT NULL,
	"llm_input_tokens" bigint DEFAULT 0 NOT NULL,
	"llm_output_tokens" bigint DEFAULT 0 NOT NULL,
	"embedding_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_cost_nanodollars" bigint DEFAULT 0 NOT NULL,
	"marked_at" timestamp with time zone,
	"drain_confirmed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"pruned_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"operator_label" text,
	"lease_token" text,
	"lease_owner" text,
	"lease_acquired_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_memory_upgrades_state_check" CHECK ("company_memory_upgrades"."state" in ('sweeping', 'flipping', 'draining', 'verified', 'pruning', 'completed', 'rolled_back', 'aborted', 'needs_recovery')),
	CONSTRAINT "company_memory_upgrades_recover_to_state_check" CHECK ("company_memory_upgrades"."recover_to_state" is null or "company_memory_upgrades"."recover_to_state" in ('sweeping', 'flipping', 'draining', 'verified', 'pruning'))
);
--> statement-breakpoint
ALTER TABLE "company_memory_upgrades" ADD CONSTRAINT "company_memory_upgrades_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_memory_upgrades_active_uq" ON "company_memory_upgrades" USING btree ("company_id") WHERE "company_memory_upgrades"."state" not in ('completed', 'aborted', 'rolled_back');--> statement-breakpoint
CREATE INDEX "company_memory_upgrades_company_idx" ON "company_memory_upgrades" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "company_memory_upgrades_lease_idx" ON "company_memory_upgrades" USING btree ("lease_expires_at") WHERE "company_memory_upgrades"."state" not in ('completed', 'aborted', 'rolled_back');--> statement-breakpoint
ALTER TABLE "company_memory_upgrades" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_memory_upgrades" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "company_memory_upgrades";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "company_memory_upgrades" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
