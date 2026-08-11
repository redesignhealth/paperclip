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
      "check_availability",
      "find_mutual_availability",
      "propose_times",
      "check_conflicts",
    ]);
    // The interim shared-bearer-token limitation must stay documented, not
    // silently dropped, until a real per-agent-identity token mint exists.
    expect(method?.warnings?.length ?? 0).toBeGreaterThan(0);
  });
});
