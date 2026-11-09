/**
 * CLI integration and validation tests for company memory upgrade sweep (TECH-8191).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ALLOWED_SWEEP_FLAGS,
  main as runMemoryUpgradeCli,
  runSweepCli,
  sanitizeCliErrorMessage,
  scrubDsnSecrets,
  validateNoUnknownFlags,
} from "../memory-upgrade.js";
import {
  agents,
  companies,
  companyMemoryDatabases,
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  ManualClock,
  setupTenantMem0Table,
  sql,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("sweep CLI validation and flags", async (t) => {
  await t.test("scrubDsnSecrets scrubs credentials from URLs", () => {
    const raw = "Connection failed to postgres://app_user:super_secret_password@db.internal.net:5432/db_prod";
    const scrubbed = scrubDsnSecrets(raw);
    assert.ok(!scrubbed.includes("super_secret_password"));
    assert.equal(scrubbed, "Connection failed to [REDACTED_DATABASE_URL]");

    // Empty username
    const emptyUser = "postgres://:secret_pass_123@localhost:5432/mydb";
    assert.ok(!scrubDsnSecrets(emptyUser).includes("secret_pass_123"));
    assert.equal(scrubDsnSecrets(emptyUser), "[REDACTED_DATABASE_URL]");

    // Password containing @ or special characters
    const passWithAt = "postgres://u:pass%40word123@localhost:5432/mydb";
    const scrubbedAt = scrubDsnSecrets(passWithAt);
    assert.ok(!scrubbedAt.includes("pass%40word123"));
    assert.ok(!scrubbedAt.includes("pass@word123"));
    assert.equal(scrubbedAt, "[REDACTED_DATABASE_URL]");

    // Query param password inside DSN candidate is whole-URL masked
    const queryPass = "postgres://u:pass1@localhost:5432/mydb?password=query_secret_456&ssl=true";
    const scrubbedQuery = scrubDsnSecrets(queryPass);
    assert.ok(!scrubbedQuery.includes("query_secret_456"));
    assert.ok(!scrubbedQuery.includes("pass1"));
    assert.equal(scrubbedQuery, "[REDACTED_DATABASE_URL]");

    // Standalone query param password
    const standaloneQuery = "Details: ?password=query_secret_456&ssl=true";
    const scrubbedStandalone = scrubDsnSecrets(standaloneQuery);
    assert.ok(!scrubbedStandalone.includes("query_secret_456"));
    assert.equal(scrubbedStandalone, "Details: ?password=***&ssl=true");
  });

  await t.test("--help works even with unexpected or unknown flags", async () => {
    let stdout = "";
    const origLog = console.log;
    console.log = (msg: string) => { stdout += `${msg}\n`; };
    try {
      const exitHelp = await runSweepCli(["--help", "--unknown-bogus-flag"]);
      assert.equal(exitHelp, 0);
      assert.ok(stdout.includes("Usage: pnpm memory:upgrade sweep"));

      stdout = "";
      const exitShortHelp = await runSweepCli(["-h", "--bad-flag=123"]);
      assert.equal(exitShortHelp, 0);
      assert.ok(stdout.includes("Usage: pnpm memory:upgrade sweep"));
    } finally {
      console.log = origLog;
    }
  });

  await t.test("--operator-label bounds and rejection without echoing value", async () => {
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };
    const markerBadLabel = "bad_label_with_forbidden_chars!#$%^&*()_+secret9988";
    const validUuid = randomUUID();
    const localDsn = "postgres://u:p@localhost:5432/db";

    try {
      const exit = await runSweepCli([
        "--database-url", localDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid,
        "--confirm", validUuid,
        "--operator-label", markerBadLabel,
      ]);
      assert.equal(exit, 1);
      assert.ok(stderr.includes("Invalid --operator-label"));
      assert.ok(!stderr.includes(markerBadLabel), "Never echo invalid operator label value");
    } finally {
      console.error = origError;
    }
  });

  await t.test("validateNoUnknownFlags rejects unexpected options for sweep", () => {
    assert.throws(
      () => validateNoUnknownFlags(["--chat-input-usd-per-mtok=1.5"], ALLOWED_SWEEP_FLAGS, "sweep"),
      (err: any) => {
        assert.equal(err.code, "INVALID_ARGUMENT");
        assert.ok(err.message.includes("Unknown option '--chat-input-usd-per-mtok'"));
        assert.ok(err.message.includes("Only sweep options are accepted"));
        return true;
      },
    );

    assert.throws(
      () => validateNoUnknownFlags(["--bogus-flag"], ALLOWED_SWEEP_FLAGS, "sweep"),
      (err: any) => {
        assert.equal(err.code, "INVALID_ARGUMENT");
        assert.ok(err.message.includes("Unknown option '--bogus-flag'"));
        return true;
      },
    );
  });

  await t.test("--confirm missing, mismatched, or invalid UUID rejects without echoing arg values", async () => {
    const validUuid1 = randomUUID();
    const validUuid2 = randomUUID();
    const secretUuid = "d734892c-secret-token-value-leaked";

    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };

    try {
      // 1. Missing --confirm
      stderr = "";
      const exit1 = await runSweepCli([
        "--database-url", "postgres://u:p@localhost:5432/db",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--company", validUuid1,
      ]);
      assert.equal(exit1, 1);
      assert.ok(stderr.includes("Error: Flag --confirm <uuid> is required for sweep."));

      // 2. Mismatched --confirm
      stderr = "";
      const exit2 = await runSweepCli([
        "--database-url", "postgres://u:p@localhost:5432/db",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--company", validUuid1,
        "--confirm", validUuid2,
      ]);
      assert.equal(exit2, 1);
      assert.ok(stderr.includes("Error: Flag --confirm <uuid> must strictly match --company <uuid>."));
      // NEVER echo the value of either argument
      assert.ok(!stderr.includes(validUuid1));
      assert.ok(!stderr.includes(validUuid2));

      // 3. Invalid UUID
      stderr = "";
      const exit3 = await runSweepCli([
        "--database-url", "postgres://u:p@localhost:5432/db",
        "--control-plane-url", "postgres://u:p@localhost:5432/cp",
        "--company", secretUuid,
        "--confirm", secretUuid,
      ]);
      assert.equal(exit3, 1);
      assert.ok(stderr.includes("Error: Flag --company must be a valid UUID."));
      assert.ok(!stderr.includes(secretUuid));
    } finally {
      console.error = origError;
    }
  });

  await t.test("prod gate enforces --prod and MEMORY_UPGRADE_ALLOW_PROD=1 on BOTH DSNs", async () => {
    const validUuid = randomUUID();
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };

    const remoteDsn = "postgres://app:secret123@rds.us-east-1.amazonaws.com:5432/tenant_db";
    const localDsn = "postgres://app:secret123@localhost:5432/cp_db";

    try {
      // Case A: Remote tenant DSN without flag or env
      stderr = "";
      const exitA = await runSweepCli([
        "--database-url", remoteDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid,
        "--confirm", validUuid,
      ], { env: {} });
      assert.equal(exitA, 1);
      assert.ok(stderr.includes("[PROD_GUARD_ENFORCED] Refusing to connect to non-local database target without production confirmation (--prod and MEMORY_UPGRADE_ALLOW_PROD=1)."));
      assert.ok(!stderr.includes("secret123")); // Password scrubbed
      assert.ok(!stderr.includes("rds.us-east-1.amazonaws.com")); // Downstream host not echoed

      // Case B: Remote tenant DSN with flag only
      stderr = "";
      const exitB = await runSweepCli([
        "--database-url", remoteDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid,
        "--confirm", validUuid,
        "--prod",
      ], { env: {} });
      assert.equal(exitB, 1);
      assert.ok(stderr.includes("[PROD_GUARD_ENFORCED] Refusing to connect to non-local database target without production confirmation (--prod and MEMORY_UPGRADE_ALLOW_PROD=1)."));
      assert.ok(!stderr.includes("secret123"));
      assert.ok(!stderr.includes("rds.us-east-1.amazonaws.com"));

      // Case C: Remote tenant DSN with env only
      stderr = "";
      const exitC = await runSweepCli([
        "--database-url", remoteDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid,
        "--confirm", validUuid,
      ], { env: { MEMORY_UPGRADE_ALLOW_PROD: "1" } });
      assert.equal(exitC, 1);
      assert.ok(stderr.includes("[PROD_GUARD_ENFORCED] Refusing to connect to non-local database target without production confirmation (--prod and MEMORY_UPGRADE_ALLOW_PROD=1)."));
      assert.ok(!stderr.includes("secret123"));
      assert.ok(!stderr.includes("rds.us-east-1.amazonaws.com"));

      // Case D: Remote control-plane DSN without flag or env
      stderr = "";
      const exitD = await runSweepCli([
        "--database-url", localDsn,
        "--control-plane-url", remoteDsn,
        "--company", validUuid,
        "--confirm", validUuid,
      ], { env: {} });
      assert.equal(exitD, 1);
      assert.ok(stderr.includes("[PROD_GUARD_ENFORCED] Refusing to connect to non-local database target without production confirmation (--prod and MEMORY_UPGRADE_ALLOW_PROD=1)."));
      assert.ok(!stderr.includes("secret123"));
      assert.ok(!stderr.includes("rds.us-east-1.amazonaws.com"));
    } finally {
      console.error = origError;
    }
  });

  await t.test("subcommand dispatch from main", async () => {
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };

    try {
      stderr = "";
      const exitNoArgs = await runMemoryUpgradeCli(["node", "memory-upgrade.ts"]);
      assert.equal(exitNoArgs, 1);
      assert.ok(stderr.includes("Available subcommands: census, sweep"));

      stderr = "";
      const exitSweepHelp = await runMemoryUpgradeCli(["node", "memory-upgrade.ts", "sweep", "--help"]);
      assert.equal(exitSweepHelp, 0);

      stderr = "";
      const exitUnknown = await runMemoryUpgradeCli(["node", "memory-upgrade.ts", "not-a-command"]);
      assert.equal(exitUnknown, 1);
      assert.ok(stderr.includes("Unknown subcommand 'not-a-command'."));
    } finally {
      console.error = origError;
    }
  });

  await t.test("secret markers in --format, --table, and --output paths are NEVER echoed to stdout or stderr", async () => {
    let stdout = "";
    let stderr = "";
    const origLog = console.log;
    const origError = console.error;
    console.log = (msg: string) => { stdout += `${msg}\n`; };
    console.error = (msg: string) => { stderr += `${msg}\n`; };

    const validUuid = randomUUID();
    const localDsn = "postgres://u:p@localhost:5432/db";
    const secretMarkerFormat = "marker_secret_format_val_998877";
    const secretMarkerTable = "marker_secret_table_val_998877; DROP TABLE--";
    const secretMarkerPathInRepo = "scripts/marker_secret_path_val_998877.json";
    const secretMarkerPathMissingParent = "/nonexistent_parent_dir_998877/out.json";

    try {
      // 1. Invalid --format with secret marker
      stdout = "";
      stderr = "";
      const exitFormat = await runSweepCli([
        "--database-url", localDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid,
        "--confirm", validUuid,
        "--format", secretMarkerFormat,
      ]);
      assert.equal(exitFormat, 1);
      assert.ok(stderr.includes("Invalid --format"));
      assert.ok(!stdout.includes(secretMarkerFormat));
      assert.ok(!stderr.includes(secretMarkerFormat));

      // 2. Invalid --table with secret marker
      stdout = "";
      stderr = "";
      const exitTable = await runSweepCli([
        "--database-url", localDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid,
        "--confirm", validUuid,
        "--table", secretMarkerTable,
      ]);
      assert.equal(exitTable, 1);
      assert.ok(stderr.includes("Invalid --table value"));
      assert.ok(!stdout.includes(secretMarkerTable));
      assert.ok(!stderr.includes(secretMarkerTable));

      // 3. Invalid in-repo --output path with secret marker
      stdout = "";
      stderr = "";
      const exitPathRepo = await runSweepCli([
        "--database-url", localDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid,
        "--confirm", validUuid,
        "--output", secretMarkerPathInRepo,
      ]);
      assert.equal(exitPathRepo, 1);
      assert.ok(stderr.includes("Refusing to write output inside repository"));
      assert.ok(!stdout.includes(secretMarkerPathInRepo));
      assert.ok(!stderr.includes(secretMarkerPathInRepo));

      // 4. Invalid missing-parent --output path with secret marker
      stdout = "";
      stderr = "";
      const exitPathParent = await runSweepCli([
        "--database-url", localDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid,
        "--confirm", validUuid,
        "--output", secretMarkerPathMissingParent,
      ]);
      assert.equal(exitPathParent, 1);
      assert.ok(stderr.includes("Parent directory does not exist"));
      assert.ok(!stdout.includes(secretMarkerPathMissingParent));
      assert.ok(!stderr.includes(secretMarkerPathMissingParent));
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  });

  await t.test("sanitizeCliErrorMessage maps downstream admission and state errors to generic messages without echoing identifiers", () => {
    const markerSecret = "marker_secret_identifier_downstream_7788";

    // 1. Admission: COMPANY_DELETION_IN_PROGRESS
    const errDel = new CompanyMemoryUpgradeError(
      `Company ${markerSecret} is undergoing deletion`,
      "COMPANY_DELETION_IN_PROGRESS",
    );
    const msgDel = sanitizeCliErrorMessage(errDel);
    assert.ok(!msgDel.includes(markerSecret), "Must never echo company ID from deletion error");
    assert.equal(msgDel, "[COMPANY_DELETION_IN_PROGRESS] Target company is undergoing deletion.");

    // 2. Admission: COMPANY_NOT_FOUND
    const errNotFound = new CompanyMemoryUpgradeError(
      `Company ${markerSecret} not found in control plane database.`,
      "COMPANY_NOT_FOUND",
    );
    const msgNotFound = sanitizeCliErrorMessage(errNotFound);
    assert.ok(!msgNotFound.includes(markerSecret), "Must never echo company ID from not-found error");
    assert.equal(msgNotFound, "[COMPANY_NOT_FOUND] Target company record does not exist in control plane database.");

    // 3. State machine: ACTIVE_UPGRADE_EXISTS
    const errActive = new CompanyMemoryUpgradeError(
      `An active memory upgrade is already in progress for company ${markerSecret}`,
      "ACTIVE_UPGRADE_EXISTS",
    );
    const msgActive = sanitizeCliErrorMessage(errActive);
    assert.ok(!msgActive.includes(markerSecret), "Must never echo company ID from active-upgrade error");
    assert.equal(msgActive, "[ACTIVE_UPGRADE_EXISTS] An active memory upgrade is already in progress for target company.");

    // 4. State machine: UPGRADE_NOT_FOUND
    const errUpNotFound = new CompanyMemoryUpgradeError(
      `Upgrade ${markerSecret} not found`,
      "UPGRADE_NOT_FOUND",
    );
    const msgUpNotFound = sanitizeCliErrorMessage(errUpNotFound);
    assert.ok(!msgUpNotFound.includes(markerSecret), "Must never echo upgrade ID from not-found error");
    assert.equal(msgUpNotFound, "[UPGRADE_NOT_FOUND] Upgrade record not found.");

    // 5. State machine: STATE_MISMATCH with arbitrary downstream text
    const errStateMismatch = new CompanyMemoryUpgradeError(
      `State mismatch for upgrade ${markerSecret}: invalid state`,
      "STATE_MISMATCH",
    );
    const msgStateMismatch = sanitizeCliErrorMessage(errStateMismatch);
    assert.ok(!msgStateMismatch.includes(markerSecret), "Must never echo upgrade ID from state mismatch error");
    assert.equal(msgStateMismatch, "[STATE_MISMATCH] Cannot run sweep: active upgrade is not in sweeping state.");

    // 6. State machine: LEASE_FENCED_OUT with arbitrary downstream text
    const errLeaseFenced = new CompanyMemoryUpgradeError(
      `Lease token mismatch for upgrade ${markerSecret}`,
      "LEASE_FENCED_OUT",
    );
    const msgLeaseFenced = sanitizeCliErrorMessage(errLeaseFenced);
    assert.ok(!msgLeaseFenced.includes(markerSecret), "Must never echo upgrade ID from lease error");
    assert.equal(msgLeaseFenced, "[LEASE_FENCED_OUT] Failed to acquire or maintain lease for upgrade. Another worker may hold the lease.");

    // 7. Untrusted class or custom error with secret marker code & message (don't just trust class)
    const errCustom = new CompanyMemoryUpgradeError(
      `Secret internal details: ${markerSecret}`,
      "SECRET_DOWNSTREAM_CODE_1234",
    );
    const msgCustom = sanitizeCliErrorMessage(errCustom);
    assert.ok(!msgCustom.includes(markerSecret), "Must never echo custom message from untrusted error");
    assert.ok(!msgCustom.includes("SECRET_DOWNSTREAM_CODE_1234"), "Must never echo custom code from untrusted error");
    assert.equal(msgCustom, "[unexpected_failure] An unexpected error occurred during upgrade.");
  });
});

test("sweep CLI database integration", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("sweep-cli-cp-");
  const cpAdminDb = createDb(cpFixture.connectionString);

  const tenantFixture = await startEmbeddedPostgresTestDatabase("sweep-cli-tenant-");
  const tenantAdminSql = openTenantClient(tenantFixture.connectionString);

  t.after(async () => {
    await tenantAdminSql.end();
    await cpAdminDb.$client?.end();
    await tenantFixture.cleanup();
    await cpFixture.cleanup();
  });

  await tenantAdminSql.unsafe(`CREATE ROLE cli_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await tenantAdminSql.unsafe(`GRANT ALL ON SCHEMA public TO cli_tenant;`);
  await tenantAdminSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO cli_tenant;`);
  await tenantAdminSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO cli_tenant;`);

  await cpAdminDb.execute(sql`CREATE ROLE cli_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await cpAdminDb.execute(sql`GRANT ALL ON SCHEMA public TO cli_cp;`);
  await cpAdminDb.execute(sql`GRANT ALL ON ALL TABLES IN SCHEMA public TO cli_cp;`);
  await cpAdminDb.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO cli_cp;`);

  const tenantUserUrl = new URL(tenantFixture.connectionString);
  tenantUserUrl.username = "cli_tenant";
  tenantUserUrl.password = "pass123";

  const cpUserUrl = new URL(cpFixture.connectionString);
  cpUserUrl.username = "cli_cp";
  cpUserUrl.password = "pass123";

  await setupTenantMem0Table(tenantAdminSql, "mem0_memories");

  const [company] = await cpAdminDb.insert(companies).values({
    name: "CLI Co",
    issuePrefix: "CL",
  }).returning();

  const [tInfo] = await tenantAdminSql`SELECT current_database()::text AS db;`;

  await cpAdminDb.insert(companyMemoryDatabases).values({
    companyId: company.id,
    databaseName: tInfo.db,
    databaseRole: "cli_tenant",
    host: "localhost",
    port: 5432,
    status: "ready",
  });

  const [agent] = await cpAdminDb.insert(agents).values({
    companyId: company.id,
    name: "CLI Agent",
    adapterType: "hermes_local",
    status: "active",
  }).returning();

  await insertTenantMemoryRow(tenantAdminSql, {
    agentId: agent.id,
    data: "Substantive preference memory text for CLI test.",
  });

  await t.test("refuses when company memory database binding is not verified", async () => {
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };

    const unboundCompany = randomUUID();
    try {
      const exit = await runSweepCli([
        "--database-url", tenantUserUrl.toString(),
        "--control-plane-url", cpUserUrl.toString(),
        "--company", unboundCompany,
        "--confirm", unboundCompany,
      ], { _internalSkipVectorIdentityCheck: true });

      assert.equal(exit, 1);
      assert.ok(stderr.includes("COMPANY_NOT_FOUND"));
    } finally {
      console.error = origError;
    }
  });

  await t.test("refuses when company memory database status is not ready (pending, failed, deprovisioning, archived)", async () => {
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };

    const testStatuses = ["pending", "failed", "deprovisioning", "archived"] as const;

    try {
      for (const st of testStatuses) {
        const prefix = `S${st.slice(0, 2).toUpperCase()}`;
        const [comp] = await cpAdminDb.insert(companies).values({
          name: `Status Test Co ${st}`,
          issuePrefix: prefix,
        }).returning();

        const compDbName = `status_db_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        const compDbRole = `status_r_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        await cpAdminDb.insert(companyMemoryDatabases).values({
          companyId: comp.id,
          databaseName: compDbName,
          databaseRole: compDbRole,
          host: "localhost",
          port: 5432,
          status: st,
        });

        stderr = "";
        const exit = await runSweepCli([
          "--database-url", tenantUserUrl.toString(),
          "--control-plane-url", cpUserUrl.toString(),
          "--company", comp.id,
          "--confirm", comp.id,
          "--pause-when-active-runs", "0",
        ], {
          _internalSkipVectorIdentityCheck: true,
          _internalDatabaseIdentityOverride: { database: compDbName, user: compDbRole },
        });

        assert.equal(exit, 1);
        assert.ok(stderr.includes("[COMPANY_BINDING_MISMATCH]"));
        assert.ok(stderr.includes("status is not ready"));
        assert.ok(!stderr.includes(comp.id));
      }
    } finally {
      console.error = origError;
    }
  });

  await t.test("downstream admission: company undergoing deletion fails closed without echoing company id", async () => {
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };

    const markerCompanyId = randomUUID();
    const [delComp] = await cpAdminDb.insert(companies).values({
      id: markerCompanyId,
      name: "Deletion Test Co",
      issuePrefix: "DT",
      deletionStartedAt: new Date(),
    }).returning();

    const compDbName = `del_db_${markerCompanyId.replace(/-/g, "").slice(0, 12)}`;
    const compDbRole = `del_r_${markerCompanyId.replace(/-/g, "").slice(0, 12)}`;
    await cpAdminDb.insert(companyMemoryDatabases).values({
      companyId: delComp.id,
      databaseName: compDbName,
      databaseRole: compDbRole,
      host: "localhost",
      port: 5432,
      status: "ready",
    });

    try {
      const exit = await runSweepCli([
        "--database-url", tenantUserUrl.toString(),
        "--control-plane-url", cpUserUrl.toString(),
        "--company", delComp.id,
        "--confirm", delComp.id,
        "--pause-when-active-runs", "0",
      ], {
        _internalSkipVectorIdentityCheck: true,
        _internalDatabaseIdentityOverride: { database: compDbName, user: compDbRole },
      });

      assert.equal(exit, 1);
      assert.ok(stderr.includes("[COMPANY_DELETION_IN_PROGRESS]"));
      assert.ok(stderr.includes("Target company is undergoing deletion."));
      assert.ok(!stderr.includes(markerCompanyId), "Downstream admission error must never echo company ID");
    } finally {
      console.error = origError;
    }
  });

  await t.test("refuses in-repo output path and writes mode 0600 to external output path", async () => {
    let stderr = "";
    const origError = console.error;
    console.error = (msg: string) => { stderr += `${msg}\n`; };

    const inRepoPath = "./scripts/test-output.json";
    const externalOut = `/tmp/sweep-cli-out-${randomUUID().slice(0, 8)}.json`;

    try {
      // 1. In-repo output refused
      stderr = "";
      const exitInRepo = await runSweepCli([
        "--database-url", tenantUserUrl.toString(),
        "--control-plane-url", cpUserUrl.toString(),
        "--company", company.id,
        "--confirm", company.id,
        "--output", inRepoPath,
        "--pause-when-active-runs", "0",
      ], { _internalSkipVectorIdentityCheck: true });
      assert.equal(exitInRepo, 1);
      assert.ok(stderr.includes("Refusing to write output inside repository"));

      // 2. External output succeeds with mode 0600
      stderr = "";
      const exitExternal = await runSweepCli([
        "--database-url", tenantUserUrl.toString(),
        "--control-plane-url", cpUserUrl.toString(),
        "--company", company.id,
        "--confirm", company.id,
        "--output", externalOut,
        "--format", "json",
        "--pause-when-active-runs", "0",
      ], { _internalSkipVectorIdentityCheck: true });
      assert.equal(exitExternal, 0);
      assert.ok(stderr.includes("Sweep report written to"));

      const stats = statSync(externalOut);
      assert.equal(stats.mode & 0o777, 0o600);
      unlinkSync(externalOut);
    } finally {
      console.error = origError;
    }
  });

  await t.test("JSON output prints only counts and contains ZERO memory text", async () => {
    let stdout = "";
    const origLog = console.log;
    console.log = (msg: string) => { stdout += `${msg}\n`; };

    try {
      const exit = await runSweepCli([
        "--database-url", tenantUserUrl.toString(),
        "--control-plane-url", cpUserUrl.toString(),
        "--company", company.id,
        "--confirm", company.id,
        "--format", "json",
        "--pause-when-active-runs", "0",
      ], { _internalSkipVectorIdentityCheck: true });

      assert.equal(exit, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.schemaVersion, "1.0");
      assert.equal(parsed.counts.pendingConversionCount, 1);
      assert.ok(parsed.counts.sourceSeenCount >= 1);

      // Verify ZERO memory text anywhere in stdout
      assert.ok(!stdout.includes("Substantive preference memory text for CLI test"));
    } finally {
      console.log = origLog;
    }
  });
});
