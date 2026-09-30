-- TECH-6956: Postgres row-level security on this plugin's memory table.
--
-- 001 made the tenant key un-NULLable so a cross-tenant overwrite could not
-- happen by accident, and store.ts filters every statement on company_id +
-- agent_id (tests/fake-db.ts asserts it does). This is the layer underneath
-- both: even a query that forgot the filter entirely cannot read or write
-- another company's rows.
--
-- Same convention as the core tables (packages/db/src/rls.ts): pass rows
-- through when `app.current_company_id` is unset, filter to that company when
-- it is set. The host binds it per plugin RPC invocation --
-- plugin-host-services.ts#ensureCompanyId records the tenant, and
-- plugin-loader.ts wraps each invocation in its own tenant context.
--
-- FORCE is required: Paperclip creates this schema and table as the same role
-- it serves traffic with, and Postgres exempts a table's owner from its own
-- policies unless the table is FORCEd.
--
-- No `DROP POLICY IF EXISTS` guard here, unlike the core migration:
-- validatePluginMigrationStatement refuses any statement starting with DROP.
-- Plugin migrations are recorded in `plugin_migrations` and applied once, so
-- the unguarded CREATE is safe; a re-run would need the record cleared first,
-- which already implies the schema was rebuilt.

ALTER TABLE plugin_rh_agent_memory_ce4b575f82.agent_memory ENABLE ROW LEVEL SECURITY;

ALTER TABLE plugin_rh_agent_memory_ce4b575f82.agent_memory FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON plugin_rh_agent_memory_ce4b575f82.agent_memory
  FOR ALL
  USING (
    nullif(current_setting('app.current_company_id', true), '') IS NULL
    OR company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.current_company_id', true), '') IS NULL
    OR company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
  );
