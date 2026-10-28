import { describe, expect, it, vi } from "vitest";
import { createSlackSetupClient } from "./provider-client.js";
import { buildSlackAppManifest, slackManifestBotScopes } from "@paperclipai/shared";

describe("Slack configuration rotation provider errors", () => {
  it.each(["invalid_auth", "token_expired", "token_revoked", "not_authed", "not_allowed_token_type"])("maps a definitive %s rejection", async (error) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, error }));
    await expect(createSlackSetupClient(fetchImpl)("tooling.tokens.rotate", { refresh_token: "test-refresh" }))
      .rejects.toMatchObject({ details: { code: "slack_configuration_token_invalid" } });
  });

  it.each([500, 502, 503])("keeps HTTP %s uncertain even with an auth error body", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, error: "invalid_auth" }, { status }));
    await expect(createSlackSetupClient(fetchImpl)("tooling.tokens.rotate", { refresh_token: "test-refresh" }))
      .rejects.toMatchObject({ details: { code: "slack_provider_failure" } });
  });
});

describe("Slack install scope verification", () => {
  const manifest = buildSlackAppManifest({
    app: { appName: "Maya", botName: "maya", command: "/maya" },
    agentName: "Maya",
    webhookUrl: "https://paperclip.example/hook",
  });
  const requested = slackManifestBotScopes(manifest);

  it("passes a correctly trimmed install that grants exactly the requested scopes", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: true }, { headers: { "x-oauth-scopes": requested.join(",") } }),
    );
    await expect(createSlackSetupClient(fetchImpl)("auth.test", {}, "xoxb-test", requested)).resolves.toMatchObject({ ok: true });
  });

  it("fails when an install is missing a requested scope", async () => {
    const granted = requested.filter((scope) => scope !== "chat:write");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: true }, { headers: { "x-oauth-scopes": granted.join(",") } }),
    );
    await expect(createSlackSetupClient(fetchImpl)("auth.test", {}, "xoxb-test", requested))
      .rejects.toMatchObject({ details: { code: "slack_install_scopes_missing" } });
  });

  it("does not require a scope the endpoint never requested", async () => {
    // `files:write` is opt-in; a default install must pass without it.
    expect(requested).not.toContain("files:write");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: true }, { headers: { "x-oauth-scopes": requested.join(",") } }),
    );
    await expect(createSlackSetupClient(fetchImpl)("auth.test", {}, "xoxb-test", requested)).resolves.toBeTruthy();
  });

  it("includes an enabled group's scopes in the requested set", () => {
    const withUpload = slackManifestBotScopes(buildSlackAppManifest({
      app: { appName: "Maya", botName: "maya", command: "/maya" },
      agentName: "Maya",
      webhookUrl: "https://paperclip.example/hook",
      optInScopeGroups: ["file_upload"],
    }));
    expect(withUpload).toContain("files:write");
    expect(withUpload.sort()).toEqual([...requested, "files:write"].sort());
  });
});
