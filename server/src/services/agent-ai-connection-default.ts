import {
  AI_PROVIDERS,
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiProvider,
} from "@paperclipai/shared";
import {
  currentAgentAuthPolicy,
  isManagedOnlyEnforced,
  type AgentAuthPolicy,
} from "@paperclipai/adapter-utils/agent-auth-policy";

// Only keys read by the child's provider express a child auth override.
// A config copied from another provider can retain unrelated keys.
const PROVIDER_AUTH_ENV_KEYS: Record<AiProvider, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
  openai: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "OPENAI_BASE_URL"],
  openrouter: ["OPENROUTER_API_KEY", "OPENCODE_AUTH_JSON", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "PAPERCLIP_OPENCODE_PROVIDERS"],
  xai: ["XAI_API_KEY", "GROK_API_KEY", "GROK_HOME", "XAI_BASE_URL"],
};

/** A hire inherits a connection choice, never its manager's credentials or identity. */
export function defaultAiConnectionForHire(
  adapterType: string,
  config: Record<string, unknown>,
  managerBinding: unknown,
  policy: AgentAuthPolicy = currentAgentAuthPolicy(),
): AiConnectionBinding | undefined {
  const compatible = (binding: AiConnectionBinding) =>
    isAiConnectionCompatible(binding, adapterType, config.model, config.provider, config.acpxAgent);
  const inherited = aiConnectionBindingSchema.safeParse(managerBinding);
  if (!inherited.success) {
    // TECH-7095: under managed_only an unbound managed-capable agent can never run (the
    // pre-spawn gate refuses it), and there is no host login to fall back to. Give the hire a
    // responsible_user binding so its responsible user's own provider default supplies the
    // credential at run time. Child env auth keys do not take precedence here: they would be
    // an unmanaged credential path, and a managed run strips them anyway.
    if (isManagedOnlyEnforced(policy)) {
      for (const provider of AI_PROVIDERS) {
        const binding = { provider, method: "api_key", mode: "responsible_user" } as const;
        if (compatible(binding)) return binding;
      }
    }
    // Unmanaged parents keep their existing login and credential-reference paths.
    return undefined;
  }
  const env = config.env && typeof config.env === "object" ? config.env as Record<string, unknown> : {};
  const withChildAuthPrecedence = (binding: AiConnectionBinding) =>
    // Under managed_only a child env auth key cannot replace the managed connection (see above).
    !isManagedOnlyEnforced(policy) && PROVIDER_AUTH_ENV_KEYS[binding.provider].some((key) => env[key] !== undefined) ? undefined : binding;
  if (inherited.data.mode !== "delegated" && compatible(inherited.data)) {
    return withChildAuthPrecedence(inherited.data);
  }
  // The selected provider's personal default supplies the actual sign-in method
  // at run time. A provider without an account can be connected on the first task.
  for (const provider of AI_PROVIDERS) {
    const binding = { provider, method: "api_key", mode: "responsible_user" } as const;
    if (compatible(binding)) return withChildAuthPrecedence(binding);
  }
  return undefined;
}
