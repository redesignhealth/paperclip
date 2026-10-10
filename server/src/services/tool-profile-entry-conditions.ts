import { toolPolicyConditionsSchema, type ToolPolicyConditions } from "@paperclipai/shared";

/**
 * Parses a tool profile entry's stored `conditions` JSON. Leaf helper shared by the policy decision
 * path and the profile/owner-cap summaries so malformed conditions fail closed identically in both.
 *
 * - `null` / `undefined`: valid and unconditional.
 * - Schema failure, including malformed values and an empty object: invalid (callers must fail closed).
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
  const cond = parsed.data as ToolPolicyConditions;
  const isUnconditional = Object.keys(cond).length === 0;
  return { valid: true, unconditional: isUnconditional, conditions: cond };
}
