import { describe, expect, it } from "vitest";
import { buildPackageRelayEnv, packageRelayOptedIn, PACKAGE_RELAY_ROUTE_POLICIES } from "./package-relay-env.js";

const bridge = { PAPERCLIP_API_URL: "http://127.0.0.1:41234", PAPERCLIP_API_KEY: "abc_DEF-123" };

describe("package relay env", () => {
  it("points uv and pip at the gateway for an opted-in agent", () => {
    const env = buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "gitea" }, bridge);
    expect(env.UV_EXTRA_INDEX_URL).toBe("http://paperclip:abc_DEF-123@127.0.0.1:41234/api/package-relay/gitea/simple/");
    // pip merges indexes and takes the highest version, so it is never configured.
    expect(env.PIP_EXTRA_INDEX_URL).toBeUndefined();
    expect(Object.keys(env)).toEqual(["UV_EXTRA_INDEX_URL"]);
  });

  it("registers one bridge route policy that matches exactly the relay routes", () => {
    const [policy] = PACKAGE_RELAY_ROUTE_POLICIES;
    const path = policy!.path as RegExp;
    expect(path.test("/api/package-relay/gitea/simple/rh-auth/")).toBe(true);
    expect(path.test("/api/package-relay/gitea/files/rh-auth/1.0.0/rh_auth-1.0.0-py3-none-any.whl")).toBe(true);
    expect(path.test("/api/package-relay/gitea/simple/")).toBe(false);
    expect(path.test("/api/agents/me")).toBe(false);
    expect(policy!.deadlineMs).toBeGreaterThan(60_000);
  });

  it("accepts a plain env binding and a list", () => {
    expect(packageRelayOptedIn({ PAPERCLIP_PACKAGE_RELAY: { type: "plain", value: "github, Gitea" } }, "gitea")).toBe(true);
  });

  it("adds nothing without opt-in, a bridge, or for an unsafe token or URL", () => {
    expect(buildPackageRelayEnv({}, bridge)).toEqual({});
    expect(buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "github" }, bridge)).toEqual({});
    expect(buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "gitea" }, {})).toEqual({});
    expect(buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "gitea" }, { ...bridge, PAPERCLIP_API_KEY: "a@b/c" })).toEqual({});
    expect(buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "gitea" }, { ...bridge, PAPERCLIP_API_URL: "http://u:p@127.0.0.1:1" })).toEqual({});
    expect(buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "gitea" }, { ...bridge, PAPERCLIP_API_URL: "not a url" })).toEqual({});
  });
});
