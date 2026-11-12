/**
 * Report types and formatting for company memory upgrade recovery (TECH-8191 §Q6, PR5.11).
 */

import type { UpgradeState } from "./types.js";

export interface RecoverReport {
  isDryRun: boolean;
  companyId: string;
  companyName: string | null;
  upgradeId: string;
  state: UpgradeState;
  priorState: UpgradeState;
  recoverToState: UpgradeState;
  clearedLastError: string | null;
  /** leaseOwner is always null now: leaseReleased means the upgrade holds no lease after recovery. */
  leaseOwner: string | null;
  leaseReleased: boolean;
  claimableNow: boolean;
  recoveryConfirmedByReadback: boolean;
  actionRequired: string;
  durationMs: number;
}

export function formatRecoverActionRequired(
  state: UpgradeState,
  isDryRun: boolean,
  recoveryConfirmedByReadback = false,
): string {
  let action: string;
  if (isDryRun) {
    if (state === "flipping") {
      action =
        "[DRY RUN] Would restore upgrade state to 'flipping', clear last_error, and release lease. After running recover, re-run 'pnpm memory:upgrade flip' to finish the flip (flip is idempotent).";
    } else if (state === "verified") {
      action =
        "[DRY RUN] Would restore upgrade state to 'verified', clear last_error, and release lease. Re-run 'pnpm memory:upgrade verify' to confirm gates still hold, or run 'pnpm memory:upgrade rollback' if rollback is needed before pruning.";
    } else if (state === "pruning") {
      action =
        "[DRY RUN] Would restore upgrade state to 'pruning', clear last_error, and release lease. Pruning tooling is not yet available in this release. The upgrade should be left in 'pruning' until tooling ships; rollback is refused once pruning has started, and manual database cleanup should not be attempted.";
    } else {
      action = `[DRY RUN] Would restore upgrade state to '${state}', clear last_error, and release lease.`;
    }
  } else {
    switch (state) {
      case "flipping":
        action =
          "The upgrade was restored to 'flipping'. Run 'pnpm memory:upgrade flip' to finish the flip (flip is idempotent).";
        break;
      case "sweeping":
        action =
          "The upgrade was restored to 'sweeping'. Run 'pnpm memory:upgrade sweep' to resume sweeping.";
        break;
      case "draining":
        action =
          "The upgrade was restored to 'draining'. Run 'pnpm memory:upgrade drain' or catch-up sweep/publish to resume.";
        break;
      case "verified":
        action =
          "The upgrade was restored to 'verified'. Re-run 'pnpm memory:upgrade verify' to confirm gates still hold, or run 'pnpm memory:upgrade rollback' if rollback is needed before pruning.";
        break;
      case "pruning":
        action =
          "The upgrade was restored to 'pruning'. Pruning tooling is not yet available in this release. The upgrade should be left in 'pruning' until tooling ships; rollback is refused once pruning has started, and manual database cleanup should not be attempted.";
        break;
      default:
        action = `The upgrade was restored to '${state}'.`;
        break;
    }
  }
  if (recoveryConfirmedByReadback) {
    action +=
      " The recover command lost its connection before it could confirm the result, but a readback shows the recovery committed. No second recover is needed.";
  }
  return action;
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
    `Recovery Confirmed By Readback: ${report.recoveryConfirmedByReadback ? "yes" : "no"}`,
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
