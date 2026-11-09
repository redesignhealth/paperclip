/**
 * Hardening tests for memory upgrade sweep and census (TECH-8191 Argus R2).
 * Covers:
 * - Table-driven error code mapping and generic message sanitization
 * - Non-CompanyMemoryUpgradeError and malicious pg error scrubbing
 * - Numeric flag validation without echoing malicious values
 * - Comprehensive DSN scrubbing (unencoded @, +driver, empty user/query, password 'a')
 * - Existing output file preflight before mutations
 * - Multi-page text collections with uppercase, invalid interior page, and case collision
 * - Rejected worker runs no tenant DDL
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  main as runMemoryUpgradeCli,
  runCensusCli,
  runSweepCli,
  sanitizeCliErrorMessage,
  scrubDsnSecrets,
} from "../memory-upgrade.js";
import {
  CompanyMemoryUpgradeError,
  mapSweepErrorCode,
  SWEEP_ERROR_CODE_MAP,
  UPGRADE_ERROR_CODES,
} from "../../server/src/services/company-memory-upgrade/types.js";
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  ManualClock,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { eq } = require("drizzle-orm");

const support = await getEmbeddedPostgresTestSupport();

test("memory upgrade error sanitization and CLI hardening", async (t) => {
  // 1. Table-driven SWEEP_ERROR_CODE_MAP coverage
  await t.test("table-driven SWEEP_ERROR_CODE_MAP maps all keys to bounded UPGRADE_ERROR_CODES", () => {
    const validCodesSet = new Set<string>(UPGRADE_ERROR_CODES);

    for (const [key, mapped] of Object.entries(SWEEP_ERROR_CODE_MAP)) {
      assert.ok(
        validCodesSet.has(mapped),
        `Mapped value "${mapped}" for key "${key}" must be in UPGRADE_ERROR_CODES`,
      );
      assert.equal(
        mapSweepErrorCode(key),
        mapped,
        `mapSweepErrorCode("${key}") must resolve to "${mapped}"`,
      );
    }

    assert.equal(mapSweepErrorCode("NONEXISTENT_CODE"), "unexpected_failure");
    assert.equal(mapSweepErrorCode(null), "unexpected_failure");
    assert.equal(mapSweepErrorCode(undefined), "unexpected_failure");
  });

  // 2. Table-driven sanitizeCliErrorMessage coverage for census and sweep codes
  await t.test("sanitizeCliErrorMessage preserves bounded codes and fixed messages for census and sweep", () => {
    const requiredCodes = [
      "NOT_PGVECTOR",
      "SUPERUSER_REJECTED",
      "BYPASSRLS_REJECTED",
      "EXCESSIVE_PRIVILEGE_REJECTED",
      "TABLE_NOT_FOUND",
      "SCHEMA_MISMATCH",
      "EMBEDDING_DIMENSIONS_MISMATCH",
      "CONTROL_PLANE_ROUTING_MISMATCH",
      "CONTROL_PLANE_UNREACHABLE",
      "COMPANY_NOT_FOUND",
      "COMPANY_DELETION_IN_PROGRESS",
      "ACTIVE_UPGRADE_EXISTS",
      "UPGRADE_NOT_FOUND",
      "CONVERTER_CONTRACT_MISMATCH",
      "LEASE_FENCED_OUT",
      "LEASE_EXPIRED",
      "LEASE_LAPSED",
      "CAS_FAILED",
      "INVALID_RECOVERY",
      "INVALID_STATE",
      "ILLEGAL_TRANSITION",
      "ROLLBACK_REFUSED",
      "UNSUPPORTED_SOURCE_ID",
      "ACTIVE_RUN_TIMEOUT",
      "PAUSED_TOO_LONG",
      "DRAIN_TIMEOUT",
      "STAGING_WRITE_FAILED",
      "PUBLISH_FAILED",
      "VERIFICATION_FAILED",
      "UNEXPECTED_FAILURE",
      "SCHEMA_INIT_FAILED",
      "MIGRATION_FAILED",
      "SOURCE_READ_FAILED",
      "DATABASE_IDENTITY_UNAVAILABLE",
      "INVALID_DATABASE_URL",
    ];

    for (const code of requiredCodes) {
      const err = new CompanyMemoryUpgradeError("Sens1t1ve Internal Det41l", code);
      const sanitized = sanitizeCliErrorMessage(err);
      assert.ok(sanitized.startsWith(`[${code}]`), `Sanitized message must preserve machine code [${code}]`);
      assert.ok(!sanitized.includes("Sens1t1ve Internal Det41l"), `Must not echo raw error message for ${code}`);
    }
  });

  // 3. Non-CompanyMemoryUpgradeError paths return generic fixed message; malicious pg details absent
  await t.test("unknown and database driver errors return generic message without leaking details", () => {
    const maliciousDriverErrors = [
      new Error('relation "secret_table_leak" does not exist'),
      new Error('null value in column "company_secret" of relation "companies" violates not-null constraint (Key (id)=(secret_val))'),
      new Error('syntax error at or near "SELECT password FROM credentials"'),
      { code: "42P01", message: 'table "secret_schema.secret_table" does not exist' },
      { code: "28P01", message: 'password authentication failed for user "super_admin"' },
      "arbitrary raw string exception leaking secret",
      null,
      undefined,
    ];

    for (const err of maliciousDriverErrors) {
      const result = sanitizeCliErrorMessage(err);
      assert.equal(
        result,
        "[unexpected_failure] An unexpected error occurred during upgrade.",
      );
      assert.ok(!result.includes("secret"));
      assert.ok(!result.includes("password"));
      assert.ok(!result.includes("admin"));
    }
  });

  // 4. Numeric flag validation tests with malicious markers
  await t.test("numeric flags reject malicious arguments without echoing values (census and sweep)", async () => {
    const maliciousMarker = "MALICIOUS_INJECTION_TOKEN_12345";

    // Census --long-threshold
    let stderrLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      stderrLogged += `${msg}\n`;
    };

    try {
      stderrLogged = "";
      const exit1 = await runCensusCli([
        "--database-url", "postgres://usr:pw@localhost:5432/db",
        "--long-threshold", maliciousMarker,
      ]);
      assert.equal(exit1, 1);
      assert.ok(!stderrLogged.includes(maliciousMarker), "Census --long-threshold must not echo raw value");
      assert.ok(stderrLogged.includes("Invalid --long-threshold"));

      // Census --chat-input-usd-per-mtok
      stderrLogged = "";
      const exit2 = await runCensusCli([
        "--database-url", "postgres://usr:pw@localhost:5432/db",
        "--chat-input-usd-per-mtok", maliciousMarker,
      ]);
      assert.equal(exit2, 1);
      assert.ok(!stderrLogged.includes(maliciousMarker), "Census price flag must not echo raw value");

      // Sweep --page-size
      stderrLogged = "";
      const exit3 = await runSweepCli([
        "--database-url", "postgres://usr:pw@localhost:5432/db",
        "--control-plane-url", "postgres://usr:pw@localhost:5432/cpdb",
        "--company", "00000000-0000-4000-8000-000000000001",
        "--confirm", "00000000-0000-4000-8000-000000000001",
        "--page-size", maliciousMarker,
      ]);
      assert.equal(exit3, 1);
      assert.ok(!stderrLogged.includes(maliciousMarker), "Sweep --page-size must not echo raw value");

      // Sweep --max-rows
      stderrLogged = "";
      const exit4 = await runSweepCli([
        "--database-url", "postgres://usr:pw@localhost:5432/db",
        "--control-plane-url", "postgres://usr:pw@localhost:5432/cpdb",
        "--company", "00000000-0000-4000-8000-000000000001",
        "--confirm", "00000000-0000-4000-8000-000000000001",
        "--max-rows", maliciousMarker,
      ]);
      assert.equal(exit4, 1);
      assert.ok(!stderrLogged.includes(maliciousMarker), "Sweep --max-rows must not echo raw value");
    } finally {
      console.error = origError;
    }
  });

  // 5. Comprehensive DSN scrub tests
  await t.test("scrubDsnSecrets handles unencoded @, +driver, empty user/query, and short passwords", () => {
    // Unencoded @ in password
    const unencodedAt = "postgres://user:p@ss@word@dbhost:5432/mydb";
    const scrubbedUnencoded = scrubDsnSecrets(unencodedAt);
    assert.equal(scrubbedUnencoded, "postgres://user:***@dbhost:5432/mydb");
    assert.ok(!scrubbedUnencoded.includes("p@ss"));
    assert.ok(!scrubbedUnencoded.includes("word"));

    // URL-encoded @ in password
    const encodedAt = "postgres://user:p%40ss%40word@dbhost:5432/mydb";
    const scrubbedEncoded = scrubDsnSecrets(encodedAt);
    assert.equal(scrubbedEncoded, "postgres://user:***@dbhost:5432/mydb");

    // +driver schemes
    const driverSchemes = [
      "postgresql+asyncpg://admin:supersecret@localhost:5432/proddb",
      "postgres+psycopg2://admin:supersecret@localhost:5432/proddb",
      "postgresql+pg8000://admin:supersecret@localhost:5432/proddb",
    ];
    for (const dsn of driverSchemes) {
      const scrubbed = scrubDsnSecrets(dsn);
      assert.ok(!scrubbed.includes("supersecret"));
      assert.ok(scrubbed.includes(":***@"));
    }

    // Empty user
    const emptyUser = "postgres://:mysecret@localhost:5432/mydb";
    const scrubbedEmptyUser = scrubDsnSecrets(emptyUser);
    assert.equal(scrubbedEmptyUser, "postgres://:***@localhost:5432/mydb");

    // Empty query param password
    const emptyQueryParam = "postgres://localhost:5432/mydb?password=&sslmode=require";
    const scrubbedEmptyQuery = scrubDsnSecrets(emptyQueryParam);
    assert.equal(scrubbedEmptyQuery, "postgres://localhost:5432/mydb?password=***&sslmode=require");

    // Password 'a' does NOT corrupt diagnostic code text
    const singleCharPass = "[PROD_GUARD_ENFORCED] Target postgresql://app_user:a@localhost:5432/app_db failed admission";
    const scrubbedSingle = scrubDsnSecrets(singleCharPass);
    assert.equal(
      scrubbedSingle,
      "[PROD_GUARD_ENFORCED] Target postgresql://app_user:***@localhost:5432/app_db failed admission",
    );
    assert.ok(scrubbedSingle.includes("[PROD_GUARD_ENFORCED]"), "Code text must not be corrupted by short password 'a'");
  });
});

test("memory upgrade sweep database hardening integration", async (t) => {
  if (!support.supported) {
    handleEmbeddedPostgresUnsupported(t);
    return;
  }

  const cpDbInstance = await startEmbeddedPostgresTestDatabase("sweep-hard-cp-");
  const tenantDbInstance = await startEmbeddedPostgresTestDatabase("sweep-hard-tn-");

  const adminSql = openTenantClient(tenantDbInstance.connectionString);
  await adminSql.unsafe(`CREATE ROLE sweep_hard_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await adminSql.unsafe(`GRANT ALL ON SCHEMA public TO sweep_hard_tenant;`);
  await adminSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO sweep_hard_tenant;`);
  await adminSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sweep_hard_tenant;`);

  const tenantWorkerUrl = new URL(tenantDbInstance.connectionString);
  tenantWorkerUrl.username = "sweep_hard_tenant";
  tenantWorkerUrl.password = "pass123";
  const tenantSql = openTenantClient(tenantWorkerUrl.toString());

  const cpAdminSql = openTenantClient(cpDbInstance.connectionString);
  await cpAdminSql.unsafe(`CREATE ROLE sweep_hard_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await cpAdminSql.unsafe(`GRANT ALL ON SCHEMA public TO sweep_hard_cp;`);
  await cpAdminSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO sweep_hard_cp;`);
  await cpAdminSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sweep_hard_cp;`);

  const cpWorkerUrl = new URL(cpDbInstance.connectionString);
  cpWorkerUrl.username = "sweep_hard_cp";
  cpWorkerUrl.password = "pass123";
  const cpDb = createDb(cpWorkerUrl.toString());

  t.after(async () => {
    await tenantSql.end({ timeout: 1 }).catch(() => {});
    await adminSql.end({ timeout: 1 }).catch(() => {});
    await cpAdminSql.end({ timeout: 1 }).catch(() => {});
    await cpDb.$client.end({ timeout: 1 }).catch(() => {});
    await cpDbInstance.cleanup();
    await tenantDbInstance.cleanup();
  });

  // 6. Preflight existing output file: no ledger or control plane mutations
  await t.test("preflights existing output file BEFORE mutations: EEXIST causes zero writes", async () => {
    const [comp] = await cpDb.insert(companies).values({ name: "Output EEXIST Co", issuePrefix: "OE" }).returning();
    const dbName = `tn_${comp.id.slice(0, 8)}`;
    const role = `role_${comp.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp.id,
      databaseName: dbName,
      databaseRole: role,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sweep-eexist-"));
    const existingFile = path.join(tmpDir, "already-exists.json");
    fs.writeFileSync(existingFile, JSON.stringify({ pre_existing: true }));

    await assert.rejects(
      async () => {
        await runSweep(
          {
            databaseUrl: tenantWorkerUrl.toString(),
            controlPlaneUrl: cpWorkerUrl.toString(),
            companyId: comp.id,
            outputPath: existingFile,
          },
          {
            controlPlaneDb: cpDb,
            tenantSql,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbName, user: role },
          },
        );
      },
      (err: any) => {
        assert.equal(err.code, "EEXIST");
        return true;
      },
    );

    // Verify ZERO control plane upgrade records were created
    const upgrades = await cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, comp.id));
    assert.equal(upgrades.length, 0, "No upgrade records created on preflight EEXIST");

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 7. Rejected worker runs NO tenant DDL
  await t.test("rejected worker runs NO tenant DDL when admission refuses company", async () => {
    const [comp] = await cpDb
      .insert(companies)
      .values({
        name: "Deletion Bound Co",
        issuePrefix: "DB",
        deletionStartedAt: new Date(), // undergoing deletion!
      })
      .returning();

    const dbName = `tn_${comp.id.slice(0, 8)}`;
    const role = `role_${comp.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp.id,
      databaseName: dbName,
      databaseRole: role,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    // Ensure live collection exists, but upgrade tables do NOT exist
    await setupTenantMem0Table(adminSql, "mem0_memories");
    await adminSql.unsafe(`DROP TABLE IF EXISTS paperclip_memory_upgrade_ledger CASCADE;`);
    await adminSql.unsafe(`DROP TABLE IF EXISTS paperclip_memory_upgrade_staging CASCADE;`);
    await adminSql.unsafe(`DROP TABLE IF EXISTS paperclip_memory_upgrade_dedupe CASCADE;`);

    // Run sweep - should be rejected by admission
    await assert.rejects(
      async () => {
        await runSweep(
          {
            databaseUrl: tenantWorkerUrl.toString(),
            controlPlaneUrl: cpWorkerUrl.toString(),
            companyId: comp.id,
          },
          {
            controlPlaneDb: cpDb,
            tenantSql,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbName, user: role },
          },
        );
      },
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "COMPANY_DELETION_IN_PROGRESS");
        return true;
      },
    );

    // Assert that tenant DDL was NEVER executed
    const regclassCheck = await adminSql.unsafe(
      `SELECT to_regclass('paperclip_memory_upgrade_ledger')::text AS tbl;`,
    );
    assert.equal(regclassCheck[0]?.tbl, null, "Tenant upgrade tables must NOT be created by rejected worker");
  });

  // 8. Multi-page text collections with uppercase UUIDs, invalid interior page, and case collision
  await t.test("text collection rejects case collisions and invalid interior pages upfront", async () => {
    const [comp] = await cpDb.insert(companies).values({ name: "Text Validations Co", issuePrefix: "TV" }).returning();
    const dbName = `tn_${comp.id.slice(0, 8)}`;
    const role = `role_${comp.id.slice(0, 8)}`;
    await cpDb.insert(companyMemoryDatabases).values({
      companyId: comp.id,
      databaseName: dbName,
      databaseRole: role,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    await adminSql.unsafe(`
      DO $$ BEGIN
        CREATE DOMAIN "vector(1536)" AS text;
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    // Subtest A: Duplicate text IDs differing only in case are rejected
    await adminSql.unsafe(`DROP TABLE IF EXISTS mem0_case_collision;`);
    await adminSql.unsafe(`
      CREATE TABLE mem0_case_collision (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        vector "vector(1536)" NOT NULL
      );
    `);

    const sharedUuid = randomUUID().toLowerCase();
    await adminSql.unsafe(
      `INSERT INTO mem0_case_collision (id, payload, vector) VALUES ($1, '{"data":"row1"}', 'vec');`,
      [sharedUuid.toLowerCase()],
    );
    await adminSql.unsafe(
      `INSERT INTO mem0_case_collision (id, payload, vector) VALUES ($1, '{"data":"row2"}', 'vec');`,
      [sharedUuid.toUpperCase()],
    );

    await assert.rejects(
      async () => {
        await runSweep(
          {
            databaseUrl: tenantWorkerUrl.toString(),
            controlPlaneUrl: cpWorkerUrl.toString(),
            companyId: comp.id,
            tableName: "mem0_case_collision",
          },
          {
            controlPlaneDb: cpDb,
            tenantSql,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbName, user: role },
          },
        );
      },
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "UNSUPPORTED_SOURCE_ID");
        return true;
      },
    );

    // Subtest B: Multi-page text scan rejects invalid interior page ID before mutations
    await adminSql.unsafe(`DROP TABLE IF EXISTS mem0_invalid_interior;`);
    await adminSql.unsafe(`
      CREATE TABLE mem0_invalid_interior (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        vector "vector(1536)" NOT NULL
      );
    `);

    // Insert 4 valid UUIDs on page 1, and an invalid non-UUID string on page 2
    for (let i = 0; i < 4; i++) {
      await adminSql.unsafe(
        `INSERT INTO mem0_invalid_interior (id, payload, vector) VALUES ($1, '{"data":"page1"}', 'vec');`,
        [`00000000-0000-4000-8000-00000000000${i}`],
      );
    }
    await adminSql.unsafe(
      `INSERT INTO mem0_invalid_interior (id, payload, vector) VALUES ($1, '{"data":"page2"}', 'vec');`,
      ["invalid-interior-text-id"],
    );

    await assert.rejects(
      async () => {
        await runSweep(
          {
            databaseUrl: tenantWorkerUrl.toString(),
            controlPlaneUrl: cpWorkerUrl.toString(),
            companyId: comp.id,
            tableName: "mem0_invalid_interior",
            pageSize: 2,
          },
          {
            controlPlaneDb: cpDb,
            tenantSql,
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: dbName, user: role },
          },
        );
      },
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "UNSUPPORTED_SOURCE_ID");
        return true;
      },
    );
  });
});
