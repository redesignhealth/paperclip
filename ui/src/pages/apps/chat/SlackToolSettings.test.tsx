// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SlackToolCapabilities } from "@paperclipai/shared";
import { SlackCapabilitiesView } from "./SlackToolSettings";

function guidance(action: "enable" | "reconnect") {
  const capabilities: SlackToolCapabilities = {
    grantedScopes: ["chat:write"], missingScopes: [], tools: [],
    missingGroups: [{ group: "file_upload", label: "File upload", description: "Upload attachments.",
      scopes: ["files:write"], toolNames: ["slack_upload_file"], action }],
  };
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(<SlackCapabilitiesView capabilities={capabilities} />);
  return element.textContent!;
}

describe("Slack permission group guidance", () => {
  it("asks to turn on a group not yet requested, then reconnect", () => {
    expect(guidance("enable")).toContain("Turn on File upload");
    expect(guidance("enable")).toContain("reconnect");
  });
  it("asks only to reconnect for an already-requested group awaiting its grant", () => {
    expect(guidance("reconnect")).toContain("already requested");
    expect(guidance("reconnect")).toContain("reconnect");
    expect(guidance("reconnect")).not.toContain("Turn on");
    expect(guidance("reconnect")).toContain("slack_upload_file");
  });
});
