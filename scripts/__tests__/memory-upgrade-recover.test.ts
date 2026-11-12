/**
 * Memory upgrade recover command tests (TECH-8191 §Q6, PR5.11).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  claimUpgradeLease,
  formatRecoverReport,
  runRecover,
} from "../../server/src/services/company-memory-upgrade/index.js";
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
import {
  CompanyMemoryUpgradeError,
  type UpgradeState,
} from "../../server/src/services/company-memory-upgrade/types.js";
import {
  ALLOWED_RECOVER_FLAGS,
  BOOLEAN_RECOVER_FLAGS,
} from "../memory-upgrade-recover-flags.js";
import { parseRecoverArgs } from "../memory-upgrade-recover-args.js";
import { runRecoverCli } from "../memory-upgrade-recover.js";
import { sanitizeCliErrorMessage, validateNoUnknownFlags } from "../memory-upgrade.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companies,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";

test("memory upgrade recover command (embedded postgres)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("recover-cmd");
  t.after(async () => {
    await env.cleanup();
  });

  const cpDb = env.cpWorkerDb;
  const company = env.company;

  const baseUpgradeValues = {
    companyId: company.id,
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  };

  t.beforeEach(async () => {
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, company.id));
  });

  await t.test("restores recover_to_state and clears lastError", async () => {
    const [upgrade] = await cpDb
      .insert(companyMemoryUpgrades)
      .values({
        ...baseUpgradeValues,
        state: "needs_recovery",
        recoverToState: "sweeping",
        lastError: "tenant_fence_claim_failed",
      })
      .returning();

    const report = await runRecover(
      { companyId: company.id, confirm: company.id },
      { cpDb },
    );

    assert.equal(report.isDryRun, false);
    assert.equal(report.state, "sweeping");
    assert.equal(report.priorState, "needs_recovery");
    assert.equal(report.recoverToState, "sweeping");
    assert.equal(report.clearedLastError, "tenant_fence_claim_failed");
    assert.equal(report.leaseReleased, true);
    assert.equal(report.claimableNow, true);
    assert.ok(report.actionRequired.includes("pnpm memory:upgrade sweep"));

    const [row] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "sweeping");
    assert.equal(row.recoverToState, null);
    assert.equal(row.lastError, null);
    assert.equal(row.leaseToken, null);
    assert.equal(row.leaseOwner, null);

    // Clean up
    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });

  await t.test(
    "refuses from any non-needs_recovery state (sweeping/draining/verified/pruning/completed/rolled_back/aborted)",
    async () => {
      const nonRecoveryStates: UpgradeState[] = [
        "sweeping",
        "draining",
        "verified",
        "pruning",
        "completed",
        "rolled_back",
        "aborted",
      ];

      for (const st of nonRecoveryStates) {
        const [upgrade] = await cpDb
          .insert(companyMemoryUpgrades)
          .values({
            ...baseUpgradeValues,
            state: st,
            recoverToState: null,
            lastError: null,
          })
          .returning();

        await assert.rejects(
          () => runRecover({ companyId: company.id, confirm: company.id }, { cpDb }),
          (err: any) => {
            assert.ok(err instanceof CompanyMemoryUpgradeError);
            if (st === "completed" || st === "rolled_back" || st === "aborted") {
              assert.equal(err.code, "STATE_MISMATCH");
            } else {
              assert.equal(err.code, "INVALID_RECOVERY");
            }
            return true;
          },
        );

        const [row] = await cpDb
          .select()
          .from(companyMemoryUpgrades)
          .where(eq(companyMemoryUpgrades.id, upgrade.id));
        assert.equal(row.state, st);

        await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
      }
    },
  );

  await t.test(
    "refuses while company deletion is in progress (assert the 409 path / conflict error surfaces and no state change)",
    async () => {
      const [upgrade] = await cpDb
        .insert(companyMemoryUpgrades)
        .values({
          ...baseUpgradeValues,
          state: "needs_recovery",
          recoverToState: "sweeping",
          lastError: "heartbeat_lost",
        })
        .returning();

      await cpDb
        .update(companies)
        .set({ deletionStartedAt: new Date() })
        .where(eq(companies.id, company.id));

      try {
        await assert.rejects(
          () => runRecover({ companyId: company.id, confirm: company.id }, { cpDb }),
          (err: any) => {
            assert.ok(err instanceof CompanyMemoryUpgradeError);
            assert.equal(err.code, "COMPANY_DELETION_IN_PROGRESS");
            return true;
          },
        );

        // State remains untouched
        const [row] = await cpDb
          .select()
          .from(companyMemoryUpgrades)
          .where(eq(companyMemoryUpgrades.id, upgrade.id));
        assert.equal(row.state, "needs_recovery");
        assert.equal(row.recoverToState, "sweeping");
        assert.equal(row.lastError, "heartbeat_lost");
      } finally {
        await cpDb
          .update(companies)
          .set({ deletionStartedAt: null })
          .where(eq(companies.id, company.id));
        await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
      }
    },
  );

  await t.test(
    "the lease is released so a following sweep can claim it (assert claimability right after)",
    async () => {
      const [upgrade] = await cpDb
        .insert(companyMemoryUpgrades)
        .values({
          ...baseUpgradeValues,
          state: "needs_recovery",
          recoverToState: "sweeping",
        })
        .returning();

      // Retry-once on lease release: attempt 0 fails, attempt 1 succeeds
      let releaseAttempts = 0;
      const report = await runRecover(
        { companyId: company.id, confirm: company.id },
        {
          cpDb,
          _internalReleaseHook: async (attempt) => {
            releaseAttempts++;
            if (attempt === 0) {
              throw new Error("transient release error");
            }
          },
        },
      );

      assert.equal(releaseAttempts, 2);
      assert.equal(report.leaseReleased, true);
      assert.equal(report.claimableNow, true);

      // Claim right after: must succeed because lease was released
      const claim = await claimUpgradeLease(cpDb, {
        upgradeId: upgrade.id,
        leaseOwner: "followup_sweep_worker",
        now: new Date(),
      });
      assert.equal(claim.acquired, true);
      assert.ok(claim.leaseToken !== null);

      await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    },
  );

  await t.test(
    "persistent release failure throws and is reported clearly rather than silently succeeding",
    async () => {
      const [upgrade] = await cpDb
        .insert(companyMemoryUpgrades)
        .values({
          ...baseUpgradeValues,
          state: "needs_recovery",
          recoverToState: "sweeping",
        })
        .returning();

      await assert.rejects(
        () =>
          runRecover(
            { companyId: company.id, confirm: company.id },
            {
              cpDb,
              _internalReleaseHook: async () => {
                throw new Error("persistent release network error");
              },
            },
          ),
        (err: any) => {
          assert.equal(err?.message, "persistent release network error");
          return true;
        },
      );

      await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    },
  );

  await t.test(
    "recover_to_state = flipping tells the operator to re-run flip",
    async () => {
      const [upgrade] = await cpDb
        .insert(companyMemoryUpgrades)
        .values({
          ...baseUpgradeValues,
          state: "needs_recovery",
          recoverToState: "flipping",
        })
        .returning();

      const report = await runRecover(
        { companyId: company.id, confirm: company.id },
        { cpDb },
      );

      assert.equal(report.state, "flipping");
      assert.ok(report.actionRequired.includes("pnpm memory:upgrade flip"));
      assert.ok(report.actionRequired.includes("flip is idempotent"));

      const formatted = formatRecoverReport(report, "text");
      assert.ok(formatted.includes("Restored State: flipping"));
      assert.ok(formatted.includes("Run 'pnpm memory:upgrade flip'"));
      assert.ok(formatted.includes("flip is idempotent"));

      await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
    },
  );

  await t.test("dry run changes nothing", async () => {
    const [upgrade] = await cpDb
      .insert(companyMemoryUpgrades)
      .values({
        ...baseUpgradeValues,
        state: "needs_recovery",
        recoverToState: "sweeping",
        lastError: "unhandled_crash",
      })
      .returning();

    // 1. Without confirm
    const rep1 = await runRecover({ companyId: company.id }, { cpDb });
    assert.equal(rep1.isDryRun, true);
    assert.equal(rep1.leaseReleased, false);
    assert.equal(rep1.claimableNow, false);

    // 2. With dryRun: true
    const rep2 = await runRecover(
      { companyId: company.id, confirm: company.id, dryRun: true },
      { cpDb },
    );
    assert.equal(rep2.isDryRun, true);

    const [row] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "needs_recovery");
    assert.equal(row.recoverToState, "sweeping");
    assert.equal(row.lastError, "unhandled_crash");
    assert.equal(row.leaseToken, null);

    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });

  await t.test("mismatched --confirm throws; recover rejects other commands' flags", async () => {
    const wrongUuid = randomUUID();
    await assert.rejects(
      () => runRecover({ companyId: company.id, confirm: wrongUuid }, { cpDb }),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "INVALID_ARGUMENT");
        return true;
      },
    );

    assert.throws(
      () =>
        parseRecoverArgs(
          ["--company", company.id, "--confirm", wrongUuid],
          { CONTROL_PLANE_DATABASE_URL: env.cpUrl.toString() },
          process.cwd(),
        ),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "INVALID_ARGUMENT");
        return true;
      },
    );

    // Foreign flags rejected
    for (const flag of ["--table", "--database-url", "--model", "--max-rows"]) {
      assert.throws(
        () => validateNoUnknownFlags([flag], ALLOWED_RECOVER_FLAGS, "recover", BOOLEAN_RECOVER_FLAGS),
        (err: any) => {
          assert.ok(err instanceof CompanyMemoryUpgradeError);
          assert.equal(err.code, "INVALID_ARGUMENT");
          return true;
        },
      );
    }
  });

  await t.test("sweep's needs_recovery message is the allowlisted text verbatim", async () => {
    const [upgrade] = await cpDb
      .insert(companyMemoryUpgrades)
      .values({
        ...baseUpgradeValues,
        state: "needs_recovery",
        recoverToState: "sweeping",
      })
      .returning();

    const expectedMessage =
      "Upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' before resuming sweep.";

    let caughtErr: unknown = null;
    try {
      await runSweep(
        {
          companyId: company.id,
          databaseUrl: env.tenantUrl.toString(),
          controlPlaneUrl: env.cpUrl.toString(),
        },
        {
          controlPlaneDb: cpDb,
          tenantSql: env.tenantWorkerSql,
          _internalSkipVectorIdentityCheck: true,
        },
      );
    } catch (err: unknown) {
      caughtErr = err;
    }

    assert.ok(caughtErr instanceof CompanyMemoryUpgradeError);
    assert.equal(caughtErr.code, "STATE_MISMATCH");
    assert.equal(caughtErr.message, expectedMessage);

    const sanitized = sanitizeCliErrorMessage(caughtErr);
    assert.equal(sanitized, `[STATE_MISMATCH] ${expectedMessage}`);

    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });

  await t.test("runRecoverCli execution and report formatting", async () => {
    const [upgrade] = await cpDb
      .insert(companyMemoryUpgrades)
      .values({
        ...baseUpgradeValues,
        state: "needs_recovery",
        recoverToState: "draining",
      })
      .returning();

    // Dry run via CLI
    const dryRunCode = await runRecoverCli(
      ["--company", company.id, "--dry-run"],
      {
        cpDb,
        env: { CONTROL_PLANE_DATABASE_URL: env.cpUrl.toString() },
      },
    );
    assert.equal(dryRunCode, 0);

    // Confirmed run via CLI
    const confirmedCode = await runRecoverCli(
      ["--company", company.id, "--confirm", company.id, "--format", "json"],
      {
        cpDb,
        env: { CONTROL_PLANE_DATABASE_URL: env.cpUrl.toString() },
      },
    );
    assert.equal(confirmedCode, 0);

    const [row] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgrade.id));
    assert.equal(row.state, "draining");
    assert.equal(row.recoverToState, null);
    assert.equal(row.leaseToken, null);

    await cpDb.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.id, upgrade.id));
  });
});
