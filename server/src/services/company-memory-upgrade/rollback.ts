/**
 * Orchestrator service for company memory upgrade rollback (TECH-8191 §Q5, PR5.9).
 *
 * Implements state dispatch, lease-fenced scope marker clear first, then state advance,
 * agent-scoped rows reporting without deletion, and near-final rollback warnings.
 */

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { companyMemoryUpgrades, createDb, type Db } from "@paperclipai/db";
import { desc, eq } from "drizzle-orm";
import { assertCompanyAcceptsMemoryWork, findActiveUpgrade } from "./admission.js";
import { frozenClock, readCpNow } from "./cp-clock.js";
import { openTenantClient } from "./sweep-tenant.js";
import { runTenantPreflight } from "./preflight.js";
import {
  clearScopeMigrationMarkerFenced,
  readScopeMigrationMarker,
  type ClearedScopeMigrationMarker,
} from "./scope-marker.js";
import {
  summariseAgentScopedRows,
  type AgentScopedRowGroup,
} from "./rollback-report.js";
import {
  advanceState,
  claimUpgradeLease,
  DEFAULT_LEASE_TTL_MS,
  releaseUpgradeLease,
  startLeaseHeartbeat,
} from "./state-machine.js";
import {
  CompanyMemoryUpgradeError,
  mapSweepErrorCode,
  type UpgradeErrorCode,
  type UpgradeState,
} from "./types.js";

export const ROLLBACK_NEAR_FINAL_WARNING =
  "WARNING: Treat rollback as near-final. Re-upgrading this company later creates a fresh upgrade row and re-converts legacy memories from scratch, paying model costs again and publishing duplicate copies into agent scope alongside the retained rows (TECH-8326).";

export const ROLLBACK_REVERT_SCOPE_NOTICE =
  "Notice: Clearing the scope migration marker reverts memory reads to company scope for all agents. For agents whose configuration includes 'agent-scoped-mem0', operators should remove 'agent-scoped-mem0' from their agent configuration to keep configuration consistent. Rollback does not modify agent configurations.";

export const ROLLBACK_RETAINED_ROWS_NOTE =
  "Agent-scoped rows present (not provably post-flip). Rollback and reconciliation delete nothing: published agent-scoped rows remain in the live collection.";

export interface RollbackOptions {
  companyId: string;
  tenantDatabaseUrl: string;
  controlPlaneDatabaseUrl: string;
  table?: string;
  confirm?: string;
  dryRun?: boolean;
  limit?: number;
}

export interface RollbackReport {
  isDryRun: boolean;
  companyId: string;
  companyName: string | null;
  upgradeId: string;
  state: UpgradeState;
  priorState: UpgradeState;
  markerCleared: boolean;
  priorMarkerCompletedAt: Date | null;
  priorMarkerMode: string | null;
  agentScopeObservedAt: Date | null;
  rolledBackAt: Date | null;
  publishedRowsRetained: number;
  agentScopedRows: AgentScopedRowGroup[];
  totalAgentScopedRows: number;
  totalCreatedByAnUpgrade: number;
  totalAgentScopes: number;
  truncated: boolean;
  durationMs: number;
  warnings: string[];
}

export interface RollbackDependencies {
  cpDb?: Db;
  tenantSql?: postgres.Sql;
  _internalSkipVectorIdentityCheck?: boolean;
  _internalDatabaseIdentityOverride?: { database?: string | null; user?: string | null };
  _internalCreateCpDb?: (url: string, opts?: any) => Db;
  _internalOpenTenantClient?: (url: string, opts?: any) => postgres.Sql;
  _internalPreClaimHook?: () => Promise<void> | void;
  _internalPostClaimHook?: () => Promise<void> | void;
  _internalStepHook?: (step: "clear_marker" | "advance_state") => Promise<void> | void;
  _internalReleaseHook?: (attempt: number) => Promise<void> | void;
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

export function formatRollbackReport(report: RollbackReport, format: "text" | "json" = "text"): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  const lines = [
    `=== Memory Upgrade Rollback Report ===`,
    `Mode: ${report.isDryRun ? "DRY RUN (no changes made)" : "CONFIRMED"}`,
    `Company ID: ${report.companyId}`,
    `Company Name: ${report.companyName ?? "unknown"}`,
    `Upgrade ID: ${report.upgradeId}`,
    `State: ${report.state}`,
    `Prior state: ${report.priorState}`,
    `Marker cleared: ${report.markerCleared ? "yes" : "no"}`,
    `Prior marker completed at: ${report.priorMarkerCompletedAt?.toISOString() ?? "null"}`,
    `Prior marker mode: ${report.priorMarkerMode ?? "none"}`,
    `Agent scope observed at: ${report.agentScopeObservedAt?.toISOString() ?? "none"} (preserved)`,
    `Rolled back at: ${report.rolledBackAt?.toISOString() ?? "null"}`,
    `Published rows retained: ${report.publishedRowsRetained}`,
    `Agent-scoped rows present (not provably post-flip):`,
  ];

  if (report.agentScopedRows.length === 0) {
    lines.push(`  (none)`);
  } else {
    for (const group of report.agentScopedRows) {
      lines.push(
        `  Agent ${group.agentScope}: ${group.rows} rows (${group.createdByAnUpgrade} created by an upgrade)`,
      );
    }
    if (report.truncated) {
      lines.push(
        `  ... (showing top ${report.agentScopedRows.length} of ${report.totalAgentScopes} agent scopes; overall totals below reflect all rows)`,
      );
    }
  }
  lines.push(
    `Total agent-scoped rows: ${report.totalAgentScopedRows} (${report.totalCreatedByAnUpgrade} created by an upgrade across ${report.totalAgentScopes} agent scopes${report.truncated ? ", truncated in display" : ""})`,
  );
  lines.push(`Duration: ${report.durationMs}ms`);

  if (report.isDryRun) {
    lines.push(`Advisory: dry-run preview — no lease claimed and upgrade state not transitioned.`);
  }

  lines.push("");
  for (const w of report.warnings) {
    lines.push(w);
  }

  return lines.join("\n");
}

export async function runRollback(
  options: RollbackOptions,
  deps: RollbackDependencies = {},
): Promise<RollbackReport> {
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

  let cpDb = deps.cpDb;
  let tenantSql = deps.tenantSql;
  let ownCp = false;
  let ownTenant = false;
  let leaseTokenToClean: string | null = null;
  let activeUpgradeId: string | null = null;
  let heartbeat: ReturnType<typeof startLeaseHeartbeat> | null = null;

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
      const [latest] = await cpDb
        .select({ id: companyMemoryUpgrades.id, state: companyMemoryUpgrades.state })
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.companyId, companyId))
        .orderBy(desc(companyMemoryUpgrades.createdAt))
        .limit(1);

      if (latest && (latest.state === "completed" || latest.state === "pruning")) {
        throw new CompanyMemoryUpgradeError(
          "Rollback refused: cannot roll back upgrade from current state",
          "ROLLBACK_REFUSED",
        );
      }

      throw new CompanyMemoryUpgradeError("No active memory upgrade for this company.", "STATE_MISMATCH");
    }

    activeUpgradeId = initialUpgrade.id;

    // State dispatch check
    if (initialUpgrade.state === "sweeping") {
      throw new CompanyMemoryUpgradeError(
        "Cannot run rollback: no flip has been performed for this upgrade.",
        "STATE_MISMATCH",
      );
    }
    if (initialUpgrade.state === "needs_recovery") {
      throw new CompanyMemoryUpgradeError(
        "Cannot run rollback: active upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' first.",
        "STATE_MISMATCH",
      );
    }
    if (initialUpgrade.state === "pruning" || initialUpgrade.state === "completed") {
      throw new CompanyMemoryUpgradeError(
        "Rollback refused: cannot roll back upgrade from current state",
        "ROLLBACK_REFUSED",
      );
    }
    if (
      initialUpgrade.state !== "flipping" &&
      initialUpgrade.state !== "draining" &&
      initialUpgrade.state !== "verified"
    ) {
      throw new CompanyMemoryUpgradeError(
        `Cannot run rollback from state '${initialUpgrade.state}'.`,
        "STATE_MISMATCH",
      );
    }

    // Summarise agent-scoped rows (read-only from tenant database)
    const agentSummary = await summariseAgentScopedRows(tenantSql, {
      upgradeId: initialUpgrade.id,
      tableName,
      limit: options.limit ?? 100,
    });

    const warnings = [
      ROLLBACK_NEAR_FINAL_WARNING,
      ROLLBACK_REVERT_SCOPE_NOTICE,
      ROLLBACK_RETAINED_ROWS_NOTE,
    ];

    if (isDryRun) {
      const currentMarker = await readScopeMigrationMarker(cpDb, companyId);
      return {
        isDryRun: true,
        companyId,
        companyName: preflight.resolvedCompanyName,
        upgradeId: initialUpgrade.id,
        state: initialUpgrade.state,
        priorState: initialUpgrade.state,
        markerCleared: false,
        priorMarkerCompletedAt: currentMarker?.completedAt ?? null,
        priorMarkerMode: currentMarker?.mode ?? null,
        agentScopeObservedAt: currentMarker?.agentScopeObservedAt ?? null,
        rolledBackAt: null,
        publishedRowsRetained: agentSummary.publishedRowsRetained,
        agentScopedRows: agentSummary.groups,
        totalAgentScopedRows: agentSummary.totalAgentScopedRows,
        totalCreatedByAnUpgrade: agentSummary.totalCreatedByAnUpgrade,
        totalAgentScopes: agentSummary.totalAgentScopes,
        truncated: agentSummary.truncated,
        durationMs: Date.now() - startTime,
        warnings,
      };
    }

    // Confirmed run
    await deps._internalPreClaimHook?.();
    const leaseOwner = `memupg_rollback_${process.pid}_${randomUUID().slice(0, 8)}`;
    const claimNow = await readCpNow(cpDb);
    const claim = await claimUpgradeLease(cpDb, {
      upgradeId: initialUpgrade.id,
      leaseOwner,
      now: claimNow,
    });
    if (!claim.acquired || !claim.leaseToken || !claim.leaseExpiresAt) {
      throw new CompanyMemoryUpgradeError(
        "Failed to acquire lease for rollback. Another worker may hold the lease.",
        "LEASE_FENCED_OUT",
      );
    }
    const leaseToken = claim.leaseToken;
    leaseTokenToClean = leaseToken;
    await deps._internalPostClaimHook?.();

    heartbeat = startLeaseHeartbeat(cpDb, initialUpgrade.id, leaseToken, {
      initialExpiresAt: claim.leaseExpiresAt,
      onLost: () => {},
    });

    // Re-read upgrade row under held lease
    const [upgradeUnderLease] = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, initialUpgrade.id));

    if (
      !upgradeUnderLease ||
      upgradeUnderLease.leaseToken !== leaseToken ||
      (upgradeUnderLease.state !== "flipping" &&
        upgradeUnderLease.state !== "draining" &&
        upgradeUnderLease.state !== "verified")
    ) {
      throw new CompanyMemoryUpgradeError(
        "Upgrade state or lease changed after acquiring lease",
        "LEASE_FENCED_OUT",
      );
    }

    // Step 1: Clear scope migration marker FIRST (lease-fenced)
    await deps._internalStepHook?.("clear_marker");
    const clearedMarker = await clearScopeMigrationMarkerFenced(cpDb, {
      upgradeId: initialUpgrade.id,
      leaseToken,
      companyId,
      expectedState: upgradeUnderLease.state,
    });

    // Step 2: Advance state
    await deps._internalStepHook?.("advance_state");
    const tAdvance = await readCpNow(cpDb);
    let finalState: UpgradeState;
    let rolledBackAt: Date | null = null;

    if (upgradeUnderLease.state === "flipping") {
      finalState = "sweeping";
      await advanceState(
        cpDb,
        initialUpgrade.id,
        leaseToken,
        "flipping",
        "sweeping",
        { clock: frozenClock(tAdvance) },
      );
    } else {
      finalState = "rolled_back";
      rolledBackAt = tAdvance;
      await advanceState(
        cpDb,
        initialUpgrade.id,
        leaseToken,
        upgradeUnderLease.state,
        "rolled_back",
        { clock: frozenClock(tAdvance) },
      );
    }

    // Clean up heartbeat
    heartbeat.stop();
    heartbeat = null;

    // Terminal advance (rolled_back) clears the lease automatically in DB.
    // Non-terminal advance (flipping -> sweeping) retains the lease until explicitly released.
    if (finalState === "sweeping") {
      await attemptReleaseLease(cpDb, initialUpgrade.id, leaseToken, deps._internalReleaseHook);
      leaseTokenToClean = null;
    } else {
      leaseTokenToClean = null;
    }

    return {
      isDryRun: false,
      companyId,
      companyName: preflight.resolvedCompanyName,
      upgradeId: initialUpgrade.id,
      state: finalState,
      priorState: upgradeUnderLease.state,
      markerCleared: true,
      priorMarkerCompletedAt: clearedMarker.completedAt,
      priorMarkerMode: clearedMarker.mode,
      agentScopeObservedAt: clearedMarker.agentScopeObservedAt,
      rolledBackAt,
      publishedRowsRetained: agentSummary.publishedRowsRetained,
      agentScopedRows: agentSummary.groups,
      totalAgentScopedRows: agentSummary.totalAgentScopedRows,
      totalCreatedByAnUpgrade: agentSummary.totalCreatedByAnUpgrade,
      totalAgentScopes: agentSummary.totalAgentScopes,
      truncated: agentSummary.truncated,
      durationMs: Date.now() - startTime,
      warnings,
    };
  } finally {
    if (heartbeat) {
      try {
        heartbeat.stop();
      } catch {}
    }
    if (leaseTokenToClean && activeUpgradeId && cpDb) {
      try {
        await attemptReleaseLease(cpDb, activeUpgradeId, leaseTokenToClean, deps._internalReleaseHook);
      } catch {}
    }
    if (ownTenant && tenantSql) {
      try {
        await tenantSql.end();
      } catch {}
    }
    if (ownCp && cpDb) {
      try {
        await (cpDb as any).$client?.end?.();
      } catch {}
    }
  }
}
