/**
 * Server-side enforcement helpers for the agent authentication policy (TECH-7095).
 *
 * Every helper here reports env KEY NAMES only. Values (which may be credentials) are never
 * read into messages, details or logs.
 */
import {
  AgentAuthPolicyError,
  currentAgentAuthPolicy,
  isManagedOnlyEnforced,
  isManagedOnlyPolicy,
  type AgentAuthPolicy,
} from "@paperclipai/adapter-utils/agent-auth-policy";
import { AI_PROVIDERS, isAiConnectionCompatible } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * True when some managed AI connection provider can authenticate this adapter + model
 * (claude_local, codex_local, grok_local, opencode_local on an OpenRouter model, and the
 * paperclip_runner claude/codex/opencode/acpx+claude variants). Such an agent must run with a
 * managed AI connection under `managed_only`; every other adapter runs with an isolated home.
 */
export function isManagedCapableAdapter(
  adapterType: string,
  config: Record<string, unknown> | null | undefined,
): boolean {
  const cfg = config ?? {};
  return AI_PROVIDERS.some((provider) =>
    isAiConnectionCompatible(
      { provider, method: "api_key", mode: "responsible_user" },
      adapterType,
      cfg.model,
      cfg.provider,
      cfg.acpxAgent,
    ),
  );
}

/** Env names that redirect the child's home or a credential location. */
const FORBIDDEN_OVERRIDE_EXACT: ReadonlySet<string> = new Set([
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "GROK_HOME",
  "HERMES_HOME",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "KIMI_CODE_HOME",
  "GH_CONFIG_DIR",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG",
]);
const FORBIDDEN_OVERRIDE_PREFIXES = ["XDG_", "GIT_CONFIG_"] as const;

export function isForbiddenAgentEnvOverrideKey(key: string): boolean {
  return (
    FORBIDDEN_OVERRIDE_EXACT.has(key) ||
    FORBIDDEN_OVERRIDE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function envRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Sorted forbidden override key names present in an env binding map. */
export function findForbiddenAgentEnvOverrides(
  env: unknown,
  options: { previousEnv?: unknown } = {},
): string[] {
  const record = envRecord(env);
  const previous = envRecord(options.previousEnv);
  return Object.keys(record)
    .filter((key) => isForbiddenAgentEnvOverrideKey(key))
    // An update only rejects what it introduces or changes; an already-saved override is
    // neutralised at run time (the run home env is applied last and saved overrides are
    // stripped), so an unrelated edit to a legacy agent is not blocked by it.
    .filter((key) =>
      !Object.prototype.hasOwnProperty.call(previous, key) ||
      JSON.stringify(previous[key]) !== JSON.stringify(record[key]),
    )
    .sort();
}

/**
 * Create/update/hire validation. Under `managed_only` throws agent_env_override_forbidden
 * naming the offending keys; under `managed_only_report` logs the names and allows it.
 */
export function assertAgentEnvOverridesAllowed(
  env: unknown,
  options: {
    previousEnv?: unknown;
    adapterType?: string | null;
    policy?: AgentAuthPolicy;
  } = {},
): void {
  const policy = options.policy ?? currentAgentAuthPolicy();
  if (!isManagedOnlyPolicy(policy)) return;
  const keys = findForbiddenAgentEnvOverrides(env, options);
  if (keys.length === 0) return;
  if (isManagedOnlyEnforced(policy)) {
    throw new AgentAuthPolicyError("agent_env_override_forbidden", {
      keys,
      ...(options.adapterType ? { adapterType: options.adapterType } : {}),
    });
  }
  logger.warn(
    { keys, adapterType: options.adapterType ?? null, policy },
    "agent auth policy (report-only): agent env would be rejected for home/credential-location overrides",
  );
}

/** Runtime neutralisation: drop forbidden override keys from one env layer. */
export function stripForbiddenAgentEnvOverrides(
  env: Record<string, unknown>,
): { env: Record<string, unknown>; stripped: string[] } {
  const stripped: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isForbiddenAgentEnvOverrideKey(key)) stripped.push(key);
    else out[key] = value;
  }
  return { env: out, stripped: stripped.sort() };
}

/**
 * AI-provider and GitHub credential env names the generic `process` adapter may not carry under
 * `managed_only`: a process agent cannot hold a managed AI connection, so a provider key in its
 * env would be an unmanaged credential path.
 */
const PROCESS_CREDENTIAL_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "CODEX_",
  "XAI_",
  "GROK_",
  "GEMINI_",
  "OPENROUTER_",
  "KIMI_",
] as const;
const PROCESS_CREDENTIAL_EXACT: ReadonlySet<string> = new Set([
  "GOOGLE_API_KEY",
  "CURSOR_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

export function isForbiddenProcessAdapterCredentialKey(key: string): boolean {
  return (
    PROCESS_CREDENTIAL_EXACT.has(key) ||
    PROCESS_CREDENTIAL_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    /^GITHUB_.*TOKEN$/.test(key) ||
    /^GH_.*TOKEN$/.test(key)
  );
}

export function findForbiddenProcessAdapterCredentialKeys(env: unknown): string[] {
  const record = envRecord(env);
  return Object.keys(record)
    // An empty value carries no credential: the managed GitHub broker env deliberately blanks
    // GH_TOKEN/GITHUB_TOKEN/SSH_AUTH_SOCK etc. to clear anything ambient.
    .filter((key) => !(typeof record[key] === "string" && (record[key] as string).trim() === ""))
    .filter((key) => isForbiddenProcessAdapterCredentialKey(key))
    .sort();
}
