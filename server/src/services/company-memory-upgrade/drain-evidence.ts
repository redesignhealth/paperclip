/**
 * Pure evaluation function for company memory upgrade drain evidence (TECH-8191 §Q1, §Q3, PR5.7).
 */

import type { BlockingRun } from "./drain-runs.js";
import type { DrainProbeResult } from "./drain-probe.js";

export const DEFAULT_MIN_STREAK_MS = 10 * 60 * 1000; // 10 minutes

export interface EvaluateDrainEvidenceParams {
  probe: Pick<DrainProbeResult, "blockingSources"> & Partial<Pick<DrainProbeResult, "missingScopeBlockingSources">>;
  blockingRuns: Array<Pick<BlockingRun, "id">>;
  agentScopeObservedAt: Date | null | undefined;
  markedAt: Date;
  streakStartedAt: Date | null | undefined;
  leaseHeldByOther: boolean;
  now: Date;
  minStreakMs?: number;
}

export interface DrainEvidenceDecision {
  counts: boolean;
  nextStreakStartedAt: Date | null;
  confirmed: boolean;
  blockedBy: string[];
}

export function evaluateDrainEvidence(
  params: EvaluateDrainEvidenceParams,
): DrainEvidenceDecision {
  const {
    probe,
    blockingRuns,
    agentScopeObservedAt,
    markedAt,
    streakStartedAt,
    leaseHeldByOther,
    now,
    minStreakMs = DEFAULT_MIN_STREAK_MS,
  } = params;

  const blockedBy: string[] = [];

  const blockingSources = Number(probe.blockingSources ?? 0);
  const missingScopeSources = Number(probe.missingScopeBlockingSources ?? 0);

  if (blockingSources > 0) {
    blockedBy.push("blocking_sources");
  }
  if (missingScopeSources > 0) {
    // In drain.ts, missingScopeSources > 0 triggers an immediate DRAIN_BLOCKED_MISSING_SCOPE error
    // before evaluateDrainEvidence is reached. We keep this branch in place so evaluateDrainEvidence
    // remains correct as a pure function for any other caller.
    blockedBy.push("missing_scope_blocking_sources");
  }

  if (blockingRuns.length > 0) {
    blockedBy.push("blocking_runs");
  }

  const markedAtMs = markedAt instanceof Date ? markedAt.getTime() : new Date(markedAt).getTime();
  const observedAtMs = agentScopeObservedAt
    ? (agentScopeObservedAt instanceof Date ? agentScopeObservedAt.getTime() : new Date(agentScopeObservedAt).getTime())
    : null;

  if (observedAtMs === null || observedAtMs <= markedAtMs) {
    blockedBy.push("agent_scope_not_observed");
  }

  if (leaseHeldByOther) {
    blockedBy.push("a sweep or publish is in flight");
  }

  const isQuiescent = blockedBy.length === 0;

  if (!isQuiescent) {
    return {
      counts: false,
      nextStreakStartedAt: null,
      confirmed: false,
      blockedBy,
    };
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  if (!streakStartedAt) {
    return {
      counts: false,
      nextStreakStartedAt: now instanceof Date ? now : new Date(now),
      confirmed: false,
      blockedBy: [],
    };
  }

  const streakStartMs = streakStartedAt instanceof Date
    ? streakStartedAt.getTime()
    : new Date(streakStartedAt).getTime();

  const elapsedMs = nowMs - streakStartMs;
  const normalizedStreakStart = streakStartedAt instanceof Date ? streakStartedAt : new Date(streakStartedAt);

  if (elapsedMs >= minStreakMs) {
    return {
      counts: true,
      nextStreakStartedAt: normalizedStreakStart,
      confirmed: true,
      blockedBy: [],
    };
  }

  return {
    counts: false,
    nextStreakStartedAt: normalizedStreakStart,
    confirmed: false,
    blockedBy: [],
  };
}
