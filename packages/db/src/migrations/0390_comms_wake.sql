-- TECH-9906: comms board wake registrations, received-event log and conversation-to-issue links.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE TABLE "comms_wake_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"board_conversation_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms_wake_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"board_conversation_id" uuid NOT NULL,
	"seq" integer,
	"message_type" text,
	"sender_board_agent_id" uuid NOT NULL,
	"board_session_ref" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issue_id" uuid,
	"comment_id" uuid,
	"outcome" text,
	"session_ref" text,
	CONSTRAINT "comms_wake_events_kind_check" CHECK ("comms_wake_events"."kind" in ('message', 'invite')),
	CONSTRAINT "comms_wake_events_reason_check" CHECK ("comms_wake_events"."reason" in ('rule', 'open_conversation'))
);
--> statement-breakpoint
CREATE TABLE "comms_wake_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"board_agent_id" uuid NOT NULL,
	"signing_secret_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comms_wake_conversations" ADD CONSTRAINT "comms_wake_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_wake_conversations" ADD CONSTRAINT "comms_wake_conversations_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_wake_conversations" ADD CONSTRAINT "comms_wake_conversations_company_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_wake_events" ADD CONSTRAINT "comms_wake_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_wake_events" ADD CONSTRAINT "comms_wake_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_wake_events" ADD CONSTRAINT "comms_wake_events_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_wake_events" ADD CONSTRAINT "comms_wake_events_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_wake_registrations" ADD CONSTRAINT "comms_wake_registrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_wake_registrations" ADD CONSTRAINT "comms_wake_registrations_signing_secret_id_company_secrets_id_fk" FOREIGN KEY ("signing_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_wake_registrations" ADD CONSTRAINT "comms_wake_registrations_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comms_wake_conversations_agent_conversation_uq" ON "comms_wake_conversations" USING btree ("agent_id","board_conversation_id");--> statement-breakpoint
CREATE INDEX "comms_wake_conversations_issue_idx" ON "comms_wake_conversations" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "comms_wake_conversations_company_idx" ON "comms_wake_conversations" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comms_wake_events_agent_event_uq" ON "comms_wake_events" USING btree ("agent_id","event_id");--> statement-breakpoint
CREATE INDEX "comms_wake_events_company_received_idx" ON "comms_wake_events" USING btree ("company_id","received_at");--> statement-breakpoint
CREATE INDEX "comms_wake_events_agent_conversation_idx" ON "comms_wake_events" USING btree ("agent_id","board_conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comms_wake_registrations_agent_uq" ON "comms_wake_registrations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "comms_wake_registrations_company_idx" ON "comms_wake_registrations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "comms_wake_registrations_signing_secret_idx" ON "comms_wake_registrations" USING btree ("signing_secret_id");--> statement-breakpoint
ALTER TABLE "comms_wake_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comms_wake_conversations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "comms_wake_conversations";
CREATE POLICY "tenant_isolation" ON "comms_wake_conversations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "comms_wake_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comms_wake_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "comms_wake_events";
CREATE POLICY "tenant_isolation" ON "comms_wake_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "comms_wake_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comms_wake_registrations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "comms_wake_registrations";
CREATE POLICY "tenant_isolation" ON "comms_wake_registrations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
