import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectEnvironmentSecrets,
  collectUrlPasswordSecrets,
  hasFlag,
  parseFlag,
  redactSampleData,
  sampleMem0MemoryContent,
  validateAndResolveTableIdentifier,
  validateExplicitDatabaseUrl,
  validateOutputPath,
  validateRedactPrefixChars,
  main,
} from "../sample-mem0-memory-content.js";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../packages/db/src/index.js";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { sql } = require("drizzle-orm");

export function handleEmbeddedPostgresUnsupported(
  support: { supported: boolean; reason?: string },
  t?: { skip: (reason?: string) => void },
  ciEnv: string | undefined = process.env.CI,
): void {
  if (support.supported) return;
  const reason = support.reason ?? "embedded Postgres not supported";
  if (ciEnv === "true" || ciEnv === "1") {
    throw new Error(`Embedded Postgres is required in CI but not supported: ${reason}`);
  }
  if (t && typeof t.skip === "function") {
    t.skip(reason);
  }
}

describe("sample-mem0-memory-content unit & contract tests", () => {
  it("parses CLI flags correctly", () => {
    const argv = ["node", "script.js", "--out", "/tmp/out.json", "--limit", "25", "--table", "custom_table"];
    assert.equal(parseFlag("--out", argv), "/tmp/out.json");
    assert.equal(parseFlag("--limit", argv), "25");
    assert.equal(parseFlag("--table", argv), "custom_table");
    assert.equal(parseFlag("--agent", argv), null);
    assert.equal(hasFlag("--company", argv), false);
    assert.equal(hasFlag("--limit", argv), true);
  });

  it("validates and resolves bare and schema-qualified table identifiers", () => {
    // Bare valid identifier
    assert.doesNotThrow(() => validateAndResolveTableIdentifier("mem0_memories", sql));
    assert.doesNotThrow(() => validateAndResolveTableIdentifier("custom_memories_v2", sql));

    // Schema-qualified valid identifier
    assert.doesNotThrow(() => validateAndResolveTableIdentifier("public.mem0_memories", sql));
    assert.doesNotThrow(() => validateAndResolveTableIdentifier("tenant_01.mem0_memories", sql));

    // Invalid identifiers should be rejected
    assert.throws(
      () => validateAndResolveTableIdentifier("mem0; DROP TABLE users;--", sql),
      /Invalid --table value/,
    );
    assert.throws(
      () => validateAndResolveTableIdentifier("public.mem0.extra", sql),
      /Invalid --table value/,
    );
    assert.throws(
      () => validateAndResolveTableIdentifier("123invalid", sql),
      /Invalid --table value/,
    );
    assert.throws(
      () => validateAndResolveTableIdentifier("has space", sql),
      /Invalid --table value/,
    );
  });

  it("validates redact prefix character counts", () => {
    assert.equal(validateRedactPrefixChars(null), 16);
    assert.equal(validateRedactPrefixChars("0"), 0);
    assert.equal(validateRedactPrefixChars("24"), 24);

    assert.throws(() => validateRedactPrefixChars("-1"), /Must be a non-negative integer/);
    assert.throws(() => validateRedactPrefixChars("foo"), /Must be a non-negative integer/);
    assert.throws(() => validateRedactPrefixChars("3.14"), /Must be a non-negative integer/);
  });

  it("masks prefixes and scrubs environment secrets", () => {
    const secrets = ["super_secret_token", "db_password_xyz"];

    // Standard prefix masking
    const res1 = redactSampleData("User preference is dark mode", secrets, 16);
    assert.equal(res1, "[REDACTED_16_CHARS]is dark mode");

    // Short data smaller than prefix
    const res2 = redactSampleData("Short", secrets, 16);
    assert.equal(res2, "[REDACTED_5_CHARS]");

    // Zero prefix: no prefix characters masked, but secrets scrubbed
    const res3 = redactSampleData("User token is super_secret_token for auth", secrets, 0);
    assert.equal(res3, "User token is ***REDACTED*** for auth");

    // Masking plus secret scrubbing
    const res4 = redactSampleData("The password was db_password_xyz confirmed", secrets, 12);
    assert.ok(res4.startsWith("[REDACTED_12_CHARS]"));
    assert.ok(!res4.includes("db_password_xyz"));
    assert.ok(res4.includes("***REDACTED***"));

    // Empty data returns empty
    assert.equal(redactSampleData("", secrets, 16), "");
  });

  it("collects secrets and extracts password components from connection URLs", () => {
    const fakeEnv = {
      API_KEY: "secret_api_key_12345",
      AUTH_TOKEN: "jwt_bearer_token_9999",
      SERVICE_PASSWORD: "plain_password_xyz",
      DATABASE_URL: "postgres://user:url_password_secret@localhost:5432/db",
      COMPANY_MEMORY_DATABASE_URL: "postgres://tenant:company_db_secret@localhost:5432/mem",
      PUBLIC_WEB_URL: "https://example.com/api",
      SHORT: "abc", // < 4 chars, ignored
    };

    const secrets = collectEnvironmentSecrets(fakeEnv);
    assert.ok(secrets.includes("secret_api_key_12345"));
    assert.ok(secrets.includes("jwt_bearer_token_9999"));
    assert.ok(secrets.includes("plain_password_xyz"));
    assert.ok(secrets.includes("url_password_secret"));
    assert.ok(secrets.includes("company_db_secret"));
    assert.ok(!secrets.includes("https://example.com/api"));
    assert.ok(!secrets.includes("abc"));

    // Also extracts raw and decoded passwords directly from databaseUrl even when not in env
    const secretsWithCliUrl = collectEnvironmentSecrets(
      {},
      "postgres://tenant:cli_only_db_pass%21@localhost:5432/mem",
    );
    assert.ok(secretsWithCliUrl.includes("cli_only_db_pass%21"));
    assert.ok(secretsWithCliUrl.includes("cli_only_db_pass!"));
  });

  it("extracts URL passwords covering raw encoded, decoded, short, malformed percent, and invalid URLs", () => {
    // 1. Raw encoded and decoded components
    const encodedSecrets = collectUrlPasswordSecrets(
      "postgres://usr:p%40ss%23word%20123@localhost:5432/db",
    );
    assert.ok(encodedSecrets.includes("p%40ss%23word%20123"));
    assert.ok(encodedSecrets.includes("p@ss#word 123"));

    // 2. Short passwords (< 4 chars) without >= 4 filtering
    const shortSecrets1 = collectUrlPasswordSecrets("postgres://usr:pw@localhost:5432/db");
    assert.ok(shortSecrets1.includes("pw"));
    const shortSecrets2 = collectUrlPasswordSecrets("postgres://usr:k1@localhost:5432/db");
    assert.ok(shortSecrets2.includes("k1"));

    // 3. Malformed percent-encoding preserves raw password without dropping via swallowed catch
    const malformedSecrets1 = collectUrlPasswordSecrets(
      "postgres://usr:malformed%ZZpass@localhost:5432/db",
    );
    assert.ok(malformedSecrets1.includes("malformed%ZZpass"));
    const malformedSecrets2 = collectUrlPasswordSecrets(
      "postgres://usr:percent%8tail@localhost:5432/db",
    );
    assert.ok(malformedSecrets2.includes("percent%8tail"));
    const malformedSecrets3 = collectUrlPasswordSecrets(
      "postgres://usr:dangling%@localhost:5432/db",
    );
    assert.ok(malformedSecrets3.includes("dangling%"));

    // 4. Invalid URLs and URLs without password return empty array without throwing
    assert.deepEqual(collectUrlPasswordSecrets("not-a-valid-url"), []);
    assert.deepEqual(collectUrlPasswordSecrets("://bad-scheme"), []);
    assert.deepEqual(collectUrlPasswordSecrets(""), []);
    assert.deepEqual(collectUrlPasswordSecrets(null as any), []);
    assert.deepEqual(collectUrlPasswordSecrets(undefined), []);
    assert.deepEqual(collectUrlPasswordSecrets("https://example.com/no-pass"), []);
    assert.deepEqual(collectUrlPasswordSecrets("postgres://usr@localhost:5432/db"), []);

    // 5. Environment connection URLs and actual options.databaseUrl share helper behavior
    const envWithAllVariants = {
      DATABASE_URL: "postgres://usr:env_raw%21pass@localhost:5432/db1",
      COMPANY_MEMORY_DATABASE_URL: "postgres://usr:short_pw@localhost:5432/db2",
      CUSTOM_DB_URL: "postgres://usr:env_malformed%ZZ@localhost:5432/db3",
      INVALID_URL: "not-a-valid-url",
    };
    const combinedSecrets = collectEnvironmentSecrets(
      envWithAllVariants,
      "postgres://usr:direct_malformed%FF_pw@localhost:5432/db4",
    );
    // env URLs
    assert.ok(combinedSecrets.includes("env_raw%21pass"));
    assert.ok(combinedSecrets.includes("env_raw!pass"));
    assert.ok(combinedSecrets.includes("short_pw"));
    assert.ok(combinedSecrets.includes("env_malformed%ZZ"));
    // actual options.databaseUrl
    assert.ok(combinedSecrets.includes("direct_malformed%FF_pw"));
  });

  it("redacts sample data and ensures no credential leaks for raw encoded, decoded, short, and malformed passwords", () => {
    const rawEncoded = "cli_pass%21%23secret";
    const decoded = "cli_pass!#secret";
    const shortPw = "pw";
    const malformedPw = "malformed%ZZsecret";

    const secrets = collectEnvironmentSecrets(
      {
        DATABASE_URL: `postgres://usr:${rawEncoded}@localhost:5432/db1`,
        SHORT_URL: `postgres://usr:${shortPw}@localhost:5432/db2`,
      },
      `postgres://usr:${malformedPw}@localhost:5432/db3`,
    );

    // Verify all passwords collected
    assert.ok(secrets.includes(rawEncoded));
    assert.ok(secrets.includes(decoded));
    assert.ok(secrets.includes(shortPw));
    assert.ok(secrets.includes(malformedPw));

    // Test data with all credential variants
    const sampleText = [
      `Connecting using raw password ${rawEncoded} in log.`,
      `Decoded password ${decoded} was shown.`,
      `User set password to ${shortPw} for rapid testing.`,
      `Legacy system passed ${malformedPw} as credential.`,
      `Unrelated word spawning upward should not corrupt word tokens.`,
    ].join("\n");

    const redacted = redactSampleData(sampleText, secrets, 0);

    // Ensure NO credential leaks
    assert.ok(!redacted.includes(rawEncoded), "Raw encoded credential must not leak");
    assert.ok(!redacted.includes(decoded), "Decoded credential must not leak");
    assert.ok(!redacted.includes(` ${shortPw} `), "Short password must not leak");
    assert.ok(!redacted.includes(malformedPw), "Malformed percent credential must not leak");

    // Ensure redactor boundary policy preserves surrounding word tokens for short secrets
    assert.ok(redacted.includes("spawning"), "Surrounding word 'spawning' must be preserved");
    assert.ok(redacted.includes("upward"), "Surrounding word 'upward' must be preserved");
    assert.ok(redacted.includes("***REDACTED***"), "Redaction marker must be present");
  });

  it("handles embedded postgres unsupported environments by failing in CI and skipping locally", () => {
    // 1. When supported, does nothing
    assert.doesNotThrow(() => {
      handleEmbeddedPostgresUnsupported({ supported: true }, undefined, "true");
    });

    // 2. When unsupported and CI=true (or 1), throws
    assert.throws(
      () =>
        handleEmbeddedPostgresUnsupported(
          { supported: false, reason: "missing binary" },
          undefined,
          "true",
        ),
      /Embedded Postgres is required in CI but not supported: missing binary/,
    );
    assert.throws(
      () =>
        handleEmbeddedPostgresUnsupported(
          { supported: false, reason: "missing binary" },
          undefined,
          "1",
        ),
      /Embedded Postgres is required in CI but not supported: missing binary/,
    );

    // 3. When unsupported and not CI, calls t.skip
    let skippedReason: string | undefined;
    const mockT = {
      skip: (reason?: string) => {
        skippedReason = reason;
      },
    };
    assert.doesNotThrow(() => {
      handleEmbeddedPostgresUnsupported(
        { supported: false, reason: "local missing binary" },
        mockT,
        "",
      );
    });
    assert.equal(skippedReason, "local missing binary");
  });

  it("refuses output paths inside the repository worktree, missing parents, and symlinked parents into the repo", () => {
    const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

    // Relative inside repo
    assert.throws(
      () => validateOutputPath("sample-export.json", repoRoot),
      /Refusing to write output inside repository/,
    );

    // Absolute inside repo
    const insidePath = path.join(repoRoot, "scripts", "out.json");
    assert.throws(
      () => validateOutputPath(insidePath, repoRoot),
      /Refusing to write output inside repository/,
    );

    // Missing parent directory rejected
    const missingParentOut = path.join(
      os.tmpdir(),
      `nonexistent-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "out.json",
    );
    assert.throws(
      () => validateOutputPath(missingParentOut, repoRoot),
      /Parent directory does not exist/,
    );

    // Parent directory that is a symlink into the repo rejected
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-symlink-test-"));
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

    // Normal temp dir accepted
    const validOut = path.join(os.tmpdir(), `mem0-test-${Date.now()}.json`);
    const resolved = validateOutputPath(validOut, repoRoot);
    assert.equal(resolved, path.resolve(validOut));
  });

  it("CLI main() rejects --company selector", async () => {
    let errorLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      errorLogged += msg;
    };
    const origExitCode = process.exitCode;

    try {
      await main(["node", "script.js", "--company", "comp_01"]);
      assert.ok(errorLogged.includes("The --company selector has been removed"));
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = origError;
      process.exitCode = origExitCode;
    }
  });

  it("CLI main() rejects missing --out and --limit flags", async () => {
    let errorLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      errorLogged += msg;
    };
    const origExitCode = process.exitCode;

    try {
      await main(["node", "script.js"]);
      assert.ok(errorLogged.includes("Refuses to run without explicit --out and --limit"));
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = origError;
      process.exitCode = origExitCode;
    }
  });

  it("CLI main() rejects missing database URL without control-plane fallback", async () => {
    let errorLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      errorLogged += msg;
    };
    const origExitCode = process.exitCode;
    const origEnv = process.env.COMPANY_MEMORY_DATABASE_URL;
    delete process.env.COMPANY_MEMORY_DATABASE_URL;

    try {
      await main(["node", "script.js", "--out", "/tmp/test.json", "--limit", "10"]);
      assert.ok(errorLogged.includes("Refuses to run without explicit per-company --database-url"));
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = origError;
      process.exitCode = origExitCode;
      if (origEnv !== undefined) process.env.COMPANY_MEMORY_DATABASE_URL = origEnv;
    }
  });

  it("validates explicit database URLs, rejecting unparseable URLs and unsupported credentials without leaking passwords", () => {
    // 1. Valid URLs with normal passwords
    const res1 = validateExplicitDatabaseUrl("postgres://usr:secure_pass_123@localhost:5432/mem");
    assert.equal(res1.rawPassword, "secure_pass_123");
    assert.equal(res1.decodedPassword, "secure_pass_123");

    // Valid URL without password
    const res2 = validateExplicitDatabaseUrl("postgres://localhost:5432/mem");
    assert.equal(res2.rawPassword, undefined);

    // 2. Unparseable WHATWG URLs fail closed without leaking credentials
    const socketUrl = "postgres://usr:super_secret_socket_pw@/db?host=/var/run/postgresql";
    assert.throws(
      () => validateExplicitDatabaseUrl(socketUrl),
      (err: Error) => {
        assert.ok(!err.message.includes("super_secret_socket_pw"), "Error message must not leak password");
        assert.ok(/Unable to parse/.test(err.message));
        return true;
      },
    );

    assert.throws(
      () => validateExplicitDatabaseUrl("not-a-valid-url"),
      /Unable to parse/,
    );
    assert.throws(
      () => validateExplicitDatabaseUrl("://bad-scheme"),
      /Unable to parse/,
    );
    assert.throws(
      () => validateExplicitDatabaseUrl(""),
      /URL must be a non-empty string/,
    );

    // 3. Punctuation-only short passwords (< 4 chars without alphanumeric) fail closed without leaking credentials
    const punctuationPasswords = [
      { url: "postgres://usr:!!@localhost:5432/db", pass: "!!" },
      { url: "postgres://usr:***@localhost:5432/db", pass: "***" },
      { url: "postgres://usr:%21%21@localhost:5432/db", pass: "%21%21" },
      { url: "postgres://usr:-_-@localhost:5432/db", pass: "-_-" },
    ];
    for (const { url, pass } of punctuationPasswords) {
      assert.throws(
        () => validateExplicitDatabaseUrl(url),
        (err: Error) => {
          assert.ok(!err.message.includes(pass), `Error message must not leak password "${pass}"`);
          assert.ok(/unsupported format: short punctuation-only passwords/.test(err.message));
          return true;
        },
      );
    }
  });

  it("emits stderr warning for supported short alphanumeric passwords and remains silent for >= 4 char passwords", () => {
    let stderrLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      stderrLogged += `${msg}\n`;
    };

    try {
      // Short alphanumeric passwords (< 4 chars) emit warning
      validateExplicitDatabaseUrl("postgres://usr:pw@localhost:5432/db");
      assert.ok(stderrLogged.includes("Warning: Database URL uses a short password (< 4 characters)"));
      assert.ok(/token-boundary redaction/i.test(stderrLogged));

      stderrLogged = "";
      validateExplicitDatabaseUrl("postgres://usr:k1@localhost:5432/db");
      assert.ok(stderrLogged.includes("Warning: Database URL uses a short password (< 4 characters)"));

      stderrLogged = "";
      validateExplicitDatabaseUrl("postgres://usr:a@localhost:5432/db");
      assert.ok(stderrLogged.includes("Warning: Database URL uses a short password (< 4 characters)"));

      // Normal passwords (>= 4 chars) emit NO warning
      stderrLogged = "";
      validateExplicitDatabaseUrl("postgres://usr:pass1234@localhost:5432/db");
      assert.equal(stderrLogged, "");
    } finally {
      console.error = origError;
    }
  });

  it("fails closed in sampleMem0MemoryContent BEFORE connecting or creating output file for unparseable URLs and punctuation passwords", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-fail-closed-"));
    try {
      // 1. Unparseable socket URL
      const unparseableOut = path.join(tmpDir, "socket-out.json");
      await assert.rejects(
        async () => {
          await sampleMem0MemoryContent({
            outPath: unparseableOut,
            limit: 10,
            databaseUrl: "postgres://usr:raw_secret_socket_pass@/db?host=/var/run/postgresql",
          });
        },
        (err: Error) => {
          assert.ok(!err.message.includes("raw_secret_socket_pass"), "Must not leak password");
          assert.ok(/Unable to parse/.test(err.message));
          return true;
        },
      );
      assert.equal(fs.existsSync(unparseableOut), false, "Output file must not be created");

      // 2. Punctuation-only short password
      const punctuationOut = path.join(tmpDir, "punct-out.json");
      await assert.rejects(
        async () => {
          await sampleMem0MemoryContent({
            outPath: punctuationOut,
            limit: 10,
            databaseUrl: "postgres://usr:!!@localhost:5432/db",
          });
        },
        (err: Error) => {
          assert.ok(!err.message.includes("!!"), "Must not leak password");
          assert.ok(/unsupported format: short punctuation-only passwords/.test(err.message));
          return true;
        },
      );
      assert.equal(fs.existsSync(punctuationOut), false, "Output file must not be created");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("CLI main() rejects unparseable URLs and punctuation-only short passwords without leaking credentials", async () => {
    let errorLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      errorLogged += `${msg}\n`;
    };
    const origExitCode = process.exitCode;

    try {
      // Unparseable URL
      await main([
        "node",
        "script.js",
        "--out",
        "/tmp/test.json",
        "--limit",
        "10",
        "--database-url",
        "postgres://usr:leak_pass_cli@/db?host=/var/run/postgresql",
      ]);
      assert.ok(errorLogged.includes("Sample mem0 memory content failed"));
      assert.ok(!errorLogged.includes("leak_pass_cli"));
      assert.equal(process.exitCode, 1);

      // Punctuation password
      errorLogged = "";
      process.exitCode = 0;
      await main([
        "node",
        "script.js",
        "--out",
        "/tmp/test.json",
        "--limit",
        "10",
        "--database-url",
        "postgres://usr:***@localhost:5432/db",
      ]);
      assert.ok(errorLogged.includes("unsupported format: short punctuation-only passwords"));
      assert.ok(!errorLogged.includes("***"));
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = origError;
      process.exitCode = origExitCode;
    }
  });

  it("verifies exact boundary outputs with punctuation and JSON delimiters for short secrets", () => {
    const secrets = ["k1", "pw"];

    // 1. JSON delimiter boundaries: quotes, braces, colons, brackets, commas
    assert.equal(
      redactSampleData('{"secret":"k1"}', secrets, 0),
      '{"secret":"***REDACTED***"}',
    );
    assert.equal(
      redactSampleData('{"k1":"value"}', secrets, 0),
      '{"***REDACTED***":"value"}',
    );
    assert.equal(
      redactSampleData('["k1", "pw"]', secrets, 0),
      '["***REDACTED***", "***REDACTED***"]',
    );
    assert.equal(
      redactSampleData('{"a":1,"b":"pw","c":true}', secrets, 0),
      '{"a":1,"b":"***REDACTED***","c":true}',
    );
    assert.equal(
      redactSampleData('{"nested":{"inner":"k1"}}', secrets, 0),
      '{"nested":{"inner":"***REDACTED***"}}',
    );

    // 2. Punctuation delimiters: parentheses, exclamation, question mark, colons, commas, semicolons, slashes
    assert.equal(
      redactSampleData("User token is (k1).", secrets, 0),
      "User token is (***REDACTED***).",
    );
    assert.equal(
      redactSampleData("Detected password pw!", secrets, 0),
      "Detected password ***REDACTED***!",
    );
    assert.equal(
      redactSampleData("Is this k1? Yes.", secrets, 0),
      "Is this ***REDACTED***? Yes.",
    );
    assert.equal(
      redactSampleData("k1: first item", secrets, 0),
      "***REDACTED***: first item",
    );
    assert.equal(
      redactSampleData("values: k1, second", secrets, 0),
      "values: ***REDACTED***, second",
    );
    assert.equal(
      redactSampleData("k1; next;", secrets, 0),
      "***REDACTED***; next;",
    );
    assert.equal(
      redactSampleData("/opt/k1/bin", secrets, 0),
      "/opt/***REDACTED***/bin",
    );
    assert.equal(
      redactSampleData("k1", secrets, 0),
      "***REDACTED***",
    );

    // 3. Non-boundary word/token characters ([a-zA-Z0-9_-]) protecting legitimate text
    assert.equal(
      redactSampleData("spawning upward", secrets, 0),
      "spawning upward",
    );
    assert.equal(
      redactSampleData("k123 and prek1", secrets, 0),
      "k123 and prek1",
    );
    assert.equal(
      redactSampleData("k1_identifier and pre-k1-item", secrets, 0),
      "k1_identifier and pre-k1-item",
    );
    assert.equal(
      redactSampleData("pw_hash and var-pw", secrets, 0),
      "pw_hash and var-pw",
    );
  });
});

describe("sample-mem0-memory-content integration test against fixture table", () => {
  it("queries real Mem0 table shape, respects read-only transaction, orders by payload created_at, applies agent filter, and cleans up connection", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_mem0_sampler");
    const db = createDb(fixture.connectionString);

    try {
      // Create table matching exact Mem0 pgvector collection table shape: id, vector, payload
      // created_at is strictly in payload->>'created_at'
      await db.execute(sql`
        CREATE TABLE mem0_memories (
          id TEXT PRIMARY KEY,
          vector TEXT,
          payload JSONB NOT NULL
        );
      `);

      // Create dedicated user with custom password to verify that options.databaseUrl
      // password component is collected into scrub secrets and redacted, even when not in env.
      await db.execute(sql`CREATE USER test_cli_user WITH PASSWORD 'cli_direct_pass!@#456';`);
      await db.execute(sql`GRANT USAGE ON SCHEMA public TO test_cli_user;`);
      await db.execute(sql`GRANT SELECT ON mem0_memories TO test_cli_user;`);

      // Seed test memories
      await db.execute(sql`
        INSERT INTO mem0_memories (id, vector, payload) VALUES
        ('mem-1', '[]', '{"agent_id": "agent-alpha", "user_id": "company", "data": "Alpha note 1 with secret_key_secret123", "created_at": "2026-11-05T10:00:00.000Z"}'::jsonb),
        ('mem-2', '[]', '{"agent_id": "agent-alpha", "user_id": "company", "data": "Alpha note 2 newest entry with cli_direct_pass!@#456", "created_at": "2026-11-05T12:00:00.000Z"}'::jsonb),
        ('mem-3', '[]', '{"agent_id": "agent-beta", "user_id": "company", "data": "Beta note middle entry", "created_at": "2026-11-05T11:00:00.000Z"}'::jsonb),
        ('mem-4', '[]', '{"agent_id": null, "user_id": "company", "data": "Unassigned note without timestamp", "created_at": null}'::jsonb);
      `);

      const testOutPath = path.join(os.tmpdir(), `mem0-e2e-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

      // Build databaseUrl with encoded password supplied directly to options, not present in env
      const directDbUrl = new URL(fixture.connectionString);
      directDbUrl.username = "test_cli_user";
      directDbUrl.password = encodeURIComponent("cli_direct_pass!@#456");
      const directDatabaseUrl = directDbUrl.toString();

      const testEnv = {
        ...process.env,
        TEST_SECRET_KEY: "secret_key_secret123",
      };
      assert.ok(
        !Object.values(testEnv).some(
          (val) => typeof val === "string" && val.includes("cli_direct_pass!@#456"),
        ),
      );

      // 1. Unscoped sampling (all agents) with transaction hook asserting read-only from inside sampler tx
      let hookTxReadOnly: string | undefined;
      const result = await sampleMem0MemoryContent({
        outPath: testOutPath,
        limit: 10,
        databaseUrl: directDatabaseUrl,
        tableName: "mem0_memories",
        agentFilter: null,
        redactPrefixChars: 16,
        env: testEnv,
        onTransaction: async (tx) => {
          const check = (await tx.execute(sql`SHOW transaction_read_only;`)) as unknown as Array<{
            transaction_read_only: string;
          }>;
          hookTxReadOnly = check[0]?.transaction_read_only;
        },
      });

      assert.equal(hookTxReadOnly, "on");
      assert.equal(result.transactionReadOnly, "on");
      assert.equal(result.totalCount, 4);
      assert.equal(result.sampleCount, 4);
      assert.ok(fs.existsSync(testOutPath));

      // Verify file mode 0600 (owner read/write only)
      const stat = fs.statSync(testOutPath);
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600);

      // Verify file contents
      const content = JSON.parse(fs.readFileSync(testOutPath, "utf8"));
      assert.equal(content.metadata.table, "mem0_memories");
      assert.equal(content.metadata.totalCount, 4);
      assert.equal(content.metadata.agentFilter, null);

      // Agent breakdown checks (snake_case and '(none)' sentinel)
      const alphaBreakdown = content.metadata.agentBreakdown.find((r: any) => r.agent_id === "agent-alpha");
      const betaBreakdown = content.metadata.agentBreakdown.find((r: any) => r.agent_id === "agent-beta");
      const unassignedBreakdown = content.metadata.agentBreakdown.find((r: any) => r.agent_id === "(none)");
      assert.equal(alphaBreakdown?.count, 2);
      assert.equal(betaBreakdown?.count, 1);
      assert.equal(unassignedBreakdown?.count, 1);

      // Sample ordering check: payload->>'created_at' DESC NULLS LAST
      // Expected order: mem-2 (12:00), mem-3 (11:00), mem-1 (10:00), mem-4 (null)
      assert.equal(content.samples[0].id, "mem-2");
      assert.equal(content.samples[0].createdAt, "2026-11-05T12:00:00.000Z");
      assert.equal(content.samples[1].id, "mem-3");
      assert.equal(content.samples[1].createdAt, "2026-11-05T11:00:00.000Z");
      assert.equal(content.samples[2].id, "mem-1");
      assert.equal(content.samples[2].createdAt, "2026-11-05T10:00:00.000Z");
      assert.equal(content.samples[3].id, "mem-4");
      assert.equal(content.samples[3].createdAt, null);
      assert.equal(content.samples[3].agentId, null);

      // Redaction check on mem-1: secret_key_secret123 scrubbed and prefix masked
      assert.ok(!content.samples[2].dataRedacted.includes("secret_key_secret123"));
      assert.ok(content.samples[2].dataRedacted.startsWith("[REDACTED_16_CHARS]"));

      // Redaction check on mem-2: direct options.databaseUrl decoded password scrubbed even when not in env
      assert.ok(!content.samples[0].dataRedacted.includes("cli_direct_pass!@#456"));
      assert.ok(content.samples[0].dataRedacted.includes("***REDACTED***"));
      assert.ok(content.samples[0].dataRedacted.startsWith("[REDACTED_16_CHARS]"));

      // 2. Exclusive creation: writing again to testOutPath must fail with EEXIST (wx flag)
      await assert.rejects(
        () =>
          sampleMem0MemoryContent({
            outPath: testOutPath,
            limit: 5,
            databaseUrl: fixture.connectionString,
          }),
        (err: any) => err.code === "EEXIST",
      );

      fs.unlinkSync(testOutPath);

      // 3. Scoped agent filter test: --agent agent-alpha
      const agentOutPath = path.join(os.tmpdir(), `mem0-agent-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      const agentResult = await sampleMem0MemoryContent({
        outPath: agentOutPath,
        limit: 10,
        databaseUrl: fixture.connectionString,
        tableName: "mem0_memories",
        agentFilter: "agent-alpha",
        redactPrefixChars: 16,
      });

      assert.equal(agentResult.totalCount, 2);
      assert.equal(agentResult.sampleCount, 2);
      const agentContent = JSON.parse(fs.readFileSync(agentOutPath, "utf8"));
      assert.equal(agentContent.metadata.agentFilter, "agent-alpha");
      assert.equal(agentContent.metadata.totalCount, 2);
      assert.equal(agentContent.metadata.agentBreakdown.length, 1);
      assert.equal(agentContent.metadata.agentBreakdown[0].agent_id, "agent-alpha");
      assert.equal(agentContent.samples.length, 2);
      assert.ok(agentContent.samples.every((s: any) => s.agentId === "agent-alpha"));

      fs.unlinkSync(agentOutPath);

      // 4. Verify read-only transaction from inside the sampler's actual transaction:
      // an attempted mutation inside the sampler's transaction fails closed.
      const rejectOutPath = path.join(
        os.tmpdir(),
        `mem0-reject-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
      await assert.rejects(
        () =>
          sampleMem0MemoryContent({
            outPath: rejectOutPath,
            limit: 5,
            databaseUrl: fixture.connectionString,
            tableName: "mem0_memories",
            onTransaction: async (tx) => {
              await tx.execute(
                sql`INSERT INTO mem0_memories (id, vector, payload) VALUES ('mem-fail', '[]', '{}'::jsonb);`,
              );
            },
          }),
        (err: any) => {
          const msg = `${err?.message ?? ""} ${err?.cause?.message ?? ""}`;
          return msg.includes("cannot execute INSERT in a read-only transaction");
        },
      );
      assert.ok(!fs.existsSync(rejectOutPath), "output file must not be created when transaction fails");
    } finally {
      await db.$client.end({ timeout: 1 }).catch(() => {});
      await fixture.cleanup();
    }
  });
});
