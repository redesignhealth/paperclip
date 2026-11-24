import { isOpenRouterUrl, openRouterAttributionHeaders } from "@paperclipai/adapter-utils/openrouter-attribution";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { modelRelayProviderNameOk, type ModelRelayEntry } from "@paperclipai/adapter-utils/model-relay";
import { PI_MCP_CONFIG_FILE } from "./mcp-config.js";

type PreparedPiRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  /** The managed agent-config dir, or null when no provider config was written. */
  agentConfigDir: string | null;
  /** TECH-10174: providers whose key was taken out of the pod. Empty unless `modelRelay` was requested. */
  relayedProviders: Record<string, ModelRelayEntry>;
  /** Env names the pod must not receive because their value is now held host-side. */
  droppedEnvKeys: string[];
  cleanup: () => Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. an LLM-gateway virtual key) into models.json
// SERVER-SIDE, where the value is reliably present. Prefer Pi's own env reference
// (`$NAME` or `${NAME}`, resolved from the run env at request time) so the secret is
// never written to models.json. A bare NAME is a literal key in Pi 0.87. Unresolvable
// placeholders are left intact; an env var set to an empty string counts as unresolvable.
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

type ParsedProviderConfig = {
  providers: Record<string, unknown> | null;
  warning: string | null;
};

export function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
): ParsedProviderConfig {
  // Unset/empty (or an empty JSON object) is the normal "feature off" case: no warning.
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { providers: null, warning: null };
  }
  // A SET but unusable value is a misconfiguration; surface it so the run does
  // not proceed silently unconfigured and fail later with an opaque
  // model-not-found error pointing nowhere near the env var.
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {
        providers: null,
        warning: "PAPERCLIP_PI_PROVIDERS is set but is not a JSON object; custom providers ignored.",
      };
    }
    // Only keep provider entries that are themselves objects; surface the ones
    // we drop so a malformed entry is just as diagnosable as malformed JSON.
    const providers: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
      else skipped.push(key);
    }
    return {
      providers: Object.keys(providers).length > 0 ? providers : null,
      warning: skipped.length > 0
        ? `PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`
        : null,
    };
  } catch {
    return {
      providers: null,
      warning: "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    };
  }
}

// Names only, never values. Pi 0.87 resolves an apiKey of `$NAME` or `${NAME}` from the run env at request time,
// `!cmd` by running it, and anything else (including a bare NAME) as the literal key.
const PI_ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
function apiKeyWarnings(providers: Record<string, unknown>, env: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, provider] of Object.entries(providers)) {
    const apiKey = isPlainObject(provider) ? provider.apiKey : undefined;
    if (typeof apiKey !== "string" || apiKey.startsWith("!")) continue;
    const referenced = [...apiKey.matchAll(PI_ENV_REFERENCE)].map((match) => match[1] ?? match[2]);
    for (const variable of new Set(referenced)) {
      if (!env[variable]) {
        out.push(`PAPERCLIP_PI_PROVIDERS: provider "${name}" apiKey references env var ${variable}, which is missing or empty in the run env.`);
      }
    }
    // Never echo the value: a literal key can look like an env var name.
    if (referenced.length === 0 && /^[A-Z][A-Z0-9_]*$/.test(apiKey)) {
      out.push(`PAPERCLIP_PI_PROVIDERS: provider "${name}" apiKey looks like a bare env var name, which Pi 0.87 sends as a literal key. Write it as $NAME.`);
    }
  }
  return out;
}

/** The in-pod key every relayed provider uses: the run's bridge token, which only the pod's loopback gateway accepts. */
const RELAY_PROVIDER_API_KEY = "$PAPERCLIP_API_KEY";
/** Written into models.json until the bridge is up; `pointRelayedProvidersAtBridge` replaces it. */
const RELAY_PLACEHOLDER_ORIGIN = "http://127.0.0.1:0";
const ROUTER_PROVIDER_NAME = "ramp-router";
const ROUTER_KEY_ENV = "RAMP_ROUTER_API_KEY";
const WHOLE_ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/;

// TECH-10174: take the model gateway key out of the pod. A provider is relayed when it is the Ramp Router provider (or reads
// RAMP_ROUTER_API_KEY), has an https baseUrl, and its key resolves from the run env or is a literal. The key and the real
// baseUrl move to the host-side relay registry; models.json keeps only the relay path and the bridge token reference.
//
// A model entry (in `models` or `modelOverrides`) may override the provider's `baseUrl` and `apiKey` (Router serves Claude over
// the Messages API at the host root, so those models carry their own baseUrl). Every such override is rewritten too. Each distinct
// (baseUrl, key) pair gets its own relay entry: the first is named after the provider, later ones `<provider>-m<N>`.
// If any part of a provider cannot be relayed safely (a `!command` key, an unresolved env reference, an auth header), the whole
// provider is left as it was and nothing of it is relayed, so no half-rewritten config is ever produced.
function resolveRelayKey(apiKey: string, env: Record<string, string>): { value: string; envName: string | null } | null {
  if (apiKey.startsWith("!")) return null;
  const reference = WHOLE_ENV_REFERENCE.exec(apiKey);
  const envName = reference ? (reference[1] ?? reference[2] ?? null) : null;
  const value = envName ? env[envName] : apiKey;
  if (!value || /[\r\n\0$]/.test(value)) return null;
  return { value, envName };
}

function modelEntries(provider: Record<string, unknown>): Record<string, unknown>[] {
  return [
    ...(Array.isArray(provider.models) ? provider.models : []),
    ...(isPlainObject(provider.modelOverrides) ? Object.values(provider.modelOverrides) : []),
  ].filter(isPlainObject);
}

function hasAuthHeader(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).some((name) => /^(authorization|x-api-key|api-key|proxy-authorization)$/i.test(name));
}

function relayOneProvider(
  name: string,
  provider: Record<string, unknown>,
  env: Record<string, string>,
): { entries: Record<string, ModelRelayEntry>; droppedEnvKeys: string[] } | null {
  const apiKey = provider.apiKey;
  const baseUrl = provider.baseUrl;
  if (typeof apiKey !== "string" || typeof baseUrl !== "string") return null;
  const providerKey = resolveRelayKey(apiKey, env);
  if (!providerKey || !baseUrl.startsWith("https://")) return null;
  if (name !== ROUTER_PROVIDER_NAME && providerKey.envName !== ROUTER_KEY_ENV) return null;
  if (hasAuthHeader(provider.headers)) return null;

  const entries: Record<string, ModelRelayEntry> = {};
  const names = new Map<string, string>();
  const droppedEnvKeys: string[] = providerKey.envName ? [providerKey.envName] : [];
  const nameFor = (upstreamBaseUrl: string, key: string): string => {
    const id = `${upstreamBaseUrl}\n${key}`;
    let relayName = names.get(id);
    if (!relayName) {
      relayName = names.size === 0 ? name : `${name}-m${names.size}`;
      names.set(id, relayName);
      entries[relayName] = { upstreamBaseUrl, apiKey: key };
    }
    return relayName;
  };
  // The provider's own pair is always first, so it keeps the provider name.
  const providerRelay = nameFor(baseUrl, providerKey.value);
  const rewrites: Array<() => void> = [() => {
    provider.baseUrl = `${RELAY_PLACEHOLDER_ORIGIN}/api/model-relay/${providerRelay}`;
    provider.apiKey = RELAY_PROVIDER_API_KEY;
  }];
  for (const model of modelEntries(provider)) {
    const hasBase = model.baseUrl !== undefined;
    const hasKey = model.apiKey !== undefined;
    if (hasAuthHeader(model.headers)) return null;
    if (!hasBase && !hasKey) continue;
    if (hasBase && (typeof model.baseUrl !== "string" || !model.baseUrl.startsWith("https://"))) return null;
    let modelKey = providerKey;
    if (hasKey) {
      const resolved = typeof model.apiKey === "string" ? resolveRelayKey(model.apiKey, env) : null;
      if (!resolved) return null;
      modelKey = resolved;
      if (resolved.envName) droppedEnvKeys.push(resolved.envName);
    }
    const relayName = nameFor(hasBase ? (model.baseUrl as string) : baseUrl, modelKey.value);
    rewrites.push(() => {
      model.baseUrl = `${RELAY_PLACEHOLDER_ORIGIN}/api/model-relay/${relayName}`;
      if (hasKey) model.apiKey = RELAY_PROVIDER_API_KEY;
    });
  }
  if (Object.keys(entries).some((relayName) => !modelRelayProviderNameOk(relayName))) return null;
  for (const rewrite of rewrites) rewrite();
  return { entries, droppedEnvKeys };
}

function relayProviders(
  providers: Record<string, unknown>,
  env: Record<string, string>,
): { relayed: Record<string, ModelRelayEntry>; droppedEnvKeys: string[] } {
  const relayed: Record<string, ModelRelayEntry> = {};
  const droppedEnvKeys: string[] = [];
  for (const [name, provider] of Object.entries(providers)) {
    if (!isPlainObject(provider) || !modelRelayProviderNameOk(name)) continue;
    const result = relayOneProvider(name, provider, env);
    if (!result) continue;
    Object.assign(relayed, result.entries);
    droppedEnvKeys.push(...result.droppedEnvKeys);
  }
  // The raw provider config can itself carry a literal key; the pod never needs it.
  const raw = env.PAPERCLIP_PI_PROVIDERS;
  if (raw && Object.values(relayed).some((entry) => raw.includes(entry.apiKey))) droppedEnvKeys.push("PAPERCLIP_PI_PROVIDERS");
  return { relayed, droppedEnvKeys: [...new Set(droppedEnvKeys)] };
}

/**
 * Rewrites every relay placeholder baseUrl (provider level and per-model) in a models.json body to the bridge URL.
 * Returns null when nothing changed.
 */
export function pointRelayedProvidersAtBridge(modelsJson: string, apiUrl: string): string | null {
  const parsed = JSON.parse(modelsJson) as { providers?: Record<string, unknown> };
  const origin = apiUrl.trim().replace(/\/+$/, "");
  let changed = false;
  const point = (target: Record<string, unknown>) => {
    if (typeof target.baseUrl === "string" && target.baseUrl.startsWith(`${RELAY_PLACEHOLDER_ORIGIN}/`)) {
      target.baseUrl = `${origin}${target.baseUrl.slice(RELAY_PLACEHOLDER_ORIGIN.length)}`;
      changed = true;
    }
  };
  for (const provider of Object.values(parsed.providers ?? {})) {
    if (!isPlainObject(provider)) continue;
    point(provider);
    for (const model of modelEntries(provider)) point(model);
  }
  return changed ? `${JSON.stringify(parsed, null, 2)}\n` : null;
}

// Materialize custom Pi providers supplied via PAPERCLIP_PI_PROVIDERS (a JSON
// object in Pi's models.json "providers" shape) into a managed agent-config dir.
//
// Pi has no base-url CLI flag or env var: the only mechanism for pointing it at a
// custom/OpenAI- or Anthropic-compatible endpoint is a models.json file in its
// agent config dir, which Pi resolves from $PI_CODING_AGENT_DIR (falling back to
// $HOME/.pi/agent). Pi resolves `--provider P --model M` by an exact (provider,
// model id) match against that registry, so routing a gateway model requires the
// provider entry to enumerate its models explicitly. We accept the providers as
// config (not hard-coded) so the gateway URL, key, and model list stay declarative.
//
// When PAPERCLIP_PI_PROVIDERS is set we write {"providers": ...} to a fresh temp
// dir and point PI_CODING_AGENT_DIR at it; the managed dir intentionally replaces
// the host agent dir (credentials travel inside the providers config itself, via
// a literal apiKey or a server-side-expanded {env:VAR} placeholder). For remote
// execution targets, execute.ts ships the dir to the sandbox as a runtime asset
// and repoints PI_CODING_AGENT_DIR at the in-sandbox copy.
export async function preparePiRuntimeConfig(input: {
  env: Record<string, string>;
  /** TECH-9794: `mcp-adapter.json` body for the pi-mcp-adapter extension. Forces a managed dir even with no providers. */
  mcpConfig?: Record<string, unknown> | null;
  /** TECH-10174: sandbox pods with the bridge. The model gateway key stays host-side and the provider points at the relay. */
  modelRelay?: boolean;
}): Promise<PreparedPiRuntimeConfig> {
  // TECH-7076: `{env:NAME}` placeholders may read the SERVER env only when the provider config
  // itself came from the server env (an operator-authored setting). If it came from the agent's
  // own adapter env, resolve ONLY from that env, otherwise agent-controlled config could name any
  // server variable (BETTER_AUTH_SECRET, DATABASE_URL, ...) and have it written into a file the
  // agent can read.
  const providersFromAdapterEnv = input.env.PAPERCLIP_PI_PROVIDERS !== undefined;
  const resolveEnv = (name: string): string | undefined =>
    input.env[name] ?? (providersFromAdapterEnv ? undefined : process.env[name]);
  const { providers, warning: parseWarning } = parseProviderConfig(
    input.env.PAPERCLIP_PI_PROVIDERS ?? process.env.PAPERCLIP_PI_PROVIDERS,
    resolveEnv,
  );
  const { relayed, droppedEnvKeys } = providers && input.modelRelay
    ? relayProviders(providers, input.env)
    : { relayed: {} as Record<string, ModelRelayEntry>, droppedEnvKeys: [] as string[] };
  const keyWarnings = providers
    ? apiKeyWarnings(Object.fromEntries(Object.entries(providers).filter(([name]) => !(name in relayed))), input.env)
    : [];
  const warnings = [...(parseWarning ? [parseWarning] : []), ...keyWarnings];
  if (!providers && !input.mcpConfig) {
    return {
      env: input.env,
      notes: warnings,
      agentConfigDir: null,
      relayedProviders: relayed,
      droppedEnvKeys,
      cleanup: async () => {},
    };
  }

  for (const [name, provider] of Object.entries(providers ?? {})) {
    if (!isPlainObject(provider)) continue;
    if (isOpenRouterUrl(provider.baseUrl) || (name === "openrouter" && provider.baseUrl === undefined)) {
      provider.headers = openRouterAttributionHeaders(isPlainObject(provider.headers) ? provider.headers as Record<string, string> : {});
      const models = [
        ...(Array.isArray(provider.models) ? provider.models : []),
        ...(isPlainObject(provider.modelOverrides) ? Object.values(provider.modelOverrides) : []),
      ];
      for (const model of models) {
        if (isPlainObject(model)) model.headers = openRouterAttributionHeaders(isPlainObject(model.headers) ? model.headers as Record<string, string> : {});
      }
    }
  }
  const agentConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-agent-config-"));
  try {
    if (providers) {
      await fs.writeFile(
        path.join(agentConfigDir, "models.json"),
        `${JSON.stringify({ providers }, null, 2)}\n`,
        "utf8",
      );
    }
    if (input.mcpConfig) {
      await fs.writeFile(
        path.join(agentConfigDir, PI_MCP_CONFIG_FILE),
        `${JSON.stringify(input.mcpConfig, null, 2)}\n`,
        "utf8",
      );
    }
  } catch (err) {
    // Never leak the temp dir when the write fails (e.g. disk-full): the
    // caller only receives the cleanup handle on success.
    await fs.rm(agentConfigDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    env: {
      ...input.env,
      PI_CODING_AGENT_DIR: agentConfigDir,
    },
    notes: [
      ...warnings,
      ...(providers
        ? [`Injected ${Object.keys(providers).length} custom Pi provider(s) from PAPERCLIP_PI_PROVIDERS into a managed models.json: ${Object.keys(providers).join(", ")}.`]
        : []),
      ...(Object.keys(relayed).length > 0
        ? [`Model provider(s) routed through the Paperclip relay; no model key is in the sandbox: ${Object.keys(relayed).join(", ")}.`]
        : []),
      ...(input.mcpConfig ? ["Wrote a managed mcp-adapter.json (no credentials; servers point at the sandbox bridge relay)."] : []),
    ],
    agentConfigDir,
    relayedProviders: relayed,
    droppedEnvKeys,
    cleanup: async () => {
      await fs.rm(agentConfigDir, { recursive: true, force: true });
    },
  };
}
