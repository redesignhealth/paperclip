/**
 * Tenant gate V6 quarantine refusal, override, and dropped items (TECH-8191 §Q4).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runVerify } from "../../server/src/services/company-memory-upgrade/verify.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("verify V6 quarantine refusal and dropped items", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("v-v6q");
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

  const verifyCall = (allowQuarantined = false) =>
    runVerify(
      { companyId: env.company.id, dryRun: true, allowQuarantined, tenantDatabaseUrl: "postgres://unused", controlPlaneDatabaseUrl: "postgres://unused" },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );

  await t.test("V6 refusal: quarantined sources present without --allow-quarantined", async () => {
    const qId = randomUUID();
    await env.tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids) VALUES ('${upgrade.id}', '${qId}', 'hq', '${env.agent.id}', 'quarantined', 'sensitive_data', ARRAY[]::uuid[]);`
    );

    await assert.rejects(
      () => verifyCall(false),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "VERIFY_QUARANTINE_PRESENT" && err.message.includes("quarantined sources remain in the ledger"),
    );

    // Override with allowQuarantined = true
    const rep = await verifyCall(true);
    assert.equal(rep.quarantinedCount, 1);
    assert.equal(rep.allowQuarantined, true);
  });

  await t.test("dropped_noise and dropped_sensitive do not block and report as intentional", async () => {
    const d1 = randomUUID(), d2 = randomUUID();
    await env.tenantSql.unsafe(
      `INSERT INTO paperclip_memory_upgrade_ledger (upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids) VALUES ` +
      `('${upgrade.id}', '${d1}', 'h1', '${env.agent.id}', 'dropped_noise', 'noise', ARRAY[]::uuid[]),` +
      `('${upgrade.id}', '${d2}', 'h2', '${env.agent.id}', 'dropped_sensitive', 'sensitive', ARRAY[]::uuid[]);`
    );

    const rep = await verifyCall(true);
    assert.equal(rep.droppedNoiseCount, 1);
    assert.equal(rep.droppedSensitiveCount, 1);
  });
});
