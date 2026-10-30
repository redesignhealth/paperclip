import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSlackEmailMissCache, resolveSlackEmail } from "./directory.js";

const human = { id: "U1", team_id: "T1", deleted: false, is_bot: false, profile: { email: "Person@Example.com" } };

function slackFetch(body: unknown, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe("resolveSlackEmail", () => {
  beforeEach(() => {
    resetSlackEmailMissCache();
    vi.stubEnv("PAPERCLIP_SLACK_EMAIL_MATCH_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_SLACK_DIRECTORY_TOKENS", JSON.stringify({ T1: "xoxb-directory" }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("returns the lowercased email of a real workspace human", async () => {
    const fetchImpl = slackFetch({ ok: true, user: human });
    await expect(resolveSlackEmail({ workspaceId: "T1", slackUserId: "U1", fetchImpl })).resolves.toBe("person@example.com");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://slack.com/api/users.info");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-directory");
    expect(new URLSearchParams(String(init?.body)).get("user")).toBe("U1");
  });

  it.each([
    ["deleted", { ...human, deleted: true }],
    ["bot", { ...human, is_bot: true }],
    ["app user", { ...human, is_app_user: true }],
    ["wrong team", { ...human, team_id: "T2" }],
    ["different user", { ...human, id: "U2" }],
    ["no email", { ...human, profile: {} }],
  ])("returns null for a %s", async (_label, user) => {
    await expect(resolveSlackEmail({ workspaceId: "T1", slackUserId: "U1", fetchImpl: slackFetch({ ok: true, user }) })).resolves.toBeNull();
  });

  it("returns null without calling Slack when the workspace has no token", async () => {
    const fetchImpl = slackFetch({ ok: true, user: human });
    await expect(resolveSlackEmail({ workspaceId: "T9", slackUserId: "U1", fetchImpl })).resolves.toBeNull();
    vi.stubEnv("PAPERCLIP_SLACK_DIRECTORY_TOKENS", "not json");
    await expect(resolveSlackEmail({ workspaceId: "T1", slackUserId: "U1", fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null without calling Slack when the flag is off", async () => {
    vi.stubEnv("PAPERCLIP_SLACK_EMAIL_MATCH_ENABLED", "");
    const fetchImpl = slackFetch({ ok: true, user: human });
    await expect(resolveSlackEmail({ workspaceId: "T1", slackUserId: "U1", fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null on Slack errors instead of throwing", async () => {
    await expect(resolveSlackEmail({ workspaceId: "T1", slackUserId: "U1", fetchImpl: slackFetch({ ok: false, error: "missing_scope" }) })).resolves.toBeNull();
    await expect(resolveSlackEmail({ workspaceId: "T1", slackUserId: "U1", fetchImpl: slackFetch({}, 500) })).resolves.toBeNull();
    await expect(resolveSlackEmail({ workspaceId: "T1", slackUserId: "U1", fetchImpl: vi.fn(async () => { throw new Error("network"); }) })).resolves.toBeNull();
  });

  it("caches users with no usable email for ten minutes, but not successes or errors", async () => {
    vi.useFakeTimers();
    const input = { workspaceId: "T1", slackUserId: "U1" };
    const miss = slackFetch({ ok: true, user: { ...human, profile: {} } });
    await resolveSlackEmail({ ...input, fetchImpl: miss });
    await expect(resolveSlackEmail({ ...input, fetchImpl: miss })).resolves.toBeNull();
    expect(miss).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await resolveSlackEmail({ ...input, fetchImpl: miss });
    expect(miss).toHaveBeenCalledTimes(2);

    const failing = slackFetch({ ok: false, error: "ratelimited" });
    await resolveSlackEmail({ workspaceId: "T1", slackUserId: "U2", fetchImpl: failing });
    await resolveSlackEmail({ workspaceId: "T1", slackUserId: "U2", fetchImpl: failing });
    expect(failing).toHaveBeenCalledTimes(2);

    const found = slackFetch({ ok: true, user: { ...human, id: "U3" } });
    await resolveSlackEmail({ workspaceId: "T1", slackUserId: "U3", fetchImpl: found });
    await expect(resolveSlackEmail({ workspaceId: "T1", slackUserId: "U3", fetchImpl: found })).resolves.toBe("person@example.com");
    expect(found).toHaveBeenCalledTimes(2);
  });
});
