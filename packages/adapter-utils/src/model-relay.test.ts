import { describe, expect, it } from "vitest";
import {
  lookupModelRelay,
  MODEL_RELAY_ROUTE_POLICIES,
  modelRelayBaseUrl,
  registerModelRelay,
} from "./model-relay.js";
import { DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST } from "./sandbox-callback-bridge.js";

const entry = { upstreamBaseUrl: "https://api.router.example/v1", apiKey: "k".repeat(24) };

describe("model relay (TECH-10174)", () => {
  it("holds a run's entries only until the run disposes them", () => {
    const dispose = registerModelRelay("run-a", { "ramp-router": entry });
    expect(lookupModelRelay("run-a", "ramp-router")).toEqual(entry);
    expect(lookupModelRelay("run-b", "ramp-router")).toBeNull();
    expect(lookupModelRelay("run-a", "other")).toBeNull();
    dispose();
    expect(lookupModelRelay("run-a", "ramp-router")).toBeNull();
  });

  it("a stale disposer does not remove a newer registration for the same run", () => {
    const first = registerModelRelay("run-c", { "ramp-router": entry });
    const second = registerModelRelay("run-c", { "ramp-router": { ...entry, apiKey: "z".repeat(24) } });
    first();
    expect(lookupModelRelay("run-c", "ramp-router")?.apiKey).toBe("z".repeat(24));
    second();
  });

  it("rejects provider names that are not path-safe", () => {
    expect(() => registerModelRelay("run-d", { "../x": entry })).toThrow();
  });

  it("rejects an empty or header-unsafe credential", () => {
    expect(() => registerModelRelay("run-e", { "ramp-router": { ...entry, apiKey: "" } })).toThrow();
    expect(() => registerModelRelay("run-e", { "ramp-router": { ...entry, apiKey: "a\nb" } })).toThrow();
  });

  it("builds the in-pod base URL", () => {
    expect(modelRelayBaseUrl("http://127.0.0.1:4310/", "ramp-router")).toBe("http://127.0.0.1:4310/api/model-relay/ramp-router");
  });

  it("allows only POST to the inference paths on the bridge, with a long deadline lane", () => {
    const rules = DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST.filter((rule) => rule.path.test("/api/model-relay/ramp-router/chat/completions"));
    expect(rules.map((rule) => rule.method)).toEqual(["POST"]);
    for (const bad of ["/api/model-relay/ramp-router/models", "/api/model-relay/ramp-router/chat/completions/x", "/api/model-relay/Ramp/chat/completions", "/api/model-relay/a/../messages"]) {
      expect(DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST.some((rule) => rule.path.test(bad))).toBe(false);
    }
    expect(MODEL_RELAY_ROUTE_POLICIES[0]!.path.test("/api/model-relay/ramp-router/responses")).toBe(true);
    expect(MODEL_RELAY_ROUTE_POLICIES[0]!.deadlineMs).toBeGreaterThan(300_000);
  });
});
