import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import {
  ARCANA_PROVISION_KEY_ENV,
  ARCANA_URL_ENV,
  readArcanaProvisionerSnapshot,
  __resetArcanaProvisionerForTests,
} from "../arcana-provisioner-credentials.js";

describe("loadConfig scrubs a late-populated Arcana provision token (TECH-7252)", () => {
  beforeEach(() => {
    __resetArcanaProvisionerForTests();
    delete process.env[ARCANA_URL_ENV];
    delete process.env[ARCANA_PROVISION_KEY_ENV];
  });
  afterEach(() => {
    __resetArcanaProvisionerForTests();
    delete process.env[ARCANA_URL_ENV];
    delete process.env[ARCANA_PROVISION_KEY_ENV];
  });

  it("deletes the token on every loadConfig() and adopts nothing that appears after the first capture", () => {
    // First capture saw nothing (as if bootstrap ran with no deployment values).
    __resetArcanaProvisionerForTests();
    loadConfig();
    process.env[ARCANA_URL_ENV] = "https://late.test";
    process.env[ARCANA_PROVISION_KEY_ENV] = "late-token-fixture";
    loadConfig();
    expect(process.env[ARCANA_PROVISION_KEY_ENV]).toBeUndefined();
    expect(readArcanaProvisionerSnapshot()).toEqual({ arcanaUrl: null, provisionKey: null, mcpUrl: null });
  });
});
