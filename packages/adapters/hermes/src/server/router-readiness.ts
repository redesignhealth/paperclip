/**
 * Ramp Router env and credential policy helpers for Hermes Local runs (TECH-7895).
 *
 * Hermes ships a native `router` provider authenticated with RAMP_ROUTER_API_KEY against a fixed
 * endpoint. These pure helpers define the policy a Router run applies:
 *  - which endpoint-override / alias variables must never reach the child, whatever layer supplied
 *    them (agent adapter env, inherited host profile env, or the parent process);
 *  - the canonical RAMP_ROUTER_API_KEY is the only Router credential — another provider's key never
 *    satisfies a Router run, and the provider is never silently swapped;
 *  - a remote/sandbox execution target is rejected: this adapter only executes locally.
 *
 * They have no callers yet; the run path wires them in a later change.
 */

import { ROUTER_PROVIDER } from "../shared/constants.js";

export const RAMP_ROUTER_API_KEY_ENV = "RAMP_ROUTER_API_KEY";

/** Exact legacy/alias names that could redirect or replace the canonical Router credential. */
const ROUTER_ALIAS_ENV_NAMES: ReadonlySet<string> = new Set([
  "ROUTER_API_KEY",
  "ROUTER_BASE_URL",
  "ROUTER_API_BASE",
]);

/**
 * Generic OpenAI-SDK endpoint variables. A Responses-API client may fall back to them when it is not
 * given an explicit base URL, so they are removed from Router runs only (non-Router runs keep them).
 */
const ROUTER_RUN_SDK_ENDPOINT_ENV_NAMES: readonly string[] = ["OPENAI_BASE_URL", "OPENAI_API_BASE"];

/**
 * True for any variable that could point the Router credential somewhere other than Hermes's
 * built-in Router endpoint: every RAMP_ROUTER_* name except the canonical key, plus legacy aliases.
 */
export function isRouterEndpointOverrideEnvName(name: string): boolean {
  if (name === RAMP_ROUTER_API_KEY_ENV) return false;
  return name.startsWith("RAMP_ROUTER_") || ROUTER_ALIAS_ENV_NAMES.has(name);
}

/**
 * Names to remove from (and unset in) the final child env. Always includes the fixed alias set so
 * `unsetEnvKeys` removes them even if a later layer would re-add them.
 */
export function routerEnvNamesToStrip(
  env: Record<string, string | undefined>,
  isRouterRun: boolean,
): string[] {
  const names = new Set<string>(["RAMP_ROUTER_BASE_URL", ...ROUTER_ALIAS_ENV_NAMES]);
  for (const name of Object.keys(env)) {
    if (isRouterEndpointOverrideEnvName(name)) names.add(name);
  }
  if (isRouterRun) for (const name of ROUTER_RUN_SDK_ENDPOINT_ENV_NAMES) names.add(name);
  return [...names].sort();
}

/** The canonical, non-blank Router key from a resolved env, or undefined. */
export function readRouterApiKey(env: Record<string, unknown> | null | undefined): string | undefined {
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
  const value = (env as Record<string, unknown>)[RAMP_ROUTER_API_KEY_ENV];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isRouterProvider(provider: string | null | undefined): boolean {
  return typeof provider === "string" && provider.trim().toLowerCase() === ROUTER_PROVIDER;
}

export const ROUTER_KEY_MISSING_MESSAGE =
  "Refusing to start: this agent uses the Ramp Router provider but no RAMP_ROUTER_API_KEY is configured. " +
  "Bind a Ramp Router API key through the agent's adapter env (company secret reference). " +
  "Other providers' keys are not used for Router, and the provider is never switched automatically.";

export const ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE =
  "Refusing to start: the Ramp Router provider is only supported for Hermes Local runs on the Paperclip host. " +
  "This run targets a remote/sandbox environment, which the Hermes Local adapter does not execute in. " +
  "Select the local environment for this agent.";

export const ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE =
  "Refusing to start: extra Hermes CLI arguments (extraArgs) are not supported with the Ramp Router provider, " +
  "because Hermes parses them before Paperclip's own flags and they could select another profile, provider or endpoint. " +
  "Remove extraArgs from this agent's configuration.";

/** Shown by the environment test: host-side overrides never apply to a Router run. */
export const ROUTER_FRESH_PROFILE_NOTE =
  "Ramp Router runs use a fresh per-run Hermes profile: host endpoint overrides (RAMP_ROUTER_BASE_URL, model.base_url), " +
  "auth/credential pools and provider plugins from the host Hermes dir are not used.";

/** True when the run targets a remote (SSH/sandbox) environment rather than the local host. */
export function isRemoteExecutionTarget(ctx: {
  executionTarget?: { kind?: string } | null;
  executionTransport?: { remoteExecution?: Record<string, unknown> | null } | null;
}): boolean {
  if (ctx.executionTarget && ctx.executionTarget.kind && ctx.executionTarget.kind !== "local") return true;
  return Boolean(ctx.executionTransport?.remoteExecution);
}
