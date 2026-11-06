import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  companies,
  companyMemoryDatabases,
  createDb,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recordAgentScopedMemoryUse } from "../services/memory-scope-observations.js";
import { logger } from "../middleware/logger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres memory scope observation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recordAgentScopedMemoryUse real Postgres execution", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-observations-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(companyMemoryDatabases);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await db?.$client?.end();
    await tempDb?.cleanup();
  });

  it("updates null observed_at when scope migration completed marker is set", async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: "Migrated Co", issuePrefix: "MIG" })
      .returning();

    const completedAt = new Date("2026-11-05T00:00:00Z");
    await db.insert(companyMemoryDatabases).values({
      companyId: company.id,
      databaseName: "pcmem_test1",
      databaseRole: "pcmem_r_test1",
      host: "db.test.internal",
      status: "ready",
      scopeMigrationCompletedAt: completedAt,
      scopeMigrationAgentScopeObservedAt: null,
    });

    const baseTime = new Date("2026-11-05T12:00:00Z");
    const updated = await recordAgentScopedMemoryUse(db, company.id, baseTime);

    expect(updated).toBe(true);

    const [row] = await db
      .select({ observedAt: companyMemoryDatabases.scopeMigrationAgentScopeObservedAt })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, company.id));

    expect(row.observedAt).toEqual(baseTime);
  });

  it("throttles updates within 1 hour and only updates once interval has elapsed", async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: "Throttle Co", issuePrefix: "THR" })
      .returning();

    const completedAt = new Date("2026-11-05T00:00:00Z");
    await db.insert(companyMemoryDatabases).values({
      companyId: company.id,
      databaseName: "pcmem_test2",
      databaseRole: "pcmem_r_test2",
      host: "db.test.internal",
      status: "ready",
      scopeMigrationCompletedAt: completedAt,
      scopeMigrationAgentScopeObservedAt: null,
    });

    const baseTime = new Date("2026-11-05T12:00:00Z");

    // 1. Initial observation: updates from null
    const firstUpdate = await recordAgentScopedMemoryUse(db, company.id, baseTime);
    expect(firstUpdate).toBe(true);

    // 2. Call 30 minutes later: throttled (returns false, row unchanged)
    const timePlus30Min = new Date(baseTime.getTime() + 30 * 60 * 1000);
    const secondUpdate = await recordAgentScopedMemoryUse(db, company.id, timePlus30Min);
    expect(secondUpdate).toBe(false);

    let [row] = await db
      .select({ observedAt: companyMemoryDatabases.scopeMigrationAgentScopeObservedAt })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, company.id));
    expect(row.observedAt).toEqual(baseTime);

    // 3. Call 59 minutes later: throttled (returns false, row unchanged)
    const timePlus59Min = new Date(baseTime.getTime() + 59 * 60 * 1000);
    const thirdUpdate = await recordAgentScopedMemoryUse(db, company.id, timePlus59Min);
    expect(thirdUpdate).toBe(false);

    [row] = await db
      .select({ observedAt: companyMemoryDatabases.scopeMigrationAgentScopeObservedAt })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, company.id));
    expect(row.observedAt).toEqual(baseTime);

    // 4. Call 61 minutes later: updates (> 1 hour older)
    const timePlus61Min = new Date(baseTime.getTime() + 61 * 60 * 1000);
    const fourthUpdate = await recordAgentScopedMemoryUse(db, company.id, timePlus61Min);
    expect(fourthUpdate).toBe(true);

    [row] = await db
      .select({ observedAt: companyMemoryDatabases.scopeMigrationAgentScopeObservedAt })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, company.id));
    expect(row.observedAt).toEqual(timePlus61Min);
  });

  it("is a no-op when scope migration completed marker is missing (null)", async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: "Unmigrated Co", issuePrefix: "UNM" })
      .returning();

    await db.insert(companyMemoryDatabases).values({
      companyId: company.id,
      databaseName: "pcmem_test3",
      databaseRole: "pcmem_r_test3",
      host: "db.test.internal",
      status: "ready",
      scopeMigrationCompletedAt: null,
      scopeMigrationAgentScopeObservedAt: null,
    });

    const now = new Date("2026-11-05T12:00:00Z");
    const updated = await recordAgentScopedMemoryUse(db, company.id, now);
    expect(updated).toBe(false);

    const [row] = await db
      .select({ observedAt: companyMemoryDatabases.scopeMigrationAgentScopeObservedAt })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, company.id));
    expect(row.observedAt).toBeNull();
  });

  it("catches database errors, logs at warn with { err, companyId }, and returns false without failing run", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const companyId = "99999999-9999-4999-8999-999999999999";

    const failingDb = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              throw new Error("simulated Postgres connection drop");
            }),
          })),
        })),
      })),
    } as unknown as Db;

    const result = await recordAgentScopedMemoryUse(failingDb, companyId);
    expect(result).toBe(false);

    expect(warnSpy).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        companyId,
      },
      "failed to record agent-scoped memory observation",
    );

    const warnCall = warnSpy.mock.calls.find(
      ([obj]) => typeof obj === "object" && obj !== null && "companyId" in obj && (obj as any).companyId === companyId,
    );
    expect(warnCall).toBeDefined();
    // Verify no secret leakage or unexpected fields
    expect(Object.keys(warnCall![0] as object).sort()).toEqual(["companyId", "err"]);
  });
});
