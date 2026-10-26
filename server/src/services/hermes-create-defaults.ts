/**
 * Create-time provider/model defaults for NEW Hermes Local agents (TECH-7895), shared by the agent
 * create transaction and the read-only create-purpose environment test forecast.
 *
 * Order at create (agents service): the platform-default Ramp Router key is bound first (TECH-7959,
 * only when its attempt predicate says so AND the secret step actually binds), then the
 * platform-default OpenAI key (unchanged predicate; native mem0 memory needs OPENAI_API_KEY even on a
 * Router agent), then the Ramp Router provider/model default applies. A bound platform Router key
 * makes Router the default even though the agent is no longer credential-free; without it the Router
 * default applies only to an otherwise-unchosen, credential-free config. The forecast reproduces
 * exactly that order without any secret write, and both sides project the result into the same safe,
 * credential-free AgentCreateDefaultsProjection.
 */
import type { AgentCreateDefaultsProjection } from "@paperclipai/shared";
import {
  ROUTER_DEFAULT_MODEL,
  ROUTER_PROVIDER,
  isHermesProviderCredentialName,
} from "@paperclipai/hermes-paperclip-adapter/server";

import { conflict } from "../errors.js";

export const HERMES_LOCAL_ADAPTER_TYPE = "hermes_local";

/** The canonical Router credential env name the Hermes adapter reads (router-readiness.ts). */
export const RAMP_ROUTER_API_KEY_ENV = "RAMP_ROUTER_API_KEY";

/** The platform-default OpenAI company secret a Hermes create may bind (key, name, description). */
export const PLATFORM_DEFAULT_OPENAI_SECRET = {
  key: "openai_api_key",
  name: "OPENAI_API_KEY (platform default)",
  description: "Platform default OpenAI API key for Hermes agents. Managed by deployment; update or rotate via Secrets API.",
} as const;

/** The platform-default Ramp Router company secret a Hermes create may bind (TECH-7959). */
export const PLATFORM_DEFAULT_ROUTER_SECRET = {
  key: "ramp_router_api_key",
  name: "RAMP_ROUTER_API_KEY (platform default)",
  description: "Platform default Ramp Router API key for Hermes agents. Managed by deployment; rotated from the deployment key at boot when reconcile is enabled.",
} as const;

/**
 * A fixed, NON-SECRET stand-in for the organization's Router key in a create-purpose readiness test
 * (TECH-7959). The test never reads or receives the real managed key; this only satisfies the
 * "key present" gate so the remaining Router gates are exercised.
 */
export const PLATFORM_ROUTER_KEY_TEST_PLACEHOLDER = "paperclip-platform-router-key-not-tested";

/** The (key, name) pair a platform-default secret forecast or ensure step needs. */
export type PlatformDefaultSecretSpec = { key: string; name: string };

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

/**
 * TECH-7959: whether a create ATTEMPTS to bind the platform-default Ramp Router key. True only for a
 * Hermes Local agent with a valid captured deployment Router key whose raw env has no
 * RAMP_ROUTER_API_KEY property of its own (an explicit blank stays the caller's choice), AND either
 *   - the provider normalizes to "router" (the caller chose Router and needs a key), or
 *   - provider and model are unchosen and the caller chose NO provider credential.
 * Evaluated on the caller's raw (pre-binding) config, so the platform OpenAI binding never counts as
 * a user credential here. Whether it is actually bound is the secret step's decision (or forecast).
 */
export function needsPlatformDefaultRouterKey(
  adapterType: string,
  rawAdapterConfig: unknown,
  deploymentKeyAvailable: boolean,
): boolean {
  if (adapterType !== HERMES_LOCAL_ADAPTER_TYPE || !deploymentKeyAvailable) return false;
  const config = isPlainRecord(rawAdapterConfig) ? rawAdapterConfig : {};
  const hasEnv = Object.prototype.hasOwnProperty.call(config, "env");
  if (hasEnv && !isPlainRecord(config.env)) return false;
  const rawEnv = hasEnv ? (config.env as Record<string, unknown>) : undefined;
  if (rawEnv && Object.prototype.hasOwnProperty.call(rawEnv, RAMP_ROUTER_API_KEY_ENV)) return false;
  const provider = normalizedProvider(config.provider);
  if (provider === ROUTER_PROVIDER) return true;
  if (provider !== "" && provider !== "auto") return false;
  if (!isUnchosenModel(config.model)) return false;
  return !hasProviderCredentialEnv(rawEnv);
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
 * - Implicit default (provider absent/"auto"): applies only when NO model was chosen and either the
 *   platform-default Router key is ACTUALLY bound (TECH-7959: Router wins over the platform OpenAI
 *   key, which may be bound alongside it for memory), or NO provider credential is supplied and no
 *   platform-default OpenAI key is being bound. An explicit model (e.g. claude-sonnet-5) keeps
 *   Paperclip's model-name provider inference.
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
  /** TECH-7959: the platform-default Ramp Router key is ACTUALLY bound (not skipped). */
  bindsPlatformDefaultRouterKey?: boolean;
}) {
  const { adapterType, adapterConfig, bindsPlatformDefaultOpenAiKey } = input;
  const bindsPlatformDefaultRouterKey = input.bindsPlatformDefaultRouterKey === true;
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
  // The bind predicate already required an otherwise credential-free intent, so the only credentials
  // now present are the platform defaults themselves.
  if (bindsPlatformDefaultRouterKey) {
    return { ...adapterConfig, provider: ROUTER_PROVIDER, model: ROUTER_DEFAULT_MODEL };
  }
  if (bindsPlatformDefaultOpenAiKey) return adapterConfig;
  if (hasProviderCredentialEnv(adapterConfig.env)) return adapterConfig;

  return { ...adapterConfig, provider: ROUTER_PROVIDER, model: ROUTER_DEFAULT_MODEL };
}

/**
 * The safe projection of a Hermes Local create's effective provider/model. `before` is the config
 * the Router default was applied to and `after` its result (the same object when untouched).
 */
export function projectHermesCreateDefaults(input: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  platformDefaultOpenAiKeyBound: boolean;
  platformDefaultRouterKeyBound?: boolean;
}): AgentCreateDefaultsProjection {
  const { before, after, platformDefaultOpenAiKeyBound } = input;
  const platformRouterKeyBound = input.platformDefaultRouterKeyBound === true;
  const provider = typeof after.provider === "string" && after.provider.trim() ? after.provider.trim() : null;
  const model = typeof after.model === "string" && !isUnchosenModel(after.model) ? after.model : null;
  const providerUnchosen = provider === null || provider.toLowerCase() === "auto";
  const source: AgentCreateDefaultsProjection["source"] = after !== before
    ? "router_default"
    : platformDefaultOpenAiKeyBound && providerUnchosen && model === null
      ? "platform_openai"
      : "explicit_or_inferred";
  return { provider, model, source, requiresRouterReadiness: provider === ROUTER_PROVIDER, platformRouterKeyBound };
}

export function createDefaultsEqual(a: AgentCreateDefaultsProjection, b: AgentCreateDefaultsProjection): boolean {
  return a.provider === b.provider
    && a.model === b.model
    && a.source === b.source
    && a.requiresRouterReadiness === b.requiresRouterReadiness
    // An older client's echoed projection omits the flag; it means "not bound".
    && (a.platformRouterKeyBound ?? false) === (b.platformRouterKeyBound ?? false);
}

/**
 * Optional create-time consistency assertion: refuse (409, retryable) when the defaults this create
 * actually resolved differ from what a create-purpose preflight forecast. Thrown inside the create
 * transaction, so every side effect (including a platform-default secret it created) rolls back.
 * This is a staleness check, not proof of readiness or an authorization token.
 */
export function assertExpectedCreateDefaults(
  expected: AgentCreateDefaultsProjection | undefined,
  actual: AgentCreateDefaultsProjection,
): void {
  if (!expected || createDefaultsEqual(expected, actual)) return;
  throw conflict(
    "This agent's server defaults changed after its setup check. Review the setup and try again.",
    { code: "agent_create_defaults_changed", createDefaults: actual },
  );
}

/**
 * READ-ONLY forecast of a Hermes Local create's defaults from the caller's raw intent config.
 *
 * `extraCredentialNames` are provider keys entered for this setup that the create will store and
 * bind (one-shot test credentials): they count exactly as a bound env entry would, without their
 * values ever entering this computation. Environment-level variables are NOT part of the create
 * decision and must not be passed here. Returns the projection and the provider/model a readiness
 * test should use; never env, keys or the full config.
 */
export async function forecastHermesCreateDefaults(input: {
  adapterConfig: Record<string, unknown>;
  extraCredentialNames: readonly string[];
  /** A valid platform-default OpenAI key was captured at boot. */
  deploymentKeyAvailable: boolean;
  /** TECH-7959: a valid platform-default Ramp Router key was captured at boot. */
  routerKeyAvailable?: boolean;
  /** Read-only forecast of the generic platform-default secret step for one secret. */
  forecastPlatformSecret: (secret: PlatformDefaultSecretSpec) => Promise<{ wouldBind: boolean }>;
}): Promise<AgentCreateDefaultsProjection> {
  const intentEnv = isPlainRecord(input.adapterConfig.env) ? { ...input.adapterConfig.env } : undefined;
  let intent = input.adapterConfig;
  if (input.extraCredentialNames.length > 0) {
    const env: Record<string, unknown> = { ...(intentEnv ?? {}) };
    // Placeholders only: the create binds the stored secret under this name. No value is used.
    for (const name of input.extraCredentialNames) env[name] = { type: "secret_ref", secretId: "forecast" };
    intent = { ...intent, env };
  }
  // Same order as the create: Router secret first, then OpenAI, both judged on the raw intent.
  const attemptsRouter = needsPlatformDefaultRouterKey(HERMES_LOCAL_ADAPTER_TYPE, intent, input.routerKeyAvailable === true);
  const attemptsOpenAi = needsPlatformDefaultOpenAiKey(HERMES_LOCAL_ADAPTER_TYPE, intent, input.deploymentKeyAvailable);
  const platformDefaultRouterKeyBound = attemptsRouter
    ? (await input.forecastPlatformSecret(PLATFORM_DEFAULT_ROUTER_SECRET)).wouldBind
    : false;
  const platformDefaultOpenAiKeyBound = attemptsOpenAi
    ? (await input.forecastPlatformSecret(PLATFORM_DEFAULT_OPENAI_SECRET)).wouldBind
    : false;
  const after = applyHermesRouterProviderDefault({
    adapterType: HERMES_LOCAL_ADAPTER_TYPE,
    adapterConfig: intent,
    bindsPlatformDefaultOpenAiKey: platformDefaultOpenAiKeyBound,
    bindsPlatformDefaultRouterKey: platformDefaultRouterKeyBound,
  });
  return projectHermesCreateDefaults({
    before: intent,
    after,
    platformDefaultOpenAiKeyBound,
    platformDefaultRouterKeyBound,
  });
}
