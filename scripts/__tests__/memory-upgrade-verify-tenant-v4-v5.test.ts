/**
 * Tenant gate refusals V4 and V5 (TECH-8191 §Q4).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runVerify } from "../../server/src/services/company-memory-upgrade/verify.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("verify tenant gate refusals (V4, V5)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("v-v4v5");
  t.after(async () => { await env.cleanup(); });

  const [t0Row] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
  const t0 = t0Row.t instanceof Date ? t0Row.t : new Date(t0Row.t);
  const markedAt = new Date(t0.getTime() - 30 * 60_000);
  const observedAt = new Date(t0.getTime() - 25 * 60_000);

  await env.cpDb.update(companyMemoryDatabases).set({
    scopeMigrationCompletedAt: markedAt, scopeMigrationMode: "copy", scopeMigrationAgentScopeObservedAt: observedAt, updatedAt: markedAt,
  }).where(eq(companyMemoryDatabases.companyId, env.company.id));

  const [upgrade] = await env.cpDb.insert(companyMemoryUpgrades).values({
    companyId: env.company.id, state: "draining", converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1, collectionName: "mem0_memories", embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536, markedAt, drainConfirmedAt: new Date(t0.getTime() - 10 * 60_000),
  }).returning();

  const verifyCall = () =>
    runVerify(
      { companyId: env.company.id, dryRun: true, tenantDatabaseUrl: "postgres://unused", controlPlaneDatabaseUrl: "postgres://unused" },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );

  await t.test("V4 refusal: pending publish rows present", async () => {
    const sId = randomUUID(), outId = randomUUID(), h = computeSourceContentSha256("p");
    await insertTenantMemoryRow(env.tenantSql, { id: sId, agentId: env.agent.id, userId: "company", data: "p" });
    await env.tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids) VALUES ('${upgrade.id}', '${sId}', '${h}', '${env.agent.id}', 'published', 'converted', ARRAY['${outId}'::uuid]);` +
      `INSERT INTO paperclip_memory_upgrade_staging (upgrade_id, source_id, output_id, agent_id, content_sha256, payload, embedding) VALUES ('${upgrade.id}', '${sId}', '${outId}', '${env.agent.id}', '${h}', '{"data":"p"}', 'vec');`
    );

    await assert.rejects(
      () => verifyCall(),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "VERIFICATION_FAILED" && err.message.includes("staged rows are still pending publish"),
    );

    await env.tenantSql`UPDATE paperclip_memory_upgrade_staging SET published_at = now() WHERE output_id = ${outId}::uuid;`;
  });

  await t.test("V5 refusal: unledgered live memory creates blocking source on probe", async () => {
    const freshId = randomUUID();
    await insertTenantMemoryRow(env.tenantSql, { id: freshId, agentId: env.agent.id, userId: "company", data: "u" });

    await assert.rejects(
      () => verifyCall(),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "VERIFICATION_FAILED" && err.message.includes("fresh drain probe found"),
    );
  });
});
