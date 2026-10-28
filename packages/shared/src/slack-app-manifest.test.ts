import { describe, expect, it } from "vitest";
import { buildSlackAppManifest, defaultSlackAppConfiguration, slackRegistrationSchema, slackAccountStateSchema, slackConfigurationCredentialSaveSchema, slackRegistrationErrorMessage } from "./slack-app-manifest.js";
import { createChatEndpointSchema, slackAppConfigurationSchema } from "./validators/chat-channels.js";

describe("Slack app manifest", () => {
  it("preserves older account setup state and validates optional verification delivery state", () => {
    const account = { externalUserId: "UINSTALLER", paperclipUserId: "board-user", status: "linked", welcomeStatus: "sent" };
    expect(slackAccountStateSchema.safeParse(account).success).toBe(true);
    for (const verificationStatus of ["pending", "sending", "sent", "failed", "uncertain"]) {
      expect(slackAccountStateSchema.safeParse({ ...account, verificationStatus }).success).toBe(true);
    }
    expect(slackAccountStateSchema.safeParse({ ...account, verificationStatus: "delivered" }).success).toBe(false);
  });
  it("uses readable, valid agent defaults and accepts them atomically with a new Slack draft", () => {
    expect(defaultSlackAppConfiguration("Maya")).toEqual({ appName: "maya-paperclip", botName: "maya", command: "/maya" });
    for (const name of ["Research Lead", "Áda Lovelace", "A.B_C", "", "Very long agent name that needs truncating"]) {
      expect(slackAppConfigurationSchema.safeParse(defaultSlackAppConfiguration(name)).success).toBe(true);
    }
    const request = { provider: "slack", assignedAgentId: "12345678-1234-4123-8123-123456789abc", slackApp: defaultSlackAppConfiguration("Maya") };
    expect(createChatEndpointSchema.safeParse(request).success).toBe(true);
    expect(createChatEndpointSchema.safeParse({ ...request, provider: "discord" }).success).toBe(false);
  });
  const input = { app: { appName: 'Research "Ops"', botName: "research-ops", command: "/research" }, agentName: "Maya", webhookUrl: "https://ingress.example/api/chat-webhooks/public/slack" };
  it("uses identical manual and automatic configuration except the OAuth redirect", () => {
    const manual = buildSlackAppManifest(input);
    const automatic = buildSlackAppManifest({ ...input, redirectUri: "https://board.example/api/chat-slack/oauth/callback" });
    expect(automatic).toEqual({ ...manual, oauth_config: { ...manual.oauth_config, redirect_urls: ["https://board.example/api/chat-slack/oauth/callback"] } });
    expect(manual.features.bot_user.display_name).toBe("research-ops");
    expect(manual.features.slash_commands[0]).toMatchObject({ command: "/research", url: input.webhookUrl, should_escape: false });
    expect(manual.settings.event_subscriptions.request_url).toBe(input.webhookUrl);
    expect(manual.settings.interactivity).toEqual({ is_enabled: true, request_url: input.webhookUrl });
    expect(manual.settings.socket_mode_enabled).toBe(false);
    expect(manual.features).toHaveProperty("agent_view");
    expect(manual.features).not.toHaveProperty("assistant_view");
    expect(manual.features.bot_user).not.toHaveProperty("always_online");
    expect(manual.features.app_home).toEqual({
      home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false,
    });
    // The reviewed provider permissions/events stay pinned across both creation paths.
    expect(manual.oauth_config.scopes.bot).toMatchSnapshot();
    expect(manual.settings.event_subscriptions.bot_events).toMatchSnapshot();
  });
  it("rejects arbitrary manifests, scopes, callback destinations, and refresh tokens", () => {
    const request = { requestId: "12345678-1234-4123-8123-123456789abc", credentials: { configurationToken: "temporary" } };
    expect(slackRegistrationSchema.safeParse(request).success).toBe(true);
    for (const key of ["manifest", "scopes", "callbackUri", "configurationRefreshToken", "avatarUrl"])
      expect(slackRegistrationSchema.safeParse({ ...request, [key]: "untrusted" }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { ...request.credentials, refreshToken: "untrusted" } }).success).toBe(false);
  });
  it("accepts a saved configuration credential id as an alternative to an access token", () => {
    const request = { requestId: "12345678-1234-4123-8123-123456789abc" };
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationCredentialId: "12345678-1234-4123-8123-123456789abc" } }).success).toBe(true);
    // Both variants are strict: neither extra keys nor a second source is accepted.
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationCredentialId: "12345678-1234-4123-8123-123456789abc", configurationToken: "temporary" } }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationCredentialId: "not-a-uuid" } }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationCredentialId: "12345678-1234-4123-8123-123456789abc", extra: "untrusted" } }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { configurationToken: "temporary", extra: "untrusted" } }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: {} }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { refreshToken: "xoxe-1-untrusted" } }).success).toBe(false);
  });
  it("validates a saved refresh token shape strictly", () => {
    const save = (credentials: unknown) => slackConfigurationCredentialSaveSchema.safeParse({ credentials }).success;
    expect(save({ refreshToken: "xoxe-1-abc" })).toBe(true);
    expect(save({ refreshToken: "  xoxe-1-padded  " })).toBe(true);
    expect(save({ refreshToken: "xoxp-1234" })).toBe(false);
    expect(save({ refreshToken: "" })).toBe(false);
    expect(save({ refreshToken: "xoxe-1-abc", extra: "untrusted" })).toBe(false);
    expect(slackConfigurationCredentialSaveSchema.safeParse({ credentials: { refreshToken: "xoxe-1-abc" }, extra: true }).success).toBe(false);
  });
  it("returns specific messages for the saved-credential failure codes", () => {
    for (const code of ["slack_configuration_refresh_invalid", "slack_configuration_refresh_required", "slack_configuration_refresh_uncertain", "slack_configuration_refresh_busy", "slack_configuration_credential_mismatch", "slack_configuration_credential_forbidden"]) {
      expect(slackRegistrationErrorMessage(code)).not.toBe(slackRegistrationErrorMessage("unknown-code"));
    }
    expect(slackRegistrationErrorMessage("slack_configuration_refresh_invalid")).toContain("refresh token");
    expect(slackRegistrationErrorMessage("slack_configuration_token_invalid")).toContain("use a saved refresh token");
  });
});
