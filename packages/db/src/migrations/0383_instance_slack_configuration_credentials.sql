-- RH-only: an instance-wide Slack app-configuration credential that an instance
-- administrator saves once and every company's Slack setup uses.
--
-- Not tenant-scoped on purpose: the table has no company_id, so no tenant policy
-- applies (same as instance_settings). The token pair is stored encrypted with the
-- instance master key; the table never holds a plaintext token.
CREATE TABLE IF NOT EXISTS "instance_slack_configuration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"saved_by_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"access_material" jsonb,
	"refresh_material" jsonb,
	"access_expires_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"chain_generation" integer DEFAULT 0 NOT NULL,
	"rotation_started_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_slack_configuration_credentials_status_check" CHECK ("instance_slack_configuration_credentials"."status" in ('active', 'rotating', 'reauthorize', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "instance_slack_configuration_credentials_workspace_idx" ON "instance_slack_configuration_credentials" USING btree ("workspace_id");
