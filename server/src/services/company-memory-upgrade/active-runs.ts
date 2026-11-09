/**
 * Active run gating for company memory upgrade sweep (TECH-8191).
 *
 * Prevents concurrent load and data mutation skew by pausing sweep operations
 * while the company has in-flight or queued heartbeat runs.
 */

import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  createSystemClock,
  createSystemSleeper,
  type MonotonicClock,
  type Sleeper,
} from "./clock.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export const ACTIVE_HEARTBEAT_RUN_STATUSES = [
  "queued",
  "scheduled_retry",
  "running",
] as const;

export type ActiveHeartbeatRunStatus = (typeof ACTIVE_HEARTBEAT_RUN_STATUSES)[number];

/**
 * Counts the active heartbeat runs for a company on the control-plane database.
 */
export async function countActiveCompanyRuns(
  db: Db,
  companyId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, Array.from(ACTIVE_HEARTBEAT_RUN_STATUSES)),
      ),
    );

  return row?.count ?? 0;
}

export interface CreateActiveRunGateOptions {
  db: Db;
  companyId: string;
  threshold: number;
  pollMs?: number;
  maxPauseMs?: number;
  clock?: MonotonicClock;
  sleeper?: Sleeper;
  onPause?: (activeCount: number) => void;
  onResume?: () => void;
  assertLeaseActive?: () => void;
}

export interface ActiveRunGateStats {
  pauseCount: number;
  totalPausedMs: number;
}

export interface ActiveRunGate {
  waitUntilQuiet(): Promise<void>;
  stats(): ActiveRunGateStats;
}

/**
 * Creates an active run gate that pauses callers when active runs >= threshold.
 * Threshold <= 0 disables the gate.
 */
export function createActiveRunGate(
  options: CreateActiveRunGateOptions,
): ActiveRunGate {
  const {
    db,
    companyId,
    threshold,
    pollMs = 15_000,
    maxPauseMs = 0,
    clock = createSystemClock(),
    sleeper = createSystemSleeper(),
    onPause,
    onResume,
    assertLeaseActive,
  } = options;

  let pauseCount = 0;
  let totalPausedMs = 0;
  let lastCheckMs = -Infinity;

  return {
    async waitUntilQuiet(): Promise<void> {
      if (threshold <= 0) {
        return;
      }

      assertLeaseActive?.();

      const now = clock.nowMs();
      if (now - lastCheckMs < pollMs) {
        return;
      }

      let active = await countActiveCompanyRuns(db, companyId);
      lastCheckMs = clock.nowMs();

      if (active < threshold) {
        return;
      }

      // Enter pause state
      pauseCount++;
      onPause?.(active);
      const pauseStartMs = clock.nowMs();

      while (active >= threshold) {
        const currentMs = clock.nowMs();
        const cumulativePausedMs = totalPausedMs + (currentMs - pauseStartMs);

        if (maxPauseMs > 0 && cumulativePausedMs >= maxPauseMs) {
          // Re-poll before declaring paused_too_long
          active = await countActiveCompanyRuns(db, companyId);
          lastCheckMs = clock.nowMs();
          if (active < threshold) {
            break;
          }
          totalPausedMs += (clock.nowMs() - pauseStartMs);
          throw new CompanyMemoryUpgradeError(
            `Active heartbeat runs paused longer than limit (${cumulativePausedMs}ms >= maxPauseMs ${maxPauseMs}ms)`,
            "paused_too_long",
          );
        }

        const remainingBudgetMs = maxPauseMs > 0 ? maxPauseMs - cumulativePausedMs : Infinity;
        const stepMs = Math.min(5000, pollMs, Math.max(1, remainingBudgetMs));

        await sleeper.sleep(stepMs);
        assertLeaseActive?.();

        const afterSleepMs = clock.nowMs();
        const newCumulative = totalPausedMs + (afterSleepMs - pauseStartMs);
        const shouldPoll =
          afterSleepMs - lastCheckMs >= pollMs ||
          (maxPauseMs > 0 && newCumulative >= maxPauseMs);

        if (shouldPoll) {
          active = await countActiveCompanyRuns(db, companyId);
          lastCheckMs = clock.nowMs();
        }
      }

      totalPausedMs += clock.nowMs() - pauseStartMs;
      onResume?.();
    },

    stats(): ActiveRunGateStats {
      return {
        pauseCount,
        totalPausedMs,
      };
    },
  };
}
