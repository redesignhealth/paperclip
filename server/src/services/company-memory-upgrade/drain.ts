/**
 * Orchestrator service for company memory upgrade drain (TECH-8191 §Q3, PR5.7).
 */

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createDb, type Db } from "@paperclipai/db";
import { assertCompanyAcceptsMemoryWork, findActiveUpgrade } from "./admission.js";
import {
  frozenClock,
  readCpNow,
  readUpgradeWithCpNow,
} from "./cp-clock.js";
import { openTenantClient } from "./sweep-tenant.js";
import { runDrainProbe, type DrainProbeResult } from "./drain-probe.js";
import { findBlockingPreFlipRuns, type BlockingRun } from "./drain-runs.js";
import { evaluateDrainEvidence, type DrainEvidenceDecision } from "./drain-evidence.js";
import { runTenantPreflight } from "./preflight.js";
import { readScopeMigrationMarker } from "./scope-marker.js";
import {
  claimUpgradeLease,
  releaseUpgradeLease,
  updateUpgradeCounters,
} from "./state-machine.js";
import {
  CompanyMemoryUpgradeError,
  type UpgradeState,
} from "./types.js";

function sameInstant(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const aMs = a instanceof Date ? a.getTime() : new Date(a).getTime();
  const bMs = b instanceof Date ? b.getTime() : new Date(b).getTime();
  return aMs === bMs;
}

export interface DrainOptions {
  companyId: string;
  tenantDatabaseUrl: string;
  controlPlaneDatabaseUrl: string;
  table?: string;
  confirm?: string;
  dryRun?: boolean;
  once?: boolean;
  probeIntervalMinutes?: number;
  maxDrainHours?: number;
  probeLimit?: number;
  blockingRunLimit?: number;
}

export interface DrainReport {
  isDryRun: boolean;
  companyId: string;
  companyName: string | null;
  upgradeId: string;
  state: UpgradeState;
  markedAt: Date | null;
  agentScopeObservedAt: Date | null;
  blockingSources: number;
  missingScopeBlockingSources: number;
  pendingPublishableRows: number;
  blockingRuns: BlockingRun[];
  leaseHeldByOther: boolean;
  counts: boolean;
  streakStartedAt: Date | null;
  nextStreakStartedAt: Date | null;
  confirmed: boolean;
  confirmedAt: Date | null;
  blockedBy: string[];
  deadline: Date;
  durationMs: number;
  evidenceInvalidated: boolean;
}

export interface DrainDependencies {
  cpDb?: Db;
  tenantSql?: postgres.Sql;
  sleep?: (ms: number) => Promise<void>;
  _internalSkipVectorIdentityCheck?: boolean;
  _internalDatabaseIdentityOverride?: { database?: string | null; user?: string | null };
  _internalCreateCpDb?: (url: string, opts?: any) => Db;
  _internalOpenTenantClient?: (url: string, opts?: any) => postgres.Sql;
  _internalLoopHook?: (iteration: number, evalResult: DrainEvidenceDecision) => void | Promise<void>;
}

export function formatDrainReport(report: DrainReport, format: "text" | "json" = "text"): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  const blockingRunIds = report.blockingRuns.length > 0
    ? report.blockingRuns.map((r) => r.id).join(", ")
    : "none";
  const blockedByReasons = report.blockedBy.length > 0
    ? report.blockedBy.join(", ")
    : "none";
  const lines = [
    `=== Memory Upgrade Drain Report ===`,
    `Mode: ${report.isDryRun ? "DRY RUN (no changes made)" : "CONFIRMED"}`,
    `Company ID: ${report.companyId}`,
    `Company Name: ${report.companyName ?? "unknown"}`,
    `Upgrade ID: ${report.upgradeId}`,
    `State: ${report.state}`,
    `Marked at: ${report.markedAt?.toISOString() ?? "null"}`,
    `Agent scope observed at: ${report.agentScopeObservedAt?.toISOString() ?? "none"}`,
    `Drain probe:`,
    `  Blocking sources: ${report.blockingSources}`,
    `  Missing scope sources: ${report.missingScopeBlockingSources}${report.missingScopeBlockingSources > 0 ? " (non-waitable)" : ""}`,
    `  Pending publishable rows: ${report.pendingPublishableRows}`,
    `Blocking pre-flip runs (${report.blockingRuns.length}): ${blockingRunIds}`,
    `Lease: ${report.leaseHeldByOther ? "held by other owner (a sweep or publish is in flight)" : "free"}`,
    `Streak:`,
    `  Counts: ${report.counts}`,
    `  Evidence invalidated: ${report.evidenceInvalidated}`,
    `  Streak started at: ${report.streakStartedAt?.toISOString() ?? "null"}`,
    `  Next streak started at: ${report.nextStreakStartedAt?.toISOString() ?? "null"}`,
    `  Confirmed: ${report.confirmed}`,
    `  Confirmed at: ${report.confirmedAt?.toISOString() ?? "null"}`,
    `  Blocked by: ${blockedByReasons}`,
    `Deadline: ${report.deadline.toISOString()}`,
    `Duration: ${report.durationMs}ms`,
  ];
  if (report.isDryRun) {
    lines.push(`Advisory: evidence was not taken under lease; a concurrent sweep or publish may have invalidated it.`);
  }
  return lines.join("\n");
}

export async function runDrain(
  options: DrainOptions,
  deps: DrainDependencies = {},
): Promise<DrainReport> {
  const startTime = Date.now();
  const companyId = options.companyId;
  const tableName = options.table ?? "mem0_memories";

  if (options.confirm !== undefined && options.confirm !== companyId) {
    throw new CompanyMemoryUpgradeError(
      "Confirmation company ID does not match target company ID.",
      "INVALID_ARGUMENT",
    );
  }

  const isDryRun = Boolean(options.dryRun || options.confirm === undefined);
  const probeIntervalMinutes = options.probeIntervalMinutes ?? 10;
  if (probeIntervalMinutes < 10) {
    throw new CompanyMemoryUpgradeError(
      "Invalid --probe-interval-minutes. Must be an integer of at least 10.",
      "INVALID_ARGUMENT",
    );
  }

  const maxDrainHours = options.maxDrainHours ?? 24;
  if (maxDrainHours <= 0 || maxDrainHours > 168) {
    throw new CompanyMemoryUpgradeError(
      "Invalid --max-drain-hours. Must be a positive number of hours not exceeding 168.",
      "INVALID_ARGUMENT",
    );
  }

  const probeLimit = options.probeLimit ?? 1000;
  const blockingRunLimit = options.blockingRunLimit ?? 25;

  let cpDb = deps.cpDb;
  let tenantSql = deps.tenantSql;
  let ownCp = false;
  let ownTenant = false;

  try {
    if (!cpDb) {
      if (!options.controlPlaneDatabaseUrl) {
        throw new CompanyMemoryUpgradeError("controlPlaneDatabaseUrl required.", "INVALID_ARGUMENT");
      }
      const createDbFn = deps._internalCreateCpDb ?? createDb;
      cpDb = createDbFn(options.controlPlaneDatabaseUrl, { maxConnections: 1 });
      ownCp = true;
    }
    if (!tenantSql) {
      if (!options.tenantDatabaseUrl) {
        throw new CompanyMemoryUpgradeError("tenantDatabaseUrl required.", "INVALID_ARGUMENT");
      }
      const openTenantFn = deps._internalOpenTenantClient ?? openTenantClient;
      tenantSql = openTenantFn(options.tenantDatabaseUrl, { max: 1 });
      ownTenant = true;
    }

    const preflight = await runTenantPreflight(
      cpDb,
      tenantSql,
      { companyId, tableName },
      {
        _internalSkipVectorIdentityCheck: deps._internalSkipVectorIdentityCheck,
        _internalDatabaseIdentityOverride: deps._internalDatabaseIdentityOverride,
      },
    );

    const initialUpgrade = await cpDb.transaction(async (tx) => {
      await assertCompanyAcceptsMemoryWork(tx, companyId);
      return await findActiveUpgrade(tx, companyId);
    });
    if (!initialUpgrade) {
      throw new CompanyMemoryUpgradeError("No active memory upgrade for this company.", "STATE_MISMATCH");
    }
    if (initialUpgrade.state !== "draining") {
      console.error(
        `[drain_state_mismatch] Active upgrade is in state '${initialUpgrade.state}', expected 'draining'.`,
      );
      throw new CompanyMemoryUpgradeError(
        "Cannot run drain: active upgrade is not in draining state.",
        "STATE_MISMATCH",
      );
    }

    const marker = await readScopeMigrationMarker(cpDb, companyId);
    if (
      !initialUpgrade.markedAt ||
      !marker?.completedAt ||
      initialUpgrade.markedAt.getTime() !== marker.completedAt.getTime()
    ) {
      throw new CompanyMemoryUpgradeError(
        "Scope migration marker missing or does not match upgrade marked_at.",
        "FLIP_MARKER_MISSING",
      );
    }

    const deadline = new Date(initialUpgrade.markedAt.getTime() + maxDrainHours * 60 * 60 * 1000);
    let iteration = 0;

    while (true) {
      iteration++;

      const { row: currentUpgrade, dbNow: tProbe } = await readUpgradeWithCpNow(cpDb, initialUpgrade.id);
      if (!currentUpgrade || currentUpgrade.state !== "draining") {
        console.error(
          `[drain_state_mismatch] Active upgrade is in state '${currentUpgrade?.state ?? "none"}', expected 'draining'.`,
        );
        throw new CompanyMemoryUpgradeError(
          "Cannot run drain: active upgrade is not in draining state.",
          "STATE_MISMATCH",
        );
      }

      const snap = {
        streak: currentUpgrade.drainProbeStreakStartedAt ?? null,
        confirmedAt: currentUpgrade.drainConfirmedAt ?? null,
        markedAt: currentUpgrade.markedAt,
        state: currentUpgrade.state as UpgradeState,
      };

      if (tProbe.getTime() >= deadline.getTime()) {
        const blockingRuns = await findBlockingPreFlipRuns(cpDb, {
          companyId,
          markedAt: snap.markedAt!,
          limit: blockingRunLimit,
        });
        const runIdsStr = blockingRuns.map((r) => r.id).join(", ") || "none";
        const streakStr = snap.streak ? snap.streak.toISOString() : "null";
        console.error(
          `[drain_timeout] Drain deadline expired. Blocking run IDs: [${runIdsStr}]. Streak started at: ${streakStr}`,
        );

        if (!isDryRun) {
          const rand8 = randomUUID().replace(/-/g, "").slice(0, 8);
          const leaseOwner = `memupg_drain_timeout_${process.pid}_${rand8}`;
          const tClaim = await readCpNow(cpDb);
          const claimRes = await claimUpgradeLease(cpDb, {
            upgradeId: currentUpgrade.id,
            leaseOwner,
            now: tClaim,
          });
          if (claimRes.acquired && claimRes.leaseToken) {
            try {
              const tWrite = await readCpNow(cpDb);
              await updateUpgradeCounters(
                cpDb,
                currentUpgrade.id,
                claimRes.leaseToken,
                { lastError: "drain_timeout" },
                { clock: frozenClock(tWrite) },
              );
            } finally {
              const tRelease = await readCpNow(cpDb);
              await releaseUpgradeLease(cpDb, currentUpgrade.id, claimRes.leaseToken, {
                clock: frozenClock(tRelease),
              });
            }
          } else {
            console.error(
              `[drain_timeout] last_error was NOT persisted: another worker holds the upgrade lease.\n` +
              `The upgrade row is unchanged; re-run drain after the in-flight sweep or publish finishes ` +
              `if you need the timeout recorded.`,
            );
          }
        }

        throw new CompanyMemoryUpgradeError(
          `Drain deadline expired (${maxDrainHours} hours from flip). Blocking pre-flip runs: [${runIdsStr}].`,
          "DRAIN_TIMEOUT",
        );
      }

      const leaseHeldByOther = Boolean(
        currentUpgrade.leaseToken &&
        currentUpgrade.leaseExpiresAt &&
        currentUpgrade.leaseExpiresAt.getTime() > tProbe.getTime(),
      );
      if (leaseHeldByOther) {
        console.error("a sweep or publish is in flight");
      }

      const probe = await runDrainProbe(tenantSql, {
        upgradeId: currentUpgrade.id,
        tableName,
        cpAgentMap: preflight.cpAgentMap,
        limit: probeLimit,
      });

      if (probe.missingScopeBlockingSources > 0) {
        console.error(
          `[drain_blocked_missing_scope] Live rows whose payload has no 'user_id' that a draining ` +
          `sweep cannot adopt: ${probe.missingScopeBlockingSources} (probe limit ${probeLimit}). ` +
          `Waiting cannot clear this.`,
        );
        throw new CompanyMemoryUpgradeError(
          "Drain refused: the live collection contains rows with no memory scope.",
          "DRAIN_BLOCKED_MISSING_SCOPE",
        );
      }

      const blockingRuns = await findBlockingPreFlipRuns(cpDb, {
        companyId,
        markedAt: snap.markedAt!,
        limit: blockingRunLimit,
      });

      const markerRow = await readScopeMigrationMarker(cpDb, companyId);
      const agentScopeObservedAt = markerRow?.agentScopeObservedAt ?? null;

      const evalResult = evaluateDrainEvidence({
        probe,
        blockingRuns,
        agentScopeObservedAt,
        markedAt: snap.markedAt!,
        streakStartedAt: snap.streak,
        leaseHeldByOther,
        now: tProbe,
      });

      await deps._internalLoopHook?.(iteration, evalResult);

      const streakChanged =
        (evalResult.nextStreakStartedAt === null && snap.streak !== null) ||
        (evalResult.nextStreakStartedAt !== null && snap.streak === null) ||
        (evalResult.nextStreakStartedAt !== null &&
          snap.streak !== null &&
          evalResult.nextStreakStartedAt.getTime() !== snap.streak.getTime());

      let effectiveStreakStart = snap.streak;
      let confirmedAt: Date | null = snap.confirmedAt;
      let evidenceInvalidated = false;

      // When another owner holds the lease, whoever holds the lease either already cleared
      // the streak at the tenant fence or will never mutate, so drain need not persist anything.
      const needsWrite =
        !isDryRun &&
        !leaseHeldByOther &&
        (streakChanged || (evalResult.confirmed && !snap.confirmedAt));

      if (needsWrite) {
        const tClaim = await readCpNow(cpDb);
        const rand8 = randomUUID().replace(/-/g, "").slice(0, 8);
        const leaseOwner = `memupg_drain_${process.pid}_${rand8}`;
        const claimRes = await claimUpgradeLease(cpDb, {
          upgradeId: currentUpgrade.id,
          leaseOwner,
          now: tClaim,
        });
        if (claimRes.acquired && claimRes.leaseToken) {
          let releaseClock = frozenClock(tClaim);
          try {
            const { row: underLease, dbNow: tWrite } = await readUpgradeWithCpNow(cpDb, currentUpgrade.id);
            releaseClock = frozenClock(tWrite);

            if (!underLease || underLease.state !== "draining") {
              console.error(
                `[drain_state_mismatch] Active upgrade is in state '${underLease?.state ?? "none"}', expected 'draining'.`,
              );
              throw new CompanyMemoryUpgradeError(
                "Cannot run drain: active upgrade is not in draining state.",
                "STATE_MISMATCH",
              );
            }

            const matchesSnapshot =
              sameInstant(underLease.markedAt, snap.markedAt) &&
              sameInstant(underLease.drainProbeStreakStartedAt, snap.streak) &&
              sameInstant(underLease.drainConfirmedAt, snap.confirmedAt);

            if (!matchesSnapshot) {
              evidenceInvalidated = true;
              console.error(
                "[drain_evidence_invalidated] Upgrade row changed between probe and lease claim; discarding observation.",
              );
            } else {
              const streakToWrite =
                evalResult.nextStreakStartedAt === null ? null : (snap.streak ?? tWrite);
              const updated = await updateUpgradeCounters(
                cpDb,
                currentUpgrade.id,
                claimRes.leaseToken,
                {
                  drainProbeStreakStartedAt: streakToWrite,
                  ...(evalResult.confirmed ? { drainConfirmedAt: tWrite } : {}),
                },
                { clock: frozenClock(tWrite) },
              );
              effectiveStreakStart = updated.drainProbeStreakStartedAt ?? null;
              confirmedAt = updated.drainConfirmedAt ?? null;
            }
          } finally {
            await releaseUpgradeLease(cpDb, currentUpgrade.id, claimRes.leaseToken, {
              clock: releaseClock,
            });
          }
        } else {
          if (options.once) {
            throw new CompanyMemoryUpgradeError(
              "Failed to acquire lease for upgrade write. Another worker may hold the lease.",
              "LEASE_FENCED_OUT",
            );
          }
          console.error("a sweep or publish is in flight");
        }
      } else if (isDryRun) {
        effectiveStreakStart = evalResult.nextStreakStartedAt;
        if (evalResult.confirmed) {
          confirmedAt = tProbe;
        }
      }

      const isActuallyConfirmed =
        !evidenceInvalidated && (isDryRun ? evalResult.confirmed : Boolean(confirmedAt));

      const report: DrainReport = {
        isDryRun,
        companyId,
        companyName: preflight.resolvedCompanyName,
        upgradeId: currentUpgrade.id,
        state: currentUpgrade.state as UpgradeState,
        markedAt: currentUpgrade.markedAt,
        agentScopeObservedAt,
        blockingSources: probe.blockingSources,
        missingScopeBlockingSources: probe.missingScopeBlockingSources,
        pendingPublishableRows: probe.pendingPublishableRows,
        blockingRuns,
        leaseHeldByOther,
        counts: evalResult.counts && !evidenceInvalidated,
        streakStartedAt: effectiveStreakStart,
        nextStreakStartedAt: evalResult.nextStreakStartedAt,
        confirmed: isActuallyConfirmed,
        confirmedAt,
        blockedBy: evidenceInvalidated
          ? [...evalResult.blockedBy, "evidence_invalidated_by_concurrent_work"]
          : evalResult.blockedBy,
        deadline,
        durationMs: Date.now() - startTime,
        evidenceInvalidated,
      };

      if (isActuallyConfirmed || isDryRun || options.once) {
        return report;
      }

      const sleepFn = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
      await sleepFn(probeIntervalMinutes * 60 * 1000);
    }
  } finally {
    if (ownTenant && tenantSql) {
      await tenantSql.end({ timeout: 5 }).catch(() => {});
    }
    if (ownCp && cpDb) {
      await cpDb.$client.end({ timeout: 5 }).catch(() => {});
    }
  }
}
