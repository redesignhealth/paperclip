import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  RLS_EXEMPT_TENANT_TABLES,
  TENANT_COMPANY_SETTING,
  listRlsTargets,
  renderTenantIsolationDdl,
  tenantCheckPredicateSql,
  tenantUsingPredicateSql,
} from "./rls.js";
import { RLS_MIGRATION_FILE, renderRlsMigrationFile, rlsMigrationPath } from "./render-rls-migration.js";

/**
 * TECH-6956: keeps the committed RLS migration honest.
 *
 * The migration covers ~143 tables and is generated from the Drizzle schema.
 * The whole arrangement only holds if the committed file and the generator
 * agree, so this test is the mechanism that makes "someone added a
 * tenant-scoped table" a visible event rather than a silent coverage hole.
 */

describe("tenant-isolation RLS migration", () => {
  it("matches what the generator renders from the current schema", async () => {
    const committed = await readFile(rlsMigrationPath(), "utf8");
    // If this fails, either run `pnpm --filter @paperclipai/db rls:generate`
    // and commit the result, or add the new table to
    // RLS_EXEMPT_TENANT_TABLES with a reason. Note that regenerating only
    // covers databases that have not yet applied 0288 -- an already-migrated
    // database needs a follow-on migration, which the boot check will demand.
    expect(committed).toBe(renderRlsMigrationFile());
  });

  it("covers every tenant-scoped table that is not explicitly exempt", () => {
    const targets = listRlsTargets();
    const covered = new Set(targets.map((target) => target.table));

    // Spot-check the tables the ticket calls out by name, so a refactor that
    // renamed or dropped one of them cannot quietly reduce coverage.
    for (const table of ["agents", "issues", "projects", "tool_connections", "tool_profiles"]) {
      expect(covered, `${table} must be covered by tenant isolation`).toContain(table);
    }

    // Exemptions are holes in the backstop, so each one must be deliberate
    // AND reasoned -- an empty reason string would defeat the point of the
    // list existing.
    for (const [table, reason] of RLS_EXEMPT_TENANT_TABLES) {
      expect(covered, `${table} is exempt and must not also be covered`).not.toContain(table);
      expect(reason.trim().length, `${table} exemption needs a reason`).toBeGreaterThan(0);
    }
  });

  it("passes rows through when the session variable is unset", () => {
    // The disjunct that makes this change additive: without it, every code
    // path that has not been taught to bind a company would see zero rows on
    // every covered table -- i.e. a total outage rather than a backstop.
    const predicate = tenantUsingPredicateSql({
      table: "agents",
      column: "company_id",
      nullableScope: false,
    });
    expect(predicate).toContain(`nullif(current_setting('${TENANT_COMPANY_SETTING}', true), '') IS NULL`);
  });

  it("admits instance-level NULL company_id rows on nullable-scope tables' USING clause", () => {
    const nullable = tenantUsingPredicateSql({
      table: "plugin_logs",
      column: "company_id",
      nullableScope: true,
    });
    const notNullable = tenantUsingPredicateSql({
      table: "agents",
      column: "company_id",
      nullableScope: false,
    });
    // `plugin_logs` and friends store instance-level rows with no company at
    // all; a policy that dropped them would break instance-level logging
    // while adding nothing, since a NULL row belongs to no tenant to leak
    // between.
    expect(nullable).toContain(`"company_id" IS NULL`);
    expect(notNullable).not.toContain(`"company_id" IS NULL`);
  });

  it(
    "never admits a NULL company_id write through WITH CHECK, even on nullable-scope tables",
    () => {
      // TECH-6956 round 1 (Argus): the WITH CHECK clause used to be identical
      // to USING for nullableScope tables, which let a request scoped to a
      // real company detach a row into the unscoped instance-level pool (or
      // plant/tamper with an existing NULL-company row) via INSERT/UPDATE.
      // WITH CHECK must never admit `company_id IS NULL` as an alternative to
      // matching the bound company -- only "setting unset" may pass a write
      // through unchecked.
      const nullableScopeCheck = tenantCheckPredicateSql({
        table: "invites",
        column: "company_id",
        nullableScope: true,
      });
      expect(nullableScopeCheck).not.toContain(`"company_id" IS NULL`);
      expect(nullableScopeCheck).toContain(
        `nullif(current_setting('${TENANT_COMPANY_SETTING}', true), '') IS NULL`,
      );

      // Same table's USING clause still admits the NULL-company row for reads.
      const nullableScopeUsing = tenantUsingPredicateSql({
        table: "invites",
        column: "company_id",
        nullableScope: true,
      });
      expect(nullableScopeUsing).toContain(`"company_id" IS NULL`);
    },
  );

  it("emits idempotent DDL so a re-applied migration cannot fail", () => {
    const statements = renderTenantIsolationDdl({
      table: "agents",
      column: "company_id",
      nullableScope: false,
    });
    expect(statements).toEqual([
      `ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;`,
      // FORCE is what makes the policy apply to the table owner, which is the
      // role Paperclip connects as. Without it the whole migration is a
      // no-op that looks correct in pg_policies.
      `ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;`,
      `DROP POLICY IF EXISTS "tenant_isolation" ON "agents";`,
      expect.stringContaining(`CREATE POLICY "tenant_isolation" ON "agents" FOR ALL USING (`),
    ]);
    // Both clauses are required: USING alone would filter reads but let an
    // INSERT plant a row in another company.
    expect(statements[3]).toContain("WITH CHECK (");
  });

  it("is registered in the migration journal", async () => {
    const journal = JSON.parse(
      await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    const tag = RLS_MIGRATION_FILE.replace(/\.sql$/, "");
    // An unjournalled migration file is never applied, which would make the
    // backstop silently absent in exactly the way the boot check exists to
    // catch.
    expect(journal.entries.map((entry) => entry.tag)).toContain(tag);
  });
});
