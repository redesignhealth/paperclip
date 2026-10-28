-- TECH-7981 (RH-only): personally owned Slack app-configuration credentials.
--
-- Nullable state is intentional: a row exists between creation and the first
-- secret write and after `forget` clears the references. RLS isolation below is
-- the canonical tenant policy (same semantics as 0373).
CREATE TABLE IF NOT EXISTS "chat_slack_configuration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"access_secret_id" uuid,
	"refresh_secret_id" uuid,
	"access_expires_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"chain_generation" integer DEFAULT 0 NOT NULL,
	"rotation_started_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_slack_configuration_credentials_status_check" CHECK ("chat_slack_configuration_credentials"."status" in ('active', 'rotating', 'reauthorize', 'revoked'))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_slack_configuration_credentials_company_id_companies_id_fk'
      AND conrelid = '"chat_slack_configuration_credentials"'::regclass
  ) THEN
    ALTER TABLE "chat_slack_configuration_credentials" ADD CONSTRAINT "chat_slack_configuration_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_slack_configuration_credentials_company_id_idx" ON "chat_slack_configuration_credentials" USING btree ("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_slack_configuration_credentials_owner_idx" ON "chat_slack_configuration_credentials" USING btree ("company_id","user_id","workspace_id");--> statement-breakpoint
ALTER TABLE "chat_slack_configuration_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_slack_configuration_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_slack_configuration_credentials";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chat_slack_configuration_credentials" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
