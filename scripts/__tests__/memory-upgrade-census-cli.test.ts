import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateAndResolveTableIdentifier,
  validateDatabaseUrl,
  validateOutputPath,
} from "../../server/src/services/company-memory-upgrade/census.js";
import {
  main as runMemoryUpgradeCli,
  parseFlagValue,
  hasBooleanFlag,
  validateNoUnknownFlags,
  isNumericString,
  isUsableFlagValue,
  BOOLEAN_FLAGS,
  VALUE_FLAGS,
  ALLOWED_CENSUS_FLAGS,
} from "../memory-upgrade.js";
import { sql } from "./memory-upgrade-census-helpers.js";

describe("isNumericString and isUsableFlagValue helper unit tests", () => {
  it("validates numeric strings including negative and decimal numbers", () => {
    // Negative numbers
    assert.equal(isNumericString("-5"), true);
    assert.equal(isNumericString("-0.5"), true);
    assert.equal(isNumericString("-.5"), true);

    // Positive numbers and decimals
    assert.equal(isNumericString("5"), true);
    assert.equal(isNumericString("0.5"), true);
    assert.equal(isNumericString(".5"), true);
    assert.equal(isNumericString("0"), true);
    assert.equal(isNumericString("  -5  "), true);
    assert.equal(isNumericString("  100.25  "), true);

    // Non-numeric tokens
    assert.equal(isNumericString("-h"), false);
    assert.equal(isNumericString("-v"), false);
    assert.equal(isNumericString("-"), false);
    assert.equal(isNumericString(""), false);
    assert.equal(isNumericString("   "), false);
    assert.equal(isNumericString("--table"), false);
    assert.equal(isNumericString("abc"), false);
    assert.equal(isNumericString("1.2.3"), false);
    assert.equal(isNumericString("-"), false);
  });

  it("validates usable flag values rejecting empty, undefined, flag collisions, and dash tokens", () => {
    // Empty and undefined
    assert.equal(isUsableFlagValue(undefined), false);
    assert.equal(isUsableFlagValue(""), false);

    // Single-dash non-numeric tokens
    assert.equal(isUsableFlagValue("-h"), false);
    assert.equal(isUsableFlagValue("-v"), false);
    assert.equal(isUsableFlagValue("-"), false);
    assert.equal(isUsableFlagValue("-custom"), false);

    // Negative numbers are usable flag values (e.g. for numeric flags)
    assert.equal(isUsableFlagValue("-5"), true);
    assert.equal(isUsableFlagValue("-0.5"), true);
    assert.equal(isUsableFlagValue("-.5"), true);

    // Positive numbers and normal string values
    assert.equal(isUsableFlagValue("5"), true);
    assert.equal(isUsableFlagValue("public.mem0_memories"), true);
    assert.equal(isUsableFlagValue("postgres://localhost:5432/db"), true);
    assert.equal(isUsableFlagValue("00000000-0000-4000-8000-000000000001"), true);

    // Tokens starting with -- are rejected
    assert.equal(isUsableFlagValue("--table"), false);
    assert.equal(isUsableFlagValue("--anything"), false);

    // Collisions with BOOLEAN_FLAGS
    for (const flag of BOOLEAN_FLAGS) {
      assert.equal(isUsableFlagValue(flag), false, `Expected BOOLEAN_FLAG "${flag}" not to be usable value`);
    }

    // Collisions with VALUE_FLAGS
    for (const flag of VALUE_FLAGS) {
      assert.equal(isUsableFlagValue(flag), false, `Expected VALUE_FLAG "${flag}" not to be usable value`);
    }
  });
});

describe("validation, path, and CLI flags unit tests", () => {
  it("validates and resolves table identifiers", () => {
    // Valid bare identifiers
    const b1 = validateAndResolveTableIdentifier("mem0_memories", sql);
    assert.equal(b1.bareTable, "mem0_memories");
    assert.equal(b1.schema, null);

    // Valid schema-qualified identifiers
    const q1 = validateAndResolveTableIdentifier("public.mem0_memories", sql);
    assert.equal(q1.bareTable, "mem0_memories");
    assert.equal(q1.schema, "public");

    // Invalid identifiers
    assert.throws(
      () => validateAndResolveTableIdentifier("mem0; DROP TABLE users;--", sql),
      /Invalid --table value/,
    );
    assert.throws(
      () => validateAndResolveTableIdentifier("public.mem0.extra", sql),
      /Invalid --table value/,
    );
    assert.throws(
      () => validateAndResolveTableIdentifier("123bad", sql),
      /Invalid --table value/,
    );
    assert.throws(
      () => validateAndResolveTableIdentifier("has space", sql),
      /Invalid --table value/,
    );
  });

  it("validates output path rejecting paths inside repo, symlinked parents, and missing parents", () => {
    const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

    // Relative inside repo
    assert.throws(
      () => validateOutputPath("census-report.json", repoRoot),
      /Refusing to write output inside repository/,
    );

    // Absolute inside repo
    const insidePath = path.join(repoRoot, "server", "out.json");
    assert.throws(
      () => validateOutputPath(insidePath, repoRoot),
      /Refusing to write output inside repository/,
    );

    // Missing parent dir
    const missingParent = path.join(
      os.tmpdir(),
      `missing-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "out.json",
    );
    assert.throws(
      () => validateOutputPath(missingParent, repoRoot),
      /Parent directory does not exist/,
    );

    // Symlinked parent into repo
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-census-symlink-"));
    try {
      const symlinkParent = path.join(tmpDir, "repo-link");
      fs.symlinkSync(repoRoot, symlinkParent, "dir");
      assert.throws(
        () => validateOutputPath(path.join(symlinkParent, "out.json"), repoRoot),
        /Refusing to write output inside repository via symlinked parent/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Valid temp path accepted
    const validOut = path.join(os.tmpdir(), `mem0-census-${Date.now()}.json`);
    const resolved = validateOutputPath(validOut, repoRoot);
    assert.equal(resolved, path.resolve(validOut));
  });

  it("validates database URL and enforces prod gate against remote hosts", () => {
    // Localhost allowed without env var or --prod flag
    assert.doesNotThrow(() => {
      validateDatabaseUrl("postgres://usr:pw@localhost:5432/db", {});
    });
    assert.doesNotThrow(() => {
      validateDatabaseUrl("postgres://usr:pw@127.0.0.1:5432/db", {});
    });

    // Remote host rejected without both --prod flag and env var (names both)
    assert.throws(
      () => validateDatabaseUrl("postgres://usr:pw@rds.example.internal:5432/db", {}),
      (err: any) => {
        assert.equal(err.code, "PROD_GUARD_ENFORCED");
        assert.ok(err.message.includes("without --prod flag and MEMORY_UPGRADE_ALLOW_PROD=1 environment variable"));
        return true;
      },
    );

    // Remote host with env set but missing --prod flag (names missing --prod flag)
    assert.throws(
      () =>
        validateDatabaseUrl(
          "postgres://usr:pw@rds.example.internal:5432/db",
          { MEMORY_UPGRADE_ALLOW_PROD: "1" },
          { allowProd: false },
        ),
      (err: any) => {
        assert.equal(err.code, "PROD_GUARD_ENFORCED");
        assert.ok(err.message.includes("without --prod flag."));
        return true;
      },
    );

    // Remote host with --prod flag set but missing env var (names missing MEMORY_UPGRADE_ALLOW_PROD=1)
    assert.throws(
      () =>
        validateDatabaseUrl(
          "postgres://usr:pw@rds.example.internal:5432/db",
          {},
          { allowProd: true },
        ),
      (err: any) => {
        assert.equal(err.code, "PROD_GUARD_ENFORCED");
        assert.ok(err.message.includes("without MEMORY_UPGRADE_ALLOW_PROD=1 environment variable."));
        return true;
      },
    );

    // Remote host allowed when BOTH --prod flag and MEMORY_UPGRADE_ALLOW_PROD=1 are set
    assert.doesNotThrow(() => {
      validateDatabaseUrl(
        "postgres://usr:pw@rds.example.internal:5432/db",
        { MEMORY_UPGRADE_ALLOW_PROD: "1" },
        { allowProd: true },
      );
    });
  });

  it("validates CLI flag parsing hygiene", () => {
    // Supports --flag=value
    assert.equal(parseFlagValue("--table", ["--table=my_table"]), "my_table");
    assert.equal(parseFlagValue("--company", ["--company=11111111-1111-4111-8111-111111111111"]), "11111111-1111-4111-8111-111111111111");

    // Supports space-separated --flag value
    assert.equal(parseFlagValue("--table", ["--table", "my_table"]), "my_table");

    // Negative numeric values are passed through to numeric validator
    assert.equal(parseFlagValue("--long-threshold", ["--long-threshold", "-5"]), "-5");

    // Single-dash non-numeric values and boolean flags like -h are rejected as usable values
    assert.throws(
      () => parseFlagValue("--table", ["--table", "-h"]),
      (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("--table"),
    );
    assert.throws(
      () => parseFlagValue("--table", ["--table", "-v"]),
      (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("--table"),
    );
    assert.throws(
      () => parseFlagValue("--table", ["--table=-x"]),
      (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("--table"),
    );

    // Value flag present without usable value (missing, next starts with --, or empty =) throws hard INVALID_ARGUMENT error
    assert.throws(
      () => parseFlagValue("--table", ["--table"]),
      (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("--table"),
    );
    assert.throws(
      () => parseFlagValue("--table", ["--table", "--flag"]),
      (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("--table"),
    );
    assert.throws(
      () => parseFlagValue("--table", ["--table="]),
      (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("--table"),
    );
    assert.throws(
      () => parseFlagValue("--table", ["--table=--flag"]),
      (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("--table"),
    );

    // --database-url --prod must fail, NOT silently fall back to env var
    const prevEnv = process.env.COMPANY_MEMORY_DATABASE_URL;
    process.env.COMPANY_MEMORY_DATABASE_URL = "postgres://usr:pw@localhost:5432/from_env";
    try {
      assert.throws(
        () => parseFlagValue("--database-url", ["--database-url", "--prod"]),
        (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("--database-url"),
      );
    } finally {
      if (prevEnv !== undefined) {
        process.env.COMPANY_MEMORY_DATABASE_URL = prevEnv;
      } else {
        delete process.env.COMPANY_MEMORY_DATABASE_URL;
      }
    }

    // Boolean flags with =... rejected with clear error
    assert.throws(
      () => hasBooleanFlag("--prod", ["--prod=1"]),
      (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("Boolean flag '--prod' does not take a value"),
    );
    assert.throws(
      () => validateNoUnknownFlags(["--prod=true"], ALLOWED_CENSUS_FLAGS),
      (err: any) => err.code === "INVALID_ARGUMENT" && err.message.includes("Boolean flag '--prod' does not take a value"),
    );

    // Negative numeric values are passed to numeric validator, which rejects with numeric error, not unknown-flag error
    assert.doesNotThrow(() => {
      validateNoUnknownFlags(["--long-threshold", "-5"], ALLOWED_CENSUS_FLAGS);
    });

    // Unknown option rejected and error echoes ONLY flag name (never raw value containing DSN/password)
    assert.throws(
      () => validateNoUnknownFlags(["--bad-dsn=postgres://usr:secret_pass_123@host:5432/db"], ALLOWED_CENSUS_FLAGS),
      (err: Error) => {
        assert.ok(err.message.includes("Unknown option '--bad-dsn'"));
        assert.ok(!err.message.includes("secret_pass_123"));
        return true;
      },
    );
  });

  it("validates CLI flag rejection for unknown options and stub subcommands", async () => {
    // Unknown option rejected
    assert.throws(
      () => validateNoUnknownFlags(["--database-url", "url", "--write"], ALLOWED_CENSUS_FLAGS),
      /Unknown option '--write'/,
    );

    // Subcommands: flip, drain, prune, rollback, recover, status reject with not implemented yet
    let stderrLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      stderrLogged += `${msg}\n`;
    };

    try {
      const exitFlip = await runMemoryUpgradeCli(["node", "memory-upgrade.ts", "flip"]);
      assert.equal(exitFlip, 1);
      assert.ok(stderrLogged.includes("Subcommand 'flip' is not implemented yet."));

      stderrLogged = "";
      const exitStatus = await runMemoryUpgradeCli(["node", "memory-upgrade.ts", "status"]);
      assert.equal(exitStatus, 1);
      assert.ok(stderrLogged.includes("Subcommand 'status' is not implemented yet."));

      // Subcommand matching /^[a-z-]+$/ echoes subcommand name
      stderrLogged = "";
      const exitUnknown = await runMemoryUpgradeCli(["node", "memory-upgrade.ts", "bogus"]);
      assert.equal(exitUnknown, 1);
      assert.ok(stderrLogged.includes("Unknown subcommand 'bogus'."));

      // Subcommand omitted entirely prints usage without echoing args[0]
      stderrLogged = "";
      const exitMissing = await runMemoryUpgradeCli(["node", "memory-upgrade.ts"]);
      assert.equal(exitMissing, 1);
      assert.ok(stderrLogged.includes("Usage: pnpm memory:upgrade <subcommand> [options]"));

      // Subcommand not matching /^[a-z-]+$/ (e.g. DSN with secret credentials) does NOT echo args[0]
      stderrLogged = "";
      const exitDsn = await runMemoryUpgradeCli(["node", "memory-upgrade.ts", "postgres://usr:secret_pass_leak@host:5432/db"]);
      assert.equal(exitDsn, 1);
      assert.ok(stderrLogged.includes("Error: Unknown subcommand."));
      assert.ok(!stderrLogged.includes("secret_pass_leak"));
      assert.ok(!stderrLogged.includes("postgres://"));

      // Negative long threshold fails with numeric error instead of unknown option
      stderrLogged = "";
      const exitNegativeNumeric = await runMemoryUpgradeCli([
        "node",
        "memory-upgrade.ts",
        "census",
        "--database-url",
        "postgres://usr:pw@localhost:5432/db",
        "--long-threshold",
        "-5",
      ]);
      assert.equal(exitNegativeNumeric, 1);
      assert.ok(stderrLogged.includes('Invalid --long-threshold "-5". Must be a positive integer.'));

      // Value flag followed by -h fails INVALID_ARGUMENT rather than short-circuiting to help
      stderrLogged = "";
      let stdoutLogged = "";
      const origLog = console.log;
      console.log = (msg: string) => {
        stdoutLogged += `${msg}\n`;
      };
      try {
        const exitMissingValBeforeHelp = await runMemoryUpgradeCli([
          "node",
          "memory-upgrade.ts",
          "census",
          "--database-url",
          "postgres://usr:pw@localhost:5432/db",
          "--table",
          "-h",
        ]);
        assert.equal(exitMissingValBeforeHelp, 1);
        assert.ok(stderrLogged.includes("Flag '--table' requires a usable value."));
        assert.equal(stdoutLogged, "", "Help must not be printed when a value flag is missing a value");

        // Standalone -h works and prints help
        stderrLogged = "";
        stdoutLogged = "";
        const exitHelpShort = await runMemoryUpgradeCli([
          "node",
          "memory-upgrade.ts",
          "census",
          "-h",
        ]);
        assert.equal(exitHelpShort, 0);
        assert.ok(stdoutLogged.includes("Usage: pnpm memory:upgrade census"));

        // Standalone --help works and prints help
        stderrLogged = "";
        stdoutLogged = "";
        const exitHelpLong = await runMemoryUpgradeCli([
          "node",
          "memory-upgrade.ts",
          "census",
          "--help",
        ]);
        assert.equal(exitHelpLong, 0);
        assert.ok(stdoutLogged.includes("Usage: pnpm memory:upgrade census"));

        // Valid args with -h prints help
        stderrLogged = "";
        stdoutLogged = "";
        const exitHelpWithValidArgs = await runMemoryUpgradeCli([
          "node",
          "memory-upgrade.ts",
          "census",
          "--database-url",
          "postgres://usr:pw@localhost:5432/db",
          "-h",
        ]);
        assert.equal(exitHelpWithValidArgs, 0);
        assert.ok(stdoutLogged.includes("Usage: pnpm memory:upgrade census"));
      } finally {
        console.log = origLog;
      }
    } finally {
      console.error = origError;
    }
  });
});
