import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyMemoryNoise,
  classifyMemoryNoiseDetailed,
} from "../../server/src/services/company-memory-upgrade/classify-noise.js";
import {
  detectSensitiveFamilies,
  SENSITIVE_FAMILIES,
} from "../../server/src/services/company-memory-upgrade/sensitive-patterns.js";
import {
  CONVERSION_BUDGET_CONSTANTS,
  estimateConversionBudget,
  formatDurationHuman,
} from "../../server/src/services/company-memory-upgrade/budget.js";
import {
  formatCensusTextReport,
  isValidUuid,
  runCensus,
  validateAndResolveTableIdentifier,
  validateDatabaseUrl,
  validateOutputPath,
} from "../../server/src/services/company-memory-upgrade/census.js";
import {
  main as runMemoryUpgradeCli,
  parseFlagValue,
  validateNoUnknownFlags,
  ALLOWED_CENSUS_FLAGS,
} from "../memory-upgrade.js";
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

describe("classifyMemoryNoise pure unit tests", () => {
  it("classifies null, undefined, empty, and whitespace as noise", () => {
    assert.equal(classifyMemoryNoise(null), true);
    assert.equal(classifyMemoryNoise(undefined), true);
    assert.equal(classifyMemoryNoise(""), true);
    assert.equal(classifyMemoryNoise("   "), true);
    assert.equal(classifyMemoryNoise("\t\n  \r"), true);
  });

  it("classifies strings under length floor (< 4 characters) as noise", () => {
    assert.equal(classifyMemoryNoise("a"), true);
    assert.equal(classifyMemoryNoise("hi"), true);
    assert.equal(classifyMemoryNoise("ok"), true);
    assert.equal(classifyMemoryNoise("yes"), true);
    assert.equal(classifyMemoryNoise("no"), true);
    assert.equal(classifyMemoryNoise("yo"), true);
    assert.equal(classifyMemoryNoise(" . "), true);
  });

  it("classifies test and placeholder strings as noise", () => {
    const placeholders = [
      "test",
      "testing",
      "test note",
      "test memory",
      "test data",
      "test 123",
      "placeholder",
      "dummy",
      "dummy note",
      "sample",
      "sample note",
      "sample text",
      "lorem ipsum",
      "lorem ipsum dolor sit amet",
      "asdf",
      "qwerty",
      "foo",
      "bar",
      "baz",
      "foobar",
      "n/a",
      "na",
      "none",
      "null",
      "nil",
      "undefined",
      "nothing",
      "empty",
      "ping",
      "pong",
    ];

    for (const p of placeholders) {
      assert.equal(classifyMemoryNoise(p), true, `Expected "${p}" to be noise`);
      assert.equal(classifyMemoryNoise(`  ${p.toUpperCase()}!  `), true, `Expected uppercase punctuated "${p}" to be noise`);
    }
  });

  it("classifies bare greetings and acknowledgments as noise", () => {
    const greetings = [
      "hello",
      "hello world",
      "hello there",
      "good morning",
      "good afternoon",
      "good evening",
      "good night",
      "thanks",
      "thank you",
      "thank you so much",
      "ok",
      "okay",
      "sounds good",
      "got it",
      "understood",
      "ack",
      "noted",
      "bye",
      "goodbye",
      "see you",
      "cya",
      "done",
    ];

    for (const g of greetings) {
      assert.equal(classifyMemoryNoise(g), true, `Expected "${g}" to be noise`);
      assert.equal(classifyMemoryNoise(`${g}.`), true, `Expected "${g}." to be noise`);
    }
  });

  it("NEVER classifies substantive preferences, facts, or instructions as noise", () => {
    const substantive = [
      "User prefers dark mode",
      "Deploy to prod on Tuesdays only",
      "Always use TypeScript for new services",
      "Dan's birthday is June 5",
      "Call me Dan",
      "Client requested a 20% discount on renewal",
      "Auth token expires in 1 hour",
      "Postgres connection pooling maxConnections is 5",
      "API keys are stored in HashiCorp Vault",
      "Never use floating point numbers for financial amounts",
      "Customer contact email is ops@example.com",
    ];

    for (const s of substantive) {
      assert.equal(classifyMemoryNoise(s), false, `Substantive text "${s}" must not be noise`);
      const detailed = classifyMemoryNoiseDetailed(s);
      assert.equal(detailed.isNoise, false);
      assert.equal(detailed.reason, undefined);
    }
  });
});

describe("detectSensitiveFamilies unit tests", () => {
  it("detects sensitive patterns across all supported regex families without leaking matched text", () => {
    // 1. Private key header
    const privKey = detectSensitiveFamilies("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...");
    assert.equal(privKey.isSensitive, true);
    assert.equal(privKey.matches.privateKey, true);
    assert.equal(privKey.matches.apiKey, false);

    // 2. Bearer token
    const bearer = detectSensitiveFamilies("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz1234567890abcdef");
    assert.equal(bearer.isSensitive, true);
    assert.equal(bearer.matches.bearerToken, true);

    // 3. API key (OpenAI sk- / GitHub ghp_)
    const apiKey1 = detectSensitiveFamilies("API key is sk-1234567890abcdef1234567890abcdef for project");
    assert.equal(apiKey1.isSensitive, true);
    assert.equal(apiKey1.matches.apiKey, true);

    const apiKey2 = detectSensitiveFamilies("Use token ghp_abcdef1234567890abcdef1234567890 to pull");
    assert.equal(apiKey2.isSensitive, true);
    assert.equal(apiKey2.matches.apiKey, true);

    // 4. SSN
    const ssn = detectSensitiveFamilies("Applicant SSN is 123-45-6789 for tax forms");
    assert.equal(ssn.isSensitive, true);
    assert.equal(ssn.matches.ssn, true);

    // 5. Credit card
    const cc = detectSensitiveFamilies("Payment card 4111 2222 3333 4444 on file");
    assert.equal(cc.isSensitive, true);
    assert.equal(cc.matches.creditCard, true);

    // 6. Password assignment
    const pw = detectSensitiveFamilies("Temporary admin password: superSecretPassword123!");
    assert.equal(pw.isSensitive, true);
    assert.equal(pw.matches.passwordAssignment, true);
  });

  it("returns isSensitive false for clean memory text", () => {
    const clean = detectSensitiveFamilies("User prefers monospace font in the editor interface.");
    assert.equal(clean.isSensitive, false);
    for (const val of Object.values(clean.matches)) {
      assert.equal(val, false);
    }
  });
});

describe("estimateConversionBudget unit tests", () => {
  it("produces zero cost and zero time for zero rows", () => {
    const budget = estimateConversionBudget({
      totalRows: 0,
      noiseRows: 0,
      unroutableRows: 0,
      duplicateSurplusRows: 0,
      averageTextLength: 0,
    });

    assert.equal(budget.rowsToConvert, 0);
    assert.equal(budget.estimatedCostUsd.total, 0);
    assert.equal(budget.estimatedWallClock.seconds, 0);
    assert.equal(budget.estimatedWallClock.bottleneck, "none");
    assert.equal(budget.isEstimate, true);
  });

  it("subtraction formula correctly subtracts noise, unroutable, and duplicates", () => {
    const budget = estimateConversionBudget({
      totalRows: 1000,
      noiseRows: 100,
      unroutableRows: 150,
      duplicateSurplusRows: 50,
      averageTextLength: 120,
    });

    // 1000 - 100 - 150 - 50 = 700
    assert.equal(budget.rowsToConvert, 700);
    assert.equal(budget.subtractions.totalRows, 1000);
    assert.equal(budget.subtractions.noiseRows, 100);
    assert.equal(budget.subtractions.unroutableRows, 150);
    assert.equal(budget.subtractions.duplicateSurplusRows, 50);
  });

  it("exhibits cost monotonicity with increasing rows", () => {
    const b1 = estimateConversionBudget({
      totalRows: 500,
      noiseRows: 0,
      unroutableRows: 0,
      duplicateSurplusRows: 0,
      averageTextLength: 100,
    });

    const b2 = estimateConversionBudget({
      totalRows: 1000,
      noiseRows: 0,
      unroutableRows: 0,
      duplicateSurplusRows: 0,
      averageTextLength: 100,
    });

    assert.ok(b2.estimatedCostUsd.total > b1.estimatedCostUsd.total);
    assert.ok(b2.estimatedTokens.chatTotal > b1.estimatedTokens.chatTotal);
    assert.ok(b2.estimatedTokens.embeddingTotal > b1.estimatedTokens.embeddingTotal);
  });

  it("exhibits token and cost monotonicity with increasing text length", () => {
    const bShort = estimateConversionBudget({
      totalRows: 1000,
      noiseRows: 0,
      unroutableRows: 0,
      duplicateSurplusRows: 0,
      averageTextLength: 50,
    });

    const bLong = estimateConversionBudget({
      totalRows: 1000,
      noiseRows: 0,
      unroutableRows: 0,
      duplicateSurplusRows: 0,
      averageTextLength: 800,
    });

    assert.ok(bLong.estimatedCostUsd.total > bShort.estimatedCostUsd.total);
    assert.ok(bLong.estimatedTokens.chatInput > bShort.estimatedTokens.chatInput);
  });

  it("correctly identifies RPM bottleneck vs TPM bottleneck boundary cases", () => {
    const bNormal = estimateConversionBudget({
      totalRows: 1000,
      noiseRows: 0,
      unroutableRows: 0,
      duplicateSurplusRows: 0,
      averageTextLength: 100,
    });

    assert.equal(bNormal.estimatedWallClock.bottleneck, "tpm");
    assert.ok(bNormal.estimatedWallClock.tpmDurationSeconds >= bNormal.estimatedWallClock.rpmDurationSeconds);
    assert.equal(
      bNormal.estimatedWallClock.seconds,
      Math.ceil(Math.max(bNormal.estimatedWallClock.rpmDurationSeconds, bNormal.estimatedWallClock.tpmDurationSeconds)),
    );
  });

  it("formats human duration string properly", () => {
    assert.equal(formatDurationHuman(0), "0s");
    assert.equal(formatDurationHuman(45), "45s");
    assert.equal(formatDurationHuman(60), "1m");
    assert.equal(formatDurationHuman(125), "2m 5s");
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

    // Rejects values starting with -
    assert.equal(parseFlagValue("--table", ["--table", "-v"]), null);
    assert.equal(parseFlagValue("--table", ["--table", "--flag"]), null);
    assert.equal(parseFlagValue("--table", ["--table=-x"]), null);

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

    // Subcommands: sweep, flip, drain, prune, rollback, recover, status reject with not implemented yet
    let stderrLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      stderrLogged += `${msg}\n`;
    };

    try {
      const exitSweep = await runMemoryUpgradeCli(["node", "memory-upgrade.ts", "sweep"]);
      assert.equal(exitSweep, 1);
      assert.ok(stderrLogged.includes("Subcommand 'sweep' is not implemented yet."));

      stderrLogged = "";
      const exitStatus = await runMemoryUpgradeCli(["node", "memory-upgrade.ts", "status"]);
      assert.equal(exitStatus, 1);
      assert.ok(stderrLogged.includes("Subcommand 'status' is not implemented yet."));

      stderrLogged = "";
      const exitUnknown = await runMemoryUpgradeCli(["node", "memory-upgrade.ts", "bogus"]);
      assert.equal(exitUnknown, 1);
      assert.ok(stderrLogged.includes("Unknown subcommand 'bogus'"));
    } finally {
      console.error = origError;
    }
  });
});

describe("census integration tests against embedded Postgres fixture", () => {
  it("enforces strict privilege preflight on tenant and control-plane connections", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_privileges");
    const adminDb = createDb(fixture.connectionString);

    try {
      await adminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await adminDb.execute(sql`
        CREATE TABLE mem0_memories (
          id TEXT PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);

      // 1. Direct superuser rejected on tenant (default 'postgres' role)
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: fixture.connectionString,
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "SUPERUSER_REJECTED");
          assert.ok(err.message.includes("is a superuser"));
          return true;
        },
      );

      // Create regular unprivileged tenant role for testing control plane rejection
      await adminDb.execute(sql`CREATE ROLE tenant_ok WITH LOGIN PASSWORD 'pass' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_ok;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_ok;`);

      const tenantOkUrl = new URL(fixture.connectionString);
      tenantOkUrl.username = "tenant_ok";
      tenantOkUrl.password = "pass";

      // 2. Direct superuser rejected on control plane
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantOkUrl.toString(),
            controlPlaneUrl: fixture.connectionString, // superuser CP connection
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "SUPERUSER_REJECTED");
          assert.ok(err.message.includes("control-plane database is a superuser"));
          return true;
        },
      );

      // 3. Direct BYPASSRLS rejected
      await adminDb.execute(sql`CREATE ROLE tenant_bypass WITH LOGIN PASSWORD 'pass' NOSUPERUSER BYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_bypass;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_bypass;`);

      const tenantBypassUrl = new URL(fixture.connectionString);
      tenantBypassUrl.username = "tenant_bypass";
      tenantBypassUrl.password = "pass";

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantBypassUrl.toString(),
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "BYPASSRLS_REJECTED");
          return true;
        },
      );

      // 4. Inherited superuser via GRANT rejected
      await adminDb.execute(sql`CREATE ROLE admin_group WITH SUPERUSER;`);
      await adminDb.execute(sql`CREATE ROLE tenant_inherited WITH LOGIN PASSWORD 'pass' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT admin_group TO tenant_inherited;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_inherited;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_inherited;`);

      const tenantInheritedUrl = new URL(fixture.connectionString);
      tenantInheritedUrl.username = "tenant_inherited";
      tenantInheritedUrl.password = "pass";

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantInheritedUrl.toString(),
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "SUPERUSER_REJECTED");
          assert.ok(err.message.includes("admin_group"));
          return true;
        },
      );

      // 5. NOINHERIT BYPASSRLS membership variant rejected
      await adminDb.execute(sql`CREATE ROLE sec_group WITH BYPASSRLS;`);
      await adminDb.execute(sql`CREATE ROLE tenant_noinherit WITH LOGIN PASSWORD 'pass' NOSUPERUSER NOBYPASSRLS NOINHERIT;`);
      await adminDb.execute(sql`GRANT sec_group TO tenant_noinherit;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_noinherit;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_noinherit;`);

      const tenantNoinheritUrl = new URL(fixture.connectionString);
      tenantNoinheritUrl.username = "tenant_noinherit";
      tenantNoinheritUrl.password = "pass";

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantNoinheritUrl.toString(),
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: any) => {
          assert.equal(err.code, "BYPASSRLS_REJECTED");
          assert.ok(err.message.includes("sec_group"));
          return true;
        },
      );

      // 6. Plain group passes preflight check without false positive (negative control)
      await adminDb.execute(sql`CREATE ROLE plain_group;`);
      await adminDb.execute(sql`CREATE ROLE tenant_plain WITH LOGIN PASSWORD 'pass' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT plain_group TO tenant_plain;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_plain;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_plain;`);

      const tenantPlainUrl = new URL(fixture.connectionString);
      tenantPlainUrl.username = "tenant_plain";
      tenantPlainUrl.password = "pass";

      const plainReport = await runCensus({
        databaseUrl: tenantPlainUrl.toString(),
        companyId: "00000000-0000-4000-8000-000000000001",
      });
      assert.ok(plainReport.readOnly);
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("rejects table with missing expected columns and invalid embedding dimensions", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_schema_check");
    const adminDb = createDb(fixture.connectionString);

    try {
      // Create non-superuser tenant role
      await adminDb.execute(sql`CREATE ROLE tenant_checker WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_checker;`);

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      // 1. Missing payload column
      await adminDb.execute(sql`
        CREATE TABLE bad_table_1 (
          id TEXT PRIMARY KEY,
          vector TEXT
        );
      `);
      await adminDb.execute(sql`GRANT SELECT ON bad_table_1 TO tenant_checker;`);

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            tableName: "bad_table_1",
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: Error) => {
          assert.ok(err.message.includes('missing required "payload" column'));
          return true;
        },
      );

      // 2. Invalid embedding dimensions (e.g. 768 instead of 1536)
      await adminDb.execute(sql`
        CREATE DOMAIN "vector(768)" AS text;
        CREATE TABLE bad_table_2 (
          id TEXT PRIMARY KEY,
          vector "vector(768)",
          payload JSONB NOT NULL
        );
      `);
      await adminDb.execute(sql`GRANT SELECT ON bad_table_2 TO tenant_checker;`);

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            tableName: "bad_table_2",
            companyId: "00000000-0000-4000-8000-000000000001",
          }),
        (err: Error) => {
          assert.ok(err.message.includes("Invalid embedding dimensions for Mem0 table"));
          assert.ok(err.message.includes("expected 1536, found 768"));
          return true;
        },
      );
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("enforces read-only transaction mode and rejects write attempts inside census transaction", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_read_only");
    const adminDb = createDb(fixture.connectionString);

    try {
      await adminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await adminDb.execute(sql`
        CREATE TABLE mem0_memories (
          id TEXT PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);
      await adminDb.execute(sql`CREATE ROLE tenant_ro WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_ro;`);
      await adminDb.execute(sql`GRANT ALL PRIVILEGES ON mem0_memories TO tenant_ro;`);

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_ro";
      tenantUrl.password = "pass123";

      // Attempt write inside census transaction hook
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            tableName: "mem0_memories",
            companyId: "00000000-0000-4000-8000-000000000001",
            onTransaction: async (tx) => {
              // Verify transaction isolation settings are applied by drizzle transaction config
              const settings = (await tx.execute<{ iso: string; ro: string }>(sql`
                SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro;
              `)) as unknown as Array<{ iso: string; ro: string }>;
              assert.equal(settings[0].iso, "repeatable read");
              assert.equal(settings[0].ro, "on");

              // Attempt mutation inside read-only transaction
              await tx.execute(sql`
                INSERT INTO mem0_memories (id, vector, payload)
                VALUES ('fail-row', '[]', '{}'::jsonb);
              `);
            },
          }),
        (err: any) => {
          // PostgreSQL error 25006: read_only_sql_transaction
          assert.ok(
            err.message?.includes("read-only transaction") ||
            err.cause?.message?.includes("read-only transaction") ||
            err.cause?.code === "25006" ||
            err.code === "25006",
          );
          return true;
        },
      );
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("preserves snapshot consistency during concurrent write from separate connection", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_concurrent_snapshot");
    const adminDb = createDb(fixture.connectionString);

    try {
      await adminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await adminDb.execute(sql`
        CREATE TABLE mem0_memories (
          id TEXT PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);
      await adminDb.execute(sql`CREATE ROLE tenant_checker WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await adminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_checker;`);
      await adminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_checker;`);

      // Seed initial 2 rows
      await adminDb.execute(sql`
        INSERT INTO mem0_memories (id, vector, payload) VALUES
        ('row-1', '[]', '{"agent_id": "11111111-1111-4111-8111-111111111111", "data": "initial 1"}'::jsonb),
        ('row-2', '[]', '{"agent_id": "11111111-1111-4111-8111-111111111111", "data": "initial 2"}'::jsonb);
      `);

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      // During onTransaction hook, insert a 3rd row from adminDb (separate connection/transaction)
      const report = await runCensus({
        databaseUrl: tenantUrl.toString(),
        tableName: "mem0_memories",
        companyId: "00000000-0000-4000-8000-000000000001",
        onTransaction: async () => {
          await adminDb.execute(sql`
            INSERT INTO mem0_memories (id, vector, payload)
            VALUES ('row-3', '[]', '{"agent_id": "11111111-1111-4111-8111-111111111111", "data": "concurrent 3"}'::jsonb);
          `);
        },
      });

      // Repeatable read snapshot guarantees that census observes only the initial 2 rows
      assert.equal(report.shapeIntrospection.rowCount, 2);
      assert.equal(report.census.totalRows, 2);
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("enforces fail-closed company-to-DSN binding and error codes", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const tenantFixture = await startEmbeddedPostgresTestDatabase("test_census_binding_tenant");
    const cpFixture = await startEmbeddedPostgresTestDatabase("test_census_binding_cp");

    const tenantAdminDb = createDb(tenantFixture.connectionString);
    const cpAdminDb = createDb(cpFixture.connectionString);

    const companyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const companyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    try {
      await tenantAdminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await tenantAdminDb.execute(sql`
        CREATE TABLE mem0_memories (
          id TEXT PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);
      await tenantAdminDb.execute(sql`CREATE ROLE tenant_role WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
      await tenantAdminDb.execute(sql`GRANT USAGE ON SCHEMA public TO tenant_role;`);
      await tenantAdminDb.execute(sql`GRANT SELECT ON mem0_memories TO tenant_role;`);

      await cpAdminDb.execute(sql`CREATE ROLE cp_reader WITH LOGIN PASSWORD 'cp_pass' NOSUPERUSER NOBYPASSRLS;`);
      await cpAdminDb.execute(sql`GRANT USAGE ON SCHEMA public TO cp_reader;`);
      await cpAdminDb.execute(sql`GRANT SELECT ON companies, agents, company_memory_databases TO cp_reader;`);

      await cpAdminDb.execute(sql`
        INSERT INTO companies (id, name, issue_prefix) VALUES (${companyA}::uuid, 'Company A', 'COMA');
      `);

      const parsedTenantUrl = new URL(tenantFixture.connectionString);
      const tenantDbName = parsedTenantUrl.pathname.replace(/^\//, "");

      const tenantUserUrl = new URL(tenantFixture.connectionString);
      tenantUserUrl.username = "tenant_role";
      tenantUserUrl.password = "pass123";

      const cpUserUrl = new URL(cpFixture.connectionString);
      cpUserUrl.username = "cp_reader";
      cpUserUrl.password = "cp_pass";

      // 1. Invalid UUID for --company throws INVALID_ARGUMENT
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUserUrl.toString(),
            companyId: "invalid-uuid-string",
          }),
        (err: any) => {
          assert.equal(err.code, "INVALID_ARGUMENT");
          assert.ok(err.message.includes("Must be a valid UUID"));
          return true;
        },
      );

      // 2. TABLE_NOT_FOUND when target table does not exist
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUserUrl.toString(),
            tableName: "non_existent_table",
            companyId: companyA,
          }),
        (err: any) => {
          assert.equal(err.code, "TABLE_NOT_FOUND");
          return true;
        },
      );

      // 3. COMPANY_NOT_FOUND when company does not exist in control plane
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUserUrl.toString(),
            controlPlaneUrl: cpUserUrl.toString(),
            companyId: companyB, // not in companies table
          }),
        (err: any) => {
          assert.equal(err.code, "COMPANY_NOT_FOUND");
          return true;
        },
      );

      // 4. COMPANY_BINDING_MISMATCH when company_memory_databases has no record for companyA
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUserUrl.toString(),
            controlPlaneUrl: cpUserUrl.toString(),
            companyId: companyA,
          }),
        (err: any) => {
          assert.equal(err.code, "COMPANY_BINDING_MISMATCH");
          assert.ok(err.message.includes("No company_memory_databases record found"));
          return true;
        },
      );

      // 5. COMPANY_BINDING_MISMATCH when control plane record specifies wrong database_name or database_role
      await cpAdminDb.execute(sql`
        INSERT INTO company_memory_databases (company_id, database_name, database_role, host, status)
        VALUES (${companyA}::uuid, 'other_db_name', 'tenant_role', '127.0.0.1', 'ready');
      `);

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUserUrl.toString(),
            controlPlaneUrl: cpUserUrl.toString(),
            companyId: companyA,
          }),
        (err: any) => {
          assert.equal(err.code, "COMPANY_BINDING_MISMATCH");
          assert.ok(err.message.includes("binding mismatch"));
          return true;
        },
      );

      // Fix control plane record to match tenantDbName and tenant_role
      await cpAdminDb.execute(sql`
        UPDATE company_memory_databases
        SET database_name = ${tenantDbName}, database_role = 'tenant_role'
        WHERE company_id = ${companyA}::uuid;
      `);

      // 6. Successful inference via company_memory_databases when --company is omitted
      const inferredReport = await runCensus({
        databaseUrl: tenantUserUrl.toString(),
        controlPlaneUrl: cpUserUrl.toString(),
      });
      assert.equal(inferredReport.company.id, companyA);
      assert.equal(inferredReport.company.verification, "control-plane-verified");

      // 7. Inference fails with COMPANY_BINDING_MISMATCH if database_role does not match currentUser
      await cpAdminDb.execute(sql`
        UPDATE company_memory_databases
        SET database_role = 'mismatched_role'
        WHERE company_id = ${companyA}::uuid;
      `);

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUserUrl.toString(),
            controlPlaneUrl: cpUserUrl.toString(),
          }),
        (err: any) => {
          assert.equal(err.code, "COMPANY_BINDING_MISMATCH");
          assert.ok(err.message.includes("specifies role \"mismatched_role\""));
          return true;
        },
      );
    } finally {
      await tenantAdminDb.$client.end({ timeout: 1 });
      await cpAdminDb.$client.end({ timeout: 1 });
      await tenantFixture.cleanup();
      await cpFixture.cleanup();
    }
  });

  it("accurately reports all census counts, routing readiness, budget, and contains NO memory text in output", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    // Tenant database fixture
    const tenantFixture = await startEmbeddedPostgresTestDatabase("test_census_tenant");
    // Control plane database fixture
    const cpFixture = await startEmbeddedPostgresTestDatabase("test_census_cp");

    const tenantAdminDb = createDb(tenantFixture.connectionString);
    const cpAdminDb = createDb(cpFixture.connectionString);

    const testCompanyId = "11111111-1111-4111-8111-111111111111";
    const routableHermesAgentId = "22222222-2222-4222-8222-222222222222";
    const pausedHermesAgentId = "33333333-3333-4333-8333-333333333333";
    const terminatedHermesAgentId = "44444444-4444-4444-8444-444444444444";
    const nonHermesAgentId = "55555555-5555-4555-8555-555555555555";
    const unknownAgentId = "66666666-6666-4666-8666-666666666666";
    const hermesGatewayAgentId = "77777777-7777-4777-8777-777777777777";
    const pendingApprovalHermesAgentId = "88888888-8888-4888-8888-888888888888";

    try {
      // 1. Seed Control Plane fixture tables (companies, agents, company_memory_databases are migrated)
      await cpAdminDb.execute(sql`
        INSERT INTO companies (id, name, issue_prefix) VALUES (${testCompanyId}::uuid, 'Acme Test Corp', 'ACME');
      `);

      await cpAdminDb.execute(sql`
        INSERT INTO agents (id, company_id, name, adapter_type, status, paused_at) VALUES
        (${routableHermesAgentId}::uuid, ${testCompanyId}::uuid, 'Hermes Worker 1', 'hermes_local', 'idle', NULL),
        (${pausedHermesAgentId}::uuid, ${testCompanyId}::uuid, 'Hermes Paused', 'hermes_local', 'paused', now()),
        (${terminatedHermesAgentId}::uuid, ${testCompanyId}::uuid, 'Hermes Fired', 'hermes_local', 'terminated', NULL),
        (${nonHermesAgentId}::uuid, ${testCompanyId}::uuid, 'Claude Process', 'claude_local', 'idle', NULL),
        (${hermesGatewayAgentId}::uuid, ${testCompanyId}::uuid, 'Hermes Gateway Agent', 'hermes_gateway', 'idle', NULL),
        (${pendingApprovalHermesAgentId}::uuid, ${testCompanyId}::uuid, 'Hermes Pending Approval', 'hermes_local', 'pending_approval', NULL);
      `);

      // Extract tenant db name from fixture connection string
      const parsedTenantUrl = new URL(tenantFixture.connectionString);
      const tenantDbName = parsedTenantUrl.pathname.replace(/^\//, "");

      await cpAdminDb.execute(sql`
        INSERT INTO company_memory_databases (company_id, database_name, database_role, host, status)
        VALUES (${testCompanyId}::uuid, ${tenantDbName}, 'pcmem_tenant_role', '127.0.0.1', 'ready');
      `);

      // Create dedicated non-superuser role for control plane preflight
      await cpAdminDb.execute(sql`CREATE ROLE cp_reader WITH LOGIN PASSWORD 'cp_pw_secret' NOSUPERUSER NOBYPASSRLS;`);
      await cpAdminDb.execute(sql`GRANT USAGE ON SCHEMA public TO cp_reader;`);
      await cpAdminDb.execute(sql`GRANT SELECT ON companies, agents, company_memory_databases TO cp_reader;`);

      const cpUserUrl = new URL(cpFixture.connectionString);
      cpUserUrl.username = "cp_reader";
      cpUserUrl.password = "cp_pw_secret";
      const cpDsn = cpUserUrl.toString();

      // 2. Setup Tenant Database
      await tenantAdminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await tenantAdminDb.execute(sql`
        CREATE TABLE mem0_memories (
          id TEXT PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);

      // Create non-superuser tenant role
      await tenantAdminDb.execute(sql`CREATE ROLE pcmem_tenant_role WITH LOGIN PASSWORD 'tenant_pw_secret' NOSUPERUSER NOBYPASSRLS;`);
      await tenantAdminDb.execute(sql`GRANT USAGE ON SCHEMA public TO pcmem_tenant_role;`);
      await tenantAdminDb.execute(sql`GRANT SELECT ON mem0_memories TO pcmem_tenant_role;`);

      // Long text row (> 500 chars)
      const longText = "This is a detailed and extensive memory specification regarding infrastructure configuration. ".repeat(6);
      assert.ok(longText.length > 500);

      // Seed realistic dataset in tenant database
      await tenantAdminDb.execute(sql`
        INSERT INTO mem0_memories (id, vector, payload) VALUES
        ('mem-01', '[]', ${JSON.stringify({
          agent_id: routableHermesAgentId,
          user_id: "user-01",
          data: "User preferences: always format code using prettier with 2-space indentation.",
          created_at: "2026-10-15T12:00:00.000Z",
        })}::jsonb),
        ('mem-02', '[]', ${JSON.stringify({
          agent_id: routableHermesAgentId,
          user_id: "user-01",
          data: "  user preferences: always format code using prettier with 2-space indentation.  ",
          created_at: "2026-10-16T14:00:00.000Z",
        })}::jsonb),
        ('mem-03', '[]', ${JSON.stringify({
          agent_id: routableHermesAgentId,
          user_id: "user-02",
          data: "Staging environment OpenAI credential is sk-1234567890abcdef1234567890abcdef for testing.",
          created_at: "2026-11-01T09:00:00.000Z",
        })}::jsonb),
        ('mem-04', '[]', ${JSON.stringify({
          agent_id: routableHermesAgentId,
          user_id: "user-02",
          data: longText,
          created_at: "2026-11-02T10:00:00.000Z",
        })}::jsonb),
        ('mem-05', '[]', ${JSON.stringify({
          agent_id: pausedHermesAgentId,
          user_id: "user-01",
          data: "Architecture note: backend service listens on internal port 8080.",
          created_at: "2026-11-03T11:00:00.000Z",
        })}::jsonb),
        ('mem-06', '[]', ${JSON.stringify({
          agent_id: terminatedHermesAgentId,
          user_id: "user-03",
          data: "Legacy deployment note from retired worker.",
          created_at: "2026-09-01T08:00:00.000Z",
        })}::jsonb),
        ('mem-07', '[]', ${JSON.stringify({
          agent_id: nonHermesAgentId,
          user_id: "user-03",
          data: "Claude agent conversation memory row.",
          created_at: "2026-09-10T15:00:00.000Z",
        })}::jsonb),
        ('mem-08', '[]', ${JSON.stringify({
          agent_id: unknownAgentId,
          user_id: "user-04",
          data: "Memory from agent that does not exist in Acme Corp.",
          created_at: "2026-08-20T16:00:00.000Z",
        })}::jsonb),
        ('mem-09', '[]', ${JSON.stringify({
          agent_id: "malformed-agent-id-123",
          user_id: "user-04",
          data: "Agent ID is not a valid UUID format.",
          created_at: "2026-08-21T17:00:00.000Z",
        })}::jsonb),
        ('mem-10', '[]', ${JSON.stringify({
          agent_id: null,
          user_id: "user-04",
          data: "Agent ID was left completely empty in legacy ingestion.",
          created_at: "invalid-timestamp-value",
        })}::jsonb),
        ('mem-11', '[]', ${JSON.stringify({
          agent_id: routableHermesAgentId,
          user_id: "user-01",
          data: "test",
          created_at: "2026-11-04T18:00:00.000Z",
        })}::jsonb),
        ('mem-12', '[]', ${JSON.stringify({
          agent_id: routableHermesAgentId,
          user_id: "user-01",
          data: "hello world!",
          created_at: "2026-11-05T19:00:00.000Z",
        })}::jsonb),
        ('mem-13', '[]', ${JSON.stringify({
          agent_id: hermesGatewayAgentId,
          user_id: "user-05",
          data: "Hermes gateway adapter memory row.",
          created_at: "2026-11-06T20:00:00.000Z",
        })}::jsonb),
        ('mem-14', '[]', ${JSON.stringify({
          agent_id: pendingApprovalHermesAgentId,
          user_id: "user-05",
          data: "Pending approval agent memory row.",
          created_at: "2026-11-07T21:00:00.000Z",
        })}::jsonb);
      `);

      const tenantUserUrl = new URL(tenantFixture.connectionString);
      tenantUserUrl.username = "pcmem_tenant_role";
      tenantUserUrl.password = "tenant_pw_secret";
      const tenantDsn = tenantUserUrl.toString();

      const tmpOutPath = path.join(
        os.tmpdir(),
        `census-report-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );

      // 3. Execute runCensus with control plane URL
      const report = await runCensus({
        databaseUrl: tenantDsn,
        controlPlaneUrl: cpDsn,
        companyId: testCompanyId,
        outputPath: tmpOutPath,
        format: "json",
      });

      // 4. Verify shape introspection
      assert.equal(report.shapeIntrospection.table, "mem0_memories");
      assert.equal(report.shapeIntrospection.embeddingDims, 1536);
      assert.equal(report.shapeIntrospection.payloadType, "jsonb");
      assert.equal(report.shapeIntrospection.rowCount, 14);

      // 5. Verify aggregates & counts
      assert.equal(report.census.totalRows, 14);
      assert.equal(report.census.distinctUserIds, 5); // user-01, user-02, user-03, user-04, user-05

      // Hygiene counts
      assert.equal(report.census.agentIdHygiene.missingOrBlankCount, 1); // mem-10
      assert.equal(report.census.agentIdHygiene.nonUuidCount, 1); // mem-09
      assert.equal(report.census.agentIdHygiene.totalMalformedOrMissingCount, 2);

      // Monthly histogram
      assert.equal(report.census.createdAtHistogram["2026-08"], 2); // mem-08, mem-09
      assert.equal(report.census.createdAtHistogram["2026-09"], 2); // mem-06, mem-07
      assert.equal(report.census.createdAtHistogram["2026-10"], 2); // mem-01, mem-02
      assert.equal(report.census.createdAtHistogram["2026-11"], 7); // mem-03, mem-04, mem-05, mem-11, mem-12, mem-13, mem-14
      assert.equal(report.census.createdAtHistogram["unparseable"], 1); // mem-10

      // Length statistics
      assert.ok(report.census.contentLength.average > 0);
      assert.ok(report.census.contentLength.median > 0);
      assert.ok(report.census.contentLength.p95 > 0);
      assert.equal(report.census.contentLength.longerThanThresholdCount, 1); // mem-04

      // Quality & Noise signals
      // Noise candidates: mem-11 ("test"), mem-12 ("hello world!") -> 2 rows
      assert.equal(report.census.noise.candidateCount, 2);

      // Duplicate content: mem-01 and mem-02 have identical normalized text for routableHermesAgentId
      assert.equal(report.census.duplicates.duplicateGroups, 1);
      assert.equal(report.census.duplicates.surplusRows, 1);

      // Sensitive candidate: mem-03 has API key (sk-...)
      assert.equal(report.census.sensitive.candidateCount, 1);
      assert.equal(report.census.sensitive.familyBreakdown.apiKey, 1);

      // 6. Routing readiness verification
      assert.equal(report.routing.status, "verified");
      assert.equal(report.company.verification, "control-plane-verified");
      assert.equal(report.routing.counts.agents.routable, 1); // routableHermesAgentId
      assert.equal(report.routing.counts.agents.routable_but_paused, 1); // pausedHermesAgentId
      // Unroutable agents: terminated (mem-06), non-hermes (mem-07), unknown (mem-08), malformed (mem-09), missing (mem-10), hermesGateway (mem-13), pendingApproval (mem-14) -> 7
      assert.equal(report.routing.counts.agents.unroutable, 7);

      // Rows by routing class:
      // Routable agent rows: mem-01, mem-02, mem-03, mem-04, mem-11, mem-12 -> 6 rows
      assert.equal(report.routing.counts.rows.routable, 6);
      // Paused agent rows: mem-05 -> 1 row
      assert.equal(report.routing.counts.rows.routable_but_paused, 1);
      // Unroutable rows: mem-06, mem-07, mem-08, mem-09, mem-10, mem-13, mem-14 -> 7 rows
      assert.equal(report.routing.counts.rows.unroutable, 7);

      // Unroutable agent IDs listed (ids only)
      assert.ok(report.routing.unroutableAgentIds.includes(terminatedHermesAgentId));
      assert.ok(report.routing.unroutableAgentIds.includes(nonHermesAgentId));
      assert.ok(report.routing.unroutableAgentIds.includes(unknownAgentId));
      assert.ok(report.routing.unroutableAgentIds.includes("malformed-agent-id-123"));
      assert.ok(report.routing.unroutableAgentIds.includes(hermesGatewayAgentId));
      assert.ok(report.routing.unroutableAgentIds.includes(pendingApprovalHermesAgentId));

      // 7. Budget estimate verification
      // rowsToConvert = total (14) - noise (2) - unroutable (7) - duplicates (1) = 4
      assert.equal(report.budget.rowsToConvert, 4);
      assert.ok(report.budget.estimatedCostUsd.total > 0);
      assert.ok(report.budget.estimatedWallClock.seconds > 0);

      // 8. CRITICAL: Zero Memory Text in Output Verification!
      const reportJsonStr = JSON.stringify(report);
      const textSummary = formatCensusTextReport(report);

      const sensitiveMemories = [
        "always format code using prettier",
        "sk-1234567890abcdef",
        "Legacy deployment note from retired worker",
        "Claude agent conversation memory",
        "Memory from agent that does not exist",
        "extensive memory specification",
      ];

      for (const phrase of sensitiveMemories) {
        assert.ok(
          !reportJsonStr.includes(phrase),
          `CRITICAL VIOLATION: Memory text "${phrase}" found in JSON report!`,
        );
        assert.ok(
          !textSummary.includes(phrase),
          `CRITICAL VIOLATION: Memory text "${phrase}" found in text summary!`,
        );
      }

      // 9. Output file verification: mode 0600 and exclusive create
      assert.ok(fs.existsSync(tmpOutPath));
      const stat = fs.statSync(tmpOutPath);
      assert.equal(stat.mode & 0o777, 0o600);

      // Writing again fails with EEXIST
      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantDsn,
            controlPlaneUrl: cpDsn,
            companyId: testCompanyId,
            outputPath: tmpOutPath,
            format: "json",
          }),
        (err: any) => err.code === "EEXIST",
      );

      fs.unlinkSync(tmpOutPath);

      // 10. Verification without control plane URL: requires company and marks unverified and unbound
      const unverifiedReport = await runCensus({
        databaseUrl: tenantDsn,
        companyId: testCompanyId,
      });

      assert.equal(unverifiedReport.routing.status, "unverified");
      assert.equal(unverifiedReport.company.verification, "unbound");
      assert.ok(unverifiedReport.routing.caveat?.includes("Control plane URL was not provided"));

      // Text summary loudly warns about unverified routing
      const unverifiedSummary = formatCensusTextReport(unverifiedReport);
      assert.ok(unverifiedSummary.includes("ROUTING UNVERIFIED"));
    } finally {
      await tenantAdminDb.$client.end({ timeout: 1 });
      await cpAdminDb.$client.end({ timeout: 1 });
      await tenantFixture.cleanup();
      await cpFixture.cleanup();
    }
  });
});
