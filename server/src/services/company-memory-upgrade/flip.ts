/**
 * Orchestrator service for company memory upgrade flip (TECH-8191 §Q2, PR5.6).
 *
 * Sequence:
 * A: Preflight + P6 + P7 (reads only)
 * B: claimUpgradeLease (CP)
 * C: startLeaseHeartbeat
 * D: Re-read state and re-run P6 under held lease
 * E: advanceState(sweeping -> flipping)
 * F: setScopeMigrationMarker (idempotent; 0 rows -> read back)
 * G: updateUpgradeCounters(markedAt = <value read back from F>)
 * H: advanceState(flipping -> draining)
 * I: releaseUpgradeLease
 */

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { agents, createDb, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { resolveMemoryHardeningFlags } from "@paperclipai/shared";
import { HERMES_ADAPTER_TYPE } from "../company-memory-constants.js";
import { assertCompanyAcceptsMemoryWork, findActiveUpgrade } from "./admission.js";
import { createSystemClock } from "./clock.js";
import { openTenantClient } from "./sweep-tenant.js";
import { assertFlipPreconditions, countPublishPending } from "./flip-preconditions.js";
import { runTenantPreflight } from "./preflight.js";
import { readScopeMigrationMarker, setScopeMigrationMarkerFenced } from "./scope-marker.js";
import {
  advanceState,
  claimUpgradeLease,
  releaseUpgradeLease,
  startLeaseHeartbeat,
  updateUpgradeCounters,
} from "./state-machine.js";
import {
  CompanyMemoryUpgradeError,
  mapSweepErrorCode,
  type Clock,
  type UpgradeErrorCode,
  type UpgradeState,
} from "./types.js";

export const ACK_AGENT_SCOPE_ASSERTION =
  "Operator assertion, not proof. Evidence of agent-scoped memory use will be verified independently during drain and verify.";

export const SCOPE_WARNING =
  "The scope marker is company-wide and only takes effect for agents whose effective flags include agent-scoped-mem0 (via server environment or per-agent adapterConfig.env). WARNING: If the SERVER environment enables agent-scoped-mem0 (or 'all'), every Hermes agent in the company switches to agent scope at once.";

export const PILOT_SUMMARY_NOTE =
  "agents with the flag in their own config; server-wide flags are not visible to the CLI.";

export interface AgentScopePilotSummary {
  totalHermesAgents: number;
  agentsWithFlagInConfig: string[];
  agentsWithInvalidFlagConfig: string[];
  note: string;
}

export interface FlipOptions {
  companyId: string;
  tenantDatabaseUrl: string;
  controlPlaneDatabaseUrl: string;
  table?: string;
  confirm?: string;
  mode?: string;
  probeLimit?: number;
  ackAgentScopeFlag?: boolean;
}

export interface FlipReport {
  isDryRun: boolean;
  companyId: string;
  companyName: string | null;
  upgradeId: string;
  state: UpgradeState;
  priorState: UpgradeState;
  mode: string;
  markedAt: Date | null;
  alreadySet: boolean;
  pendingRows: number;
  pendingSources: number;
  alreadyPublishedRows: number;
  blockingSources: number;
  missingScopeBlockingSources: number;
  durationMs: number;
  ackAgentScopeFlag: boolean;
  ackAgentScopeAssertion: string;
  agentsWithInvalidFlagConfig: string[];
  agentScopePilotSummary: AgentScopePilotSummary;
  scopeWarning: string;
}

export interface FlipDependencies {
  cpDb?: Db;
  tenantSql?: postgres.Sql;
  clock?: Clock;
  _internalSkipVectorIdentityCheck?: boolean;
  _internalDatabaseIdentityOverride?: { database?: string | null; user?: string | null };
  _internalCreateCpDb?: (url: string, opts?: any) => Db;
  _internalOpenTenantClient?: (url: string, opts?: any) => postgres.Sql;
  _internalStepHook?: (step: "E" | "F" | "G" | "H") => void | Promise<void>;
}

export function formatFlipReport(report: FlipReport, format: "text" | "json" = "text"): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  const flagAgents = report.agentScopePilotSummary.agentsWithFlagInConfig.length > 0
    ? report.agentScopePilotSummary.agentsWithFlagInConfig.join(", ")
    : "none";
  const invalidAgentsList = report.agentScopePilotSummary.agentsWithInvalidFlagConfig ?? report.agentsWithInvalidFlagConfig ?? [];
  const invalidAgents = invalidAgentsList.length > 0
    ? invalidAgentsList.join(", ")
    : "none";
  const lines = [
    `=== Memory Upgrade Flip Report ===`,
    `Mode: ${report.isDryRun ? "DRY RUN (no changes made)" : "CONFIRMED"}`,
    `Company ID: ${report.companyId}`,
    `Company Name: ${report.companyName ?? "unknown"}`,
    `Upgrade ID: ${report.upgradeId}`,
    `Prior State: ${report.priorState}`,
    `Current State: ${report.state}`,
    `Migration Mode: ${report.mode}`,
    `Marker Completed At: ${report.markedAt ? report.markedAt.toISOString() : "not set"}`,
    `Marker Already Set: ${report.alreadySet}`,
    `Pending Publish Rows: ${report.pendingRows}`,
    `Already Published Rows: ${report.alreadyPublishedRows}`,
    `Drain Probe Blocking Sources: ${report.blockingSources}`,
    `Drain Probe Missing-Scope Sources: ${report.missingScopeBlockingSources}`,
    `Duration: ${report.durationMs}ms`,
    `--ack-agent-scope-flag: ${report.ackAgentScopeFlag ? "acknowledged" : "not passed"}`,
    `Operator assertion note: ${report.ackAgentScopeAssertion}`,
    `Single-Agent Pilot Summary:`,
    `  Total hermes_local agents: ${report.agentScopePilotSummary.totalHermesAgents}`,
    `  Agents with the flag in their own config: ${flagAgents}`,
    `  Agents with invalid flag config: ${invalidAgents}`,
    ...(invalidAgentsList.length > 0
      ? [`  Warning: Agent config will fail at run time until fixed: ${invalidAgents}`]
      : []),
    `  Note: ${report.agentScopePilotSummary.note}`,
    `Scope warning: ${report.scopeWarning}`,
  ];
  return lines.join("\n");
}

export async function runFlip(
  options: FlipOptions,
  deps: FlipDependencies = {},
): Promise<FlipReport> {
  const startTime = Date.now();
  const companyId = options.companyId;
  const tableName = options.table ?? "mem0_memories";
  const mode = options.mode ?? "copy";
  if (mode !== "copy") {
    throw new CompanyMemoryUpgradeError("Invalid --mode. Only 'copy' is supported.", "INVALID_ARGUMENT");
  }

  if (options.confirm !== undefined && options.confirm !== companyId) {
    throw new CompanyMemoryUpgradeError(
      "Confirmation company ID does not match target company ID.",
      "INVALID_ARGUMENT",
    );
  }
  const isDryRun = options.confirm === undefined;
  const ackAgentScopeFlag = Boolean(options.ackAgentScopeFlag);
  if (!isDryRun && !ackAgentScopeFlag) {
    throw new CompanyMemoryUpgradeError(
      "Flag '--ack-agent-scope-flag' is required for flip. The scope marker alone has no effect unless 'agent-scoped-mem0' is enabled for this company's agent processes.",
      "INVALID_ARGUMENT",
    );
  }

  const clock = deps.clock ?? createSystemClock();
  let cpDb = deps.cpDb;
  let tenantSql = deps.tenantSql;
  let ownCp = false;
  let ownTenant = false;
  let heartbeatHandle: ReturnType<typeof startLeaseHeartbeat> | null = null;
  let activeUpgradeId = "";
  let leaseToken: string | null = null;

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
    // Step A: Preflight reads and precondition assertions
    const upgrade = await cpDb.transaction(async (tx) => {
      await assertCompanyAcceptsMemoryWork(tx, companyId);
      return await findActiveUpgrade(tx, companyId);
    });

    if (!upgrade) {
      throw new CompanyMemoryUpgradeError("No active memory upgrade for this company.", "STATE_MISMATCH");
    }
    activeUpgradeId = upgrade.id;

    const marker = await readScopeMigrationMarker(cpDb, companyId);
    const preflight = await runTenantPreflight(
      cpDb,
      tenantSql,
      { companyId, tableName },
      {
        _internalSkipVectorIdentityCheck: deps._internalSkipVectorIdentityCheck,
        _internalDatabaseIdentityOverride: deps._internalDatabaseIdentityOverride,
      },
    );

    const { pending, probe } = await assertFlipPreconditions({
      upgrade,
      marker,
      tenantSql,
      tableName,
      cpAgentMap: preflight.cpAgentMap,
      probeLimit: options.probeLimit,
      mode,
    });

    // Query hermes_local agents to inspect adapterConfig.env for the pilot summary
    const companyAgents = await cpDb
      .select({ id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const hermesAgents = companyAgents.filter(
      (a) => a.adapterType === HERMES_ADAPTER_TYPE || a.adapterType === "hermes_local",
    );

    const agentsWithFlagInConfig: string[] = [];
    const agentsWithInvalidFlagConfig: string[] = [];
    for (const a of hermesAgents) {
      const cfg = (a.adapterConfig ?? {}) as Record<string, unknown>;
      const rawEnv = cfg.env;
      if (rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
        try {
          const flags = resolveMemoryHardeningFlags(rawEnv as Record<string, string | undefined>);
          if (flags.agentScopedMem0) {
            agentsWithFlagInConfig.push(a.id);
          }
        } catch {
          agentsWithInvalidFlagConfig.push(a.id);
        }
      }
    }

    const pilotSummary: AgentScopePilotSummary = {
      totalHermesAgents: hermesAgents.length,
      agentsWithFlagInConfig,
      agentsWithInvalidFlagConfig,
      note: PILOT_SUMMARY_NOTE,
    };

    if (isDryRun) {
      return {
        isDryRun: true,
        companyId,
        companyName: preflight.resolvedCompanyName,
        upgradeId: upgrade.id,
        state: upgrade.state as UpgradeState,
        priorState: upgrade.state as UpgradeState,
        mode,
        markedAt: marker?.completedAt ?? null,
        alreadySet: marker?.completedAt != null,
        pendingRows: pending.pendingRows,
        pendingSources: pending.pendingSources,
        alreadyPublishedRows: pending.alreadyPublishedRows,
        blockingSources: probe.blockingSources,
        missingScopeBlockingSources: probe.missingScopeBlockingSources,
        durationMs: Date.now() - startTime,
        ackAgentScopeFlag,
        ackAgentScopeAssertion: ACK_AGENT_SCOPE_ASSERTION,
        agentsWithInvalidFlagConfig,
        agentScopePilotSummary: pilotSummary,
        scopeWarning: SCOPE_WARNING,
      };
    }

    // Step B: Claim upgrade lease
    const rand8 = randomUUID().replace(/-/g, "").slice(0, 8);
    const leaseOwner = `memupg_flip_${process.pid}_${rand8}`;
    const claimRes = await claimUpgradeLease(cpDb, {
      upgradeId: activeUpgradeId,
      leaseOwner,
      now: clock.now(),
    });

    if (!claimRes.acquired || !claimRes.leaseToken || !claimRes.leaseExpiresAt) {
      throw new CompanyMemoryUpgradeError(
        "Failed to acquire lease for upgrade. Another worker may hold the lease.",
        "LEASE_FENCED_OUT",
      );
    }
    leaseToken = claimRes.leaseToken;

    // Step C: Start lease heartbeat
    heartbeatHandle = startLeaseHeartbeat(cpDb, activeUpgradeId, leaseToken, {
      initialExpiresAt: claimRes.leaseExpiresAt,
      clock,
      onLost: () => {},
    });

    // Tenant fence epoch bump is NOT needed or performed: flip mutates no tenant data.
    // The control-plane lease (claimUpgradeLease) provides the necessary mutual exclusion.

    // Step D: Re-read state and re-run P6 under held lease
    const currentUpgrade = await cpDb.transaction(async (tx) => {
      await assertCompanyAcceptsMemoryWork(tx, companyId);
      return await findActiveUpgrade(tx, companyId);
    });

    if (!currentUpgrade) {
      throw new CompanyMemoryUpgradeError("No active memory upgrade for this company.", "STATE_MISMATCH");
    }
    if (currentUpgrade.state !== "sweeping" && currentUpgrade.state !== "flipping") {
      throw new CompanyMemoryUpgradeError(
        "Cannot run flip: active upgrade is not in sweeping or flipping state.",
        "STATE_MISMATCH",
      );
    }

    const recheckPending = await countPublishPending(tenantSql, activeUpgradeId);
    if (recheckPending.pendingRows > 0) {
      throw new CompanyMemoryUpgradeError(
        "Flip refused before changing anything: staged rows are still unpublished, or a sweep would still find new or changed company-scoped memories. Run 'pnpm memory:upgrade publish' and 'pnpm memory:upgrade sweep' until both are clean, then retry. Nothing was flipped.",
        "FLIP_PRECONDITION_FAILED",
      );
    }

    // Step E: Advance state sweeping -> flipping (skipped if already in flipping on resume)
    let stateAtE: UpgradeState = currentUpgrade.state as UpgradeState;
    if (currentUpgrade.state === "sweeping") {
      const advanced = await advanceState(
        cpDb,
        activeUpgradeId,
        leaseToken,
        "sweeping",
        "flipping",
        { clock },
      );
      stateAtE = advanced.state as UpgradeState;
    }
    await deps._internalStepHook?.("E");

    // Step F: Set marker (fenced CAS on upgrade lease and flipping state)
    const markerRes = await setScopeMigrationMarkerFenced(cpDb, {
      upgradeId: activeUpgradeId,
      leaseToken,
      companyId,
      mode,
    });
    await deps._internalStepHook?.("F");

    // Step G: Record markedAt from the marker's own timestamp (read back if already set)
    await updateUpgradeCounters(
      cpDb,
      activeUpgradeId,
      leaseToken,
      { markedAt: markerRes.completedAt },
      { clock },
    );
    await deps._internalStepHook?.("G");

    // Step H: Advance state flipping -> draining
    const drained = await advanceState(
      cpDb,
      activeUpgradeId,
      leaseToken,
      "flipping",
      "draining",
      { clock },
    );
    await deps._internalStepHook?.("H");

    return {
      isDryRun: false,
      companyId,
      companyName: preflight.resolvedCompanyName,
      upgradeId: activeUpgradeId,
      state: drained.state as UpgradeState,
      priorState: stateAtE,
      mode,
      markedAt: markerRes.completedAt,
      alreadySet: markerRes.alreadySet,
      pendingRows: recheckPending.pendingRows,
      pendingSources: recheckPending.pendingSources,
      alreadyPublishedRows: recheckPending.alreadyPublishedRows,
      blockingSources: probe.blockingSources,
      missingScopeBlockingSources: probe.missingScopeBlockingSources,
      durationMs: Date.now() - startTime,
      ackAgentScopeFlag,
      ackAgentScopeAssertion: ACK_AGENT_SCOPE_ASSERTION,
      agentsWithInvalidFlagConfig,
      agentScopePilotSummary: pilotSummary,
      scopeWarning: SCOPE_WARNING,
    };
  } catch (err) {
    const code = (err as any)?.code ?? (err as any)?.message;
    const mapped = mapSweepErrorCode(code) as UpgradeErrorCode;
    if (
      leaseToken &&
      activeUpgradeId &&
      cpDb &&
      mapped !== "lease_fenced_out" &&
      mapped !== "lease_expired" &&
      mapped !== "lease_lapsed"
    ) {
      await updateUpgradeCounters(cpDb, activeUpgradeId, leaseToken, {
        lastError: mapped,
      }).catch(() => {});
    }
    throw err;
  } finally {
    // Step I: Clean release of heartbeat and lease
    if (heartbeatHandle) {
      await heartbeatHandle.stop().catch(() => {});
    }
    if (leaseToken && activeUpgradeId && cpDb) {
      await releaseUpgradeLease(cpDb, activeUpgradeId, leaseToken, {
        clock,
      }).catch(() => {});
    }
    if (ownTenant && tenantSql) {
      await tenantSql.end().catch(() => {});
    }
    if (ownCp && cpDb) {
      await cpDb.$client?.end().catch(() => {});
    }
  }
}
