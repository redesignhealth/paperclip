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
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-census-helpers.js";

describe("census company binding, routing verification, and report accuracy integration tests", () => {
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
            _internalSkipVectorIdentityCheck: true,
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
            _internalSkipVectorIdentityCheck: true,
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
            _internalSkipVectorIdentityCheck: true,
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
        _internalSkipVectorIdentityCheck: true,
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
            _internalSkipVectorIdentityCheck: true,
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
        _internalSkipVectorIdentityCheck: true,
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

      // Unroutable breakdown by named reason (C3)
      const expectedMalformedHash = `sha256:${createHash("sha256").update("malformed-agent-id-123").digest("hex").slice(0, 12)} (len 22)`;
      assert.equal(report.routing.unroutableBreakdown.missing_agent_id.rowCount, 1);
      assert.equal(report.routing.unroutableBreakdown.malformed_agent_id.rowCount, 1);
      assert.deepEqual(report.routing.unroutableBreakdown.malformed_agent_id.agentIds, [expectedMalformedHash]);
      assert.equal(report.routing.unroutableBreakdown.unknown_agent.rowCount, 1);
      assert.deepEqual(report.routing.unroutableBreakdown.unknown_agent.agentIds, [unknownAgentId]);
      assert.equal(report.routing.unroutableBreakdown.non_memory_adapter.rowCount, 2); // claude + hermes_gateway
      assert.deepEqual(report.routing.unroutableBreakdown.non_memory_adapter.agentIds, [nonHermesAgentId, hermesGatewayAgentId].sort());
      assert.equal(report.routing.unroutableBreakdown.terminated.rowCount, 1);
      assert.deepEqual(report.routing.unroutableBreakdown.terminated.agentIds, [terminatedHermesAgentId]);
      assert.equal(report.routing.unroutableBreakdown.pending_approval.rowCount, 1);
      assert.deepEqual(report.routing.unroutableBreakdown.pending_approval.agentIds, [pendingApprovalHermesAgentId]);
      assert.equal(report.routing.unroutableBreakdown.unknown_status.rowCount, 0);

      // Unroutable agent IDs listed (ids only)
      assert.ok(report.routing.unroutableAgentIds.includes(terminatedHermesAgentId));
      assert.ok(report.routing.unroutableAgentIds.includes(nonHermesAgentId));
      assert.ok(report.routing.unroutableAgentIds.includes(unknownAgentId));
      assert.ok(report.routing.unroutableAgentIds.includes(expectedMalformedHash));
      assert.ok(!report.routing.unroutableAgentIds.includes("malformed-agent-id-123"));
      assert.ok(report.routing.unroutableAgentIds.includes(hermesGatewayAgentId));
      assert.ok(report.routing.unroutableAgentIds.includes(pendingApprovalHermesAgentId));

      // 7. Budget estimate verification
      // Exact reconciliation: rowsToConvert(4) + unroutable(7) + noiseInRoutable(2) + duplicateSurplusInRoutable(1) = 14
      assert.equal(report.budget.rowsToConvert, 4);
      assert.equal(report.budget.basis, "verified");
      assert.equal(report.budget.bound, "exact");
      assert.equal(report.budget.breakdown.rowsToConvert, 4);
      assert.equal(report.budget.breakdown.unroutableRows, 7);
      assert.equal(report.budget.breakdown.noiseRowsInRoutable, 2);
      assert.equal(report.budget.breakdown.duplicateSurplusInRoutable, 1);
      assert.equal(report.budget.breakdown.totalRows, 14);
      assert.equal(
        report.budget.breakdown.rowsToConvert +
          report.budget.breakdown.unroutableRows +
          report.budget.breakdown.noiseRowsInRoutable +
          report.budget.breakdown.duplicateSurplusInRoutable,
        14,
      );
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
        "malformed-agent-id-123",
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
            _internalSkipVectorIdentityCheck: true,
          }),
        (err: any) => err.code === "EEXIST",
      );

      fs.unlinkSync(tmpOutPath);

      // 10. Verification without control plane URL: requires company and marks unverified and unbound
      const unverifiedReport = await runCensus({
        databaseUrl: tenantDsn,
        companyId: testCompanyId,
        _internalSkipVectorIdentityCheck: true,
      });

      assert.equal(unverifiedReport.routing.status, "unverified");
      assert.equal(unverifiedReport.company.verification, "unbound");
      assert.equal(unverifiedReport.budget.basis, "provisional");
      assert.equal(unverifiedReport.budget.bound, "upper_bound");
      assert.ok(unverifiedReport.routing.caveat?.includes("Control plane URL was not provided"));

      // Text summary loudly warns about unverified routing and renders provisional estimate banner
      const unverifiedSummary = formatCensusTextReport(unverifiedReport);
      assert.ok(unverifiedSummary.includes("ROUTING UNVERIFIED"));
      assert.ok(unverifiedSummary.includes("PROVISIONAL BUDGET ESTIMATE"));
    } finally {
      await tenantAdminDb.$client.end({ timeout: 1 });
      await cpAdminDb.$client.end({ timeout: 1 });
      await tenantFixture.cleanup();
      await cpFixture.cleanup();
    }
  });
});
