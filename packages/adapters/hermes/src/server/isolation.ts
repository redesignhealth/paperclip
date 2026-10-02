/**
 * Hosted Hermes credential isolation switch (TECH-7102).
 *
 * In a hosted (`authenticated`) deployment the Paperclip server host's `~/.hermes` (.env provider
 * keys, config, auth, skills) must never reach a Hermes run: the run gets a fresh per-run home and
 * only an explicit provider credential from the agent's resolved adapter env. Local single-user
 * development (`local_trusted`) keeps the legacy behavior of using your own `~/.hermes`.
 *
 * Hermes-only on purpose; this is NOT the cross-adapter agent auth policy (TECH-7095).
 */
import { HERMES_PROVIDER_ENV_ALLOWLIST } from "./mcp-config.js";

export const HERMES_HOST_ISOLATION_ENV = "PAPERCLIP_HERMES_HOST_ISOLATION";

const OFF_VALUES = new Set(["false", "0", "off", "no"]);
const ON_VALUES = new Set(["true", "1", "on", "yes"]);

/**
 * ON when PAPERCLIP_DEPLOYMENT_MODE=authenticated. PAPERCLIP_HERMES_HOST_ISOLATION overrides it
 * either way; any value that is set but not a recognised "off" value fails closed to ON, so a typo
 * cannot silently disable isolation.
 */
export function hermesHostIsolationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env[HERMES_HOST_ISOLATION_ENV]?.trim().toLowerCase();
  if (explicit) {
    if (OFF_VALUES.has(explicit)) return false;
    if (ON_VALUES.has(explicit)) return true;
    return true;
  }
  return env.PAPERCLIP_DEPLOYMENT_MODE === "authenticated";
}

const NON_CREDENTIAL_SUFFIX = /(_BASE_URL|_PORTAL_URL|_HOST|_ENDPOINT|_REGION)$/;

/** Allowlisted provider variables that carry a credential (not a base URL / host / endpoint). */
export function isHermesProviderCredentialName(name: string): boolean {
  return HERMES_PROVIDER_ENV_ALLOWLIST.has(name) && !NON_CREDENTIAL_SUFFIX.test(name);
}

/**
 * True when the run's own resolved adapter env carries at least one non-empty provider credential.
 * Only the agent's resolved `config.env` is consulted: never the server env, a host `.env`, or
 * the host HOME. Returns names only, never values.
 */
export function hasExplicitHermesProviderCredential(userEnv: unknown): boolean {
  if (!userEnv || typeof userEnv !== "object" || Array.isArray(userEnv)) return false;
  for (const [name, value] of Object.entries(userEnv as Record<string, unknown>)) {
    if (!isHermesProviderCredentialName(name)) continue;
    if (typeof value === "string" && value.trim().length > 0) return true;
  }
  return false;
}

export const HERMES_EXPLICIT_CREDENTIAL_REQUIRED_MESSAGE =
  "Refusing to start: this deployment isolates Hermes from the server host's credentials, and the agent has no explicit provider credential. " +
  "Bind a provider API key through the agent's company secret reference (adapter env).";
