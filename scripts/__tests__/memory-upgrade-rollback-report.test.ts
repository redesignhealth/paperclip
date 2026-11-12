/**
 * Rollback reporting, row retention, privacy, and flag validation (TECH-8191 §Q5, PR5.9).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRollbackReport,
  ROLLBACK_NEAR_FINAL_WARNING,
  ROLLBACK_REVERT_SCOPE_NOTICE,
  runRollback,
} from "../../server/src/services/company-memory-upgrade/rollback.js";
import { summariseAgentScopedRows } from "../../server/src/services/company-memory-upgrade/rollback-report.js";
import { parseRollbackArgs } from "../memory-upgrade-rollback-args.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("rollback report, retention, privacy, and flag validation (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("rb-report");
  t.after(async () => { await env.cleanup(); });

  const [t0Row] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
  const t0 = t0Row.t instanceof Date ? t0Row.t : new Date(t0Row.t);
  const markedAt = new Date(t0.getTime() - 10 * 60_000);

  await env.cpDb.update(companyMemoryDatabases).set({
    scopeMigrationCompletedAt: markedAt,
    scopeMigrationMode: "copy",
    updatedAt: markedAt,
  }).where(eq(companyMemoryDatabases.companyId, env.company.id));

  const [upgrade] = await env.cpDb.insert(companyMemoryUpgrades).values({
    companyId: env.company.id,
    state: "draining",
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
    markedAt,
  }).returning();

  const SECRET_1 = "SuperSecretPersonalMemoryContentThatMustNeverLeak111";
  const SECRET_2 = "SuperSecretPersonalMemoryContentThatMustNeverLeak222";
  const SECRET_3 = "SuperSecretPersonalMemoryContentThatMustNeverLeak333";
  const SENSITIVE_SCOPE_TEXT = "CONFIDENTIAL_PATIENT_SSN_999-88-7777";
  const MALICIOUS_SCOPE_TEXT = "MALICIOUS_DROP_TABLE_INJECTION_TEXT";

  const upgradeOutputId = "11111111-1111-1111-1111-111111111111";
  const nativeAgent1Id = "22222222-2222-2222-2222-222222222222";
  const nativeAgent2Id = "33333333-3333-3333-3333-333333333333";
  const sensitiveScopeId = "55555555-5555-5555-5555-555555555555";
  const companyScopeId = "44444444-4444-4444-4444-444444444444";
  const canonicalAgentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  // Insert live rows using tenantWorkerSql.json to ensure true jsonb objects:
  await env.tenantWorkerSql`
    INSERT INTO "mem0_memories" (id, payload, vector) VALUES
      (${upgradeOutputId}::uuid, ${env.tenantWorkerSql.json({ user_id: canonicalAgentId, data: SECRET_1 })}, '[]'),
      (${nativeAgent1Id}::uuid, ${env.tenantWorkerSql.json({ user_id: canonicalAgentId, data: SECRET_2 })}, '[]'),
      (${nativeAgent2Id}::uuid, ${env.tenantWorkerSql.json({ user_id: SENSITIVE_SCOPE_TEXT, data: SECRET_3 })}, '[]'),
      (${sensitiveScopeId}::uuid, ${env.tenantWorkerSql.json({ user_id: MALICIOUS_SCOPE_TEXT, data: "safe payload data" })}, '[]'),
      (${companyScopeId}::uuid, ${env.tenantWorkerSql.json({ user_id: "company", data: "Regular company memory" })}, '[]');
  `;

  // Insert staging row for the upgrade-published row
  await env.tenantWorkerSql`
    INSERT INTO paperclip_memory_upgrade_staging (
      upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at, created_at
    ) VALUES (
      ${upgrade.id}::uuid,
      ${companyScopeId}::uuid,
      ${upgradeOutputId}::uuid,
      ${canonicalAgentId}::uuid,
      ${env.tenantWorkerSql.json({ user_id: canonicalAgentId, data: SECRET_1 })},
      '[]',
      'dummyhash',
      ${t0},
      ${t0}
    );
  `;

  await t.test("summariseAgentScopedRows counts by agent, hashes non-UUID scope, and splits created_by_an_upgrade", async () => {
    const summary = await summariseAgentScopedRows(env.tenantWorkerSql, {
      upgradeId: upgrade.id,
      tableName: "mem0_memories",
    });

    assert.equal(summary.totalAgentScopedRows, 4);
    assert.equal(summary.totalCreatedByAnUpgrade, 1);
    assert.equal(summary.totalAgentScopes, 3);
    assert.equal(summary.truncated, false);
    assert.equal(summary.publishedRowsRetained, 1);

    // Canonical UUID scope is preserved
    const canonicalGroup = summary.groups.find((g) => g.agentScope === canonicalAgentId);
    assert.ok(canonicalGroup);
    assert.equal(canonicalGroup.rows, 2);
    assert.equal(canonicalGroup.createdByAnUpgrade, 1);

    // Sensitive text scopes are hashed
    assert.ok(!summary.groups.some((g) => g.agentScope.includes(SENSITIVE_SCOPE_TEXT)));
    assert.ok(!summary.groups.some((g) => g.agentScope.includes(MALICIOUS_SCOPE_TEXT)));
    const hashedGroups = summary.groups.filter((g) => g.agentScope.startsWith("sha256:"));
    assert.equal(hashedGroups.length, 2);
  });

  await t.test("small limit preserves exact overall totals and reports honest truncation indication", async () => {
    const limitedSummary = await summariseAgentScopedRows(env.tenantWorkerSql, {
      upgradeId: upgrade.id,
      tableName: "mem0_memories",
      limit: 2,
    });

    assert.equal(limitedSummary.groups.length, 2);
    assert.equal(limitedSummary.totalAgentScopes, 3);
    assert.equal(limitedSummary.truncated, true);
    // Overall totals reflect all rows, not just the top 2 groups
    assert.equal(limitedSummary.totalAgentScopedRows, 4);
    assert.equal(limitedSummary.totalCreatedByAnUpgrade, 1);

    const report = await runRollback(
      {
        companyId: env.company.id,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
        dryRun: true,
        limit: 2,
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    assert.equal(report.agentScopedRows.length, 2);
    assert.equal(report.totalAgentScopes, 3);
    assert.equal(report.totalAgentScopedRows, 4);
    assert.equal(report.totalCreatedByAnUpgrade, 1);
    assert.equal(report.truncated, true);

    const textReport = formatRollbackReport(report, "text");
    assert.ok(textReport.includes("showing top 2 of 3 agent scopes"));
    assert.ok(textReport.includes("overall totals below reflect all rows"));
    assert.ok(textReport.includes("Total agent-scoped rows: 4 (1 created by an upgrade across 3 agent scopes, truncated in display)"));
  });

  await t.test("runRollback preserves all live rows and contains zero memory text or sensitive scope text", async () => {
    const report = await runRollback(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    // Live collection rows are NOT deleted
    const countRows = await env.tenantWorkerSql`
      SELECT count(*)::int AS count FROM "mem0_memories";
    `;
    assert.equal(countRows[0].count, 5);

    // Formatted reports contain no secret memory text or raw sensitive scope text
    const textReport = formatRollbackReport(report, "text");
    const jsonReport = formatRollbackReport(report, "json");

    assert.ok(!textReport.includes(SECRET_1));
    assert.ok(!textReport.includes(SECRET_2));
    assert.ok(!textReport.includes(SECRET_3));
    assert.ok(!textReport.includes(SENSITIVE_SCOPE_TEXT));
    assert.ok(!textReport.includes(MALICIOUS_SCOPE_TEXT));

    assert.ok(!jsonReport.includes(SECRET_1));
    assert.ok(!jsonReport.includes(SECRET_2));
    assert.ok(!jsonReport.includes(SECRET_3));
    assert.ok(!jsonReport.includes(SENSITIVE_SCOPE_TEXT));
    assert.ok(!jsonReport.includes(MALICIOUS_SCOPE_TEXT));

    // Reports must contain blunt warnings
    assert.ok(textReport.includes("Treat rollback as near-final"));
    assert.ok(textReport.includes("duplicate"));
    assert.ok(textReport.includes("agent-scoped-mem0"));
    assert.ok(jsonReport.includes("duplicate"));
    assert.ok(report.warnings.some((w) => w.includes(ROLLBACK_NEAR_FINAL_WARNING)));
    assert.ok(report.warnings.some((w) => w.includes(ROLLBACK_REVERT_SCOPE_NOTICE)));
  });

  await t.test("flag validation: rollback rejects flags belonging to other subcommands", () => {
    const forbiddenFlags = [
      "--model",
      "--max-cost-usd",
      "--page-size",
      "--allow-quarantined",
      "--ack-agent-scope-flag",
      "--max-drain-hours",
    ];

    for (const flag of forbiddenFlags) {
      assert.throws(
        () =>
          parseRollbackArgs(
            ["--company", env.company.id, flag, "value"],
            process.env,
            process.cwd(),
          ),
        (err: any) =>
          err?.code === "INVALID_ARGUMENT" &&
          err?.message.includes(`Unknown option '${flag}'`),
      );
    }
  });
});
