/**
 * Tenant write-fencing and concurrency tests for company memory upgrade sweep (TECH-8191).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  claimUpgradeLease,
  openUpgrade,
} from "../../server/src/services/company-memory-upgrade/state-machine.js";
import {
  acquireSourceAdvisoryLock,
  claimTenantFenceGuarded,
} from "../../server/src/services/company-memory-upgrade/tenant-fence.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import {
  commitSourceOutcome,
  ensureUpgradeTables,
  openTenantClient,
  reconcileChangedContent,
  reconcileTombstones,
  stageSourceRecords,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { computeRecordDataSha256 } from "../../server/src/services/company-memory-upgrade/converter-contract.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  companies,
  companyMemoryUpgrades,
  createDb,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

function dummyStageItem() {
  const data = `Durable fact ${randomUUID()}`;
  return {
    outputId: randomUUID(),
    dataSha256: computeRecordDataSha256(data),
    payload: { data },
    embedding: new Array(1536).fill(0.01),
  };
}

test("tenant fence: epoch takeover rejects ALL mutation functions for the stale writer, with no partial writes", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("fence-takeover-");
  const sqlClient = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sqlClient.end();
    await fixture.cleanup();
  });

  await ensureUpgradeTables(sqlClient, "text");

  const upgradeId = randomUUID();
  const agentId = randomUUID();
  const sourceId = randomUUID();

  // Worker A claims first (epoch 1).
  const fenceA = await claimTenantFenceForTestSetup(sqlClient, upgradeId, "worker-a");
  assert.equal(fenceA.fenceEpoch, "1");

  // Worker B (the "successor") claims next (epoch 2), unconditionally superseding A.
  const fenceB = await claimTenantFenceForTestSetup(sqlClient, upgradeId, "worker-b");
  assert.equal(fenceB.fenceEpoch, "2");
  assert.notEqual(fenceB.leaseToken, fenceA.leaseToken);

  // Seed one real ledger row (committed under the CURRENT fence B) so reconcileTombstones
  // below has an actual tombstone candidate to validate the fence against -- otherwise it
  // would short-circuit as a no-op before ever reaching its per-batch fence check.
  const tombstoneCandidateId = randomUUID();
  await commitSourceOutcome(
    sqlClient,
    {
      upgradeId,
      sourceId: tombstoneCandidateId,
      sourceContentSha256: "hash-tombstone-candidate",
      agentId,
      outcome: "dropped_noise",
      reasonCode: "empty",
    },
    fenceB,
  );

  // Baseline row counts before any stale-fenced attempt.
  const ledgerCountBefore = await sqlClient`SELECT count(*)::int AS count FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${upgradeId}::uuid`;
  const stagingCountBefore = await sqlClient`SELECT count(*)::int AS count FROM paperclip_memory_upgrade_staging WHERE upgrade_id = ${upgradeId}::uuid`;

  // Every mutation function must reject the STALE fence A (epoch 1, superseded) with
  // LEASE_FENCED_OUT, and must not have written anything.
  await assert.rejects(
    () =>
      commitSourceOutcome(
        sqlClient,
        {
          upgradeId,
          sourceId,
          sourceContentSha256: "hash-stale",
          agentId,
          outcome: "unroutable",
          reasonCode: "missing_agent_id",
        },
        fenceA,
      ),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );

  await assert.rejects(
    () =>
      stageSourceRecords(
        sqlClient,
        {
          upgradeId,
          sourceId,
          sourceContentSha256: "hash-stale",
          agentId,
          records: [dummyStageItem()],
          vectorType: "text",
        },
        fenceA,
      ),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );

  await assert.rejects(
    () => reconcileChangedContent(sqlClient, upgradeId, sourceId, fenceA),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );

  await assert.rejects(
    () => reconcileTombstones(sqlClient, upgradeId, { tombstoneSourceIds: [tombstoneCandidateId] }, fenceA),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );

  // No row was written or changed by ANY of the above rejected (rolled back) attempts,
  // including the seeded tombstone candidate itself (it must still be 'dropped_noise',
  // NOT 'source_deleted').
  const ledgerCountAfter = await sqlClient`SELECT count(*)::int AS count FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${upgradeId}::uuid`;
  const stagingCountAfter = await sqlClient`SELECT count(*)::int AS count FROM paperclip_memory_upgrade_staging WHERE upgrade_id = ${upgradeId}::uuid`;
  assert.equal(ledgerCountAfter[0].count, ledgerCountBefore[0].count);
  assert.equal(stagingCountAfter[0].count, stagingCountBefore[0].count);
  const [candidateRow] = await sqlClient`SELECT outcome FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${tombstoneCandidateId}::uuid`;
  assert.equal(candidateRow.outcome, "dropped_noise");

  // The CURRENT fence (B) still works correctly for every mutation function.
  await commitSourceOutcome(
    sqlClient,
    {
      upgradeId,
      sourceId,
      sourceContentSha256: "hash-current",
      agentId,
      outcome: "unroutable",
      reasonCode: "missing_agent_id",
    },
    fenceB,
  );
  const [row] = await sqlClient`SELECT outcome FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid`;
  assert.equal(row.outcome, "unroutable");
});

test("tenant fence: same source, two concurrent separate clients -- no orphaned staging, no duplicate dedupe wins, no deadlocks", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("fence-concurrent-");
  const sqlClientA = openTenantClient(fixture.connectionString, { max: 2 });
  const sqlClientB = openTenantClient(fixture.connectionString, { max: 2 });
  const sqlClientBarrier = openTenantClient(fixture.connectionString, { max: 2 });

  t.after(async () => {
    await sqlClientBarrier.end();
    await sqlClientA.end();
    await sqlClientB.end();
    await fixture.cleanup();
  });

  await ensureUpgradeTables(sqlClientA, "text");

  const upgradeId = randomUUID();
  const agentId = randomUUID();
  const sourceId = randomUUID();
  const fence = await claimTenantFenceForTestSetup(sqlClientA, upgradeId, "shared-owner");

  // Open a third client, take the L1 advisory lock on (upgradeId, sourceId) before
  // launching the concurrent writers, and assert both remain blocked until the barrier releases.
  let barrierAcquired: () => void;
  const barrierReady = new Promise<void>((r) => { barrierAcquired = r; });
  let releaseBarrier: () => void;
  const barrierHold = new Promise<void>((r) => { releaseBarrier = r; });

  const barrierTx = sqlClientBarrier.begin(async (tx) => {
    await acquireSourceAdvisoryLock(tx, upgradeId, sourceId);
    barrierAcquired();
    await barrierHold;
  });
  await barrierReady;

  // Two fully separate postgres.js client connections racing stageSourceRecords for the
  // SAME source concurrently. The per-source advisory lock (L1) must fully serialize
  // these two transactions against each other -- neither hangs (deadlock), and the
  // result is consistent: exactly one source_id row in the ledger, output_ids fully
  // referencing whatever ended up staged, no orphaned staging rows.
  const dataA = "Concurrent durable fact variant A for source race.";
  const dataB = "Concurrent durable fact variant B for source race.";

  let eitherSettled = false;
  const callA = stageSourceRecords(
    sqlClientA,
    {
      upgradeId,
      sourceId,
      sourceContentSha256: "hash-race",
      agentId,
      records: [
        {
          outputId: randomUUID(),
          dataSha256: computeRecordDataSha256(dataA),
          payload: { data: dataA },
          embedding: new Array(1536).fill(0.02),
        },
      ],
      vectorType: "text",
    },
    fence,
  ).finally(() => {
    eitherSettled = true;
  });

  const callB = stageSourceRecords(
    sqlClientB,
    {
      upgradeId,
      sourceId,
      sourceContentSha256: "hash-race",
      agentId,
      records: [
        {
          outputId: randomUUID(),
          dataSha256: computeRecordDataSha256(dataB),
          payload: { data: dataB },
          embedding: new Array(1536).fill(0.03),
        },
      ],
      vectorType: "text",
    },
    fence,
  ).finally(() => {
    eitherSettled = true;
  });

  // Assert both writers are still pending while the barrier holds L1
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(eitherSettled, false, "both concurrent writers must be blocked waiting on L1 advisory lock held by barrier");

  // Release the barrier
  releaseBarrier!();
  await barrierTx;

  const results = await Promise.race([
    Promise.all([callA, callB]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("DEADLOCK/TIMEOUT: concurrent same-source writers never completed")), 15_000).unref?.(),
    ),
  ]);

  assert.equal(results.length, 2);

  // Exactly one ledger row for this source (the LAST writer's upsert wins the row, by
  // design of the per-source serialization -- there is no race to lose a ledger row to).
  const ledgerRows = await sqlClientA`
    SELECT output_ids FROM paperclip_memory_upgrade_ledger
    WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
  `;
  assert.equal(ledgerRows.length, 1);

  // LEDGER INVARIANT: every staging row for this source is referenced by the ledger row's
  // output_ids (no orphans), and vice versa (no dangling ids pointing at deleted staging).
  const stagingRows = await sqlClientA`
    SELECT output_id FROM paperclip_memory_upgrade_staging
    WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
  `;
  const stagingIds = stagingRows.map((r: any) => r.output_id).sort();
  const ledgerIds = [...ledgerRows[0].output_ids].sort();
  assert.deepEqual(stagingIds, ledgerIds, "every staging output must be referenced in the source ledger, with no orphans");
  assert.equal(stagingIds.length, 1, "the second writer's delete-then-insert must have superseded the first, not duplicated it");
});

test("tenant fence: claimTenantFenceGuarded refuses a DELAYED/STALE claimant whose CP admission was already superseded (no epoch bump)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("fence-delayed-cp-");
  const cpDb = createDb(cpFixture.connectionString);

  const tenantFixture = await startEmbeddedPostgresTestDatabase("fence-delayed-tenant-");
  const tenantSql = openTenantClient(tenantFixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await cpDb.$client?.end();
    await tenantFixture.cleanup();
    await cpFixture.cleanup();
  });

  await ensureUpgradeTables(tenantSql, "text");

  const [company] = await cpDb.insert(companies).values({
    name: "Delayed Claimant Co",
    issuePrefix: "DC",
  }).returning();

  const upgrade = await openUpgrade(cpDb, {
    companyId: company.id,
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  });

  // Worker A (the eventually-delayed/stale worker) claims the CP lease first.
  const claimA = await claimUpgradeLease(cpDb, { upgradeId: upgrade.id, leaseOwner: "worker-a" });
  assert.ok(claimA.acquired && claimA.leaseToken);

  // Worker A successfully claims the tenant fence while it is still the legitimate holder.
  const fenceA = await claimTenantFenceGuarded(cpDb, tenantSql, {
    upgradeId: upgrade.id,
    cpLeaseToken: claimA.leaseToken!,
    leaseOwner: "worker-a",
  });
  assert.equal(fenceA.fenceEpoch, "1");

  // Simulate the real-world sequence that supersedes A: A's lease is force-expired (as the
  // CP lease reconciler would do once it lapses), and Worker B is admitted with a NEW lease
  // token for the SAME upgrade (still in 'sweeping' -- a fresh claimUpgradeLease covers both
  // the "normal re-claim after expiry" and "post-recovery re-claim" cases, since both mint a
  // new token the same way).
  await cpDb
    .update(companyMemoryUpgrades)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(companyMemoryUpgrades.id, upgrade.id));

  const claimB = await claimUpgradeLease(cpDb, { upgradeId: upgrade.id, leaseOwner: "worker-b" });
  assert.ok(claimB.acquired && claimB.leaseToken);
  assert.notEqual(claimB.leaseToken, claimA.leaseToken);

  // Worker B (the legitimate successor) claims the tenant fence and bumps the epoch.
  const fenceB = await claimTenantFenceGuarded(cpDb, tenantSql, {
    upgradeId: upgrade.id,
    cpLeaseToken: claimB.leaseToken!,
    leaseOwner: "worker-b",
  });
  assert.equal(fenceB.fenceEpoch, "2");

  // THE race this test exists to catch: Worker A, having been stalled this whole time,
  // finally wakes up and tries to claim the tenant fence using its OWN (by now invalidated)
  // CP lease token. This must be REFUSED outright -- Worker A can never supersede Worker B
  // after the fact, no matter how the claim is attempted.
  await assert.rejects(
    () =>
      claimTenantFenceGuarded(cpDb, tenantSql, {
        upgradeId: upgrade.id,
        cpLeaseToken: claimA.leaseToken!,
        leaseOwner: "worker-a",
      }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );

  // Confirm the epoch was NOT bumped by Worker A's refused attempt: it is still exactly
  // what Worker B left it at.
  const [fenceRow] = await tenantSql`
    SELECT fence_epoch::text AS fence_epoch, lease_token
    FROM paperclip_memory_upgrade_fence
    WHERE upgrade_id = ${upgrade.id}::uuid;
  `;
  assert.equal(fenceRow.fence_epoch, "2");
  assert.equal(fenceRow.lease_token, fenceB.leaseToken);
});

test("tenant fence: claimTenantFenceGuarded succeeds for the current legitimate CP lease holder and bumps the epoch", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("fence-happy-cp-");
  const cpDb = createDb(cpFixture.connectionString);

  const tenantFixture = await startEmbeddedPostgresTestDatabase("fence-happy-tenant-");
  const tenantSql = openTenantClient(tenantFixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await cpDb.$client?.end();
    await tenantFixture.cleanup();
    await cpFixture.cleanup();
  });

  await ensureUpgradeTables(tenantSql, "text");

  const [company] = await cpDb.insert(companies).values({
    name: "Happy Claimant Co",
    issuePrefix: "HC",
  }).returning();

  const upgrade = await openUpgrade(cpDb, {
    companyId: company.id,
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  });

  const claim = await claimUpgradeLease(cpDb, { upgradeId: upgrade.id, leaseOwner: "solo-worker" });
  assert.ok(claim.acquired && claim.leaseToken);

  const fence1 = await claimTenantFenceGuarded(cpDb, tenantSql, {
    upgradeId: upgrade.id,
    cpLeaseToken: claim.leaseToken!,
    leaseOwner: "solo-worker",
  });
  assert.equal(fence1.fenceEpoch, "1");

  // Re-claiming with the SAME still-valid CP lease token bumps the epoch again (e.g. a
  // worker restarting mid-sweep with the same lease) -- never a no-op, always a fresh token.
  const fence2 = await claimTenantFenceGuarded(cpDb, tenantSql, {
    upgradeId: upgrade.id,
    cpLeaseToken: claim.leaseToken!,
    leaseOwner: "solo-worker",
  });
  assert.equal(fence2.fenceEpoch, "2");
  assert.notEqual(fence2.leaseToken, fence1.leaseToken);

  // A bogus/mismatched CP lease token is refused without bumping the epoch.
  await assert.rejects(
    () =>
      claimTenantFenceGuarded(cpDb, tenantSql, {
        upgradeId: upgrade.id,
        cpLeaseToken: randomUUID(),
        leaseOwner: "impersonator",
      }),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "LEASE_FENCED_OUT",
  );
  const [fenceRow] = await tenantSql`
    SELECT fence_epoch::text AS fence_epoch FROM paperclip_memory_upgrade_fence WHERE upgrade_id = ${upgrade.id}::uuid;
  `;
  assert.equal(fenceRow.fence_epoch, "2");
});

test("tenant fence claim error mapping and timeouts (F1/F2)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("fence-f1f2-cp-");
  const cpDb = createDb(cpFixture.connectionString);

  t.after(async () => {
    await cpDb.$client?.end();
    await cpFixture.cleanup();
  });

  const [company] = await cpDb.insert(companies).values({
    name: "Error Mapping Co",
    issuePrefix: "EM",
  }).returning();

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

  // 1. tenant begin throws { code: "57014" } -> LEASE_FENCED_OUT, err.cause preserved, no driver text in message
  const fakeTenantSql57014 = {
    begin: async () => {
      const err = new Error("canceling statement due to statement timeout (driver specific details)");
      (err as any).code = "57014";
      throw err;
    },
  } as any;

  await assert.rejects(
    () =>
      claimTenantFenceGuarded(cpDb, fakeTenantSql57014, {
        upgradeId: upgrade.id,
        cpLeaseToken: claim.leaseToken!,
        leaseOwner: "test-worker",
      }),
    (err: any) => {
      assert.ok(err instanceof CompanyMemoryUpgradeError);
      assert.equal(err.code, "LEASE_FENCED_OUT");
      assert.ok(err.cause);
      assert.equal((err.cause as any).code, "57014");
      assert.ok(!err.message.includes("canceling statement"));
      return true;
    },
  );

  // 2. tenant begin throws { code: "42501" } -> TENANT_FENCE_CLAIM_FAILED, cause preserved, fixed message
  const fakeTenantSql42501 = {
    begin: async () => {
      const err = new Error("permission denied for table paperclip_memory_upgrade_fence (internal role info)");
      (err as any).code = "42501";
      throw err;
    },
  } as any;

  await assert.rejects(
    () =>
      claimTenantFenceGuarded(cpDb, fakeTenantSql42501, {
        upgradeId: upgrade.id,
        cpLeaseToken: claim.leaseToken!,
        leaseOwner: "test-worker",
      }),
    (err: any) => {
      assert.ok(err instanceof CompanyMemoryUpgradeError);
      assert.equal(err.code, "TENANT_FENCE_CLAIM_FAILED");
      assert.ok(err.cause);
      assert.equal((err.cause as any).code, "42501");
      assert.ok(!err.message.includes("permission denied"));
      return true;
    },
  );

  // 3. tenant begin returns a never-settling promise, boundMs: 200 -> rejects TENANT_FENCE_CLAIM_FAILED in < 1s
  // and CP row lock is released immediately (verified by SELECT ... FOR UPDATE NOWAIT)
  const fakeTenantSqlStall = {
    begin: () => new Promise(() => {}),
  } as any;

  const startMs = Date.now();
  await assert.rejects(
    () =>
      claimTenantFenceGuarded(cpDb, fakeTenantSqlStall, {
        upgradeId: upgrade.id,
        cpLeaseToken: claim.leaseToken!,
        leaseOwner: "test-worker",
        boundMs: 200,
      }),
    (err: any) => {
      assert.ok(err instanceof CompanyMemoryUpgradeError);
      assert.equal(err.code, "TENANT_FENCE_CLAIM_FAILED");
      return true;
    },
  );
  const elapsedMs = Date.now() - startMs;
  assert.ok(elapsedMs < 1000, `Expected rejection in well under a second, took ${elapsedMs}ms`);

  // Immediately afterwards a second CP connection can SELECT ... FOR UPDATE NOWAIT without error
  const cpClient2 = openTenantClient(cpFixture.connectionString);
  try {
    await cpClient2.begin(async (tx) => {
      const [row] = await tx`
        SELECT state, lease_token
        FROM company_memory_upgrades
        WHERE id = ${upgrade.id}::uuid
        FOR UPDATE NOWAIT;
      `;
      assert.equal(row.state, "sweeping");
      assert.equal(row.lease_token, claim.leaseToken);
    });
  } finally {
    await cpClient2.end();
  }
});

test("advisory lock key canonicalisation: case collision on sourceId serializes (F4)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("fence-case-collision-");
  const sqlClientA = openTenantClient(fixture.connectionString);
  const sqlClientB = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sqlClientA.end();
    await sqlClientB.end();
    await fixture.cleanup();
  });

  const upgradeId = randomUUID();
  const sourceId = randomUUID();

  let lockAcquiredByA: () => void;
  const lockPromiseA = new Promise<void>((resolve) => {
    lockAcquiredByA = resolve;
  });
  let releaseA: () => void;
  const holdPromiseA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const txA = sqlClientA.begin(async (tx) => {
    await acquireSourceAdvisoryLock(tx, upgradeId, sourceId.toUpperCase());
    lockAcquiredByA();
    await holdPromiseA;
  });

  await lockPromiseA;

  // Session B attempts to acquire the lock using lowercase UUID with lock_timeout = 300ms -> must fail with 55P03
  await assert.rejects(
    () =>
      sqlClientB.begin(async (tx) => {
        await tx.unsafe("SET LOCAL lock_timeout = 300");
        await acquireSourceAdvisoryLock(tx, upgradeId, sourceId.toLowerCase());
      }),
    (err: any) => {
      const code = (err as any)?.code;
      assert.equal(code, "55P03");
      return true;
    },
  );

  releaseA!();
  await txA;
});

test("stageSourceRecords: fail-closed validation on vectorType and embedding dimensions (F9)", async () => {
  const upgradeId = randomUUID();
  const sourceId = randomUUID();
  const agentId = randomUUID();
  const fakeFence: any = {
    upgradeId,
    leaseToken: "test-token",
    fenceEpoch: "1",
    leaseOwner: "test-owner",
  };
  const fakeSql: any = {};

  // 1. vectorType: "public.vector(1536)" -> INVALID_ARGUMENT (schema-qualified unsupported)
  await assert.rejects(
    () =>
      stageSourceRecords(
        fakeSql,
        {
          upgradeId,
          sourceId,
          sourceContentSha256: "sha-test",
          agentId,
          records: [dummyStageItem()],
          vectorType: "public.vector(1536)",
        },
        fakeFence,
      ),
    (err: any) => {
      assert.ok(err instanceof CompanyMemoryUpgradeError);
      assert.equal(err.code, "INVALID_ARGUMENT");
      return true;
    },
  );

  // 2. vectorType: "vector(1536)" with a 512-length embedding -> INVALID_ARGUMENT
  const wrongDimItem = {
    outputId: randomUUID(),
    dataSha256: computeRecordDataSha256("fact"),
    payload: { data: "fact" },
    embedding: new Array(512).fill(0.01),
  };
  await assert.rejects(
    () =>
      stageSourceRecords(
        fakeSql,
        {
          upgradeId,
          sourceId,
          sourceContentSha256: "sha-test",
          agentId,
          records: [wrongDimItem],
          vectorType: "vector(1536)",
        },
        fakeFence,
      ),
    (err: any) => {
      assert.ok(err instanceof CompanyMemoryUpgradeError);
      assert.equal(err.code, "INVALID_ARGUMENT");
      return true;
    },
  );
});

test("tenant fence: lease expired by CP DB clock is refused even when params.now claims it is still valid (F5)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("fence-f5-dbclock-");
  const cpDb = createDb(cpFixture.connectionString);
  const tenantFixture = await startEmbeddedPostgresTestDatabase("fence-f5-tenant-");
  const tenantSql = openTenantClient(tenantFixture.connectionString);

  t.after(async () => {
    await tenantSql.end();
    await cpDb.$client?.end();
    await tenantFixture.cleanup();
    await cpFixture.cleanup();
  });

  await ensureUpgradeTables(tenantSql, "text");

  const [company] = await cpDb.insert(companies).values({
    name: "DB Clock Authority Co",
    issuePrefix: "DC",
  }).returning();

  const upgrade = await openUpgrade(cpDb, {
    companyId: company.id,
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  });

  const claim = await claimUpgradeLease(cpDb, { upgradeId: upgrade.id, leaseOwner: "worker-skew" });
  assert.ok(claim.acquired && claim.leaseToken);

  // Set leaseExpiresAt in the past relative to the real database clock
  await cpDb
    .update(companyMemoryUpgrades)
    .set({ leaseExpiresAt: new Date(Date.now() - 5_000) })
    .where(eq(companyMemoryUpgrades.id, upgrade.id));

  // Caller's local clock is skewed far in the past (e.g. 1 hour ago), so local check thinks lease is still valid
  const skewedWorkerNow = new Date(Date.now() - 3_600_000);

  await assert.rejects(
    () =>
      claimTenantFenceGuarded(cpDb, tenantSql, {
        upgradeId: upgrade.id,
        cpLeaseToken: claim.leaseToken!,
        leaseOwner: "worker-skew",
        now: skewedWorkerNow,
      }),
    (err: any) => {
      assert.ok(err instanceof CompanyMemoryUpgradeError);
      assert.equal(err.code, "LEASE_FENCED_OUT");
      assert.match(err.message, /database clock/);
      return true;
    },
  );
});
