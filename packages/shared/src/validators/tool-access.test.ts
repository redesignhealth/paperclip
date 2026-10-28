import { describe, expect, it } from "vitest";
import {
  connectionTokenRequestSchema,
  connectToolAppSchema,
  customMcpOAuthClientSchema,
  createToolMcpGatewayTokenSchema,
  createToolConnectionSchema,
  startConnectionAuthorizationSchema,
  startToolOAuthSchema,
  toolCredentialSecretRefSchema,
  toolRedactedValueSummarySchema,
  toolTransportConfigSchema,
} from "./tool-access.js";

describe("tool access validators", () => {
  it("accepts only nonempty reviewed Workspace service groups", () => {
    expect(startToolOAuthSchema.parse({ workspaceServices: { gmail: "read", drive: "write" } }).workspaceServices).toEqual({ gmail: "read", drive: "write" });
    for (const workspaceServices of [{}, { chat: "read" }, { people: "read" }, { gmail: "admin" }]) {
      expect(startToolOAuthSchema.safeParse({ workspaceServices }).success).toBe(false);
      expect(connectToolAppSchema.safeParse({ galleryKey: "google-workspace", workspaceServices }).success).toBe(false);
    }
  });
  it("treats a gateway token owner note as optional", () => {
    const parsed = createToolMcpGatewayTokenSchema.parse({
      name: "cursor-client",
      clientLabel: "cursor-client",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });

    expect(parsed.ownerNote).toBe("");
  });

  it("defaults connection token subjects to app", () => {
    expect(connectionTokenRequestSchema.parse({})).toEqual({ subject: { type: "app" } });
  });

  it("accepts user subjects, grant selection, and authorization input", () => {
    const request = connectionTokenRequestSchema.parse({
      subject: { type: "user", userId: "user-123" },
      grantId: "11111111-1111-4111-8111-111111111111",
    });
    expect(request.subject).toEqual({ type: "user", userId: "user-123" });
    expect(startConnectionAuthorizationSchema.parse({ subjectUserId: "user-123", scopes: ["read"] })).toEqual({
      subjectUserId: "user-123",
      scopes: ["read"],
    });
  });

  it("accepts multi-key credential annotations", () => {
    const parsed = toolCredentialSecretRefSchema.parse({
      secretId: "11111111-1111-4111-8111-111111111111",
      configPath: "credentials.apiKey",
      keyScope: "production",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(parsed.keyScope).toBe("production");
  });
  it("rejects raw credential-looking fields in transport config", () => {
    const parsed = toolTransportConfigSchema.safeParse({
      url: "https://example.test/mcp",
      headers: {
        Authorization: "Bearer raw-token",
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("credentialSecretRefs");
    }
  });

  it("keeps app method configuration separate from secrets", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      connectionMethodKey: "mcp-api-key",
      configValues: { projectId: "12345", readOnly: true, features: "insights" },
    }).success).toBe(true);
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      configValues: { projectId: "12345", apiKey: "phx_raw" },
    }).success).toBe(false);
  });

  it("accepts only UUID connection request links during app setup", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      interactionId: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(true);
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      interactionId: "not-an-interaction",
    }).success).toBe(false);
  });

  it("accepts a curated provider-generated URL while still requiring a source", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "zapier",
      connectionMethodKey: "generated-url",
      link: "https://mcp.zapier.com/api/v1/connect?token=secret-token",
    }).success).toBe(true);
    expect(connectToolAppSchema.safeParse({}).success).toBe(false);
  });

  // PAP-17087: the guided generic flow and paste-config both reach the connect
  // endpoint, so unsafe header names/values are rejected once at this boundary.
  it("accepts generic advanced-authentication input for a pasted URL", () => {
    const parsed = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      authMode: "custom_headers",
      credentialValues: {
        "headers.X-Api-Key": "phx_abc123",
        "headers.X-PostHog-Project-Id": "12345",
      },
    });
    expect(parsed.success).toBe(true);

    const manualClient = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      authMode: "oauth",
      oauthClient: { clientId: "client-abc", clientSecret: "shhh" },
    });
    expect(manualClient.success).toBe(true);

    expect(connectToolAppSchema.safeParse({
      galleryKey: "asana",
      oauthClient: { clientId: "customer-client", clientSecret: "customer-secret" },
    }).success).toBe(true);
  });

  // TECH-7973: an explicit public client is how the operator says "this client
  // has no secret". Blank alone keeps meaning "keep the saved secret".
  it("accepts an explicit public manual OAuth client and rejects a contradictory one", () => {
    expect(connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      authMode: "oauth",
      oauthClient: { clientId: "client-abc", publicClient: true },
    }).success).toBe(true);

    const contradictory = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      authMode: "oauth",
      oauthClient: {
        clientId: "client-abc",
        clientSecret: "shhh",
        publicClient: true,
      },
    });
    expect(contradictory.success).toBe(false);
    if (!contradictory.success) {
      expect(contradictory.error.issues.map((issue) => issue.path.join(".")))
        .toContain("oauthClient.clientSecret");
    }
  });

  it.each([undefined, true, false])("normalizes blank custom-MCP secrets before public=%s validation", (publicClient) => {
    for (const clientSecret of ["", " \t\n "]) {
      const parsed = customMcpOAuthClientSchema.parse({ clientId: "client-abc", clientSecret, publicClient });
      expect(parsed.clientSecret).toBeUndefined();
      expect("clientSecret" in parsed).toBe(false);
      expect(parsed.publicClient).toBe(publicClient);
    }
    expect(customMcpOAuthClientSchema.parse({ clientId: "client-abc", clientSecret: " secret bytes " }).clientSecret)
      .toBe(" secret bytes ");
    expect(customMcpOAuthClientSchema.safeParse({ clientId: "client-abc", clientSecret: "real", publicClient: true }).success)
      .toBe(false);
  });

  it.each([null, undefined, "client", "", 7, true, false, [], ["client"], [{ clientId: "x", clientSecret: "" }]].map((value) => ({ value })))(
    "rejects non-object preprocessing input $value without throwing", ({ value }) => {
      expect(() => customMcpOAuthClientSchema.safeParse(value)).not.toThrow();
      expect(customMcpOAuthClientSchema.safeParse(value).success).toBe(false);
      expect(connectToolAppSchema.safeParse(value).success).toBe(false);
      expect(connectToolAppSchema.safeParse({ link: "https://mcp.example.test/mcp", oauthClient: value }).success)
        .toBe(value === undefined);
    },
  );

  it.each(["", " \t\n "])("normalizes a custom-MCP route secret %j to absent before validation", (clientSecret) => {
    expect(connectToolAppSchema.parse({
      link: "https://mcp.example.test/mcp", oauthClient: { clientId: "client", clientSecret, publicClient: false },
    }).oauthClient).toEqual({ clientId: "client", publicClient: false });
  });

  it("keeps the route contract for curated payloads: no blank-secret normalization", () => {
    // The shared request schema is unchanged from master for secrets: an empty
    // string is still rejected and whitespace bytes reach the service as-is.
    // Custom-MCP route and service paths normalize; curated requests do not.
    expect(connectToolAppSchema.safeParse({
      galleryKey: "linear", oauthClient: { clientId: "c", clientSecret: "" },
    }).success).toBe(false);
    expect(connectToolAppSchema.parse({
      galleryKey: "linear", oauthClient: { clientId: "c", clientSecret: "  " },
    }).oauthClient?.clientSecret).toBe("  ");
    // A whitespace-only secret is not a contradictory public claim.
    expect(connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp", authMode: "oauth",
      oauthClient: { clientId: "c", clientSecret: " ", publicClient: true },
    }).success).toBe(true);
  });

  it("rejects header credentials Paperclip refuses to send", () => {    for (const configPath of ["headers.Host", "headers.Cookie", "headers.Transfer-Encoding", "headers.Sec-Fetch-Mode"]) {
      const parsed = connectToolAppSchema.safeParse({
        link: "https://mcp.example.test/mcp",
        credentialValues: { [configPath]: "value" },
      });
      expect(parsed.success, configPath).toBe(false);
    }
  });

  it("rejects header names and values that could split the outbound request", () => {
    const badName = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      credentialValues: { "headers.X-Bad\r\nX-Injected": "value" },
    });
    expect(badName.success).toBe(false);

    const badValue = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      credentialValues: { "headers.X-Api-Key": "abc\r\nX-Injected: 1" },
    });
    expect(badValue.success).toBe(false);
    if (!badValue.success) {
      // The message names the header but must never echo the rejected value.
      const message = badValue.error.issues[0]?.message ?? "";
      expect(message).toContain("X-Api-Key");
      expect(message).not.toContain("X-Injected");
    }
  });

  it("keeps generic auth-mode selection off curated apps while allowing owned OAuth clients", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      authMode: "bearer",
    }).success).toBe(false);
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      oauthClient: { clientId: "client-abc" },
    }).success).toBe(true);
  });

  it("allows only curated app setup to resume an exact draft", () => {
    const resumeConnectionId = "11111111-1111-4111-8111-111111111111";
    expect(connectToolAppSchema.safeParse({
      galleryKey: "notion",
      resumeConnectionId,
    }).success).toBe(true);
    expect(connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      resumeConnectionId,
    }).success).toBe(false);
  });

  it("accepts secret references for connection credentials", () => {
    const parsed = createToolConnectionSchema.safeParse({
      applicationId: "11111111-1111-4111-8111-111111111111",
      name: "GitHub fixture",
      connectionKind: "managed",
      transportConfig: { url: "https://example.test/mcp" },
      credentialSecretRefs: [
        {
          secretId: "22222222-2222-4222-8222-222222222222",
          configPath: "headers.Authorization",
          versionSelector: "latest",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("keeps invocation payload summaries redacted and bounded", () => {
    const parsed = toolRedactedValueSummarySchema.parse({
      summary: "Redacted arguments: 2 fields omitted.",
      sha256: "a".repeat(64),
      redactedFields: ["headers.Authorization", "body.token"],
    });

    expect(parsed.redactedFields).toEqual(["headers.Authorization", "body.token"]);
  });
});
