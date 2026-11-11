import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeCliErrorMessage,
  scrubDsnSecrets,
} from "../memory-upgrade.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  LIFECYCLE_CLI_GENERIC_ERROR_MESSAGES,
  LIFECYCLE_SAFE_INVALID_ARGUMENT_EXACT_MESSAGES,
  LIFECYCLE_SAFE_STATE_MISMATCH_MESSAGES,
} from "../memory-upgrade-lifecycle-errors.js";

test("lifecycle safe messages and DSN sanitization", async (t) => {
  await t.test("sanitizeCliErrorMessage preserves new SAFE_STATE_MISMATCH_MESSAGES verbatim", () => {
    for (const msg of LIFECYCLE_SAFE_STATE_MISMATCH_MESSAGES) {
      const upperErr = new CompanyMemoryUpgradeError(msg, "STATE_MISMATCH");
      assert.equal(sanitizeCliErrorMessage(upperErr), `[STATE_MISMATCH] ${msg}`);

      const lowerErr = new CompanyMemoryUpgradeError(msg, "state_mismatch");
      assert.equal(sanitizeCliErrorMessage(lowerErr), `[state_mismatch] ${msg}`);
    }
  });

  await t.test("sanitizeCliErrorMessage preserves new SAFE_INVALID_ARGUMENT_EXACT_MESSAGES verbatim", () => {
    for (const msg of LIFECYCLE_SAFE_INVALID_ARGUMENT_EXACT_MESSAGES) {
      const upperErr = new CompanyMemoryUpgradeError(msg, "INVALID_ARGUMENT");
      assert.equal(sanitizeCliErrorMessage(upperErr), `[INVALID_ARGUMENT] ${msg}`);

      const lowerErr = new CompanyMemoryUpgradeError(msg, "invalid_argument");
      assert.equal(sanitizeCliErrorMessage(lowerErr), `[invalid_argument] ${msg}`);
    }
  });

  await t.test("no lifecycle message contains raw database credentials or unredacted DSNs", () => {
    const allMessages = [
      ...Object.values(LIFECYCLE_CLI_GENERIC_ERROR_MESSAGES),
      ...LIFECYCLE_SAFE_STATE_MISMATCH_MESSAGES,
      ...LIFECYCLE_SAFE_INVALID_ARGUMENT_EXACT_MESSAGES,
    ];

    for (const msg of allMessages) {
      assert.equal(
        scrubDsnSecrets(msg),
        msg,
        `Message must not trigger secret replacement when clean: ${msg}`,
      );
      assert.ok(!msg.includes("postgres://"));
      assert.ok(!msg.includes("postgresql://"));
      assert.ok(!msg.includes("password"));
    }
  });
});
