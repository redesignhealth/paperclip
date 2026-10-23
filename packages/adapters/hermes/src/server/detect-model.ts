/**
 * Detect the current model and provider from the user's Hermes config.
 *
 * Reads ~/.hermes/config.yaml and extracts the default model,
 * provider, base_url, api_key presence, and api_mode settings.
 *
 * Also provides provider resolution logic that merges explicit config,
 * Hermes config detection, and model-name prefix inference.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hermesHostIsolationEnabled } from "./isolation.js";
import { resolveHostHermesDir } from "./skills.js";
import { MODEL_PREFIX_PROVIDER_HINTS, ROUTER_PROVIDER, VALID_PROVIDERS } from "../shared/constants.js";
import { normalizeConfiguredModel, resolveModelArg } from "./model-arg.js";

export interface DetectedModel {
  /** Model name from config (e.g. "gpt-5.4", "anthropic/claude-sonnet-4") */
  model: string;
  /** Provider name from config (e.g. "copilot", "zai"). May be empty. */
  provider: string;
  /** Base URL override from config (e.g. "https://api.githubcopilot.com"). May be empty. */
  baseUrl: string;
  /** Whether Hermes config includes a non-empty API key. */
  hasApiKey: boolean;
  /** API mode from config (e.g. "chat_completions", "codex_responses"). May be empty. */
  apiMode: string;
  /** Where the detection came from */
  source: "config";
}

/**
 * Read the Hermes config file and extract the default model config.
 */
export async function detectModel(
  configPath?: string,
): Promise<DetectedModel | null> {
  // TECH-7102: in an isolated (hosted) deployment the host Hermes config is not something a run
  // receives, so it must not drive model/provider detection. Explicit paths are the caller's choice.
  if (configPath === undefined && hermesHostIsolationEnabled()) return null;
  // Same host Hermes dir as execution (HERMES_HOME, then HOME), not a hardcoded ~/.hermes.
  const filePath = configPath ?? join(resolveHostHermesDir(), "config.yaml");

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  return parseModelFromConfig(content);
}

/**
 * Parse model.default, model.provider, model.base_url, model.api_key, and model.api_mode
 * from raw YAML content. Uses simple regex parsing to avoid a YAML dependency.
 */
export function parseModelFromConfig(content: string): DetectedModel | null {
  const lines = content.split("\n");
  let model = "";
  let provider = "";
  let baseUrl = "";
  let hasApiKey = false;
  let apiMode = "";
  let inModelSection = false;
  let modelSectionIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const indent = line.length - line.trimStart().length;

    // Track model: section (indent 0)
    if (/^model:\s*$/.test(trimmed) && indent === 0) {
      inModelSection = true;
      modelSectionIndent = 0;
      continue;
    }

    // We left the model section if indent drops back to the section level or below
    if (inModelSection && indent <= modelSectionIndent && trimmed && !trimmed.startsWith("#")) {
      inModelSection = false;
    }

    if (inModelSection) {
      const match = trimmed.match(/^\s*(\w+)\s*:\s*(.+)$/);
      if (match) {
        const key = match[1];
        const val = match[2].trim().replace(/#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
        if (key === "default") model = val;
        if (key === "provider") provider = val;
        if (key === "base_url") baseUrl = val;
        if (key === "api_key") hasApiKey = val.length > 0;
        if (key === "api_mode") apiMode = val;
      }
    }
  }

  if (!model) return null;

  return { model, provider, baseUrl, hasApiKey, apiMode, source: "config" };
}

/**
 * Infer a provider from the model name using prefix-based hints.
 *
 * For example:
 *   "gpt-5.4"       → "copilot"
 *   "claude-sonnet-4" → "anthropic"
 *   "glm-5-turbo"   → "zai"
 *
 * Returns undefined if no hint matches (caller should fall back to "auto").
 */
export function inferProviderFromModel(model: string): string | undefined {
  const lower = model.toLowerCase();

  // Strip provider/ prefix if present (e.g. "anthropic/claude-sonnet-4")
  const bareName = lower.includes("/") ? lower.split("/").pop()! : lower;

  for (const [prefix, hint] of MODEL_PREFIX_PROVIDER_HINTS) {
    if (bareName.startsWith(prefix)) {
      return hint;
    }
  }

  return undefined;
}

/**
 * Resolve the correct provider for a model, using a priority chain:
 *
 *   1. Explicit provider from adapterConfig (highest priority — user override)
 *   2. Provider from Hermes config file — ONLY if the config model matches
 *      the requested model (otherwise the config provider is for a different model)
 *   3. If Hermes config matches the requested model but uses runtime settings that
 *      the adapter cannot represent directly, return "auto" and let Hermes resolve it itself
 *   4. Provider inferred from model name prefix
 *   5. "auto" (let Hermes figure it out — lowest priority)
 *
 * Always returns a valid provider string.
 * The `resolvedFrom` field indicates which source was used, useful for logging.
 */
export function resolveProvider(options: {
  /** Explicit provider from adapterConfig (user override) */
  explicitProvider?: string | null;
  /** Provider detected from Hermes config file */
  detectedProvider?: string;
  /** Model name from Hermes config file (to check consistency) */
  detectedModel?: string;
  /** Base URL detected from Hermes config file */
  detectedBaseUrl?: string;
  /** Whether Hermes config includes a non-empty API key */
  detectedHasApiKey?: boolean;
  /** API mode detected from Hermes config file */
  detectedApiMode?: string;
  /** Model name to infer from if no explicit/detected provider */
  model?: string;
}): { provider: string; resolvedFrom: string } {
  const {
    explicitProvider,
    detectedProvider,
    detectedModel,
    detectedBaseUrl,
    detectedHasApiKey,
    detectedApiMode,
    model,
  } = options;

  // 1. Explicit provider from adapterConfig — user override, always wins
  if (explicitProvider && (VALID_PROVIDERS as readonly string[]).includes(explicitProvider)) {
    return { provider: explicitProvider, resolvedFrom: "adapterConfig" };
  }

  const supportedProviders = VALID_PROVIDERS as readonly string[];
  const configMatchesRequestedModel =
    !!detectedModel &&
    !!model &&
    detectedModel.toLowerCase() === model.toLowerCase();

  // 2. Provider from Hermes config file — but ONLY if the config model matches
  //    the requested model. Otherwise the config provider is for a different model
  //    and would cause exactly the kind of routing bug we're fixing.
  if (
    configMatchesRequestedModel &&
    !!detectedProvider &&
    supportedProviders.includes(detectedProvider)
  ) {
    return { provider: detectedProvider, resolvedFrom: "hermesConfig" };
  }

  const hasRuntimeSignals = !!detectedBaseUrl || !!detectedHasApiKey || !!detectedApiMode;

  // 3a. Matching Hermes config with an unsupported provider (for example "custom")
  //     should not fall through to model-name inference, because that can route to
  //     the wrong provider entirely. Defer back to Hermes's own runtime resolution.
  if (configMatchesRequestedModel && !!detectedProvider && !supportedProviders.includes(detectedProvider)) {
    return {
      provider: "auto",
      resolvedFrom: `hermesConfigUnsupported:${detectedProvider}`,
    };
  }

  // 3b. Matching Hermes config may omit provider entirely while still specifying
  //     enough runtime information (base_url, api_key, api_mode) for Hermes itself.
  //     In that case, also defer to Hermes instead of doing a wrong prefix inference.
  if (configMatchesRequestedModel && !detectedProvider && hasRuntimeSignals) {
    return {
      provider: "auto",
      resolvedFrom: "hermesConfigRuntime",
    };
  }

  // 4. Infer from model name prefix
  if (model) {
    const inferred = inferProviderFromModel(model);
    if (inferred) {
      return { provider: inferred, resolvedFrom: "modelInference" };
    }
  }

  // 5. Let Hermes auto-detect
  return { provider: "auto", resolvedFrom: "auto" };
}

/**
 * The provider, its source and the `-m` decision a run will actually use, resolved together so the
 * run and the environment test cannot classify a config differently (TECH-7895).
 */
export type EffectiveRunConfig =
  | {
      ok: true;
      provider: string;
      resolvedFrom: string;
      /** True when this run uses the Ramp Router provider (and so must pass every Router gate). */
      isRouter: boolean;
      /** Value for `hermes chat -m`; undefined omits the flag. */
      modelArg: string | undefined;
      /** Model Hermes will actually use, when known (for logs/results). */
      effectiveModel: string | undefined;
    }
  | { ok: false; provider: string; resolvedFrom: string; isRouter: boolean; message: string };

/**
 * Resolve a run's effective provider and model in one place.
 *
 * Legacy resolution (resolveProvider + resolveModelArg) is kept for everything except the cases where
 * the host Hermes config would silently make the run a Ramp Router run:
 *  - an explicit concrete provider (anything but "auto") always wins, even over a Router host default;
 *  - with no provider (or a genuinely deferring explicit "auto"), a host config whose provider is
 *    `router` decides the provider when the agent sets no model or the SAME model as the host
 *    default. A different agent model keeps legacy inference (never prefix-inferred as Router);
 *  - `detected` must be null when the deployment is host-isolated: hosted runs never read the host.
 *
 * Router runs use a fresh profile that has no host `model` section, so a Router run that relies on a
 * Hermes default model pins it explicitly as `-m` — only when that default is a Router default (host
 * provider `router`). An explicit Router config with no model and no Router default fails as a missing
 * model, as it always did with no default. Non-Router runs keep omitting `-m` for a Hermes default.
 */
export function resolveEffectiveRunConfig(options: {
  explicitProvider: string | undefined;
  /** Raw configured model; the legacy "auto" sentinel and blanks mean "no model". */
  configuredModel: string | undefined;
  detected: DetectedModel | null | undefined;
}): EffectiveRunConfig {
  const configuredModel = normalizeConfiguredModel(options.configuredModel);
  const { explicitProvider, detected } = options;
  const explicitIsValid =
    !!explicitProvider && (VALID_PROVIDERS as readonly string[]).includes(explicitProvider);
  const defersToHost = !explicitIsValid || explicitProvider === "auto";
  const hostIsRouter = !!detected?.model && detected.provider.trim().toLowerCase() === ROUTER_PROVIDER;
  const sameModelAsHost =
    !configuredModel || (!!detected?.model && detected.model.toLowerCase() === configuredModel.toLowerCase());

  let provider: string;
  let resolvedFrom: string;
  if (defersToHost && hostIsRouter && sameModelAsHost) {
    provider = ROUTER_PROVIDER;
    resolvedFrom = configuredModel ? "hermesConfig" : "hermesConfigDefault";
  } else {
    ({ provider, resolvedFrom } = resolveProvider({
      explicitProvider,
      detectedProvider: detected?.provider,
      detectedModel: detected?.model,
      detectedBaseUrl: detected?.baseUrl,
      detectedHasApiKey: detected?.hasApiKey,
      detectedApiMode: detected?.apiMode,
      model: configuredModel,
    }));
  }
  const isRouter = provider.trim().toLowerCase() === ROUTER_PROVIDER;

  if (!isRouter) {
    const modelArg = resolveModelArg({ configuredModel, explicitProvider, hermesDefaultModel: detected?.model });
    if (!modelArg.ok) return { ok: false, provider, resolvedFrom, isRouter, message: modelArg.message };
    return { ok: true, provider, resolvedFrom, isRouter, modelArg: modelArg.arg, effectiveModel: modelArg.effectiveModel };
  }
  // A Router profile carries no host model section, so a Hermes default can only be used by pinning
  // it as `-m` — and only a genuinely Router default (host provider `router`) is pinned. An unrelated
  // host default is never borrowed: with no configured model it is the usual missing-model failure.
  const routerDefault = hostIsRouter ? detected?.model : undefined;
  const modelArg = resolveModelArg({ configuredModel, explicitProvider: ROUTER_PROVIDER, hermesDefaultModel: routerDefault });
  if (!modelArg.ok) return { ok: false, provider, resolvedFrom, isRouter, message: modelArg.message };
  const arg = modelArg.arg ?? modelArg.effectiveModel;
  return { ok: true, provider, resolvedFrom, isRouter, modelArg: arg, effectiveModel: modelArg.effectiveModel };
}
