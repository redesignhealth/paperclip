import { describe, expect, it } from "vitest";
import { buildPackageRelayEnv, packageRelayOptedIn } from "./package-relay-env.js";

const bridge = { PAPERCLIP_API_URL: "http://127.0.0.1:41234", PAPERCLIP_API_KEY: "abc_DEF-123" };

describe("package relay env", () => {
  it("points uv and pip at the gateway for an opted-in agent", () => {
    const env = buildPackageRelayEnv({ PAPERCLIP_PACKAGE_RELAY: "gitea" }, bridge);
    expect(env.UV_EXTRA_INDEX_URL).toBe("http://paperclip:abc_DEF-123@127.0.0.1:41234/api/package-relay/gitea/simple/");
    expect(env.PIP_EXTRA_INDEX_URL).toBe(env.UV_EXTRA_INDEX_URL);
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
