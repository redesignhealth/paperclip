import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasChildVisibleEnvBinding,
  inferOpenAiCompatibleBiller,
  resolveChildVisibleBillingIdentity,
} from "./billing.js";

describe("inferOpenAiCompatibleBiller", () => {
  it("returns openrouter when OPENROUTER_API_KEY is present", () => {
    expect(
      inferOpenAiCompatibleBiller({ OPENROUTER_API_KEY: "sk-or-123" } as NodeJS.ProcessEnv, "openai"),
    ).toBe("openrouter");
  });

  it("returns openrouter when OPENAI_BASE_URL points at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("returns fallback when no OpenRouter markers are present", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://api.openai.com/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openai");
  });
});

describe("resolveChildVisibleBillingIdentity (TECH-7095)", () => {
  const SENTINEL = "sk-host-sentinel-should-never-count";
  const saved: Record<string, string | undefined> = {};
  const keys = ["PAPERCLIP_AGENT_AUTH_POLICY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
    process.env.ANTHROPIC_API_KEY = SENTINEL;
    process.env.OPENAI_API_KEY = SENTINEL;
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("maps a managed subscription connection to subscription under managed_only", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    expect(resolveChildVisibleBillingIdentity({ managedAiConnection: { method: "subscription" } })).toEqual({
      billingType: "subscription",
      source: "managed_connection",
    });
  });

  it("maps a managed api_key connection to api", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    expect(resolveChildVisibleBillingIdentity({ managedAiConnection: { method: "api_key" } }).billingType).toBe("api");
  });

  it("returns unknown for an unbound agent under managed_only, ignoring host keys", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    expect(resolveChildVisibleBillingIdentity({}, { apiKeyEnvNames: ["ANTHROPIC_API_KEY"] })).toEqual({
      billingType: "unknown",
      source: "unresolved",
    });
  });

  it("treats an explicit config.env key (string, plain or secret_ref) as api", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    for (const value of [
      "sk-explicit",
      { type: "plain", value: "sk-explicit" },
      { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" },
    ]) {
      expect(
        resolveChildVisibleBillingIdentity({ env: { ANTHROPIC_API_KEY: value } }, { apiKeyEnvNames: ["ANTHROPIC_API_KEY"] }),
      ).toEqual({ billingType: "api", source: "config_env" });
    }
  });

  it("treats an explicitly bound subscription token as subscription", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    expect(
      resolveChildVisibleBillingIdentity(
        { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "s1" } } },
        { apiKeyEnvNames: ["ANTHROPIC_API_KEY"], subscriptionEnvNames: ["CLAUDE_CODE_OAUTH_TOKEN"] },
      ),
    ).toEqual({ billingType: "subscription", source: "config_env" });
  });

  it("ignores empty bindings and keys this adapter does not bill by", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    expect(hasChildVisibleEnvBinding({ env: { ANTHROPIC_API_KEY: "  " } }, "ANTHROPIC_API_KEY")).toBe(false);
    expect(hasChildVisibleEnvBinding({ env: { ANTHROPIC_API_KEY: { type: "plain", value: "" } } }, "ANTHROPIC_API_KEY")).toBe(false);
    expect(
      resolveChildVisibleBillingIdentity({ env: { OPENAI_API_KEY: "sk" } }, { apiKeyEnvNames: ["ANTHROPIC_API_KEY"] }).billingType,
    ).toBe("unknown");
  });

  it("keeps the legacy inference under host_fallback and managed_only_report", () => {
    for (const policy of ["host_fallback", "managed_only_report"]) {
      process.env.PAPERCLIP_AGENT_AUTH_POLICY = policy;
      expect(resolveChildVisibleBillingIdentity({})).toEqual({ billingType: "subscription", source: "legacy_inference" });
      expect(resolveChildVisibleBillingIdentity({}, { legacyBillingType: "metered_api" }).billingType).toBe("metered_api");
    }
  });

  it("accepts an explicit policy override", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    expect(resolveChildVisibleBillingIdentity({}, { policy: "managed_only" }).billingType).toBe("unknown");
  });
});
