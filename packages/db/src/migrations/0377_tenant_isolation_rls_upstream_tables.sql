-- TECH-6956 follow-on: tenant-isolation RLS for tenant-scoped tables that did
-- not exist in the fork's schema when 0372_tenant_isolation_rls.sql (the
-- fork's original 0288, kept byte-identical) was generated.
--
-- Those are the company-scoped tables upstream added between v2026.916.1 and
-- the 2026-10-21 sync-catchup, plus company_memory_databases (whose own
-- migration, 0373, already applies the same canonical policy; repeating it
-- here is a no-op). The list is RLS_TABLES_COVERED_BY_LATER_MIGRATION in
-- packages/db/src/rls.ts and the DDL below is
-- renderTenantIsolationMigration(listRlsLaterMigrationTargets()).
--
-- A database that already applied 0372 never re-runs it, so without this file
-- the boot check (listRlsTargets) reports every table below as uncovered and
-- fails closed in authenticated + public mode. Shipped migrations are never
-- edited: a future catch-up that adds tenant tables needs another follow-on.
--
-- Same semantics as 0372: every policy passes rows through when
-- app.current_company_id is unset and filters to that company when it is set.
-- All statements are idempotent, and each table's statements are kept in one
-- chunk so a table is never left with RLS enabled but no policy. Nothing in
-- this header may contain the literal statement separator used below.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "accounting_runtime_baselines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounting_runtime_baselines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "accounting_runtime_baselines";
CREATE POLICY "tenant_isolation" ON "accounting_runtime_baselines" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_commentary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_commentary" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_commentary";
CREATE POLICY "tenant_isolation" ON "agent_commentary" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_identity_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_identity_keys" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_identity_keys";
CREATE POLICY "tenant_isolation" ON "agent_identity_keys" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_instruction_heads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_instruction_heads" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_instruction_heads";
CREATE POLICY "tenant_isolation" ON "agent_instruction_heads" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_instruction_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_instruction_revisions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_instruction_revisions";
CREATE POLICY "tenant_isolation" ON "agent_instruction_revisions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_instruction_working_copies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_instruction_working_copies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_instruction_working_copies";
CREATE POLICY "tenant_isolation" ON "agent_instruction_working_copies" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ai_connection_pools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_connection_pools" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_connection_pools";
CREATE POLICY "tenant_isolation" ON "ai_connection_pools" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ai_connection_router_cursors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_connection_router_cursors" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_connection_router_cursors";
CREATE POLICY "tenant_isolation" ON "ai_connection_router_cursors" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ai_connection_task_pins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_connection_task_pins" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_connection_task_pins";
CREATE POLICY "tenant_isolation" ON "ai_connection_task_pins" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ai_subscription_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_subscription_connections" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_subscription_connections";
CREATE POLICY "tenant_isolation" ON "ai_subscription_connections" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ai_subscription_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_subscription_prices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_subscription_prices";
CREATE POLICY "tenant_isolation" ON "ai_subscription_prices" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ai_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_subscriptions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_subscriptions";
CREATE POLICY "tenant_isolation" ON "ai_subscriptions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "billing_invoice_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_invoice_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_invoice_lines";
CREATE POLICY "tenant_isolation" ON "billing_invoice_lines" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "billing_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_invoices";
CREATE POLICY "tenant_isolation" ON "billing_invoices" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "browser_use_browsers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_use_browsers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "browser_use_browsers";
CREATE POLICY "tenant_isolation" ON "browser_use_browsers" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "browser_use_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_use_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "browser_use_runs";
CREATE POLICY "tenant_isolation" ON "browser_use_runs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "browser_use_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_use_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "browser_use_sessions";
CREATE POLICY "tenant_isolation" ON "browser_use_sessions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "browser_use_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_use_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "browser_use_settings";
CREATE POLICY "tenant_isolation" ON "browser_use_settings" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "budget_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_reservations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "budget_reservations";
CREATE POLICY "tenant_isolation" ON "budget_reservations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "case_access_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_access_sources" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "case_access_sources";
CREATE POLICY "tenant_isolation" ON "case_access_sources" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "case_handoffs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_handoffs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "case_handoffs";
CREATE POLICY "tenant_isolation" ON "case_handoffs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_completion_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_completion_deliveries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_completion_deliveries";
CREATE POLICY "tenant_isolation" ON "chat_completion_deliveries" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_github_configurations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_github_configurations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_github_configurations";
CREATE POLICY "tenant_isolation" ON "chat_github_configurations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_github_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_github_registrations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_github_registrations";
CREATE POLICY "tenant_isolation" ON "chat_github_registrations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_github_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_github_reviews" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_github_reviews";
CREATE POLICY "tenant_isolation" ON "chat_github_reviews" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_slack_manager_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_slack_manager_grants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_slack_manager_grants";
CREATE POLICY "tenant_isolation" ON "chat_slack_manager_grants" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_slack_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_slack_registrations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_slack_registrations";
CREATE POLICY "tenant_isolation" ON "chat_slack_registrations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_task_handoffs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_task_handoffs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_task_handoffs";
CREATE POLICY "tenant_isolation" ON "chat_task_handoffs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_voice_callbacks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_voice_callbacks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_voice_callbacks";
CREATE POLICY "tenant_isolation" ON "chat_voice_callbacks" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_voice_inbound_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_voice_inbound_calls" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_voice_inbound_calls";
CREATE POLICY "tenant_isolation" ON "chat_voice_inbound_calls" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_voice_phone_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_voice_phone_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_voice_phone_lines";
CREATE POLICY "tenant_isolation" ON "chat_voice_phone_lines" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_voice_replies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_voice_replies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_voice_replies";
CREATE POLICY "tenant_isolation" ON "chat_voice_replies" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_voice_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_voice_reports" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_voice_reports";
CREATE POLICY "tenant_isolation" ON "chat_voice_reports" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_voice_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_voice_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_voice_sessions";
CREATE POLICY "tenant_isolation" ON "chat_voice_sessions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "chat_voice_tool_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_voice_tool_calls" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "chat_voice_tool_calls";
CREATE POLICY "tenant_isolation" ON "chat_voice_tool_calls" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_decision_models" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_decision_models" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_decision_models";
CREATE POLICY "tenant_isolation" ON "company_decision_models" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_fast_responses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_fast_responses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_fast_responses";
CREATE POLICY "tenant_isolation" ON "company_fast_responses" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_memory_databases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_memory_databases" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_memory_databases";
CREATE POLICY "tenant_isolation" ON "company_memory_databases" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_observability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_observability" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_observability";
CREATE POLICY "tenant_isolation" ON "company_observability" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_prompt_injection_prevention" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_prompt_injection_prevention" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_prompt_injection_prevention";
CREATE POLICY "tenant_isolation" ON "company_prompt_injection_prevention" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_import_budgets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_import_budgets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_import_budgets";
CREATE POLICY "tenant_isolation" ON "company_skill_import_budgets" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_repository_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_repository_snapshots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_repository_snapshots";
CREATE POLICY "tenant_isolation" ON "company_skill_repository_snapshots" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_source_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_source_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_source_entries";
CREATE POLICY "tenant_isolation" ON "company_skill_source_entries" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_sources" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_sources";
CREATE POLICY "tenant_isolation" ON "company_skill_sources" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "cost_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cost_adjustments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "cost_adjustments";
CREATE POLICY "tenant_isolation" ON "cost_adjustments" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_invocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_invocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_invocations";
CREATE POLICY "tenant_isolation" ON "decision_invocations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "dot_agent_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dot_agent_bindings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "dot_agent_bindings";
CREATE POLICY "tenant_isolation" ON "dot_agent_bindings" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "dot_mailbox_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dot_mailbox_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "dot_mailbox_items";
CREATE POLICY "tenant_isolation" ON "dot_mailbox_items" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "dot_runner_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dot_runner_assignments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "dot_runner_assignments";
CREATE POLICY "tenant_isolation" ON "dot_runner_assignments" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "dot_runner_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dot_runner_operations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "dot_runner_operations";
CREATE POLICY "tenant_isolation" ON "dot_runner_operations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "execution_workspace_repositories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_workspace_repositories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "execution_workspace_repositories";
CREATE POLICY "tenant_isolation" ON "execution_workspace_repositories" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "execution_workspace_repository_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_workspace_repository_access" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "execution_workspace_repository_access";
CREATE POLICY "tenant_isolation" ON "execution_workspace_repository_access" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "execution_workspace_repository_roots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_workspace_repository_roots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "execution_workspace_repository_roots";
CREATE POLICY "tenant_isolation" ON "execution_workspace_repository_roots" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "external_agent_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_agent_holds" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "external_agent_holds";
CREATE POLICY "tenant_isolation" ON "external_agent_holds" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "fast_response_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fast_response_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "fast_response_requests";
CREATE POLICY "tenant_isolation" ON "fast_response_requests" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "grok_bot_dispatches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grok_bot_dispatches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "grok_bot_dispatches";
CREATE POLICY "tenant_isolation" ON "grok_bot_dispatches" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "grok_bot_routines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grok_bot_routines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "grok_bot_routines";
CREATE POLICY "tenant_isolation" ON "grok_bot_routines" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "mcp_attachment_uploads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_attachment_uploads" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mcp_attachment_uploads";
CREATE POLICY "tenant_isolation" ON "mcp_attachment_uploads" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "mcp_event_admissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_event_admissions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mcp_event_admissions";
CREATE POLICY "tenant_isolation" ON "mcp_event_admissions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "mcp_event_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_event_subscriptions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mcp_event_subscriptions";
CREATE POLICY "tenant_isolation" ON "mcp_event_subscriptions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "mcp_file_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_file_tickets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mcp_file_tickets";
CREATE POLICY "tenant_isolation" ON "mcp_file_tickets" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "mcp_mutation_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_mutation_receipts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mcp_mutation_receipts";
CREATE POLICY "tenant_isolation" ON "mcp_mutation_receipts" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_oauth_grants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mcp_oauth_grants";
CREATE POLICY "tenant_isolation" ON "mcp_oauth_grants" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "muse_agent_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "muse_agent_bindings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "muse_agent_bindings";
CREATE POLICY "tenant_isolation" ON "muse_agent_bindings" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "muse_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "muse_credentials" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "muse_credentials";
CREATE POLICY "tenant_isolation" ON "muse_credentials" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "muse_idle_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "muse_idle_receipts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "muse_idle_receipts";
CREATE POLICY "tenant_isolation" ON "muse_idle_receipts" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "muse_input_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "muse_input_deliveries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "muse_input_deliveries";
CREATE POLICY "tenant_isolation" ON "muse_input_deliveries" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "muse_mailbox_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "muse_mailbox_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "muse_mailbox_items";
CREATE POLICY "tenant_isolation" ON "muse_mailbox_items" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "muse_receiver_contact_buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "muse_receiver_contact_buckets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "muse_receiver_contact_buckets";
CREATE POLICY "tenant_isolation" ON "muse_receiver_contact_buckets" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "muse_runner_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "muse_runner_assignments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "muse_runner_assignments";
CREATE POLICY "tenant_isolation" ON "muse_runner_assignments" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "muse_runner_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "muse_runner_operations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "muse_runner_operations";
CREATE POLICY "tenant_isolation" ON "muse_runner_operations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "project_access_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_access_members" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "project_access_members";
CREATE POLICY "tenant_isolation" ON "project_access_members" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "project_skill_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_skill_sources" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "project_skill_sources";
CREATE POLICY "tenant_isolation" ON "project_skill_sources" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "prompt_injection_invocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prompt_injection_invocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "prompt_injection_invocations";
CREATE POLICY "tenant_isolation" ON "prompt_injection_invocations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "provider_billing_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_billing_snapshots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "provider_billing_snapshots";
CREATE POLICY "tenant_isolation" ON "provider_billing_snapshots" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "resource_lifecycle_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_lifecycle_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "resource_lifecycle_events";
CREATE POLICY "tenant_isolation" ON "resource_lifecycle_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "routine_webhook_test_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "routine_webhook_test_receipts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "routine_webhook_test_receipts";
CREATE POLICY "tenant_isolation" ON "routine_webhook_test_receipts" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "run_usage_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_usage_receipts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "run_usage_receipts";
CREATE POLICY "tenant_isolation" ON "run_usage_receipts" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "runner_api_response_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runner_api_response_reservations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "runner_api_response_reservations";
CREATE POLICY "tenant_isolation" ON "runner_api_response_reservations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_connection_app_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_connection_app_snapshots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_connection_app_snapshots";
CREATE POLICY "tenant_isolation" ON "tool_connection_app_snapshots" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_connection_app_syncs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_connection_app_syncs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_connection_app_syncs";
CREATE POLICY "tenant_isolation" ON "tool_connection_app_syncs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "user_company_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_company_preferences" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_company_preferences";
CREATE POLICY "tenant_isolation" ON "user_company_preferences" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
