/**
 * Orchestrator service for company memory upgrade recovery (TECH-8191 §Q6, PR5.11).
 */

import { companies, companyMemoryUpgrades, createDb, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { assertCompanyAcceptsMemoryWork, findActiveUpgrade } from "./admission.js";
import {
  formatRecoverActionRequired,
  formatRecoverReport,
  type RecoverReport,
} from "./recover-report.js";
import {
  ACTIVE_PRE_LAPSE_STATES,
  recoverUpgradeAndReleaseLease,
} from "./state-machine.js";
import {
  CompanyMemoryUpgradeError,
  type CompanyMemoryUpgradeRow,
  type UpgradeState,
} from "./types.js";

export { formatRecoverActionRequired, formatRecoverReport, type RecoverReport };

export interface RecoverOptions {
  companyId: string;
  controlPlaneDatabaseUrl?: string;
  confirm?: string;
  dryRun?: boolean;
}

export interface RecoverDependencies {
  cpDb?: Db;
  _internalCreateCpDb?: (url: string, opts?: any) => Db;
  _internalTxHook?: (phase: "before_update" | "after_update") => Promise<void> | void;
  _internalPostCommitHook?: () => Promise<void> | void;
  _internalReadbackHook?: () => Promise<void> | void;
}

const NO_READBACK_CODES = new Set([
  "UPGRADE_NOT_FOUND",
  "INVALID_RECOVERY",
  "RECOVER_LEASE_PRESENT",
  "CAS_FAILED",
  "INVALID_ARGUMENT",
]);

interface ResolveRecoverFailureContext {
  startTime: number;
  companyId: string;
  companyName: string | null;
  priorState: UpgradeState;
  recoverToState: UpgradeState;
  clearedLastError: string | null;
  deps: RecoverDependencies;
}

async function resolveRecoverFailure(
  cpDb: Db,
  upgradeId: string,
  err: unknown,
  ctx: ResolveRecoverFailureContext,
): Promise<RecoverReport> {
  if (err instanceof CompanyMemoryUpgradeError && NO_READBACK_CODES.has(err.code)) {
    throw err;
  }

  let readbackRow: CompanyMemoryUpgradeRow | undefined;
  try {
    if (ctx.deps._internalReadbackHook) {
      await ctx.deps._internalReadbackHook();
    }
    const [row] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, upgradeId));
    readbackRow = row;
  } catch (_readbackErr: unknown) {
    throw new CompanyMemoryUpgradeError(
      "Control-plane database unreachable or outcome could not be determined",
      "RECOVER_OUTCOME_UNKNOWN",
      { cause: err },
    );
  }

  if (!readbackRow) {
    throw new CompanyMemoryUpgradeError(
      "Control-plane database unreachable or outcome could not be determined",
      "RECOVER_OUTCOME_UNKNOWN",
      { cause: err },
    );
  }

  if (readbackRow.state !== "needs_recovery" && readbackRow.recoverToState === null) {
    const restoredState = readbackRow.state as UpgradeState;
    return {
      isDryRun: false,
      companyId: ctx.companyId,
      companyName: ctx.companyName,
      upgradeId: readbackRow.id,
      state: restoredState,
      priorState: ctx.priorState,
      recoverToState: ctx.recoverToState,
      clearedLastError: ctx.clearedLastError,
      leaseOwner: null,
      leaseReleased: true,
      claimableNow: readbackRow.leaseToken === null,
      recoveryConfirmedByReadback: true,
      actionRequired: formatRecoverActionRequired(restoredState, false, true),
      durationMs: Date.now() - ctx.startTime,
    };
  }

  if (readbackRow.state === "needs_recovery") {
    throw new CompanyMemoryUpgradeError(
      "Recovery was not applied: the upgrade remains in needs_recovery",
      "RECOVER_NOT_APPLIED",
      { cause: err },
    );
  }

  throw new CompanyMemoryUpgradeError(
    "Control-plane database unreachable or outcome could not be determined",
    "RECOVER_OUTCOME_UNKNOWN",
    { cause: err },
  );
}

export async function runRecover(
  options: RecoverOptions,
  deps: RecoverDependencies = {},
): Promise<RecoverReport> {
  const startTime = Date.now();
  const companyId = options.companyId;

  if (options.confirm !== undefined && options.confirm !== companyId) {
    throw new CompanyMemoryUpgradeError(
      "Confirmation company ID does not match target company ID.",
      "INVALID_ARGUMENT",
    );
  }

  const isDryRun = Boolean(options.dryRun || options.confirm === undefined);
  let cpDb = deps.cpDb;
  let ownCp = false;

  try {
    if (!cpDb) {
      if (!options.controlPlaneDatabaseUrl) {
        throw new CompanyMemoryUpgradeError("controlPlaneDatabaseUrl required.", "INVALID_ARGUMENT");
      }
      cpDb = (deps._internalCreateCpDb ?? createDb)(options.controlPlaneDatabaseUrl, { maxConnections: 1 });
      ownCp = true;
    }

    const initialUpgrade = await cpDb.transaction(async (tx) => {
      await assertCompanyAcceptsMemoryWork(tx, companyId);
      return await findActiveUpgrade(tx, companyId);
    });

    if (!initialUpgrade) {
      throw new CompanyMemoryUpgradeError("No active memory upgrade for this company.", "STATE_MISMATCH");
    }

    if (initialUpgrade.state !== "needs_recovery") {
      throw new CompanyMemoryUpgradeError("Cannot run recover: active upgrade is not in needs_recovery.", "INVALID_RECOVERY");
    }

    const recoverToState = initialUpgrade.recoverToState as UpgradeState | null;
    if (!recoverToState || !ACTIVE_PRE_LAPSE_STATES.has(recoverToState)) {
      throw new CompanyMemoryUpgradeError("Cannot recover upgrade: invalid or missing recover_to_state", "INVALID_RECOVERY");
    }

    const [company] = await cpDb.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    const companyName = company?.name ?? null;

    if (isDryRun) {
      return {
        isDryRun: true,
        companyId,
        companyName,
        upgradeId: initialUpgrade.id,
        state: recoverToState,
        priorState: initialUpgrade.state,
        recoverToState,
        clearedLastError: initialUpgrade.lastError,
        leaseOwner: null,
        leaseReleased: false,
        claimableNow: false,
        recoveryConfirmedByReadback: false,
        actionRequired: formatRecoverActionRequired(recoverToState, true),
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const recovered = await recoverUpgradeAndReleaseLease(cpDb, initialUpgrade.id, {
        _internalTxHook: deps._internalTxHook,
      });

      if (deps._internalPostCommitHook) {
        await deps._internalPostCommitHook();
      }

      const recoveredState = recovered.restoredState;
      return {
        isDryRun: false,
        companyId,
        companyName,
        upgradeId: recovered.row.id,
        state: recoveredState,
        priorState: initialUpgrade.state,
        recoverToState,
        clearedLastError: recovered.clearedLastError,
        leaseOwner: null,
        leaseReleased: true,
        claimableNow: true,
        recoveryConfirmedByReadback: false,
        actionRequired: formatRecoverActionRequired(recoveredState, false),
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return await resolveRecoverFailure(cpDb, initialUpgrade.id, err, {
        startTime,
        companyId,
        companyName,
        priorState: initialUpgrade.state,
        recoverToState,
        clearedLastError: initialUpgrade.lastError,
        deps,
      });
    }
  } finally {
    if (ownCp && cpDb) await cpDb.$client?.end().catch(() => {});
  }
}
