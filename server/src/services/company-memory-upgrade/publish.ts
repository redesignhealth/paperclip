/**
 * Orchestrator service for company memory upgrade publish (TECH-8191).
 *
 * Invariants:
 * - Cost-free: never imports OpenAI, embedding or LLM converter clients.
 * - Runs while upgrade state is 'sweeping'; never calls openUpgrade.
 * - Single tenant transaction for live insert and published_at marking.
 * - Honest counter flush: flushes only committed deltas, never pre-seeded.
 */

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createDb, type Db } from "@paperclipai/db";
import { classifyAgentRouting, type CpAgentRow } from "./agent-routing.js";
import { assertCompanyAcceptsMemoryWork, findActiveUpgrade } from "./admission.js";
import { createActiveRunGate } from "./active-runs.js";
import {
  createSystemClock,
  createSystemSleeper,
  type MonotonicClock,
  type Sleeper,
} from "./clock.js";
import { CONVERTER_ID, CONVERTER_VERSION } from "./converter-version.js";
import { computeSourceContentSha256 } from "./source-hash.js";
import { runTenantPreflight } from "./preflight.js";
import {
  assertLiveCollectionInsertable,
  loadLiveSourceRows,
  publishSourceBatch,
  resolveLiveVectorCast,
  selectUnpublishedSourcePage,
  type LiveSourceRow,
} from "./publish-tenant.js";
import {
  claimUpgradeLease,
  CompanyMemoryUpgradeError,
  releaseUpgradeLease,
  startLeaseHeartbeat,
  updateUpgradeCounters,
} from "./state-machine.js";
import {
  acquireSourceAdvisoryLock,
  claimTenantFenceGuarded,
  validateTenantFence,
  type TenantFence,
} from "./tenant-fence.js";
import { UPGRADE_WORK_STATES, isUpgradeWorkState } from "./phases.js";
import { isValidUuid } from "./census.js";
import { ensureUpgradeTables, introspectStagingEmbeddingType } from "./tenant-tables.js";
import {
  mapSweepErrorCode,
  type UpgradeErrorCode,
  type UpgradeState,
} from "./types.js";
import {
  openTenantClient,
  reconcileChangedContent,
  reconcileTombstones,
} from "./sweep-tenant.js";

export interface PublishOptions {
  companyId: string;
  tenantDatabaseUrl?: string;
  controlPlaneDatabaseUrl?: string;
  table?: string;
  confirm?: string;
  maxRows?: number;
  batchSources?: number;
  pageSize?: number;
  pauseWhenActiveRuns?: number;
  activeRunPollMs?: number;
  maxPauseSeconds?: number;
  clock?: MonotonicClock & { now(): Date };
  sleeper?: Sleeper;
}

export interface PublishDependencies {
  cpDb?: Db;
  tenantSql?: postgres.Sql;
  clock?: MonotonicClock & { now(): Date };
  sleeper?: Sleeper;
  _internalSkipVectorIdentityCheck?: boolean;
  _internalDatabaseIdentityOverride?: { database?: string | null; user?: string | null };
  _internalCreateCpDb?: typeof createDb;
}

export interface CleanupDroppedSourceParams {
  upgradeId: string;
  sourceId: string;
}

/**
 * Fenced cleanup of unpublished staging and dedupe rows for dropped or unroutable sources.
 *
 * Follows exact L1 -> L2 discipline:
 * L1: acquire per-source advisory lock
 * L2: validate tenant fence FOR SHARE
 * Then:
 * 1. Select output_ids of unpublished staging rows (published_at IS NULL)
 * 2. Delete matching dedupe rows for those output_ids
 * 3. Delete unpublished staging rows
 * 4. Refresh ledger output_ids via correlated subquery (never EXCLUDED.output_ids)
 */
export async function cleanupUnpublishedDroppedStaging(
  sql: postgres.Sql,
  params: CleanupDroppedSourceParams,
  fence: TenantFence,
): Promise<{ deletedStagingCount: number; deletedDedupeCount: number }> {
  const { upgradeId, sourceId } = params;

  if (!isValidUuid(sourceId)) {
    throw new CompanyMemoryUpgradeError(
      "sourceId must be a valid UUID string.",
      "UNSUPPORTED_SOURCE_ID",
    );
  }
  if (!isValidUuid(upgradeId)) {
    throw new CompanyMemoryUpgradeError(
      "upgradeId must be a valid UUID string.",
      "INVALID_ARGUMENT",
    );
  }
  if (!fence || fence.upgradeId !== upgradeId) {
    throw new CompanyMemoryUpgradeError(
      "cleanupUnpublishedDroppedStaging requires a valid tenant fence for this upgrade.",
      "INVALID_ARGUMENT",
    );
  }

  let deletedStagingCount = 0;
  let deletedDedupeCount = 0;

  await sql.begin(async (tx: any) => {
    // L1: per-source advisory lock BEFORE the fence row lock
    await acquireSourceAdvisoryLock(tx, upgradeId, sourceId);
    // L2: fence row SHARE lock, held to commit
    await validateTenantFence(tx, fence);

    // 1. Find unpublished staging output_ids
    const stagingRows = (await tx.unsafe(
      `SELECT output_id
       FROM paperclip_memory_upgrade_staging
       WHERE upgrade_id = $1::uuid AND source_id = $2::uuid AND published_at IS NULL;`,
      [upgradeId, sourceId],
    )) as Array<{ output_id: string }>;
    const outputIds = stagingRows.map((r) => r.output_id);

    // 2. Delete matching dedupe rows
    if (outputIds.length > 0) {
      const deletedDedupe = await tx.unsafe(
        `DELETE FROM paperclip_memory_upgrade_dedupe
         WHERE upgrade_id = $1::uuid AND output_id = ANY($2::uuid[])
         RETURNING output_id;`,
        [upgradeId, outputIds],
      );
      deletedDedupeCount = deletedDedupe.length;
    }

    // 3. Delete unpublished staging rows
    const deletedStaging = await tx.unsafe(
      `DELETE FROM paperclip_memory_upgrade_staging
       WHERE upgrade_id = $1::uuid AND source_id = $2::uuid AND published_at IS NULL
       RETURNING output_id;`,
      [upgradeId, sourceId],
    );
    deletedStagingCount = deletedStaging.length;

    // 4. Refresh ledger output_ids via correlated subquery (never EXCLUDED.output_ids)
    await tx.unsafe(
      `UPDATE paperclip_memory_upgrade_ledger l
       SET output_ids = COALESCE((
         SELECT array_agg(s.output_id ORDER BY s.output_id)
         FROM paperclip_memory_upgrade_staging s
         WHERE s.upgrade_id = l.upgrade_id AND s.source_id = l.source_id), '{}'),
         updated_at = now()
       WHERE l.upgrade_id = $1::uuid AND l.source_id = $2::uuid;`,
      [upgradeId, sourceId],
    );
  });

  return { deletedStagingCount, deletedDedupeCount };
}

export interface PublishCounts {
  publishedCount: number;
  supersededCount: number;
  sourceDeletedCount: number;
  pendingRows: number;
  alreadyPublishedRows: number;
  pendingSources: number;
}

export interface PublishReport {
  isDryRun: boolean;
  companyId: string;
  upgradeId: string;
  state: UpgradeState;
  counts: PublishCounts;
  durationMs: number;
  activeRunGate: { pauseCount: number; totalPausedMs: number };
  lastError?: UpgradeErrorCode;
}

export interface CandidateSource {
  id: string;
  agentId: string | null;
  sha: string;
  outcome: string;
}

export function partitionCandidates(
  candidates: CandidateSource[],
  liveRows: Map<string, LiveSourceRow>,
  cpAgentMap: Map<string, CpAgentRow>,
): {
  tombstones: string[];
  changed: Array<{ id: string; newSha: string; newAgentId: string | null }>;
  publishable: CandidateSource[];
} {
  const tombstones: string[] = [];
  const changed: Array<{ id: string; newSha: string; newAgentId: string | null }> = [];
  const publishable: CandidateSource[] = [];

  for (const c of candidates) {
    const live = liveRows.get(c.id.toLowerCase());
    if (!live) {
      tombstones.push(c.id);
      continue;
    }
    const liveSha = computeSourceContentSha256(live.data ?? "");
    const routing = classifyAgentRouting(live.agentId, cpAgentMap);
    if (liveSha !== c.sha || !routing.isRoutable || routing.matchedAgentId !== c.agentId) {
      changed.push({
        id: c.id,
        newSha: liveSha,
        newAgentId: routing.matchedAgentId,
      });
      continue;
    }
    publishable.push(c);
  }

  return { tombstones, changed, publishable };
}

export function formatPublishTextReport(report: PublishReport): string {
  const isComplete = report.counts.pendingRows === 0 && report.counts.pendingSources === 0;
  const header = report.isDryRun
    ? "DRY RUN — no rows were published. No lease or fence was taken; these numbers are a point-in-time estimate."
    : isComplete
      ? "Publish complete."
      : "Publish batch complete; pending work remains.";
  return [
    `=== Memory Upgrade Publish Report ===`,
    header,
    `Company ID:       ${report.companyId}`,
    `Upgrade ID:       ${report.upgradeId}`,
    `State:            ${report.state}`,
    `Published rows:   ${report.counts.publishedCount}`,
    `Superseded:       ${report.counts.supersededCount}`,
    `Source deleted:   ${report.counts.sourceDeletedCount}`,
    `Pending rows:     ${report.counts.pendingRows}`,
    `Pending sources:  ${report.counts.pendingSources}`,
    `Duration (ms):    ${report.durationMs}`,
    `Gate pauses:      ${report.activeRunGate.pauseCount} (${report.activeRunGate.totalPausedMs} ms)`,
    ...(report.lastError ? [`Last error:       ${report.lastError}`] : []),
  ].join("\n");
}

export function formatPublishReport(report: PublishReport, format: "text" | "json" = "text"): string {
  return format === "json" ? JSON.stringify(report, null, 2) : formatPublishTextReport(report);
}

export async function runPublish(
  options: PublishOptions,
  deps: PublishDependencies = {},
): Promise<PublishReport> {
  const startTime = Date.now();
  const companyId = options.companyId;
  const tableName = options.table ?? "mem0_memories";
  const isDryRun = !options.confirm || options.confirm !== companyId;
  const clock = deps.clock ?? options.clock ?? createSystemClock();
  const sleeper = deps.sleeper ?? options.sleeper ?? createSystemSleeper();
  const batchSources = options.batchSources && options.batchSources > 0 ? options.batchSources : 100;
  const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 1000;
  const maxRows = options.maxRows && options.maxRows > 0 ? options.maxRows : undefined;

  let cpDb = deps.cpDb;
  let tenantSql = deps.tenantSql;
  let ownCp = false;
  let ownTenant = false;

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
    tenantSql = openTenantClient(options.tenantDatabaseUrl, { max: 1 });
    ownTenant = true;
  }

  let heartbeatHandle: ReturnType<typeof startLeaseHeartbeat> | null = null;
  let activeUpgradeId = "";
  let leaseToken: string | null = null;

  const pending = { publishedCount: 0, supersededCount: 0, sourceDeletedCount: 0 };
  const flushPending = async (lastError?: UpgradeErrorCode): Promise<void> => {
    if (!leaseToken || !activeUpgradeId || !cpDb) return;
    const snap = { ...pending };
    const hasDelta = snap.publishedCount > 0 || snap.supersededCount > 0 || snap.sourceDeletedCount > 0;
    if (!hasDelta && lastError === undefined) return;
    await updateUpgradeCounters(
      cpDb,
      activeUpgradeId,
      leaseToken,
      {
        publishedCount: snap.publishedCount > 0 ? snap.publishedCount : undefined,
        supersededCount: snap.supersededCount > 0 ? snap.supersededCount : undefined,
        sourceDeletedCount: snap.sourceDeletedCount > 0 ? snap.sourceDeletedCount : undefined,
        ...(lastError !== undefined ? { lastError } : {}),
      },
      { clock },
    );
    pending.publishedCount -= snap.publishedCount;
    pending.supersededCount -= snap.supersededCount;
    pending.sourceDeletedCount -= snap.sourceDeletedCount;
  };

  try {
    // Phase A: Preflight before any mutations
    const preflight = await runTenantPreflight(
      cpDb,
      tenantSql,
      { companyId, tableName },
      {
        _internalSkipVectorIdentityCheck: deps._internalSkipVectorIdentityCheck,
        _internalDatabaseIdentityOverride: deps._internalDatabaseIdentityOverride,
      },
    );

    await assertLiveCollectionInsertable(tenantSql, tableName, preflight.shape);
    const vectorCast = resolveLiveVectorCast(preflight.shape, preflight.stagingVectorType);

    // Verify upgrade state under CP transaction
    const upgrade = await cpDb.transaction(async (tx) => {
      await assertCompanyAcceptsMemoryWork(tx, companyId);
      return await findActiveUpgrade(tx, companyId);
    });

    if (!upgrade) {
      throw new CompanyMemoryUpgradeError(
        "No active memory upgrade for this company; run 'pnpm memory:upgrade sweep' first.",
        "STATE_MISMATCH",
      );
    }
    if (!isUpgradeWorkState(upgrade.state)) {
      throw new CompanyMemoryUpgradeError(
        "Cannot run publish: active upgrade is not in sweeping state.",
        "STATE_MISMATCH",
      );
    }
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
    activeUpgradeId = upgrade.id;

    const stagingType = await introspectStagingEmbeddingType(tenantSql);

    // Phase B: Dry run
    if (isDryRun) {
      if (!stagingType) {
        return {
          isDryRun: true,
          companyId,
          upgradeId: activeUpgradeId,
          state: upgrade.state,
          counts: { publishedCount: 0, supersededCount: 0, sourceDeletedCount: 0, pendingRows: 0, alreadyPublishedRows: 0, pendingSources: 0 },
          durationMs: Date.now() - startTime,
          activeRunGate: { pauseCount: 0, totalPausedMs: 0 },
        };
      }

      const [{ pending_rows, already_published_rows, pending_sources }] = (await tenantSql.unsafe(
        `SELECT
           count(*) FILTER (WHERE published_at IS NULL)::int AS pending_rows,
           count(*) FILTER (WHERE published_at IS NOT NULL)::int AS already_published_rows,
           count(DISTINCT source_id) FILTER (WHERE published_at IS NULL)::int AS pending_sources
         FROM paperclip_memory_upgrade_staging
         WHERE upgrade_id = $1::uuid;`,
        [activeUpgradeId],
      )) as Array<{ pending_rows: number; already_published_rows: number; pending_sources: number }>;

      return {
        isDryRun: true,
        companyId,
        upgradeId: activeUpgradeId,
        state: upgrade.state,
        counts: {
          publishedCount: 0,
          supersededCount: 0,
          sourceDeletedCount: 0,
          pendingRows: pending_rows ?? 0,
          alreadyPublishedRows: already_published_rows ?? 0,
          pendingSources: pending_sources ?? 0,
        },
        durationMs: Date.now() - startTime,
        activeRunGate: { pauseCount: 0, totalPausedMs: 0 },
      };
    }

    // Phase C: Confirmed run
    const rand8 = randomUUID().replace(/-/g, "").slice(0, 8);
    const leaseOwner = `memupg_publish_${process.pid}_${rand8}`;
    const claimRes = await claimUpgradeLease(cpDb, {
      upgradeId: activeUpgradeId,
      leaseOwner,
      now: clock.now?.() ?? new Date(),
    });

    if (!claimRes.acquired || !claimRes.leaseToken || !claimRes.leaseExpiresAt) {
      throw new CompanyMemoryUpgradeError(
        "Failed to acquire lease for upgrade. Another worker may hold the lease.",
        "LEASE_FENCED_OUT",
      );
    }
    leaseToken = claimRes.leaseToken;

    heartbeatHandle = startLeaseHeartbeat(cpDb, activeUpgradeId, leaseToken, {
      initialExpiresAt: claimRes.leaseExpiresAt,
      clock,
      onLost: () => {},
    });

    await ensureUpgradeTables(tenantSql, preflight.stagingVectorType);

    const fence = await claimTenantFenceGuarded(cpDb, tenantSql, {
      upgradeId: activeUpgradeId,
      cpLeaseToken: leaseToken,
      leaseOwner,
      now: clock.now?.() ?? new Date(),
      allowedStates: UPGRADE_WORK_STATES,
    });

    const activeRunGate = createActiveRunGate({
      db: cpDb,
      companyId,
      threshold: options.pauseWhenActiveRuns ?? 1,
      pollMs: options.activeRunPollMs ?? 15000,
      maxPauseMs: (options.maxPauseSeconds ?? 0) * 1000,
      clock,
      sleeper,
      assertLeaseActive: () => heartbeatHandle?.assertActive(),
    });

    let totalPublished = 0;
    let totalSuperseded = 0;
    let totalSourceDeleted = 0;
    let lastSourceId: string | null = null;
    let rowBudgetUsed = 0;

    while (true) {
      heartbeatHandle.assertActive();
      await activeRunGate.waitUntilQuiet();
      heartbeatHandle.assertActive();

      if (maxRows !== undefined && rowBudgetUsed >= maxRows) {
        break;
      }

      const page = await selectUnpublishedSourcePage(tenantSql, activeUpgradeId, {
        afterSourceId: lastSourceId,
        limit: pageSize,
      });

      if (page.sourceIds.length === 0) {
        break;
      }

      // Load ledger rows for these sources
      const ledgerRows = (await tenantSql.unsafe(
        `SELECT source_id, agent_id, outcome, source_content_sha256
         FROM paperclip_memory_upgrade_ledger
         WHERE upgrade_id = $1::uuid AND source_id = ANY($2::uuid[]);`,
        [activeUpgradeId, page.sourceIds],
      )) as Array<{
        source_id: string;
        agent_id: string | null;
        outcome: string;
        source_content_sha256: string;
      }>;

      const ledgerMap = new Map(ledgerRows.map((r) => [String(r.source_id).toLowerCase(), r]));

      const activeCandidates: CandidateSource[] = [];

      for (const sId of page.sourceIds) {
        const led = ledgerMap.get(sId);
        if (!led) {
          throw new CompanyMemoryUpgradeError(
            `Staging candidate ${sId} has no ledger row.`,
            "PUBLISH_LEDGER_INCONSISTENT",
          );
        }

        // Quarantined sources keep staging rows (never pruned) and are skipped
        if (led.outcome === "quarantined") {
          continue;
        }

        // Dropped / unroutable sources: clear stale unpublished staging rows
        if (
          led.outcome === "dropped_noise" ||
          led.outcome === "dropped_sensitive" ||
          led.outcome === "unroutable"
        ) {
          await cleanupUnpublishedDroppedStaging(
            tenantSql,
            { upgradeId: activeUpgradeId, sourceId: sId },
            fence,
          );
          continue;
        }

        if (led.outcome === "published") {
          activeCandidates.push({
            id: sId,
            agentId: led.agent_id ? String(led.agent_id).toLowerCase() : null,
            sha: led.source_content_sha256,
            outcome: led.outcome,
          });
        }
      }

      if (activeCandidates.length > 0) {
        const liveRows = await loadLiveSourceRows(
          tenantSql,
          tableName,
          activeCandidates.map((c) => c.id),
          preflight.shape.isUuidId,
        );

        const { tombstones, changed, publishable } = partitionCandidates(
          activeCandidates,
          liveRows,
          preflight.cpAgentMap,
        );

        if (tombstones.length > 0) {
          const res = await reconcileTombstones(
            tenantSql,
            activeUpgradeId,
            {
              tombstoneSourceIds: tombstones,
              batchSize: 200,
              assertLeaseActive: () => heartbeatHandle?.assertActive(),
            },
            fence,
          );
          pending.sourceDeletedCount += res.tombstonesCount;
          totalSourceDeleted += res.tombstonesCount;
          await flushPending();
        }

        for (const src of changed) {
          heartbeatHandle.assertActive();
          await reconcileChangedContent(
            tenantSql,
            {
              upgradeId: activeUpgradeId,
              sourceId: src.id,
              sourceContentSha256: src.newSha,
              agentId: src.newAgentId,
            },
            fence,
          );
          pending.supersededCount += 1;
          totalSuperseded += 1;
          await flushPending();
        }

        // Count pending staging rows per publishable source to enforce maxRows at source granularity
        if (publishable.length > 0) {
          const pubSourceIds = publishable.map((p) => p.id);
          const stagingCountRows = (await tenantSql.unsafe(
            `SELECT source_id, count(*)::int as count
             FROM paperclip_memory_upgrade_staging
             WHERE upgrade_id = $1::uuid AND source_id = ANY($2::uuid[]) AND published_at IS NULL
             GROUP BY source_id;`,
            [activeUpgradeId, pubSourceIds],
          )) as Array<{ source_id: string; count: number }>;

          const countsBySource = new Map(
            stagingCountRows.map((r) => [String(r.source_id).toLowerCase(), r.count]),
          );

          let budgetExhausted = false;
          const boundedSources: string[] = [];
          for (const p of publishable) {
            const count = countsBySource.get(p.id.toLowerCase()) ?? 0;
            if (maxRows !== undefined && rowBudgetUsed + count > maxRows) {
              // No source has been admitted into this (or any prior) page's budget yet:
              // the very first eligible source is already larger than --max-rows. Bounding
              // would publish zero rows while leaving the source unpublished, so a repeat
              // run would hit the exact same wall and stall forever. Since sources are
              // published atomically (never split across rows), refuse instead of silently
              // no-op'ing.
              if (rowBudgetUsed === 0 && totalPublished === 0) {
                throw new CompanyMemoryUpgradeError(
                  "Source exceeds --max-rows and cannot be split; increase --max-rows to at least the source's row count.",
                  "INVALID_ARGUMENT",
                );
              }
              // Otherwise this run already made progress (published rows in this or an
              // earlier page): stop normally so the committed progress is reported, and a
              // follow-up run resumes at this source.
              budgetExhausted = true;
              break;
            }
            boundedSources.push(p.id);
            rowBudgetUsed += count;
          }

          for (let i = 0; i < boundedSources.length; i += batchSources) {
            heartbeatHandle.assertActive();
            const chunkIds = boundedSources.slice(i, i + batchSources);
            const res = await publishSourceBatch(
              tenantSql,
              {
                upgradeId: activeUpgradeId,
                sourceIds: chunkIds,
                tableName,
                shape: preflight.shape,
                vectorCast,
              },
              fence,
            );
            pending.publishedCount += res.publishedCount;
            totalPublished += res.publishedCount;
            await flushPending();
          }

          if (budgetExhausted) {
            break;
          }
        }
      }

      lastSourceId = page.maxSourceId;
    }

    const [{ pending_rows, already_published_rows, pending_sources }] = (await tenantSql.unsafe(
      `SELECT
         count(*) FILTER (WHERE published_at IS NULL)::int AS pending_rows,
         count(*) FILTER (WHERE published_at IS NOT NULL)::int AS already_published_rows,
         count(DISTINCT source_id) FILTER (WHERE published_at IS NULL)::int AS pending_sources
       FROM paperclip_memory_upgrade_staging
       WHERE upgrade_id = $1::uuid;`,
      [activeUpgradeId],
    )) as Array<{ pending_rows: number; already_published_rows: number; pending_sources: number }>;

    const gateStats = activeRunGate.stats();

    return {
      isDryRun: false,
      companyId,
      upgradeId: activeUpgradeId,
      state: upgrade.state,
      counts: {
        publishedCount: totalPublished,
        supersededCount: totalSuperseded,
        sourceDeletedCount: totalSourceDeleted,
        pendingRows: pending_rows ?? 0,
        alreadyPublishedRows: already_published_rows ?? 0,
        pendingSources: pending_sources ?? 0,
      },
      durationMs: Date.now() - startTime,
      activeRunGate: {
        pauseCount: gateStats.pauseCount,
        totalPausedMs: gateStats.totalPausedMs,
      },
    };
  } catch (err) {
    const code = (err as any)?.code ?? (err as any)?.message;
    const mapped = mapSweepErrorCode(code);
    if (
      leaseToken &&
      mapped !== "lease_fenced_out" &&
      mapped !== "lease_expired" &&
      mapped !== "lease_lapsed"
    ) {
      await flushPending(mapped).catch(() => {});
    }
    throw err;
  } finally {
    if (heartbeatHandle) {
      await heartbeatHandle.stop().catch(() => {});
    }
    if (leaseToken && activeUpgradeId) {
      await releaseUpgradeLease(cpDb!, activeUpgradeId, leaseToken, {
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
