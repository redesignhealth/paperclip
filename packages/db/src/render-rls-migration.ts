/**
 * TECH-6956: renders `migrations/0288_tenant_isolation_rls.sql`.
 *
 * The RLS migration covers ~143 tables, so hand-maintaining it would
 * guarantee drift the first time someone adds a tenant-scoped table. Instead
 * the target list is derived from the Drizzle schema (`rls.ts`) and the SQL
 * is rendered from it, with `rls-migration.test.ts` asserting the committed
 * file still matches. That turns "a new company_id table has no policy" from
 * an invisible hole into a failing test.
 *
 * Run `pnpm --filter @paperclipai/db rls:generate` after adding a
 * tenant-scoped table (or after exempting one in
 * `RLS_EXEMPT_TENANT_TABLES`), then commit the regenerated file.
 *
 * Deliberately regenerates IN PLACE rather than emitting a new numbered
 * migration: the DDL is idempotent (`ENABLE`/`FORCE` are no-ops when already
 * set, and the policy is dropped by name before being recreated), but a
 * database that has already recorded 0288 will not re-run it. So a
 * regenerated 0288 only takes effect on databases that have not applied it
 * yet -- adding coverage for a NEW table on an ALREADY-migrated database
 * needs its own follow-on migration. `rls-boot-check.ts` is what catches that
 * case: it compares live policy state against this same derived list at
 * startup, so a table added to the list but missing from the database fails
 * loudly instead of silently going uncovered.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listRlsTargets, renderTenantIsolationMigration, type RlsTarget } from "./rls.js";

export const RLS_MIGRATION_FILE = "0288_tenant_isolation_rls.sql";

const RLS_MIGRATION_HEADER = `-- TECH-6956: Postgres Row-Level Security as a tenant-isolation backstop.
--
-- Paperclip's tenant isolation is otherwise entirely application-layer:
-- \`assertCompanyAccess\` calls in server/src/routes/**. That has already
-- produced two Critical cross-tenant CVEs (a route that simply forgot the
-- check) plus a third instance found in the plugin memory mechanisms
-- (TECH-6955). These policies are the backstop for the next one, not a
-- replacement for those checks -- none were removed.
--
-- This file is GENERATED from the Drizzle schema. Do not hand-edit it; the
-- target list, the exemptions and the predicate all live in
-- packages/db/src/rls.ts, and \`pnpm --filter @paperclipai/db rls:generate\`
-- re-renders the DDL below. packages/db/src/rls-migration.test.ts fails if
-- this file drifts from what that module renders, so a new tenant-scoped
-- table cannot be added without either covering it or exempting it on
-- purpose.
--
-- Behavior: every policy passes rows through unchanged when
-- \`app.current_company_id\` is unset, and filters to that company when it is
-- set (see rls.ts for why that asymmetry makes this additive rather than a
-- flag day). FORCE is required because Paperclip connects as the table
-- owner, which Postgres otherwise exempts from a table's own policies.
--
-- Statement grouping: every table's statements (four for most tables; ten
-- for the handful of "nullableScope" tables that get command-specific
-- policies instead of one FOR ALL policy -- see rls.ts's
-- NULLABLE_SCOPE_POLICY_NAMES) are deliberately kept in one breakpoint-
-- delimited chunk so a table is never left with RLS enabled but no policy --
-- that intermediate state denies all rows to a scoped session. Migrations
-- here run one file per transaction
-- (applyPendingMigrationsManually), so the whole file is atomic regardless,
-- but the grouping keeps that true statement-by-statement as well.
--
-- Nothing in this header may contain the literal breakpoint marker that
-- separates statements below: splitMigrationStatements() splits on that text
-- anywhere it appears, including inside a comment, which would cut this
-- header in half and feed Postgres a fragment of prose as SQL.
`;

/**
 * Lock-safety preamble, matching the house style of recent migrations (see
 * 0287_light_zaran.sql). These are short ALTERs that take ACCESS EXCLUSIVE
 * briefly per table; bounding the wait means a deploy that collides with a
 * long-running query fails fast instead of queueing behind it and blocking
 * every subsequent reader on those tables.
 */
const RLS_MIGRATION_PREAMBLE = [
  "SET LOCAL lock_timeout = '5s';--> statement-breakpoint",
  "SET LOCAL statement_timeout = '60s';--> statement-breakpoint",
].join("\n");

/** The exact expected contents of the committed migration file. */
export function renderRlsMigrationFile(targets: RlsTarget[] = listRlsTargets()): string {
  return `${RLS_MIGRATION_HEADER}${RLS_MIGRATION_PREAMBLE}\n${renderTenantIsolationMigration(targets)}`;
}

export function rlsMigrationPath(): string {
  return fileURLToPath(new URL(`./migrations/${RLS_MIGRATION_FILE}`, import.meta.url));
}

async function main(): Promise<void> {
  const targets = listRlsTargets();
  const path = rlsMigrationPath();
  await writeFile(path, renderRlsMigrationFile(targets), "utf8");
  const nullable = targets.filter((target) => target.nullableScope).map((target) => target.table);
  console.log(
    `Wrote ${RLS_MIGRATION_FILE}: ${targets.length} tables covered ` +
      `(${nullable.length} admit instance-level NULL company_id: ${nullable.join(", ")})`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
