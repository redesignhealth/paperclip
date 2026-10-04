export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentKnowledgeConfig {
  readonly enabled: boolean;
  readonly pilotCompanyIds: readonly string[];
}

export class AgentKnowledgeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKnowledgeConfigurationError";
  }
}

/**
 * Parses and validates agent knowledge ledger configuration.
 *
 * Rules:
 * - PAPERCLIP_AGENT_KNOWLEDGE_ENABLED must be exactly case-sensitive "true" or "false" (after trim).
 * - When unset or empty string: defaults to false (disabled).
 * - ANY other non-empty value (e.g. "TRUE", "True", "1", "yes", typos) throws AgentKnowledgeConfigurationError.
 * - When enabled (true):
 *   - PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES must be a non-empty, comma-separated list of valid UUIDs only.
 *   - Wildcard '*' or non-UUID strings are strictly invalid.
 */
export function parseAgentKnowledgeConfig(env: NodeJS.ProcessEnv = process.env): AgentKnowledgeConfig {
  const rawEnabled = env.PAPERCLIP_AGENT_KNOWLEDGE_ENABLED?.trim();

  let isEnabled = false;
  if (rawEnabled === undefined || rawEnabled === "") {
    isEnabled = false;
  } else if (rawEnabled === "false") {
    isEnabled = false;
  } else if (rawEnabled === "true") {
    isEnabled = true;
  } else {
    throw new AgentKnowledgeConfigurationError(
      "PAPERCLIP_AGENT_KNOWLEDGE_ENABLED must be exactly 'true' or 'false' (case-sensitive)",
    );
  }

  if (!isEnabled) {
    return {
      enabled: false,
      pilotCompanyIds: Object.freeze([]),
    };
  }

  const rawAllowlist = env.PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES?.trim();
  if (!rawAllowlist) {
    throw new AgentKnowledgeConfigurationError(
      "PAPERCLIP_AGENT_KNOWLEDGE_ENABLED is true but PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES is missing or empty. A non-empty UUID-only pilot allowlist is required.",
    );
  }

  const items = rawAllowlist
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (items.length === 0) {
    throw new AgentKnowledgeConfigurationError(
      "PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES contains no valid entries",
    );
  }

  for (const item of items) {
    if (item === "*" || !UUID_REGEX.test(item)) {
      throw new AgentKnowledgeConfigurationError(
        "PAPERCLIP_AGENT_KNOWLEDGE_PILOT_COMPANIES contains an invalid entry. Wildcard '*' is forbidden; each entry must be a valid UUID.",
      );
    }
  }

  return {
    enabled: true,
    pilotCompanyIds: Object.freeze(Array.from(new Set(items))),
  };
}

let cachedConfig: AgentKnowledgeConfig | null = null;
let testConfigOverride: AgentKnowledgeConfig | null = null;

export function getAgentKnowledgeConfig(): AgentKnowledgeConfig {
  if (testConfigOverride) {
    return testConfigOverride;
  }
  if (!cachedConfig) {
    cachedConfig = parseAgentKnowledgeConfig(process.env);
  }
  return cachedConfig;
}

export function isAgentKnowledgeEnabledForCompany(
  companyId: string,
  config: AgentKnowledgeConfig = getAgentKnowledgeConfig(),
): boolean {
  if (!config.enabled) return false;
  return config.pilotCompanyIds.includes(companyId.toLowerCase());
}

/**
 * Dependency-injection hook for tests to inject in-memory configuration.
 * Note: tests must use this programmatic DI hook; environment variables cannot select
 * a fake provider.
 */
export function setAgentKnowledgeConfigForTests(config: AgentKnowledgeConfig | null): void {
  testConfigOverride = config;
}

export function resetAgentKnowledgeConfigForTests(): void {
  cachedConfig = null;
  testConfigOverride = null;
}

/**
 * Production boot-time guard.
 * If PAPERCLIP_AGENT_KNOWLEDGE_ENABLED is true at production boot, it must fail with
 * a clear diagnostic because no real authority adapter exists in this build.
 */
export function validateAgentKnowledgeConfigAtBoot(env: NodeJS.ProcessEnv = process.env): void {
  const config = parseAgentKnowledgeConfig(env);
  if (config.enabled) {
    throw new AgentKnowledgeConfigurationError(
      "PAPERCLIP_AGENT_KNOWLEDGE_ENABLED is true, but no authority adapter is available in this build (deferred to future milestone). Live agent knowledge cannot be enabled at boot without a registered authority adapter.",
    );
  }
  cachedConfig = config;
}
