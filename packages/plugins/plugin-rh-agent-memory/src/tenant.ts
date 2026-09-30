/**
 * THE ONE HARD RULE OF THIS PLUGIN
 * ================================
 *
 * Tenant identity (`company_id`, `agent_id`) is derived EXCLUSIVELY from the
 * host-provided `ToolRunContext` — the second argument the Paperclip plugin
 * host passes to a tool handler. It is NEVER read from `params`.
 *
 * Why this matters (verified against the Paperclip source, not assumed):
 *
 *   - `server/src/services/tool-gateway.ts` validates `actor.companyId ===
 *     runContext.companyId` before a plugin tool is ever dispatched. That makes
 *     `runContext` trusted. It does NOT cross-check
 *     `requestedParameters.companyId`, so `params` is attacker-controlled: an
 *     agent under prompt injection can put any company's UUID in there.
 *
 *   - The shipped reference plugin `plugin-llm-wiki` scopes all of its SQL by
 *     `company_id` correctly, but sources that value from a tool PARAMETER —
 *     e.g. `packages/plugins/plugin-llm-wiki/src/wiki/core.ts`:
 *
 *         }, async (params: unknown): Promise<ToolResult> => {
 *           const input = params as ToolParams;
 *           const companyId = requireString(input.companyId, "companyId");
 *
 *     Note that the handler does not even accept the `runCtx` argument. That is
 *     the exact vulnerability class this module exists to make impossible here.
 *
 * Enforcement is two-layered and both layers are covered by
 * `tests/tenant-isolation.spec.ts`:
 *
 *   1. IGNORE  — `resolveTenant()` takes only a `ToolRunContext`. It has no
 *      access to `params`, so no amount of caller input can influence the
 *      tenant key. This is a type-level guarantee, not a convention.
 *   2. REJECT  — `assertNoTenantParams()` fails the tool call loudly if the
 *      caller supplied any tenant-identity-shaped parameter. Silently ignoring
 *      an injection attempt leaves no audit trail; we want the error.
 *
 * CODE REVIEW CHECKLIST for any change to this package:
 *   [ ] No handler reads `companyId` / `agentId` / `company_id` / `agent_id`
 *       (or any alias) out of `params`.
 *   [ ] Every tool handler calls `assertNoTenantParams(params)` first and
 *       `resolveTenant(runCtx)` for identity.
 *   [ ] Every SQL statement filters on BOTH `company_id = $n` AND
 *       `agent_id = $n`, bound from the resolved tenant, never interpolated.
 *   [ ] No manifest `parametersSchema` declares a companyId/agentId property.
 *   [ ] A new tool ships with a cross-tenant-parameter-injection test.
 */

import type { ToolRunContext } from "@paperclipai/plugin-sdk";

/** Host-validated tenant key. The only legitimate source of tenancy. */
export interface Tenant {
  /** From `runContext.companyId`. One company per RH employee. */
  readonly companyId: string;
  /** From `runContext.agentId`. */
  readonly agentId: string;
}

/**
 * Parameter names a caller might use to try to smuggle in a tenant identity.
 * Matching is case-insensitive and ignores any non-alphanumeric separator
 * (`_`, `-`, `.`, `:`, whitespace, ...) so `company_id`, `companyID`,
 * `company-id`, `company.id`, and `company id` are all caught.
 */
const FORBIDDEN_TENANT_PARAM_KEYS = [
  "companyid",
  "company",
  "orgid",
  "organizationid",
  "tenantid",
  "tenant",
  "agentid",
  "agent",
  "runid",
  "projectid",
  "scopeid",
  "actorid",
  "userid",
  "workspaceid",
  "ownerid",
  "accountid",
  "clientid",
  "customerid",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** Thrown when a caller tries to supply tenant identity as a tool parameter. */
export class TenantParameterInjectionError extends Error {
  readonly rejectedKeys: string[];

  constructor(rejectedKeys: string[]) {
    super(
      `Refusing tool call: tenant identity may not be passed as a parameter. `
      + `Rejected parameter(s): ${rejectedKeys.join(", ")}. `
      + `company_id/agent_id are derived from the host-validated runContext only.`,
    );
    this.name = "TenantParameterInjectionError";
    this.rejectedKeys = rejectedKeys;
  }
}

/** Thrown when the host did not supply a usable runContext tenant identity. */
export class MissingRunContextTenantError extends Error {
  constructor(detail: string) {
    super(`Refusing tool call: ${detail}`);
    this.name = "MissingRunContextTenantError";
  }
}

/**
 * Layer 2 — reject. Fail the call if the caller supplied anything that looks
 * like a tenant identity, even if it happens to match the real one. There is no
 * legitimate reason for a model to send these, so a match is a signal worth
 * surfacing rather than swallowing.
 */
export function assertNoTenantParams(params: unknown): void {
  if (params == null || typeof params !== "object" || Array.isArray(params)) return;
  const rejected: string[] = [];
  for (const key of Object.keys(params as Record<string, unknown>)) {
    if (FORBIDDEN_TENANT_PARAM_KEYS.includes(canonicalizeKey(key) as never)) {
      rejected.push(key);
    }
  }
  if (rejected.length > 0) throw new TenantParameterInjectionError(rejected.sort());
}

/**
 * Layer 1 — ignore. Derive the tenant key from the host-validated runContext.
 *
 * This function deliberately accepts ONLY `ToolRunContext`. It cannot read
 * caller parameters because it is never given them.
 */
export function resolveTenant(runCtx: ToolRunContext | null | undefined): Tenant {
  if (runCtx == null || typeof runCtx !== "object") {
    throw new MissingRunContextTenantError("the host did not provide a tool runContext");
  }
  const companyId = typeof runCtx.companyId === "string" ? runCtx.companyId.trim() : "";
  const agentId = typeof runCtx.agentId === "string" ? runCtx.agentId.trim() : "";
  if (!UUID_RE.test(companyId)) {
    throw new MissingRunContextTenantError("runContext.companyId is missing or is not a UUID");
  }
  if (!UUID_RE.test(agentId)) {
    throw new MissingRunContextTenantError("runContext.agentId is missing or is not a UUID");
  }
  return Object.freeze({ companyId: companyId.toLowerCase(), agentId: agentId.toLowerCase() });
}

/**
 * Both layers, in the required order, for a tool handler entrypoint.
 * Reject first so an injection attempt errors even if the runContext is fine.
 */
export function requireTenant(params: unknown, runCtx: ToolRunContext | null | undefined): Tenant {
  assertNoTenantParams(params);
  return resolveTenant(runCtx);
}
