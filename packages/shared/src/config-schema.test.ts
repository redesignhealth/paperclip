import { describe, expect, it } from "vitest";
import {
  findPaperclipConfigKeyWarnings,
  mergePaperclipConfig,
  paperclipConfigSchema,
  ssoProviderConfigSchema,
} from "./config-schema.js";

function baseSsoProvider(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "test-provider",
    clientId: "client-id",
    clientSecret: "client-secret",
    ...overrides,
  };
}

describe("paperclip config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
      server: {},
    });

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.paperclip/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.paperclip/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.paperclip/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.paperclip/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.paperclip/instances/default/secrets/master.key");
  });

  it("retains extension keys at the top level and every nested config boundary", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
        extensionMeta: "keep",
      },
      database: {
        mode: "embedded-postgres",
        backup: {
          backupExtension: "keep",
        },
      },
      logging: {
        mode: "file",
      },
      server: {
        serverExtension: "keep",
      },
      storage: {
        localDisk: {
          driverExtension: "keep",
        },
        s3: {
          s3Extension: "keep",
        },
      },
      secrets: {
        localEncrypted: {
          providerExtension: "keep",
        },
      },
      topLevelExtension: {
        enabled: true,
      },
    });

    expect(parsed).toMatchObject({
      $meta: { extensionMeta: "keep" },
      database: { backup: { backupExtension: "keep" } },
      server: { serverExtension: "keep" },
      storage: {
        localDisk: { driverExtension: "keep" },
        s3: { s3Extension: "keep" },
      },
      secrets: { localEncrypted: { providerExtension: "keep" } },
      topLevelExtension: { enabled: true },
    });
  });

  it("merges retained extensions without resurrecting removed known fields", () => {
    const source = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      llm: {
        provider: "openai",
        apiKey: "remove-me",
        providerExtension: "keep",
      },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file" },
      server: { port: 3100, serverExtension: "keep" },
      topLevelExtension: "keep",
    });
    const update = paperclipConfigSchema.parse({
      ...source,
      llm: {
        provider: "openai",
      },
      server: {
        ...source.server,
        port: 3200,
      },
    });

    const merged = mergePaperclipConfig(source, update);

    expect(merged.server.port).toBe(3200);
    expect(merged.server.serverExtension).toBe("keep");
    expect(merged.topLevelExtension).toBe("keep");
    expect(merged.llm?.providerExtension).toBe("keep");
    expect(merged.llm).not.toHaveProperty("apiKey");
  });

  it("warns about likely misspellings while leaving arbitrary extensions alone", () => {
    expect(findPaperclipConfigKeyWarnings({
      servr: {},
      server: {
        ports: 3100,
        pluginOptions: {
          arbitrary: true,
        },
      },
      extensionNamespace: {
        port: 9999,
      },
    })).toEqual([
      { path: "servr", suggestion: "server" },
      { path: "server.ports", suggestion: "server.port" },
    ]);
  });
});

describe("ssoProviderConfigSchema per-provider required fields (TECH-4916)", () => {
  it("requires discoveryUrl when type is oidc", () => {
    expect(() => ssoProviderConfigSchema.parse(baseSsoProvider({
      type: "oidc",
      discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
    }))).not.toThrow();

    expect(() => ssoProviderConfigSchema.parse(baseSsoProvider({ type: "oidc" })))
      .toThrowError(/discoveryUrl is required when type is oidc/);
  });

  it("requires issuer when type is keycloak or okta", () => {
    for (const type of ["keycloak", "okta"] as const) {
      expect(() => ssoProviderConfigSchema.parse(baseSsoProvider({
        type,
        issuer: "https://idp.example.com/realms/paperclip",
      }))).not.toThrow();

      expect(() => ssoProviderConfigSchema.parse(baseSsoProvider({ type })))
        .toThrowError(new RegExp(`issuer is required when type is ${type}`));
    }
  });

  it("requires issuer or domain when type is auth0", () => {
    expect(() => ssoProviderConfigSchema.parse(baseSsoProvider({
      type: "auth0",
      issuer: "https://tenant.auth0.com/",
    }))).not.toThrow();

    expect(() => ssoProviderConfigSchema.parse(baseSsoProvider({
      type: "auth0",
      domain: "tenant.auth0.com",
    }))).not.toThrow();

    expect(() => ssoProviderConfigSchema.parse(baseSsoProvider({ type: "auth0" })))
      .toThrowError(/issuer or domain is required when type is auth0/);
  });

  it("requires tenantId when type is microsoft_entra_id", () => {
    expect(() => ssoProviderConfigSchema.parse(baseSsoProvider({
      type: "microsoft_entra_id",
      tenantId: "11111111-1111-1111-1111-111111111111",
    }))).not.toThrow();

    expect(() => ssoProviderConfigSchema.parse(baseSsoProvider({ type: "microsoft_entra_id" })))
      .toThrowError(/tenantId is required when type is microsoft_entra_id/);
  });
});
