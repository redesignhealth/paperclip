import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  companyMemoryUpgrades,
  createDb,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  advanceState,
  claimUpgradeLease,
  CompanyMemoryUpgradeError,
  failUpgradeLeaseLapse,
  openUpgrade,
  reconcileLapsedUpgradeLeases,
  recoverUpgrade,
  renewUpgradeLease,
  startLeaseHeartbeat,
  updateUpgradeCounters,
} from "../services/company-memory-upgrade/index.js";
import { deleteCompany } from "../services/company-deletion.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("company memory upgrade state machine integration", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-upgrade-state-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemoryUpgrades);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client?.end();
    await tempDb?.cleanup();
  });

  async function createTestCompany(name = "Test Co", prefix = "TC") {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: prefix })
      .returning();
    return company;
  }

  it("openUpgrade creates record in sweeping state and rejects second active upgrade", async () => {
    const company = await createTestCompany();

    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      operatorLabel: "initial test run",
    });

    expect(upgrade.id).toBeDefined();
    expect(upgrade.state).toBe("sweeping");
    expect(upgrade.companyId).toBe(company.id);
    expect(upgrade.operatorLabel).toBe("initial test run");

    // Second active upgrade for same company throws ACTIVE_UPGRADE_EXISTS
    await expect(
      openUpgrade(db, {
        companyId: company.id,
        converterId: "mem0-v1",
        converterVersion: 1,
        collectionName: "mem0_memories",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "CompanyMemoryUpgradeError",
        code: "ACTIVE_UPGRADE_EXISTS",
      }),
    );
  });

  it("handles lease claim: two claimants race and exactly one wins", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const [claimA, claimB] = await Promise.all([
      claimUpgradeLease(db, {
        upgradeId: upgrade.id,
        leaseOwner: "worker-A",
        ttlMs: 60_000,
      }),
      claimUpgradeLease(db, {
        upgradeId: upgrade.id,
        leaseOwner: "worker-B",
        ttlMs: 60_000,
      }),
    ]);

    // Exactly one claimant acquires the lease
    const winners = [claimA, claimB].filter((c) => c.acquired);
    const losers = [claimA, claimB].filter((c) => !c.acquired);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].leaseToken).toBeDefined();
    expect(["worker-A", "worker-B"]).toContain(winners[0].leaseOwner);
  });

  it("allows reclaiming an expired lease once its TTL elapses", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const now = new Date("2026-01-01T00:00:00Z");
    const claim1 = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "worker-1",
      ttlMs: 10_000,
      now,
    });
    expect(claim1.acquired).toBe(true);

    // Another worker tries before expiry -> rejected
    const claimTooEarly = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "worker-2",
      ttlMs: 10_000,
      now: new Date("2026-01-01T00:00:05Z"),
    });
    expect(claimTooEarly.acquired).toBe(false);

    // After expiry -> reclaimed by worker-2
    const claimAfterExpiry = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "worker-2",
      ttlMs: 10_000,
      now: new Date("2026-01-01T00:00:15Z"),
    });
    expect(claimAfterExpiry.acquired).toBe(true);
    expect(claimAfterExpiry.leaseOwner).toBe("worker-2");
    expect(claimAfterExpiry.leaseToken).not.toBe(claim1.leaseToken);
  });

  it("renews lease and provides active heartbeat check", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "worker-heartbeat",
      ttlMs: 30_000,
    });
    expect(claim.acquired).toBe(true);

    const heartbeat = startLeaseHeartbeat(db, upgrade.id, claim.leaseToken!, {
      initialExpiresAt: claim.leaseExpiresAt!,
      intervalMs: 100,
      ttlMs: 30_000,
    });

    expect(heartbeat.isLost()).toBe(false);
    expect(() => heartbeat.assertActive()).not.toThrow();

    // Manual renewal
    const renewResult = await renewUpgradeLease(db, upgrade.id, claim.leaseToken!, {
      ttlMs: 40_000,
    });
    expect(renewResult.renewed).toBe(true);
    expect(renewResult.expiresAt).toBeDefined();

    // Wrong token renewal fails
    const badRenew = await renewUpgradeLease(db, upgrade.id, "wrong-token");
    expect(badRenew.renewed).toBe(false);

    await heartbeat.stop();
  });

  it("advances state under lease fencing, rejecting stale tokens or state mismatches", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "worker-state",
      ttlMs: 60_000,
    });
    expect(claim.acquired).toBe(true);

    // Illegal advance throws
    await expect(
      advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "completed"),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "ILLEGAL_TRANSITION",
      }),
    );

    // Wrong lease token throws LEASE_FENCED_OUT
    await expect(
      advanceState(db, upgrade.id, "wrong-token", "sweeping", "flipping"),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "LEASE_FENCED_OUT",
      }),
    );

    // Valid advance sweeping -> flipping
    const flipping = await advanceState(
      db,
      upgrade.id,
      claim.leaseToken!,
      "sweeping",
      "flipping",
    );
    expect(flipping.state).toBe("flipping");

    // State mismatch (calling legal edge sweeping -> flipping when now already flipping) throws STATE_MISMATCH
    await expect(
      advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "flipping"),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "STATE_MISMATCH",
      }),
    );

    await expect(
      advanceState(db, upgrade.id, claim.leaseToken!, "flipping", "completed"),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "ILLEGAL_TRANSITION",
      }),
    );

    // advance flipping -> draining
    const draining = await advanceState(
      db,
      upgrade.id,
      claim.leaseToken!,
      "flipping",
      "draining",
    );
    expect(draining.state).toBe("draining");

    // advance draining -> verified
    const verified = await advanceState(
      db,
      upgrade.id,
      claim.leaseToken!,
      "draining",
      "verified",
    );
    expect(verified.state).toBe("verified");
    expect(verified.verifiedAt).toBeDefined();

    // advance verified -> pruning
    const pruning = await advanceState(
      db,
      upgrade.id,
      claim.leaseToken!,
      "verified",
      "pruning",
    );
    expect(pruning.state).toBe("pruning");
    expect(pruning.prunedAt).toBeDefined();

    // advance pruning -> completed
    const completed = await advanceState(
      db,
      upgrade.id,
      claim.leaseToken!,
      "pruning",
      "completed",
    );
    expect(completed.state).toBe("completed");
    expect(completed.completedAt).toBeDefined();
  });

  it("handles lease lapse to needs_recovery and recovers back to prior state", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const baseTime = new Date("2026-02-01T10:00:00Z");
    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "worker-lapse",
      ttlMs: 10_000,
      now: baseTime,
    });
    expect(claim.acquired).toBe(true);

    // Advance to draining
    await advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "flipping", {
      clock: { now: () => new Date("2026-02-01T10:00:01Z") },
    });
    await advanceState(db, upgrade.id, claim.leaseToken!, "flipping", "draining", {
      clock: { now: () => new Date("2026-02-01T10:00:02Z") },
    });

    // Simulate clock advancing past lease expiry (leaseExpiresAt is 10:00:10Z)
    const lapseTime = new Date("2026-02-01T10:00:15Z");

    // reconcileLapsedUpgradeLeases genuinely reconciles the lapsed row and returns 1
    const reconciledCount = await reconcileLapsedUpgradeLeases(db, {
      clock: { now: () => lapseTime },
    });
    expect(reconciledCount).toBe(1);

    const [reconciledRow] = await db
      .select()
      .from(companyMemoryUpgrades)
      .where(sql`id = ${upgrade.id}`);
    expect(reconciledRow.state).toBe("needs_recovery");
    expect(reconciledRow.recoverToState).toBe("draining");
    expect(reconciledRow.leaseToken).toBeNull();
    expect(reconciledRow.leaseOwner).toBeNull();
    expect(reconciledRow.lastError).toBe("lease_lapsed");

    // Second reconcile call is idempotent and returns 0
    const secondReconcile = await reconcileLapsedUpgradeLeases(db, {
      clock: { now: () => lapseTime },
    });
    expect(secondReconcile).toBe(0);

    // Recover upgrade restores prior state ('draining') and mints a new lease
    const recovered = await recoverUpgrade(db, upgrade.id, "recovery-worker", {
      clock: { now: () => new Date("2026-02-01T10:00:20Z") },
      ttlMs: 30_000,
    });

    expect(recovered.state).toBe("draining");
    expect(recovered.recoverToState).toBeNull();
    expect(recovered.leaseOwner).toBe("recovery-worker");
    expect(recovered.leaseToken).toBeDefined();

    // From draining, can advance to verified with the new lease
    const next = await advanceState(
      db,
      upgrade.id,
      recovered.leaseToken!,
      "draining",
      "verified",
      { clock: { now: () => new Date("2026-02-01T10:00:25Z") } },
    );
    expect(next.state).toBe("verified");
  });

  it("atomically increments counters and sets timestamps under lease fencing", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "counter-worker",
      ttlMs: 60_000,
    });
    expect(claim.acquired).toBe(true);

    const markedTime = new Date("2026-03-01T12:00:00Z");

    const batch1 = await updateUpgradeCounters(
      db,
      upgrade.id,
      claim.leaseToken!,
      {
        sweepCount: 5,
        sourceSeenCount: 10,
        publishedCount: 8,
        droppedNoiseCount: 2,
        llmInputTokens: 1200,
        llmOutputTokens: 300,
        embeddingTokens: 500,
        estimatedCostNanodollars: 15000,
        markedAt: markedTime,
      },
    );

    expect(batch1.sweepCount).toBe(5);
    expect(batch1.sourceSeenCount).toBe(10);
    expect(batch1.publishedCount).toBe(8);
    expect(batch1.droppedNoiseCount).toBe(2);
    expect(batch1.llmInputTokens).toBe(1200n);
    expect(batch1.llmOutputTokens).toBe(300n);
    expect(batch1.embeddingTokens).toBe(500n);
    expect(batch1.estimatedCostNanodollars).toBe(15000n);
    expect(batch1.markedAt?.toISOString()).toBe(markedTime.toISOString());

    // Second increment increments values additively
    const batch2 = await updateUpgradeCounters(
      db,
      upgrade.id,
      claim.leaseToken!,
      {
        sweepCount: 3,
        sourceSeenCount: 5,
        publishedCount: 4,
        deduplicatedCount: 1,
        llmInputTokens: 800,
        llmOutputTokens: 200,
        embeddingTokens: 300,
        estimatedCostNanodollars: 10000,
      },
    );

    expect(batch2.sweepCount).toBe(8);
    expect(batch2.sourceSeenCount).toBe(15);
    expect(batch2.publishedCount).toBe(12);
    expect(batch2.droppedNoiseCount).toBe(2);
    expect(batch2.deduplicatedCount).toBe(1);
    expect(batch2.llmInputTokens).toBe(2000n);
    expect(batch2.llmOutputTokens).toBe(500n);
    expect(batch2.embeddingTokens).toBe(800n);
    expect(batch2.estimatedCostNanodollars).toBe(25000n);

    // Call with invalid lease token throws LEASE_FENCED_OUT
    await expect(
      updateUpgradeCounters(db, upgrade.id, "bad-token", { sweepCount: 1 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "LEASE_FENCED_OUT",
      }),
    );
  });

  it("updateUpgradeCounters rejects negative, non-integer, and invalid deltas", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "validation-worker",
      ttlMs: 60_000,
    });
    expect(claim.acquired).toBe(true);

    // Negative integer delta
    await expect(
      updateUpgradeCounters(db, upgrade.id, claim.leaseToken!, { sweepCount: -1 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );

    // Non-integer float delta
    await expect(
      updateUpgradeCounters(db, upgrade.id, claim.leaseToken!, { publishedCount: 3.5 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );

    // NaN delta
    await expect(
      updateUpgradeCounters(db, upgrade.id, claim.leaseToken!, { sourceSeenCount: Number.NaN }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );

    // Negative bigint delta
    await expect(
      updateUpgradeCounters(db, upgrade.id, claim.leaseToken!, { llmInputTokens: -50n }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );

    // Non-integer float delta for bigint counter
    await expect(
      updateUpgradeCounters(db, upgrade.id, claim.leaseToken!, { estimatedCostNanodollars: 12.34 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );

    // Nonnegative bigint deltas succeed and preserve atomic increments
    const okBatch = await updateUpgradeCounters(db, upgrade.id, claim.leaseToken!, {
      llmInputTokens: 500n,
      estimatedCostNanodollars: 1000n,
      sweepCount: 0,
    });
    expect(okBatch.llmInputTokens).toBe(500n);
    expect(okBatch.estimatedCostNanodollars).toBe(1000n);

    // Delta exceeding 32-bit signed integer (2^31 - 1 = 2147483647)
    await expect(
      updateUpgradeCounters(db, upgrade.id, claim.leaseToken!, { sweepCount: 2_147_483_648 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );

    // Bigint delta exceeding 64-bit signed integer (2^63 - 1)
    await expect(
      updateUpgradeCounters(db, upgrade.id, claim.leaseToken!, { llmInputTokens: 9_223_372_036_854_775_808n }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  });

  it("updateUpgradeCounters refuses updates on terminal or needs_recovery states even if lease unexpired", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "terminal-test-worker",
      ttlMs: 60_000,
    });
    expect(claim.acquired).toBe(true);

    // Advance directly to aborted (terminal)
    await advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "aborted");

    // Attempting counter update on aborted upgrade while lease unexpired fails with INVALID_STATE
    await expect(
      updateUpgradeCounters(db, upgrade.id, claim.leaseToken!, { sweepCount: 1 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_STATE",
      }),
    );

    // Create another upgrade and set to needs_recovery with an unexpired lease
    const upgrade2 = await openUpgrade(db, {
      companyId: (await createTestCompany("Co 2", "C2")).id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim2 = await claimUpgradeLease(db, {
      upgradeId: upgrade2.id,
      leaseOwner: "recovery-test-worker",
      ttlMs: 60_000,
    });

    // Manually set state to needs_recovery keeping the lease unexpired
    await db
      .update(companyMemoryUpgrades)
      .set({ state: "needs_recovery", recoverToState: "sweeping" })
      .where(sql`id = ${upgrade2.id}`);

    await expect(
      updateUpgradeCounters(db, upgrade2.id, claim2.leaseToken!, { sweepCount: 1 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_STATE",
      }),
    );
  });

  it("enforces bounded machine reason codes for lastError and rejects arbitrary strings or secrets", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "error-test-worker",
      ttlMs: 60_000,
    });
    expect(claim.acquired).toBe(true);

    // 1. advanceState rejects raw error with DSN/secret and does not echo secret
    const secretDsn = "postgres://u:s3cret@h/db";
    let advanceErr: Error | undefined;
    try {
      await advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "aborted", {
        lastError: secretDsn as any,
      });
    } catch (err: any) {
      advanceErr = err;
    }
    expect(advanceErr).toBeDefined();
    expect((advanceErr as any).code).toBe("INVALID_ARGUMENT");
    expect(advanceErr!.message).not.toContain("s3cret");

    // 2. advanceState accepts valid machine reason code from vocabulary
    const advanced = await advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "aborted", {
      lastError: "aborted_by_operator",
    });
    expect(advanced.state).toBe("aborted");
    expect(advanced.lastError).toBe("aborted_by_operator");

    // 3. updateUpgradeCounters rejects raw string and accepts valid machine code without echoing secrets
    const upgrade2 = await openUpgrade(db, {
      companyId: (await createTestCompany("Co Err", "CE")).id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim2 = await claimUpgradeLease(db, {
      upgradeId: upgrade2.id,
      leaseOwner: "error-test-worker-2",
      ttlMs: 60_000,
    });

    let counterLastErrorErr: Error | undefined;
    try {
      await updateUpgradeCounters(db, upgrade2.id, claim2.leaseToken!, {
        lastError: secretDsn as any,
      });
    } catch (err: any) {
      counterLastErrorErr = err;
    }
    expect(counterLastErrorErr).toBeDefined();
    expect((counterLastErrorErr as any).code).toBe("INVALID_ARGUMENT");
    expect(counterLastErrorErr!.message).not.toContain("s3cret");

    let counterDeltaErr: Error | undefined;
    try {
      await updateUpgradeCounters(db, upgrade2.id, claim2.leaseToken!, {
        sweepCount: secretDsn as any,
      });
    } catch (err: any) {
      counterDeltaErr = err;
    }
    expect(counterDeltaErr).toBeDefined();
    expect((counterDeltaErr as any).code).toBe("INVALID_ARGUMENT");
    expect(counterDeltaErr!.message).not.toContain("s3cret");

    let bigIntDeltaErr: Error | undefined;
    try {
      await updateUpgradeCounters(db, upgrade2.id, claim2.leaseToken!, {
        llmInputTokens: secretDsn as any,
      });
    } catch (err: any) {
      bigIntDeltaErr = err;
    }
    expect(bigIntDeltaErr).toBeDefined();
    expect((bigIntDeltaErr as any).code).toBe("INVALID_ARGUMENT");
    expect(bigIntDeltaErr!.message).not.toContain("s3cret");

    const updatedCounters = await updateUpgradeCounters(db, upgrade2.id, claim2.leaseToken!, {
      lastError: "conversion_failed",
    });
    expect(updatedCounters.lastError).toBe("conversion_failed");
  });

  it("startLeaseHeartbeat handles normal heartbeat and immediately stops/reports lost on expired initial lease", async () => {
    const company = await createTestCompany();
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "heartbeat-regression-worker",
      ttlMs: 30_000,
    });
    expect(claim.acquired).toBe(true);

    // 1. Expired initial lease: already expired before heartbeat starts
    let onLostCalled = false;
    const expiredHeartbeat = startLeaseHeartbeat(db, upgrade.id, claim.leaseToken!, {
      initialExpiresAt: new Date(Date.now() - 5_000), // 5 seconds in the past
      intervalMs: 50,
      ttlMs: 30_000,
      onLost: () => {
        onLostCalled = true;
      },
    });

    expect(onLostCalled).toBe(true);
    expect(expiredHeartbeat.isLost()).toBe(true);
    expect(() => expiredHeartbeat.assertActive()).toThrowError(
      expect.objectContaining({
        code: "LEASE_FENCED_OUT",
      }),
    );
    await expiredHeartbeat.stop();

    // 2. Normal heartbeat with claimed expiry runs and reports active
    let normalLostCalled = false;
    const normalHeartbeat = startLeaseHeartbeat(db, upgrade.id, claim.leaseToken!, {
      initialExpiresAt: claim.leaseExpiresAt!,
      intervalMs: 50,
      ttlMs: 30_000,
      onLost: () => {
        normalLostCalled = true;
      },
    });

    expect(normalLostCalled).toBe(false);
    expect(normalHeartbeat.isLost()).toBe(false);
    expect(() => normalHeartbeat.assertActive()).not.toThrow();

    // Allow background interval renewal to run once
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(normalHeartbeat.isLost()).toBe(false);
    expect(normalLostCalled).toBe(false);

    await normalHeartbeat.stop();
  });

  it("refuses lease renewal on terminal upgrade states", async () => {
    const company = await createTestCompany("Co Term", "CT");
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "terminal-renewal-worker",
      ttlMs: 60_000,
    });
    expect(claim.acquired).toBe(true);

    // Advance to aborted (terminal)
    const aborted = await advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "aborted");
    expect(aborted.state).toBe("aborted");
    expect(aborted.leaseToken).toBeNull();

    // Renewal on aborted row returns false
    const renewResult = await renewUpgradeLease(db, upgrade.id, claim.leaseToken!);
    expect(renewResult.renewed).toBe(false);
  });

  it("reconciles unclaimed upgrade after createdAt + ttlMs and recovers it", async () => {
    const company = await createTestCompany("Co Stale", "CS");
    const openTime = new Date("2026-04-01T10:00:00Z");

    const upgrade = await openUpgrade(
      db,
      {
        companyId: company.id,
        converterId: "mem0-v1",
        converterVersion: 1,
        collectionName: "mem0_memories",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
      },
      { clock: { now: () => openTime } },
    );

    // Row has no lease yet
    expect(upgrade.leaseExpiresAt).toBeNull();
    expect(upgrade.state).toBe("sweeping");

    // Before TTL expires: reconcile does nothing
    const earlyTime = new Date("2026-04-01T10:05:00Z"); // 5 mins later (< 10 min default TTL)
    const earlyReconcile = await reconcileLapsedUpgradeLeases(db, {
      clock: { now: () => earlyTime },
    });
    expect(earlyReconcile).toBe(0);

    // Past TTL: worker crashed between open and claim
    const staleTime = new Date("2026-04-01T10:11:00Z"); // 11 mins later (> 10 min default TTL)
    const staleReconcile = await reconcileLapsedUpgradeLeases(db, {
      clock: { now: () => staleTime },
    });
    expect(staleReconcile).toBe(1);

    const [staleRow] = await db
      .select()
      .from(companyMemoryUpgrades)
      .where(sql`id = ${upgrade.id}`);
    expect(staleRow.state).toBe("needs_recovery");
    expect(staleRow.recoverToState).toBe("sweeping");
    expect(staleRow.lastError).toBe("lease_lapsed");

    // Recover upgrade successfully recovers back to sweeping with a new lease
    const recovered = await recoverUpgrade(db, upgrade.id, "crash-recovery-worker", {
      clock: { now: () => new Date("2026-04-01T10:15:00Z") },
    });
    expect(recovered.state).toBe("sweeping");
    expect(recovered.leaseOwner).toBe("crash-recovery-worker");
    expect(recovered.leaseToken).toBeDefined();
  });

  it("handles throwing onLost callback defensively without unhandled rejection and stops interval", async () => {
    const company = await createTestCompany("Co Throw", "CTH");
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const claim = await claimUpgradeLease(db, {
      upgradeId: upgrade.id,
      leaseOwner: "throwing-onlost-worker",
      ttlMs: 30_000,
    });
    expect(claim.acquired).toBe(true);

    // 1. Throwing onLost on already expired initial lease
    let onLostCallCount = 0;
    const expiredHb = startLeaseHeartbeat(db, upgrade.id, claim.leaseToken!, {
      initialExpiresAt: new Date(Date.now() - 10_000),
      onLost: () => {
        onLostCallCount++;
        throw new Error("Callback exploded!");
      },
    });

    expect(onLostCallCount).toBe(1);
    expect(expiredHb.isLost()).toBe(true);
    expect(() => expiredHb.assertActive()).toThrowError(
      expect.objectContaining({ code: "LEASE_FENCED_OUT" }),
    );
    await expect(expiredHb.stop()).resolves.toBeUndefined();

    // 2. Throwing onLost during renewal failure in running timer
    let renewalLossCount = 0;
    const runningHb = startLeaseHeartbeat(db, upgrade.id, "nonexistent-lease-token", {
      initialExpiresAt: new Date(Date.now() + 5_000),
      intervalMs: 30,
      ttlMs: 10_000,
      onLost: () => {
        renewalLossCount++;
        throw new Error("Renewal lost exploded!");
      },
    });

    // Wait for the interval to fire and fail renewal
    await new Promise((resolve) => setTimeout(resolve, 100));

    // onLost was invoked exactly once, timer was stopped
    expect(renewalLossCount).toBe(1);
    expect(runningHb.isLost()).toBe(true);
    await expect(runningHb.stop()).resolves.toBeUndefined();
  });

  it("deletes companyMemoryUpgrades rows during company deletion without FK restrict violation", async () => {
    const company = await createTestCompany("Delete Co", "DC");
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });
    expect(upgrade.id).toBeDefined();

    // deleteCompany purges companyMemoryUpgrades before deleting company
    const deleted = await deleteCompany(db, company.id);
    expect(deleted).toMatchObject({ id: company.id });

    // Verify upgrade row is removed
    const [upgradeRow] = await db
      .select()
      .from(companyMemoryUpgrades)
      .where(sql`id = ${upgrade.id}`);
    expect(upgradeRow).toBeUndefined();

    // Verify company row is removed
    const [companyRow] = await db
      .select()
      .from(companies)
      .where(sql`id = ${company.id}`);
    expect(companyRow).toBeUndefined();
  });

  it("recoverUpgrade rejects not found, invalid state, and missing prior state", async () => {
    const company = await createTestCompany("Co Rec", "CR");
    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    // 1. Nonexistent upgrade ID throws UPGRADE_NOT_FOUND
    const fakeId = "00000000-0000-0000-0000-000000000000";
    await expect(
      recoverUpgrade(db, fakeId, "worker"),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "UPGRADE_NOT_FOUND" }),
    );

    // 2. Upgrade in 'sweeping' (not 'needs_recovery') throws INVALID_RECOVERY
    await expect(
      recoverUpgrade(db, upgrade.id, "worker"),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_RECOVERY" }),
    );

    // 3. Upgrade in 'needs_recovery' with null recoverToState throws INVALID_RECOVERY
    await db
      .update(companyMemoryUpgrades)
      .set({ state: "needs_recovery", recoverToState: null })
      .where(sql`id = ${upgrade.id}`);

    await expect(
      recoverUpgrade(db, upgrade.id, "worker"),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_RECOVERY" }),
    );
  });
});
