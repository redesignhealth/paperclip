import { describe, expect, it } from "vitest";
import { shouldAllowPrivateNetworkTargets } from "./constants.js";

// This formula is shared by three SSRF-style guards: remote MCP tool
// connections (tool-access.ts, tool-gateway.ts) and the SSO discovery-sourced
// userinfo_endpoint fetch (better-auth.ts). A round-5 review of the SSO call
// site flagged `authenticated + private` resolving to "allow private network
// targets" as a suspected copy-paste bug -- the reasoning being that the
// guard should only relax for the fully-untrusted-network case. That read is
// wrong: `authenticated + private` means reachability is scoped to the
// operator's own network (Tailscale/VPN/LAN, per doc/DEPLOYMENT-MODES.md),
// not a public/multi-tenant one, so a private destination can't point
// anywhere the operator doesn't already control -- exactly like
// `local_trusted`. `authenticated + public` is the only state where private
// destinations must stay blocked. These four cases pin that down explicitly
// so a future edit that flips the boolean for `authenticated + private`
// (reintroducing the "fix" the mistaken review suggested) fails a test
// instead of silently landing.
describe("shouldAllowPrivateNetworkTargets", () => {
  it("allows private network targets for local_trusted + private", () => {
    expect(
      shouldAllowPrivateNetworkTargets({ deploymentMode: "local_trusted", deploymentExposure: "private" }),
    ).toBe(true);
  });

  it("allows private network targets for local_trusted + public", () => {
    expect(
      shouldAllowPrivateNetworkTargets({ deploymentMode: "local_trusted", deploymentExposure: "public" }),
    ).toBe(true);
  });

  it("allows private network targets for authenticated + private (the case round 5 flagged as a bug)", () => {
    expect(
      shouldAllowPrivateNetworkTargets({ deploymentMode: "authenticated", deploymentExposure: "private" }),
    ).toBe(true);
  });

  it("blocks private network targets only for authenticated + public", () => {
    expect(
      shouldAllowPrivateNetworkTargets({ deploymentMode: "authenticated", deploymentExposure: "public" }),
    ).toBe(false);
  });
});
