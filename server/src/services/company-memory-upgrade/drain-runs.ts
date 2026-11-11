/**
 * Blocking pre-flip run queries for company memory upgrade (TECH-8191 §Q3, PR5.5).
 *
 * Identifies active heartbeat runs on hermes_local agents that were created
 * or started before the flip marker and may still be running with company
 * memory scope.
 */

import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ACTIVE_HEARTBEAT_RUN_STATUSES } from "./active-runs.js";
import { isValidUuid } from "./census.js";
import { HERMES_ADAPTER_TYPE } from "../company-memory-constants.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface BlockingRun {
  id: string;
  agentId: string;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
}

export interface FindBlockingRunsOptions {
  companyId: string;
  markedAt: Date;
  limit?: number;
}

function validateBlockingRunArgs(companyId: string, markedAt: Date): void {
  if (!isValidUuid(companyId)) {
    throw new CompanyMemoryUpgradeError(
      `Invalid company ID: "${companyId}"`,
      "INVALID_ARGUMENT",
    );
  }
  if (!(markedAt instanceof Date) || Number.isNaN(markedAt.getTime())) {
    throw new CompanyMemoryUpgradeError(
      `Invalid markedAt timestamp: "${String(markedAt)}"`,
      "INVALID_ARGUMENT",
    );
  }
}

/**
 * Finds active heartbeat runs on hermes_local agents created or started before markedAt.
 * Conservative boundary: coalesce(started_at, created_at) < marked_at.
 * Reports ids, status, and timestamps only; never memory text or credentials.
 */
export async function findBlockingPreFlipRuns(
  cpDb: Db,
  options: FindBlockingRunsOptions,
): Promise<BlockingRun[]> {
  validateBlockingRunArgs(options.companyId, options.markedAt);
  const limit = options.limit && options.limit > 0 ? options.limit : 25;

  const rows = await cpDb
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        eq(heartbeatRuns.companyId, options.companyId),
        eq(agents.adapterType, HERMES_ADAPTER_TYPE),
        inArray(heartbeatRuns.status, Array.from(ACTIVE_HEARTBEAT_RUN_STATUSES)),
        sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) < ${options.markedAt.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    status: r.status,
    startedAt: r.startedAt ? new Date(r.startedAt) : null,
    createdAt: new Date(r.createdAt),
  }));
}

/**
 * Counts active heartbeat runs on hermes_local agents created or started before markedAt.
 */
export async function countBlockingPreFlipRuns(
  cpDb: Db,
  options: Omit<FindBlockingRunsOptions, "limit">,
): Promise<number> {
  validateBlockingRunArgs(options.companyId, options.markedAt);

  const [row] = await cpDb
    .select({ count: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        eq(heartbeatRuns.companyId, options.companyId),
        eq(agents.adapterType, HERMES_ADAPTER_TYPE),
        inArray(heartbeatRuns.status, Array.from(ACTIVE_HEARTBEAT_RUN_STATUSES)),
        sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) < ${options.markedAt.toISOString()}::timestamptz`,
      ),
    );

  return Number(row?.count ?? 0);
}
