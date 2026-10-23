import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as claudeModels } from "@paperclipai/adapter-claude-local";
import { models as codexModels } from "@paperclipai/adapter-codex-local";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  HERMES_ANTHROPIC_API_MODELS,
  HERMES_OPENAI_API_MODELS,
  listHermesProviderModels,
  parseHermesProviderQuery,
} from "../adapters/hermes-provider-models.js";

/**
 * Unit coverage for the Hermes Local provider model catalog helper
 * (TECH-7395). The HTTP route surface (auth ordering, company guards,
 * refresh flag, and the empty-manual-entry contract over the wire) is covered
 * by adapter-model-refresh-routes.test.ts; this file pins the helper's own
 * parsing boundaries, catalog selection, and copy semantics directly.
 *
 * The OpenRouter discovery service is mocked so no test here performs network
 * I/O; the 'opencode/' vs 'openrouter/' ID prefix question under team review
 * is deliberately not exercised (mock IDs are opaque markers).
 */

const mockListOpenRouterModels = vi.hoisted(() => vi.fn());

vi.mock("../services/openrouter-models.js", () => ({
  listOpenRouterModels: mockListOpenRouterModels,
}));

function expectRejectsWithBadRequest(raw: unknown) {
  let caught: unknown;
  try {
    parseHermesProviderQuery(raw);
  } catch (err) {
    caught = err;
  }
  expect(caught, `provider ${JSON.stringify(raw)} should be rejected`).toBeInstanceOf(Error);
  expect((caught as { status?: unknown }).status).toBe(400);
  return caught as Error;
}

describe("parseHermesProviderQuery", () => {
  it.each([
    ["an absent provider", undefined],
    ["an empty provider", ""],
    ["a space-only provider", "   "],
    ["a tab-only provider", "\t"],
  ])("treats %s as no provider chosen", (_name, raw) => {
    expect(parseHermesProviderQuery(raw)).toBeNull();
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(parseHermesProviderQuery("Anthropic")).toBe("anthropic");
    expect(parseHermesProviderQuery("  OPENAI  ")).toBe("openai");
    expect(parseHermesProviderQuery("\tOpenRouter\n")).toBe("openrouter");
  });

  it("accepts the full provider slug charset up to the 64-character bound", () => {
    expect(parseHermesProviderQuery("z.ai")).toBe("z.ai");
    expect(parseHermesProviderQuery("kimi-coding")).toBe("kimi-coding");
    expect(parseHermesProviderQuery("openai_api")).toBe("openai_api");
    expect(parseHermesProviderQuery("A1-b.C_d")).toBe("a1-b.c_d");
    const slug64 = "a".repeat(64);
    expect(parseHermesProviderQuery(slug64)).toBe(slug64);
    // Normalization happens before the length check, so an uppercase
    // 64-character input stays inside the bound.
    expect(parseHermesProviderQuery("A".repeat(64))).toBe(slug64);
  });

  it.each([
    ["a 65-character provider", "a".repeat(65)],
    ["a provider with a leading dash", "-openai"],
    ["a provider with a leading dot", ".zai"],
    ["a provider with a leading underscore", "_internal"],
    ["a provider with an interior space", "open ai"],
    ["a provider with a slash", "provider/zai"],
    ["a provider with a URL", "https://example.com"],
    ["a provider with other punctuation", "openai!"],
    ["a path traversal", "../etc"],
  ])("rejects %s with a 400", (_name, raw) => {
    expectRejectsWithBadRequest(raw);
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["a boolean", true],
    ["a structured object", { provider: "anthropic" }],
    ["a repeated query array", ["anthropic", "openai"]],
  ])("rejects %s because provider must be a single string", (_name, raw) => {
    const err = expectRejectsWithBadRequest(raw);
    expect(err.message).toBe("provider must be a single string");
  });
});

describe("listHermesProviderModels", () => {
  beforeEach(() => {
    mockListOpenRouterModels.mockReset();
    mockListOpenRouterModels.mockResolvedValue([{ id: "openrouter/mock/model", label: "Mock model" }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty manual-entry catalog for no provider and for providers without a catalog", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(await listHermesProviderModels(null, false)).toEqual([]);
      for (const provider of ["zai", "groq", "ollama", "kimi-coding", "minimax", "unknown-provider"]) {
        expect(await listHermesProviderModels(provider, false)).toEqual([]);
      }
      expect(mockListOpenRouterModels).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("serves the existing static Claude catalog for anthropic without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const models = await listHermesProviderModels("anthropic", false);
      expect(models).toEqual(claudeModels);
      expect(models.length).toBeGreaterThan(0);
      expect(mockListOpenRouterModels).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns a fresh copy of the anthropic catalog on every call", async () => {
    const first = await listHermesProviderModels("anthropic", false);
    const second = await listHermesProviderModels("anthropic", false);
    expect(first).not.toBe(second);
    expect(first).not.toBe(HERMES_ANTHROPIC_API_MODELS);
    // A caller mutating its response must not corrupt the module catalog.
    first.push({ id: "mutated/model", label: "mutated" } satisfies AdapterModel);
    expect(await listHermesProviderModels("anthropic", false)).toEqual(claudeModels);
  });

  it("serves only API model IDs drawn from the existing Codex catalog for openai", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const models = await listHermesProviderModels("openai", false);
      expect(models.length).toBeGreaterThan(0);
      const catalogIds = new Set(codexModels.map((model) => model.id));
      for (const model of models) {
        expect(catalogIds.has(model.id), `${model.id} must exist in the Codex catalog`).toBe(true);
      }
      // The Codex catalog's CLI alias is not an OpenAI API model ID.
      expect(models.map((model) => model.id)).not.toContain("codex-mini-latest");
      expect(models).toEqual([...HERMES_OPENAI_API_MODELS]);
      expect(mockListOpenRouterModels).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns a fresh copy of the openai catalog on every call", async () => {
    const first = await listHermesProviderModels("openai", false);
    const before = first.length;
    first.push({ id: "gpt-not-a-real-id", label: "gpt-not-a-real-id" } satisfies AdapterModel);
    expect((await listHermesProviderModels("openai", false)).length).toBe(before);
  });

  it("delegates openrouter to the existing public discovery with the exact refresh flag and hands back native IDs as copies", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      // The shared discovery prefixes every ID with `openrouter/`; the helper strips
      // exactly one prefix (so OpenRouter's own openrouter/* models survive as
      // openrouter/*) and copies entries instead of exposing the shared catalog.
      const shared = [
        { id: "openrouter/anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { id: "openrouter/openrouter/free", label: "Free" },
        { id: "already/native", label: "Native" },
      ];
      const snapshot = shared.map((model) => ({ ...model }));
      mockListOpenRouterModels.mockResolvedValueOnce(shared);
      const models = await listHermesProviderModels("openrouter", false);
      expect(mockListOpenRouterModels).toHaveBeenCalledTimes(1);
      expect(mockListOpenRouterModels).toHaveBeenCalledWith(false);
      expect(models).toEqual([
        { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { id: "openrouter/free", label: "Free" },
        { id: "already/native", label: "Native" },
      ]);
      // Exactly one prefix: OpenRouter's own openrouter/* model keeps its own
      // leading prefix and must never collapse to the bare tail.
      expect(models.map((model) => model.id)).not.toContain("free");
      for (let index = 0; index < models.length; index += 1) {
        expect(models[index], "entries must be copies of the shared catalog").not.toBe(shared[index]);
      }
      expect(shared).toEqual(snapshot);

      mockListOpenRouterModels.mockResolvedValueOnce([{ id: "openrouter/fresh/model", label: "Fresh" }]);
      const refreshed = await listHermesProviderModels("openrouter", true);
      expect(mockListOpenRouterModels).toHaveBeenCalledTimes(2);
      expect(mockListOpenRouterModels).toHaveBeenLastCalledWith(true);
      expect(refreshed).toEqual([{ id: "fresh/model", label: "Fresh" }]);

      // An empty discovery result is handed back as an empty manual-entry catalog.
      mockListOpenRouterModels.mockResolvedValueOnce([]);
      expect(await listHermesProviderModels("openrouter", false)).toEqual([]);
      expect(mockListOpenRouterModels).toHaveBeenLastCalledWith(false);
      // The helper itself adds no network access beyond the (mocked) service.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("composes with the route's parse helper, so provider matching is case-insensitive end to end", async () => {
    expect(await listHermesProviderModels(parseHermesProviderQuery("  OPENAI "), false)).toEqual([
      ...HERMES_OPENAI_API_MODELS,
    ]);
    expect(await listHermesProviderModels(parseHermesProviderQuery("Anthropic"), false)).toEqual(claudeModels);
    expect(await listHermesProviderModels(parseHermesProviderQuery("Zai"), false)).toEqual([]);
    expect(await listHermesProviderModels(parseHermesProviderQuery(undefined), false)).toEqual([]);
  });
});
