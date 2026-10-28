import { describe, expect, it, vi } from "vitest";
import { createSlackSetupClient } from "./provider-client.js";

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
