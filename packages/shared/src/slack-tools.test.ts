import { describe, expect, it } from "vitest";
import { SLACK_TOOLS } from "./slack-tools.js";

describe("Slack tool catalog definitions", () => {
  it("instructs agents reading channel history to call slack_thread for reply content", () => {
    const historyTool = SLACK_TOOLS.find((tool) => tool.name === "slack_history");
    expect(historyTool).toBeDefined();
    expect(historyTool?.description).toContain("replyCount");
    expect(historyTool?.description).toContain("slack_thread");
    expect(historyTool?.description).toContain("channel");
    expect(historyTool?.description).toContain("ts");
  });

  it("instructs agents to use slack_thread to get full reply content for threads found via other tools", () => {
    const threadTool = SLACK_TOOLS.find((tool) => tool.name === "slack_thread");
    expect(threadTool).toBeDefined();
    expect(threadTool?.description).toContain("full reply content");
    expect(threadTool?.description).toContain("slack_history");
    expect(threadTool?.description).toContain("slack_search");
    expect(threadTool?.description).toContain("slack_message");
    expect(threadTool?.description).toContain("Paginate");
  });
});
