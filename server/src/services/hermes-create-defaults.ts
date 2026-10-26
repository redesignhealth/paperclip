/**
 * Create-time provider/model defaults for NEW Hermes Local agents (TECH-7895).
 *
 * Order at create (agents service): the platform-default OpenAI key is bound first (only when the
 * existing attempt predicate says so AND the secret step actually binds), then the Ramp Router
 * default applies to an otherwise-unchosen, credential-free config. The result is projected into
 * the safe, credential-free AgentCreateDefaultsProjection.
 */
import {
  ROUTER_DEFAULT_MODEL,
  ROUTER_PROVIDER,
  isHermesProviderCredentialName,
} from "@paperclipai/hermes-paperclip-adapter/server";

export const HERMES_LOCAL_ADAPTER_TYPE = "hermes_local";

/** The platform-default OpenAI company secret a Hermes create may bind (key, name, description). */
export const PLATFORM_DEFAULT_OPENAI_SECRET = {
  key: "openai_api_key",
  name: "OPENAI_API_KEY (platform default)",
  description: "Platform default OpenAI API key for Hermes agents. Managed by deployment; update or rotate via Secrets API.",
} as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a create ATTEMPTS to bind the platform-default OpenAI key: a Hermes Local agent, a valid
 * captured deployment key, and no OPENAI_API_KEY entry of its own (no env at all, or an env record
 * without that name). Whether it is actually bound is the secret step's decision (or its forecast).
 */
export function needsPlatformDefaultOpenAiKey(
  adapterType: string,
  rawAdapterConfig: unknown,
  deploymentKeyAvailable: boolean,
): boolean {
  if (adapterType !== HERMES_LOCAL_ADAPTER_TYPE || !deploymentKeyAvailable) return false;
  if (!isPlainRecord(rawAdapterConfig)) return true;
  if (!Object.prototype.hasOwnProperty.call(rawAdapterConfig, "env")) return true;
  const rawEnv = rawAdapterConfig.env;
  return isPlainRecord(rawEnv) && !Object.prototype.hasOwnProperty.call(rawEnv, "OPENAI_API_KEY");
}

/** Whether a normalized adapter env carries at least one non-empty allowlisted provider credential. */
export function hasProviderCredentialEnv(env: unknown): boolean {
  if (!isPlainRecord(env)) return false;
  return Object.entries(env).some(([name, binding]) => {
    if (!isHermesProviderCredentialName(name)) return false;
    if (typeof binding === "string") return binding.trim().length > 0;
    if (!isPlainRecord(binding)) return false;
    // A secret reference is a credential even before it resolves; so is a plain binding whose value
    // is a non-empty (non-whitespace) string. An empty or blank plain value is not.
    return binding.type === "secret_ref"
      || binding.type === "user_secret_ref"
      || (typeof binding.value === "string" && binding.value.trim().length > 0);
  });
}

function normalizedProvider(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase();
}

/**
 * No model chosen: absent, blank, or Hermes's legacy "auto" sentinel (normalizeConfiguredModel treats
 * "auto" as "no model", and Hermes never receives it as `-m`).
 */
export function isUnchosenModel(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const model = value.trim().toLowerCase();
  return model === "" || model === "auto";
}

/**
 * TECH-7895: Ramp Router defaults for NEW Hermes Local agents (create-only; the update path is
 * untouched, so existing agents keep their configuration and there is no migration).
 *
 * - Explicit provider "router": only an unchosen model is filled with the Router default, whether or
 *   not a key is supplied, because Hermes refuses a provider with no model. An explicit model is kept.
 * - Implicit default (provider absent/"auto"): applies only when NO model was chosen, NO provider
 *   credential is supplied, and no platform-default OpenAI key is being bound. An explicit model
 *   (e.g. claude-sonnet-5) keeps Paperclip's model-name provider inference.
 * - Any other explicit provider is never touched.
 *
 * Returns the SAME object when nothing changes. No key is substituted here: an agent created
 * without a Router key keeps provider/model but fails closed before inference at run time.
 */
export function applyHermesRouterProviderDefault(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  /** A platform-default OpenAI key is ACTUALLY bound (not skipped), so the agent is not credential-free. */
  bindsPlatformDefaultOpenAiKey: boolean;
}) {
  const { adapterType, adapterConfig, bindsPlatformDefaultOpenAiKey } = input;
  if (adapterType !== HERMES_LOCAL_ADAPTER_TYPE) return adapterConfig;
  const provider = normalizedProvider(adapterConfig.provider);

  if (provider === ROUTER_PROVIDER) {
    // Persist the canonical slug. `normalizedProvider` accepts "Router"/" router ", but the adapter's
    // resolveProvider() requires an exact VALID_PROVIDERS match, so keeping the caller's spelling
    // would leave a Router config the run cannot resolve.
    const canonical = adapterConfig.provider === ROUTER_PROVIDER
      ? adapterConfig
      : { ...adapterConfig, provider: ROUTER_PROVIDER };
    return isUnchosenModel(canonical.model)
      ? { ...canonical, model: ROUTER_DEFAULT_MODEL }
      : canonical;
  }

  if (provider !== "" && provider !== "auto") return adapterConfig;
  if (!isUnchosenModel(adapterConfig.model)) return adapterConfig;
  if (bindsPlatformDefaultOpenAiKey) return adapterConfig;
  if (hasProviderCredentialEnv(adapterConfig.env)) return adapterConfig;

  return { ...adapterConfig, provider: ROUTER_PROVIDER, model: ROUTER_DEFAULT_MODEL };
}
