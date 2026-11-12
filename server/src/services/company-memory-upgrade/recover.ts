/**
 * Orchestrator service for company memory upgrade recovery (TECH-8191 §Q6, PR5.11).
 */

import { randomUUID } from "node:crypto";
import { companies, createDb, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { assertCompanyAcceptsMemoryWork, findActiveUpgrade } from "./admission.js";
import { frozenClock, readCpNow } from "./cp-clock.js";
import { ACTIVE_PRE_LAPSE_STATES, recoverUpgrade, releaseUpgradeLease } from "./state-machine.js";
import { CompanyMemoryUpgradeError, type UpgradeState } from "./types.js";

export interface RecoverOptions {
  companyId: string;
  controlPlaneDatabaseUrl?: string;
  confirm?: string;
  dryRun?: boolean;
}

export interface RecoverReport {
  isDryRun: boolean;
  companyId: string;
  companyName: string | null;
  upgradeId: string;
  state: UpgradeState;
  priorState: UpgradeState;
  recoverToState: UpgradeState;
  clearedLastError: string | null;
  leaseOwner: string | null;
  leaseReleased: boolean;
  claimableNow: boolean;
  actionRequired: string;
  durationMs: number;
}

export interface RecoverDependencies {
  cpDb?: Db;
  _internalCreateCpDb?: (url: string, opts?: any) => Db;
  _internalReleaseHook?: (attempt: number) => Promise<void> | void;
}

export function formatRecoverActionRequired(state: UpgradeState, isDryRun: boolean): string {
  if (isDryRun) {
    return state === "flipping"
      ? "[DRY RUN] Would restore upgrade state to 'flipping', clear last_error, and release lease. After running recover, re-run 'pnpm memory:upgrade flip' to finish the flip (flip is idempotent)."
      : `[DRY RUN] Would restore upgrade state to '${state}', clear last_error, and release lease.`;
  }
  switch (state) {
    case "flipping":
      return "The upgrade was restored to 'flipping'. Run 'pnpm memory:upgrade flip' to finish the flip (flip is idempotent).";
    case "sweeping":
      return "The upgrade was restored to 'sweeping'. Run 'pnpm memory:upgrade sweep' to resume sweeping.";
    case "draining":
      return "The upgrade was restored to 'draining'. Run 'pnpm memory:upgrade drain' or catch-up sweep/publish to resume.";
    case "pruning":
      return "The upgrade was restored to 'pruning'. Run 'pnpm memory:upgrade prune' to resume.";
    default:
      return `The upgrade was restored to '${state}'.`;
  }
}

export function formatRecoverReport(report: RecoverReport, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  const lines = [
    "=== Memory Upgrade Recovery Report ===",
    `Mode: ${report.isDryRun ? "DRY RUN (no changes made)" : "CONFIRMED"}`,
    `Company ID: ${report.companyId}`,
    `Company Name: ${report.companyName ?? "unknown"}`,
    `Upgrade ID: ${report.upgradeId}`,
    `Prior State: ${report.priorState}`,
    `Restored State: ${report.state}`,
    `Recover-To State: ${report.recoverToState}`,
    `Cleared Last Error: ${report.clearedLastError ?? "none"}`,
    `Lease Released: ${report.leaseReleased ? "yes" : "no"}`,
    `Claimable Now: ${report.claimableNow ? "yes" : "no"}`,
    `Duration: ${report.durationMs}ms`,
    "",
    "Action Required:",
    `  ${report.actionRequired}`,
  ];
  if (report.isDryRun) {
    lines.push("", "Advisory: dry-run preview — no state change made and lease not acquired/released.");
  }
  return lines.join("\n");
}

async function attemptReleaseLease(
  cpDb: Db,
  upgradeId: string,
  token: string,
  hook?: (attempt: number) => Promise<void> | void,
): Promise<void> {
  let firstErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (hook) await hook(attempt);
      const tRelease = await readCpNow(cpDb);
      const res = await releaseUpgradeLease(cpDb, upgradeId, token, { clock: frozenClock(tRelease) });
      if (!res.released) {
        throw new CompanyMemoryUpgradeError(
          "Upgrade lease could not be released. The lease token or state may have changed.",
          "LEASE_EXPIRED",
        );
      }
      return;
    } catch (err: unknown) {
      if (attempt === 0) firstErr = err;
      else throw err;
    }
  }
  throw firstErr;
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
        actionRequired: formatRecoverActionRequired(recoverToState, true),
        durationMs: Date.now() - startTime,
      };
    }

    const leaseOwner = `memupg_recover_${process.pid}_${randomUUID().slice(0, 8)}`;
    const cpNow = await readCpNow(cpDb);
    const recovered = await recoverUpgrade(cpDb, initialUpgrade.id, leaseOwner, { clock: frozenClock(cpNow) });
    await attemptReleaseLease(cpDb, recovered.id, recovered.leaseToken!, deps._internalReleaseHook);

    const recoveredState = recovered.state as UpgradeState;
    return {
      isDryRun: false,
      companyId,
      companyName,
      upgradeId: recovered.id,
      state: recoveredState,
      priorState: initialUpgrade.state,
      recoverToState,
      clearedLastError: initialUpgrade.lastError,
      leaseOwner,
      leaseReleased: true,
      claimableNow: true,
      actionRequired: formatRecoverActionRequired(recoveredState, false),
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (ownCp && cpDb) await cpDb.$client?.end().catch(() => {});
  }
}
