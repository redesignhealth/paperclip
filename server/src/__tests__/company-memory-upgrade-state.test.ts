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

    // State mismatch (calling from sweeping when now flipping) throws STATE_MISMATCH
    await expect(
      advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "draining"),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "ILLEGAL_TRANSITION",
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

    const lapsed = await failUpgradeLeaseLapse(db, upgrade.id, {
      clock: { now: () => lapseTime },
    });
    expect(lapsed).not.toBeNull();
    expect(lapsed?.state).toBe("needs_recovery");
    expect(lapsed?.recoverToState).toBe("draining");
    expect(lapsed?.leaseToken).toBeNull();
    expect(lapsed?.leaseOwner).toBeNull();
    expect(lapsed?.lastError).toBe("lease_lapsed");

    // reconcileLapsedUpgradeLeases is idempotent
    const reconciledCount = await reconcileLapsedUpgradeLeases(db, {
      clock: { now: () => lapseTime },
    });
    expect(reconciledCount).toBe(0);

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
    expect(batch1.llmInputTokens).toBe(1200);
    expect(batch1.llmOutputTokens).toBe(300);
    expect(batch1.embeddingTokens).toBe(500);
    expect(batch1.estimatedCostNanodollars).toBe(15000);
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
    expect(batch2.llmInputTokens).toBe(2000);
    expect(batch2.llmOutputTokens).toBe(500);
    expect(batch2.embeddingTokens).toBe(800);
    expect(batch2.estimatedCostNanodollars).toBe(25000);

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
    expect(okBatch.llmInputTokens).toBe(500);
    expect(okBatch.estimatedCostNanodollars).toBe(1000);
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

    // 1. advanceState rejects raw error with DSN/secret
    await expect(
      advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "aborted", {
        lastError: "Connection failed to postgres://user:secret@db.internal:5432/corp and leaked memory: confidential data" as any,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );

    // 2. advanceState accepts valid machine reason code from vocabulary
    const advanced = await advanceState(db, upgrade.id, claim.leaseToken!, "sweeping", "aborted", {
      lastError: "aborted_by_operator",
    });
    expect(advanced.state).toBe("aborted");
    expect(advanced.lastError).toBe("aborted_by_operator");

    // 3. updateUpgradeCounters rejects raw string and accepts valid machine code
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

    await expect(
      updateUpgradeCounters(db, upgrade2.id, claim2.leaseToken!, {
        lastError: "SyntaxError: Unexpected token < in JSON at position 0" as any,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );

    const updatedCounters = await updateUpgradeCounters(db, upgrade2.id, claim2.leaseToken!, {
      lastError: "conversion_failed",
    });
    expect(updatedCounters.lastError).toBe("conversion_failed");
  });
});
