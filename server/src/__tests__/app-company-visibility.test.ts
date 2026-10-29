import { describe, expect, it } from "vitest";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import {
  appCompanyVisibilityDenial,
  appForConnectionConfig,
  connectionCompanyVisibilityDenial,
  isGranolaConfig,
  withCompanyVisibilityAvailability,
} from "../services/app-company-visibility.js";

const granola = getConnectableAppDefinition("granola")!;
const linear = getConnectableAppDefinition("linear")!;

describe("app-company-visibility helpers", () => {
  it("identifies Granola only by its pinned label or exact canonical endpoint", () => {
    expect(isGranolaConfig({ sourceTemplateKey: "granola" })).toBe(true);
    expect(isGranolaConfig({ url: "https://mcp.granola.ai/mcp" })).toBe(true);
    expect(isGranolaConfig({ url: "https://mcp.granola.ai/mcp/" })).toBe(false);
    expect(isGranolaConfig({ url: "https://mcp.granola.ai/mcp-other" })).toBe(false);
    expect(isGranolaConfig({ url: "https://mcp.granola.ai.evil.example/mcp" })).toBe(false);
    expect(isGranolaConfig({ url: "http://mcp.granola.ai/mcp" })).toBe(false);
    expect(isGranolaConfig({ url: "https://mcp.granola.ai:8443/mcp" })).toBe(false);
    expect(isGranolaConfig({ url: "https://user:pass@mcp.granola.ai/mcp" })).toBe(false);
    expect(isGranolaConfig({ url: "https://mcp.linear.app/mcp" })).toBe(false);
    expect(isGranolaConfig({})).toBe(false);
  });

  it("resolves a connection config to its app definition", () => {
    expect(appForConnectionConfig({ sourceTemplateKey: "granola" })?.slug).toBe("granola");
    expect(appForConnectionConfig({ url: "https://mcp.granola.ai/mcp" })?.slug).toBe("granola");
    expect(appForConnectionConfig({ sourceTemplateKey: "linear" })?.slug).toBe("linear");
    expect(appForConnectionConfig({ sourceTemplateKey: "not-a-real-app" })).toBeNull();
    expect(appForConnectionConfig({ url: "https://fixture.example/mcp" })).toBeNull();
  });

  it("fails closed on an unclassified company for an allowlisted app", () => {
    expect(appCompanyVisibilityDenial(granola, "private")).toBeNull();
    expect(appCompanyVisibilityDenial(granola, "shared"))
      .toBe("Granola is only available in private companies.");
    expect(appCompanyVisibilityDenial(granola, null))
      .toBe("Granola is only available in private companies.");
    // An app with no allowlist is never denied.
    expect(appCompanyVisibilityDenial(linear, "shared")).toBeNull();
    expect(appCompanyVisibilityDenial(linear, null)).toBeNull();
    expect(connectionCompanyVisibilityDenial({ sourceTemplateKey: "granola" }, null))
      .toBe("Granola is only available in private companies.");
    expect(connectionCompanyVisibilityDenial({ sourceTemplateKey: "linear" }, null)).toBeNull();
  });

  it("projects unavailability by adding a reason without dropping the row", () => {
    const denied = withCompanyVisibilityAvailability(granola, "shared");
    expect(denied.slug).toBe("granola");
    expect(denied.methods).toEqual(granola.methods);
    expect(denied.availability).toEqual({
      available: false,
      reason: "Granola is only available in private companies.",
    });
    // Allowed and unrestricted apps keep their identity.
    expect(withCompanyVisibilityAvailability(granola, "private")).toBe(granola);
    expect(withCompanyVisibilityAvailability(linear, "shared")).toBe(linear);
    // A statically disabled entry keeps its own reason.
    const staticallyDisabled = { ...granola, availability: { available: false, reason: "Static reason." } };
    expect(withCompanyVisibilityAvailability(staticallyDisabled, "shared"))
      .toBe(staticallyDisabled);
  });
});
