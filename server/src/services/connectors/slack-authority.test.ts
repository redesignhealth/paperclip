import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createInboundWakeAuthority } from "../chat-channels/inbound/wakeup-authorization.js";
import { isSlackAuthorizationDenial } from "./slack-tool-discovery.js";
import {
  registerSlackTaskAuthority,
  resolveSlackTaskAuthorization,
  resolveSlackTaskAuthority,
  slackRunOrigin,
  type SlackTaskAuthority,
  type SlackTaskBinding,
} from "./slack-authority.js";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../run-identity.js", () => ({ captureRunIdentity: capture }));

const binding: SlackTaskBinding = {
  companyId: "company",
  agentId: "agent",
  issueId: "issue",
  runId: "run",
};

describe("Slack authority registration", () => {
  it.each(["missing-approval", "changed-approval", "changed-context", "no-requester", "wrong-task"])("tags %s origin eligibility denials", async fault => {
    const issueId = "00000000-0000-4000-8000-000000000001";
    const task = { ...binding, issueId, identityContextId: "context", ...(fault.includes("approval") ? { approvedInvocationId: "approval" } : {}) };
    capture.mockResolvedValue({ run: { nativeIssueId: fault === "wrong-task" ? "00000000-0000-4000-8000-000000000002" : issueId,
      responsibleUserId: fault === "no-requester" ? null : "user" }, context: { id: fault === "changed-context" ? "other" : "context" } });
    let reads = 0;
    const db = { select: () => ({ from: () => ({
      innerJoin: () => ({ where: async () => fault === "missing-approval" ? [] : [{ invocation: {} }] }),
      where: async () => ++reads === 1 ? [{ responsibleUserId: "user", activeIdentityContextId: "other" }] : [{ id: "context", responsibleUserId: "user" }],
    }) }) } as unknown as Db;
    await expect(slackRunOrigin(db, task)).rejects.toMatchObject({ status: 403, details: { code: "slack_task_authorization_denied" } });
  });
  it("recognizes the inbound wake authority's source-tagged denial", async () => {
    const db = {} as Db;
    const { authorizeInboundWakeup } = createInboundWakeAuthority(db, {} as Parameters<typeof createInboundWakeAuthority>[1]);
    const error = await authorizeInboundWakeup(db, { payload: {} } as Parameters<typeof authorizeInboundWakeup>[1]).catch(error => error);
    expect(error).toMatchObject({ status: 403, details: { code: "chat_action_authorization_changed" } });
    expect(isSlackAuthorizationDenial(error)).toBe(true);
  });

  it("requires a live registration for authorization and revision resolution", async () => {
    const db = {} as Db;
    await expect(resolveSlackTaskAuthorization(db, binding)).rejects.toMatchObject({ status: 403 });
    await expect(resolveSlackTaskAuthority(db, binding)).rejects.toMatchObject({ status: 403 });
  });

  it("retains existing resolver compatibility without caching its result", async () => {
    const db = {} as Db;
    const first = { revision: "first" } as SlackTaskAuthority;
    const second = { revision: "second" } as SlackTaskAuthority;
    const resolve = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(second);
    const unregister = registerSlackTaskAuthority(db, resolve);
    try {
      expect(await resolveSlackTaskAuthorization(db, binding)).toBe(first);
      expect(await resolveSlackTaskAuthorization(db, binding)).toBe(second);
      expect(await resolveSlackTaskAuthority(db, binding)).toBe(second);
      expect(resolve.mock.calls).toEqual([[binding], [binding], [binding]]);
      expect(resolve.mock.contexts).toEqual([undefined, undefined, undefined]);
    } finally { unregister(); }
  });

  it("uses live authorization separately from the revision resolver", async () => {
    const db = {} as Db;
    const full = { revision: "current" } as SlackTaskAuthority;
    const resolve = vi.fn(async () => full);
    const authorize = vi.fn(async () => full);
    const unregister = registerSlackTaskAuthority(db, resolve, authorize);
    try {
      expect(await resolveSlackTaskAuthorization(db, binding)).toBe(full);
      expect(authorize).toHaveBeenCalledWith(binding);
      expect(resolve).not.toHaveBeenCalled();
      expect(await resolveSlackTaskAuthority(db, binding)).toBe(full);
      expect(resolve).toHaveBeenCalledWith(binding);
    } finally { unregister(); }
  });

  it("does not unregister a replacement service's authorization", async () => {
    const db = {} as Db;
    const old = { revision: "old" } as SlackTaskAuthority;
    const current = { revision: "current" } as SlackTaskAuthority;
    const unregisterOld = registerSlackTaskAuthority(db, async () => old, async () => old);
    const unregisterCurrent = registerSlackTaskAuthority(db, async () => current, async () => current);
    try {
      unregisterOld();
      expect(await resolveSlackTaskAuthorization(db, binding)).toBe(current);
      expect(await resolveSlackTaskAuthority(db, binding)).toBe(current);
    } finally { unregisterCurrent(); }
    await expect(resolveSlackTaskAuthorization(db, binding)).rejects.toMatchObject({ status: 403 });
  });
});
