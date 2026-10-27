ALTER TABLE "chat_endpoint_resources" ADD COLUMN IF NOT EXISTS "wake_on_root_messages" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_endpoint_resources" ADD COLUMN IF NOT EXISTS "follow_ups_require_mention" boolean DEFAULT false NOT NULL;
