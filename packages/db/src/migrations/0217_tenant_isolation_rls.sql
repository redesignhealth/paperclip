-- TECH-6956: Postgres Row-Level Security as a tenant-isolation backstop.
--
-- Paperclip's tenant isolation is otherwise entirely application-layer:
-- `assertCompanyAccess` calls in server/src/routes/**. That has already
-- produced two Critical cross-tenant CVEs (a route that simply forgot the
-- check) plus a third instance found in the plugin memory mechanisms
-- (TECH-6955). These policies are the backstop for the next one, not a
-- replacement for those checks -- none were removed.
--
-- This file is GENERATED from the Drizzle schema. Do not hand-edit it; the
-- target list, the exemptions and the predicate all live in
-- packages/db/src/rls.ts, and `pnpm --filter @paperclipai/db rls:generate`
-- re-renders the DDL below. packages/db/src/rls-migration.test.ts fails if
-- this file drifts from what that module renders, so a new tenant-scoped
-- table cannot be added without either covering it or exempting it on
-- purpose.
--
-- Behavior: every policy passes rows through unchanged when
-- `app.current_company_id` is unset, and filters to that company when it is
-- set (see rls.ts for why that asymmetry makes this additive rather than a
-- flag day). FORCE is required because Paperclip connects as the table
-- owner, which Postgres otherwise exempts from a table's own policies.
--
-- Statement grouping: the four statements per table are deliberately kept in
-- one breakpoint-delimited chunk so a table is never left with RLS enabled
-- but no policy -- that intermediate state denies all rows to a scoped
-- session. Migrations here run one file per transaction
-- (applyPendingMigrationsManually), so the whole file is atomic regardless,
-- but the grouping keeps that true statement-by-statement as well.
--
-- Nothing in this header may contain the literal breakpoint marker that
-- separates statements below: splitMigrationStatements() splits on that text
-- anywhere it appears, including inside a comment, which would cut this
-- header in half and feed Postgres a fragment of prose as SQL.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "activity_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activity_log" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "activity_log";
CREATE POLICY "tenant_isolation" ON "activity_log" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_api_keys" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_api_keys";
CREATE POLICY "tenant_isolation" ON "agent_api_keys" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_config_revisions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_config_revisions";
CREATE POLICY "tenant_isolation" ON "agent_config_revisions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_memberships";
CREATE POLICY "tenant_isolation" ON "agent_memberships" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_ownership_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_ownership_grants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_ownership_grants";
CREATE POLICY "tenant_isolation" ON "agent_ownership_grants" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_ownership_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_ownership_transfers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_ownership_transfers";
CREATE POLICY "tenant_isolation" ON "agent_ownership_transfers" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_runtime_state" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_runtime_state";
CREATE POLICY "tenant_isolation" ON "agent_runtime_state" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_task_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_task_sessions";
CREATE POLICY "tenant_isolation" ON "agent_task_sessions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_wakeup_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_wakeup_requests";
CREATE POLICY "tenant_isolation" ON "agent_wakeup_requests" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agents";
CREATE POLICY "tenant_isolation" ON "agents" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "approval_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_comments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "approval_comments";
CREATE POLICY "tenant_isolation" ON "approval_comments" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approvals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "approvals";
CREATE POLICY "tenant_isolation" ON "approvals" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "assets";
CREATE POLICY "tenant_isolation" ON "assets" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "budget_incidents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_incidents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "budget_incidents";
CREATE POLICY "tenant_isolation" ON "budget_incidents" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "budget_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_policies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "budget_policies";
CREATE POLICY "tenant_isolation" ON "budget_policies" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "built_in_managed_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "built_in_managed_resources" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "built_in_managed_resources";
CREATE POLICY "tenant_isolation" ON "built_in_managed_resources" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "case_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_attachments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "case_attachments";
CREATE POLICY "tenant_isolation" ON "case_attachments" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "case_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_documents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "case_documents";
CREATE POLICY "tenant_isolation" ON "case_documents" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "case_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "case_events";
CREATE POLICY "tenant_isolation" ON "case_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "case_issue_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_issue_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "case_issue_links";
CREATE POLICY "tenant_isolation" ON "case_issue_links" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "case_labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_labels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "case_labels";
CREATE POLICY "tenant_isolation" ON "case_labels" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cases" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "cases";
CREATE POLICY "tenant_isolation" ON "cases" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_logos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_logos" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_logos";
CREATE POLICY "tenant_isolation" ON "company_logos" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_memberships";
CREATE POLICY "tenant_isolation" ON "company_memberships" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_secret_bindings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_secret_bindings";
CREATE POLICY "tenant_isolation" ON "company_secret_bindings" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_secret_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_secret_proposals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_secret_proposals";
CREATE POLICY "tenant_isolation" ON "company_secret_proposals" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_secret_provider_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_secret_provider_configs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_secret_provider_configs";
CREATE POLICY "tenant_isolation" ON "company_secret_provider_configs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_secrets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_secrets";
CREATE POLICY "tenant_isolation" ON "company_secrets" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_comments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_comments";
CREATE POLICY "tenant_isolation" ON "company_skill_comments" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_policies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_policies";
CREATE POLICY "tenant_isolation" ON "company_skill_policies" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_stars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_stars" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_stars";
CREATE POLICY "tenant_isolation" ON "company_skill_stars" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_test_inputs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_test_inputs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_test_inputs";
CREATE POLICY "tenant_isolation" ON "company_skill_test_inputs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_test_run_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_test_run_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_test_run_templates";
CREATE POLICY "tenant_isolation" ON "company_skill_test_run_templates" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_test_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_test_runs";
CREATE POLICY "tenant_isolation" ON "company_skill_test_runs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skill_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skill_versions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skill_versions";
CREATE POLICY "tenant_isolation" ON "company_skill_versions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_skills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_skills" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_skills";
CREATE POLICY "tenant_isolation" ON "company_skills" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "company_user_sidebar_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_user_sidebar_preferences" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "company_user_sidebar_preferences";
CREATE POLICY "tenant_isolation" ON "company_user_sidebar_preferences" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "connection_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_grants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "connection_grants";
CREATE POLICY "tenant_isolation" ON "connection_grants" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "connection_token_issuances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_token_issuances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "connection_token_issuances";
CREATE POLICY "tenant_isolation" ON "connection_token_issuances" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "cost_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cost_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "cost_events";
CREATE POLICY "tenant_isolation" ON "cost_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_archive_notification_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_archive_notification_outbox" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_archive_notification_outbox";
CREATE POLICY "tenant_isolation" ON "decision_archive_notification_outbox" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_bundles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_bundles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_bundles";
CREATE POLICY "tenant_isolation" ON "decision_bundles" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_queue_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_queue_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_queue_items";
CREATE POLICY "tenant_isolation" ON "decision_queue_items" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_queues" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_queues" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_queues";
CREATE POLICY "tenant_isolation" ON "decision_queues" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_retention" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_retention" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_retention";
CREATE POLICY "tenant_isolation" ON "decision_retention" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_target_issues" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_target_issues" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_target_issues";
CREATE POLICY "tenant_isolation" ON "decision_target_issues" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_training_examples" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_training_examples" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_training_examples";
CREATE POLICY "tenant_isolation" ON "decision_training_examples" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_triage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_triage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_triage";
CREATE POLICY "tenant_isolation" ON "decision_triage" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decision_triage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_triage_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decision_triage_events";
CREATE POLICY "tenant_isolation" ON "decision_triage_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decisions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "decisions";
CREATE POLICY "tenant_isolation" ON "decisions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_annotation_anchor_snapshots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "document_annotation_anchor_snapshots";
CREATE POLICY "tenant_isolation" ON "document_annotation_anchor_snapshots" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_annotation_comments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "document_annotation_comments";
CREATE POLICY "tenant_isolation" ON "document_annotation_comments" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_annotation_threads" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "document_annotation_threads";
CREATE POLICY "tenant_isolation" ON "document_annotation_threads" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "document_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "document_memberships";
CREATE POLICY "tenant_isolation" ON "document_memberships" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "document_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_revisions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "document_revisions";
CREATE POLICY "tenant_isolation" ON "document_revisions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "documents";
CREATE POLICY "tenant_isolation" ON "documents" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "environment_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "environment_leases" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "environment_leases";
CREATE POLICY "tenant_isolation" ON "environment_leases" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_workspaces" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "execution_workspaces";
CREATE POLICY "tenant_isolation" ON "execution_workspaces" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "external_object_mentions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_object_mentions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "external_object_mentions";
CREATE POLICY "tenant_isolation" ON "external_object_mentions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "external_objects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_objects" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "external_objects";
CREATE POLICY "tenant_isolation" ON "external_objects" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "feedback_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feedback_exports" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "feedback_exports";
CREATE POLICY "tenant_isolation" ON "feedback_exports" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "feedback_votes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feedback_votes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "feedback_votes";
CREATE POLICY "tenant_isolation" ON "feedback_votes" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "finance_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "finance_events";
CREATE POLICY "tenant_isolation" ON "finance_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "folders";
CREATE POLICY "tenant_isolation" ON "folders" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "goals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "goals";
CREATE POLICY "tenant_isolation" ON "goals" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "heartbeat_run_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "heartbeat_run_events";
CREATE POLICY "tenant_isolation" ON "heartbeat_run_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "heartbeat_run_watchdog_decisions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "heartbeat_run_watchdog_decisions";
CREATE POLICY "tenant_isolation" ON "heartbeat_run_watchdog_decisions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "heartbeat_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "heartbeat_runs";
CREATE POLICY "tenant_isolation" ON "heartbeat_runs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox_dismissals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "inbox_dismissals";
CREATE POLICY "tenant_isolation" ON "inbox_dismissals" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invites" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "invites";
CREATE POLICY "tenant_isolation" ON "invites" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_approvals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_approvals";
CREATE POLICY "tenant_isolation" ON "issue_approvals" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_attachments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_attachments";
CREATE POLICY "tenant_isolation" ON "issue_attachments" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_comments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_comments";
CREATE POLICY "tenant_isolation" ON "issue_comments" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_create_idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_create_idempotency_keys" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_create_idempotency_keys";
CREATE POLICY "tenant_isolation" ON "issue_create_idempotency_keys" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_documents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_documents";
CREATE POLICY "tenant_isolation" ON "issue_documents" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_execution_decisions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_execution_decisions";
CREATE POLICY "tenant_isolation" ON "issue_execution_decisions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_inbox_archives" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_inbox_archives";
CREATE POLICY "tenant_isolation" ON "issue_inbox_archives" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_labels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_labels";
CREATE POLICY "tenant_isolation" ON "issue_labels" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_plan_decompositions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_plan_decompositions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_plan_decompositions";
CREATE POLICY "tenant_isolation" ON "issue_plan_decompositions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_read_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_read_states" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_read_states";
CREATE POLICY "tenant_isolation" ON "issue_read_states" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_recovery_actions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_recovery_actions";
CREATE POLICY "tenant_isolation" ON "issue_recovery_actions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_reference_mentions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_reference_mentions";
CREATE POLICY "tenant_isolation" ON "issue_reference_mentions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_relations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_relations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_relations";
CREATE POLICY "tenant_isolation" ON "issue_relations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_thread_interactions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_thread_interactions";
CREATE POLICY "tenant_isolation" ON "issue_thread_interactions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_tree_hold_members" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_tree_hold_members";
CREATE POLICY "tenant_isolation" ON "issue_tree_hold_members" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_tree_holds" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_tree_holds";
CREATE POLICY "tenant_isolation" ON "issue_tree_holds" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_watchdogs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_watchdogs";
CREATE POLICY "tenant_isolation" ON "issue_watchdogs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issue_work_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_work_products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_work_products";
CREATE POLICY "tenant_isolation" ON "issue_work_products" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "issues" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issues" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "issues";
CREATE POLICY "tenant_isolation" ON "issues" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "join_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "join_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "join_requests";
CREATE POLICY "tenant_isolation" ON "join_requests" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "labels";
CREATE POLICY "tenant_isolation" ON "labels" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_automation_executions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pipeline_automation_executions";
CREATE POLICY "tenant_isolation" ON "pipeline_automation_executions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "pipeline_case_blockers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_case_blockers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pipeline_case_blockers";
CREATE POLICY "tenant_isolation" ON "pipeline_case_blockers" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "pipeline_case_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_case_documents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pipeline_case_documents";
CREATE POLICY "tenant_isolation" ON "pipeline_case_documents" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_case_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pipeline_case_events";
CREATE POLICY "tenant_isolation" ON "pipeline_case_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_case_issue_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pipeline_case_issue_links";
CREATE POLICY "tenant_isolation" ON "pipeline_case_issue_links" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "pipeline_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_cases" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pipeline_cases";
CREATE POLICY "tenant_isolation" ON "pipeline_cases" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "pipeline_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_documents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pipeline_documents";
CREATE POLICY "tenant_isolation" ON "pipeline_documents" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "pipelines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipelines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pipelines";
CREATE POLICY "tenant_isolation" ON "pipelines" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "plugin_company_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plugin_company_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "plugin_company_settings";
CREATE POLICY "tenant_isolation" ON "plugin_company_settings" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "plugin_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plugin_config" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "plugin_config";
CREATE POLICY "tenant_isolation" ON "plugin_config" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "plugin_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plugin_entities" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "plugin_entities";
CREATE POLICY "tenant_isolation" ON "plugin_entities" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plugin_job_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "plugin_job_runs";
CREATE POLICY "tenant_isolation" ON "plugin_job_runs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "plugin_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plugin_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "plugin_logs";
CREATE POLICY "tenant_isolation" ON "plugin_logs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "plugin_managed_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plugin_managed_resources" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "plugin_managed_resources";
CREATE POLICY "tenant_isolation" ON "plugin_managed_resources" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plugin_webhook_deliveries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "plugin_webhook_deliveries";
CREATE POLICY "tenant_isolation" ON "plugin_webhook_deliveries" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "principal_permission_grants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "principal_permission_grants";
CREATE POLICY "tenant_isolation" ON "principal_permission_grants" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "project_goals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_goals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "project_goals";
CREATE POLICY "tenant_isolation" ON "project_goals" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "project_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "project_memberships";
CREATE POLICY "tenant_isolation" ON "project_memberships" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "project_workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_workspaces" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "project_workspaces";
CREATE POLICY "tenant_isolation" ON "project_workspaces" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "projects";
CREATE POLICY "tenant_isolation" ON "projects" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "routine_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "routine_documents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "routine_documents";
CREATE POLICY "tenant_isolation" ON "routine_documents" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "routine_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "routine_revisions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "routine_revisions";
CREATE POLICY "tenant_isolation" ON "routine_revisions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "routine_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "routine_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "routine_runs";
CREATE POLICY "tenant_isolation" ON "routine_runs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "routine_triggers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "routine_triggers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "routine_triggers";
CREATE POLICY "tenant_isolation" ON "routine_triggers" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "routines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "routines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "routines";
CREATE POLICY "tenant_isolation" ON "routines" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "secret_access_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "secret_access_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "secret_access_events";
CREATE POLICY "tenant_isolation" ON "secret_access_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "smoke_run_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "smoke_run_steps" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "smoke_run_steps";
CREATE POLICY "tenant_isolation" ON "smoke_run_steps" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "smoke_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "smoke_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "smoke_runs";
CREATE POLICY "tenant_isolation" ON "smoke_runs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "status_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "status_cards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "status_cards";
CREATE POLICY "tenant_isolation" ON "status_cards" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "summary_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "summary_slots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "summary_slots";
CREATE POLICY "tenant_isolation" ON "summary_slots" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_access_audit_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_access_audit_events";
CREATE POLICY "tenant_isolation" ON "tool_access_audit_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_action_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_action_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_action_requests";
CREATE POLICY "tenant_isolation" ON "tool_action_requests" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_applications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_applications";
CREATE POLICY "tenant_isolation" ON "tool_applications" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_call_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_call_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_call_events";
CREATE POLICY "tenant_isolation" ON "tool_call_events" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_catalog_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_catalog_entries";
CREATE POLICY "tenant_isolation" ON "tool_catalog_entries" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_connection_installs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_connection_installs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_connection_installs";
CREATE POLICY "tenant_isolation" ON "tool_connection_installs" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_connections" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_connections";
CREATE POLICY "tenant_isolation" ON "tool_connections" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_gateway_rate_limit_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_gateway_rate_limit_counters" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_gateway_rate_limit_counters";
CREATE POLICY "tenant_isolation" ON "tool_gateway_rate_limit_counters" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_gateway_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_gateway_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_gateway_sessions";
CREATE POLICY "tenant_isolation" ON "tool_gateway_sessions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_invocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_invocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_invocations";
CREATE POLICY "tenant_isolation" ON "tool_invocations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_mcp_gateway_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_mcp_gateway_tokens";
CREATE POLICY "tenant_isolation" ON "tool_mcp_gateway_tokens" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_mcp_gateways" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_mcp_gateways";
CREATE POLICY "tenant_isolation" ON "tool_mcp_gateways" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_oauth_states" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_oauth_states";
CREATE POLICY "tenant_isolation" ON "tool_oauth_states" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_policies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_policies";
CREATE POLICY "tenant_isolation" ON "tool_policies" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_profile_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_profile_bindings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_profile_bindings";
CREATE POLICY "tenant_isolation" ON "tool_profile_bindings" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_profile_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_profile_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_profile_entries";
CREATE POLICY "tenant_isolation" ON "tool_profile_entries" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_profiles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_profiles";
CREATE POLICY "tenant_isolation" ON "tool_profiles" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_rate_limit_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_rate_limit_counters" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_rate_limit_counters";
CREATE POLICY "tenant_isolation" ON "tool_rate_limit_counters" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_runtime_metric_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_runtime_metric_counters" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_runtime_metric_counters";
CREATE POLICY "tenant_isolation" ON "tool_runtime_metric_counters" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_runtime_slots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_runtime_slots";
CREATE POLICY "tenant_isolation" ON "tool_runtime_slots" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_stdio_command_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_stdio_command_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tool_stdio_command_templates";
CREATE POLICY "tenant_isolation" ON "tool_stdio_command_templates" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "user_inbox_agent_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_inbox_agent_policies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_inbox_agent_policies";
CREATE POLICY "tenant_isolation" ON "user_inbox_agent_policies" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "user_secret_declarations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_secret_declarations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_secret_declarations";
CREATE POLICY "tenant_isolation" ON "user_secret_declarations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_secret_definitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_secret_definitions";
CREATE POLICY "tenant_isolation" ON "user_secret_definitions" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workspace_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_operations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "workspace_operations";
CREATE POLICY "tenant_isolation" ON "workspace_operations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_runtime_services" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "workspace_runtime_services";
CREATE POLICY "tenant_isolation" ON "workspace_runtime_services" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);
