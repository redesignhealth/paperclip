import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARCANA_PROVISION_TOKEN_ENV,
  ARCANA_MCP_URL_ENV,
  ARCANA_URL_ENV,
  arcanaSnapshotFromEnv,
  captureAndScrubArcanaProvisionerCredentials,
  readArcanaProvisionerSnapshot,
  __resetArcanaProvisionerForTests,
} from "../arcana-provisioner-credentials.js";
import * as sharedEnv from "@paperclipai/shared/arcana-provisioner-env";
import { resolveArcanaProvisionerConfig } from "../../services/arcana-provisioner-client.js";

const TOKEN = "arcana-provision-token-fixture-aaaa";
const URL_ = "https://arcana.internal.test";
const clear = () => {
  delete process.env[ARCANA_URL_ENV];
  delete process.env[ARCANA_MCP_URL_ENV];
  delete process.env[ARCANA_PROVISION_TOKEN_ENV];
};

describe("arcana-provisioner-credentials (TECH-7252)", () => {
  beforeEach(() => {
    __resetArcanaProvisionerForTests();
    clear();
  });
  afterEach(() => {
    __resetArcanaProvisionerForTests();
    clear();
  });

  it("names the env keys from the shared module and reserves exactly those two", () => {
    expect(ARCANA_URL_ENV).toBe(sharedEnv.ARCANA_URL_ENV);
    expect(ARCANA_PROVISION_TOKEN_ENV).toBe(sharedEnv.ARCANA_PROVISION_TOKEN_ENV);
    expect([...sharedEnv.ARCANA_PROVISIONER_ENV_KEYS].sort()).toEqual([ARCANA_MCP_URL_ENV, ARCANA_PROVISION_TOKEN_ENV, ARCANA_URL_ENV].sort());
    expect(Object.isFrozen(sharedEnv.ARCANA_PROVISIONER_ENV_KEYS)).toBe(true);
  });

  it("captures trimmed values and deletes only the token variable", () => {
    const env: NodeJS.ProcessEnv = { [ARCANA_URL_ENV]: ` ${URL_} `, [ARCANA_PROVISION_TOKEN_ENV]: `  ${TOKEN}\n`, OTHER: "keep" };
    expect(captureAndScrubArcanaProvisionerCredentials(env)).toEqual({ configured: true });
    expect(readArcanaProvisionerSnapshot()).toEqual({ arcanaUrl: URL_, provisionToken: TOKEN, mcpUrl: null });
    expect(ARCANA_PROVISION_TOKEN_ENV in env).toBe(false);
    expect(env[ARCANA_URL_ENV]).toBe(` ${URL_} `);
    expect(env.OTHER).toBe("keep");
  });

  it("captures the MCP URL trimmed and leaves it in the environment (not a secret)", () => {
    const env: NodeJS.ProcessEnv = { [ARCANA_MCP_URL_ENV]: "  https://mcp.test/mcp \n", [ARCANA_PROVISION_TOKEN_ENV]: TOKEN };
    captureAndScrubArcanaProvisionerCredentials(env);
    expect(readArcanaProvisionerSnapshot().mcpUrl).toBe("https://mcp.test/mcp");
    expect(env[ARCANA_MCP_URL_ENV]).toBe("  https://mcp.test/mcp \n");
    expect(arcanaSnapshotFromEnv({ [ARCANA_MCP_URL_ENV]: "  " }).mcpUrl).toBeNull();
  });

  it("scrubs process.env by default", () => {
    Object.assign(process.env, { [ARCANA_URL_ENV]: URL_, [ARCANA_PROVISION_TOKEN_ENV]: TOKEN });
    captureAndScrubArcanaProvisionerCredentials();
    expect(process.env[ARCANA_PROVISION_TOKEN_ENV]).toBeUndefined();
    expect(readArcanaProvisionerSnapshot().provisionToken).toBe(TOKEN);
  });

  it("first capture wins: a later value is scrubbed and never adopted, scrubbing is idempotent", () => {
    const env: NodeJS.ProcessEnv = { [ARCANA_URL_ENV]: URL_, [ARCANA_PROVISION_TOKEN_ENV]: TOKEN };
    captureAndScrubArcanaProvisionerCredentials(env);
    env[ARCANA_PROVISION_TOKEN_ENV] = "attacker-token";
    env[ARCANA_URL_ENV] = "https://evil.test";
    expect(captureAndScrubArcanaProvisionerCredentials(env)).toEqual({ configured: true });
    expect(captureAndScrubArcanaProvisionerCredentials(env)).toEqual({ configured: true });
    expect(ARCANA_PROVISION_TOKEN_ENV in env).toBe(false);
    expect(readArcanaProvisionerSnapshot()).toEqual({ arcanaUrl: URL_, provisionToken: TOKEN, mcpUrl: null });
  });

  it("an empty first capture is never revived by a later value", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(captureAndScrubArcanaProvisionerCredentials(env)).toEqual({ configured: false });
    env[ARCANA_URL_ENV] = URL_;
    env[ARCANA_PROVISION_TOKEN_ENV] = TOKEN;
    expect(captureAndScrubArcanaProvisionerCredentials(env)).toEqual({ configured: false });
    expect(ARCANA_PROVISION_TOKEN_ENV in env).toBe(false);
    expect(resolveArcanaProvisionerConfig()).toEqual({ ok: false, reason: "provisioner_not_configured" });
  });

  it("blank is missing, and the live resolver never falls back to process.env", () => {
    expect(arcanaSnapshotFromEnv({ [ARCANA_URL_ENV]: "  ", [ARCANA_PROVISION_TOKEN_ENV]: "" })).toEqual({ arcanaUrl: null, provisionToken: null, mcpUrl: null });
    Object.assign(process.env, { [ARCANA_URL_ENV]: URL_, [ARCANA_PROVISION_TOKEN_ENV]: TOKEN });
    expect(resolveArcanaProvisionerConfig()).toEqual({ ok: false, reason: "provisioner_not_configured" });
    expect(resolveArcanaProvisionerConfig({ [ARCANA_URL_ENV]: URL_, [ARCANA_PROVISION_TOKEN_ENV]: TOKEN })).toMatchObject({ ok: true });
  });
});
