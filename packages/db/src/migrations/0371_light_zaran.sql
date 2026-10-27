SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "sso" jsonb DEFAULT '{}'::jsonb NOT NULL;
