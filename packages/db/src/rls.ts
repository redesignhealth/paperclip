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

/** Name of the per-table policy this module manages for non-nullableScope tables. */
export const TENANT_ISOLATION_POLICY = "tenant_isolation";

/**
 * TECH-6956 round 2 (Argus, real privilege escalation): a `nullableScope`
 * table cannot use a single `FOR ALL` policy the way every other covered
 * table does. `FOR ALL`'s `USING` clause governs SELECT *and* the row-
 * targeting half of UPDATE/DELETE (which row does the command even get to
 * touch), and that clause must admit `company_id IS NULL` for reads (an
 * instance-level row is legitimately visible to every scoped tenant). But
 * admitting it for UPDATE/DELETE targeting means a session scoped to a real
 * company could target -- and delete, or blank-overwrite -- an existing
 * instance-level row (a bootstrap CEO invite token, an instance-level plugin
 * log row, ...), even though `WITH CHECK` (round 1's fix) correctly blocks
 * writing a *new* null-company row.
 *
 * So `nullableScope` tables get four command-specific policies instead of one
 * `FOR ALL` policy:
 *  - `..._select`: `USING` only, permissive (admits NULL) -- read visibility
 *    is unchanged from before.
 *  - `..._insert`: `WITH CHECK` only, strict (no NULL) -- unchanged from
 *    round 1's fix.
 *  - `..._update`: BOTH `USING` and `WITH CHECK` strict (no NULL) -- a scoped
 *    session may neither target nor write a null-company row via UPDATE.
 *  - `..._delete`: `USING` only, strict (no NULL) -- a scoped session may not
 *    target a null-company row via DELETE.
 *
 * Non-nullableScope tables keep the single `FOR ALL` policy: their `USING`
 * and `WITH CHECK` predicates were already identical (there is no
 * `company_id IS NULL` disjunct to split), so a command-specific split would
 * add policies with zero behavioral difference.
 */
export const NULLABLE_SCOPE_POLICY_NAMES = {
  select: "tenant_isolation_select",
  insert: "tenant_isolation_insert",
  update: "tenant_isolation_update",
  delete: "tenant_isolation_delete",
} as const;

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
  // `company_skills` and its children were previously exempted here for a
  // `sharing_scope=public_link` cross-company read path. Argus (TECH-6956
  // round 1) found that `normalizeMutableSharingScope` already rejects
  // `public_link` outright -- the justification does not correspond to any
  // currently-reachable code path, so the exemption was leaving these tables
  // with zero RLS protection for a feature that is not live. Removed; they
  // now get the standard tenant_isolation policy like every other covered
  // table. If `public_link` sharing is ever reintroduced, it needs its own
  // cross-company-safe design (e.g. a dedicated read path that runs
  // unscoped/service-role rather than a blanket RLS exemption), not a
  // reinstated entry here.
]);

/**
 * Explicit allowlist of tables that legitimately store instance-level rows
 * with a NULL `company_id` alongside tenant-scoped rows.
 *
 * TECH-6956 round 1: originally this was derived purely from whether the
 * Drizzle column was nullable (`!column.notNull`), which Argus flagged as
 * risky -- a column can be nullable for reasons that have nothing to do with
 * an intentional instance-level-row design (a migration that added the
 * column without backfilling it yet, a column nullable during a phased
 * rollout, etc.), and every one of those would silently and permissively
 * admit `company_id IS NULL` rows into a table that was never meant to have
 * any. An explicit allowlist means a new nullable `company_id` column defaults
 * to being treated as *not* nullableScope (a real instance-level row would
 * then fail its NOT enforced isolation loudly -- no such rows would exist
 * without deliberately adding the table here), which is the safer failure
 * direction for a security backstop.
 *
 * `listRlsTargets()` still cross-checks this list against the live schema at
 * derivation time and throws on drift in either direction, so this cannot
 * silently fall out of sync with the actual nullability of the column.
 */
export const NULLABLE_SCOPE_TABLES: ReadonlySet<string> = new Set([
  "invites",
  "plugin_entities",
  "plugin_job_runs",
  "plugin_logs",
  "plugin_webhook_deliveries",
  // Added during the v2026.916.1 resync (TECH-6952): company_transfer_runs is
  // new upstream (post-dates this RLS patch's original schema). Its
  // company_id is null while an import targeting a not-yet-created company
  // has not created the destination company row yet -- a genuine
  // instance-level row during that window, not a nullability oversight.
  "company_transfer_runs",
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

    const columnIsNullable = !column.notNull && !column.primary;
    const isAllowlistedNullableScope = NULLABLE_SCOPE_TABLES.has(config.name);
    // Drift in either direction is a real hole: a table added to the
    // allowlist whose column is actually NOT NULL would render a policy that
    // never matches its `IS NULL` disjunct (harmless but wrong), while a
    // nullable column on a table NOT in the allowlist means real
    // instance-level rows exist and would get NO write predicate covering
    // them at all under the fixed WITH CHECK clause below -- so this fails
    // loudly instead of silently misclassifying either way.
    if (isAllowlistedNullableScope && !columnIsNullable) {
      throw new Error(
        `RLS: "${config.name}" is in NULLABLE_SCOPE_TABLES but its "${column.name}" column is NOT NULL. ` +
          "Remove it from the allowlist or fix the schema.",
      );
    }
    if (!isAllowlistedNullableScope && columnIsNullable) {
      throw new Error(
        `RLS: "${config.name}"."${column.name}" is nullable but the table is not in NULLABLE_SCOPE_TABLES. ` +
          "Add it to the allowlist if instance-level (company_id IS NULL) rows are intentional, " +
          "or make the column NOT NULL if they are not.",
      );
    }

    targets.push({
      table: config.name,
      column: column.name,
      nullableScope: isAllowlistedNullableScope,
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
 * The shared base predicate, as SQL text. `nullif(..., '')` collapses both
 * "never set" and "set to empty string" into NULL so a single IS NULL test
 * covers both; without it an empty-string setting would reach `::uuid` and
 * raise `invalid input syntax for type uuid` on every row.
 *
 * `current_setting(..., true)` (missing_ok) is required -- the two-argument
 * form returns NULL for an undefined setting, while the one-argument form
 * raises, which would turn every query on an un-bound connection into an
 * error instead of a pass-through.
 *
 * This is deliberately the SAME for every table's `USING` clause (read
 * visibility): an unset setting passes everything through, and for
 * `nullableScope` tables a `company_id IS NULL` row is visible regardless of
 * which company is bound, because instance-level rows are meant to be
 * readable by any scoped request. See `tenantCheckPredicateSql` below for why
 * `WITH CHECK` (write validation) is a DIFFERENT, narrower predicate for those
 * tables.
 */
export function tenantUsingPredicateSql(target: RlsTarget): string {
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
 * The `WITH CHECK` predicate (write validation).
 *
 * TECH-6956 round 1 (Argus, real privilege escalation): for `nullableScope`
 * tables this used to be IDENTICAL to the `USING` predicate above, which is
 * correct for reads but wrong for writes -- it let a request that IS scoped
 * to a real company (`app.current_company_id` set) still INSERT/UPDATE a row
 * with `company_id IS NULL`, i.e. detach a row from its own company into the
 * unscoped instance-level pool (or, per Argus, plant/tamper with rows like
 * bootstrap CEO invite tokens in `invites` that a real cross-tenant write
 * should never be able to reach).
 *
 * So `WITH CHECK` is deliberately narrower than `USING` and does NOT admit
 * the `company_id IS NULL` disjunct: whenever the setting IS bound, a write
 * must match that company exactly, full stop. The `company_id IS NULL`
 * branch only ever helps a WRITE when the setting itself is unset (a
 * non-request code path, e.g. an instance-admin backfill), which the leading
 * "setting is unset" disjunct already covers.
 */
export function tenantCheckPredicateSql(target: RlsTarget): string {
  const column = quoteIdentifier(target.column);
  const setting = `nullif(current_setting('${TENANT_COMPANY_SETTING}', true), '')`;
  return [`${setting} IS NULL`, `${column} = ${setting}::uuid`].join(" OR ");
}

/**
 * DDL for one table. Every statement is idempotent (`ENABLE`/`FORCE` are
 * no-ops when already set, and each policy is dropped by name before being
 * recreated) so re-running the migration -- or running it against a database
 * that a previous partial deploy already touched -- cannot fail.
 *
 * Non-nullableScope tables get the original single `FOR ALL` policy.
 * `nullableScope` tables get four command-specific policies -- see
 * `NULLABLE_SCOPE_POLICY_NAMES`'s docstring for why a single `FOR ALL` policy
 * is unsafe for them.
 */
export function renderTenantIsolationDdl(target: RlsTarget): string[] {
  const table = quoteIdentifier(target.table);
  const usingPredicate = tenantUsingPredicateSql(target);
  const checkPredicate = tenantCheckPredicateSql(target);
  const enableAndForce = [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
  ];

  if (!target.nullableScope) {
    const policy = quoteIdentifier(TENANT_ISOLATION_POLICY);
    return [
      ...enableAndForce,
      `DROP POLICY IF EXISTS ${policy} ON ${table};`,
      `CREATE POLICY ${policy} ON ${table} FOR ALL USING (${usingPredicate}) WITH CHECK (${checkPredicate});`,
    ];
  }

  const legacyPolicy = quoteIdentifier(TENANT_ISOLATION_POLICY);
  const selectPolicy = quoteIdentifier(NULLABLE_SCOPE_POLICY_NAMES.select);
  const insertPolicy = quoteIdentifier(NULLABLE_SCOPE_POLICY_NAMES.insert);
  const updatePolicy = quoteIdentifier(NULLABLE_SCOPE_POLICY_NAMES.update);
  const deletePolicy = quoteIdentifier(NULLABLE_SCOPE_POLICY_NAMES.delete);
  return [
    ...enableAndForce,
    // Drop the old single FOR ALL policy name too: if a previous partial
    // deploy of this table ever created it under that name, leaving it in
    // place alongside the new command-specific policies would mean its
    // permissive USING clause still governs UPDATE/DELETE targeting via
    // Postgres's "any matching permissive policy passes" semantics --
    // silently defeating this fix.
    `DROP POLICY IF EXISTS ${legacyPolicy} ON ${table};`,
    `DROP POLICY IF EXISTS ${selectPolicy} ON ${table};`,
    `CREATE POLICY ${selectPolicy} ON ${table} FOR SELECT USING (${usingPredicate});`,
    `DROP POLICY IF EXISTS ${insertPolicy} ON ${table};`,
    `CREATE POLICY ${insertPolicy} ON ${table} FOR INSERT WITH CHECK (${checkPredicate});`,
    `DROP POLICY IF EXISTS ${updatePolicy} ON ${table};`,
    `CREATE POLICY ${updatePolicy} ON ${table} FOR UPDATE USING (${checkPredicate}) WITH CHECK (${checkPredicate});`,
    `DROP POLICY IF EXISTS ${deletePolicy} ON ${table};`,
    `CREATE POLICY ${deletePolicy} ON ${table} FOR DELETE USING (${checkPredicate});`,
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
 *
 * The query is not filtered to a single policy name because `nullableScope`
 * tables carry four (see `NULLABLE_SCOPE_POLICY_NAMES`); every policy on a
 * covered table is fetched and then matched against the expected name(s) in
 * application code below.
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
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'`,
  );

  const rowsByTable = new Map<string, PolicyRow[]>();
  for (const row of rows) {
    const existing = rowsByTable.get(row.table_name);
    if (existing) {
      existing.push(row);
    } else {
      rowsByTable.set(row.table_name, [row]);
    }
  }

  const mentionsSetting = (clause: string | null): boolean =>
    (clause ?? "").includes(TENANT_COMPANY_SETTING);

  const problems: RlsPolicyProblem[] = [];

  for (const target of targets) {
    const tableRows = rowsByTable.get(target.table);
    if (!tableRows || tableRows.length === 0) {
      problems.push({ kind: "missing-table", table: target.table });
      continue;
    }

    const [first] = tableRows;
    if (!first) {
      problems.push({ kind: "missing-table", table: target.table });
      continue;
    }
    if (!first.relrowsecurity) {
      problems.push({ kind: "rls-disabled", table: target.table });
      continue;
    }
    if (!first.relforcerowsecurity) {
      // Without FORCE the policy exists but never applies to the table
      // owner -- which is the role Paperclip connects as. Reporting this
      // separately from "disabled" matters because the failure is invisible:
      // pg_policies would show the policy present and correct.
      problems.push({ kind: "rls-not-forced", table: target.table });
    }

    const policies = tableRows.filter(
      (row): row is PolicyRow & { policy_name: string } => row.policy_name !== null,
    );

    if (!target.nullableScope) {
      const policy = policies.find((row) => row.policy_name === TENANT_ISOLATION_POLICY);
      if (!policy) {
        problems.push({ kind: "missing-policy", table: target.table });
        continue;
      }
      // Postgres rewrites the predicate, so an exact text match is not
      // available. Asserting the setting name appears in both clauses catches
      // the realistic failure -- a policy replaced by something that does not
      // consult the session variable at all -- without coupling the check to
      // Postgres's expression-rendering details.
      if (!mentionsSetting(policy.qual) || !mentionsSetting(policy.with_check)) {
        problems.push({
          kind: "policy-predicate-mismatch",
          table: target.table,
          expectedSetting: TENANT_COMPANY_SETTING,
        });
      }
      continue;
    }

    // nullableScope: four command-specific policies must all be present, and
    // each must consult the session variable in whichever clause(s) it
    // actually has (SELECT/DELETE only have USING, INSERT only has WITH
    // CHECK, UPDATE has both).
    const byName = new Map(policies.map((row) => [row.policy_name, row]));
    const selectPolicy = byName.get(NULLABLE_SCOPE_POLICY_NAMES.select);
    const insertPolicy = byName.get(NULLABLE_SCOPE_POLICY_NAMES.insert);
    const updatePolicy = byName.get(NULLABLE_SCOPE_POLICY_NAMES.update);
    const deletePolicy = byName.get(NULLABLE_SCOPE_POLICY_NAMES.delete);

    if (!selectPolicy || !insertPolicy || !updatePolicy || !deletePolicy) {
      problems.push({ kind: "missing-policy", table: target.table });
      continue;
    }

    const allMentionSetting =
      mentionsSetting(selectPolicy.qual) &&
      mentionsSetting(insertPolicy.with_check) &&
      mentionsSetting(updatePolicy.qual) &&
      mentionsSetting(updatePolicy.with_check) &&
      mentionsSetting(deletePolicy.qual);
    if (!allMentionSetting) {
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
