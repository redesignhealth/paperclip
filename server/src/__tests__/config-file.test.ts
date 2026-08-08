import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFile } from "../config-file.js";
import { loadConfig } from "../config.js";

const ORIGINAL_PAPERCLIP_CONFIG = process.env.PAPERCLIP_CONFIG;
const ORIGINAL_PAPERCLIP_SSO_PROVIDERS = process.env.PAPERCLIP_SSO_PROVIDERS;

function writeConfig(configPath: string, value: unknown): void {
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function minimalConfig(): unknown {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-07-05T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
    },
    logging: {
      mode: "file",
    },
    server: {},
  };
}

describe("readConfigFile", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-config-file-test-"));
    configPath = path.join(tempDir, "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_PAPERCLIP_CONFIG === undefined) {
      delete process.env.PAPERCLIP_CONFIG;
    } else {
      process.env.PAPERCLIP_CONFIG = ORIGINAL_PAPERCLIP_CONFIG;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when the config file does not exist", () => {
    expect(readConfigFile()).toBeNull();
  });

  it("throws a path-specific error when the config file is invalid JSON", () => {
    fs.writeFileSync(configPath, "{");

    expect(() => readConfigFile()).toThrow(
      new RegExp(`Invalid Paperclip config at ${escapeRegExp(configPath)}: failed to read or parse JSON`),
    );
  });

  it("throws a field-specific error when the config file fails schema validation", () => {
    const config = minimalConfig();
    if (typeof config === "object" && config !== null) {
      (config as { $meta: { source: string } }).$meta.source = "edited-by-hand";
    }

    writeConfig(configPath, config);

    expect(() => readConfigFile()).toThrow(/Invalid Paperclip config .* \$meta\.source:/);
  });

  it("parses a valid config file", () => {
    writeConfig(configPath, minimalConfig());

    expect(readConfigFile()).toMatchObject({
      $meta: {
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
    });
  });

  it("warns about likely misspellings without stripping them", () => {
    const config = {
      ...(minimalConfig() as Record<string, unknown>),
      server: {
        ports: 3200,
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeConfig(configPath, config);

    expect(readConfigFile()).toMatchObject({
      server: {
        port: 3100,
        ports: 3200,
      },
    });
    expect(warn).toHaveBeenCalledWith(
      "Unknown config key server.ports; did you mean server.port? It will be preserved.",
    );
  });
});

// TECH-4916 finding #5: PAPERCLIP_SSO_PROVIDERS parse failures used to be
// silently swallowed into `[]`, producing a server that boots with SSO
// quietly disabled and no clue why. loadConfig() now throws a specific,
// actionable error for each failure mode instead, which crashes boot loudly
// (see startServer()'s top-level .catch in index.ts).
describe("loadConfig PAPERCLIP_SSO_PROVIDERS parsing (TECH-4916 finding #5)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-config-file-test-"));
    // Point at a config file that doesn't exist so loadConfig() falls back
    // to defaults for everything except the env var under test.
    process.env.PAPERCLIP_CONFIG = path.join(tempDir, "does-not-exist.json");
  });

  afterEach(() => {
    if (ORIGINAL_PAPERCLIP_CONFIG === undefined) {
      delete process.env.PAPERCLIP_CONFIG;
    } else {
      process.env.PAPERCLIP_CONFIG = ORIGINAL_PAPERCLIP_CONFIG;
    }
    if (ORIGINAL_PAPERCLIP_SSO_PROVIDERS === undefined) {
      delete process.env.PAPERCLIP_SSO_PROVIDERS;
    } else {
      process.env.PAPERCLIP_SSO_PROVIDERS = ORIGINAL_PAPERCLIP_SSO_PROVIDERS;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns no providers when the env var is unset", () => {
    delete process.env.PAPERCLIP_SSO_PROVIDERS;

    expect(loadConfig().ssoProviders).toEqual([]);
  });

  it("throws a specific error when the env var is not valid JSON", () => {
    process.env.PAPERCLIP_SSO_PROVIDERS = "{not json";

    expect(() => loadConfig()).toThrow(/PAPERCLIP_SSO_PROVIDERS is not valid JSON/);
  });

  it("throws a specific error when the env var is valid JSON but not an array", () => {
    process.env.PAPERCLIP_SSO_PROVIDERS = JSON.stringify({ providerId: "okta" });

    expect(() => loadConfig()).toThrow(
      /PAPERCLIP_SSO_PROVIDERS must be a JSON array of SSO provider configs, got object/,
    );
  });

  it("throws a specific, index-scoped error when an entry fails schema validation", () => {
    process.env.PAPERCLIP_SSO_PROVIDERS = JSON.stringify([
      {
        providerId: "okta",
        type: "okta",
        clientId: "client",
        clientSecret: "secret",
        issuer: "https://example.okta.com",
      },
      { providerId: "broken" },
    ]);

    expect(() => loadConfig()).toThrow(/PAPERCLIP_SSO_PROVIDERS\[1\] is invalid:/);
  });

  it("parses a valid array of provider configs", () => {
    process.env.PAPERCLIP_SSO_PROVIDERS = JSON.stringify([
      {
        providerId: "okta",
        type: "okta",
        clientId: "client",
        clientSecret: "secret",
        issuer: "https://example.okta.com",
      },
    ]);

    expect(loadConfig().ssoProviders).toEqual([
      {
        providerId: "okta",
        type: "okta",
        clientId: "client",
        clientSecret: "secret",
        issuer: "https://example.okta.com",
      },
    ]);
  });
});
