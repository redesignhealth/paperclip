/**
 * CLI validation and flag parsing tests for verify subcommand (TECH-8191 §Q4, PR5.8).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseVerifyArgs } from "../memory-upgrade-verify-args.js";
import { runVerifyCli } from "../memory-upgrade-verify.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("verify CLI flag parsing, validation, and error boundaries", async (t) => {
  const localDsn = "postgres://user:pass@127.0.0.1:5432/test_tenant";
  const validUuid1 = randomUUID();
  const validUuid2 = randomUUID();

  const parseArgs = (extra: string[]) =>
    parseVerifyArgs(
      ["--database-url", localDsn, "--control-plane-url", localDsn, "--company", validUuid1, ...extra],
      {},
      "/tmp",
    ) as any;

  const capture = () => {
    let buf = "";
    const orig = console.error;
    console.error = (msg: string) => { buf += msg + "\n"; };
    return { get: () => buf, restore: () => { console.error = orig; } };
  };

  await t.test("required flags: database-url, control-plane-url, company/confirm", async () => {
    const c = capture();
    try {
      const e1 = await runVerifyCli(["--control-plane-url", localDsn, "--company", validUuid1], { env: {} });
      assert.equal(e1, 1);
      assert.match(c.get(), /Refusing to run verify without explicit tenant --database-url/);

      const e2 = await runVerifyCli(["--database-url", localDsn, "--company", validUuid1], { env: {} });
      assert.equal(e2, 1);
      assert.match(c.get(), /Refusing to run verify without explicit control plane --control-plane-url/);

      const e3 = await runVerifyCli(["--database-url", localDsn, "--control-plane-url", localDsn], { env: {} });
      assert.equal(e3, 1);
      assert.match(c.get(), /Flag --company <uuid> \(or --confirm <uuid>\) is required/);
    } finally {
      c.restore();
    }
  });

  await t.test("--confirm mismatch throws INVALID_ARGUMENT", async () => {
    assert.throws(
      () => parseArgs(["--confirm", validUuid2]),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "INVALID_ARGUMENT" &&
        err.message.includes("Flag --confirm <uuid> must strictly match --company <uuid>."),
    );
  });

  await t.test("verify rejects flags belonging to other commands", async () => {
    const foreignFlags = [
      "--ack-agent-scope-flag",
      "--mode=copy",
      "--model=gpt-5.4-mini",
      "--max-cost-usd=100",
      "--max-drain-hours=24",
      "--probe-interval-minutes=10",
      "--once",
    ];
    for (const flag of foreignFlags) {
      assert.throws(
        () => parseArgs([flag]),
        (err: any) =>
          err instanceof CompanyMemoryUpgradeError &&
          err.code === "INVALID_ARGUMENT" &&
          err.message.includes("Only verify options are accepted"),
      );
    }
  });

  await t.test("dry run default when --confirm omitted", async () => {
    const parsed = parseArgs([]);
    assert.equal(parsed.isDryRun, true);
    assert.equal(parsed.confirm, undefined);
  });

  await t.test("confirmed run when --confirm provided", async () => {
    const parsed = parseArgs(["--confirm", validUuid1]);
    assert.equal(parsed.isDryRun, false);
    assert.equal(parsed.confirm, validUuid1);
  });

  await t.test("--allow-quarantined flag recognized", async () => {
    const parsed = parseArgs(["--allow-quarantined"]);
    assert.equal(parsed.allowQuarantined, true);
  });
});
