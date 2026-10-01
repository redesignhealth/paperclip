import { UUID_REGEX } from "./company-memory-constants.js";

export interface CompanyMemoryConfig {
  readonly enabled: boolean;
  readonly adminDatabaseUrl: string | null;
  readonly pilotCompanyIds: readonly string[];
}

export class CompanyMemoryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyMemoryConfigurationError";
  }
}

/**
 * Parses and validates tenant-isolated company memory configuration.
 *
 * Rules:
 * - PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED must be exactly case-sensitive "true" or "false" (after trim).
 * - When unset or empty string: defaults to false (disabled).
 * - ANY other non-empty value (e.g. "TRUE", "True", "1", "yes", typos) throws CompanyMemoryConfigurationError.
 * - When enabled (true):
 *   - PAPERCLIP_MEMORY_ADMIN_DATABASE_URL must be a valid postgres: or postgresql: URL.
 *   - sslmode=require is strictly required in the URL query string.
 *   - PAPERCLIP_MEMORY_PILOT_COMPANIES must be a non-empty, comma-separated list of valid UUIDs only.
 *   - Wildcard '*' or non-UUID strings are strictly invalid.
 * - Configuration errors NEVER echo DSN, password, or raw user inputs.
 */
export function parseCompanyMemoryConfig(env: NodeJS.ProcessEnv = process.env): CompanyMemoryConfig {
  const rawEnabled = env.PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED?.trim();

  let isEnabled = false;
  if (rawEnabled === undefined || rawEnabled === "") {
    isEnabled = false;
  } else if (rawEnabled === "false") {
    isEnabled = false;
  } else if (rawEnabled === "true") {
    isEnabled = true;
  } else {
    throw new CompanyMemoryConfigurationError(
      "PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED must be exactly 'true' or 'false' (case-sensitive)",
    );
  }

  if (!isEnabled) {
    return {
      enabled: false,
      adminDatabaseUrl: null,
      pilotCompanyIds: Object.freeze([]),
    };
  }

  // 1. Validate admin database URL
  const rawAdminUrl = env.PAPERCLIP_MEMORY_ADMIN_DATABASE_URL?.trim();
  if (!rawAdminUrl) {
    throw new CompanyMemoryConfigurationError(
      "PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED is true but PAPERCLIP_MEMORY_ADMIN_DATABASE_URL is missing or empty",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawAdminUrl);
  } catch {
    throw new CompanyMemoryConfigurationError(
      "PAPERCLIP_MEMORY_ADMIN_DATABASE_URL is not a valid URL",
    );
  }

  if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
    throw new CompanyMemoryConfigurationError(
      "PAPERCLIP_MEMORY_ADMIN_DATABASE_URL must use postgres: or postgresql: protocol",
    );
  }

  const sslmodes = parsedUrl.searchParams.getAll("sslmode");
  if (sslmodes.length !== 1 || sslmodes[0].trim().toLowerCase() !== "require") {
    throw new CompanyMemoryConfigurationError(
      "PAPERCLIP_MEMORY_ADMIN_DATABASE_URL requires sslmode=require (exactly one parameter)",
    );
  }

  // 2. Validate pilot allowlist
  const rawAllowlist = env.PAPERCLIP_MEMORY_PILOT_COMPANIES?.trim();
  if (!rawAllowlist) {
    throw new CompanyMemoryConfigurationError(
      "PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED is true but PAPERCLIP_MEMORY_PILOT_COMPANIES is missing or empty. A non-empty UUID-only pilot allowlist is required.",
    );
  }

  const items = rawAllowlist
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (items.length === 0) {
    throw new CompanyMemoryConfigurationError(
      "PAPERCLIP_MEMORY_PILOT_COMPANIES contains no valid entries",
    );
  }

  for (const item of items) {
    if (item === "*" || !UUID_REGEX.test(item)) {
      throw new CompanyMemoryConfigurationError(
        "PAPERCLIP_MEMORY_PILOT_COMPANIES contains an invalid entry. Wildcard '*' is forbidden; each entry must be a valid UUID.",
      );
    }
  }

  return {
    enabled: true,
    adminDatabaseUrl: rawAdminUrl,
    pilotCompanyIds: Object.freeze(Array.from(new Set(items))),
  };
}

let cachedConfig: CompanyMemoryConfig | null = null;

export function getCompanyMemoryConfig(): CompanyMemoryConfig {
  if (!cachedConfig) {
    cachedConfig = parseCompanyMemoryConfig(process.env);
  }
  return cachedConfig;
}

export function resetCompanyMemoryConfigForTests(): void {
  cachedConfig = null;
}

export function validateCompanyMemoryConfigAtBoot(env: NodeJS.ProcessEnv = process.env): void {
  cachedConfig = parseCompanyMemoryConfig(env);
}
