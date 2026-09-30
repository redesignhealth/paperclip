/**
 * TECH-6956: binding the ambient tenant into the database session.
 *
 * `rls.ts` defines the policies, `tenant-context.ts` carries the verified
 * company id through the request. This module is the join: it turns an
 * ambient company id into a real `app.current_company_id` setting on the
 * connection a query is about to run on.
 *
 * ## Why this has to be a transaction
 *
 * Paperclip talks to Postgres through one shared postgres.js pool
 * (`createDb`), in autocommit -- consecutive queries are not guaranteed to
 * land on the same backend connection. A session variable set by one query
 * would therefore apply to an arbitrary, unrelated later query, which is
 * worse than not setting it at all.
 *
 * A transaction is the only construct that pins a sequence of statements to
 * one connection, so `set_config(..., is_local => true)` inside a transaction
 * is both correctly scoped and automatically unwound at COMMIT/ROLLBACK. That
 * matters more than the tidiness: a leaked setting on a pooled connection
 * would silently filter a *later* request's queries to the wrong company.
 *
 * `set_config(name, value, true)` is used rather than `SET LOCAL <name> =
 * <value>` because `SET LOCAL` takes no bind parameters -- the value would
 * have to be interpolated into SQL text.
 */

import { sql as sqlTag } from "drizzle-orm";
import { TENANT_COMPANY_SETTING } from "./rls.js";
import { getAmbientCompanyId } from "./tenant-context.js";

/**
 * Minimal shape of a drizzle transaction/database handle: enough to issue the
 * `set_config` call. Kept structural so this module does not have to import
 * the concrete `Db` type from `client.ts`, which imports this one.
 */
export type CompanyScopeExecutor = {
  execute(query: ReturnType<typeof sqlTag>): Promise<unknown>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `value` can be bound into `app.current_company_id` safely.
 *
 * The RLS predicate casts the setting to `uuid`. A non-uuid value would
 * therefore make *every* query against *every* covered table fail with
 * `invalid input syntax for type uuid` -- turning a malformed company id
 * somewhere upstream into a total outage rather than a scoped failure. So a
 * value that is not a uuid is refused here, before it can reach the session.
 */
export function isBindableCompanyId(value: string | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Issues the `set_config` for `companyId` on `executor`'s connection. */
export async function bindCompanyScope(
  executor: CompanyScopeExecutor,
  companyId: string,
): Promise<void> {
  if (!isBindableCompanyId(companyId)) {
    throw new Error(`Refusing to bind a non-uuid company id into ${TENANT_COMPANY_SETTING}`);
  }
  await executor.execute(
    sqlTag`select set_config(${TENANT_COMPANY_SETTING}, ${companyId}, true)`,
  );
}

/**
 * Binds the ambient company id, if there is a usable one.
 *
 * Returns the id that was bound, or undefined when the statement was skipped
 * -- which happens for non-request code paths (no ambient context), for
 * requests that legitimately span tenants (see `tenant-context.ts`), and for
 * a malformed id. In every skip case the policies' "setting is unset"
 * disjunct takes over and behavior is unchanged from before RLS existed.
 */
export async function bindAmbientCompanyScope(
  executor: CompanyScopeExecutor,
): Promise<string | undefined> {
  const companyId = getAmbientCompanyId();
  if (!isBindableCompanyId(companyId)) return undefined;
  await bindCompanyScope(executor, companyId);
  return companyId;
}

/**
 * Minimal shape of a handle that can open a transaction.
 *
 * Structural rather than the concrete drizzle `Db` for the same
 * import-cycle reason as `CompanyScopeExecutor`.
 */
export type CompanyScopeTransactor<TTx extends CompanyScopeExecutor> = {
  transaction<T>(fn: (tx: TTx) => Promise<T>): Promise<T>;
};

/**
 * Runs `fn` in a transaction whose session is scoped to `companyId`, so every
 * statement inside it is filtered by the `tenant_isolation` policies.
 *
 * This is the sanctioned primitive for any code path that wants hard
 * database-level tenant isolation regardless of whether its own queries
 * remembered to filter on `company_id`. Unlike the ambient auto-binding in
 * `createDb`, this is explicit and does not depend on an
 * `assertCompanyAccess` call having established context first -- use it for
 * worker and plugin-host entry points, which have no HTTP request to inherit
 * context from.
 */
export async function withCompanyScope<TTx extends CompanyScopeExecutor, T>(
  db: CompanyScopeTransactor<TTx>,
  companyId: string,
  fn: (tx: TTx) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await bindCompanyScope(tx, companyId);
    return await fn(tx);
  });
}
