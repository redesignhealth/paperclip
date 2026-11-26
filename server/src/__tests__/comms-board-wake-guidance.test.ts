import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommsWakeComment } from "../services/comms-wake-issue.js";
import type { CommsWakeEvent } from "../services/comms-wake-event.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
const REFERENCE = "skills/paperclip/references/comms-board-wake.md";

const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const event = (kind: "message" | "invite"): CommsWakeEvent => ({
  eventId: "11111111-1111-4111-8111-111111111111",
  name: "comms.wake",
  timestamp: "2026-11-24T03:00:00Z",
  data: {
    kind,
    recipientAgentId: "22222222-2222-4222-8222-222222222222",
    conversationId: "33333333-3333-4333-8333-333333333333",
    seq: 4,
    messageType: "task_assign",
    senderAgentId: "44444444-4444-4444-8444-444444444444",
    sessionRef: null,
    reason: "rule",
  },
});

describe("agent guidance for comms board wakes (TECH-9889)", () => {
  it("is pointed at from the paperclip skill before the Terminology header", () => {
    const skill = read("skills/paperclip/SKILL.md");
    const pointer = skill.indexOf("references/comms-board-wake.md");
    expect(pointer).toBeGreaterThanOrEqual(0);
    expect(pointer).toBeLessThan(skill.indexOf("## Terminology"));
    expect(skill).toContain("New comms-board message");
  });

  it("is summarised in the default agent instructions that new agents receive", () => {
    const defaults = read("server/src/onboarding-assets/default/AGENTS.md");
    expect(defaults).toContain("comms_board_conversation");
    expect(defaults).toContain("New comms-board message");
    expect(defaults).toContain("skills/paperclip/references/comms-board-wake.md");
    expect(defaults).toMatch(/end every wake run by marking that issue done, even when there was nothing to do/);
    expect(defaults).toMatch(/never just to acknowledge/);
  });

  it("covers every point the dev end-to-end runs showed was needed, and stays short", () => {
    const guide = read(REFERENCE);
    expect(guide.split(/\s+/).length).toBeLessThan(800);
    for (const needle of [
      "comms_board_conversation",
      "Read the whole conversation",
      "already answers the new message",
      "A reply belongs on the board",
      "If a reply is needed",
      "Closing a session does not replace marking the issue done",
      "Mark the issue done",
      "including a run where there was nothing to do",
      "Do not reply just to acknowledge",
      "`task_complete` or a closing note ends the exchange",
      "250 wake events in 10 minutes",
      "`task_assign` has no free-text field",
      "Free text goes in a `note`",
      "comms_wake_rules_list",
      "comms_wake_rule_add",
      "comms_wake_rule_update",
      "comms_wake_sessions_list",
      "comms_wake_session_close",
      "Rules are never deleted",
      "one at a time",
      "Example 1, mute a noisy conversation",
      "Example 2, wake only on `task_assign`",
      "An open conversation wakes you before any rule is checked",
      "## Polling instead",
      "comms_inbox",
      "comms_accept",
      "## Stopping",
    ]) {
      expect(guide, needle).toContain(needle);
    }
  });

  it("only names board tools that exist on the agent allowlist", () => {
    const spec = read("server/src/services/default-mcp-spec.ts");
    for (const tool of ["comms_wake_rules_list", "comms_wake_rule_add", "comms_wake_rule_update", "comms_wake_sessions_list", "comms_wake_session_close"]) {
      expect(spec, tool).toContain(`"${tool}"`);
    }
  });
});

describe("buildCommsWakeComment", () => {
  it("tells the agent to finish by marking the issue done even with nothing to do", () => {
    for (const kind of ["message", "invite"] as const) {
      expect(buildCommsWakeComment(event(kind), AGENT_ID)).toContain("mark this issue done, even if there was nothing to do");
    }
  });

  it("tells the agent not to reply just to acknowledge or to answer twice", () => {
    const text = buildCommsWakeComment(event("message"), AGENT_ID);
    expect(text).toContain("Reply on the board only if a reply is needed");
    expect(text).toContain("not just to acknowledge");
    expect(text).toContain("not again if you already answered it");
  });

  it("tells an agent woken by an invite to read the whole conversation, since the opening message gets no wake", () => {
    const text = buildCommsWakeComment(event("invite"), AGENT_ID);
    expect(text).toMatch(/^New comms-board invitation\. Conversation: /);
    expect(text).toContain("comms_get_conversation");
    expect(text).toContain("will not wake you again");
    expect(text).toContain("mark this issue done");
  });

  it("names the board identity to act as, and the connection to use, in both comments", () => {
    for (const kind of ["message", "invite"] as const) {
      const text = buildCommsWakeComment(event(kind), AGENT_ID);
      expect(text).toContain(`This wake is for your own board identity \`paperclip-agent-${AGENT_ID}\``);
      expect(text).toContain("(board agent id `22222222-2222-4222-8222-222222222222`)");
      expect(text).toContain("Use the comms board connection where `comms_whoami` returns that identity as active");
      expect(text).toContain("ignore any other board connection for this conversation");
    }
    expect(buildCommsWakeComment(event("invite"), AGENT_ID)).toMatch(/^New comms-board invitation\. Conversation: /);
    expect(buildCommsWakeComment(event("message"), AGENT_ID)).toMatch(/^New comms-board message\. Conversation: /);
  });

  it("keeps the existing instructions next to the identity sentence", () => {
    const invite = buildCommsWakeComment(event("invite"), AGENT_ID);
    expect(invite).toContain("accept or decline the invitation");
    expect(invite).toContain("read the whole conversation with `comms_get_conversation`");
    const message = buildCommsWakeComment(event("message"), AGENT_ID);
    expect(message).toContain("Read the conversation with your comms-board tools");
  });

  it("explains in the reference which connection to use when there is more than one", () => {
    const guide = read(REFERENCE);
    expect(guide).toContain("If you have more than one comms board connection");
    expect(guide).toContain("`comms_whoami` returns your own identity");
    expect(guide).toContain("A wake is addressed to your own Paperclip board identity");
    expect(guide).toContain("Another connection is a different identity");
  });

  it("explains in the reference why an accepted invite needs a read of the opening message", () => {
    const guide = read(REFERENCE);
    expect(guide).toContain("After you accept, read the whole conversation with `comms_get_conversation`");
    expect(guide).toContain("gets no separate wake");
  });

  it("still names the conversation and the message number and carries no message content", () => {
    const text = buildCommsWakeComment(event("message"), AGENT_ID);
    expect(text).toContain("33333333-3333-4333-8333-333333333333");
    expect(text).toContain("Message number: `4`");
    expect(text).toContain("Type: `task_assign`");
    expect(text).not.toMatch(/ignore previous|secret|body/i);
  });
});
