import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { executeSlackTool } from "./slack.js";
import { registerSlackTaskAuthority, type SlackTaskAuthority } from "./slack-authority.js";

/**
 * TECH-7988: a tool this agent did not opt into must be rejected before any
 * Slack API call, not surfaced later as a Slack `missing_scope`.
 */
describe("Slack tool dispatch opt-in gating", () => {
  const binding = {
    companyId: "company",
    agentId: "agent",
    runId: "run",
    issueId: "issue",
  };

  function authority(setup: Record<string, unknown>) {
    return {
      endpoint: {
        id: "endpoint",
        companyId: "company",
        providerAccountId: "T1",
        botExternalId: "UBOT",
        allowDirectMessages: true,
        setup,
      },
      conversation: null,
      slackUserId: "U1",
      principalId: "principal",
      userId: "user",
      deliveryId: null,
      identityContextId: null,
      revision: "revision",
      workMode: "standard",
      botToken: "xoxb-test",
    } as unknown as SlackTaskAuthority;
  }

  it.each([
    ["slack_upload_file", { attachmentId: "00000000-0000-4000-8000-000000000000", channel: "C1", idempotencyKey: "00000000-0000-4000-8000-000000000001" }],
    ["slack_open_dm", { idempotencyKey: "00000000-0000-4000-8000-000000000002" }],
  ])("rejects %s before any Slack call when the group is off", async (tool, args) => {
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => authority({ slackOptInScopeGroups: [] }));
    const fetchImpl = vi.fn();
    try {
      await expect(executeSlackTool(db, binding, tool, args, fetchImpl as unknown as typeof fetch))
        .rejects.toThrow("is not enabled for this agent");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("keeps a tool disabled until a pending opt-in change is actually installed", async () => {
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => authority({
      slackOptInScopeGroups: ["file_upload"],
      slackInstalledOptInScopeGroups: [],
    }));
    const fetchImpl = vi.fn();
    try {
      await expect(executeSlackTool(db, binding, "slack_upload_file", {
        attachmentId: "00000000-0000-4000-8000-000000000000",
        channel: "C1",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }, fetchImpl as unknown as typeof fetch)).rejects.toThrow("is not enabled for this agent");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});

describe("Slack governed dispatch opt-in gating", () => {
  it("names the missing opt-in before entering the tool gateway", async () => {
    const { executeGovernedSlackTool } = await import("./slack.js");
    const db = {} as Db;
    const unregister = registerSlackTaskAuthority(db, async () => ({
      endpoint: { id: "endpoint", companyId: "company", setup: { slackOptInScopeGroups: [] } },
    }) as unknown as SlackTaskAuthority);
    try {
      await expect(executeGovernedSlackTool(db, { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" },
        "slack_create_channel", { name: "launch", is_private: false, idempotencyKey: "00000000-0000-4000-8000-000000000003" }))
        .rejects.toMatchObject({ status: 403, details: { code: "slack_tool_not_enabled", groups: ["channel_management"] } });
    } finally {
      unregister();
    }
  });
});
