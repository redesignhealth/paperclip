import { describe, expect, it } from "vitest";
import {
  parseCompanyMemoryConfig,
  getCompanyMemoryConfig,
  resetCompanyMemoryConfigForTests,
  validateCompanyMemoryConfigAtBoot,
  CompanyMemoryConfigurationError,
} from "./company-memory-config.js";

describe("company-memory-config", () => {
  const validUuid = "11111111-1111-4111-8111-111111111111";
  const validDsn = "postgres://admin:pass@db.example.com:5432/postgres?sslmode=require";

  it("returns disabled when PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED is unset or exact 'false'", () => {
    expect(parseCompanyMemoryConfig({})).toEqual({
      enabled: false,
      companyScope: "allowlist",
      adminDatabaseUrl: null,
      pilotCompanyIds: [],
    });

    expect(parseCompanyMemoryConfig({ PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "false" })).toEqual({
      enabled: false,
      companyScope: "allowlist",
      adminDatabaseUrl: null,
      pilotCompanyIds: [],
    });

    expect(parseCompanyMemoryConfig({ PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "  false  " })).toEqual({
      enabled: false,
      companyScope: "allowlist",
      adminDatabaseUrl: null,
      pilotCompanyIds: [],
    });
  });

  it("throws on any non-exact-boolean values (case-sensitive enforcement)", () => {
    for (const badValue of ["TRUE", "True", "1", "yes", "YES", "on", "t", "typo", "0"]) {
      expect(
        () =>
          parseCompanyMemoryConfig({
            PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: badValue,
          }),
        `expected "${badValue}" to throw`,
      ).toThrow(CompanyMemoryConfigurationError);
    }
  });

  it("fails closed when enabled but admin URL is missing or empty", () => {
    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
      }),
    ).toThrow(CompanyMemoryConfigurationError);

    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: "   ",
      }),
    ).toThrow("missing or empty");
  });

  it("fails closed when admin URL is not a postgres/postgresql URL", () => {
    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: "mysql://user:pass@host:3306/db?sslmode=require",
        PAPERCLIP_MEMORY_PILOT_COMPANIES: validUuid,
      }),
    ).toThrow("must use postgres: or postgresql: protocol");
  });

  it("fails closed when admin URL does not specify sslmode=require", () => {
    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: "postgres://user:pass@host:5432/db",
        PAPERCLIP_MEMORY_PILOT_COMPANIES: validUuid,
      }),
    ).toThrow("requires sslmode=require");

    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: "postgres://user:pass@host:5432/db?sslmode=disable",
        PAPERCLIP_MEMORY_PILOT_COMPANIES: validUuid,
      }),
    ).toThrow("requires sslmode=require");

    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: "postgres://user:pass@host:5432/db?sslmode=require&sslmode=disable",
        PAPERCLIP_MEMORY_PILOT_COMPANIES: validUuid,
      }),
    ).toThrow("requires sslmode=require");
  });

  it("fails closed when pilot allowlist is missing, empty, wildcard, or contains invalid entries without echoing values", () => {
    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
      }),
    ).toThrow("missing or empty");

    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_PILOT_COMPANIES: "*",
      }),
    ).toThrow("Wildcard '*' is forbidden");

    const invalidInput = "super_secret_company_name_or_sql_injection";
    let thrownError: Error | null = null;
    try {
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_PILOT_COMPANIES: invalidInput,
      });
    } catch (e) {
      thrownError = e as Error;
    }
    expect(thrownError).not.toBeNull();
    // Must NOT echo the invalid raw input value
    expect(thrownError!.message).not.toContain(invalidInput);
    expect(thrownError!.message).toContain("contains an invalid entry");
  });

  it("successfully parses valid configuration with pilot UUIDs", () => {
    const config = parseCompanyMemoryConfig({
      PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
      PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
      PAPERCLIP_MEMORY_PILOT_COMPANIES: `${validUuid}, 22222222-2222-4222-8222-222222222222`,
    });

    expect(config.enabled).toBe(true);
    expect(config.companyScope).toBe("allowlist");
    expect(config.adminDatabaseUrl).toBe(validDsn);
    expect(config.pilotCompanyIds).toEqual([
      validUuid,
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  describe("PAPERCLIP_MEMORY_COMPANY_SCOPE parsing and validation", () => {
    it("parses valid scopes: 'allowlist', 'all', and trims whitespace", () => {
      const cfg1 = parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_PILOT_COMPANIES: validUuid,
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "allowlist",
      });
      expect(cfg1.companyScope).toBe("allowlist");

      const cfg2 = parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
      });
      expect(cfg2.companyScope).toBe("all");
      expect(cfg2.pilotCompanyIds).toEqual([]);

      const cfg3 = parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "  all  ",
      });
      expect(cfg3.companyScope).toBe("all");

      const cfg4 = parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "all ",
      });
      expect(cfg4.companyScope).toBe("all");
    });

    it("strictly rejects invalid scopes even when tenant isolation is disabled", () => {
      for (const badScope of ["ALL", "All", "universal", "1", "true", "*", "allow_list", "any"]) {
        expect(
          () =>
            parseCompanyMemoryConfig({
              PAPERCLIP_MEMORY_COMPANY_SCOPE: badScope,
              PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "false",
            }),
          `expected bad scope "${badScope}" to throw while disabled`,
        ).toThrow("PAPERCLIP_MEMORY_COMPANY_SCOPE must be exactly 'allowlist' or 'all'");

        expect(
          () =>
            parseCompanyMemoryConfig({
              PAPERCLIP_MEMORY_COMPANY_SCOPE: badScope,
              PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
              PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
            }),
          `expected bad scope "${badScope}" to throw while enabled`,
        ).toThrow("PAPERCLIP_MEMORY_COMPANY_SCOPE must be exactly 'allowlist' or 'all'");
      }
    });

    it("in 'all' mode: pilot list is optional, but if provided must contain valid UUIDs without wildcard", () => {
      // Optional when empty or unset
      const cfgNoPilot = parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
      });
      expect(cfgNoPilot.companyScope).toBe("all");
      expect(cfgNoPilot.pilotCompanyIds).toEqual([]);

      const cfgEmptyPilot = parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
        PAPERCLIP_MEMORY_PILOT_COMPANIES: "   ",
      });
      expect(cfgEmptyPilot.pilotCompanyIds).toEqual([]);

      // Preserves valid pilot list when provided
      const cfgWithPilot = parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
        PAPERCLIP_MEMORY_PILOT_COMPANIES: validUuid,
      });
      expect(cfgWithPilot.pilotCompanyIds).toEqual([validUuid]);

      // Rejects wildcard even in 'all' mode
      expect(() =>
        parseCompanyMemoryConfig({
          PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
          PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
          PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
          PAPERCLIP_MEMORY_PILOT_COMPANIES: "*",
        }),
      ).toThrow("Wildcard '*' is forbidden");

      // Rejects non-UUID even in 'all' mode
      expect(() =>
        parseCompanyMemoryConfig({
          PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
          PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
          PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
          PAPERCLIP_MEMORY_PILOT_COMPANIES: "not-a-uuid",
        }),
      ).toThrow("each entry must be a valid UUID");
    });

    it("in 'allowlist' mode: pilot list is mandatory", () => {
      expect(() =>
        parseCompanyMemoryConfig({
          PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
          PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
          PAPERCLIP_MEMORY_COMPANY_SCOPE: "allowlist",
        }),
      ).toThrow("A non-empty UUID-only pilot allowlist is required");

      expect(() =>
        parseCompanyMemoryConfig({
          PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
          PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
          PAPERCLIP_MEMORY_COMPANY_SCOPE: "allowlist",
          PAPERCLIP_MEMORY_PILOT_COMPANIES: "",
        }),
      ).toThrow("A non-empty UUID-only pilot allowlist is required");
    });
  });

  it("caches parsed config at boot and respects resetCompanyMemoryConfigForTests", () => {
    resetCompanyMemoryConfigForTests();
    const env = {
      PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
      PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
      PAPERCLIP_MEMORY_PILOT_COMPANIES: validUuid,
    };
    validateCompanyMemoryConfigAtBoot(env);
    const cached = getCompanyMemoryConfig();
    expect(cached.enabled).toBe(true);
    expect(cached.pilotCompanyIds).toEqual([validUuid]);

    resetCompanyMemoryConfigForTests();
    // Default getCompanyMemoryConfig parses process.env (disabled by default)
    expect(getCompanyMemoryConfig().enabled).toBe(false);
  });

  it("caches 'all'-scope config with an empty pilot list at boot (scope cached, not re-derived)", () => {
    resetCompanyMemoryConfigForTests();
    validateCompanyMemoryConfigAtBoot({
      PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
      PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
      PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
    });
    const cached = getCompanyMemoryConfig();
    expect(cached.enabled).toBe(true);
    expect(cached.companyScope).toBe("all");
    expect(cached.pilotCompanyIds).toEqual([]);
    resetCompanyMemoryConfigForTests();
  });

  it("fails closed at boot on an invalid company scope even when the master flag is false (no eager startup path proceeds)", () => {
    resetCompanyMemoryConfigForTests();
    expect(() =>
      validateCompanyMemoryConfigAtBoot({
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "ALL",
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "false",
      }),
    ).toThrow(CompanyMemoryConfigurationError);
    resetCompanyMemoryConfigForTests();
    expect(() =>
      validateCompanyMemoryConfigAtBoot({
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "universal",
      }),
    ).toThrow("PAPERCLIP_MEMORY_COMPANY_SCOPE must be exactly 'allowlist' or 'all'");
    resetCompanyMemoryConfigForTests();
  });

  it("normalizes uppercase-hex pilot UUID entries to lowercase and deduplicates them", () => {
    const config = parseCompanyMemoryConfig({
      PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
      PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
      // UUID_REGEX is case-insensitive; entries must be normalized to lowercase
      PAPERCLIP_MEMORY_PILOT_COMPANIES: `${validUuid.toUpperCase()}, ${validUuid.toUpperCase()}, ${validUuid}`,
    });
    expect(config.pilotCompanyIds).toEqual([validUuid]);
  });

  it("returns a frozen (immutable) pilot allowlist in every scope mode", () => {
    const allowlistConfig = parseCompanyMemoryConfig({
      PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
      PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
      PAPERCLIP_MEMORY_PILOT_COMPANIES: validUuid,
    });
    expect(Object.isFrozen(allowlistConfig.pilotCompanyIds)).toBe(true);
    expect(() => (allowlistConfig.pilotCompanyIds as any).push("33333333-3333-4333-8333-333333333333")).toThrow(TypeError);

    const allConfig = parseCompanyMemoryConfig({
      PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
      PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
      PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
    });
    expect(Object.isFrozen(allConfig.pilotCompanyIds)).toBe(true);
    expect(() => (allConfig.pilotCompanyIds as any).push("33333333-3333-4333-8333-333333333333")).toThrow(TypeError);

    const disabledConfig = parseCompanyMemoryConfig({});
    expect(Object.isFrozen(disabledConfig.pilotCompanyIds)).toBe(true);
    expect(() => (disabledConfig.pilotCompanyIds as any).push("33333333-3333-4333-8333-333333333333")).toThrow(TypeError);
  });

  it("rejects a star wildcard even when embedded in a UUID list in 'all' mode (not just as the sole entry)", () => {
    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "all",
        PAPERCLIP_MEMORY_PILOT_COMPANIES: `${validUuid},*`,
      }),
    ).toThrow("Wildcard '*' is forbidden");

    expect(() =>
      parseCompanyMemoryConfig({
        PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "true",
        PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: validDsn,
        PAPERCLIP_MEMORY_COMPANY_SCOPE: "allowlist",
        PAPERCLIP_MEMORY_PILOT_COMPANIES: `*,${validUuid}`,
      }),
    ).toThrow("Wildcard '*' is forbidden");
  });
});
