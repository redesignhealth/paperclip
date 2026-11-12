/**
 * Fenced scope marker company authorization and database clock expiry tests
 * (TECH-8191 review findings regression).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";
import { setScopeMigrationMarkerFenced } from "../../server/src/services/company-memory-upgrade/scope-marker.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("setScopeMigrationMarkerFenced company binding and DB clock expiry (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("flip-fenced-marker");
  t.after(async () => {
    await env.cleanup();
  });

  // Create second company with its own companyMemoryDatabases row
  const companyBId = randomUUID();
  await env.cpDb.insert(companies).values({
    id: companyBId,
    name: "Company B",
    issuePrefix: "CPB",
  });
  await env.cpDb.insert(companyMemoryDatabases).values({
    companyId: companyBId,
    databaseName: "tenant_b",
    databaseRole: "role_b",
    host: "127.0.0.1",
    status: "ready",
  });

  // 1. Regression: two companies, A upgrade/token + B company -> LEASE_FENCED_OUT, neither marker changes
  await t.test("regression: company A upgrade/lease cannot set marker for company B", async () => {
    const [upgradeA] = await env.cpDb
      .insert(companyMemoryUpgrades)
      .values({
        companyId: env.company.id,
        state: "flipping",
        leaseToken: "valid-token-a",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        converterId: "paperclip.memory-upgrade.atomic-converter",
        converterVersion: 1,
        collectionName: "mem0_memories",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
      })
      .returning();

    await assert.rejects(
      () =>
        setScopeMigrationMarkerFenced(env.cpWorkerDb, {
          upgradeId: upgradeA.id,
          leaseToken: "valid-token-a",
          companyId: companyBId,
          mode: "copy",
        }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
    );

    // Verify neither company's marker changed
    const [rowA] = await env.cpDb
      .select({ completedAt: companyMemoryDatabases.scopeMigrationCompletedAt })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(rowA.completedAt, null, "Company A marker must remain NULL");

    const [rowB] = await env.cpDb
      .select({ completedAt: companyMemoryDatabases.scopeMigrationCompletedAt })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyBId));
    assert.equal(rowB.completedAt, null, "Company B marker must remain NULL");

    await env.cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgradeA.id));
  });

  // 2. Regression: expired-by-DB lease even when params.now is earlier refuses
  await t.test("regression: lease expired by DB clock refuses even when params.now claims earlier", async () => {
    const pastExpiry = new Date(Date.now() - 10_000);
    const [expiredUpgrade] = await env.cpDb
      .insert(companyMemoryUpgrades)
      .values({
        companyId: env.company.id,
        state: "flipping",
        leaseToken: "token-past-expiry",
        leaseExpiresAt: pastExpiry,
        converterId: "paperclip.memory-upgrade.atomic-converter",
        converterVersion: 1,
        collectionName: "mem0_memories",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
      })
      .returning();

    const earlierSimulatedNow = new Date(Date.now() - 20_000);

    await assert.rejects(
      () =>
        setScopeMigrationMarkerFenced(env.cpWorkerDb, {
          upgradeId: expiredUpgrade.id,
          leaseToken: "token-past-expiry",
          companyId: env.company.id,
          mode: "copy",
          now: earlierSimulatedNow,
        }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
    );

    const [dbRow] = await env.cpDb
      .select({ completedAt: companyMemoryDatabases.scopeMigrationCompletedAt })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, env.company.id));
    assert.equal(dbRow.completedAt, null, "Marker must remain NULL when lease is expired by DB clock");

    await env.cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, expiredUpgrade.id));
  });
});
