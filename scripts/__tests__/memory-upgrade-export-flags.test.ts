import assert from "node:assert/strict";
import test from "node:test";
import { runExportCli } from "../memory-upgrade-export.js";
import { parseExportArgs } from "../memory-upgrade-export-args.js";
import { ALLOWED_EXPORT_FLAGS, BOOLEAN_EXPORT_FLAGS } from "../memory-upgrade-export-flags.js";
import { sanitizeCliErrorMessage, validateNoUnknownFlags } from "../memory-upgrade.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("export CLI flags and argument isolation (TECH-8573)", async (t) => {
  await t.test("rejects foreign flags before opening any database connection", async () => {
    let conn = false;
    let stderr = "";
    const orig = console.error;
    console.error = (m: string) => { stderr += `${m}\n`; };
    try {
      const exit = await runExportCli([
        "--database-url", "postgres://u:p@localhost:5432/tenant",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--company", "00000000-0000-4000-8000-000000000001",
        "--agent", "00000000-0000-4000-8000-000000000002",
        "--max-rows", "100",
      ], {
        tenantSql: (() => { conn = true; throw new Error("must not connect"); }) as any,
        cpDb: { transaction: () => { conn = true; throw new Error("must not connect"); } } as any,
      });
      assert.equal(exit, 1);
      assert.ok(stderr.includes("Unknown option '--max-rows'"));
      assert.equal(conn, false);
    } finally {
      console.error = orig;
    }
  });

  await t.test("foreign flag validation throws INVALID_ARGUMENT", () => {
    assert.throws(
      () => validateNoUnknownFlags(["--mode", "copy"], ALLOWED_EXPORT_FLAGS, "export", BOOLEAN_EXPORT_FLAGS),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  });

  await t.test("canonicalises uppercase and padded UUIDs", () => {
    const rawUpper = "  00000000-0000-4000-8000-00000000000A  ";
    const rawLower = "00000000-0000-4000-8000-00000000000a";
    const parsed = parseExportArgs([
      "--database-url", "postgres://u:p@localhost:5432/tenant",
      "--control-plane-url", "postgres://u:p@localhost:5432/cp",
      "--company", rawUpper,
      "--agent", "  00000000-0000-4000-8000-00000000000B  ",
      "--confirm", rawLower,
      "--output-dir", "/tmp",
    ], {}, process.cwd());

    assert.ok(!("exitCode" in parsed));
    assert.equal(parsed.companyId, "00000000-0000-4000-8000-00000000000a");
    assert.equal(parsed.agentId, "00000000-0000-4000-8000-00000000000b");
    assert.equal(parsed.confirm, "00000000-0000-4000-8000-00000000000a");
  });

  await t.test("mismatched --confirm throws INVALID_ARGUMENT", () => {
    assert.throws(
      () => parseExportArgs([
        "--database-url", "postgres://u:p@localhost:5432/tenant",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--company", "00000000-0000-4000-8000-000000000001",
        "--agent", "00000000-0000-4000-8000-000000000002",
        "--confirm", "00000000-0000-4000-8000-000000000009",
        "--output-dir", "/tmp",
      ], {}, process.cwd()),
      (err: any) => {
        assert.equal(err.code, "INVALID_ARGUMENT");
        assert.equal(
          sanitizeCliErrorMessage(err),
          "[INVALID_ARGUMENT] Flag --confirm <uuid> must strictly match --company <uuid>.",
        );
        return true;
      },
    );
  });

  await t.test("missing --output-dir when --confirm supplied throws INVALID_ARGUMENT", () => {
    assert.throws(
      () => parseExportArgs([
        "--database-url", "postgres://u:p@localhost:5432/tenant",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--company", "00000000-0000-4000-8000-000000000001",
        "--agent", "00000000-0000-4000-8000-000000000002",
        "--confirm", "00000000-0000-4000-8000-000000000001",
      ], {}, process.cwd()),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  });

  await t.test("prod gate enforces --prod and MEMORY_UPGRADE_ALLOW_PROD=1 on remote hosts", () => {
    assert.throws(
      () => parseExportArgs([
        "--database-url", "postgres://u:p@db.remote.com:5432/tenant",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--company", "00000000-0000-4000-8000-000000000001",
        "--agent", "00000000-0000-4000-8000-000000000002",
      ], {}, process.cwd()),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "PROD_GUARD_ENFORCED",
    );
  });
});
