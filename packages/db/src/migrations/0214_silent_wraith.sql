SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DROP INDEX IF EXISTS "tool_connections_company_name_uq";
