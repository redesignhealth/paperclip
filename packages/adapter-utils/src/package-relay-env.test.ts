import { describe, expect, it } from "vitest";
import { buildPackageRelayEnv, packageRelayAnyOptedIn, packageRelayOptedIn, PACKAGE_RELAY_ROUTE_POLICIES } from "./package-relay-env.js";

const bridge = { PAPERCLIP_API_URL: "http://127.0.0.1:41234", PAPERCLIP_API_KEY: "abc_DEF-123" };

describe("package relay env", () => {
  it("points uv at the gateway for an opted-in agent", () => {
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

  describe("github git relay", () => {
    const repos = "redesignhealth/rh-maiea,acme/other-repo";
    it("adds one git insteadOf rule per configured repo, and nothing for gitea", () => {
      const env = buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "github" }, bridge, repos);
      expect(env.UV_EXTRA_INDEX_URL).toBeUndefined();
      expect(env.GIT_CONFIG_COUNT).toBe("2");
      expect(env.GIT_CONFIG_KEY_0).toBe("url.http://paperclip:abc_DEF-123@127.0.0.1:41234/api/package-relay/github/redesignhealth/rh-maiea.insteadOf");
      expect(env.GIT_CONFIG_VALUE_0).toBe("https://github.com/redesignhealth/rh-maiea");
      expect(env.GIT_CONFIG_KEY_1).toContain("/api/package-relay/github/acme/other-repo.insteadOf");
      expect(env.GIT_CONFIG_VALUE_1).toBe("https://github.com/acme/other-repo");
      // The token is only in key names; no value carries it.
      expect(Object.entries(env).filter(([k, v]) => !k.includes("KEY") && v.includes("abc_DEF-123"))).toEqual([]);
    });

    it("combines with gitea, and adds nothing when the repo list is missing or invalid", () => {
      const both = buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "gitea, github" }, bridge, repos);
      expect(both.UV_EXTRA_INDEX_URL).toBeDefined();
      expect(both.GIT_CONFIG_COUNT).toBe("2");
      for (const bad of [undefined, "", "a", "a/b.git", "a/b,bad repo", "a/b/c"]) {
        expect(Object.keys(buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "github" }, bridge, bad))).toEqual([]);
      }
    });

    it("is off without the github opt-in, and the any-opt-in helper sees either", () => {
      expect(buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "gitea" }, bridge, repos).GIT_CONFIG_COUNT).toBeUndefined();
      expect(packageRelayAnyOptedIn({ PAPERCLIP_PACKAGE_RELAY: "github" })).toBe(true);
      expect(packageRelayAnyOptedIn({})).toBe(false);
    });

    it("matches the git relay routes in the bridge route policy", () => {
      const git = PACKAGE_RELAY_ROUTE_POLICIES.map((p) => p.path as RegExp);
      expect(git.some((r) => r.test("/api/package-relay/github/redesignhealth/rh-maiea/info/refs"))).toBe(true);
      expect(git.some((r) => r.test("/api/package-relay/github/redesignhealth/rh-maiea.git/git-upload-pack"))).toBe(true);
      expect(git.some((r) => r.test("/api/package-relay/github/redesignhealth/rh-maiea/git-receive-pack"))).toBe(false);
    });
  });
});
