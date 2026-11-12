/**
 * Unit tests for tenant fence durable invalidation in draining state (TECH-8191 §Q3, PR5.7 Change A1).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  companies,
  companyMemoryUpgrades,
  createDb,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { claimUpgradeLease, openUpgrade } from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { ensureUpgradeTables, openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { claimTenantFenceGuarded } from "../../server/src/services/company-memory-upgrade/tenant-fence.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("tenant-fence draining streak invalidation (Change A1)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("fence-streak-");
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
    .values({ name: "Fence Streak Co", issuePrefix: "FSC" })
    .returning();

  // 1. allowedStates = {"draining"} + state draining:
  // Both drain fields cleared, updated_at advanced, fence epoch bumped.
  await t.test("allowedStates = {draining} in state draining clears streak and confirmed, advances updated_at", async () => {
    const [co1] = await cpDb
      .insert(companies)
      .values({ name: "Fence Streak Co 1", issuePrefix: "F1" })
      .returning();

    const upgrade = await openUpgrade(cpDb, {
      companyId: co1.id,
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const streakTime = new Date("2026-11-11T10:00:00.000Z");
    const confirmedTime = new Date("2026-11-11T10:15:00.000Z");
    const oldUpdatedAt = new Date("2026-11-11T09:00:00.000Z");

    await cpDb
      .update(companyMemoryUpgrades)
      .set({
        state: "draining",
        drainProbeStreakStartedAt: streakTime,
        drainConfirmedAt: confirmedTime,
        updatedAt: oldUpdatedAt,
      })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    const claim = await claimUpgradeLease(cpDb, {
      upgradeId: upgrade.id,
      leaseOwner: "mutator-worker",
    });
    assert.ok(claim.acquired && claim.leaseToken);

    const fence = await claimTenantFenceGuarded(cpDb, tenantSql, {
      upgradeId: upgrade.id,
      cpLeaseToken: claim.leaseToken,
      leaseOwner: "mutator-worker",
      allowedStates: new Set(["draining"]),
    });
    assert.ok(fence);
    assert.equal(fence.fenceEpoch, "1");

    const [after] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    assert.equal(after.drainProbeStreakStartedAt, null);
    assert.equal(after.drainConfirmedAt, null);
    assert.ok(after.updatedAt > oldUpdatedAt);
  });

  // 2. Default allowed states ({"sweeping"}) => branch unreachable for sweeping upgrades;
  // streak fields untouched.
  await t.test("default allowedStates ({sweeping}) leaves streak fields untouched on sweeping upgrade", async () => {
    const [co2] = await cpDb
      .insert(companies)
      .values({ name: "Fence Streak Co 2", issuePrefix: "F2" })
      .returning();

    const upgrade = await openUpgrade(cpDb, {
      companyId: co2.id,
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const streakTime = new Date("2026-11-11T10:00:00.000Z");
    const confirmedTime = new Date("2026-11-11T10:15:00.000Z");

    await cpDb
      .update(companyMemoryUpgrades)
      .set({
        state: "sweeping",
        drainProbeStreakStartedAt: streakTime,
        drainConfirmedAt: confirmedTime,
      })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    const claim = await claimUpgradeLease(cpDb, {
      upgradeId: upgrade.id,
      leaseOwner: "sweeper-worker",
    });
    assert.ok(claim.acquired && claim.leaseToken);

    // Call without explicit allowedStates => uses DEFAULT_FENCE_ALLOWED_STATES = {"sweeping"}
    const fence = await claimTenantFenceGuarded(cpDb, tenantSql, {
      upgradeId: upgrade.id,
      cpLeaseToken: claim.leaseToken,
      leaseOwner: "sweeper-worker",
    });
    assert.ok(fence);

    const [after] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    assert.equal(after.drainProbeStreakStartedAt?.toISOString(), streakTime.toISOString());
    assert.equal(after.drainConfirmedAt?.toISOString(), confirmedTime.toISOString());
  });

  // 3. CP lease token mismatch => throws LEASE_FENCED_OUT before any clear
  await t.test("lease token mismatch throws LEASE_FENCED_OUT and leaves drain fields untouched", async () => {
    const [co3] = await cpDb
      .insert(companies)
      .values({ name: "Fence Streak Co 3", issuePrefix: "F3" })
      .returning();

    const upgrade = await openUpgrade(cpDb, {
      companyId: co3.id,
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const streakTime = new Date("2026-11-11T10:00:00.000Z");
    const confirmedTime = new Date("2026-11-11T10:15:00.000Z");

    await cpDb
      .update(companyMemoryUpgrades)
      .set({
        state: "draining",
        drainProbeStreakStartedAt: streakTime,
        drainConfirmedAt: confirmedTime,
      })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    const claim = await claimUpgradeLease(cpDb, {
      upgradeId: upgrade.id,
      leaseOwner: "draining-worker",
    });
    assert.ok(claim.acquired && claim.leaseToken);

    await assert.rejects(
      () =>
        claimTenantFenceGuarded(cpDb, tenantSql, {
          upgradeId: upgrade.id,
          cpLeaseToken: "wrong-lease-token",
          leaseOwner: "draining-worker",
          allowedStates: new Set(["draining"]),
        }),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
    );

    const [after] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    assert.equal(after.drainProbeStreakStartedAt?.toISOString(), streakTime.toISOString());
    assert.equal(after.drainConfirmedAt?.toISOString(), confirmedTime.toISOString());
  });

  // 4. Tenant claim failure => CP tx rolls back => drain fields untouched
  await t.test("tenant claim failure rolls back CP transaction, leaving drain fields untouched", async () => {
    const [co4] = await cpDb
      .insert(companies)
      .values({ name: "Fence Streak Co 4", issuePrefix: "F4" })
      .returning();

    const upgrade = await openUpgrade(cpDb, {
      companyId: co4.id,
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const streakTime = new Date("2026-11-11T10:00:00.000Z");
    const confirmedTime = new Date("2026-11-11T10:15:00.000Z");

    await cpDb
      .update(companyMemoryUpgrades)
      .set({
        state: "draining",
        drainProbeStreakStartedAt: streakTime,
        drainConfirmedAt: confirmedTime,
      })
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    const claim = await claimUpgradeLease(cpDb, {
      upgradeId: upgrade.id,
      leaseOwner: "draining-worker-2",
    });
    assert.ok(claim.acquired && claim.leaseToken);

    const poisonedTenantSql = {
      begin: async () => {
        const err = new Error("simulated tenant database failure");
        (err as any).code = "57014";
        throw err;
      },
    } as any;

    await assert.rejects(
      () =>
        claimTenantFenceGuarded(cpDb, poisonedTenantSql, {
          upgradeId: upgrade.id,
          cpLeaseToken: claim.leaseToken!,
          leaseOwner: "draining-worker-2",
          allowedStates: new Set(["draining"]),
        }),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError && err.code === "TENANT_FENCE_CLAIM_FAILED",
    );

    const [after] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));

    assert.equal(after.drainProbeStreakStartedAt?.toISOString(), streakTime.toISOString());
    assert.equal(after.drainConfirmedAt?.toISOString(), confirmedTime.toISOString());
  });
});
