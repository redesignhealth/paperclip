// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ConnectionMethodDef, ToolApplication, ToolConnection } from "@paperclipai/shared";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import {
  defaultGrantKindFor,
  retainedManualOAuthClient,
  recoverManualOAuthClient,
  isConnectionDefinitionUnavailable,
  isVercelConnectUnavailable,
  readConnectionIntentOAuthOutcome,
  retainedResumeMatches,
  retainedReconnectMatches,
  requestedConnectionSetupResolution,
  requestedConnectionEntry,
} from "./ConnectionSetupFlow";

import { genericConnectPayload, newCustomHeaderRow } from "../../pages/apps/generic-mcp-connect";

describe("manual OAuth client recovery", () => {
  const saved = { id: "saved", config: { oauth: {
    clientRegistrationSource: "manual", clientId: "saved-client", clientTokenEndpointAuthMethod: "none",
  } } } as unknown as ToolConnection;

  it.each(["client id edit", "secret edit", "toggle edit", "auth edit", "app switch/reset"])("does not hydrate a late query after %s", () => {
    const recovery = { connectionId: null, edited: false };
    // The edit/reset callbacks invalidate recovery synchronously, before a
    // query response can run its hydration effect on the next render.
    recovery.edited = true;
    expect(recoverManualOAuthClient(saved, recovery)).toBeNull();
    expect(recovery.connectionId).toBeNull();
  });

  it("hydrates untouched state once and never resurrects it after a reset", () => {
    const recovery: { connectionId: string | null; edited: boolean } = { connectionId: null, edited: false };
    expect(recoverManualOAuthClient(saved, recovery)?.oauthClientPublic).toBe(true);
    expect(recoverManualOAuthClient(saved, recovery)).toBeNull();
    recovery.edited = true;
    expect(recoverManualOAuthClient({ ...saved, id: "late-other-query" }, recovery)).toBeNull();
  });
  it.each(["none", "client_secret_post"])("rehydrates %s without exposing a secret", (method) => {
    const client = retainedManualOAuthClient({ config: { oauth: {
      clientRegistrationSource: "manual",
      clientId: "saved-client",
      clientTokenEndpointAuthMethod: method,
    } } } as unknown as ToolConnection);
    expect(client).toEqual({ oauthClientId: "saved-client", oauthClientSecret: "", oauthClientPublic: method === "none" });
    const payload = genericConnectPayload({
      link: "https://mcp.example.test/mcp", name: "Saved", authMode: "oauth",
      needsKey: false, keyValue: "", headers: [newCustomHeaderRow()], ...client!,
    });
    expect(payload.oauthClient).toEqual({ clientId: "saved-client", ...(method === "none" ? { publicClient: true } : {}) });
  });

  it.each(["dcr", "cimd"])("does not turn a %s client into an editable manual client", (source) => {
    expect(retainedManualOAuthClient({ config: { oauth: {
      clientRegistrationSource: source, clientId: "automatic-client", clientTokenEndpointAuthMethod: "none",
    } } } as unknown as ToolConnection)).toBeNull();
  });

  it.each(["config", "transportConfig"] as const)("never seeds generic state from a curated connection (%s source)", (field) => {
    const curated = { id: "curated", [field]: { sourceTemplateKey: "linear" }, config: {
      ...(field === "config" ? { sourceTemplateKey: "linear" } : {}),
      oauth: { clientRegistrationSource: "manual", clientId: "curated-client", clientTokenEndpointAuthMethod: "none" },
    } } as unknown as ToolConnection;
    expect(retainedManualOAuthClient(curated)).toBeNull();
    const recovery = { connectionId: null, edited: false };
    expect(recoverManualOAuthClient(curated, recovery)).toBeNull();
    expect(recovery.connectionId).toBeNull();
  });
});

const origin = "https://paperclip.test";
const interactionId = "interaction-123";

function event(data: unknown, eventOrigin = origin) {
  return { origin: eventOrigin, data };
}

describe("connection intent OAuth window messages", () => {
  it.each(["connected", "declined", "failed"] as const)(
    "accepts a matching %s outcome",
    (outcome) => {
      expect(
        readConnectionIntentOAuthOutcome(
          event({
            type: "paperclip.connection-intent.oauth",
            interactionId,
            outcome,
          }),
          origin,
          interactionId,
        ),
      ).toBe(outcome);
    },
  );

  it.each([
    [
      "foreign origin",
      event(
        {
          type: "paperclip.connection-intent.oauth",
          interactionId,
          outcome: "connected",
        },
        "https://attacker.test",
      ),
    ],
    [
      "wrong interaction",
      event({
        type: "paperclip.connection-intent.oauth",
        interactionId: "other",
        outcome: "connected",
      }),
    ],
    [
      "wrong message type",
      event({ type: "other", interactionId, outcome: "connected" }),
    ],
    [
      "unknown outcome",
      event({
        type: "paperclip.connection-intent.oauth",
        interactionId,
        outcome: "authorized",
      }),
    ],
    ["non-object payload", event("connected")],
  ])("ignores a %s message", (_label, candidate) => {
    expect(
      readConnectionIntentOAuthOutcome(candidate, origin, interactionId),
    ).toBeNull();
  });
});

describe("retained reconnect definition lookup", () => {
  const connection = { applicationId: "app-1" } as ToolConnection;

  it("restores a hidden provider only for its exact retained application", () => {
    const githubApplication = {
      id: "app-1",
      applicationKey: "github",
      metadata: { sourceTemplateKey: "github" },
    } as unknown as ToolApplication;

    expect(requestedConnectionEntry({
      requestedAppKey: "github",
      galleryApps: [],
      reconnectConnection: connection,
      resumeConnection: null,
      resumeApplication: null,
      completedResumeConnectionId: null,
      applications: [githubApplication],
    })?.slug).toBe("github");
    expect(requestedConnectionEntry({
      requestedAppKey: "notion",
      galleryApps: [],
      reconnectConnection: connection,
      resumeConnection: null,
      resumeApplication: null,
      completedResumeConnectionId: null,
      applications: [githubApplication],
    })).toBeNull();
  });

  it("ends unavailable retained reconnects instead of leaving them loading", () => {
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: "connection-1",
      hasRequestedEntry: false,
      supportedMethodCount: 0,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("reconnect_unavailable");
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: "connection-1",
      hasRequestedEntry: true,
      supportedMethodCount: 0,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("reconnect_unavailable");
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: null,
      hasRequestedEntry: false,
      supportedMethodCount: 0,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("fallback");
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: "connection-1",
      hasRequestedEntry: true,
      supportedMethodCount: 1,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("ready");
  });

  it("does not expose a hidden provider without an exact reconnect target", () => {
    expect(requestedConnectionEntry({
      requestedAppKey: "github",
      galleryApps: [],
      reconnectConnection: null,
      resumeConnection: null,
      resumeApplication: null,
      completedResumeConnectionId: null,
      applications: [],
    })).toBeNull();
    const visibleNotion = getConnectableAppDefinition("notion")!;
    expect(requestedConnectionEntry({
      requestedAppKey: "notion",
      galleryApps: [visibleNotion],
      reconnectConnection: null,
      resumeConnection: null,
      resumeApplication: null,
      completedResumeConnectionId: null,
      applications: [],
    })).toBe(visibleNotion);
  });

  it.each([
    ["draft", true],
    ["active", true],
    ["disabled", false],
    ["archived", false],
  ] as const)("allows retained resume status %s only when appropriate", (status, expected) => {
    const resumeConnection = {
      id: "connection-1",
      companyId: "company-1",
      applicationId: "app-clickup",
      status,
      config: { sourceTemplateKey: "clickup" },
    } as unknown as ToolConnection;
    const resumeApplication = {
      id: "app-clickup",
      companyId: "company-1",
      metadata: { sourceTemplateKey: "clickup" },
    } as unknown as ToolApplication;

    expect(retainedResumeMatches({
      requestedAppKey: "clickup",
      resumeConnection,
      resumeApplication,
      completedResumeConnectionId: "connection-1",
    })).toBe(expected);
  });

  it("does not apply fresh-setup availability to an exact retained reconnect", () => {
    expect(isVercelConnectUnavailable({
      credentialSource: "vercel_connect",
      available: false,
      retainedReconnectMatches: true,
    })).toBe(false);
    expect(isVercelConnectUnavailable({
      credentialSource: "vercel_connect",
      available: false,
      retainedReconnectMatches: false,
    })).toBe(true);
    expect(isConnectionDefinitionUnavailable({
      available: false,
      reconnectConnectionId: "connection-1",
      reconnectSourceMatches: true,
    })).toBe(false);
    expect(isConnectionDefinitionUnavailable({
      available: false,
      reconnectConnectionId: "connection-1",
      reconnectSourceMatches: false,
    })).toBe(true);
    expect(isConnectionDefinitionUnavailable({
      available: false,
      reconnectConnectionId: undefined,
      reconnectSourceMatches: true,
    })).toBe(true);
  });
});

describe("retained reconnect target matching", () => {
  const connection = { applicationId: "app-1" } as ToolConnection;
  const application = { id: "app-1", applicationKey: "custom-mcp" } as ToolApplication;

  it("accepts a generic reconnect only for its exact retained application", () => {
    expect(retainedReconnectMatches({
      requestedAppKey: undefined,
      byo: true,
      applicationId: "app-1",
      reconnectConnection: connection,
      reconnectApplication: application,
    })).toBe(true);
    expect(retainedReconnectMatches({
      requestedAppKey: undefined,
      byo: true,
      applicationId: "app-other",
      reconnectConnection: connection,
      reconnectApplication: application,
    })).toBe(false);
  });

  it("keeps curated reconnects bound to their provider", () => {
    const curated = {
      id: "app-1",
      applicationKey: "github",
      metadata: { sourceTemplateKey: "github" },
    } as unknown as ToolApplication;
    expect(retainedReconnectMatches({
      requestedAppKey: "github",
      byo: false,
      applicationId: "app-1",
      reconnectConnection: connection,
      reconnectApplication: curated,
    })).toBe(true);
    expect(retainedReconnectMatches({
      requestedAppKey: "notion",
      byo: false,
      applicationId: "app-1",
      reconnectConnection: connection,
      reconnectApplication: curated,
    })).toBe(false);
  });
});

describe("defaultGrantKindFor", () => {
  it("defaults a personal_only method to a per-user grant regardless of preferPersonal", () => {
    const method = {
      key: "mcp-oauth",
      transport: "mcp_remote",
      auth: "oauth",
      identityModel: "personal_only",
      ownershipModes: ["customer"],
      whenToUse: "",
      guidanceMd: "",
      riskTier: "S3",
    } as unknown as ConnectionMethodDef;
    expect(defaultGrantKindFor(method, false)).toBe("user");
    expect(defaultGrantKindFor(method, true)).toBe("user");
  });

  it("still defaults a company_or_personal method to organization", () => {
    const method = {
      key: "mcp-oauth",
      transport: "mcp_remote",
      auth: "oauth",
      identityModel: "company_or_personal",
      ownershipModes: ["customer"],
      whenToUse: "",
      guidanceMd: "",
      riskTier: "S3",
    } as unknown as ConnectionMethodDef;
    expect(defaultGrantKindFor(method, false)).toBe("organization");
    expect(defaultGrantKindFor(method, true)).toBe("user");
  });

  it("defaults Slack's real mcp-oauth gallery method to a per-user grant", () => {
    const slack = getConnectableAppDefinition("slack")!;
    const mcpOauthMethod = slack.methods.find((method) => method.key === "mcp-oauth")!;
    expect(mcpOauthMethod.identityModel).toBe("personal_only");
    expect(defaultGrantKindFor(mcpOauthMethod, false)).toBe("user");
  });
});
