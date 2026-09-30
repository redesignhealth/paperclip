/**
 * TECH-6956: Postgres Row-Level Security as a tenant-isolation backstop.
 *
 * Paperclip's tenant isolation is otherwise entirely application-layer:
 * `assertCompanyAccess` calls scattered across `server/src/routes/**`. That
 * has already produced two Critical cross-tenant CVEs (a route that simply
 * forgot the check) plus a third instance found in the plugin memory
 * mechanisms (TECH-6955). RLS does not replace those checks -- it is the
 * backstop for the *next* one someone forgets.
 *
 * ## The convention
 *
 * Every tenant-scoped table gets a `tenant_isolation` policy keyed on the
 * `app.current_company_id` session variable:
 *
 *   USING (
 *     nullif(current_setting('app.current_company_id', true), '') IS NULL
 *     OR company_id = nullif(current_setting('app.current_company_id', true), '')::uuid
 *   )
 *
 * The leading "setting is unset" disjunct is deliberate and is what makes
 * this change *additive* rather than a flag day. Code paths that have not
 * been taught to bind the session variable (migrations, the CLI, boot-time
 * bootstrapping, background schedulers that legitimately sweep every
 * company) behave exactly as they did before. Code paths that DO bind it --
 * i.e. every authenticated HTTP request and every plugin-host DB call, via
 * `withCompanyScope()` -- get hard database-level row filtering that a
 * missing `assertCompanyAccess` cannot defeat.
 *
 * That asymmetry is the whole point: the attack surface for the CVE class
 * this targets is authenticated request handling, and that is exactly the
 * surface where the variable is always bound.
 *
 * ## Why FORCE ROW LEVEL SECURITY
 *
 * Postgres exempts a table's OWNER from its own RLS policies unless the
 * table is marked `FORCE ROW LEVEL SECURITY`. Paperclip runs migrations and
 * serves traffic as the same role, which is therefore the owner of every
 * table -- so plain `ENABLE ROW LEVEL SECURITY` would be a silent no-op
 * here. Every policy this module emits is paired with FORCE.
 *
 * FORCE still does not apply to superusers or to roles with the BYPASSRLS
 * attribute; there is no table-level way to override that. `describeRlsRole()`
 * reports it and the boot assertion logs it loudly, because an app role with
 * either attribute reduces this whole mechanism to decoration.
 *
 * ## Filtering, not erroring
 *
 * A `USING` clause filters non-matching rows out of SELECT/UPDATE/DELETE
 * silently -- a cross-tenant read returns zero rows, it does not raise. The
 * paired `WITH CHECK` clause *does* raise on an INSERT/UPDATE that would
 * write a row belonging to another company, because silently dropping a
 * write would be worse than failing it.
 */

import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";

/** Session variable holding the trusted company id for the current transaction. */
export const TENANT_COMPANY_SETTING = "app.current_company_id";

/** Name of the per-table policy this module manages. */
export const TENANT_ISOLATION_POLICY = "tenant_isolation";

/** The physical column that carries tenant scope on covered tables. */
export const TENANT_SCOPE_COLUMN = "company_id";

/**
 * Tables that have a `company_id` column but are deliberately NOT covered,
 * each for a reason that a blanket policy would break. Keep this list short
 * and keep the reasons concrete -- an entry here is a documented hole in the
 * backstop, so it should be justified by a real cross-tenant-by-design
 * access pattern, not by "this one was awkward".
 */
export const RLS_EXEMPT_TENANT_TABLES: ReadonlyMap<string, string> = new Map([
  [
    "cli_auth_challenges",
    // Scoping column is `requested_company_id`, and rows are written and read
    // during the pre-authentication CLI device handshake -- before any trusted
    // company is known, so there is nothing to bind the session variable to.
    // Covering this table would break `paperclip login`.
    "pre-auth device handshake; requested_company_id is a request, not an established tenant scope",
  ],
  [
    "company_skills",
    // `sharing_scope` may be `public_link`, which is read cross-company by
    // design. A company_id policy would break public skill links for any
    // reader who happens to be signed into a different company.
    "sharing_scope=public_link is a cross-company read path by design",
  ],
  [
    "company_skill_versions",
    "child of company_skills; shares its cross-company public_link read path",
  ],
  [
    "company_skill_stars",
    "child of company_skills; shares its cross-company public_link read path",
  ],
  [
    "company_skill_comments",
    "child of company_skills; shares its cross-company public_link read path",
  ],
]);

/**
 * A table covered by the tenant-isolation policy.
 *
 * `nullableScope` tables (`plugin_entities`, `plugin_logs`, ...) legitimately
 * store instance-level rows with a NULL `company_id`. Their policy admits
 * `company_id IS NULL` so those rows stay visible; the tenant-scoped rows in
 * the same table are still isolated from each other, which is the case
 * TECH-6955 actually found being exploited.
 */
export type RlsTarget = {
  readonly table: string;
  readonly column: string;
  readonly nullableScope: boolean;
};

function tenantScopeColumn(table: PgTable) {
  const config = getTableConfig(table);
  return config.columns.find((column) => column.name === TENANT_SCOPE_COLUMN);
}

/**
 * Derives the RLS target list from the Drizzle schema rather than from a
 * hand-maintained constant, so a newly added tenant-scoped table shows up
 * here the moment it is declared. The boot assertion compares this list
 * against live `pg_policies`, which means "upstream added a company_id table
 * and we never wrote a policy for it" fails at startup instead of becoming a
 * silent hole.
 */
export function listRlsTargets(): RlsTarget[] {
  const targets: RlsTarget[] = [];

  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const config = getTableConfig(exported);
    // Only the default `public` schema is covered here. Plugin tables live in
    // per-plugin namespaces and carry their own policies in their own plugin
    // migrations (see plugin-rh-agent-memory/migrations/002_*).
    if (config.schema !== undefined) continue;
    if (RLS_EXEMPT_TENANT_TABLES.has(config.name)) continue;

    const column = tenantScopeColumn(exported);
    if (!column) continue;

    targets.push({
      table: config.name,
      column: column.name,
      nullableScope: !column.notNull && !column.primary,
    });
  }

  return targets.sort((left, right) => left.table.localeCompare(right.table));
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier for RLS policy: ${value}`);
  }
  return `"${value}"`;
}

/**
 * The shared predicate, as SQL text. `nullif(..., '')` collapses both "never
 * set" and "set to empty string" into NULL so a single IS NULL test covers
 * both; without it an empty-string setting would reach `::uuid` and raise
 * `invalid input syntax for type uuid` on every row.
 *
 * `current_setting(..., true)` (missing_ok) is required -- the two-argument
 * form returns NULL for an undefined setting, while the one-argument form
 * raises, which would turn every query on an un-bound connection into an
 * error instead of a pass-through.
 */
export function tenantPredicateSql(target: RlsTarget): string {
  const column = quoteIdentifier(target.column);
  const setting = `nullif(current_setting('${TENANT_COMPANY_SETTING}', true), '')`;
  const clauses = [
    `${setting} IS NULL`,
    ...(target.nullableScope ? [`${column} IS NULL`] : []),
    `${column} = ${setting}::uuid`,
  ];
  return clauses.join(" OR ");
}

/**
 * DDL for one table. Every statement is idempotent (`ENABLE`/`FORCE` are
 * no-ops when already set, and the policy is dropped by name before being
 * recreated) so re-running the migration -- or running it against a database
 * that a previous partial deploy already touched -- cannot fail.
 */
export function renderTenantIsolationDdl(target: RlsTarget): string[] {
  const table = quoteIdentifier(target.table);
  const policy = quoteIdentifier(TENANT_ISOLATION_POLICY);
  const predicate = tenantPredicateSql(target);
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${policy} ON ${table};`,
    `CREATE POLICY ${policy} ON ${table} FOR ALL USING (${predicate}) WITH CHECK (${predicate});`,
  ];
}

/** Full migration body for every covered table, in the drizzle statement format. */
export function renderTenantIsolationMigration(targets: RlsTarget[] = listRlsTargets()): string {
  const chunks = targets.map((target) => renderTenantIsolationDdl(target).join("\n"));
  return `${chunks.join("\n--> statement-breakpoint\n")}\n`;
}

/** Minimal `postgres`-like executor, so callers can pass a raw client or a pool. */
export type RlsSqlExecutor = {
  unsafe<T = Record<string, unknown>>(query: string): Promise<T[]> | PromiseLike<T[]>;
};

export type RlsRoleDescription = {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
};

/**
 * Reports whether the connected role can see through RLS regardless of any
 * table's policies. Superusers and BYPASSRLS roles always can, and no
 * table-level setting overrides that -- so this is the difference between the
 * backstop being real and being decorative.
 */
export async function describeRlsRole(sql: RlsSqlExecutor): Promise<RlsRoleDescription> {
  const rows = await sql.unsafe<{
    role: string;
    superuser: boolean;
    bypass_rls: boolean;
  }>(
    `SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypass_rls
       FROM pg_roles WHERE rolname = current_user`,
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Could not resolve the current role from pg_roles");
  }
  return { role: row.role, superuser: row.superuser, bypassRls: row.bypass_rls };
}

export type RlsPolicyProblem =
  | { kind: "missing-table"; table: string }
  | { kind: "rls-disabled"; table: string }
  | { kind: "rls-not-forced"; table: string }
  | { kind: "missing-policy"; table: string }
  | { kind: "policy-predicate-mismatch"; table: string; expectedSetting: string };

export type RlsVerificationResult = {
  readonly checkedTables: number;
  readonly problems: readonly RlsPolicyProblem[];
  readonly role: RlsRoleDescription;
};

type PolicyRow = {
  table_name: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  policy_name: string | null;
  qual: string | null;
  with_check: string | null;
};

/**
 * Introspects live `pg_class` / `pg_policy` state and reports every covered
 * table whose isolation is not actually in force.
 *
 * `missing-table` is reported rather than ignored: a covered table absent
 * from the database means the schema and this list have diverged, which is
 * the same class of problem as a dropped policy.
 */
export async function verifyTenantIsolationPolicies(
  sql: RlsSqlExecutor,
  targets: RlsTarget[] = listRlsTargets(),
): Promise<RlsVerificationResult> {
  const role = await describeRlsRole(sql);
  const rows = await sql.unsafe<PolicyRow>(
    `SELECT c.relname       AS table_name,
            c.relrowsecurity,
            c.relforcerowsecurity,
            p.polname       AS policy_name,
            pg_get_expr(p.polqual, p.polrelid)      AS qual,
            pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_policy p
              ON p.polrelid = c.oid
             AND p.polname = '${TENANT_ISOLATION_POLICY}'
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'`,
  );

  const byTable = new Map(rows.map((row) => [row.table_name, row]));
  const problems: RlsPolicyProblem[] = [];

  for (const target of targets) {
    const row = byTable.get(target.table);
    if (!row) {
      problems.push({ kind: "missing-table", table: target.table });
      continue;
    }
    if (!row.relrowsecurity) {
      problems.push({ kind: "rls-disabled", table: target.table });
      continue;
    }
    if (!row.relforcerowsecurity) {
      // Without FORCE the policy exists but never applies to the table
      // owner -- which is the role Paperclip connects as. Reporting this
      // separately from "disabled" matters because the failure is invisible:
      // pg_policies would show the policy present and correct.
      problems.push({ kind: "rls-not-forced", table: target.table });
    }
    if (!row.policy_name) {
      problems.push({ kind: "missing-policy", table: target.table });
      continue;
    }
    // Postgres rewrites the predicate, so an exact text match is not
    // available. Asserting the setting name appears in both clauses catches
    // the realistic failure -- a policy replaced by something that does not
    // consult the session variable at all -- without coupling the check to
    // Postgres's expression-rendering details.
    const mentionsSetting =
      (row.qual ?? "").includes(TENANT_COMPANY_SETTING) &&
      (row.with_check ?? "").includes(TENANT_COMPANY_SETTING);
    if (!mentionsSetting) {
      problems.push({
        kind: "policy-predicate-mismatch",
        table: target.table,
        expectedSetting: TENANT_COMPANY_SETTING,
      });
    }
  }

  return { checkedTables: targets.length, problems, role };
}

export function formatRlsProblems(problems: readonly RlsPolicyProblem[]): string {
  const describe = (problem: RlsPolicyProblem): string => {
    switch (problem.kind) {
      case "missing-table":
        return `${problem.table}: table is missing from the database`;
      case "rls-disabled":
        return `${problem.table}: ROW LEVEL SECURITY is not enabled`;
      case "rls-not-forced":
        return `${problem.table}: ROW LEVEL SECURITY is not FORCEd (policies do not apply to the table owner)`;
      case "missing-policy":
        return `${problem.table}: policy "${TENANT_ISOLATION_POLICY}" does not exist`;
      case "policy-predicate-mismatch":
        return `${problem.table}: policy "${TENANT_ISOLATION_POLICY}" does not reference ${problem.expectedSetting}`;
    }
  };
  return problems.map(describe).join("; ");
}
