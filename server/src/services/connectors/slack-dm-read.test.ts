import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { executeSlackTool } from "./slack.js";
import { registerSlackTaskAuthority, type SlackTaskAuthority } from "./slack-authority.js";

const dmAccessToken = vi.hoisted(() => vi.fn());
vi.mock("./slack-search-oauth.js", () => ({
  slackSearchOAuthService: () => ({ dmAccessToken }),
}));

const BOT = "Bearer xoxb-bot";
const PERSON = "Bearer xoxp-person";

/** The person's DMs with other people are invisible to the bot; only the person's own token can open them. */
describe("Slack DM reads with the person's own token", () => {
  const binding = { companyId: "company", agentId: "agent", runId: "run", issueId: "issue" };
  const authority = {
    endpoint: {
      id: "endpoint",
      companyId: "company",
      providerAccountId: "T1",
      botExternalId: "UBOT",
      allowDirectMessages: true,
      setup: { slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
    },
    conversation: null,
    slackUserId: "U1",
    principalId: "principal",
    userId: "user",
    issueId: "issue",
    deliveryId: null,
    identityContextId: null,
    revision: "revision",
    workMode: "standard",
    botToken: "xoxb-bot",
  } as unknown as SlackTaskAuthority;

  function mockDb() {
    const tx = {
      execute: vi.fn(async () => undefined),
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
    };
    return { ...tx, transaction: async (fn: any) => fn(tx) } as unknown as Db;
  }

  async function withAuthority<T>(run: (db: Db) => Promise<T>) {
    const db = mockDb();
    const unregister = registerSlackTaskAuthority(db, async () => authority);
    try {
      return await run(db);
    } finally {
      unregister();
    }
  }

  function slackFetch() {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = String(input).split("/").at(-1);
      const args = new URLSearchParams(String(init?.body ?? ""));
      const auth = (init?.headers as Record<string, string>).authorization;
      const channel = args.get("channel");
      if (method === "users.info") return Response.json({ ok: true, user: { id: "U1", team_id: "T1" } });
      if (auth === BOT) {
        if (method === "conversations.info") return Response.json({ ok: false, error: "channel_not_found" });
        if (method === "users.conversations") return Response.json({ ok: true, channels: [] });
        throw new Error(`The bot must not call ${method}`);
      }
      expect(auth).toBe(PERSON);
      if (method === "conversations.info") {
        return channel === "DFRIEND"
          ? Response.json({ ok: true, channel: { id: "DFRIEND", is_im: true, user: "UFRIEND" } })
          : channel === "CPUBLIC"
            ? Response.json({ ok: true, channel: { id: "CPUBLIC", is_member: true } })
            : Response.json({ ok: false, error: "channel_not_found" });
      }
      if (method === "conversations.history")
        return Response.json({ ok: true, messages: [{ ts: "9000.1", user: "UFRIEND", text: "dm hello" }], has_more: false });
      if (method === "users.conversations")
        return Response.json({ ok: true, channels: [{ id: "DFRIEND", is_im: true, user: "UFRIEND" }, { id: "GGROUP", is_mpim: true, name: "mpdm-a--b-1" }] });
      throw new Error(`Unexpected personal Slack method ${method}`);
    });
  }

  const calls = (fetchImpl: ReturnType<typeof slackFetch>, method: string, auth: string) =>
    fetchImpl.mock.calls.filter(
      (call) => String(call[0]).endsWith(`/${method}`) && (call[1]?.headers as Record<string, string>).authorization === auth,
    );

  it("reads a DM the bot cannot see with the person's token when they opted in", async () => {
    dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
    await withAuthority(async (db) => {
      const fetchImpl = slackFetch();
      const result = await executeSlackTool(db, binding, "slack_history", { channel: "DFRIEND" }, fetchImpl as unknown as typeof fetch);
      expect(JSON.stringify(result)).toContain("dm hello");
      expect(calls(fetchImpl, "conversations.history", PERSON)).toHaveLength(1);
      expect(calls(fetchImpl, "conversations.history", BOT)).toHaveLength(0);
    });
  });

  it("keeps the original denial when the person did not opt in", async () => {
    dmAccessToken.mockResolvedValue(null);
    await withAuthority(async (db) => {
      const fetchImpl = slackFetch();
      await expect(executeSlackTool(db, binding, "slack_history", { channel: "DFRIEND" }, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403 });
      expect(calls(fetchImpl, "conversations.info", PERSON)).toHaveLength(0);
    });
  });

  it("never opens a channel that is not a DM or group DM with the person's token", async () => {
    dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
    await withAuthority(async (db) => {
      const fetchImpl = slackFetch();
      // A public channel id never reaches the person's token, even when they opted in.
      await expect(executeSlackTool(db, binding, "slack_history", { channel: "CPUBLIC" }, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403 });
      expect(calls(fetchImpl, "conversations.info", PERSON)).toHaveLength(0);
      // A DM id the person's token cannot open keeps the original denial.
      await expect(executeSlackTool(db, binding, "slack_history", { channel: "DNOTYOURS" }, fetchImpl as unknown as typeof fetch))
        .rejects.toMatchObject({ status: 403 });
      expect(calls(fetchImpl, "conversations.history", PERSON)).toHaveLength(0);
    });
  });

  it("lists the person's own DMs only when they opted in", async () => {
    await withAuthority(async (db) => {
      dmAccessToken.mockResolvedValue({ token: "xoxp-person" });
      await expect(executeSlackTool(db, binding, "slack_channels", {}, slackFetch() as unknown as typeof fetch)).resolves.toMatchObject({
        channels: expect.arrayContaining([
          expect.objectContaining({ id: "DFRIEND", direct: true, with: "UFRIEND", source: "personal_dm" }),
          expect.objectContaining({ id: "GGROUP", source: "personal_dm" }),
        ]),
      });
      dmAccessToken.mockResolvedValue(null);
      const without = (await executeSlackTool(db, binding, "slack_channels", {}, slackFetch() as unknown as typeof fetch)) as { channels: unknown[] };
      expect(without.channels).toEqual([]);
    });
  });
});
