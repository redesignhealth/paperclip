import { describe, expect, it } from "vitest";
import { slackOAuthErrorMessage } from "./slack-search-oauth.js";

describe("slackOAuthErrorMessage", () => {
  it.each([
    ["bad_client_secret", /Client Secret.*not the Signing Secret/],
    ["invalid_client_id", /Client ID/],
    ["bad_redirect_uri", /redirect URL/],
    ["invalid_code", /expired or was already used/],
    ["code_already_used", /expired or was already used/],
  ])("maps %s to an actionable message", (code, pattern) => {
    expect(slackOAuthErrorMessage(code)).toMatch(pattern);
  });

  it("includes an unknown but well-formed Slack code", () => {
    expect(slackOAuthErrorMessage("team_not_authorized")).toContain("(team_not_authorized)");
  });

  it.each([undefined, 42, "Bad Code!", "x".repeat(65), "<script>"])(
    "falls back to the generic message for untrusted value %j",
    (code) => {
      const message = slackOAuthErrorMessage(code);
      expect(message).toBe("Slack rejected authorization. Check the app credentials and redirect URL.");
    },
  );
});
