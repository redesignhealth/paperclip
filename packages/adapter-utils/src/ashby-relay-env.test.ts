import { describe, expect, it } from "vitest";
import {
  ASHBY_RELAY_OPT_IN_ENV_KEY,
  ASHBY_RELAY_PATH,
  ashbyRelayOptedIn,
  buildAshbyRelayEnv,
} from "./ashby-relay-env.js";

describe("ashby-relay-env (TECH-9966)", () => {
  it("checks opt-in status from adapterConfig env", () => {
    expect(ashbyRelayOptedIn({ [ASHBY_RELAY_OPT_IN_ENV_KEY]: "on" })).toBe(true);
    expect(ashbyRelayOptedIn({ [ASHBY_RELAY_OPT_IN_ENV_KEY]: "true" })).toBe(true);
    expect(ashbyRelayOptedIn({ [ASHBY_RELAY_OPT_IN_ENV_KEY]: "enabled" })).toBe(true);
    expect(ashbyRelayOptedIn({ [ASHBY_RELAY_OPT_IN_ENV_KEY]: "off" })).toBe(false);
    expect(ashbyRelayOptedIn({})).toBe(false);
    expect(ashbyRelayOptedIn(null)).toBe(false);
  });

  it("builds the pod environment pointing to bridge relay with run-bound token as ASHBY_API_KEY", () => {
    const envConfig = { [ASHBY_RELAY_OPT_IN_ENV_KEY]: "on" };
    const bridgeEnv = {
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_API_KEY: "run-jwt-token-xyz",
    };

    const podEnv = buildAshbyRelayEnv(envConfig, bridgeEnv);
    expect(podEnv).toEqual({
      ASHBY_API_BASE: `http://127.0.0.1:3100${ASHBY_RELAY_PATH}`,
      ASHBY_API_KEY: "run-jwt-token-xyz",
    });
  });

  it("returns empty object when agent did not opt in or bridge env is missing", () => {
    const bridgeEnv = {
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_API_KEY: "run-jwt-token-xyz",
    };

    expect(buildAshbyRelayEnv({}, bridgeEnv)).toEqual({});
    expect(buildAshbyRelayEnv({ [ASHBY_RELAY_OPT_IN_ENV_KEY]: "on" }, undefined)).toEqual({});
    expect(buildAshbyRelayEnv({ [ASHBY_RELAY_OPT_IN_ENV_KEY]: "on" }, { PAPERCLIP_API_URL: "http://127.0.0.1:3100" })).toEqual({});
  });
});
