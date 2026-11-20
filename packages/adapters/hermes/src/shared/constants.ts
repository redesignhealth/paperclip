/**
 * Shared constants for the Hermes Agent adapter.
 */

/** Adapter type identifier registered with Paperclip. */
export const ADAPTER_TYPE = "hermes_local";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "Hermes Agent";

/** Default CLI binary name. */
export const HERMES_CLI = "hermes";

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 1800;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 10;

/**
 * Default model to use if none specified.
 *
 * Use "auto" so that Hermes resolves the model from the user's local
 * ~/.hermes/config.yaml — preventing the adapter from overriding a
 * user's configured default (e.g. MiniMax, OpenRouter, etc.) with a
 * hardcoded Anthropic model during Paperclip onboarding.
 */
export const DEFAULT_MODEL = "auto";

/**
 * Valid --provider choices for the hermes CLI.
 * Must stay in sync with `hermes chat --help`.
 *
 * `openai-api` is Hermes's direct OpenAI Platform provider (hermes_cli/auth.py: OPENAI_API_KEY
 * against https://api.openai.com/v1). Without it here, an agent given an OPENAI_API_KEY (for
 * example Paperclip's platform-default key binding) cannot be pointed at it: the adapter falls
 * back to "auto" and Hermes treats the key as an OpenRouter credential, failing with
 * "HTTP 401: Missing Authentication header" from openrouter.ai (TECH-7348).
 */
export const VALID_PROVIDERS = [
  "auto",
  "router",
  "openrouter",
  "nous",
  "openai-api",
  "openai-codex",
  "copilot",
  "copilot-acp",
  "anthropic",
  "huggingface",
  "zai",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "kilocode",
] as const;

/**
 * Ramp Router provider name in Hermes (`--provider router`).
 *
 * Hermes >= 2026.9.14 ships a native `router` provider (Responses API,
 * https://api.router.com/v1) authenticated with RAMP_ROUTER_API_KEY.
 */
export const ROUTER_PROVIDER = "router";

/**
 * Default model suggested for new Ramp Router agents.
 *
 * Router model IDs look like vendor IDs, so this is only a default and never an
 * allowlist: Hermes accepts any model ID Router's own catalog exposes, and the
 * Paperclip UI keeps manual entry.
 */
export const ROUTER_DEFAULT_MODEL = "auto-jev-routing";

/**
 * Model-name prefix → provider hint mapping.
 * Used when no explicit provider is configured and we need to infer
 * the correct provider from the model string alone.
 *
 * Deliberately no `router` entry: Router model IDs look like vendor IDs
 * (Anthropic, OpenAI, …), so inferring Router from a model name would silently
 * steal models meant for those providers. Router is selected explicitly.
 *
 * Keys are lowercased prefix patterns; values must be valid provider names.
 * Longer prefixes are matched first (order matters).
 */
export const MODEL_PREFIX_PROVIDER_HINTS: [string, string][] = [
  // OpenAI-native models
  ["gpt-4", "openai-codex"],
  ["gpt-5", "copilot"],
  ["o1-", "openai-codex"],
  ["o3-", "openai-codex"],
  ["o4-", "openai-codex"],
  // Anthropic models
  ["claude", "anthropic"],
  // Google models (via openrouter or direct)
  ["gemini", "auto"],
  // Nous models
  ["hermes-", "nous"],
  // Z.AI / GLM models
  ["glm-", "zai"],
  // Kimi / Moonshot
  ["moonshot", "kimi-coding"],
  ["kimi", "kimi-coding"],
  // MiniMax
  ["minimax", "minimax"],
  // DeepSeek
  ["deepseek", "auto"],
  // Meta Llama
  ["llama", "auto"],
  // Qwen
  ["qwen", "auto"],
  // Mistral
  ["mistral", "auto"],
  // HuggingFace models (org/model format)
  ["huggingface/", "huggingface"],
];

/** Regex to extract session ID from Hermes CLI output. */
export const SESSION_ID_REGEX = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
export const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
export const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

/** Prefix used by Hermes for tool output lines. */
export const TOOL_OUTPUT_PREFIX = "┊";

/** Prefix for Hermes thinking blocks. */
export const THINKING_PREFIX = "💭";

/**
 * Hermes's tool-name auto-repair notice, printed by `agent/turn_tool_validation.py:95`
 * (pinned hermes-agent 0.21.3 / v2026.9.14):
 *
 *   print(f"{agent.log_prefix}🔧 Auto-repaired tool name: '{old}' -> '{new}'")
 *
 * It is a bare `print()` — the only status emission in that function that does not go through
 * `_vprint`/`_buffer_vprint` — so it is the one notice that survives `hermes chat -Q`
 * (`suppress_status_output`) and lands in captured stdout. It is an operator notice about the
 * runtime, never part of the model's answer, and Paperclip publishes surviving stdout to the
 * provider thread verbatim. See TECH-8974.
 *
 * Shape: optional whitespace and single `log_prefix` token, U+1F527 WRENCH (optionally VS16),
 * the fixed phrase, and the quoted old -> new pair at end of line. Both start-bounded (permitting
 * only whitespace and at most one non-whitespace prefix token) and end-anchored, so ordinary
 * prose like "Hermes reported: 🔧 Auto-repaired..." is not matched.
 */
export const HERMES_TOOL_REPAIR_NOTICE_RE =
  /^\s*(?:\S+\s+)?\u{1F527}\uFE0F?\s*Auto-repaired tool name: '[^']*'\s*->\s*'[^']*'\s*$/u;

