/**
 * CLI validation and flag parsing tests for drain (TECH-8191 §Q3, PR5.7).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseDrainArgs } from "../memory-upgrade-drain-args.js";
import { runDrainCli } from "../memory-upgrade-drain.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("drain CLI flag parsing, validation, and error boundaries", async (t) => {
  const localDsn = "postgres://user:pass@127.0.0.1:5432/test_tenant";
  const validUuid1 = randomUUID();
  const validUuid2 = randomUUID();

  const parseArgs = (extra: string[]) =>
    parseDrainArgs(
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
      const e1 = await runDrainCli(["--control-plane-url", localDsn, "--company", validUuid1], { env: {} });
      assert.equal(e1, 1);
      assert.match(c.get(), /Refusing to run drain without explicit tenant --database-url/);

      const e2 = await runDrainCli(["--database-url", localDsn, "--company", validUuid1], { env: {} });
      assert.equal(e2, 1);
      assert.match(c.get(), /Refusing to run drain without explicit control plane --control-plane-url/);

      const e3 = await runDrainCli(["--database-url", localDsn, "--control-plane-url", localDsn], { env: {} });
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

  await t.test("other commands' flags are rejected (e.g. --ack-agent-scope-flag, --model, --max-cost-usd)", async () => {
    for (const forbidden of ["--ack-agent-scope-flag", "--model=gpt-5.4-mini", "--max-cost-usd=100"]) {
      assert.throws(
        () => parseArgs([forbidden]),
        (err: any) =>
          err instanceof CompanyMemoryUpgradeError &&
          err.code === "INVALID_ARGUMENT" &&
          err.message.includes("Only drain options are accepted"),
      );
    }
  });

  await t.test("--probe-interval-minutes floor of 10 enforced", async () => {
    assert.throws(
      () => parseArgs(["--probe-interval-minutes", "9"]),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.code === "INVALID_ARGUMENT" &&
        err.message.includes("Flag '--probe-interval-minutes' requires an integer value >= 10."),
    );

    const valid = parseArgs(["--probe-interval-minutes", "15"]);
    assert.equal(valid.probeIntervalMinutes, 15);
  });

  await t.test("--max-drain-hours bounded 0 < h <= 168", async () => {
    for (const bad of ["0", "-1", "169"]) {
      assert.throws(
        () => parseArgs(["--max-drain-hours", bad]),
        (err: any) =>
          err instanceof CompanyMemoryUpgradeError &&
          err.code === "INVALID_ARGUMENT" &&
          err.message.includes("Flag '--max-drain-hours' requires a number between 0 and 168."),
      );
    }

    const valid = parseArgs(["--max-drain-hours", "48.5"]);
    assert.equal(valid.maxDrainHours, 48.5);
  });

  await t.test("dry run preview: no --confirm or explicit --dry-run sets isDryRun: true", async () => {
    const dry1 = parseArgs([]);
    assert.equal(dry1.isDryRun, true);
    assert.equal(dry1.confirm, undefined);

    const dry2 = parseArgs(["--confirm", validUuid1, "--dry-run"]);
    assert.equal(dry2.isDryRun, true);
    assert.equal(dry2.confirm, undefined);

    const confirmed = parseArgs(["--confirm", validUuid1, "--once"]);
    assert.equal(confirmed.isDryRun, false);
    assert.equal(confirmed.confirm, validUuid1);
    assert.equal(confirmed.once, true);
  });
});
