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

test("sweep CLI validation and flags", async (t) => {
  await t.test("scrubDsnSecrets scrubs credentials from URLs", () => {
    const raw = "Connection failed to postgres://app_user:super_secret_password@db.internal.net:5432/db_prod";
    const scrubbed = scrubDsnSecrets(raw);
    assert.ok(!scrubbed.includes("super_secret_password"));
    assert.ok(scrubbed.includes("postgres://app_user:***@db.internal.net:5432/db_prod"));
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
      assert.ok(stderr.includes("Refusing to connect to non-local host 'rds.us-east-1.amazonaws.com' without --prod flag and MEMORY_UPGRADE_ALLOW_PROD=1"));
      assert.ok(!stderr.includes("secret123")); // Password scrubbed!

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
      assert.ok(stderr.includes("Refusing to connect to non-local host 'rds.us-east-1.amazonaws.com' without MEMORY_UPGRADE_ALLOW_PROD=1"));

      // Case C: Remote tenant DSN with env only
      stderr = "";
      const exitC = await runSweepCli([
        "--database-url", remoteDsn,
        "--control-plane-url", localDsn,
        "--company", validUuid,
        "--confirm", validUuid,
      ], { env: { MEMORY_UPGRADE_ALLOW_PROD: "1" } });
      assert.equal(exitC, 1);
      assert.ok(stderr.includes("Refusing to connect to non-local host 'rds.us-east-1.amazonaws.com' without --prod flag"));

      // Case D: Remote control-plane DSN without flag or env
      stderr = "";
      const exitD = await runSweepCli([
        "--database-url", localDsn,
        "--control-plane-url", remoteDsn,
        "--company", validUuid,
        "--confirm", validUuid,
      ], { env: {} });
      assert.equal(exitD, 1);
      assert.ok(stderr.includes("Refusing to connect to non-local host 'rds.us-east-1.amazonaws.com' without --prod flag and MEMORY_UPGRADE_ALLOW_PROD=1"));
      assert.ok(!stderr.includes("secret123"));
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
      assert.ok(stderr.includes("Company"));
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
