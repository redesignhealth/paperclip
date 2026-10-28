import { describe, expect, it } from "vitest";
import {
  SLACK_DEFAULT_BOT_SCOPES,
  SLACK_TOOLS,
  slackBotScopes,
  slackOptInGroupsFromScopes,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import {
  assertSlackToolEnabledForSetup,
  isSlackToolEnabledForSetup,
  slackEnabledToolsForSetup,
} from "./slack-opt-ins.js";

function names(groups: SlackOptInScopeGroup[]): string[] {
  // Gating reads the installed set only; a request alone installs nothing.
  return slackEnabledToolsForSetup({
    slackOptInScopeGroups: groups,
    slackInstalledOptInScopeGroups: groups,
  })
    .map((tool) => String(tool.name))
    .sort();
}

describe("Slack tool opt-in gating", () => {
  it("offers every tool except the four gated ones by default", () => {
    const enabled = new Set(names([]));
    for (const name of ["slack_create_channel", "slack_invite", "slack_open_dm", "slack_upload_file"]) {
      expect(enabled.has(name)).toBe(false);
    }
    for (const name of ["slack_history", "slack_thread", "slack_post_message", "slack_reactions", "slack_pins", "slack_canvases"]) {
      if (SLACK_TOOLS.some((tool) => tool.name === name)) expect(enabled.has(name)).toBe(true);
    }
    // Only the gated tools are excluded from the full catalog.
    expect(enabled.size).toBe(SLACK_TOOLS.length - 4);
  });

  it("adds exactly the tools each group unlocks, and keeps search enabled", () => {
    expect(names(["channel_management"])).toEqual(
      names([]).concat(["slack_create_channel", "slack_invite"]).sort(),
    );
    expect(names(["proactive_dms"])).toEqual(names([]).concat("slack_open_dm").sort());
    expect(names(["file_upload"])).toEqual(names([]).concat("slack_upload_file").sort());
    // search:read.* comes from the personal-search OAuth flow, never the manifest.
    expect(isSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: [] }, { name: "slack_search", scopes: ["search:read.public", "search:read.files"] })).toBe(true);
  });

  it("treats each alternative in an `a|b` requirement as sufficient", () => {
    const channelTools = SLACK_TOOLS.filter((tool) => ["slack_create_channel", "slack_invite"].includes(tool.name));
    for (const tool of channelTools) {
      expect(isSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: [] }, tool)).toBe(false);
      expect(isSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: ["channel_management"] }, tool)).toBe(true);
    }
  });

  it("keeps a live install's tools while a pending opt-in change is not installed", () => {
    // Requested: nothing. Installed: channel management. The grant is live.
    expect(isSlackToolEnabledForSetup({
      slackOptInScopeGroups: [],
      slackInstalledOptInScopeGroups: ["channel_management"],
    }, { name: "slack_create_channel", scopes: ["channels:manage|groups:write"] })).toBe(true);
  });

  it("does not offer a tool Slack has not granted yet", () => {
    // Requested: file upload. Installed: nothing. Slack has no files:write.
    expect(isSlackToolEnabledForSetup({
      slackOptInScopeGroups: ["file_upload"],
      slackInstalledOptInScopeGroups: [],
    }, { name: "slack_upload_file", scopes: ["files:write"] })).toBe(false);
  });

  it("rejects a non-enabled tool with a clear error naming the group", () => {
    expect(() => assertSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: [] }, "slack_upload_file"))
      .toThrow("slack_upload_file is not enabled for this agent");
    expect(() => assertSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: [] }, "slack_upload_file"))
      .toThrow("File upload");
  });

  it("allows an installed tool through the guard", () => {
    expect(() => assertSlackToolEnabledForSetup({ slackInstalledOptInScopeGroups: ["file_upload"] }, "slack_upload_file")).not.toThrow();
  });

  it("rejects an unknown tool name cleanly instead of asserting later", () => {
    expect(() => assertSlackToolEnabledForSetup(undefined, "not_a_slack_tool"))
      .toThrow("Unknown Slack tool: not_a_slack_tool");
    expect(() => assertSlackToolEnabledForSetup(undefined, "not_a_slack_tool"))
      .toThrow(expect.objectContaining({ details: { code: "slack_tool_unknown" } }));
  });

  it("defaults a new endpoint with no fields to no opt-in groups", () => {
    // S1: nothing requested, nothing installed, no prior install.
    expect(names([])).toEqual(slackEnabledToolsForSetup({ slackInstalledOptInScopeGroups: [] }).map(tool => String(tool.name)).sort());
    expect(slackEnabledToolsForSetup({}).map(tool => String(tool.name))).not.toContain("slack_upload_file");
    expect(slackEnabledToolsForSetup({}).map(tool => String(tool.name))).not.toContain("slack_create_channel");
  });

  it("keeps a requested-but-not-installed group gated", () => {
    const setup = { slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: [] };
    expect(slackEnabledToolsForSetup(setup).map(tool => String(tool.name))).not.toContain("slack_upload_file");
    expect(() => assertSlackToolEnabledForSetup(setup, "slack_upload_file")).toThrow("not enabled for this agent");
  });

  it("keeps the legacy full grant only for a prior install", () => {
    // S3: gating, capabilities and the tool list share one resolution.
    const legacy = slackEnabledToolsForSetup({}, { legacyInstall: true }).map(tool => String(tool.name));
    expect(legacy).toContain("slack_upload_file");
    expect(legacy).toContain("slack_create_channel");
    expect(slackEnabledToolsForSetup({}).map(tool => String(tool.name))).not.toContain("slack_upload_file");
  });

  it("matches the request helper's scope set", () => {
    expect(slackBotScopes(["channel_management", "proactive_dms"])).toEqual(
      expect.arrayContaining(["channels:manage", "groups:write", "im:write"]),
    );
  });
});

describe("Slack installed groups derived from the token's grant", () => {
  it("counts a group only when every one of its scopes was granted", () => {
    // channels:manage + groups:write are both needed.
    expect(slackOptInGroupsFromScopes(["channels:manage"])).toEqual([]);
    expect(slackOptInGroupsFromScopes(["channels:manage", "groups:write"])).toEqual(["channel_management"]);
    expect(slackOptInGroupsFromScopes(["files:write"])).toEqual(["file_upload"]);
    expect(slackOptInGroupsFromScopes([])).toEqual([]);
  });

  it("leaves a partially granted group's tools gated", () => {
    // Slack granted only part of channel management, so the marker omits it.
    const installed = slackOptInGroupsFromScopes([...SLACK_DEFAULT_BOT_SCOPES, "channels:manage"]);
    expect(installed).not.toContain("channel_management");
    const setup = { slackOptInScopeGroups: ["channel_management" as const], slackInstalledOptInScopeGroups: installed };
    expect(isSlackToolEnabledForSetup(setup, { name: "slack_create_channel", scopes: ["channels:manage|groups:write"] })).toBe(false);
    expect(() => assertSlackToolEnabledForSetup(setup, "slack_create_channel")).toThrow("not enabled for this agent");
  });
});
