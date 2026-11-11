import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companyMemoryUpgrades,
  createDb,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  claimUpgradeLease,
  CompanyMemoryUpgradeError,
  openUpgrade,
  updateUpgradeCounters,
} from "./index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("state-machine drain_probe_streak_started_at column", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("drain-probe-col-");
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

  async function createCompanyAndUpgrade() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Streak Test Co", issuePrefix: "STC" })
      .returning();

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
      leaseOwner: "drain-probe-worker",
      ttlMs: 60_000,
    });

    return { company, upgrade, claim };
  }

  it("sets, leaves untouched when omitted, and explicitly clears drainProbeStreakStartedAt", async () => {
    const { upgrade, claim } = await createCompanyAndUpgrade();
    const leaseToken = claim.leaseToken!;

    expect(upgrade.drainProbeStreakStartedAt).toBeNull();

    // 1. Set the streak start timestamp
    const streakStart = new Date("2026-11-11T12:00:00.000Z");
    const withStreak = await updateUpgradeCounters(db, upgrade.id, leaseToken, {
      drainProbeStreakStartedAt: streakStart,
    });

    expect(withStreak.drainProbeStreakStartedAt).toBeInstanceOf(Date);
    expect(withStreak.drainProbeStreakStartedAt?.toISOString()).toBe(streakStart.toISOString());

    const [row1] = await db
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    expect(row1.drainProbeStreakStartedAt?.toISOString()).toBe(streakStart.toISOString());

    // 2. Untouched when omitted (undefined)
    const withOtherUpdate = await updateUpgradeCounters(db, upgrade.id, leaseToken, {
      sweepCount: 2,
    });

    expect(withOtherUpdate.sweepCount).toBe(2);
    expect(withOtherUpdate.drainProbeStreakStartedAt?.toISOString()).toBe(streakStart.toISOString());

    const [row2] = await db
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    expect(row2.drainProbeStreakStartedAt?.toISOString()).toBe(streakStart.toISOString());

    // 3. Explicitly cleared when passed null
    const cleared = await updateUpgradeCounters(db, upgrade.id, leaseToken, {
      drainProbeStreakStartedAt: null,
    });

    expect(cleared.drainProbeStreakStartedAt).toBeNull();

    const [row3] = await db
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    expect(row3.drainProbeStreakStartedAt).toBeNull();
  });

  it("enforces lease fencing on drainProbeStreakStartedAt writes", async () => {
    const { upgrade, claim } = await createCompanyAndUpgrade();
    const streakStart = new Date("2026-11-11T12:00:00.000Z");

    // Rejects invalid lease token
    await expect(
      updateUpgradeCounters(db, upgrade.id, "wrong-token", {
        drainProbeStreakStartedAt: streakStart,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "CompanyMemoryUpgradeError",
        code: "LEASE_FENCED_OUT",
      }),
    );

    // Rejects expired lease
    const futureClock = { now: () => new Date(Date.now() + 120_000) };
    await expect(
      updateUpgradeCounters(
        db,
        upgrade.id,
        claim.leaseToken!,
        { drainProbeStreakStartedAt: streakStart },
        { clock: futureClock },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "CompanyMemoryUpgradeError",
        code: "LEASE_EXPIRED",
      }),
    );
  });
});
