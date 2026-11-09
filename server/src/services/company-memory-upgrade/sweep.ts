/**
 * Orchestrator for company memory upgrade sweep (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * 1. Counters vs Ledger:
 *    The tenant ledger (`paperclip_memory_upgrade_ledger`) is authoritative for all source
 *    outcomes and reconciliation. Counters in `company_memory_upgrades` track cumulative activity
 *    and do not partition the live source table.
 * 2. Crash Consistency:
 *    A crash or lease fence between a tenant commit and the control-plane counter update
 *    means undercounting in control plane counters, which is acceptable by design.
 *    Resumption strictly keys on the tenant ledger and live table keysets.
 * 3. ZERO network egress, ZERO API-key handling, and ZERO staging writes in this phase (PR3a).
 *    Rows requiring LLM conversion are recorded as pendingConversion without staging writes.
 * 4. Read-only Live Table:
 *    The live collection table is accessed exclusively via SELECT queries.
 * 5. Sensitive Data Protection:
 *    Memory text MUST NEVER appear in control plane columns, reports, logs, or error codes.
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createDb,
  type Db,
} from "@paperclipai/db";
import { INVOKABLE_AGENT_STATUSES } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { adapterSupportsRuntimeMemory, deriveCompanyMemoryDatabaseNames } from "../company-memory-constants.js";
import { countActiveCompanyRuns, createActiveRunGate } from "./active-runs.js";
import { assertCompanyAcceptsMemoryWork, findActiveUpgrade } from "./admission.js";
import {
  assertNoElevatedRolePrivileges,
  assertNonSuperuserAndRestrictedRole,
  isValidUuid,
  ROLE_PRIVILEGE_PREFLIGHT_SQL_TEXT,
  type RolePrivilegeRow,
  type UnroutableReason,
  validateAndResolveTableIdentifier,
  validateDatabaseUrl,
  validateOutputPath,
} from "./census.js";
import { classifyMemoryNoiseDetailed } from "./classify-noise.js";
import { createSystemClock, createSystemSleeper, type MonotonicClock, type Sleeper } from "./clock.js";
import { CONVERTER_ID, CONVERTER_VERSION } from "./converter-version.js";
import { detectSensitiveFamilies, type SensitiveFamilyName } from "./sensitive-patterns.js";
import { computeSourceContentSha256 } from "./source-hash.js";
import {
  claimUpgradeLease,
  openUpgrade,
  releaseUpgradeLease,
  startLeaseHeartbeat,
  updateUpgradeCounters,
} from "./state-machine.js";
import {
  assertTenantRolePreflight,
  commitSourceOutcome,
  ensureUpgradeTables,
  introspectCollection,
  iterateSourcePages,
  loadLedgerForSources,
  openTenantClient,
  reconcileChangedContent,
  reconcileTombstones,
  type TenantSourceRow,
} from "./sweep-tenant.js";
import {
  type Clock,
  CompanyMemoryUpgradeError,
  mapSweepErrorCode,
  type UpgradeErrorCode,
  UPGRADE_ERROR_CODES,
} from "./types.js";

export interface SweepOptions {
  databaseUrl: string;
  controlPlaneUrl: string;
  companyId: string;
  tableName?: string;
  pageSize?: number;
  maxRows?: number;
  pauseWhenActiveRuns?: number;
  activeRunPollMs?: number;
  maxPauseSeconds?: number;
  operatorLabel?: string | null;
  allowProd?: boolean;
  outputPath?: string | null;
  format?: "text" | "json";
}

export interface SweepDependencies {
  clock?: MonotonicClock & Clock;
  sleeper?: Sleeper;
  tenantSql?: postgres.Sql;
  controlPlaneDb?: Db;
  _internalSkipVectorIdentityCheck?: boolean;
  _internalDatabaseIdentityOverride?: { database?: string | null; user?: string | null };
  _internalNow?: Date;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export interface SweepCounts {
  sourceSeenCount: number;
  unroutableCount: number;
  droppedNoiseCount: number;
  droppedSensitiveCount: number;
  pendingConversionCount: number;
  supersededCount: number;
  sourceDeletedCount: number;
  skippedUnchangedCount: number;
}

export interface SweepReport {
  schemaVersion: "1.0";
  generatedAt: string;
  company: {
    id: string;
    name?: string | null;
  };
  upgradeId: string;
  leaseOwner: string;
  status: "completed" | "aborted" | "interrupted";
  counts: SweepCounts;
  activeRunGate: {
    pauseCount: number;
    totalPausedMs: number;
  };
  caveats: string[];
}

interface CpAgentRow {
  id: string;
  name: string;
  adapterType: string;
  status: string;
  pausedAt: Date | string | null;
}

function classifyAgentRouting(
  rawAgentId: string | null | undefined,
  cpAgentMap: Map<string, CpAgentRow>,
): { isRoutable: boolean; matchedAgentId: string | null; unroutableReason?: UnroutableReason } {
  if (!rawAgentId || rawAgentId.trim() === "" || rawAgentId.trim() === "(none)") {
    return { isRoutable: false, matchedAgentId: null, unroutableReason: "missing_agent_id" };
  }

  const trimmed = rawAgentId.trim().toLowerCase();
  if (!isValidUuid(trimmed)) {
    return { isRoutable: false, matchedAgentId: null, unroutableReason: "malformed_agent_id" };
  }

  const cpAgent = cpAgentMap.get(trimmed);
  if (!cpAgent) {
    return { isRoutable: false, matchedAgentId: null, unroutableReason: "unknown_agent" };
  }

  const matchedAgentId = cpAgent.id;

  if (!adapterSupportsRuntimeMemory(cpAgent.adapterType)) {
    return { isRoutable: false, matchedAgentId, unroutableReason: "non_memory_adapter" };
  }

  if (cpAgent.status === "terminated") {
    return { isRoutable: false, matchedAgentId, unroutableReason: "terminated" };
  }

  if (cpAgent.status === "pending_approval") {
    return { isRoutable: false, matchedAgentId, unroutableReason: "pending_approval" };
  }

  const isInvokable = INVOKABLE_AGENT_STATUSES.has(cpAgent.status);
  const isPausedStatus = cpAgent.status === "paused";

  if (!isInvokable && !isPausedStatus) {
    return { isRoutable: false, matchedAgentId, unroutableReason: "unknown_status" };
  }

  return { isRoutable: true, matchedAgentId };
}

export function formatSweepTextReport(report: SweepReport): string {
  const lines: string[] = [];
  lines.push("================================================================================");
  lines.push("              Paperclip Company Memory Upgrade Sweep Report (TECH-8191)         ");
  lines.push("================================================================================");
  lines.push("");
  lines.push(`Upgrade ID:       ${report.upgradeId}`);
  lines.push(`Company ID:       ${report.company.id}${report.company.name ? ` (${report.company.name})` : ""}`);
  lines.push(`Lease Owner:      ${report.leaseOwner}`);
  lines.push(`Status:           ${report.status}`);
  lines.push(`Generated At:     ${report.generatedAt}`);
  lines.push("");
  lines.push("--------------------------------------------------------------------------------");
  lines.push("Classification Counts");
  lines.push("--------------------------------------------------------------------------------");
  lines.push(`  Total Sources Scanned:        ${report.counts.sourceSeenCount}`);
  lines.push(`  Pending Conversion (3b):      ${report.counts.pendingConversionCount}`);
  lines.push(`  Dropped Noise:                ${report.counts.droppedNoiseCount}`);
  lines.push(`  Dropped Sensitive:            ${report.counts.droppedSensitiveCount}`);
  lines.push(`  Unroutable:                   ${report.counts.unroutableCount}`);
  lines.push(`  Superseded (Changed Content): ${report.counts.supersededCount}`);
  lines.push(`  Source Deleted (Tombstones):  ${report.counts.sourceDeletedCount}`);
  lines.push(`  Skipped Unchanged:            ${report.counts.skippedUnchangedCount}`);
  lines.push("");
  lines.push("--------------------------------------------------------------------------------");
  lines.push("Active Run Gate");
  lines.push("--------------------------------------------------------------------------------");
  lines.push(`  Pauses Triggered:             ${report.activeRunGate.pauseCount}`);
  lines.push(`  Total Paused Duration:        ${Math.round(report.activeRunGate.totalPausedMs / 1000)}s`);
  lines.push("");
  if (report.caveats.length > 0) {
    lines.push("--------------------------------------------------------------------------------");
    lines.push("Caveats & Notes");
    lines.push("--------------------------------------------------------------------------------");
    for (const c of report.caveats) {
      lines.push(`  * ${c}`);
    }
    lines.push("");
  }
  lines.push("================================================================================");
  return lines.join("\n");
}

function guardCleanupErrorCode(err: unknown): UpgradeErrorCode {
  if (err && typeof err === "object" && "code" in err && typeof (err as any).code === "string") {
    return mapSweepErrorCode((err as any).code);
  }
  return "unexpected_failure";
}

export async function runSweep(
  options: SweepOptions,
  deps: SweepDependencies = {},
): Promise<SweepReport> {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? createSystemClock();
  const sleeper = deps.sleeper ?? createSystemSleeper();

  const {
    databaseUrl,
    controlPlaneUrl,
    companyId,
    tableName = "mem0_memories",
    pageSize = 1000,
    maxRows,
    pauseWhenActiveRuns = 1,
    activeRunPollMs = 15_000,
    maxPauseSeconds = 0,
    operatorLabel = null,
    allowProd = false,
    outputPath,
  } = options;

  if (operatorLabel !== null && operatorLabel !== undefined) {
    if (
      typeof operatorLabel !== "string" ||
      operatorLabel.length < 1 ||
      operatorLabel.length > 64 ||
      !/^[A-Za-z0-9._:@-]+$/.test(operatorLabel)
    ) {
      throw new CompanyMemoryUpgradeError(
        "Invalid --operator-label. Must be 1-64 characters matching [A-Za-z0-9._:@-].",
        "INVALID_ARGUMENT",
      );
    }
  }

  if (!isValidUuid(companyId)) {
    throw new CompanyMemoryUpgradeError(
      "Invalid --company. Must be a valid UUID.",
      "INVALID_ARGUMENT",
    );
  }

  // Prod guard applies to BOTH DSNs
  const parsedTenantUrl = validateDatabaseUrl(databaseUrl, env, { allowProd });
  validateDatabaseUrl(controlPlaneUrl, env, { allowProd });

  if (outputPath) {
    validateOutputPath(outputPath, deps.repoRoot);
  }

  const caveats: string[] = [
    "CLASSIFICATION SWEEP (PR3a): Sources classified and recorded in ledger; zero memories converted or written to staging.",
    "Conversion and embedding generation will occur in follow-up cutover PR3b.",
    "Live collection table accessed read-only (SELECT ONLY).",
  ];

  // Open connections
  const tenantSql = deps.tenantSql ?? openTenantClient(databaseUrl);
  const ownsTenantSql = !deps.tenantSql;

  const cpDb = deps.controlPlaneDb ?? createDb(controlPlaneUrl, { maxConnections: 1 });
  const ownsCpDb = !deps.controlPlaneDb;

  let leaseToken: string | null = null;
  let upgradeId: string | null = null;
  let heartbeatHandle: ReturnType<typeof startLeaseHeartbeat> | null = null;
  let activeRunGate: ReturnType<typeof createActiveRunGate> | null = null;

  const counts: SweepCounts = {
    sourceSeenCount: 0,
    unroutableCount: 0,
    droppedNoiseCount: 0,
    droppedSensitiveCount: 0,
    pendingConversionCount: 0,
    supersededCount: 0,
    sourceDeletedCount: 0,
    skippedUnchangedCount: 0,
  };

  const rand8 = randomUUID().replace(/-/g, "").slice(0, 8);
  const leaseOwner = `memupg_sweep_${process.pid}_${rand8}`;

  try {
    // 1. Role preflights on both connections
    await assertTenantRolePreflight(tenantSql, "tenant");

    await cpDb.transaction(async (tx) => {
      await assertNonSuperuserAndRestrictedRole(tx, "control-plane");
    });

    // 2. Fetch tenant current_database() and current_user
    const dbInfoRows = await tenantSql`
      SELECT current_database()::text AS current_database, current_user::text AS current_user;
    `;
    const currentDatabase = deps._internalDatabaseIdentityOverride?.database !== undefined
      ? (deps._internalDatabaseIdentityOverride.database ?? "").trim()
      : (dbInfoRows[0]?.current_database ?? "").trim();
    const currentUser = deps._internalDatabaseIdentityOverride?.user !== undefined
      ? (deps._internalDatabaseIdentityOverride.user ?? "").trim()
      : (dbInfoRows[0]?.current_user ?? "").trim();

    if (!currentDatabase || !currentUser) {
      throw new CompanyMemoryUpgradeError(
        "Unable to determine current database and user identity from tenant connection.",
        "DATABASE_IDENTITY_UNAVAILABLE",
      );
    }

    // 3. Control plane binding verification
    let resolvedCompanyName: string | null = null;
    await cpDb.transaction(async (tx) => {
      const compRows = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId));

      if (!compRows[0]) {
        throw new CompanyMemoryUpgradeError(
          "Target company record does not exist in control plane database.",
          "COMPANY_NOT_FOUND",
        );
      }
      resolvedCompanyName = compRows[0].name;

      const memDbRows = await tx
        .select({
          databaseName: companyMemoryDatabases.databaseName,
          databaseRole: companyMemoryDatabases.databaseRole,
          host: companyMemoryDatabases.host,
          port: companyMemoryDatabases.port,
          status: companyMemoryDatabases.status,
        })
        .from(companyMemoryDatabases)
        .where(eq(companyMemoryDatabases.companyId, companyId))
        .limit(1);

      if (!memDbRows[0]) {
        throw new CompanyMemoryUpgradeError(
          "No company_memory_databases record found for target company.",
          "COMPANY_BINDING_MISMATCH",
        );
      }

      const memRow = memDbRows[0];
      if (memRow.status !== "ready") {
        throw new CompanyMemoryUpgradeError(
          "Company memory database binding status is not ready (refusing pending, failed, deprovisioning, archived).",
          "COMPANY_BINDING_MISMATCH",
        );
      }

      if (memRow.databaseName !== currentDatabase || memRow.databaseRole !== currentUser) {
        throw new CompanyMemoryUpgradeError(
          "Company memory database binding mismatch between control plane and connected tenant.",
          "COMPANY_BINDING_MISMATCH",
        );
      }

      const pcmemPattern = /^pcmem_[0-9a-f]{32}$/;
      if (pcmemPattern.test(currentDatabase)) {
        const derived = deriveCompanyMemoryDatabaseNames(companyId);
        if (currentDatabase !== derived.databaseName || currentUser !== derived.databaseRole) {
          throw new CompanyMemoryUpgradeError(
            "Company memory database binding mismatch with derived credentials.",
            "COMPANY_BINDING_MISMATCH",
          );
        }
      }
    });

    // 4. Introspect live collection shape and ensure tenant upgrade tables exist
    const shape = await introspectCollection(tenantSql, tableName, {
      skipVectorIdentityCheck: deps._internalSkipVectorIdentityCheck,
    });

    const stagingVectorType = deps._internalSkipVectorIdentityCheck
      ? "text"
      : shape.embeddingType;
    await ensureUpgradeTables(tenantSql, stagingVectorType);

    // 5. Pre-load company agents for routing
    const agentRows = await cpDb
      .select({
        id: agents.id,
        name: agents.name,
        adapterType: agents.adapterType,
        status: agents.status,
        pausedAt: agents.pausedAt,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const cpAgentMap = new Map<string, CpAgentRow>();
    for (const a of agentRows) {
      cpAgentMap.set(a.id.trim().toLowerCase(), a);
    }

    // 6. Acquire upgrade record in control-plane transaction
    let upgrade = await cpDb.transaction(async (tx) => {
      await assertCompanyAcceptsMemoryWork(tx, companyId);
      return await findActiveUpgrade(tx, companyId);
    });

    if (!upgrade) {
      upgrade = await openUpgrade(
        cpDb,
        {
          companyId,
          converterId: CONVERTER_ID,
          converterVersion: CONVERTER_VERSION,
          collectionName: tableName,
          embeddingModel: "text-embedding-3-small",
          embeddingDimensions: 1536,
          operatorLabel: operatorLabel ?? null,
        },
        { clock },
      );
    } else if (upgrade.state === "sweeping") {
      if (
        upgrade.converterId !== CONVERTER_ID ||
        upgrade.converterVersion !== CONVERTER_VERSION ||
        upgrade.collectionName !== tableName
      ) {
        throw new CompanyMemoryUpgradeError(
          "Upgrade record converter contract or collection mismatch",
          "CONVERTER_CONTRACT_MISMATCH",
        );
      }
    } else if (upgrade.state === "needs_recovery") {
      throw new CompanyMemoryUpgradeError(
        "Upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' before resuming sweep.",
        "STATE_MISMATCH",
      );
    } else {
      throw new CompanyMemoryUpgradeError(
        "Cannot run sweep: active upgrade is not in sweeping state.",
        "STATE_MISMATCH",
      );
    }

    upgradeId = upgrade.id;

    // 7. Claim upgrade lease
    const claim = await claimUpgradeLease(cpDb, {
      upgradeId: upgrade.id,
      leaseOwner,
      now: clock.now(),
    });

    if (!claim.acquired || !claim.leaseToken || !claim.leaseExpiresAt) {
      throw new CompanyMemoryUpgradeError(
        "Failed to acquire lease for upgrade. Another worker may hold the lease.",
        "LEASE_FENCED_OUT",
      );
    }

    leaseToken = claim.leaseToken;

    // 8. Start lease heartbeat
    heartbeatHandle = startLeaseHeartbeat(cpDb, upgrade.id, leaseToken, {
      initialExpiresAt: claim.leaseExpiresAt,
      clock,
      onLost: () => {
        // Will be asserted at next checkpoint
      },
    });

    // 9. Active run gate
    activeRunGate = createActiveRunGate({
      db: cpDb,
      companyId,
      threshold: pauseWhenActiveRuns,
      pollMs: activeRunPollMs,
      maxPauseMs: maxPauseSeconds * 1000,
      clock,
      sleeper,
      assertLeaseActive: () => heartbeatHandle?.assertActive(),
    });

    // 10. Process live source pages
    let isFirstPage = true;

    const sourceIterator = iterateSourcePages(tenantSql, tableName, {
      pageSize,
      maxRows,
      isUuidId: shape.isUuidId,
    });

    while (true) {
      heartbeatHandle.assertActive();
      await activeRunGate.waitUntilQuiet();
      heartbeatHandle.assertActive();

      const iterResult = await sourceIterator.next();
      if (iterResult.done) {
        break;
      }
      const page = iterResult.value;

      // Upfront validation: reject non-UUID source IDs before any mutations
      for (const source of page) {
        if (!isValidUuid(source.id)) {
          throw new CompanyMemoryUpgradeError(
            "Collection table contains source row with non-UUID id. Upgrade ledger requires valid UUID source IDs.",
            "UNSUPPORTED_SOURCE_ID",
          );
        }
      }

      const pageDeltas = {
        sourceSeenCount: page.length,
        unroutableCount: 0,
        droppedNoiseCount: 0,
        droppedSensitiveCount: 0,
        supersededCount: 0,
        sourceDeletedCount: 0,
        skippedUnchangedCount: 0,
        pendingConversionCount: 0,
      };

      const pageSourceIds = page.map((r) => r.id.toLowerCase());
      const minPageId = pageSourceIds[0];
      const maxPageId = pageSourceIds[pageSourceIds.length - 1];

      // Reconcile tombstones for this page's keyset range
      heartbeatHandle.assertActive();
      const tombstoneResult = await reconcileTombstones(tenantSql, upgradeId, {
        minSourceId: minPageId,
        maxSourceId: maxPageId,
        liveSourceIds: pageSourceIds,
        assertLeaseActive: () => heartbeatHandle?.assertActive(),
      });
      pageDeltas.sourceDeletedCount += tombstoneResult.tombstonesCount;

      // Load existing ledger rows for live sources in this page
      heartbeatHandle.assertActive();
      const ledgerMap = await loadLedgerForSources(tenantSql, upgradeId, pageSourceIds);

      // Classify each source in this page
      for (const source of page) {
        heartbeatHandle.assertActive();

        const canonicalSourceId = source.id.toLowerCase();
        const contentSha256 = computeSourceContentSha256(source.data);
        const existingLedger = ledgerMap.get(canonicalSourceId);

        // Pre-compute routing to compare agent assignment
        const routing = classifyAgentRouting(source.agentId, cpAgentMap);
        const matchedAgentId = routing.matchedAgentId;

        if (existingLedger) {
          if (
            existingLedger.sourceContentSha256 === contentSha256 &&
            existingLedger.agentId === matchedAgentId
          ) {
            pageDeltas.skippedUnchangedCount++;
            continue;
          }

          // Content or agent assignment changed: reconcile to superseded
          heartbeatHandle.assertActive();
          await reconcileChangedContent(tenantSql, upgradeId, canonicalSourceId);
          pageDeltas.supersededCount++;
          // Then source re-enters classification in this same sweep
        }

        // Gate 1: Routing -> unroutable
        if (!routing.isRoutable) {
          heartbeatHandle.assertActive();
          await commitSourceOutcome(tenantSql, {
            upgradeId,
            sourceId: canonicalSourceId,
            sourceContentSha256: contentSha256,
            agentId: routing.matchedAgentId,
            outcome: "unroutable",
            reasonCode: routing.unroutableReason!,
          });
          pageDeltas.unroutableCount++;
          continue;
        }

        // Gate 2: Noise -> dropped_noise
        const noise = classifyMemoryNoiseDetailed(source.data);
        if (noise.isNoise) {
          heartbeatHandle.assertActive();
          await commitSourceOutcome(tenantSql, {
            upgradeId,
            sourceId: canonicalSourceId,
            sourceContentSha256: contentSha256,
            agentId: matchedAgentId,
            outcome: "dropped_noise",
            reasonCode: noise.reason!,
          });
          pageDeltas.droppedNoiseCount++;
          continue;
        }

        // Gate 3: Sensitive -> dropped_sensitive
        const sensitive = detectSensitiveFamilies(source.data);
        if (sensitive.isSensitive) {
          const families = (Object.entries(sensitive.matches) as Array<[SensitiveFamilyName, boolean]>)
            .filter(([, hit]) => hit)
            .map(([fam]) => fam)
            .sort()
            .join(",");
          heartbeatHandle.assertActive();
          await commitSourceOutcome(tenantSql, {
            upgradeId,
            sourceId: canonicalSourceId,
            sourceContentSha256: contentSha256,
            agentId: matchedAgentId,
            outcome: "dropped_sensitive",
            reasonCode: families,
          });
          pageDeltas.droppedSensitiveCount++;
          continue;
        }

        // Gate 4: Routable non-noise non-sensitive -> pending conversion
        // In PR3a: ZERO staging writes, no ledger row written.
        pageDeltas.pendingConversionCount++;
      }

      // Flush counter deltas for this page to control plane
      heartbeatHandle.assertActive();
      await updateUpgradeCounters(
        cpDb,
        upgradeId,
        leaseToken,
        {
          sweepCount: isFirstPage ? 1 : undefined,
          sourceSeenCount: pageDeltas.sourceSeenCount,
          unroutableCount: pageDeltas.unroutableCount,
          droppedNoiseCount: pageDeltas.droppedNoiseCount,
          droppedSensitiveCount: pageDeltas.droppedSensitiveCount,
          supersededCount: pageDeltas.supersededCount,
          sourceDeletedCount: pageDeltas.sourceDeletedCount,
        },
        { clock },
      );

      // Accumulate into report counts
      counts.sourceSeenCount += pageDeltas.sourceSeenCount;
      counts.unroutableCount += pageDeltas.unroutableCount;
      counts.droppedNoiseCount += pageDeltas.droppedNoiseCount;
      counts.droppedSensitiveCount += pageDeltas.droppedSensitiveCount;
      counts.supersededCount += pageDeltas.supersededCount;
      counts.sourceDeletedCount += pageDeltas.sourceDeletedCount;
      counts.skippedUnchangedCount += pageDeltas.skippedUnchangedCount;
      counts.pendingConversionCount += pageDeltas.pendingConversionCount;

      isFirstPage = false;
    }

    // If live table was completely empty, still record sweepCount: 1 if first page never ran
    if (isFirstPage) {
      heartbeatHandle.assertActive();
      await updateUpgradeCounters(
        cpDb,
        upgradeId,
        leaseToken,
        { sweepCount: 1 },
        { clock },
      );
    }

    // Final pass for any tombstones in ledger that were outside the live keyset bounds
    heartbeatHandle.assertActive();
    const finalTombstones = await reconcileTombstones(tenantSql, upgradeId, {
      liveTableName: tableName,
      isUuidId: shape.isUuidId,
      assertLeaseActive: () => heartbeatHandle?.assertActive(),
    });
    if (finalTombstones.tombstonesCount > 0) {
      heartbeatHandle.assertActive();
      counts.sourceDeletedCount += finalTombstones.tombstonesCount;
      await updateUpgradeCounters(
        cpDb,
        upgradeId,
        leaseToken,
        { sourceDeletedCount: finalTombstones.tombstonesCount },
        { clock },
      );
    }

    const gateStats = activeRunGate ? activeRunGate.stats() : { pauseCount: 0, totalPausedMs: 0 };

    const report: SweepReport = {
      schemaVersion: "1.0",
      generatedAt: (deps._internalNow ?? clock.now()).toISOString(),
      company: {
        id: companyId,
        name: resolvedCompanyName,
      },
      upgradeId: upgrade.id,
      leaseOwner,
      status: "completed",
      counts,
      activeRunGate: gateStats,
      caveats,
    };

    if (outputPath) {
      const serialized = options.format === "json"
        ? JSON.stringify(report, null, 2)
        : formatSweepTextReport(report);
      await writeFile(outputPath, serialized, { mode: 0o600, flag: "wx" });
    }

    return report;
  } catch (error) {
    if (upgradeId && leaseToken) {
      try {
        const errorCode = error instanceof CompanyMemoryUpgradeError
          ? mapSweepErrorCode(error.code)
          : "unexpected_failure";

        if (errorCode !== "lease_fenced_out" && errorCode !== "lease_expired" && errorCode !== "lease_lapsed") {
          await updateUpgradeCounters(
            cpDb,
            upgradeId,
            leaseToken,
            { lastError: errorCode },
            { clock },
          ).catch((cleanupErr: any) => {
            console.error("[memory-upgrade] failed to record lastError:", guardCleanupErrorCode(cleanupErr));
          });
        }
      } catch (err: any) {
        console.error("[memory-upgrade] error in lastError recording:", guardCleanupErrorCode(err));
      }
    }
    throw error;
  } finally {
    if (heartbeatHandle) {
      await heartbeatHandle.stop().catch((err: any) => {
        console.error("[memory-upgrade] heartbeat stop error:", guardCleanupErrorCode(err));
      });
    }

    if (upgradeId && leaseToken) {
      try {
        await releaseUpgradeLease(cpDb, upgradeId, leaseToken, { clock }).catch((err: any) => {
          console.error("[memory-upgrade] lease release error:", guardCleanupErrorCode(err));
        });
      } catch (err: any) {
        console.error("[memory-upgrade] lease release failure:", guardCleanupErrorCode(err));
      }
    }

    if (ownsTenantSql) {
      await tenantSql.end().catch((err: any) => {
        console.error("[memory-upgrade] tenant connection close error:", guardCleanupErrorCode(err));
      });
    }

    if (ownsCpDb) {
      await cpDb.$client?.end().catch((err: any) => {
        console.error("[memory-upgrade] control plane connection close error:", guardCleanupErrorCode(err));
      });
    }
  }
}
