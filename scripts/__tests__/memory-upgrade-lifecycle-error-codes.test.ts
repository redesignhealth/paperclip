import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeCliErrorMessage } from "../memory-upgrade.js";
import {
  CompanyMemoryUpgradeError,
  mapSweepErrorCode,
  SWEEP_ERROR_CODE_MAP,
  UPGRADE_ERROR_CODES,
  type UpgradeErrorCode,
} from "../../server/src/services/company-memory-upgrade/types.js";
import { LIFECYCLE_CLI_GENERIC_ERROR_MESSAGES } from "../memory-upgrade-lifecycle-errors.js";

const LIFECYCLE_CODE_MAPPINGS: Array<[string, UpgradeErrorCode]> = [
  ["FLIP_PRECONDITION_FAILED", "flip_precondition_failed"],
  ["flip_precondition_failed", "flip_precondition_failed"],
  ["FLIP_MARKER_WRITE_FAILED", "flip_marker_write_failed"],
  ["flip_marker_write_failed", "flip_marker_write_failed"],
  ["FLIP_MARKER_MISSING", "flip_precondition_failed"],
  ["flip_marker_missing", "flip_precondition_failed"],
  ["AGENT_SCOPE_NOT_OBSERVED", "agent_scope_not_observed"],
  ["agent_scope_not_observed", "agent_scope_not_observed"],
  ["DRAIN_NOT_CONFIRMED", "verification_failed"],
  ["drain_not_confirmed", "verification_failed"],
  ["VERIFY_QUARANTINE_PRESENT", "verification_failed"],
  ["verify_quarantine_present", "verification_failed"],
  ["ROLLBACK_MARKER_CLEAR_FAILED", "rollback_failed"],
  ["rollback_marker_clear_failed", "rollback_failed"],
  ["DRAIN_BLOCKED_MISSING_SCOPE", "drain_blocked_missing_scope"],
  ["drain_blocked_missing_scope", "drain_blocked_missing_scope"],
  ["RECOVER_LEASE_PRESENT", "recover_lease_present"],
  ["recover_lease_present", "recover_lease_present"],
  ["RECOVER_NOT_APPLIED", "recover_not_applied"],
  ["recover_not_applied", "recover_not_applied"],
  ["RECOVER_OUTCOME_UNKNOWN", "recover_outcome_unknown"],
  ["recover_outcome_unknown", "recover_outcome_unknown"],
];

test("lifecycle error codes mapping and generic CLI messages", async (t) => {
  await t.test("UPGRADE_ERROR_CODES includes persisted last_error lifecycle codes", () => {
    assert.ok(UPGRADE_ERROR_CODES.includes("flip_precondition_failed"));
    assert.ok(UPGRADE_ERROR_CODES.includes("flip_marker_write_failed"));
    assert.ok(UPGRADE_ERROR_CODES.includes("agent_scope_not_observed"));
    assert.ok(UPGRADE_ERROR_CODES.includes("drain_blocked_missing_scope"));
    assert.ok(UPGRADE_ERROR_CODES.includes("recover_lease_present"));
    assert.ok(UPGRADE_ERROR_CODES.includes("recover_not_applied"));
    assert.ok(UPGRADE_ERROR_CODES.includes("recover_outcome_unknown"));
  });

  await t.test("mapSweepErrorCode maps every lifecycle code in both case forms", () => {
    for (const [code, expected] of LIFECYCLE_CODE_MAPPINGS) {
      assert.equal(
        mapSweepErrorCode(code),
        expected,
        `Expected ${code} to map to ${expected}`,
      );
      assert.equal(
        SWEEP_ERROR_CODE_MAP[code],
        expected,
        `Expected SWEEP_ERROR_CODE_MAP[${code}] === ${expected}`,
      );
    }
  });

  await t.test("sanitizeCliErrorMessage round-trips generic messages in both case forms", () => {
    for (const [code, expectedMsg] of Object.entries(LIFECYCLE_CLI_GENERIC_ERROR_MESSAGES)) {
      const upperErr = new CompanyMemoryUpgradeError("ignored raw message", code);
      assert.equal(sanitizeCliErrorMessage(upperErr), `[${code}] ${expectedMsg}`);

      const lowerCode = code.toLowerCase();
      const lowerErr = new CompanyMemoryUpgradeError("ignored raw message", lowerCode);
      assert.equal(sanitizeCliErrorMessage(lowerErr), `[${lowerCode}] ${expectedMsg}`);
    }
  });
});
