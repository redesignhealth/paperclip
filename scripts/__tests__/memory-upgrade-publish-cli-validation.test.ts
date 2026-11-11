/**
 * CLI validation, prod gate, and secret sanitization tests for publish (TECH-8191).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ALLOWED_PUBLISH_FLAGS,
  BOOLEAN_PUBLISH_FLAGS,
  runPublishCli,
} from "../memory-upgrade-publish.js";
import { parsePublishArgs } from "../memory-upgrade-publish-args.js";
import {
  sanitizeCliErrorMessage,
  validateNoUnknownFlags,
} from "../memory-upgrade.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("publish CLI validation and flags", async (t) => {
  const localDsn = "postgres://user:pass@127.0.0.1:5432/test_tenant";
  const remoteDsn = "postgres://app_user:secret123@rds.us-east-1.amazonaws.com:5432/app_db";
  const validUuid1 = randomUUID();
  const validUuid2 = randomUUID();

  const capture = () => {
    let buf = "";
    const orig = console.error;
    console.error = (msg: string) => { buf += msg + "\n"; };
    return { get: () => buf, restore: () => { console.error = orig; } };
  };

  await t.test("required flags: database-url, control-plane-url, company/confirm", async () => {
    const c = capture();
    try {
      const e1 = await runPublishCli(["--control-plane-url", localDsn, "--company", validUuid1], { env: {} });
      assert.equal(e1, 1);
      assert.match(c.get(), /Refusing to run publish without explicit tenant --database-url/);

      const e2 = await runPublishCli(["--database-url", localDsn, "--company", validUuid1], { env: {} });
      assert.equal(e2, 1);
      assert.match(c.get(), /Refusing to run publish without explicit control plane --control-plane-url/);

      const e3 = await runPublishCli(["--database-url", localDsn, "--control-plane-url", localDsn], { env: {} });
      assert.equal(e3, 1);
      assert.match(c.get(), /Flag --company <uuid> \(or --confirm <uuid>\) is required/);
    } finally {
      c.restore();
    }
  });

  await t.test("--confirm and --company mismatch and UUID validation without echoing args", async () => {
    const c = capture();
    try {
      const e1 = await runPublishCli([
        "--database-url", localDsn, "--control-plane-url", localDsn,
        "--company", validUuid1, "--confirm", validUuid2,
      ], { env: {} });
      assert.equal(e1, 1);
      assert.match(c.get(), /Flag --confirm <uuid> must strictly match --company <uuid>\./);
      assert.ok(!c.get().includes(validUuid1));
      assert.ok(!c.get().includes(validUuid2));

      const secretUuid = "not-a-valid-uuid-secret-marker";
      const e2 = await runPublishCli([
        "--database-url", localDsn, "--control-plane-url", localDsn, "--company", secretUuid,
      ], { env: {} });
      assert.equal(e2, 1);
      assert.match(c.get(), /Flag --company must be a valid UUID\./);
      assert.ok(!c.get().includes(secretUuid));
    } finally {
      c.restore();
    }
  });

  await t.test("prod gate enforces --prod and MEMORY_UPGRADE_ALLOW_PROD=1 on BOTH DSNs", async () => {
    const c = capture();
    try {
      const eA = await runPublishCli(["--database-url", remoteDsn, "--control-plane-url", localDsn, "--confirm", validUuid1], { env: {} });
      assert.equal(eA, 1);
      assert.match(c.get(), /\[PROD_GUARD_ENFORCED\]/);
      assert.ok(!c.get().includes("secret123"));

      const eB = await runPublishCli(["--database-url", remoteDsn, "--control-plane-url", localDsn, "--confirm", validUuid1, "--prod"], { env: {} });
      assert.equal(eB, 1);
      assert.match(c.get(), /\[PROD_GUARD_ENFORCED\]/);

      const eC = await runPublishCli(["--database-url", localDsn, "--control-plane-url", remoteDsn, "--confirm", validUuid1], { env: {} });
      assert.equal(eC, 1);
      assert.match(c.get(), /\[PROD_GUARD_ENFORCED\]/);
    } finally {
      c.restore();
    }
  });

  await t.test("sanitized error messages never contain the DSN", async () => {
    const c = capture();
    try {
      const secretDsn = "postgres://secret_user:super_secret_pw@127.0.0.1:5432/bad_db";
      await runPublishCli([
        "--database-url", secretDsn, "--control-plane-url", localDsn,
        "--company", validUuid1, "--table", "not a table",
      ], { env: {} });
      assert.ok(!c.get().includes("super_secret_pw"));
      assert.ok(!c.get().includes("secret_user"));
    } finally {
      c.restore();
    }
  });

  await t.test("source-atomic --max-rows refusal is allowlisted verbatim, with no ID/DSN echo for a differing message", () => {
    const fixedMsg =
      "Source exceeds --max-rows and cannot be split; increase --max-rows to at least the source's row count.";
    const errFixed = new CompanyMemoryUpgradeError(fixedMsg, "INVALID_ARGUMENT");
    assert.equal(sanitizeCliErrorMessage(errFixed), `[INVALID_ARGUMENT] ${fixedMsg}`);

    // Any other INVALID_ARGUMENT message (e.g. one that embedded an id/DSN) is
    // never echoed verbatim; the sanitizer falls back to a generic message.
    const secretUuid = randomUUID();
    const errUnsafe = new CompanyMemoryUpgradeError(
      `Source ${secretUuid} exceeds --max-rows.`,
      "INVALID_ARGUMENT",
    );
    const sanitized = sanitizeCliErrorMessage(errUnsafe);
    assert.equal(sanitized, "[INVALID_ARGUMENT] Invalid command argument.");
    assert.ok(!sanitized.includes(secretUuid));
  });

  await t.test("--dry-run flag is strictly accepted as boolean by publish parser and rejected if assigned a value", async () => {
    assert.equal(ALLOWED_PUBLISH_FLAGS.has("--dry-run"), true, "ALLOWED_PUBLISH_FLAGS must contain --dry-run");
    assert.equal(BOOLEAN_PUBLISH_FLAGS.has("--dry-run"), true, "BOOLEAN_PUBLISH_FLAGS must contain --dry-run");

    // validateNoUnknownFlags accepts bare --dry-run
    assert.doesNotThrow(() => {
      validateNoUnknownFlags(["--dry-run"], ALLOWED_PUBLISH_FLAGS, "publish", BOOLEAN_PUBLISH_FLAGS);
    });

    // validateNoUnknownFlags rejects --dry-run=<value>
    assert.throws(
      () => validateNoUnknownFlags(["--dry-run=true"], ALLOWED_PUBLISH_FLAGS, "publish", BOOLEAN_PUBLISH_FLAGS),
      (err: any) => {
        assert.equal(err.code, "INVALID_ARGUMENT");
        assert.ok(err.message.includes("Boolean flag '--dry-run' does not take a value."));
        return true;
      },
    );

    // runPublishCli rejects --dry-run=value
    const c = capture();
    try {
      const exitVal = await runPublishCli([
        "--database-url", localDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid1,
        "--dry-run=1",
      ], { env: {} });
      assert.equal(exitVal, 1);
      assert.match(c.get(), /Boolean flag '--dry-run' does not take a value\./);
    } finally {
      c.restore();
    }

    // parsePublishArgs parses --dry-run into confirm: undefined (dry-run preview mode)
    const parsedWithConfirmAndDryRun = parsePublishArgs([
      "--database-url", localDsn,
      "--control-plane-url", localDsn,
      "--company", validUuid1,
      "--confirm", validUuid1,
      "--dry-run",
    ], {}, process.cwd());
    assert.ok(!("exitCode" in parsedWithConfirmAndDryRun));
    assert.equal(parsedWithConfirmAndDryRun.confirm, undefined, "--dry-run forces confirm to undefined");

    const parsedWithDryRunOnly = parsePublishArgs([
      "--database-url", localDsn,
      "--control-plane-url", localDsn,
      "--company", validUuid1,
      "--dry-run",
    ], {}, process.cwd());
    assert.ok(!("exitCode" in parsedWithDryRunOnly));
    assert.equal(parsedWithDryRunOnly.confirm, undefined, "omitted confirm with --dry-run succeeds in preview mode");
  });
});
