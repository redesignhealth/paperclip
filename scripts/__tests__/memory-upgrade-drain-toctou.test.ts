/**
 * Regressions for under-lease revalidation and TOCTOU window protection (TECH-8191 §Q3, PR5.7 RC-2 Change B).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runDrain } from "../../server/src/services/company-memory-upgrade/drain.js";
import {
  claimUpgradeLease,
  releaseUpgradeLease,
} from "../../server/src/services/company-memory-upgrade/state-machine.js";
import { claimTenantFenceGuarded } from "../../server/src/services/company-memory-upgrade/tenant-fence.js";
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

test("drain under-lease revalidation TOCTOU regressions (Change B)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("drain-toctou");
  t.after(async () => {
    await env.cleanup();
  });

  const [t0Row] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
  const t0 = t0Row.t instanceof Date ? t0Row.t : new Date(t0Row.t);
  const markedAt = new Date(t0.getTime() - 30 * 60_000);
  const observedAt = new Date(t0.getTime() - 25 * 60_000);

  await env.cpDb
    .update(companyMemoryDatabases)
    .set({
      scopeMigrationCompletedAt: markedAt,
      scopeMigrationMode: "copy",
      scopeMigrationAgentScopeObservedAt: observedAt,
      updatedAt: markedAt,
    })
    .where(eq(companyMemoryDatabases.companyId, env.company.id));

  const [upgrade] = await env.cpDb
    .insert(companyMemoryUpgrades)
    .values({
      companyId: env.company.id,
      state: "draining",
      converterId: "paperclip.memory-upgrade.atomic-converter",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      markedAt,
      drainProbeStreakStartedAt: null,
      drainConfirmedAt: null,
    })
    .returning();

  // 1. Sweep between probe and claim:
  // Streak back-dated 11 min so probe would confirm; hook mutates via fence claim;
  // drain detects invalidation under lease and writes nothing.
  await t.test("sweep between probe and claim invalidates evidence: drain writes nothing", async () => {
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '11 minutes', drain_confirmed_at = null WHERE id = ${upgrade.id}`,
    );

    const hook = async () => {
      const [nowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
      const dbNow = nowRow.t instanceof Date ? nowRow.t : new Date(nowRow.t);
      const claim = await claimUpgradeLease(env.cpDb, {
        upgradeId: upgrade.id,
        leaseOwner: "interleaving_mutator",
        now: dbNow,
      });
      assert.ok(claim.acquired && claim.leaseToken);
      await claimTenantFenceGuarded(env.cpDb, env.tenantSql, {
        upgradeId: upgrade.id,
        cpLeaseToken: claim.leaseToken,
        leaseOwner: "interleaving_mutator",
        allowedStates: new Set(["draining"]),
      });
      await releaseUpgradeLease(env.cpDb, upgrade.id, claim.leaseToken);
    };

    const report = await runDrain(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        once: true,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalLoopHook: hook,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    assert.equal(report.confirmed, false);
    assert.equal(report.counts, false);
    assert.equal(report.evidenceInvalidated, true);
    assert.ok(report.blockedBy.includes("evidence_invalidated_by_concurrent_work"));

    const [after] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    // drain wrote nothing: streak remains null (left by fence claim), confirmed remains null
    assert.equal(after.drainProbeStreakStartedAt, null);
    assert.equal(after.drainConfirmedAt, null);
  });

  // 2. Mutator still holding lease at claim time:
  // Hook claims and does not release; --once throws LEASE_FENCED_OUT
  await t.test("mutator still holding lease at claim time throws LEASE_FENCED_OUT in --once", async () => {
    let heldToken: string | null = null;
    const hook = async () => {
      const [nowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
      const dbNow = nowRow.t instanceof Date ? nowRow.t : new Date(nowRow.t);
      const claim = await claimUpgradeLease(env.cpDb, {
        upgradeId: upgrade.id,
        leaseOwner: "still_holding_mutator",
        now: dbNow,
        ttlMs: 60_000,
      });
      assert.ok(claim.acquired && claim.leaseToken);
      heldToken = claim.leaseToken;
      await claimTenantFenceGuarded(env.cpDb, env.tenantSql, {
        upgradeId: upgrade.id,
        cpLeaseToken: claim.leaseToken,
        leaseOwner: "still_holding_mutator",
        allowedStates: new Set(["draining"]),
      });
    };

    try {
      await assert.rejects(
        () =>
          runDrain(
            {
              companyId: env.company.id,
              confirm: env.company.id,
              once: true,
              tenantDatabaseUrl: "postgres://unused",
              controlPlaneDatabaseUrl: "postgres://unused",
            },
            {
              cpDb: env.cpWorkerDb,
              tenantSql: env.tenantWorkerSql,
              _internalLoopHook: hook,
              _internalSkipVectorIdentityCheck: true,
            },
          ),
        (err: any) =>
          err instanceof CompanyMemoryUpgradeError &&
          err.code === "LEASE_FENCED_OUT",
      );
    } finally {
      if (heldToken) {
        await releaseUpgradeLease(env.cpDb, upgrade.id, heldToken);
      }
    }
  });

  // 3. ABA null->null case:
  // Streak null before probe; hook bumps fence and releases;
  // new streak start is sourced from write-time DB clock (>= fence claimed_at)
  await t.test("ABA null->null case: new streak start is sourced from write-time DB clock", async () => {
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = null, drain_confirmed_at = null WHERE id = ${upgrade.id}`,
    );

    let fenceClaimedAt: Date | null = null;
    const hook = async () => {
      const [nowRow] = (await env.cpDb.execute(sql`SELECT clock_timestamp() AS t`)) as unknown as Array<{ t: Date | string }>;
      const dbNow = nowRow.t instanceof Date ? nowRow.t : new Date(nowRow.t);
      const claim = await claimUpgradeLease(env.cpDb, {
        upgradeId: upgrade.id,
        leaseOwner: "aba_mutator",
        now: dbNow,
      });
      assert.ok(claim.acquired && claim.leaseToken);
      await claimTenantFenceGuarded(env.cpDb, env.tenantSql, {
        upgradeId: upgrade.id,
        cpLeaseToken: claim.leaseToken,
        leaseOwner: "aba_mutator",
        allowedStates: new Set(["draining"]),
      });
      await releaseUpgradeLease(env.cpDb, upgrade.id, claim.leaseToken);

      const [fenceRow] = await env.tenantSql`
        SELECT claimed_at FROM paperclip_memory_upgrade_fence WHERE upgrade_id = ${upgrade.id}::uuid
      `;
      fenceClaimedAt = fenceRow.claimed_at instanceof Date ? fenceRow.claimed_at : new Date(fenceRow.claimed_at);
    };

    const report = await runDrain(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        once: true,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalLoopHook: hook,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    assert.equal(report.confirmed, false);
    assert.ok(report.streakStartedAt instanceof Date);
    assert.ok(fenceClaimedAt instanceof Date);

    // Stored streak start must be >= fence claimed_at, proving write-time clock sourcing
    const [after] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.ok(after.drainProbeStreakStartedAt instanceof Date);
    assert.ok(
      after.drainProbeStreakStartedAt.getTime() >= fenceClaimedAt.getTime(),
      `Expected streak start ${after.drainProbeStreakStartedAt.toISOString()} >= fence claimed_at ${fenceClaimedAt.toISOString()}`,
    );
  });

  // 4. No false positives: normal execution confirms cleanly when no mutator intervenes
  await t.test("no false positives: normal execution confirms cleanly when unperturbed", async () => {
    await env.cpDb.execute(
      sql`UPDATE company_memory_upgrades SET drain_probe_streak_started_at = clock_timestamp() - interval '11 minutes', drain_confirmed_at = null WHERE id = ${upgrade.id}`,
    );

    const report = await runDrain(
      {
        companyId: env.company.id,
        confirm: env.company.id,
        once: true,
        tenantDatabaseUrl: "postgres://unused",
        controlPlaneDatabaseUrl: "postgres://unused",
      },
      {
        cpDb: env.cpWorkerDb,
        tenantSql: env.tenantWorkerSql,
        _internalSkipVectorIdentityCheck: true,
      },
    );

    assert.equal(report.confirmed, true);
    assert.equal(report.counts, true);
    assert.equal(report.evidenceInvalidated, false);
    assert.ok(report.confirmedAt instanceof Date);

    const [after] = await env.cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.ok(after.drainConfirmedAt instanceof Date);
  });
});
