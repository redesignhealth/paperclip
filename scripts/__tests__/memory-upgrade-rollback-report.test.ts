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

  const upgradeOutputId = "11111111-1111-1111-1111-111111111111";
  const nativeAgent1Id = "22222222-2222-2222-2222-222222222222";
  const nativeAgent2Id = "33333333-3333-3333-3333-333333333333";
  const companyScopeId = "44444444-4444-4444-4444-444444444444";

  // Insert live rows using tenantWorkerSql.json to ensure true jsonb objects:
  await env.tenantWorkerSql`
    INSERT INTO "mem0_memories" (id, payload, vector) VALUES
      (${upgradeOutputId}::uuid, ${env.tenantWorkerSql.json({ user_id: "agent-alpha", data: SECRET_1 })}, '[]'),
      (${nativeAgent1Id}::uuid, ${env.tenantWorkerSql.json({ user_id: "agent-alpha", data: SECRET_2 })}, '[]'),
      (${nativeAgent2Id}::uuid, ${env.tenantWorkerSql.json({ user_id: "agent-beta", data: SECRET_3 })}, '[]'),
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
      '55555555-5555-5555-5555-555555555555'::uuid,
      ${env.tenantWorkerSql.json({ user_id: "agent-alpha", data: SECRET_1 })},
      '[]',
      'dummyhash',
      ${t0},
      ${t0}
    );
  `;

  await t.test("summariseAgentScopedRows counts by agent only and splits created_by_an_upgrade", async () => {
    const summary = await summariseAgentScopedRows(env.tenantWorkerSql, {
      upgradeId: upgrade.id,
      tableName: "mem0_memories",
    });

    assert.equal(summary.totalAgentScopedRows, 3);
    assert.equal(summary.totalCreatedByAnUpgrade, 1);
    assert.equal(summary.publishedRowsRetained, 1);

    const alphaGroup = summary.groups.find((g) => g.agentScope === "agent-alpha");
    assert.ok(alphaGroup);
    assert.equal(alphaGroup.rows, 2);
    assert.equal(alphaGroup.createdByAnUpgrade, 1);

    const betaGroup = summary.groups.find((g) => g.agentScope === "agent-beta");
    assert.ok(betaGroup);
    assert.equal(betaGroup.rows, 1);
    assert.equal(betaGroup.createdByAnUpgrade, 0);
  });

  await t.test("runRollback preserves all live rows and contains zero memory text in reports", async () => {
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
    assert.equal(countRows[0].count, 4);

    // Formatted reports contain no secret memory text
    const textReport = formatRollbackReport(report, "text");
    const jsonReport = formatRollbackReport(report, "json");

    assert.ok(!textReport.includes(SECRET_1));
    assert.ok(!textReport.includes(SECRET_2));
    assert.ok(!textReport.includes(SECRET_3));
    assert.ok(!jsonReport.includes(SECRET_1));
    assert.ok(!jsonReport.includes(SECRET_2));
    assert.ok(!jsonReport.includes(SECRET_3));

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
