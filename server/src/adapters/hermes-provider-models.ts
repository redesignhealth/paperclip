import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as claudeModels } from "@paperclipai/adapter-claude-local";
import { models as codexModels } from "@paperclipai/adapter-codex-local";
import { badRequest } from "../errors.js";
import { listOpenRouterModels } from "../services/openrouter-models.js";

/**
 * Model suggestions for the Hermes Local setup wizard, keyed by the selected API key provider.
 *
 * These are suggestions, not an allowlist: Hermes accepts any model ID, so providers without a
 * catalog here (for example zai, groq, ollama) get an empty list and the UI keeps its manual entry.
 * The static lists do not claim to match what a given account can use, and they require no API key
 * and make no vendor call. Only OpenRouter reuses its existing public discovery.
 *
 * Ramp Router is a catalog provider that serves an empty list rather than sitting in the no-catalog
 * group: it is listed in HERMES_CATALOG_PROVIDERS so the route answers [] (wizard manual model entry)
 * instead of falling through to operator-declared models. Its model IDs depend on the account, and
 * this module's rule is no API key => no vendor call, so Router does no key-authenticated lookup.
 */

// Provider names are short lowercase slugs (openrouter, kimi-coding, openai-api, ...). Validate
// syntax only, so a legitimate provider Paperclip has no catalog for is not rejected.
const HERMES_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * IDs that the OpenAI API (Responses/Chat) accepts, taken from the existing Codex adapter catalog.
 * The Codex catalog is a CLI subscription list and also carries CLI aliases that are not API model
 * IDs (`codex-mini-latest`), so it is filtered rather than served as-is. Adding an ID here only
 * ever selects from that catalog; it never introduces one.
 */
const OPENAI_API_COMPATIBLE_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.6-sol",
  "gpt-6-astra",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "o3",
  "o4-mini",
  "o3-mini",
]);

export const HERMES_OPENAI_API_MODELS: readonly AdapterModel[] = codexModels.filter((model) =>
  OPENAI_API_COMPATIBLE_MODEL_IDS.has(model.id),
);

export const HERMES_ANTHROPIC_API_MODELS: readonly AdapterModel[] = claudeModels;

/**
 * Normalize the `provider` query value. Absent or blank means "no provider chosen". A repeated
 * (array) or structured value, or a value that is not a plausible provider slug, is rejected so
 * nothing unvalidated reaches provider routing.
 */
export function parseHermesProviderQuery(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") throw badRequest("provider must be a single string");
  const provider = raw.trim().toLowerCase();
  if (!provider) return null;
  if (!HERMES_PROVIDER_PATTERN.test(provider)) throw badRequest("provider is not a valid provider name");
  return provider;
}

const OPENROUTER_ID_PREFIX = "openrouter/";

/**
 * The shared OpenRouter discovery prefixes every ID with `openrouter/` for opencode
 * (`openrouter/anthropic/claude-sonnet-4-6`). Hermes selects OpenRouter with an explicit provider and
 * passes the model through unchanged, so it needs the native OpenRouter ID (`anthropic/claude-sonnet-4-6`).
 * Strip exactly one prefix, so OpenRouter's own `openrouter/free` (served as `openrouter/openrouter/free`)
 * becomes `openrouter/free`. Returns a copy; the shared catalog entries are never mutated.
 */
function stripOpenRouterIdPrefix(model: AdapterModel): AdapterModel {
  return model.id.startsWith(OPENROUTER_ID_PREFIX)
    ? { ...model, id: model.id.slice(OPENROUTER_ID_PREFIX.length) }
    : { ...model };
}

// "router" is in this set even though it serves no catalog: its model IDs depend on the account, so
// the route must answer with an empty list (wizard manual entry) instead of falling through to
// operator-declared models, and must never make a key-authenticated vendor call.
const HERMES_CATALOG_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "openrouter", "router"]);

/**
 * Whether `listHermesProviderModels` serves a catalog for this provider (an OpenRouter discovery that
 * returns an empty list still counts, and Ramp Router deliberately serves an empty list). Without a
 * provider, or for one with no catalog, the route falls back to the registry list (operator-declared
 * models, adapter overrides), as for any other adapter.
 */
export function hasHermesProviderCatalog(provider: string | null): provider is string {
  return provider !== null && HERMES_CATALOG_PROVIDERS.has(provider);
}

export async function listHermesProviderModels(
  provider: string | null,
  refresh: boolean,
): Promise<AdapterModel[]> {
  switch (provider) {
    case "anthropic":
      return [...HERMES_ANTHROPIC_API_MODELS];
    case "openai":
      return [...HERMES_OPENAI_API_MODELS];
    case "openrouter":
      return (await listOpenRouterModels(refresh)).map(stripOpenRouterIdPrefix);
    // Ramp Router's catalog depends on the account, and this module makes no vendor call without a
    // key, so Router falls back to the wizard's manual model entry.
    case "router":
      return [];
    default:
      return [];
  }
}
