import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
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
  openUpgrade,
} from "../services/company-memory-upgrade/index.js";
import { deleteCompany } from "../services/company-deletion.js";
import * as memoryModule from "../services/company-memory-databases.js";
import { agentLifecycleCompanyDeletion } from "../modules/agent-lifecycle/company-deletion.js";
import { HttpError } from "../errors.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("company deletion and memory upgrade interlock", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-upgrade-deletion-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(companyMemoryUpgrades);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client?.end();
    await tempDb?.cleanup();
  });

  async function createTestCompany(name = "Test Interlock Co", prefix = "TIC") {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: prefix })
      .returning();
    return company;
  }

  const NON_TERMINAL_STATES = [
    "sweeping",
    "flipping",
    "draining",
    "verified",
    "pruning",
    "needs_recovery",
  ] as const;

  // 1. it.each non-terminal states sweeping, flipping, draining, verified, pruning, needs_recovery:
  // deleteCompany rejects status 409 with the message; company row, upgrade row intact; deletion_started_at null.
  it.each(NON_TERMINAL_STATES)(
    "deleteCompany rejects with 409 when upgrade is in '%s' state and leaves rows intact",
    async (state) => {
      const company = await createTestCompany(`Co ${state}`, `C${state.slice(0, 2).toUpperCase()}`);

      const [upgrade] = await db
        .insert(companyMemoryUpgrades)
        .values({
          companyId: company.id,
          state,
          ...(state === "needs_recovery" ? { recoverToState: "sweeping" } : {}),
          converterId: "mem0-v1",
          converterVersion: 1,
          collectionName: "mem0_memories",
          embeddingModel: "text-embedding-3-small",
          embeddingDimensions: 1536,
        })
        .returning();

      let caughtError: unknown;
      try {
        await deleteCompany(db, company.id);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(HttpError);
      const httpErr = caughtError as HttpError;
      expect(httpErr.status).toBe(409);
      expect(httpErr.message).toBe(
        `Cannot delete company: memory upgrade "${upgrade.id}" is active in state "${state}". Non-terminal upgrades must complete, roll back, or abort before company deletion.`,
      );
      expect(httpErr.details).toEqual({
        code: "company_memory_upgrade_active",
        upgradeId: upgrade.id,
        state,
      });

      // Verify company row intact and deletionStartedAt remains null
      const [coRow] = await db.select().from(companies).where(sql`id = ${company.id}`);
      expect(coRow).toBeDefined();
      expect(coRow.deletionStartedAt).toBeNull();

      // Verify upgrade row intact
      const [upRow] = await db
        .select()
        .from(companyMemoryUpgrades)
        .where(sql`id = ${upgrade.id}`);
      expect(upRow).toBeDefined();
      expect(upRow.state).toBe(state);
    },
  );

  // 2. Deprovision + agent termination NOT reached:
  // vi.spyOn memory module companyMemoryDatabaseService with deleteCompanyMemory vi.fn;
  // insert agent; expect 409; deleteCompanyMemory not called; agent lifecycle/status unchanged.
  it("rejects deletion before deprovisioning memory or terminating agents", async () => {
    const company = await createTestCompany("Agent Co", "ACO");

    const deleteCompanyMemory = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "all",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory,
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Test Agent",
        status: "idle",
      })
      .returning();

    // Create an active upgrade
    await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    await expect(deleteCompany(db, company.id)).rejects.toMatchObject({
      status: 409,
    });

    // Memory deprovision was never reached
    expect(deleteCompanyMemory).not.toHaveBeenCalled();

    // Agent status is unchanged (not terminated)
    const [agentRow] = await db.select().from(agents).where(sql`id = ${agent.id}`);
    expect(agentRow).toBeDefined();
    expect(agentRow.status).toBe("idle");
  });

  // 3. Admission blocks later openUpgrade:
  // deleteCompanyMemory stub signals then waits; during wait openUpgrade rejects COMPANY_DELETION_IN_PROGRESS;
  // release; deletion completes.
  it("admission blocks later openUpgrade during deprovisioning window", async () => {
    const company = await createTestCompany("Wait Co", "WCO");

    let signalDeprovisionReached!: () => void;
    const deprovisionReached = new Promise<void>((resolve) => {
      signalDeprovisionReached = resolve;
    });

    let releaseDeprovision!: () => void;
    const allowDeprovisionComplete = new Promise<void>((resolve) => {
      releaseDeprovision = resolve;
    });

    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "all",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory: vi.fn(async () => {
        signalDeprovisionReached();
        await allowDeprovisionComplete;
      }),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    // Start deletion asynchronously
    const deletionPromise = deleteCompany(db, company.id);

    // Wait until deletion admission has passed and deprovision step has started
    await deprovisionReached;

    // During this window, company row has deletionStartedAt set.
    // openUpgrade must be rejected with COMPANY_DELETION_IN_PROGRESS
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
        code: "COMPANY_DELETION_IN_PROGRESS",
      }),
    );

    // Release deprovision so deletion can proceed
    releaseDeprovision();
    const result = await deletionPromise;
    expect(result).toMatchObject({ id: company.id });

    // Confirm company is gone
    const [coRow] = await db.select().from(companies).where(sql`id = ${company.id}`);
    expect(coRow).toBeUndefined();
  });

  // 4. openUpgrade first wins: 409 and deprovision not called.
  it("openUpgrade first wins: deleteCompany is rejected with 409 and deprovision not called", async () => {
    const company = await createTestCompany("First Wins Co", "FWC");

    const deleteCompanyMemory = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "all",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory,
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    const upgrade = await openUpgrade(db, {
      companyId: company.id,
      converterId: "mem0-v1",
      converterVersion: 1,
      collectionName: "mem0_memories",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });
    expect(upgrade.id).toBeDefined();

    await expect(deleteCompany(db, company.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(deleteCompanyMemory).not.toHaveBeenCalled();
  });

  // 5. Fail-closed: deleteCompanyMemory throws -> deleteCompany rejects;
  // deletionStartedAt remains non-null; openUpgrade is blocked with COMPANY_DELETION_IN_PROGRESS;
  // retrying deleteCompany succeeds when transient error clears.
  it("retains deletion intent when deprovisioning fails (fail-closed), blocking upgrades until retry deletion succeeds", async () => {
    const company = await createTestCompany("Recovery Co", "RCO");

    let shouldFailDeprovision = true;
    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "all",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory: vi.fn(async () => {
        if (shouldFailDeprovision) {
          throw new Error("Simulated memory deprovision failure");
        }
      }),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    // Attempt deletion; deprovisioning fails
    await expect(deleteCompany(db, company.id)).rejects.toThrow(
      "Simulated memory deprovision failure",
    );

    // Verify deletionStartedAt remains non-null (fail-closed)
    const [coAfterFail] = await db.select().from(companies).where(sql`id = ${company.id}`);
    expect(coAfterFail).toBeDefined();
    expect(coAfterFail.deletionStartedAt).not.toBeNull();

    // openUpgrade is blocked because company has deletion intent set
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
        code: "COMPANY_DELETION_IN_PROGRESS",
      }),
    );

    // Fix the deprovision mock to succeed
    shouldFailDeprovision = false;

    // Retry deleteCompany; now succeeds via reentrant admission!
    const deleted = await deleteCompany(db, company.id);
    expect(deleted).toMatchObject({ id: company.id });

    // Company is removed
    const [coFinal] = await db.select().from(companies).where(sql`id = ${company.id}`);
    expect(coFinal).toBeUndefined();
  });

  // 6. Later-stage failure after deprovisioning:
  // e.g. failure during final transaction (after memory deprovisioning succeeded).
  // deletionStartedAt remains non-null; openUpgrade remains blocked against destroyed substrate;
  // retrying deleteCompany succeeds once the transient failure clears.
  it("retains deletion intent on later-stage failure after deprovisioning, blocking upgrade against destroyed substrate", async () => {
    const company = await createTestCompany("Later Stage Co", "LSC");

    let shouldFailLater = true;
    const realDeleteCompanyData = agentLifecycleCompanyDeletion.deleteCompanyData;
    vi.spyOn(agentLifecycleCompanyDeletion, "deleteCompanyData").mockImplementation(
      async (tx, companyId) => {
        if (shouldFailLater) {
          throw new Error("Simulated later-stage failure in deletion transaction");
        }
        return await realDeleteCompanyData(tx, companyId);
      },
    );

    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "all",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory: vi.fn().mockResolvedValue(undefined),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    // Attempt deletion; fails during later deletion transaction after memory deprovision
    await expect(deleteCompany(db, company.id)).rejects.toThrow(
      "Simulated later-stage failure in deletion transaction",
    );

    // Verify deletionStartedAt remains non-null (fail-closed)
    const [coAfterFail] = await db.select().from(companies).where(sql`id = ${company.id}`);
    expect(coAfterFail).toBeDefined();
    expect(coAfterFail.deletionStartedAt).not.toBeNull();

    // openUpgrade is blocked from operating against destroyed substrate
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
        code: "COMPANY_DELETION_IN_PROGRESS",
      }),
    );

    // Fix the later-stage failure
    shouldFailLater = false;

    // Retry deleteCompany; succeeds!
    const deleted = await deleteCompany(db, company.id);
    expect(deleted).toMatchObject({ id: company.id });

    const [coFinal] = await db.select().from(companies).where(sql`id = ${company.id}`);
    expect(coFinal).toBeUndefined();
  });

  // 7. Concurrency loop ~10 companies Promise.allSettled([deleteCompany, openUpgrade]):
  // never both company deleted and upgrade persisted; whenever openUpgrade fulfils,
  // deletion rejected 409 and deprovision not called.
  it("concurrency stress loop guarantees mutually exclusive admission", async () => {
    const NUM_COMPANIES = 10;
    const deprovisionCalls: string[] = [];

    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "all",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory: vi.fn(async (companyId: string) => {
        deprovisionCalls.push(companyId);
      }),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    for (let i = 0; i < NUM_COMPANIES; i++) {
      const company = await createTestCompany(`Race Co ${i}`, `RC${i}`);

      const [delRes, openRes] = await Promise.allSettled([
        deleteCompany(db, company.id),
        openUpgrade(db, {
          companyId: company.id,
          converterId: "mem0-v1",
          converterVersion: 1,
          collectionName: "mem0_memories",
          embeddingModel: "text-embedding-3-small",
          embeddingDimensions: 1536,
        }),
      ]);

      const [companyRow] = await db.select().from(companies).where(sql`id = ${company.id}`);
      const upgradeRows = await db
        .select()
        .from(companyMemoryUpgrades)
        .where(sql`company_id = ${company.id}`);

      // Invariant 1: never both company deleted and upgrade persisted
      const companyDeleted = !companyRow;
      const upgradePersisted = upgradeRows.length > 0;
      expect(companyDeleted && upgradePersisted).toBe(false);

      // Invariant 2: whenever openUpgrade fulfils, deletion is rejected with 409 and deprovision was not called
      if (openRes.status === "fulfilled") {
        expect(delRes.status).toBe("rejected");
        const reason = (delRes as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(HttpError);
        expect((reason as HttpError).status).toBe(409);
        expect(deprovisionCalls).not.toContain(company.id);
      }

      // Invariant 3: whenever deleteCompany fulfils, openUpgrade was rejected
      if (delRes.status === "fulfilled") {
        expect(openRes.status).toBe("rejected");
        const openErr = (openRes as PromiseRejectedResult).reason;
        expect(openErr).toBeInstanceOf(CompanyMemoryUpgradeError);
        expect(["COMPANY_NOT_FOUND", "COMPANY_DELETION_IN_PROGRESS"]).toContain(
          (openErr as CompanyMemoryUpgradeError).code,
        );
      }
    }
  });
});
