import { describe, expect, it } from "vitest";
import { CONNECTABLE_APP_DEFINITIONS, getConnectableAppDefinition } from "./app-definitions.js";
import { appDefinitionSchema } from "./validators/app-definition.js";

describe("rh-scheduler-mcp AppDefinition (hand-authored, non-Wave-1 connector)", () => {
  it("validates against the shared AppDefinition schema", () => {
    const app = getConnectableAppDefinition("rh-scheduler-mcp");
    expect(app).not.toBeNull();
    expect(() => appDefinitionSchema.parse(app)).not.toThrow();
  });

  it("is discoverable through CONNECTABLE_APP_DEFINITIONS without disturbing Wave 1 entries", () => {
    const slugs = CONNECTABLE_APP_DEFINITIONS.map((app) => app.slug);
    expect(slugs).toContain("rh-scheduler-mcp");
    // Wave 1 connectable slugs must still resolve -- this connector is
    // additive, not a replacement for the generated catalog.
    expect(slugs).toContain("linear");
    expect(slugs).toContain("context7");
  });

  it("is classified MCP-direct, platform-provisioned only (no self-serve customer connect)", () => {
    const app = getConnectableAppDefinition("rh-scheduler-mcp");
    const method = app?.methods[0];
    expect(method?.transport).toBe("mcp_remote");
    expect(method?.ownershipModes).toEqual(["platform_provisioned"]);
    expect(app?.ownershipAvailability?.customer).toBe(false);
  });

  it("declares no write/destructive scopes -- the underlying MCP server is read-only shadow mode", () => {
    const app = getConnectableAppDefinition("rh-scheduler-mcp");
    const method = app?.methods[0];
    expect(method?.defaults?.scopesHint).toEqual([
      "scheduler:check_availability",
      "scheduler:find_mutual_availability",
      "scheduler:propose_times",
      "scheduler:check_conflicts",
    ]);
  });

  it("never attaches the service-principal credential as a direct request header -- it only feeds the connection-token broker", () => {
    const app = getConnectableAppDefinition("rh-scheduler-mcp");
    const method = app?.methods[0];
    // `auth: "none"` + no `keyPlacement` is what stops the gateway's
    // `resolveCredentialHeaders()` from attaching this credential as an
    // `Authorization` header on every request (tools/list discovery
    // included) -- the credential must flow only through
    // `tokenBroker.mcpTool`.
    expect(method?.auth).toBe("none");
    expect(method?.keyPlacement).toBeUndefined();
    expect(method?.warnings?.some((warning) =>
      warning.includes("no `keyPlacement`") && warning.includes("resolveCredentialHeaders"),
    )).toBe(true);
  });

  it("code-enforces mint_token_for_subject exclusion from the agent-facing catalog via catalogExcludedTools", () => {
    // Regression test for Argus round-4 BLOCKING 3: `mint_token_for_subject`
    // must not be directly callable by any agent profile, and that must be
    // enforced in code (`remoteTools()` in `server/src/services/tool-access.ts`
    // filters on this field), not rely solely on skill instruction text.
    const app = getConnectableAppDefinition("rh-scheduler-mcp");
    const method = app?.methods[0];
    expect(method?.catalogExcludedTools).toEqual(["mint_token_for_subject"]);
    expect(method?.warnings?.some((warning) =>
      warning.includes("catalogExcludedTools") && warning.includes("CODE-ENFORCED"),
    )).toBe(true);
  });

  it("is disabled for self-serve connect until real platform provisioning exists", () => {
    const app = getConnectableAppDefinition("rh-scheduler-mcp");
    expect(app?.availability?.available).toBe(false);
    expect(app?.availability?.reason).toMatch(/platform-provisioned/i);
  });
});
