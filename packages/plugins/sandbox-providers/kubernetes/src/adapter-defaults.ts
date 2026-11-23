import type { AdapterRegistryEntry } from "./adapter-registry.js";
import { resolveServerImageRef, type ServerImageRefDeps } from "./server-image-ref.js";

export interface AdapterDefaults {
  runtimeImage: string;
  envKeys: string[];
  allowFqdns: string[];
  probeCommand: string[];
  /** Non-secret env injected as the base layer for the Job (process-env wins on top). */
  defaultEnv?: Record<string, string>;
}

const REGISTRY: Record<string, AdapterDefaults> = {
  claude_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["claude", "--version"],
  },
  codex_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-codex:v1",
    envKeys: ["OPENAI_API_KEY"],
    allowFqdns: ["api.openai.com"],
    probeCommand: ["codex", "--version"],
  },
  gemini_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-gemini:v1",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    allowFqdns: ["generativelanguage.googleapis.com"],
    probeCommand: ["gemini", "--version"],
  },
  cursor_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-cursor:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com"],
    probeCommand: ["cursor-agent", "--version"],
  },
  opencode_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-opencode:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com", "openrouter.ai"],
    probeCommand: ["opencode", "--version"],
  },
  pi_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-pi:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["pi", "--version"],
  },
};

export const KNOWN_ADAPTER_TYPES: ReadonlySet<string> = new Set(Object.keys(REGISTRY));

function fromRegistryEntry(entry: AdapterRegistryEntry): AdapterDefaults {
  // Only runtimeImage is strictly required. The array fields are optional and
  // default to []: the operator emits them with `omitempty`, so a genuinely
  // empty allowFqdns/envKeys/probeCommand arrives as undefined, which is valid
  // (no extra egress / no forwarded secrets / no probe), NOT an error.
  if (!entry.runtimeImage?.trim()) {
    throw new Error(
      `Adapter "${entry.adapterType}" is missing required runtime field: runtimeImage ` +
        `(use getAdapterDefaultsResolved to default it to the server's own image)`,
    );
  }
  return {
    runtimeImage: entry.runtimeImage,
    envKeys: entry.envKeys ?? [],
    allowFqdns: entry.allowFqdns ?? [],
    probeCommand: entry.probeCommand ?? [],
    defaultEnv: entry.defaultEnv,
  };
}

/**
 * Resolve the runtime defaults for an adapter. When a `registry` is supplied it
 * is authoritative (replace semantics): the type MUST be present and complete,
 * else this throws. With no registry, falls back to the built-in REGISTRY.
 */
export function getAdapterDefaults(
  adapterType: string,
  registry?: readonly AdapterRegistryEntry[],
): AdapterDefaults {
  if (registry && registry.length > 0) {
    const entry = registry.find((e) => e.adapterType === adapterType);
    if (!entry) {
      throw new Error(`Adapter "${adapterType}" is not in the configured adapter registry`);
    }
    return fromRegistryEntry(entry);
  }
  const defaults = REGISTRY[adapterType];
  if (!defaults) {
    throw new Error(`Unknown adapter type: ${adapterType}`);
  }
  return defaults;
}

/**
 * Async variant of getAdapterDefaults: a registry entry with an unset/empty
 * `runtimeImage` defaults to the digest of the running server's own image
 * (TECH-9856), so sandbox pods follow deploys. An explicit `runtimeImage` is
 * used unchanged. Throws (no stale/default fallback) if the server image
 * cannot be determined.
 */
export async function getAdapterDefaultsResolved(
  adapterType: string,
  registry?: readonly AdapterRegistryEntry[],
  deps?: ServerImageRefDeps,
): Promise<AdapterDefaults> {
  const entry =
    registry && registry.length > 0
      ? registry.find((e) => e.adapterType === adapterType)
      : undefined;
  if (!entry || entry.runtimeImage?.trim()) {
    return getAdapterDefaults(adapterType, registry);
  }
  let image: string;
  try {
    image = await resolveServerImageRef(deps);
  } catch (err) {
    throw new Error(
      `Adapter "${adapterType}" has no runtimeImage and the server image could not be resolved: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Set runtimeImage explicitly or fix the server image reference.`,
    );
  }
  return getAdapterDefaults(
    adapterType,
    registry!.map((e) => (e === entry ? { ...e, runtimeImage: image } : e)),
  );
}

/**
 * Resolve the adapter type for a single run: prefer the run's adapter (the agent's,
 * from the lease params) so one environment can serve mixed harnesses; fall back to
 * the environment's configured default adapter when the run does not specify one.
 */
export function resolveRunAdapterType(
  runAdapterType: string | null | undefined,
  configAdapterType: string,
): string {
  const trimmed = typeof runAdapterType === "string" ? runAdapterType.trim() : "";
  return trimmed.length > 0 ? trimmed : configAdapterType;
}

/**
 * Build the per-run env for the Job: the non-secret `defaultEnv` is the base
 * and the process-env values (the secret API keys named by `envKeys`) override
 * it. Pure for testability.
 */
export function buildAdapterEnv(
  defaults: AdapterDefaults,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ...(defaults.defaultEnv ?? {}) };
  for (const k of defaults.envKeys) {
    const v = processEnv[k];
    if (v) out[k] = v;
  }
  return out;
}
