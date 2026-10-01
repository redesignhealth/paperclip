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
      adminDatabaseUrl: null,
      pilotCompanyIds: [],
    });

    expect(parseCompanyMemoryConfig({ PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "false" })).toEqual({
      enabled: false,
      adminDatabaseUrl: null,
      pilotCompanyIds: [],
    });

    expect(parseCompanyMemoryConfig({ PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED: "  false  " })).toEqual({
      enabled: false,
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
    expect(config.adminDatabaseUrl).toBe(validDsn);
    expect(config.pilotCompanyIds).toEqual([
      validUuid,
      "22222222-2222-4222-8222-222222222222",
    ]);
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
});
