import { describe, expect, it } from "vitest";
import {
  AgentAuthPolicyError,
  assertAgentAuthPolicyAllowedForDeployment,
  currentAgentAuthPolicy,
  isAgentAuthPolicyError,
  isManagedOnlyEnforced,
  isManagedOnlyPolicy,
  resolveAgentAuthPolicy,
} from "./agent-auth-policy.js";

describe("resolveAgentAuthPolicy (TECH-7095)", () => {
  it("defaults to managed_only for any authenticated deployment", () => {
    expect(resolveAgentAuthPolicy({ env: {}, deploymentMode: "authenticated" })).toBe("managed_only");
    expect(resolveAgentAuthPolicy({ env: { PAPERCLIP_DEPLOYMENT_MODE: "authenticated" } })).toBe("managed_only");
  });

  it("defaults to host_fallback only for local_trusted / unset deployments", () => {
    expect(resolveAgentAuthPolicy({ env: {}, deploymentMode: "local_trusted" })).toBe("host_fallback");
    expect(resolveAgentAuthPolicy({ env: {} })).toBe("host_fallback");
  });

  it("an explicit value wins in both directions", () => {
    expect(resolveAgentAuthPolicy({ env: { PAPERCLIP_AGENT_AUTH_POLICY: "host_fallback" }, deploymentMode: "authenticated" })).toBe("host_fallback");
    expect(resolveAgentAuthPolicy({ env: { PAPERCLIP_AGENT_AUTH_POLICY: "managed_only" }, deploymentMode: "local_trusted" })).toBe("managed_only");
    expect(resolveAgentAuthPolicy({ env: { PAPERCLIP_AGENT_AUTH_POLICY: " managed_only_report " }, deploymentMode: "authenticated" })).toBe("managed_only_report");
  });

  it("rejects an unrecognized value instead of silently weakening the policy, without echoing it", () => {
    let message = "";
    try {
      resolveAgentAuthPolicy({ env: { PAPERCLIP_AGENT_AUTH_POLICY: "tech7095-typo-secret" }, deploymentMode: "authenticated" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("must be one of");
    expect(message).not.toContain("tech7095-typo-secret");
  });

  it("currentAgentAuthPolicy re-derives from env so an unconfigured process is still strict when hosted", () => {
    expect(currentAgentAuthPolicy({ PAPERCLIP_DEPLOYMENT_MODE: "authenticated" })).toBe("managed_only");
  });

  it("distinguishes enforced from report-only", () => {
    expect(isManagedOnlyEnforced("managed_only")).toBe(true);
    expect(isManagedOnlyEnforced("managed_only_report")).toBe(false);
    expect(isManagedOnlyEnforced("host_fallback")).toBe(false);
    expect(isManagedOnlyPolicy("managed_only_report")).toBe(true);
    expect(isManagedOnlyPolicy("host_fallback")).toBe(false);
  });
});

describe("assertAgentAuthPolicyAllowedForDeployment (TECH-7095)", () => {
  it("refuses host_fallback on a public authenticated deployment without acknowledgement", () => {
    expect(() =>
      assertAgentAuthPolicyAllowedForDeployment({ policy: "host_fallback", deploymentMode: "authenticated", deploymentExposure: "public", env: {} }),
    ).toThrow(/host_fallback/);
  });

  it("allows it with the explicit acknowledgement variable, and warns", () => {
    const result = assertAgentAuthPolicyAllowedForDeployment({
      policy: "host_fallback",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      env: { PAPERCLIP_AGENT_AUTH_POLICY_ALLOW_HOSTED_FALLBACK: "1" },
    });
    expect(result.warning).toMatch(/host_fallback/);
  });

  it("warns (does not throw) for private authenticated host_fallback", () => {
    const result = assertAgentAuthPolicyAllowedForDeployment({ policy: "host_fallback", deploymentMode: "authenticated", deploymentExposure: "private", env: {} });
    expect(result.warning).toBeTruthy();
  });

  it("is silent for managed_only and for local_trusted host_fallback", () => {
    expect(assertAgentAuthPolicyAllowedForDeployment({ policy: "managed_only", deploymentMode: "authenticated", deploymentExposure: "public", env: {} }).warning).toBeNull();
    expect(assertAgentAuthPolicyAllowedForDeployment({ policy: "host_fallback", deploymentMode: "local_trusted", deploymentExposure: "private", env: {} }).warning).toBeNull();
  });
});

describe("AgentAuthPolicyError (TECH-7095)", () => {
  it("carries a stable code and a static message that never includes detail values", () => {
    const error = new AgentAuthPolicyError("ai_connection_required", { adapterType: "claude_local" });
    expect(isAgentAuthPolicyError(error)).toBe(true);
    expect(error.code).toBe("ai_connection_required");
    expect(error.message).not.toContain("claude_local");
    expect(error.details).toEqual({ adapterType: "claude_local" });
    expect(isAgentAuthPolicyError(new Error("x"))).toBe(false);
  });
});
