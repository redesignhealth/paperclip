import { describe, expect, it } from "vitest";
import { checkModel } from "./test.js";
import { normalizeConfiguredModel, resolveModelArg } from "./model-arg.js";

const detected = (model: string) =>
  ({ model, provider: "", baseUrl: "", hasApiKey: false, apiMode: "", source: "config" }) as const;

describe("normalizeConfiguredModel", () => {
  it("treats the legacy auto sentinel and blanks as unset", () => {
    expect(normalizeConfiguredModel("auto")).toBeUndefined();
    expect(normalizeConfiguredModel(" AUTO ")).toBeUndefined();
    expect(normalizeConfiguredModel("   ")).toBeUndefined();
    expect(normalizeConfiguredModel(undefined)).toBeUndefined();
  });

  it("keeps real model names", () => {
    expect(normalizeConfiguredModel(" anthropic/claude-sonnet-4 ")).toBe("anthropic/claude-sonnet-4");
  });
});

describe("resolveModelArg", () => {
  it("passes an explicit model", () => {
    expect(
      resolveModelArg({ configuredModel: "gpt-5.4", explicitProvider: "copilot", hermesDefaultModel: "other" }),
    ).toEqual({ ok: true, arg: "gpt-5.4", effectiveModel: "gpt-5.4" });
  });

  it("never passes -m auto, even when the stored config still says auto", () => {
    const result = resolveModelArg({
      configuredModel: "auto",
      explicitProvider: undefined,
      hermesDefaultModel: "gpt-5.4",
    });
    expect(result).toEqual({ ok: true, arg: undefined, effectiveModel: "gpt-5.4" });
  });

  it("omits -m when Hermes has a configured default", () => {
    expect(
      resolveModelArg({ configuredModel: undefined, explicitProvider: "anthropic", hermesDefaultModel: "claude-x" }),
    ).toEqual({ ok: true, arg: undefined, effectiveModel: "claude-x" });
  });

  it("fails before spawn for an explicit provider with no model and no Hermes default", () => {
    const result = resolveModelArg({
      configuredModel: "auto",
      explicitProvider: "anthropic",
      hermesDefaultModel: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('provider "anthropic"');
  });

  it("omits -m with no provider, model or default so Hermes decides", () => {
    expect(
      resolveModelArg({ configuredModel: undefined, explicitProvider: undefined, hermesDefaultModel: undefined }),
    ).toEqual({ ok: true, arg: undefined, effectiveModel: undefined });
  });
});

describe("checkModel (environment test)", () => {
  it("errors for explicit provider with no usable model", () => {
    const check = checkModel({ provider: "anthropic", model: "auto" }, null);
    expect(check?.level).toBe("error");
    expect(check?.code).toBe("hermes_model_required");
  });

  it("reports the Hermes default when no model is set", () => {
    const check = checkModel({}, detected("gpt-5.4"));
    expect(check?.code).toBe("hermes_configured_default_model");
    expect(check?.message).toContain("gpt-5.4");
  });

  it("warns when nothing selects a model", () => {
    expect(checkModel({}, null)?.code).toBe("hermes_no_default_model");
  });

  it("reports an explicit model", () => {
    expect(checkModel({ model: "gpt-5.4" }, null)?.code).toBe("hermes_model_configured");
  });
});
