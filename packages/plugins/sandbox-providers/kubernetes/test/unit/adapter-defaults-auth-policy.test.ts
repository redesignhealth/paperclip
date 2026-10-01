import { describe, expect, it } from "vitest";
import {
  buildAdapterEnv,
  isAgentAuthManagedOnlyEnforced,
  type AdapterDefaults,
} from "../../src/adapter-defaults.js";

// TECH-7095: the k8s sandbox provider must not inject the worker's (server-provided) model
// provider keys into sandbox Jobs under the enforced managed-only agent auth policy.
const defaults: AdapterDefaults = {
  runtimeImage: "x",
  envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"],
  allowFqdns: [],
  probeCommand: ["x"],
  defaultEnv: { ANTHROPIC_BASE_URL: "http://bifrost:8080" },
};
const hostKeys = {
  ANTHROPIC_API_KEY: "sentinel-anthropic",
  OPENAI_API_KEY: "sentinel-openai",
  GOOGLE_API_KEY: "sentinel-google",
  GEMINI_API_KEY: "sentinel-gemini",
  OPENROUTER_API_KEY: "sentinel-openrouter",
};

describe("buildAdapterEnv agent auth policy", () => {
  it("drops provider keys under explicit managed_only", () => {
    const env = buildAdapterEnv(defaults, { ...hostKeys, PAPERCLIP_AGENT_AUTH_POLICY: "managed_only" });
    expect(env).toEqual({ ANTHROPIC_BASE_URL: "http://bifrost:8080" });
    expect(JSON.stringify(env)).not.toContain("sentinel-");
  });

  it("drops provider keys on an authenticated deployment with no explicit policy", () => {
    const env = buildAdapterEnv(defaults, { ...hostKeys, PAPERCLIP_DEPLOYMENT_MODE: "authenticated" });
    expect(JSON.stringify(env)).not.toContain("sentinel-");
  });

  it("fails closed on an unrecognized explicit policy", () => {
    expect(isAgentAuthManagedOnlyEnforced({ PAPERCLIP_AGENT_AUTH_POLICY: "bogus" })).toBe(true);
  });

  it("keeps provider keys under host_fallback and managed_only_report", () => {
    for (const policy of ["host_fallback", "managed_only_report"]) {
      const env = buildAdapterEnv(defaults, {
        ...hostKeys,
        PAPERCLIP_AGENT_AUTH_POLICY: policy,
        PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      });
      expect(env.ANTHROPIC_API_KEY).toBe("sentinel-anthropic");
      expect(env.OPENROUTER_API_KEY).toBe("sentinel-openrouter");
    }
  });
});
