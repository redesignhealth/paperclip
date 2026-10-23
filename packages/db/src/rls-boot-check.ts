/**
 * TECH-6956: boot-time assertion that the RLS backstop is actually in force.
 *
 * The ECS task definition sets `PAPERCLIP_MIGRATION_AUTO_APPLY=true`, so
 * migrations apply silently at container boot. That is convenient and it is
 * also the failure mode this check exists for: if a future upstream rebase
 * drops or renumbers `0288_tenant_isolation_rls.sql`, nothing anywhere would
 * complain. The isolation backstop would simply stop existing, and the only
 * symptom would be the next cross-tenant CVE landing unmitigated.
 *
 * So the server refuses to start instead. This runs after migrations and
 * before any HTTP surface exists, alongside `assertCloudDatabaseContract()`
 * -- the existing precedent for a boot-time fail-fast contract check in
 * server/src/index.ts.
 *
 * It also catches the inverse drift: a table that gained a `company_id`
 * column upstream, is therefore in the schema-derived target list, but has no
 * policy in the database. That is a brand-new uncovered tenant table, which
 * is exactly as much of a hole as a dropped migration, and equally invisible
 * without this check.
 */

import postgres from "postgres";
import {
  formatRlsProblems,
  verifyTenantIsolationPolicies,
  type RlsVerificationResult,
} from "./rls.js";

export type RlsBootCheckMode = "error" | "warn" | "off";

export type RlsBootCheckLogger = {
  info: (obj: Record<string, unknown>, message: string) => void;
  warn: (obj: Record<string, unknown>, message: string) => void;
};

/**
 * How a failed check behaves.
 *
 * Defaults to `error` for authenticated public deployments -- the
 * multi-tenant, internet-exposed configuration where losing tenant isolation
 * is a security incident -- and to `warn` everywhere else, so a developer's
 * single-tenant local instance on a partially-migrated database is an
 * annoyance rather than a brick.
 *
 * `PAPERCLIP_RLS_BOOT_CHECK` overrides it. The escape hatch is deliberate:
 * an operator mid-incident needs to be able to boot a server whose RLS state
 * is wrong, and a check with no override gets deleted the first time it
 * blocks a deploy.
 */
export function resolveRlsBootCheckMode(
  env: NodeJS.ProcessEnv,
  isAuthenticatedPublicDeployment: boolean,
): RlsBootCheckMode {
  const configured = env.PAPERCLIP_RLS_BOOT_CHECK?.trim().toLowerCase();
  if (configured === "error" || configured === "warn" || configured === "off") return configured;
  if (configured !== undefined && configured !== "") {
    throw new Error(
      `PAPERCLIP_RLS_BOOT_CHECK must be one of "error", "warn", "off"; got: ${env.PAPERCLIP_RLS_BOOT_CHECK}`,
    );
  }
  return isAuthenticatedPublicDeployment ? "error" : "warn";
}

export type AssertRlsPoliciesOptions = {
  readonly mode: RlsBootCheckMode;
  readonly logger: RlsBootCheckLogger;
};

/**
 * Verifies live policy state against the schema-derived target list.
 *
 * Uses its own short-lived `max: 1` client rather than the app pool, matching
 * how the migration helpers in `client.ts` do their introspection: this runs
 * once at boot and should not occupy a pooled connection or inherit any
 * pool-level tuning.
 */
export async function assertRlsPoliciesInForce(
  connectionString: string,
  options: AssertRlsPoliciesOptions,
): Promise<RlsVerificationResult | null> {
  if (options.mode === "off") {
    options.logger.warn(
      { mode: options.mode },
      "Tenant-isolation RLS boot check is disabled; cross-tenant isolation has no database-level backstop.",
    );
    return null;
  }

  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  let result: RlsVerificationResult;
  try {
    result = await verifyTenantIsolationPolicies(sql);
  } finally {
    await sql.end();
  }

  // Reported regardless of whether any policy is missing, because a role that
  // bypasses RLS makes every policy decorative -- the tables look correct and
  // isolation still does not apply. Embedded Postgres runs as the initdb
  // bootstrap superuser, so this fires on every local instance by design; it
  // is a warning rather than a failure precisely so that stays true.
  if (result.role.superuser || result.role.bypassRls) {
    options.logger.warn(
      {
        role: result.role.role,
        superuser: result.role.superuser,
        bypassRls: result.role.bypassRls,
      },
      "Database role bypasses row-level security, so tenant-isolation policies do not apply to it. " +
        "Connect as a non-superuser role without BYPASSRLS for the RLS backstop to take effect.",
    );
  }

  if (result.problems.length === 0) {
    options.logger.info(
      { checkedTables: result.checkedTables, role: result.role.role },
      "Tenant-isolation RLS policies verified.",
    );
    return result;
  }

  const detail = formatRlsProblems(result.problems);
  const message =
    `Tenant-isolation RLS policies are not in force on ${result.problems.length} of ` +
    `${result.checkedTables} covered table(s): ${detail}. ` +
    "Run pnpm db:migrate (migration 0288_tenant_isolation_rls), or set " +
    "PAPERCLIP_RLS_BOOT_CHECK=warn to start anyway without a database-level tenant-isolation backstop.";

  if (options.mode === "warn") {
    options.logger.warn({ problems: result.problems }, message);
    return result;
  }

  throw new Error(message);
}
