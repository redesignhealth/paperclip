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

import { AsyncLocalStorage } from "node:async_hooks";
import { sql as sqlTag } from "drizzle-orm";
import { TENANT_COMPANY_SETTING } from "./rls.js";
import { getAmbientCompanyId } from "./tenant-context.js";

/**
 * TECH-6956 round 1 (Argus): malformed company ids and multi-company
 * conflicts previously failed completely silently -- the request proceeded
 * unscoped with no log line at all, so production telemetry had no way to
 * distinguish "normal unscoped operation" (a background job, the CLI) from
 * "tenant binding silently broke" (a bug upstream produced a non-uuid or two
 * different company ids for one request).
 *
 * This does not change the fail-OPEN behavior -- see `tenant-context.ts` for
 * why dropping scope is the deliberate, safer trade here -- it only makes the
 * drop observable. `packages/db` has no shared structured-logging dependency
 * (see `rls-boot-check.ts` for the same constraint, solved there by an
 * injected logger); this module is called from far more call sites than the
 * boot check, so rather than threading a logger through every
 * `bindCompanyScope`/`bindAmbientCompanyScope` call, it logs directly via
 * `console`, matching every other `packages/db` module that logs at all
 * (`migrate.ts`, `seed.ts`, `backup.ts`).
 */
const companyScopeLogger = {
  warn(event: string, detail: Record<string, unknown>, message: string): void {
    console.warn(`[rls:company-scope] ${event}: ${message}`, detail);
  },
  debug(event: string, detail: Record<string, unknown>, message: string): void {
    if (process.env.PAPERCLIP_RLS_DEBUG_LOG !== "1") return;
    console.debug(`[rls:company-scope] ${event}: ${message}`, detail);
  },
};

/**
 * Minimal shape of a drizzle transaction/database handle: enough to issue the
 * `set_config` call. Kept structural so this module does not have to import
 * the concrete `Db` type from `client.ts`, which imports this one.
 */
export type CompanyScopeExecutor = {
  execute(query: ReturnType<typeof sqlTag>): Promise<unknown>;
};

/**
 * A `CompanyScopeExecutor` that can also open a nested transaction on its own
 * connection -- a real Postgres `SAVEPOINT`, not a fresh top-level
 * transaction. Every concrete drizzle transaction handle satisfies this
 * (postgres-js's `PgTransaction.transaction()` issues `SAVEPOINT` /
 * `RELEASE`/`ROLLBACK TO SAVEPOINT` under the hood).
 *
 * `withCompanyScope`'s nested-reuse path needs this, not just `execute`:
 * calling `fn` directly against the enclosing call's `tx` would leave the
 * *outer* transaction's connection aborted if `fn` throws a Postgres error
 * that its caller catches and wants to recover from (e.g. a
 * unique-constraint violation handled gracefully) -- Postgres requires a
 * `ROLLBACK` after such an error before the connection accepts further
 * statements, and without a savepoint that `ROLLBACK` takes out the entire
 * outer transaction, not just the nested call's own work.
 */
export type NestableCompanyScopeExecutor = CompanyScopeExecutor & {
  transaction<T>(fn: (tx: NestableCompanyScopeExecutor) => Promise<T>): Promise<T>;
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
 * because there is no ambient context at all -- the normal, safe default for
 * non-request code paths (CLI, migrations, schedulers) and for requests that
 * legitimately span tenants (see `tenant-context.ts`). In that case the
 * policies' "setting is unset" disjunct takes over and behavior is unchanged
 * from before RLS existed.
 *
 * A *malformed* ambient company id is different and does not get the same
 * treatment: a context WAS established (something upstream believes this
 * transaction should be scoped), so there is no safe default to fall back to
 * -- unscoped would silently grant full cross-tenant access for whatever bug
 * produced the bad value. This throws instead of degrading.
 */
export async function bindAmbientCompanyScope(
  executor: CompanyScopeExecutor,
): Promise<string | undefined> {
  const companyId = getAmbientCompanyId();
  if (companyId === undefined) return undefined;
  if (!isBindableCompanyId(companyId)) {
    // Runtime value, not just a non-uuid string: `TenantContext.companyId` is
    // typed `string`, but nothing enforces that at the `setAmbientCompanyId`
    // boundary, so guard the shape before touching `.length` rather than
    // trusting the type.
    const companyIdValue: unknown = companyId;
    const malformedLength = typeof companyIdValue === "string" ? companyIdValue.length : undefined;
    companyScopeLogger.warn(
      "malformed-company-id",
      { companyIdLength: malformedLength },
      "Ambient company id is not a uuid; refusing to run this transaction " +
        "(fail-closed -- a scoped context was established, so unscoped is not a safe default).",
    );
    throw new Error(
      "Refusing to bind a malformed ambient company id: a tenant context was established for " +
        `this transaction but its value is not a uuid, so RLS cannot treat it as either "this ` +
        'company" or "no company".',
    );
  }
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
 * Tracks the company id AND the already-scoped transaction handle, if any,
 * that an enclosing `withCompanyScope` call established in the current async
 * call chain.
 *
 * `set_config(..., is_local => true)` is scoped to the current *transaction*,
 * not to a savepoint independently -- nesting `withCompanyScope` by passing an
 * already-scoped `tx` back in as the next call's `db` would open a savepoint
 * and re-issue `set_config` on a connection that is already bound, which is at
 * best redundant and at worst unclear about what a `ROLLBACK TO SAVEPOINT` in
 * the inner call restores the setting to.
 *
 * Storing the `tx` itself, not just the `companyId`, matters: a nested call
 * might receive the *unscoped root client* as its `db` argument rather than
 * the scoped `tx` (a caller forwarding the original handle instead of
 * threading the inner one through). Reusing that raw `db` would run the
 * "nested" work outside any transaction at all -- on postgres.js's shared
 * autocommit pool, unpinned from the connection `set_config` was issued on --
 * which is silent unscoped execution, not reuse. Reusing the stored `tx`
 * instead guarantees the nested call actually runs on the bound connection
 * regardless of what its own `db` argument was.
 */
const activeCompanyScope = new AsyncLocalStorage<{
  companyId: string;
  tx: NestableCompanyScopeExecutor;
}>();

/**
 * Marks `tx` as already scoped to `companyId` for the duration of `fn`, so a
 * `withCompanyScope` call nested inside `fn` reuses it instead of opening a
 * redundant nested transaction.
 *
 * This is the interop seam for binding mechanisms *other than*
 * `withCompanyScope` itself -- currently just `attachAmbientCompanyScope` in
 * `client.ts` -- that also want a nested `withCompanyScope` call to recognize
 * their binding rather than treating it as unscoped and opening its own
 * transaction underneath an already-scoped one.
 */
export async function runWithCompanyScopeTracked<T>(
  companyId: string,
  tx: NestableCompanyScopeExecutor,
  fn: () => Promise<T>,
): Promise<T> {
  return await activeCompanyScope.run({ companyId, tx }, fn);
}

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
 *
 * Nesting: if an enclosing `withCompanyScope` already scoped the current call
 * chain to the same `companyId`, this reuses the *enclosing call's own scoped
 * transaction handle* directly rather than opening a redundant nested
 * transaction/savepoint on whatever `db` this call happened to receive --
 * see `activeCompanyScope`'s doc comment for why that distinction matters.
 * Nesting with a *different* `companyId` is a caller bug (the inner call's
 * ambient expectations and the outer transaction's actual scope would
 * disagree), so it throws rather than silently re-binding or picking one.
 */
export async function withCompanyScope<TTx extends NestableCompanyScopeExecutor, T>(
  db: CompanyScopeTransactor<TTx>,
  companyId: string,
  fn: (tx: TTx) => Promise<T>,
): Promise<T> {
  const outer = activeCompanyScope.getStore();
  if (outer !== undefined) {
    if (outer.companyId !== companyId) {
      throw new Error(
        `withCompanyScope(${companyId}) called while already scoped to ${outer.companyId} in the ` +
          "same call chain. Nesting withCompanyScope for a different company is not supported -- " +
          "the outer transaction's session is already bound, so the inner call cannot safely " +
          "re-scope it. Pass the already-scoped transaction handle straight through instead of " +
          "wrapping it again.",
      );
    }
    // Reuse the enclosing call's own scoped connection, not this call's `db`
    // argument -- they are not guaranteed to be the same object, and only
    // the stored `tx` is actually bound to the right connection. Open a
    // SAVEPOINT on it rather than calling `fn` directly against `outer.tx`:
    // if `fn` throws a Postgres error its caller catches and handles, the
    // SAVEPOINT scopes the required ROLLBACK to just this nested call's
    // work, leaving the outer transaction itself still usable.
    //
    // Re-run `fn` under a FRESH `activeCompanyScope.run` bound to the new
    // savepoint's own tx, not the outer one still in scope from the caller.
    // Without this, a THIRD level of nesting inside `fn` would look up
    // `activeCompanyScope.getStore()` and see the original outer tx again
    // (ALS is unaffected by `outer.tx.transaction()` on its own), so it
    // would keep reusing that outer handle directly -- skipping past the
    // savepoint boundary this level just established and leaving a nested
    // error at the third level able to abort the second level's savepoint
    // scope, not just its own.
    return await outer.tx.transaction((tx) =>
      activeCompanyScope.run({ companyId, tx }, () => fn(tx as TTx)),
    );
  }
  return await db.transaction(async (tx) => {
    await bindCompanyScope(tx, companyId);
    return await activeCompanyScope.run({ companyId, tx }, () => fn(tx));
  });
}
