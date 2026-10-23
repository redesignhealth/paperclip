/**
 * TECH-6956: ambient tenant context for Postgres RLS.
 *
 * RLS policies (see `rls.ts`) read the trusted company id out of the
 * `app.current_company_id` session variable. Something has to put it there,
 * per request, from a value the request could not have forged. This module is
 * the carrier for that value between "the authorization layer just verified
 * which company this request may touch" and "a query is about to run".
 *
 * ## Why AsyncLocalStorage
 *
 * The obvious alternative -- thread a `companyId` parameter down through every
 * service and query call site -- is a several-thousand-line refactor across
 * ~170 tables' worth of services, and it would fail exactly where it matters:
 * a code path that forgets to pass the parameter is the same bug class RLS is
 * meant to backstop. An ambient context inverts that: a path that forgets to
 * *establish* scope falls back to unscoped behavior (no regression), while a
 * path that establishes it gets isolation whether or not its individual
 * queries know about it.
 *
 * ## Why a mutable holder rather than nested `run()` calls
 *
 * `assertCompanyAccess(req, companyId)` in `server/src/routes/authz.ts` is the
 * one place that already knows the verified company for a request -- but it is
 * synchronous, `void`-returning, and called from hundreds of handlers. It
 * cannot wrap the remainder of a handler in a `storage.run()` callback without
 * changing every one of those call sites.
 *
 * So the middleware establishes one mutable holder per request via `run()`,
 * and `setAmbientCompanyId()` writes into it. The holder object is created
 * fresh per request, so a value written during request A is invisible to
 * request B -- `AsyncLocalStorage` gives us that isolation for free, which is
 * the whole reason this is not just a module-level variable.
 *
 * ## The multi-company case, and why it fails open
 *
 * Board/user actors legitimately have access to several companies
 * (`req.actor.companyIds`), and a few admin paths touch more than one company
 * in a single request. If `setAmbientCompanyId()` is called twice with
 * different ids, the context is marked `conflicted` and the ambient company is
 * dropped for the rest of the request -- queries revert to unscoped, exactly
 * as they behave today.
 *
 * That is deliberately fail-OPEN, and it is the right trade for a
 * defense-in-depth layer being introduced under live traffic: the alternative
 * (pick one of the two companies and filter by it) would silently return wrong
 * results from a legitimate cross-company read, turning a security backstop
 * into a correctness bug. A dropped context means "no worse than before"; a
 * wrong context means "newly broken". Narrowing these paths so they scope
 * per-company is follow-up work, not a precondition.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * TECH-6956 round 1 (Argus): multi-company conflicts and the conflict
 * suppression that follows them used to fail completely silently, giving
 * production telemetry no way to tell "no ambient company established" apart
 * from "two different companies were established and the request's RLS
 * backstop just got dropped as a result". This does not change the fail-OPEN
 * behavior (see the module comment above for why that is deliberate); it only
 * makes the drop, and the deliberate `clearAmbientCompanyId()` opt-out,
 * observable. See `company-scope.ts` for why this logs via `console` rather
 * than an injected structured logger.
 */
const tenantContextLogger = {
  warn(event: string, detail: Record<string, unknown>, message: string): void {
    console.warn(`[rls:tenant-context] ${event}: ${message}`, detail);
  },
  debug(event: string, detail: Record<string, unknown>, message: string): void {
    if (process.env.PAPERCLIP_RLS_DEBUG_LOG !== "1") return;
    console.debug(`[rls:tenant-context] ${event}: ${message}`, detail);
  },
};

export type TenantContext = {
  /**
   * The verified company id to bind into `app.current_company_id`, or
   * undefined when no single company has been established (or the context
   * was conflicted, below).
   */
  companyId?: string;
  /**
   * Set once two different company ids have been established in the same
   * context. Latches: once conflicted, the context never yields an ambient
   * company again, so a later single-company call cannot re-narrow a request
   * that has already been observed touching several tenants.
   */
  conflicted?: boolean;
};

const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` with a fresh tenant context. Callers are the per-request
 * middleware and the plugin-host capability wrapper -- anything that
 * represents one unit of work belonging to (at most) one tenant.
 */
export function runWithTenantContext<T>(fn: () => T): T {
  return tenantContextStorage.run({}, fn);
}

/** The active context, or undefined outside any `runWithTenantContext`. */
export function getTenantContext(): TenantContext | undefined {
  return tenantContextStorage.getStore();
}

/**
 * Records a verified company id on the active context.
 *
 * Safe to call repeatedly with the same id (the common case: a handler that
 * calls `assertCompanyAccess` more than once for the same company). Calling
 * it with a second, different id conflicts the context -- see the module
 * comment for why that fails open.
 *
 * A no-op when there is no active context, so non-request code paths (CLI,
 * migrations, schedulers) need no special handling.
 */
export function setAmbientCompanyId(companyId: string): void {
  const context = tenantContextStorage.getStore();
  if (!context) return;
  if (context.conflicted) {
    // The context already dropped scope for a prior conflict (or an
    // explicit clearAmbientCompanyId()); a later single-company call cannot
    // re-narrow it. Distinct from the initial conflict below so a log search
    // can tell "the conflict happened here" from "a later call hit the
    // already-conflicted context".
    tenantContextLogger.warn(
      "conflict-suppressed",
      { companyId },
      "setAmbientCompanyId called again after this context was already conflicted/cleared; " +
        "ignoring -- the request remains unscoped.",
    );
    return;
  }
  if (context.companyId === undefined) {
    context.companyId = companyId;
    return;
  }
  if (context.companyId !== companyId) {
    tenantContextLogger.warn(
      "multi-company-conflict",
      { firstCompanyId: context.companyId, secondCompanyId: companyId },
      "setAmbientCompanyId called with a second, different company id in the same request; " +
        "dropping ambient tenant scope for the remainder of this request (fail-open by design).",
    );
    context.conflicted = true;
    context.companyId = undefined;
  }
}

/**
 * The company id to bind into the database session for the current unit of
 * work, or undefined when queries should run unscoped.
 */
export function getAmbientCompanyId(): string | undefined {
  const context = tenantContextStorage.getStore();
  if (!context || context.conflicted) return undefined;
  return context.companyId;
}

/**
 * Forces the active context to unscoped for the remainder of its lifetime.
 *
 * For code that knowingly spans tenants (an instance-admin sweep, a company
 * export/import) and wants to opt out explicitly rather than rely on the
 * conflict latch happening to fire.
 */
export function clearAmbientCompanyId(): void {
  const context = tenantContextStorage.getStore();
  if (!context) return;
  // Debug rather than warn: this is the INTENTIONAL cross-tenant opt-out, not
  // an accidental drop, so it should not read like the multi-company-conflict
  // warning above in log review. Off by default (see PAPERCLIP_RLS_DEBUG_LOG)
  // since a deliberate instance-admin sweep can call this often.
  tenantContextLogger.debug(
    "cleared-intentionally",
    { previousCompanyId: context.companyId },
    "clearAmbientCompanyId() called; tenant scope intentionally dropped for the remainder of this request.",
  );
  context.conflicted = true;
  context.companyId = undefined;
}
