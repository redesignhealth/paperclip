import { describe, expect, it } from "vitest";
import { getConnectableAppDefinition } from "./app-definitions.js";
import { isConnectorFeatureEnabled } from "./connector-availability.js";
import { appDefinitionSchema } from "./validators/app-definition.js";

describe("connector availability", () => {
  const ordinary = getConnectableAppDefinition("notion")!;
  const gated = { ...ordinary, slug: "private-research", name: "Private Research", experimentalFeatureKey: "enableCases" as const };

  it("honors feature metadata for an arbitrary connector and leaves ungated connectors alone", () => {
    for (const settings of [undefined, null, {}, { enableCases: false }]) {
      expect(isConnectorFeatureEnabled(gated, settings)).toBe(false);
      expect(isConnectorFeatureEnabled(ordinary, settings)).toBe(true);
    }
    expect(isConnectorFeatureEnabled(gated, { enablePaperclipNotebook: true })).toBe(false);
    expect(isConnectorFeatureEnabled(gated, { enableCases: true })).toBe(true);
  });

  it("validates the feature key schema", () => {
    expect(appDefinitionSchema.parse(gated).experimentalFeatureKey).toBe("enableCases");
    expect(appDefinitionSchema.safeParse({ ...gated, experimentalFeatureKey: "typoFeature" }).success).toBe(false);
    const synthetic = { ...ordinary, slug: "synthetic-gated", name: "Synthetic Gated", experimentalFeatureKey: "enablePaperclipNotebook" as const };
    expect(isConnectorFeatureEnabled(synthetic, {})).toBe(false);
    expect(isConnectorFeatureEnabled(synthetic, { enablePaperclipNotebook: true })).toBe(true);
  });
});
