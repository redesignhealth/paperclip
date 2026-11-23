-- TECH-9912: per-company switch for comms board wake subscriptions of new agents. Off for every existing company.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "comms_board_wake_enabled" boolean DEFAULT false NOT NULL;
