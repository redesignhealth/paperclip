import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createSlackCompletion } from "./completion.js";
import { providerFailure, type SlackRegistrationStore } from "./registration.js";

// Unit coverage for resumeLocked's install-time scope verification. The store
// is faked so no database or Slack call is made: the paths under test fail
// before any of them would be reached.
function harness(row: Record<string, unknown>) {
  const api = vi.fn(async (method: string, _fields: unknown, _bearer?: string, requiredScopes?: readonly string[]) => {
    if (method !== "auth.test") return { bot: { id: "B123", app_id: "A123", user_id: "U123", deleted: false } };
    // Mirrors provider-client: a required scope absent from the grant fails.
    const granted = ["chat:write"];
    if (requiredScopes?.some(scope => !granted.includes(scope))) throw providerFailure("slack_install_scopes_missing");
    return { team_id: "T123", user_id: "U123", bot_id: "B123", grantedScopes: granted };
  });
  const configure = vi.fn(async () => { throw new Error("stop after activation"); });
  const setFailure = vi.fn(async () => undefined);
  const store = {
    db: {} as Db,
    options: { configure, runtimeSigningSecret: async () => "signing-secret" },
    endpoint: async () => ({ endpoint: { publicId: "public-id" } }),
    registration: async () => row,
    assertOrigins: () => undefined,
    api,
    readSecret: async () => "xoxb-token",
    audit: vi.fn(async () => undefined),
    setFailure,
  } as unknown as SlackRegistrationStore;
  const lease = { assertOwned: async () => undefined };
  return { completion: createSlackCompletion(store), api, configure, setFailure, lease };
}

const baseRow = {
  endpointId: "endpoint-1",
  companyId: "company-1",
  status: "credentials_saved",
  workspaceId: "T123",
  botUserId: "U123",
  appId: "A123",
  secretIds: { botToken: "secret-bot", signingSecret: "secret-signing" },
};
const actor = { userId: "user-1" };

describe("Slack install completion scope verification", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["without oauth_config", { display_information: { name: "Agent" } }],
    ["with an empty bot scope list", { oauth_config: { scopes: { bot: [] } } }],
    ["with a non-array bot scope list", { oauth_config: { scopes: { bot: "chat:write" } } }],
  ])("fails closed for a managed install whose manifest is %s", async (_label, manifest) => {
    const { completion, api, configure, setFailure, lease } = harness({ ...baseRow, managerGrantId: "grant-1", manifest });

    await completion.resumeLocked("endpoint-1", actor as never, lease as never);

    // An empty required list must never verify vacuously: the token is not
    // checked, the runtime is never activated, and the row stays
    // credentials_saved with the scopes-missing code instead of configured.
    expect(api).not.toHaveBeenCalledWith("auth.test", expect.anything(), expect.anything(), []);
    expect(configure).not.toHaveBeenCalled();
    expect(setFailure).toHaveBeenCalledWith(expect.objectContaining({ endpointId: "endpoint-1" }), "credentials_saved", "slack_install_scopes_missing", lease);
  });

  it("still verifies a managed install against the scopes its manifest requested", async () => {
    const { completion, api, setFailure, lease } = harness({
      ...baseRow,
      managerGrantId: "grant-1",
      manifest: { oauth_config: { scopes: { bot: ["chat:write", "im:write"] } } },
    });

    await completion.resumeLocked("endpoint-1", actor as never, lease as never);

    expect(api).toHaveBeenCalledWith("auth.test", {}, "xoxb-token", ["chat:write", "im:write"]);
    expect(setFailure).toHaveBeenCalledWith(expect.anything(), "credentials_saved", "slack_install_scopes_missing", lease);
  });

  it("leaves the customer-owned path's verification unchanged", async () => {
    const { completion, api, configure, lease } = harness({ ...baseRow, managerGrantId: null, manifest: null });

    await completion.resumeLocked("endpoint-1", actor as never, lease as never);

    // No manager grant: no required-scope list is passed, so an empty manifest
    // is not treated as a verification failure here.
    expect(api).toHaveBeenCalledWith("auth.test", {}, "xoxb-token", undefined);
    expect(configure).toHaveBeenCalled();
  });
});
