-- TECH-10878: instance-level default environment for new agents. Null until an operator sets it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "new_agent_default_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_new_agent_default_environment_id_environments_id_fk" FOREIGN KEY ("new_agent_default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;
