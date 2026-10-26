import { describe, expect, it } from "vitest";
import { agentCreateDefaultsProjectionSchema, createAgentSchema } from "./agent.js";

/** TECH-7959: the create-defaults projection gains platformRouterKeyBound and stays strict. */
describe("agentCreateDefaultsProjectionSchema", () => {
  const base = { provider: "router", model: "auto-jev-routing", source: "router_default", requiresRouterReadiness: true };

  it("defaults an absent platformRouterKeyBound (older client) to false", () => {
    expect(agentCreateDefaultsProjectionSchema.parse(base)).toEqual({ ...base, platformRouterKeyBound: false });
  });

  it("keeps an explicit platformRouterKeyBound", () => {
    expect(agentCreateDefaultsProjectionSchema.parse({ ...base, platformRouterKeyBound: true }).platformRouterKeyBound).toBe(true);
  });

  it("rejects a non-boolean flag and stays strict about unknown fields", () => {
    expect(agentCreateDefaultsProjectionSchema.safeParse({ ...base, platformRouterKeyBound: "yes" }).success).toBe(false);
    expect(agentCreateDefaultsProjectionSchema.safeParse({ ...base, platformRouterKeyBound: true, env: { RAMP_ROUTER_API_KEY: "x" } }).success).toBe(false);
  });

  it("parses through createAgentSchema's expectedCreateDefaults", () => {
    const parsed = createAgentSchema.parse({ name: "A", adapterType: "hermes_local", expectedCreateDefaults: base });
    expect(parsed.expectedCreateDefaults).toEqual({ ...base, platformRouterKeyBound: false });
  });
});
