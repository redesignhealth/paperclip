-- TECH-10684: the comms board wake setting is on by default for NEW companies. Only the column default changes.
-- Existing rows are deliberately NOT updated: existing companies are switched on by an operator through the API, so a
-- company that was switched off on purpose is never switched back on by a deploy.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "comms_board_wake_enabled" SET DEFAULT true;
