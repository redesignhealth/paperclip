import { describe, expect, it, vi } from "vitest";
import { SLACK_CHAT_BOT_SCOPES, SLACK_DEFAULT_BOT_SCOPES, slackOptInScopes } from "@paperclipai/shared";
import { verifySlackCredentials } from "./credentials.js";

function authTest(scopes: readonly string[]) {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json(
    { ok: true, team_id: "T1", team: "Team", user_id: "UBOT", user: "maya" },
    { headers: { "x-oauth-scopes": scopes.join(",") } },
  ));
}

/**
 * TECH-7988: a token must hold the chat floor plus the opt-in scopes its caller
 * requires -- the installed groups for a stored token, the requested groups for
 * a replacement token. These cases pass that set as `requiredOptInScopes`.
 */
describe("Slack credential scope verification", () => {
  it("accepts an app holding only the chat floor when no opt-in scope is required", async () => {
    await expect(verifySlackCredentials({ botToken: "xoxb-test" }, authTest(SLACK_CHAT_BOT_SCOPES), 1_000))
      .resolves.toMatchObject({ providerAccountId: "T1", botExternalId: "UBOT" });
  });

  it("accepts a trimmed default install, which no longer needs files:write", async () => {
    expect(SLACK_DEFAULT_BOT_SCOPES).not.toContain("files:write");
    await expect(verifySlackCredentials({ botToken: "xoxb-test" }, authTest(SLACK_DEFAULT_BOT_SCOPES), 1_000)).resolves.toBeTruthy();
  });

  it("rejects an app missing a scope from a required opt-in group", async () => {
    await expect(verifySlackCredentials({ botToken: "xoxb-test" }, authTest(SLACK_DEFAULT_BOT_SCOPES), 1_000, slackOptInScopes(["file_upload"])))
      .rejects.toMatchObject({ details: { code: "chat_provider_permissions_missing", missingScopes: ["files:write"] } });
  });

  it("accepts an app holding a required opt-in group's scopes", async () => {
    const extra = slackOptInScopes(["channel_management"]);
    await expect(verifySlackCredentials({ botToken: "xoxb-test" }, authTest([...SLACK_DEFAULT_BOT_SCOPES, ...extra]), 1_000, extra)).resolves.toBeTruthy();
  });

  it("still rejects an app missing a chat floor scope", async () => {
    const granted = SLACK_CHAT_BOT_SCOPES.filter(scope => scope !== "chat:write");
    await expect(verifySlackCredentials({ botToken: "xoxb-test" }, authTest(granted), 1_000))
      .rejects.toMatchObject({ details: { missingScopes: ["chat:write"] } });
  });
});
