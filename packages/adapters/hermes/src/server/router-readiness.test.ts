/**
 * TECH-7895: Ramp Router env and credential policy helpers.
 */
import { describe, expect, it } from "vitest";

import {
  isRemoteExecutionTarget,
  isRouterEndpointOverrideEnvName,
  isRouterProvider,
  readRouterApiKey,
  routerEnvNamesToStrip,
} from "./router-readiness.js";

describe("Router env helpers", () => {
  it("classifies endpoint overrides and aliases but never the canonical key", () => {
    for (const name of ["RAMP_ROUTER_BASE_URL", "RAMP_ROUTER_API_BASE", "RAMP_ROUTER_ANYTHING", "ROUTER_API_KEY", "ROUTER_BASE_URL"]) {
      expect(isRouterEndpointOverrideEnvName(name), name).toBe(true);
    }
    for (const name of ["RAMP_ROUTER_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "OPENAI_BASE_URL"]) {
      expect(isRouterEndpointOverrideEnvName(name), name).toBe(false);
    }
  });

  it("strips SDK endpoint variables only from Router runs", () => {
    const env = { RAMP_ROUTER_BASE_URL: "x", OPENAI_BASE_URL: "y", RAMP_ROUTER_API_KEY: "k" };
    expect(routerEnvNamesToStrip(env, true)).toEqual(expect.arrayContaining(["RAMP_ROUTER_BASE_URL", "OPENAI_BASE_URL"]));
    expect(routerEnvNamesToStrip(env, false)).toContain("RAMP_ROUTER_BASE_URL");
    expect(routerEnvNamesToStrip(env, false)).not.toContain("OPENAI_BASE_URL");
    expect(routerEnvNamesToStrip(env, true)).not.toContain("RAMP_ROUTER_API_KEY");
  });

  it("reads only a non-blank canonical key", () => {
    expect(readRouterApiKey({ RAMP_ROUTER_API_KEY: " k " })).toBe("k");
    expect(readRouterApiKey({ RAMP_ROUTER_API_KEY: "   " })).toBeUndefined();
    expect(readRouterApiKey({ ROUTER_API_KEY: "legacy" })).toBeUndefined();
    expect(readRouterApiKey({ OPENAI_API_KEY: "other" })).toBeUndefined();
    expect(readRouterApiKey(undefined)).toBeUndefined();
  });

  it("matches only the router provider, ignoring case and surrounding whitespace", () => {
    expect(isRouterProvider("router")).toBe(true);
    expect(isRouterProvider(" Router ")).toBe(true);
    for (const provider of ["openrouter", "auto", "", null, undefined]) {
      expect(isRouterProvider(provider), String(provider)).toBe(false);
    }
  });

  it("detects remote execution targets from either contract", () => {
    expect(isRemoteExecutionTarget({ executionTarget: { kind: "remote" } })).toBe(true);
    expect(isRemoteExecutionTarget({ executionTransport: { remoteExecution: { host: "x" } } })).toBe(true);
    expect(isRemoteExecutionTarget({ executionTarget: { kind: "local" } })).toBe(false);
    expect(isRemoteExecutionTarget({})).toBe(false);
  });
});
