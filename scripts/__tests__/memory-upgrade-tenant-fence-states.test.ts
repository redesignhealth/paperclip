/**
 * Tests for tenant fence allowed states (TECH-8191 §5.2).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { claimUpgradeLease, openUpgrade } from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { claimTenantFenceGuarded } from "../../server/src/services/company-memory-upgrade/tenant-fence.js";
import { ensureUpgradeTables, openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { UPGRADE_WORK_STATES } from "../../server/src/services/company-memory-upgrade/phases.js";
import { CompanyMemoryUpgradeError, type UpgradeState } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  companies,
  companyMemoryUpgrades,
  createDb,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("tenant fence allowed states: default sweeping-only vs UPGRADE_WORK_STATES", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("fence-states-");
  const cpDb = createDb(fixture.connectionString);
  const tenantSql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await cpDb.$client?.end();
    await fixture.cleanup();
  });

  await ensureUpgradeTables(tenantSql, "text");

  const [company] = await cpDb
    .insert(companies)
    .values({ name: "Fence State Co", issuePrefix: "FS" })
    .returning();

  const upgrade = await openUpgrade(cpDb, {
    companyId: company.id,
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  });

  const claim = await claimUpgradeLease(cpDb, { upgradeId: upgrade.id, leaseOwner: "test-worker" });
  assert.ok(claim.acquired && claim.leaseToken);
  const leaseToken = claim.leaseToken;

  // 1. In 'sweeping' state:
  const f1 = await claimTenantFenceGuarded(cpDb, tenantSql, {
    upgradeId: upgrade.id,
    cpLeaseToken: leaseToken,
    leaseOwner: "test-worker",
  });
  assert.equal(f1.fenceEpoch, "1");

  const f2 = await claimTenantFenceGuarded(cpDb, tenantSql, {
    upgradeId: upgrade.id,
    cpLeaseToken: leaseToken,
    leaseOwner: "test-worker",
    allowedStates: UPGRADE_WORK_STATES,
  });
  assert.equal(f2.fenceEpoch, "2");

  // 2. Transition upgrade to 'draining'
  await cpDb
    .update(companyMemoryUpgrades)
    .set({ state: "draining" })
    .where(eq(companyMemoryUpgrades.id, upgrade.id));

  // Default (omitted allowedStates) refuses 'draining' with LEASE_FENCED_OUT
  await assert.rejects(
    () =>
      claimTenantFenceGuarded(cpDb, tenantSql, {
        upgradeId: upgrade.id,
        cpLeaseToken: leaseToken,
        leaseOwner: "test-worker",
      }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );

  // Observed 'sweeping' singleton refuses 'draining' with LEASE_FENCED_OUT
  await assert.rejects(
    () =>
      claimTenantFenceGuarded(cpDb, tenantSql, {
        upgradeId: upgrade.id,
        cpLeaseToken: leaseToken,
        leaseOwner: "test-worker",
        allowedStates: new Set(["sweeping"]),
      }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );

  // Observed 'draining' singleton accepts 'draining' and bumps epoch
  const f3 = await claimTenantFenceGuarded(cpDb, tenantSql, {
    upgradeId: upgrade.id,
    cpLeaseToken: leaseToken,
    leaseOwner: "test-worker",
    allowedStates: new Set(["draining"]),
  });
  assert.equal(f3.fenceEpoch, "3");

  // 3. Disallowed states refuse even when UPGRADE_WORK_STATES is passed
  const disallowedStates: UpgradeState[] = [
    "flipping", "verified", "pruning", "completed", "aborted", "rolled_back", "needs_recovery",
  ];

  for (const st of disallowedStates) {
    await cpDb
      .update(companyMemoryUpgrades)
      .set({ state: st })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    await assert.rejects(
      () =>
        claimTenantFenceGuarded(cpDb, tenantSql, {
          upgradeId: upgrade.id,
          cpLeaseToken: leaseToken,
          leaseOwner: "test-worker",
          allowedStates: UPGRADE_WORK_STATES,
        }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
      `State ${st} must be refused even with UPGRADE_WORK_STATES`,
    );
  }
});
