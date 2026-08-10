-- Note: statement_timeout is intentionally NOT set here (unlike 0212/0213/0214). Migration 0214
-- already dropped the old unique constraint in its own committed transaction, so this index is the
-- only thing enforcing uniqueness on (company_id, name). A fixed statement_timeout could abort the
-- CREATE INDEX build on a large tool_connections table, permanently leaving the table with no index
-- on (company_id, name). Do not re-add statement_timeout here.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle runs migrations inside a transaction; CONCURRENTLY is not supported.
CREATE INDEX IF NOT EXISTS "tool_connections_company_name_idx" ON "tool_connections" USING btree ("company_id","name");
