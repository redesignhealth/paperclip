SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle runs migrations inside a transaction; CONCURRENTLY is not supported.
CREATE INDEX IF NOT EXISTS "tool_connections_company_name_idx" ON "tool_connections" USING btree ("company_id","name");
