import { describe, expect, it } from "vitest";
import { askFirstCatalogEntryIdsFor, initialEnabledActionsFor } from "./connection-defaults";

const action = (catalogEntryId: string, riskLevel: string) =>
  ({ catalogEntryId, riskLevel }) as never;

describe("askFirstCatalogEntryIdsFor", () => {
  const result = {
    actions: {
      readOnly: [action("read-1", "read")],
      canMakeChanges: [
        action("write-1", "write"),
        action("destroy-1", "destructive"),
        action("odd-1", "medium"),
      ],
    },
    suggestedDefaults: { askFirstRiskLevels: ["write", "destructive", "high", "critical"] },
  };

  it("gates the write and destructive actions the server named", () => {
    expect(askFirstCatalogEntryIdsFor(result, () => true)).toEqual(["write-1", "destroy-1"]);
  });

  it("leaves a risk level the policy did not name alone", () => {
    // `medium` is not in the default set; gating it would be the classifier
    // making policy instead of the policy function.
    expect(askFirstCatalogEntryIdsFor(result, () => true)).not.toContain("odd-1");
  });

  it("never gates an action that is switched off", () => {
    expect(askFirstCatalogEntryIdsFor(result, (id) => id !== "write-1")).toEqual(["destroy-1"]);
  });

  it("gates nothing when the server sends an open policy", () => {
    expect(
      askFirstCatalogEntryIdsFor({ ...result, suggestedDefaults: { askFirstRiskLevels: [] } }, () => true),
    ).toEqual([]);
  });

  it("gates nothing rather than throwing when the field is missing or malformed", () => {
    expect(askFirstCatalogEntryIdsFor({ ...result, suggestedDefaults: {} }, () => true)).toEqual([]);
    expect(
      askFirstCatalogEntryIdsFor({ ...result, suggestedDefaults: undefined as never }, () => true),
    ).toEqual([]);
    expect(
      askFirstCatalogEntryIdsFor({ ...result, suggestedDefaults: { askFirstRiskLevels: "write" } }, () => true),
    ).toEqual([]);
  });
});

describe("initialEnabledActionsFor", () => {
  const actions = {
    readOnly: [action("read-1", "read")],
    canMakeChanges: [action("write-1", "write"), action("destroy-1", "destructive")],
  };

  it("turns every discovered action on when the app leaves nothing Off", () => {
    expect(initialEnabledActionsFor({ actions, suggestedDefaults: { askFirstRiskLevels: [] } })).toEqual({
      "read-1": true, "write-1": true, "destroy-1": true,
    });
  });

  it("leaves the risk levels the app names in offRiskLevels Off", () => {
    expect(initialEnabledActionsFor({ actions, suggestedDefaults: { offRiskLevels: ["write", "destructive"] } })).toEqual({
      "read-1": true, "write-1": false, "destroy-1": false,
    });
  });

  it("ignores a malformed offRiskLevels value", () => {
    expect(initialEnabledActionsFor({ actions, suggestedDefaults: { offRiskLevels: "write" } })).toEqual({
      "read-1": true, "write-1": true, "destroy-1": true,
    });
  });
});
