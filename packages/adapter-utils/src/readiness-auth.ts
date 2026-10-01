/**
 * Adapter readiness ("Test environment") rules under the agent auth policy (TECH-7095).
 *
 * Under enforced `managed_only` a readiness check may inspect ONLY what the agent child would
 * actually receive: the adapter `config.env` bindings, the managed AI connection, and a fresh
 * per-probe home. It must never read the server's own `process.env` provider keys or the server
 * user's home (`~/.claude`, `~/.codex`, `~/.hermes/.env`, ...), because a real run never sees
 * them either. Under `host_fallback` / `managed_only_report` the legacy host-login detection
 * stays (callers mark those reads with `// auth-policy: host_fallback`).
 */
import { buildAgentChildBaseEnv } from "./agent-child-env.js";
import {
  AgentAuthPolicyError,
  currentAgentAuthPolicy,
  isManagedOnlyEnforced,
  isManagedOnlyPolicy,
  type AgentAuthPolicy,
} from "./agent-auth-policy.js";
import { hasChildVisibleEnvBinding } from "./billing.js";
import { createRunHome, type RunHome } from "./run-home.js";
import type { AdapterEnvironmentCheck } from "./types.js";

export const AI_CONNECTION_REQUIRED_CHECK_CODE = "ai_connection_required";

/** True when readiness may still look at host env / host login files (legacy behaviour). */
export function readinessMayUseHostAuth(policy: AgentAuthPolicy = currentAgentAuthPolicy()): boolean {
  return !isManagedOnlyEnforced(policy);
}

export function hasManagedAiConnection(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  const managed = (config as Record<string, unknown>).managedAiConnection;
  return Boolean(managed);
}

/** A managed AI connection, or any of `keys` explicitly bound in `config.env`. Never reads values. */
export function hasChildVisibleCredential(config: unknown, keys: readonly string[]): boolean {
  return hasManagedAiConnection(config) || keys.some((key) => hasChildVisibleEnvBinding(config, key));
}

/**
 * Check result for an unbound managed-capable adapter. `error` when enforced (a run would be
 * refused before spawn), `info` under managed_only_report (what WOULD be refused).
 */
export function buildAiConnectionRequiredCheck(
  adapterType: string,
  policy: AgentAuthPolicy = currentAgentAuthPolicy(),
): AdapterEnvironmentCheck {
  const enforced = isManagedOnlyEnforced(policy);
  return {
    code: AI_CONNECTION_REQUIRED_CHECK_CODE,
    level: enforced ? "error" : "info",
    message: enforced
      ? new AgentAuthPolicyError("ai_connection_required").message
      : "This agent has no managed AI connection; it would be refused under the managed-only policy.",
    detail: `adapter=${adapterType}`,
    hint: "Select a managed AI connection for this agent (or bind the provider key explicitly as a secret in the agent env).",
  };
}

/**
 * Report-mode helper: the legacy result plus an informational `ai_connection_required` check
 * when the agent is unbound. Returns null when nothing should be reported.
 */
export function maybeReportAiConnectionRequired(
  adapterType: string,
  config: unknown,
  keys: readonly string[],
  policy: AgentAuthPolicy = currentAgentAuthPolicy(),
): AdapterEnvironmentCheck | null {
  if (!isManagedOnlyPolicy(policy) || isManagedOnlyEnforced(policy)) return null;
  if (hasChildVisibleCredential(config, keys)) return null;
  return buildAiConnectionRequiredCheck(adapterType, policy);
}

/**
 * Explicit probe env: allowlisted OS/runtime base + the caller's explicit env + the isolated
 * home's HOME/XDG/TMPDIR bindings applied LAST so neither the host home nor a caller override
 * can redirect where the CLI looks for credentials.
 */
export function buildIsolatedProbeEnv(
  callerEnv: Record<string, string>,
  home: Pick<RunHome, "env">,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base = buildAgentChildBaseEnv(source);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (typeof value === "string") env[key] = value;
  for (const [key, value] of Object.entries(callerEnv)) if (typeof value === "string") env[key] = value;
  return { ...env, ...home.env };
}

/** Run `fn` with a fresh owner-only probe home that is always removed afterwards. */
export async function withIsolatedProbeHome<T>(fn: (home: RunHome) => Promise<T>): Promise<T> {
  const home = await createRunHome({ prefix: "paperclip-run-home-probe-" });
  try {
    return await fn(home);
  } finally {
    await home.cleanup().catch(() => {});
  }
}
