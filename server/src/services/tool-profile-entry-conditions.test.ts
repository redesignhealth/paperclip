import { describe, expect, it } from "vitest";
import { toolPolicyConditionsSchema } from "@paperclipai/shared";
import { parseToolProfileEntryConditions } from "./tool-profile-entry-conditions.js";

describe("parseToolProfileEntryConditions (leaf parser shared by the policy decision path and owner-cap summaries)", () => {
  it("treats null / undefined stored conditions as valid and unconditional, with no conditions object", () => {
    expect(parseToolProfileEntryConditions(null)).toEqual({ valid: true, unconditional: true, conditions: null });
    expect(parseToolProfileEntryConditions(undefined)).toEqual({ valid: true, unconditional: true, conditions: null });
  });

  it("fails closed on an empty object: the actual shared schema requires at least one condition group", () => {
    // Grounding in the real schema contract (not an assumption): toolPolicyConditionsSchema rejects {}
    // via its at-least-one-supported-condition-group refine, so the leaf must fail closed on it —
    // identically to any other schema-invalid stored value, never treating it as unconditional.
    expect(toolPolicyConditionsSchema.safeParse({}).success).toBe(false);
    expect(parseToolProfileEntryConditions({})).toEqual({ valid: false, unconditional: false, conditions: null });
  });

  it.each([
    ["a number", 42],
    ["a string", "unconditional"],
    ["a boolean", true],
    ["an empty array", []],
    ["an array of condition objects", [{ risk: { isWrite: true } }]],
    ["a declared field with a wrong-typed value (risk.isWrite)", { risk: { isWrite: "yes" } }],
    ["a declared field with an out-of-enum value (actor.actorType)", { actor: { actorType: "bogus" } }],
    ["a declared field with a wrong-typed value (context.requireIssue)", { context: { requireIssue: "yes" } }],
  ])("fails closed on %s", (_label, conditions) => {
    expect(parseToolProfileEntryConditions(conditions)).toEqual({ valid: false, unconditional: false, conditions: null });
  });

  it.each([
    // Real stored-policy condition shapes from the tool-access-policy suite (arguments + risk groups).
    ["arguments + risk groups", {
      arguments: { fieldEquals: { to: "ops@example.com" }, fieldMatches: { body: "^[\\s\\S]{1,200}$" } },
      risk: { isWrite: true },
    }],
    ["a single arguments group", { arguments: { fieldNotEquals: { to: "ops@example.com" } } }],
  ])("parses a valid conditional %s to the same conditions, conditional rather than unconditional", (_label, conditions) => {
    expect(parseToolProfileEntryConditions(conditions)).toEqual({ valid: true, unconditional: false, conditions });
  });
});
