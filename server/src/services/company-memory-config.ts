import { UUID_REGEX } from "./company-memory-constants.js";

export type CompanyMemoryScope = "allowlist" | "all";

export interface CompanyMemoryConfig {
  readonly enabled: boolean;
  readonly companyScope: CompanyMemoryScope;
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
 * - PAPERCLIP_MEMORY_COMPANY_SCOPE must be exactly case-sensitive "allowlist" or "all" (after trim).
 *   - When unset or empty string: defaults to "allowlist".
 *   - ANY other non-empty value (e.g. "ALL", "universal", "1", typos) throws CompanyMemoryConfigurationError,
 *     even when tenant isolation is disabled.
 * - PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED must be exactly case-sensitive "true" or "false" (after trim).
 * - When unset or empty string: defaults to false (disabled).
 * - ANY other non-empty value (e.g. "TRUE", "True", "1", "yes", typos) throws CompanyMemoryConfigurationError.
 * - When enabled (true):
 *   - PAPERCLIP_MEMORY_ADMIN_DATABASE_URL must be a valid postgres: or postgresql: URL.
 *   - sslmode=require is strictly required in the URL query string.
 *   - When scope is "allowlist": PAPERCLIP_MEMORY_PILOT_COMPANIES must be a non-empty, comma-separated list of valid UUIDs only.
 *   - When scope is "all": PAPERCLIP_MEMORY_PILOT_COMPANIES is optional. If provided and non-empty, all entries must be valid UUIDs.
 *   - Wildcard '*' or non-UUID strings are strictly invalid in all modes.
 * - Configuration errors NEVER echo DSN, password, or raw user inputs.
 */
export function parseCompanyMemoryConfig(env: NodeJS.ProcessEnv = process.env): CompanyMemoryConfig {
  const rawScope = env.PAPERCLIP_MEMORY_COMPANY_SCOPE?.trim();
  let companyScope: CompanyMemoryScope = "allowlist";
  if (rawScope === undefined || rawScope === "") {
    companyScope = "allowlist";
  } else if (rawScope === "allowlist") {
    companyScope = "allowlist";
  } else if (rawScope === "all") {
    companyScope = "all";
  } else {
    throw new CompanyMemoryConfigurationError(
      "PAPERCLIP_MEMORY_COMPANY_SCOPE must be exactly 'allowlist' or 'all' (case-sensitive)",
    );
  }

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
      companyScope,
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
  let pilotCompanyIds: readonly string[] = Object.freeze([]);

  if (companyScope === "allowlist") {
    if (!rawAllowlist) {
      throw new CompanyMemoryConfigurationError(
        "PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED is true and PAPERCLIP_MEMORY_COMPANY_SCOPE is 'allowlist' but PAPERCLIP_MEMORY_PILOT_COMPANIES is missing or empty. A non-empty UUID-only pilot allowlist is required.",
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

    pilotCompanyIds = Object.freeze(Array.from(new Set(items)));
  } else {
    // companyScope === "all"
    if (rawAllowlist && rawAllowlist.length > 0) {
      const items = rawAllowlist
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);

      for (const item of items) {
        if (item === "*" || !UUID_REGEX.test(item)) {
          throw new CompanyMemoryConfigurationError(
            "PAPERCLIP_MEMORY_PILOT_COMPANIES contains an invalid entry. Wildcard '*' is forbidden; each entry must be a valid UUID.",
          );
        }
      }
      pilotCompanyIds = Object.freeze(Array.from(new Set(items)));
    }
  }

  return {
    enabled: true,
    companyScope,
    adminDatabaseUrl: rawAdminUrl,
    pilotCompanyIds,
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
