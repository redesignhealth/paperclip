import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommsWakeComment } from "../services/comms-wake-issue.js";
import type { CommsWakeEvent } from "../services/comms-wake-event.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
const REFERENCE = "skills/paperclip/references/comms-board-wake.md";

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
    expect(guide.split(/\s+/).length).toBeLessThan(750);
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
      expect(buildCommsWakeComment(event(kind))).toContain("mark this issue done, even if there was nothing to do");
    }
  });

  it("tells the agent not to reply just to acknowledge or to answer twice", () => {
    const text = buildCommsWakeComment(event("message"));
    expect(text).toContain("Reply on the board only if a reply is needed");
    expect(text).toContain("not just to acknowledge");
    expect(text).toContain("not again if you already answered it");
  });

  it("still names the conversation and the message number and carries no message content", () => {
    const text = buildCommsWakeComment(event("message"));
    expect(text).toContain("33333333-3333-4333-8333-333333333333");
    expect(text).toContain("Message number: `4`");
    expect(text).toContain("Type: `task_assign`");
  });
});
