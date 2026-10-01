import { DEFAULT_MODEL } from "../shared/constants.js";

export type ModelArgResolution =
  | {
      ok: true;
      /** Value for `hermes chat -m`; undefined means omit the flag. */
      arg: string | undefined;
      /** Model Hermes will actually use, when known (for logs/results). */
      effectiveModel: string | undefined;
    }
  | { ok: false; message: string };

/**
 * "auto" is the legacy sentinel for "no model chosen". Hermes has no model
 * named "auto", so it must never reach `hermes chat -m`.
 */
export function normalizeConfiguredModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === DEFAULT_MODEL) return undefined;
  return trimmed;
}

/**
 * Decide the value for `-m`.
 *
 * - An explicit model is always passed.
 * - With no model, the flag is omitted when Hermes has a real default to fall
 *   back on (model.default in its config).
 * - An explicit provider with no model and no Hermes default would leave Hermes
 *   without any model to run, so fail before spawning.
 */
export function resolveModelArg(options: {
  configuredModel: string | undefined;
  explicitProvider: string | undefined;
  hermesDefaultModel: string | undefined;
}): ModelArgResolution {
  const configured = normalizeConfiguredModel(options.configuredModel);
  if (configured) return { ok: true, arg: configured, effectiveModel: configured };

  const hermesDefault = options.hermesDefaultModel?.trim();
  if (hermesDefault) return { ok: true, arg: undefined, effectiveModel: hermesDefault };

  // provider "auto" means "let Hermes decide", the same as no provider.
  const provider = options.explicitProvider?.trim();
  if (provider && provider.toLowerCase() !== "auto") {
    return {
      ok: false,
      message:
        `Hermes provider "${provider}" is set but no model is configured and ` +
        "Hermes has no default model. Set a model on the agent, or set model.default in the Hermes config.",
    };
  }
  return { ok: true, arg: undefined, effectiveModel: undefined };
}
