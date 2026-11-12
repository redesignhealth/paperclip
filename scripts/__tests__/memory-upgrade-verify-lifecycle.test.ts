/**
 * Lifecycle transitions, lease release, re-run, and dry-run (TECH-8191 §Q4).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runVerify } from "../../server/src/services/company-memory-upgrade/verify.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
} from "./memory-upgrade-sweep-helpers.js";

test("verify state transitions, re-run, and dry-run", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("v-lifecycle");
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

  const doVerify = (isDryRun: boolean) =>
    runVerify(
      { companyId: env.company.id, confirm: isDryRun ? undefined : env.company.id, dryRun: isDryRun, tenantDatabaseUrl: "postgres://unused", controlPlaneDatabaseUrl: "postgres://unused" },
      { cpDb: env.cpWorkerDb, tenantSql: env.tenantWorkerSql, _internalSkipVectorIdentityCheck: true },
    );

  await t.test("dry run takes no lease and does not transition", async () => {
    const rep = await doVerify(true);
    assert.equal(rep.isDryRun, true);
    assert.equal(rep.state, "draining");
    assert.equal(rep.verifiedAt, null);

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "draining");
    assert.equal(row.verifiedAt, null);
    assert.equal(row.leaseToken, null);
  });

  let originalVerifiedAt: Date;

  await t.test("confirmed run transitions draining -> verified and sets verified_at", async () => {
    const rep = await doVerify(false);
    assert.equal(rep.isDryRun, false);
    assert.equal(rep.state, "verified");
    assert.equal(rep.priorState, "draining");
    assert.ok(rep.verifiedAt instanceof Date);
    originalVerifiedAt = rep.verifiedAt;

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "verified");
    assert.ok(row.verifiedAt instanceof Date);
    // Lease cleanly released after verify
    assert.equal(row.leaseToken, null);
  });

  await t.test("re-run in verified reports without transitioning and exits 0", async () => {
    const rep = await doVerify(false);
    assert.equal(rep.state, "verified");
    assert.equal(rep.priorState, "verified");
    assert.equal(rep.verifiedAt?.getTime(), originalVerifiedAt.getTime());

    const [row] = await env.cpDb.select().from(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "verified");
    assert.equal(row.verifiedAt?.getTime(), originalVerifiedAt.getTime());
    assert.equal(row.leaseToken, null);
  });
});
