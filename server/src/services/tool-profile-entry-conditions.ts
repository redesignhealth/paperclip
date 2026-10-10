import { toolPolicyConditionsSchema, type ToolPolicyConditions } from "@paperclipai/shared";

/**
 * Parses a tool profile entry's stored `conditions` JSON. Leaf helper shared by the policy decision
 * path and the profile/owner-cap summaries so malformed conditions fail closed identically in both.
 *
 * - `null` / `undefined`: valid and unconditional.
 * - Schema failure, including malformed values and an empty object: invalid (callers must fail closed).
 * - Any schema-valid object is conditional because `toolPolicyConditionsSchema` rejects `{}`.
 */
export function parseToolProfileEntryConditions(conditions: unknown): {
  valid: boolean;
  unconditional: boolean;
  conditions: ToolPolicyConditions | null;
} {
  if (conditions === null || conditions === undefined) {
    return { valid: true, unconditional: true, conditions: null };
  }
  const parsed = toolPolicyConditionsSchema.safeParse(conditions);
  if (!parsed.success) {
    return { valid: false, unconditional: false, conditions: null };
  }
  return { valid: true, unconditional: false, conditions: parsed.data };
}
