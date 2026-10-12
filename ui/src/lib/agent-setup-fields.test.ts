import { describe, expect, it } from "vitest";
import { HERMES_PROVIDER_KEYS, hermesRuntimeProvider } from "./agent-setup-fields";

describe("hermesRuntimeProvider", () => {
  it("maps the wizard's OpenAI provider to Hermes' openai-api", () => {
    expect(hermesRuntimeProvider("openai")).toBe("openai-api");
  });

  it.each(["openrouter", "anthropic", "zai", "kimi-coding", "minimax"])(
    "keeps %s as the Hermes provider name",
    (provider) => {
      expect(hermesRuntimeProvider(provider)).toBe(provider);
    },
  );

  it("covers every provider the wizard offers", () => {
    expect(Object.keys(HERMES_PROVIDER_KEYS).sort()).toEqual(
      ["anthropic", "kimi-coding", "minimax", "openai", "openrouter", "zai"],
    );
    for (const provider of Object.keys(HERMES_PROVIDER_KEYS)) {
      expect(hermesRuntimeProvider(provider)).toEqual(expect.any(String));
    }
  });

  it.each(["", "bogus", "openai-api", "OpenAI", "__proto__", "toString", "constructor", "hasOwnProperty"])(
    "does not map the unknown provider %j",
    (provider) => {
      expect(hermesRuntimeProvider(provider)).toBeNull();
    },
  );
});
