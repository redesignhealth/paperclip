/**
 * CLI validation and flag parsing for flip (TECH-8191 §Q1, §Q2, PR5.6).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runFlipCli } from "../memory-upgrade-flip.js";
import { parseFlipArgs } from "../memory-upgrade-flip-args.js";

test("flip CLI required flags and argument validation", async (t) => {
  const localDsn = "postgres://user:pass@127.0.0.1:5432/test_tenant";
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
      const e1 = await runFlipCli(["--control-plane-url", localDsn, "--company", validUuid1], { env: {} });
      assert.equal(e1, 1);
      assert.match(c.get(), /Refusing to run flip without explicit tenant --database-url/);

      const e2 = await runFlipCli(["--database-url", localDsn, "--company", validUuid1], { env: {} });
      assert.equal(e2, 1);
      assert.match(c.get(), /Refusing to run flip without explicit control plane --control-plane-url/);

      const e3 = await runFlipCli(["--database-url", localDsn, "--control-plane-url", localDsn], { env: {} });
      assert.equal(e3, 1);
      assert.match(c.get(), /Flag --company <uuid> \(or --confirm <uuid>\) is required/);
    } finally {
      c.restore();
    }
  });

  await t.test("--confirm and --company mismatch and UUID validation without echoing args", async () => {
    const c = capture();
    try {
      const e1 = await runFlipCli([
        "--database-url", localDsn, "--control-plane-url", localDsn,
        "--company", validUuid1, "--confirm", validUuid2,
      ], { env: {} });
      assert.equal(e1, 1);
      assert.match(c.get(), /Flag --confirm <uuid> must strictly match --company <uuid>\./);
      assert.ok(!c.get().includes(validUuid1));
      assert.ok(!c.get().includes(validUuid2));

      const secretUuid = "not-a-valid-uuid-secret-marker";
      const e2 = await runFlipCli([
        "--database-url", localDsn, "--control-plane-url", localDsn, "--company", secretUuid,
      ], { env: {} });
      assert.equal(e2, 1);
      assert.match(c.get(), /Flag --company must be a valid UUID\./);
      assert.ok(!c.get().includes(secretUuid));
    } finally {
      c.restore();
    }
  });

  await t.test("--ack-agent-scope-flag is required for a confirmed run", async () => {
    const c = capture();
    try {
      const e1 = await runFlipCli([
        "--database-url", localDsn, "--control-plane-url", localDsn,
        "--company", validUuid1, "--confirm", validUuid1,
      ], { env: {} });
      assert.equal(e1, 1);
      assert.match(c.get(), /Flag '--ack-agent-scope-flag' is required for flip/);

      const parsedDry = parseFlipArgs([
        "--database-url", localDsn, "--control-plane-url", localDsn,
        "--company", validUuid1,
      ], {}, "/dummy");
      assert.equal("companyId" in parsedDry && parsedDry.confirm, undefined);
    } finally {
      c.restore();
    }
  });

  await t.test("--mode accepts only 'copy'", async () => {
    const c = capture();
    try {
      const e1 = await runFlipCli([
        "--database-url", localDsn, "--control-plane-url", localDsn,
        "--company", validUuid1, "--mode", "invalid_mode",
      ], { env: {} });
      assert.equal(e1, 1);
      assert.match(c.get(), /Invalid --mode\. Only 'copy' is supported\./);

      const parsed = parseFlipArgs([
        "--database-url", localDsn, "--control-plane-url", localDsn,
        "--company", validUuid1, "--mode", "copy",
      ], {}, "/dummy");
      assert.equal("mode" in parsed && parsed.mode, "copy");
    } finally {
      c.restore();
    }
  });
});
