/**
 * Orchestrator service for company memory upgrade verify (TECH-8191 §Q4, PR5.8).
 *
 * Implements gates V1–V7, advances draining -> verified on confirmed run,
 * re-evaluates cleanly without transitioning when already verified,
 * and includes the authoritative disclaimer block.
 */

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createDb, type Db } from "@paperclipai/db";
import { assertCompanyAcceptsMemoryWork, findActiveUpgrade } from "./admission.js";
import { frozenClock, readCpNow, readUpgradeWithCpNow } from "./cp-clock.js";
import { openTenantClient } from "./sweep-tenant.js";
import { runDrainProbe, type DrainProbeResult } from "./drain-probe.js";
import { countPublishPending, type PublishPendingResult } from "./drain-probe-preflight.js";
import { findBlockingPreFlipRuns, type BlockingRun } from "./drain-runs.js";
import { runTenantPreflight } from "./preflight.js";
import { readScopeMigrationMarker, type ScopeMigrationMarker } from "./scope-marker.js";
import {
  advanceState,
  claimUpgradeLease,
  releaseUpgradeLease,
  updateUpgradeCounters,
} from "./state-machine.js";
import {
  CompanyMemoryUpgradeError,
  mapSweepErrorCode,
  type Clock,
  type UpgradeErrorCode,
  type UpgradeState,
} from "./types.js";

export const WHAT_VERIFY_DOES_NOT_PROVE = [
  "What this verification does NOT prove (see runbook §5.4):",
  "- That every legacy memory is now recallable by the right agent — recall quality is never tested.",
  "- That all agents observed agent scope — agent scope observation proves >=1 run, not coverage across all agents.",
  "- That the observation means a run succeeded — recordAgentScopedMemoryUse fires at scope resolution, before adapter dispatch.",
  "- That no further company-scoped write can occur.",
  "- That legacy rows are safe to delete — that is PR6 prune evidence, not verify's.",
  "- That the configuration is durable — turning agent-scoped-mem0 off after verify silently reverts reads to company scope.",
];

export interface VerifyOptions {
  companyId: string;
  tenantDatabaseUrl: string;
  controlPlaneDatabaseUrl: string;
  table?: string;
  confirm?: string;
  dryRun?: boolean;
  allowQuarantined?: boolean;
  probeLimit?: number;
  blockingRunLimit?: number;
  expectedMode?: string;
}

export interface VerifyReport {
  isDryRun: boolean;
  companyId: string;
  companyName: string | null;
  upgradeId: string;
  state: UpgradeState;
  priorState: UpgradeState;
  verifiedAt: Date | null;
  drainConfirmedAt: Date | null;
  markedAt: Date | null;
  agentScopeObservedAt: Date | null;
  scopeMigrationMode: string | null;
  pendingPublishableRows: number;
  pendingPublishableSources: number;
  probeBlockingSources: number;
  probeMissingScopeSources: number;
  blockingRunsCount: number;
  quarantinedCount: number;
  allowQuarantined: boolean;
  droppedNoiseCount: number;
  droppedSensitiveCount: number;
  durationMs: number;
  whatThisDoesNotProve: string[];
}

function guardCleanupErrorCode(err: unknown): UpgradeErrorCode {
  if (err && typeof err === "object" && "code" in err && typeof (err as any).code === "string") {
    return mapSweepErrorCode((err as any).code);
  }
  return "unexpected_failure";
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
      if (hook) {
        await hook(attempt);
      }
      const tRelease = await readCpNow(cpDb);
      await releaseUpgradeLease(cpDb, upgradeId, token, {
        clock: frozenClock(tRelease),
      });
      return;
    } catch (err: unknown) {
      if (attempt === 0) {
        firstErr = err;
      } else {
        throw err;
      }
    }
  }
}

export interface VerifyDependencies {
  cpDb?: Db;
  tenantSql?: postgres.Sql;
  _internalSkipVectorIdentityCheck?: boolean;
  _internalDatabaseIdentityOverride?: { database?: string | null; user?: string | null };
  _internalCreateCpDb?: (url: string, opts?: any) => Db;
  _internalOpenTenantClient?: (url: string, opts?: any) => postgres.Sql;
  _internalPreClaimHook?: () => Promise<void> | void;
  _internalPostClaimHook?: () => Promise<void> | void;
  _internalReleaseHook?: (attempt: number) => Promise<void> | void;
}

export function formatVerifyReport(report: VerifyReport, format: "text" | "json" = "text"): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  const lines = [
    `=== Memory Upgrade Verify Report ===`,
    `Mode: ${report.isDryRun ? "DRY RUN (no changes made)" : "CONFIRMED"}`,
    `Company ID: ${report.companyId}`,
    `Company Name: ${report.companyName ?? "unknown"}`,
    `Upgrade ID: ${report.upgradeId}`,
    `State: ${report.state}`,
    `Prior state: ${report.priorState}`,
    `Verified at: ${report.verifiedAt?.toISOString() ?? "null"}`,
    `Drain confirmed at: ${report.drainConfirmedAt?.toISOString() ?? "null"}`,
    `Marked at: ${report.markedAt?.toISOString() ?? "null"}`,
    `Agent scope observed at: ${report.agentScopeObservedAt?.toISOString() ?? "none"}`,
    `Scope migration mode: ${report.scopeMigrationMode ?? "none"}`,
    `Staging:`,
    `  Pending publishable rows: ${report.pendingPublishableRows}`,
    `  Pending publishable sources: ${report.pendingPublishableSources}`,
    `Fresh drain probe:`,
    `  Blocking sources: ${report.probeBlockingSources}`,
    `  Missing scope sources: ${report.probeMissingScopeSources}`,
    `Active pre-flip runs: ${report.blockingRunsCount}`,
    `Ledger outcomes:`,
    `  Quarantined: ${report.quarantinedCount}${report.allowQuarantined ? " (allowed by --allow-quarantined)" : ""}`,
    `  Dropped noise: ${report.droppedNoiseCount} (intentional outcome)`,
    `  Dropped sensitive: ${report.droppedSensitiveCount} (intentional outcome)`,
    `Duration: ${report.durationMs}ms`,
  ];
  if (report.isDryRun) {
    lines.push(`Advisory: dry-run preview — no lease claimed and upgrade state not transitioned.`);
  }
  lines.push("");
  for (const item of report.whatThisDoesNotProve) {
    lines.push(item);
  }
  return lines.join("\n");
}

export async function runVerify(
  options: VerifyOptions,
  deps: VerifyDependencies = {},
): Promise<VerifyReport> {
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
  const probeLimit = options.probeLimit ?? 1000;
  const blockingRunLimit = options.blockingRunLimit ?? 25;
  const allowQuarantined = Boolean(options.allowQuarantined);
  const expectedMode = options.expectedMode ?? "copy";

  let cpDb = deps.cpDb;
  let tenantSql = deps.tenantSql;
  let ownCp = false;
  let ownTenant = false;
  let leaseTokenToClean: string | null = null;
  let activeUpgradeId: string | null = null;
  let hasPrimaryError = false;

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
    if (initialUpgrade.state !== "draining" && initialUpgrade.state !== "verified") {
      throw new CompanyMemoryUpgradeError(
        "Cannot run verify: active upgrade is not in draining or verified state.",
        "STATE_MISMATCH",
      );
    }

    activeUpgradeId = initialUpgrade.id;

    const { row: currentUpgrade, dbNow } = await readUpgradeWithCpNow(cpDb, initialUpgrade.id);
    if (!currentUpgrade || (currentUpgrade.state !== "draining" && currentUpgrade.state !== "verified")) {
      throw new CompanyMemoryUpgradeError(
        "Cannot run verify: active upgrade is not in draining or verified state.",
        "STATE_MISMATCH",
      );
    }

    // Gate V1: drain confirmed
    if (!currentUpgrade.drainConfirmedAt) {
      throw new CompanyMemoryUpgradeError(
        "Verify refused: drain has not been confirmed for this upgrade. Run 'pnpm memory:upgrade drain' first.",
        "DRAIN_NOT_CONFIRMED",
      );
    }

    // Gate V1 freshness requirement: blocking pre-flip runs check
    if (!currentUpgrade.markedAt) {
      throw new CompanyMemoryUpgradeError(
        "The scope migration marker is not set, or does not match this upgrade's recorded flip time. Do not hand-edit scope_migration_completed_at; investigate before continuing.",
        "FLIP_MARKER_MISSING",
      );
    }

    const blockingRuns = await findBlockingPreFlipRuns(cpDb, {
      companyId,
      markedAt: currentUpgrade.markedAt,
      limit: blockingRunLimit,
    });
    if (blockingRuns.length > 0) {
      const runDetails = blockingRuns.map((r) => `${r.id} (${r.status})`).join(", ");
      throw new CompanyMemoryUpgradeError(
        `Verify refused: active pre-flip heartbeat runs are still running: ${runDetails}. Drain confirmation is stale.`,
        "VERIFICATION_FAILED",
      );
    }

    // Gate V2: Agent scope observed after flip
    const marker = await readScopeMigrationMarker(cpDb, companyId);
    if (
      !marker?.agentScopeObservedAt ||
      marker.agentScopeObservedAt.getTime() <= currentUpgrade.markedAt.getTime()
    ) {
      throw new CompanyMemoryUpgradeError(
        "No agent-scoped memory use has been observed for this company since the flip. The marker alone changes nothing unless 'agent-scoped-mem0' is enabled for the processes running this company's agents.",
        "AGENT_SCOPE_NOT_OBSERVED",
      );
    }

    // Gate V3: Marker still set and mode unchanged since flip
    if (
      !marker?.completedAt ||
      marker.completedAt.getTime() !== currentUpgrade.markedAt.getTime() ||
      !marker.mode ||
      (expectedMode && marker.mode !== expectedMode)
    ) {
      throw new CompanyMemoryUpgradeError(
        "The scope migration marker is not set, or does not match this upgrade's recorded flip time. Do not hand-edit scope_migration_completed_at; investigate before continuing.",
        "FLIP_MARKER_MISSING",
      );
    }

    // Gate V4: Publish pending == 0
    const pending: PublishPendingResult = await countPublishPending(tenantSql, currentUpgrade.id);
    if (pending.pendingRows > 0 || pending.pendingSources > 0) {
      throw new CompanyMemoryUpgradeError(
        `Verify refused: staged rows are still pending publish (${pending.pendingRows} rows across ${pending.pendingSources} sources). Run 'pnpm memory:upgrade publish' first.`,
        "VERIFICATION_FAILED",
      );
    }

    // Gate V5: Fresh drain probe is empty
    const probe: DrainProbeResult = await runDrainProbe(tenantSql, {
      upgradeId: currentUpgrade.id,
      tableName,
      cpAgentMap: preflight.cpAgentMap,
      limit: probeLimit,
    });
    if (probe.blockingSources > 0 || probe.missingScopeBlockingSources > 0) {
      throw new CompanyMemoryUpgradeError(
        `Verify refused: fresh drain probe found ${probe.blockingSources} blocking source(s) and ${probe.missingScopeBlockingSources} missing-scope source(s). Drain is not clean.`,
        "VERIFICATION_FAILED",
      );
    }

    // Gate V6: Zero quarantined ledger rows (unless overridden)
    const ledgerRows = (await tenantSql.unsafe(
      `SELECT
         count(*) FILTER (WHERE outcome = 'quarantined')::int AS quarantined_count,
         count(*) FILTER (WHERE outcome = 'dropped_noise')::int AS dropped_noise_count,
         count(*) FILTER (WHERE outcome = 'dropped_sensitive')::int AS dropped_sensitive_count
       FROM paperclip_memory_upgrade_ledger
       WHERE upgrade_id = $1::uuid;`,
      [currentUpgrade.id],
    )) as Array<{
      quarantined_count: number | string | null;
      dropped_noise_count: number | string | null;
      dropped_sensitive_count: number | string | null;
    }>;

    const quarantinedCount = Number(ledgerRows[0]?.quarantined_count ?? 0);
    const droppedNoiseCount = Number(ledgerRows[0]?.dropped_noise_count ?? 0);
    const droppedSensitiveCount = Number(ledgerRows[0]?.dropped_sensitive_count ?? 0);

    if (quarantinedCount > 0 && !allowQuarantined) {
      throw new CompanyMemoryUpgradeError(
        `Verify refused: quarantined sources remain in the ledger. Quarantined content never reached agent scope. Resolve them, or pass --allow-quarantined to accept the gap explicitly.`,
        "VERIFY_QUARANTINE_PRESENT",
      );
    }

    let finalState: UpgradeState = currentUpgrade.state;
    let verifiedAt = currentUpgrade.verifiedAt;
    let finalDrainConfirmedAt: Date | null = currentUpgrade.drainConfirmedAt;
    let finalMarkedAt: Date | null = currentUpgrade.markedAt;
    let finalAgentScopeObservedAt = marker.agentScopeObservedAt;
    let finalScopeMigrationMode = marker.mode;
    let finalPendingRows = pending.pendingRows;
    let finalPendingSources = pending.pendingSources;
    let finalProbeBlockingSources = probe.blockingSources;
    let finalProbeMissingScopeSources = probe.missingScopeBlockingSources;
    let finalBlockingRunsCount = blockingRuns.length;
    let finalQuarantinedCount = quarantinedCount;
    let finalDroppedNoiseCount = droppedNoiseCount;
    let finalDroppedSensitiveCount = droppedSensitiveCount;

    // Gate V7 & State advance
    if (!isDryRun && currentUpgrade.state === "draining") {
      await deps._internalPreClaimHook?.();

      const tClaim = await readCpNow(cpDb);
      const leaseOwner = `memupg_verify_${process.pid}_${randomUUID().slice(0, 8)}`;
      const leaseResult = await claimUpgradeLease(cpDb, {
        upgradeId: currentUpgrade.id,
        leaseOwner,
        now: tClaim,
      });

      if (!leaseResult.acquired || !leaseResult.leaseToken) {
        throw new CompanyMemoryUpgradeError(
          "Failed to acquire or maintain lease for upgrade. Another worker may hold the lease.",
          "LEASE_FENCED_OUT",
        );
      }

      leaseTokenToClean = leaseResult.leaseToken;

      await deps._internalPostClaimHook?.();

      const { row: underLease } = await readUpgradeWithCpNow(cpDb, currentUpgrade.id);
      if (!underLease || (underLease.state !== "draining" && underLease.state !== "verified")) {
        throw new CompanyMemoryUpgradeError(
          "Cannot run verify: active upgrade is not in draining or verified state.",
          "STATE_MISMATCH",
        );
      }

      if (underLease.state === "verified") {
        finalState = "verified";
        verifiedAt = underLease.verifiedAt;
        finalDrainConfirmedAt = underLease.drainConfirmedAt;
        finalMarkedAt = underLease.markedAt;
      } else {
        // Gate V1: drain confirmed under lease
        if (!underLease.drainConfirmedAt) {
          throw new CompanyMemoryUpgradeError(
            "Verify refused: drain has not been confirmed for this upgrade. Run 'pnpm memory:upgrade drain' first.",
            "DRAIN_NOT_CONFIRMED",
          );
        }
        if (
          currentUpgrade.drainConfirmedAt &&
          underLease.drainConfirmedAt.getTime() !== currentUpgrade.drainConfirmedAt.getTime()
        ) {
          throw new CompanyMemoryUpgradeError(
            "Verify refused: drain confirmation changed between probe and claim. Drain confirmation is stale.",
            "VERIFICATION_FAILED",
          );
        }

        // Gate V1 freshness: markedAt check
        if (!underLease.markedAt) {
          throw new CompanyMemoryUpgradeError(
            "The scope migration marker is not set, or does not match this upgrade's recorded flip time. Do not hand-edit scope_migration_completed_at; investigate before continuing.",
            "FLIP_MARKER_MISSING",
          );
        }
        if (
          currentUpgrade.markedAt &&
          underLease.markedAt.getTime() !== currentUpgrade.markedAt.getTime()
        ) {
          throw new CompanyMemoryUpgradeError(
            "Verify refused: upgrade flip marker changed between probe and claim.",
            "VERIFICATION_FAILED",
          );
        }

        // Fresh blocking pre-flip runs check under lease
        const freshBlockingRuns = await findBlockingPreFlipRuns(cpDb, {
          companyId,
          markedAt: underLease.markedAt,
          limit: blockingRunLimit,
        });
        if (freshBlockingRuns.length > 0) {
          const runDetails = freshBlockingRuns.map((r) => `${r.id} (${r.status})`).join(", ");
          throw new CompanyMemoryUpgradeError(
            `Verify refused: active pre-flip heartbeat runs are still running: ${runDetails}. Drain confirmation is stale.`,
            "VERIFICATION_FAILED",
          );
        }
        finalBlockingRunsCount = freshBlockingRuns.length;

        // Gate V2 & V3: Marker re-validation under lease
        const freshMarker = await readScopeMigrationMarker(cpDb, companyId);
        if (
          !freshMarker?.agentScopeObservedAt ||
          freshMarker.agentScopeObservedAt.getTime() <= underLease.markedAt.getTime()
        ) {
          throw new CompanyMemoryUpgradeError(
            "No agent-scoped memory use has been observed for this company since the flip. The marker alone changes nothing unless 'agent-scoped-mem0' is enabled for the processes running this company's agents.",
            "AGENT_SCOPE_NOT_OBSERVED",
          );
        }

        if (
          !freshMarker?.completedAt ||
          freshMarker.completedAt.getTime() !== underLease.markedAt.getTime() ||
          !freshMarker.mode ||
          (expectedMode && freshMarker.mode !== expectedMode)
        ) {
          throw new CompanyMemoryUpgradeError(
            "The scope migration marker is not set, or does not match this upgrade's recorded flip time. Do not hand-edit scope_migration_completed_at; investigate before continuing.",
            "FLIP_MARKER_MISSING",
          );
        }

        if (
          marker.completedAt &&
          (freshMarker.completedAt.getTime() !== marker.completedAt.getTime() ||
            freshMarker.mode !== marker.mode ||
            freshMarker.agentScopeObservedAt?.getTime() !== marker.agentScopeObservedAt?.getTime())
        ) {
          throw new CompanyMemoryUpgradeError(
            "Verify refused: scope migration marker changed between probe and claim.",
            "VERIFICATION_FAILED",
          );
        }
        finalAgentScopeObservedAt = freshMarker.agentScopeObservedAt;
        finalScopeMigrationMode = freshMarker.mode;

        // Gate V4: Pending publishable rows under lease
        const freshPending = await countPublishPending(tenantSql, underLease.id);
        if (freshPending.pendingRows > 0 || freshPending.pendingSources > 0) {
          throw new CompanyMemoryUpgradeError(
            `Verify refused: staged rows are still pending publish (${freshPending.pendingRows} rows across ${freshPending.pendingSources} sources). Run 'pnpm memory:upgrade publish' first.`,
            "VERIFICATION_FAILED",
          );
        }
        finalPendingRows = freshPending.pendingRows;
        finalPendingSources = freshPending.pendingSources;

        // Gate V5: Fresh drain probe under lease
        const freshProbe = await runDrainProbe(tenantSql, {
          upgradeId: underLease.id,
          tableName,
          cpAgentMap: preflight.cpAgentMap,
          limit: probeLimit,
        });
        if (freshProbe.blockingSources > 0 || freshProbe.missingScopeBlockingSources > 0) {
          throw new CompanyMemoryUpgradeError(
            `Verify refused: fresh drain probe found ${freshProbe.blockingSources} blocking source(s) and ${freshProbe.missingScopeBlockingSources} missing-scope source(s). Drain is not clean.`,
            "VERIFICATION_FAILED",
          );
        }
        finalProbeBlockingSources = freshProbe.blockingSources;
        finalProbeMissingScopeSources = freshProbe.missingScopeBlockingSources;

        // Gate V6: Zero quarantined ledger rows under lease (unless overridden)
        const freshLedgerRows = (await tenantSql.unsafe(
          `SELECT
             count(*) FILTER (WHERE outcome = 'quarantined')::int AS quarantined_count,
             count(*) FILTER (WHERE outcome = 'dropped_noise')::int AS dropped_noise_count,
             count(*) FILTER (WHERE outcome = 'dropped_sensitive')::int AS dropped_sensitive_count
           FROM paperclip_memory_upgrade_ledger
           WHERE upgrade_id = $1::uuid;`,
          [underLease.id],
        )) as Array<{
          quarantined_count: number | string | null;
          dropped_noise_count: number | string | null;
          dropped_sensitive_count: number | string | null;
        }>;

        finalQuarantinedCount = Number(freshLedgerRows[0]?.quarantined_count ?? 0);
        finalDroppedNoiseCount = Number(freshLedgerRows[0]?.dropped_noise_count ?? 0);
        finalDroppedSensitiveCount = Number(freshLedgerRows[0]?.dropped_sensitive_count ?? 0);

        if (finalQuarantinedCount > 0 && !allowQuarantined) {
          throw new CompanyMemoryUpgradeError(
            `Verify refused: quarantined sources remain in the ledger. Quarantined content never reached agent scope. Resolve them, or pass --allow-quarantined to accept the gap explicitly.`,
            "VERIFY_QUARANTINE_PRESENT",
          );
        }

        // Gate V7: Advance state with fresh DB clock
        const tAdvance = await readCpNow(cpDb);
        const updated = await advanceState(
          cpDb,
          underLease.id,
          leaseResult.leaseToken,
          "draining",
          "verified",
          { clock: frozenClock(tAdvance) },
        );
        finalState = updated.state as UpgradeState;
        verifiedAt = updated.verifiedAt;
        finalDrainConfirmedAt = underLease.drainConfirmedAt;
        finalMarkedAt = underLease.markedAt;
      }
    }

    return {
      isDryRun,
      companyId,
      companyName: preflight.resolvedCompanyName,
      upgradeId: currentUpgrade.id,
      state: finalState,
      priorState: currentUpgrade.state,
      verifiedAt,
      drainConfirmedAt: finalDrainConfirmedAt,
      markedAt: finalMarkedAt,
      agentScopeObservedAt: finalAgentScopeObservedAt,
      scopeMigrationMode: finalScopeMigrationMode,
      pendingPublishableRows: finalPendingRows,
      pendingPublishableSources: finalPendingSources,
      probeBlockingSources: finalProbeBlockingSources,
      probeMissingScopeSources: finalProbeMissingScopeSources,
      blockingRunsCount: finalBlockingRunsCount,
      quarantinedCount: finalQuarantinedCount,
      allowQuarantined,
      droppedNoiseCount: finalDroppedNoiseCount,
      droppedSensitiveCount: finalDroppedSensitiveCount,
      durationMs: Date.now() - startTime,
      whatThisDoesNotProve: WHAT_VERIFY_DOES_NOT_PROVE,
    };
  } catch (err: unknown) {
    hasPrimaryError = true;
    const code = (err as { code?: string })?.code;
    const mapped = mapSweepErrorCode(code) as UpgradeErrorCode;
    if (
      leaseTokenToClean &&
      activeUpgradeId &&
      cpDb &&
      mapped !== "lease_fenced_out" &&
      mapped !== "lease_expired" &&
      mapped !== "lease_lapsed"
    ) {
      try {
        const tError = await readCpNow(cpDb);
        await updateUpgradeCounters(
          cpDb,
          activeUpgradeId,
          leaseTokenToClean,
          { lastError: mapped },
          { clock: frozenClock(tError) },
        );
      } catch {
        // Suppress counter update error on catch path
      }
    }
    throw err;
  } finally {
    let releaseFailedErr: unknown = null;
    try {
      if (leaseTokenToClean && activeUpgradeId && cpDb) {
        try {
          await attemptReleaseLease(cpDb, activeUpgradeId, leaseTokenToClean, deps._internalReleaseHook);
          leaseTokenToClean = null;
        } catch (err: unknown) {
          releaseFailedErr = err;
        }
      }
    } finally {
      if (ownTenant && tenantSql) {
        await tenantSql.end().catch(() => {});
      }
      if (ownCp && cpDb) {
        await cpDb.$client?.end().catch(() => {});
      }
    }

    if (releaseFailedErr) {
      if (hasPrimaryError) {
        console.error("[memory-upgrade] lease release error:", guardCleanupErrorCode(releaseFailedErr));
      } else {
        throw new CompanyMemoryUpgradeError(
          "Failed to release upgrade lease after verify.",
          (releaseFailedErr as any)?.code ?? "VERIFICATION_FAILED",
          { cause: releaseFailedErr },
        );
      }
    }
  }
}
