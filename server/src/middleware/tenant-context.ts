/**
 * TECH-6956: establishes the per-request tenant context that RLS reads from.
 *
 * This middleware creates the context holder; it does not decide what goes in
 * it. The value is written later, by `assertCompanyAccess` in
 * `server/src/routes/authz.ts`, once that has verified which company the
 * request is actually allowed to touch. Separating the two matters: the
 * context must be established before any handler runs, but the trusted
 * company id is not knowable until authorization has happened, and for
 * board/user actors it arrives as a route parameter rather than from the
 * session.
 *
 * The one case decidable here is an agent actor, which by construction has
 * exactly one company (`req.actor.companyId`, set from a signed JWT claim or
 * an agent API key row). Binding it up front means agent-driven requests --
 * including the plugin and heartbeat paths -- are tenant-scoped even on
 * routes that never call `assertCompanyAccess` at all.
 *
 * Must be mounted AFTER `actorMiddleware` (which populates `req.actor`) and
 * BEFORE any route. It wraps the rest of the request in an
 * `AsyncLocalStorage` scope, so anything that awaits past it -- including
 * post-response async work -- still sees the same context and cannot see
 * another request's.
 */

import type { RequestHandler } from "express";
import { runWithTenantContext, setAmbientCompanyId } from "@paperclipai/db";

export function tenantContextMiddleware(): RequestHandler {
  return (req, _res, next) => {
    runWithTenantContext(() => {
      // Agent actors carry exactly one company; board/user actors carry a
      // list (`companyIds`) and the effective one is only known per-route,
      // so they are left for `assertCompanyAccess` to establish.
      const agentCompanyId = req.actor?.type === "agent" ? req.actor.companyId : undefined;
      if (agentCompanyId) setAmbientCompanyId(agentCompanyId);
      next();
    });
  };
}
