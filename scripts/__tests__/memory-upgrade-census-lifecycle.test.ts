import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  formatCensusTextReport,
  runCensus,
} from "../../server/src/services/company-memory-upgrade/census.js";
import {
  runCensusCli,
} from "../memory-upgrade.js";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-census-helpers.js";

describe("census lifecycle, redaction, and CLI integration tests", () => {
  it("never echoes payload-controlled strings verbatim (redacts emails, sentences, and malformed IDs in user_id and agent_id)", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_redaction");
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

      const emailAgent = "leak-agent-contact@company.example";
      const sentenceAgent = "This is a sentence of private memory text that leaked into the agent_id column.";
      const emailUser = "leak-user-email@domain.test";
      const sentenceUser = "This is a sentence of private memory text that leaked into the user_id column.";
      const canonicalUuidAgent = "00000000-0000-4000-8000-000000000001";

      await adminDb.execute(sql`
        INSERT INTO mem0_memories (id, vector, payload) VALUES
        ('mem-1', '[]', ${JSON.stringify({
          agent_id: emailAgent,
          user_id: emailUser,
          data: "Memory row with email in agent_id and user_id.",
        })}::jsonb),
        ('mem-2', '[]', ${JSON.stringify({
          agent_id: sentenceAgent,
          user_id: sentenceUser,
          data: "Memory row with memory sentence in agent_id and user_id.",
        })}::jsonb),
        ('mem-3', '[]', ${JSON.stringify({
          agent_id: canonicalUuidAgent,
          user_id: "company",
          data: "Valid canonical agent and company user_id.",
        })}::jsonb);
      `);

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      const report = await runCensus({
        databaseUrl: tenantUrl.toString(),
        companyId: "00000000-0000-4000-8000-000000000001",
        _internalSkipVectorIdentityCheck: true,
      });

      const jsonOutput = JSON.stringify(report, null, 2);
      const textOutput = formatCensusTextReport(report);

      // Assert payload-controlled dirty strings NEVER appear verbatim in JSON or text output
      assert.ok(!jsonOutput.includes(emailAgent), "emailAgent must not appear in JSON report");
      assert.ok(!textOutput.includes(emailAgent), "emailAgent must not appear in text report");
      assert.ok(!jsonOutput.includes(sentenceAgent), "sentenceAgent must not appear in JSON report");
      assert.ok(!textOutput.includes(sentenceAgent), "sentenceAgent must not appear in text report");
      assert.ok(!jsonOutput.includes(emailUser), "emailUser must not appear in JSON report");
      assert.ok(!textOutput.includes(emailUser), "emailUser must not appear in text report");
      assert.ok(!jsonOutput.includes(sentenceUser), "sentenceUser must not appear in JSON report");
      assert.ok(!textOutput.includes(sentenceUser), "sentenceUser must not appear in text report");

      // Canonical UUID and literal "company" MAY appear as-is
      assert.ok(jsonOutput.includes(canonicalUuidAgent));
      assert.ok(textOutput.includes(canonicalUuidAgent));
      assert.ok(jsonOutput.includes('"company"'));
      assert.ok(textOutput.includes("company"));

      // Verify non-reversible hash labels appear
      const emailAgentHash = `sha256:${createHash("sha256").update(emailAgent).digest("hex").slice(0, 12)} (len ${emailAgent.length})`;
      const sentenceUserHash = `sha256:${createHash("sha256").update(sentenceUser).digest("hex").slice(0, 12)} (len ${sentenceUser.length})`;
      assert.ok(jsonOutput.includes(emailAgentHash));
      assert.ok(textOutput.includes(emailAgentHash));
      assert.ok(jsonOutput.includes(sentenceUserHash));
      assert.ok(textOutput.includes(sentenceUserHash));
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("classifies agent with unknown status and stale paused_at as unknown_status (unroutable), never routable_but_paused", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const tenantFixture = await startEmbeddedPostgresTestDatabase("test_census_stale_paused_tenant");
    const cpFixture = await startEmbeddedPostgresTestDatabase("test_census_stale_paused_cp");
    const tenantAdminDb = createDb(tenantFixture.connectionString);
    const cpAdminDb = createDb(cpFixture.connectionString);

    const testCompanyId = "00000000-0000-4000-8000-000000000001";
    const stalePausedAgentId = "22222222-2222-4222-8222-222222222222";

    try {
      await cpAdminDb.execute(sql`
        INSERT INTO companies (id, name, issue_prefix) VALUES (${testCompanyId}::uuid, 'Acme Test Corp', 'ACME');
      `);
      await cpAdminDb.execute(sql`
        INSERT INTO agents (id, company_id, name, adapter_type, status, paused_at) VALUES
        (${stalePausedAgentId}::uuid, ${testCompanyId}::uuid, 'Stale Paused Agent', 'hermes_local', 'experimental_unknown_status', now());
      `);

      const parsedTenantUrl = new URL(tenantFixture.connectionString);
      const tenantDbName = parsedTenantUrl.pathname.replace(/^\//, "");

      await cpAdminDb.execute(sql`
        INSERT INTO company_memory_databases (company_id, database_name, database_role, host, status)
        VALUES (${testCompanyId}::uuid, ${tenantDbName}, 'pcmem_tenant_role', '127.0.0.1', 'ready');
      `);
      await cpAdminDb.execute(sql`CREATE ROLE cp_reader WITH LOGIN PASSWORD 'cp_pw_secret' NOSUPERUSER NOBYPASSRLS;`);
      await cpAdminDb.execute(sql`GRANT USAGE ON SCHEMA public TO cp_reader;`);
      await cpAdminDb.execute(sql`GRANT SELECT ON companies, agents, company_memory_databases TO cp_reader;`);

      const cpUserUrl = new URL(cpFixture.connectionString);
      cpUserUrl.username = "cp_reader";
      cpUserUrl.password = "cp_pw_secret";
      const cpDsn = cpUserUrl.toString();

      await tenantAdminDb.execute(sql`CREATE DOMAIN "vector(1536)" AS text;`);
      await tenantAdminDb.execute(sql`
        CREATE TABLE mem0_memories (
          id TEXT PRIMARY KEY,
          vector "vector(1536)",
          payload JSONB NOT NULL
        );
      `);
      await tenantAdminDb.execute(sql`CREATE ROLE pcmem_tenant_role WITH LOGIN PASSWORD 'tenant_pw_secret' NOSUPERUSER NOBYPASSRLS;`);
      await tenantAdminDb.execute(sql`GRANT USAGE ON SCHEMA public TO pcmem_tenant_role;`);
      await tenantAdminDb.execute(sql`GRANT SELECT ON mem0_memories TO pcmem_tenant_role;`);
      await tenantAdminDb.execute(sql`
        INSERT INTO mem0_memories (id, vector, payload) VALUES
        ('mem-1', '[]', ${JSON.stringify({
          agent_id: stalePausedAgentId,
          user_id: "user-1",
          data: "Memory for agent with unknown status and stale paused_at.",
        })}::jsonb);
      `);

      const tenantUserUrl = new URL(tenantFixture.connectionString);
      tenantUserUrl.username = "pcmem_tenant_role";
      tenantUserUrl.password = "tenant_pw_secret";
      const tenantDsn = tenantUserUrl.toString();

      const report = await runCensus({
        databaseUrl: tenantDsn,
        controlPlaneUrl: cpDsn,
        companyId: testCompanyId,
        _internalSkipVectorIdentityCheck: true,
      });

      // Must be classified as unknown_status (unroutable), NEVER routable_but_paused!
      assert.equal(report.routing.counts.agents.routable_but_paused, 0);
      assert.equal(report.routing.counts.rows.routable_but_paused, 0);
      assert.equal(report.routing.counts.agents.routable, 0);
      assert.equal(report.routing.counts.agents.unroutable, 1);
      assert.equal(report.routing.counts.rows.unroutable, 1);

      assert.equal(report.routing.unroutableBreakdown.unknown_status.distinctAgentCount, 1);
      assert.equal(report.routing.unroutableBreakdown.unknown_status.rowCount, 1);
      assert.deepEqual(report.routing.unroutableBreakdown.unknown_status.agentIds, [stalePausedAgentId]);

      assert.ok(
        report.caveats.some(
          (c) =>
            c.includes(stalePausedAgentId) &&
            c.includes("experimental_unknown_status") &&
            c.includes("unrecognized status"),
        ),
      );
    } finally {
      await tenantAdminDb.$client.end({ timeout: 1 });
      await cpAdminDb.$client.end({ timeout: 1 });
      await tenantFixture.cleanup();
      await cpFixture.cleanup();
    }
  });

  it("fails closed with DATABASE_IDENTITY_UNAVAILABLE when database or user identity is empty or null", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_empty_identity");
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

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            companyId: "00000000-0000-4000-8000-000000000001",
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: "", user: "" },
          }),
        (err: any) => err.code === "DATABASE_IDENTITY_UNAVAILABLE",
      );

      await assert.rejects(
        () =>
          runCensus({
            databaseUrl: tenantUrl.toString(),
            companyId: "00000000-0000-4000-8000-000000000001",
            _internalSkipVectorIdentityCheck: true,
            _internalDatabaseIdentityOverride: { database: "some_db", user: "   " },
          }),
        (err: any) => err.code === "DATABASE_IDENTITY_UNAVAILABLE",
      );
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("when --output is supplied, prints only notice to stderr and keeps stdout completely empty", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const tmpOut = path.join(os.tmpdir(), `test-cli-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_cli_output");
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

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      let stdoutLogged = "";
      let stderrLogged = "";
      const origLog = console.log;
      const origError = console.error;
      let exitCode: number;

      try {
        console.log = (msg: string) => {
          stdoutLogged += `${msg}\n`;
        };
        console.error = (msg: string) => {
          stderrLogged += `${msg}\n`;
        };

        exitCode = await runCensusCli(
          [
            "--database-url",
            tenantUrl.toString(),
            "--company",
            "00000000-0000-4000-8000-000000000001",
            "--output",
            tmpOut,
            "--format",
            "json",
          ],
          { _internalSkipVectorIdentityCheck: true },
        );
      } finally {
        console.log = origLog;
        console.error = origError;
      }

      assert.equal(exitCode, 0);
      // stdout MUST be completely empty!
      assert.equal(stdoutLogged, "", "stdout must be empty when --output is supplied");
      // stderr MUST contain the notice with resolved path
      assert.ok(
        stderrLogged.includes(`Census report written to ${path.resolve(tmpOut)}`),
        `Expected stderr to include resolved path notice, got: ${stderrLogged}`,
      );
      // File must exist with mode 0600
      assert.ok(fs.existsSync(tmpOut));
      assert.equal(fs.statSync(tmpOut).mode & 0o777, 0o600);
    } finally {
      try {
        fs.unlinkSync(tmpOut);
      } catch {}
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("enforces that env.PAPERCLIP_TEST_SKIP_VECTOR_IDENTITY cannot bypass vector identity check in runCensus or runCensusCli", async (t) => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      handleEmbeddedPostgresUnsupported(support, t);
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_census_no_env_bypass");
    const adminDb = createDb(fixture.connectionString);

    try {
      // Create fake vector domain
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

      const tenantUrl = new URL(fixture.connectionString);
      tenantUrl.username = "tenant_checker";
      tenantUrl.password = "pass123";

      const prevEnv = process.env.PAPERCLIP_TEST_SKIP_VECTOR_IDENTITY;
      process.env.PAPERCLIP_TEST_SKIP_VECTOR_IDENTITY = "true";
      try {
        // 1. runCensus without explicit programmatic _internalSkipVectorIdentityCheck must reject with NOT_PGVECTOR
        await assert.rejects(
          () =>
            runCensus({
              databaseUrl: tenantUrl.toString(),
              companyId: "00000000-0000-4000-8000-000000000001",
            }),
          (err: any) => err.code === "NOT_PGVECTOR",
        );

        // 2. runCensusCli without explicit injected dependencies must fail and report NOT_PGVECTOR error
        let stderrLogged = "";
        const origError = console.error;
        let exitCode: number;
        try {
          console.error = (msg: string) => {
            stderrLogged += `${msg}\n`;
          };

          exitCode = await runCensusCli([
            "--database-url",
            tenantUrl.toString(),
            "--company",
            "00000000-0000-4000-8000-000000000001",
          ]);
        } finally {
          console.error = origError;
        }

        assert.equal(exitCode, 1);
        assert.ok(
          stderrLogged.includes("is not a valid pgvector column") || stderrLogged.includes("NOT_PGVECTOR"),
          `Expected stderr to report pgvector rejection, got: ${stderrLogged}`,
        );
      } finally {
        if (prevEnv !== undefined) {
          process.env.PAPERCLIP_TEST_SKIP_VECTOR_IDENTITY = prevEnv;
        } else {
          delete process.env.PAPERCLIP_TEST_SKIP_VECTOR_IDENTITY;
        }
      }
    } finally {
      await adminDb.$client.end({ timeout: 1 });
      await fixture.cleanup();
    }
  });

  it("executes full-stack census against real vector(1536) in live pgvector Docker", { skip: process.env.PAPERCLIP_RUN_DOCKER_PGVECTOR_TESTS !== "true" }, async () => {
    // This test runs exclusively when live Docker PostgreSQL with pgvector is configured.
    // It asserts that the real pgvector catalog identity check passes with no _internalSkipVectorIdentityCheck.
    const dockerDsn = process.env.PAPERCLIP_TEST_DOCKER_PGVECTOR_URL;
    if (!dockerDsn) return;

    const dockerDb = createDb(dockerDsn);
    const roleName = `docker_census_${Date.now()}`;
    const tableName = `docker_mem0_real_vector_${Date.now()}`;
    const safeRole = roleName.replace(/[^a-zA-Z0-9_]/g, "");
    const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, "");

    try {
      const dbRes = (await dockerDb.execute<{ current_database: string }>(
        sql`SELECT current_database();`,
      )) as unknown as Array<{ current_database: string }>;
      const dbName = dbRes[0]?.current_database;
      if (!dbName) {
        throw new Error("Could not determine current database name for Docker fixture");
      }

      await dockerDb.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);
      await dockerDb.execute(sql.raw(`CREATE ROLE ${safeRole} WITH LOGIN PASSWORD 'docker_pass_123' NOSUPERUSER NOBYPASSRLS;`));
      await dockerDb.execute(sql.raw(`
        CREATE TABLE ${safeTable} (
          id UUID PRIMARY KEY,
          vector vector(1536),
          payload JSONB NOT NULL
        );
      `));
      await dockerDb.execute(sql`GRANT CONNECT ON DATABASE ${sql.identifier(dbName)} TO ${sql.identifier(safeRole)};`);
      await dockerDb.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(safeRole)};`);
      await dockerDb.execute(sql`GRANT SELECT ON ${sql.identifier(safeTable)} TO ${sql.identifier(safeRole)};`);

      const parsed = new URL(dockerDsn);
      parsed.username = safeRole;
      parsed.password = "docker_pass_123";
      const nonSuperuserDsn = parsed.toString();

      const report = await runCensus({
        databaseUrl: nonSuperuserDsn,
        tableName: safeTable,
        companyId: "00000000-0000-4000-8000-000000000001",
        // Note: _internalSkipVectorIdentityCheck is NOT passed here! Production contract verified!
      });

      assert.equal(report.shapeIntrospection.embeddingDims, 1536);
      assert.equal(report.readOnly, true);
    } finally {
      try {
        await dockerDb.execute(sql.raw(`DROP TABLE IF EXISTS ${safeTable};`));
      } catch {}
      try {
        await dockerDb.execute(sql.raw(`DROP ROLE IF EXISTS ${safeRole};`));
      } catch {}
      await dockerDb.$client.end({ timeout: 1 });
    }
  });
});
