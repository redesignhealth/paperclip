import {
  currentAgentAuthPolicy,
  isManagedOnlyEnforced,
  type AgentAuthPolicy,
} from "./agent-auth-policy.js";
import type { AdapterBillingType } from "./types.js";

function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function inferOpenAiCompatibleBiller(
  env: NodeJS.ProcessEnv,
  fallback: string | null = "openai",
): string | null {
  const explicitOpenRouterKey = readEnv(env, "OPENROUTER_API_KEY");
  if (explicitOpenRouterKey) return "openrouter";

  const baseUrl =
    readEnv(env, "OPENAI_BASE_URL") ??
    readEnv(env, "OPENAI_API_BASE") ??
    readEnv(env, "OPENAI_API_BASE_URL");
  if (baseUrl && /openrouter\.ai/i.test(baseUrl)) return "openrouter";

  return fallback;
}

/** Provider key names that mean "this child bills per API call" when explicitly bound. */
export const DEFAULT_CHILD_API_KEY_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "XAI_API_KEY",
  "CURSOR_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_MODEL_API_KEY",
  "OPENROUTER_API_KEY",
];

export type ChildVisibleBillingSource =
  /** `config.managedAiConnection.method` (set by the managed AI-connection runtime). */
  | "managed_connection"
  /** An explicit, non-empty provider key binding in `config.env`. */
  | "config_env"
  /** Legacy inference (e.g. "unbound Claude means subscription"); host_fallback / report only. */
  | "legacy_inference"
  /** Enforced managed_only with nothing the child can actually see: billing is unknown. */
  | "unresolved";

export interface ChildVisibleBillingIdentity {
  billingType: AdapterBillingType;
  source: ChildVisibleBillingSource;
}

export interface ChildVisibleBillingOptions {
  /** Key names that indicate API billing for this adapter. Defaults to the common provider keys. */
  apiKeyEnvNames?: readonly string[];
  /** Explicitly bound subscription tokens (e.g. CLAUDE_CODE_OAUTH_TOKEN) -> `subscription`. */
  subscriptionEnvNames?: readonly string[];
  /** What the adapter historically inferred for an unbound run. Defaults to `subscription`. */
  legacyBillingType?: AdapterBillingType;
  /** Defaults to the policy in effect for this process. */
  policy?: AgentAuthPolicy;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * True when `config.env[key]` is a binding the child will actually receive: a non-empty
 * resolved string, a non-empty `plain` binding, or a secret reference (resolved by the server
 * before spawn). Never reads, returns or logs the value itself.
 */
export function hasChildVisibleEnvBinding(config: unknown, key: string): boolean {
  const env = asRecord(asRecord(config).env);
  const raw = env[key];
  if (typeof raw === "string") return raw.trim().length > 0;
  const binding = asRecord(raw);
  if (binding.type === "plain") return typeof binding.value === "string" && binding.value.trim().length > 0;
  if (binding.type === "secret_ref") return typeof binding.secretId === "string" && binding.secretId.trim().length > 0;
  if (binding.type === "user_secret_ref") return typeof binding.key === "string" && binding.key.trim().length > 0;
  return false;
}

/** `config.managedAiConnection.method`, mapped onto a billing type. */
export function readManagedAiConnectionBillingType(config: unknown): "subscription" | "api" | null {
  const method = asRecord(asRecord(config).managedAiConnection).method;
  if (method === "subscription") return "subscription";
  if (method === "api_key" || method === "api") return "api";
  return null;
}

/**
 * Billing identity derived only from what the child process can actually see (TECH-7095).
 *
 *  1. a managed AI connection's method (`subscription` / `api_key` -> `api`);
 *  2. otherwise an explicit provider key bound in `config.env` -> `api` (or an explicitly bound
 *     subscription token -> `subscription`);
 *  3. otherwise, under enforced `managed_only`, `unknown` (there is no host login to assume);
 *  4. otherwise (host_fallback / managed_only_report) the adapter's legacy inference.
 */
export function resolveChildVisibleBillingIdentity(
  config: unknown,
  options: ChildVisibleBillingOptions = {},
): ChildVisibleBillingIdentity {
  const managed = readManagedAiConnectionBillingType(config);
  if (managed) return { billingType: managed, source: "managed_connection" };
  const keys = options.apiKeyEnvNames ?? DEFAULT_CHILD_API_KEY_ENV_NAMES;
  if (keys.some((key) => hasChildVisibleEnvBinding(config, key))) {
    return { billingType: "api", source: "config_env" };
  }
  if ((options.subscriptionEnvNames ?? []).some((key) => hasChildVisibleEnvBinding(config, key))) {
    return { billingType: "subscription", source: "config_env" };
  }
  const policy = options.policy ?? currentAgentAuthPolicy();
  if (isManagedOnlyEnforced(policy)) return { billingType: "unknown", source: "unresolved" };
  return { billingType: options.legacyBillingType ?? "subscription", source: "legacy_inference" };
}
