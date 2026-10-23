// @vitest-environment node
import { describe, expect, it } from "vitest";
import { HERMES_PROVIDER_KEYS, hermesRuntimeProvider, setupEfforts } from "./agent-setup-fields";

describe("model-specific setup efforts", () => {
  it("offers current Claude efforts without offering them on Haiku", () => {
    expect(setupEfforts("claude_local", "claude-fable-5-1")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("claude_local", "claude-sonnet-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("claude_local", "claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("claude_local", "claude-haiku-4-5")).toEqual([]);
  });

  it("offers xhigh on Grok 4.7 and 4.6, with the lower limit on 4.5", () => {
    expect(setupEfforts("grok_local", "grok-4.7")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(setupEfforts("grok_local", "grok-4.6")).toContain("xhigh");
    expect(setupEfforts("grok_local", "grok-4.5")).toEqual(["low", "medium", "high"]);
  });

  it("caps Luna at max while exposing ultra on Sol", () => {
    expect(setupEfforts("codex_local", "gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(setupEfforts("codex_local", "gpt-6-sol")).toContain("ultra");
  });
});

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
