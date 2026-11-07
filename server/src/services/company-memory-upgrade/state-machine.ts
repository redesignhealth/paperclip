import { randomUUID } from "node:crypto";
import {
  companyMemoryUpgrades,
  type Db,
  type UpgradeState,
} from "@paperclipai/db";
import { and, eq, gt, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type {
  ClaimLeaseParams,
  ClaimLeaseResult,
  Clock,
  CompanyMemoryUpgradeRow,
  LeaseHeartbeatHandle,
  OpenUpgradeParams,
  UpdateCountersParams,
} from "./types.js";

export const DEFAULT_LEASE_TTL_MS = 600_000; // 10 minutes
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 120_000; // 2 minutes

export class CompanyMemoryUpgradeError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CompanyMemoryUpgradeError";
    this.code = code;
  }
}

/**
 * Total state transition rules for live Mem0 company memory upgrades.
 *
 * Direct transitions:
 * - sweeping       -> flipping | aborted
 * - flipping       -> draining | sweeping
 * - draining       -> verified | rolled_back
 * - verified       -> pruning  | rolled_back
 * - pruning        -> completed
 *
 * Terminal states (no outgoing transitions):
 * - completed, rolled_back, aborted
 *
 * Stalling / Lease lapse:
 * - Active states (sweeping, flipping, draining, verified, pruning) -> needs_recovery
 *
 * Recovery:
 * - needs_recovery -> prior state (recorded in recover_to_state)
 *
 * Invariant:
 * - Rollback is strictly refused at/after 'pruning' (hard error).
 */
export const VALID_TRANSITIONS: Readonly<Record<UpgradeState, ReadonlySet<UpgradeState>>> = {
  sweeping: new Set(["flipping", "aborted", "needs_recovery"]),
  flipping: new Set(["draining", "sweeping", "needs_recovery"]),
  draining: new Set(["verified", "rolled_back", "needs_recovery"]),
  verified: new Set(["pruning", "rolled_back", "needs_recovery"]),
  pruning: new Set(["completed", "needs_recovery"]),
  completed: new Set([]),
  rolled_back: new Set([]),
  aborted: new Set([]),
  needs_recovery: new Set(["sweeping", "flipping", "draining", "verified", "pruning"]),
};

export const ACTIVE_PRE_LAPSE_STATES: ReadonlySet<UpgradeState> = new Set([
  "sweeping",
  "flipping",
  "draining",
  "verified",
  "pruning",
]);

export function isValidTransition(
  from: UpgradeState,
  to: UpgradeState,
  recoverToState?: UpgradeState | null,
): boolean {
  if (to === "rolled_back" && (from === "pruning" || from === "completed")) {
    return false;
  }
  if (from === "needs_recovery" && recoverToState !== undefined && recoverToState !== null) {
    return to === recoverToState;
  }
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertValidTransition(
  from: UpgradeState,
  to: UpgradeState,
  recoverToState?: UpgradeState | null,
): void {
  if (to === "rolled_back" && (from === "pruning" || from === "completed")) {
    throw new CompanyMemoryUpgradeError(
      `Rollback refused: cannot roll back upgrade from state "${from}"`,
      "ROLLBACK_REFUSED",
    );
  }

  if (from === "needs_recovery" && recoverToState !== undefined && recoverToState !== null) {
    if (to !== recoverToState) {
      throw new CompanyMemoryUpgradeError(
        `Illegal state transition: recovery from "needs_recovery" must transition to recorded prior state "${recoverToState}", not "${to}"`,
        "ILLEGAL_TRANSITION",
      );
    }
    return;
  }

  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new CompanyMemoryUpgradeError(
      `Illegal state transition from "${from}" to "${to}"`,
      "ILLEGAL_TRANSITION",
    );
  }
}

/**
 * Inserts a new memory upgrade record in 'sweeping' state.
 * The partial unique index enforces at most one active upgrade per company.
 */
export async function openUpgrade(
  db: Db,
  params: OpenUpgradeParams,
  options?: { clock?: Clock },
): Promise<CompanyMemoryUpgradeRow> {
  const now = options?.clock?.now() ?? new Date();
  try {
    const [inserted] = await db
      .insert(companyMemoryUpgrades)
      .values({
        companyId: params.companyId,
        state: "sweeping",
        converterId: params.converterId,
        converterVersion: params.converterVersion,
        collectionName: params.collectionName,
        embeddingModel: params.embeddingModel,
        embeddingDimensions: params.embeddingDimensions,
        operatorLabel: params.operatorLabel ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return inserted;
  } catch (error: any) {
    const cause = error?.cause ?? error;
    if (
      cause?.code === "23505" ||
      cause?.constraint === "company_memory_upgrades_active_uq" ||
      cause?.constraint_name === "company_memory_upgrades_active_uq" ||
      String(error?.message).includes("company_memory_upgrades_active_uq") ||
      String(cause?.message).includes("company_memory_upgrades_active_uq")
    ) {
      throw new CompanyMemoryUpgradeError(
        `An active memory upgrade is already in progress for company ${params.companyId}`,
        "ACTIVE_UPGRADE_EXISTS",
      );
    }
    throw error;
  }
}

/**
 * Claims or re-claims an unassigned or expired lease on an active upgrade record.
 */
export async function claimUpgradeLease(
  db: Db,
  params: ClaimLeaseParams,
): Promise<ClaimLeaseResult> {
  const now = params.now ?? new Date();
  const ttlMs = params.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const newToken = randomUUID();

  const [claimed] = await db
    .update(companyMemoryUpgrades)
    .set({
      leaseToken: newToken,
      leaseOwner: params.leaseOwner,
      leaseAcquiredAt: now,
      leaseExpiresAt: expiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(companyMemoryUpgrades.id, params.upgradeId),
        or(
          isNull(companyMemoryUpgrades.leaseExpiresAt),
          lte(companyMemoryUpgrades.leaseExpiresAt, now),
        ),
        notInArray(companyMemoryUpgrades.state, [
          "completed",
          "aborted",
          "rolled_back",
          "needs_recovery",
        ]),
      ),
    )
    .returning();

  if (!claimed) {
    return { acquired: false };
  }

  return {
    acquired: true,
    leaseToken: newToken,
    leaseOwner: params.leaseOwner,
    leaseAcquiredAt: now,
    leaseExpiresAt: expiresAt,
    upgrade: claimed,
  };
}

/**
 * Renews an existing valid lease on an upgrade record.
 */
export async function renewUpgradeLease(
  db: Db,
  id: string,
  leaseToken: string,
  options?: {
    ttlMs?: number;
    clock?: Clock;
  },
): Promise<{ renewed: boolean; expiresAt?: Date }> {
  const now = options?.clock?.now() ?? new Date();
  const ttlMs = options?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const newExpires = new Date(now.getTime() + ttlMs);

  const [renewed] = await db
    .update(companyMemoryUpgrades)
    .set({
      leaseExpiresAt: newExpires,
      updatedAt: now,
    })
    .where(
      and(
        eq(companyMemoryUpgrades.id, id),
        eq(companyMemoryUpgrades.leaseToken, leaseToken),
        gt(companyMemoryUpgrades.leaseExpiresAt, now),
      ),
    )
    .returning({ id: companyMemoryUpgrades.id });

  if (!renewed) {
    return { renewed: false };
  }

  return { renewed: true, expiresAt: newExpires };
}

/**
 * Starts a background heartbeat timer to periodically renew the upgrade lease.
 */
export function startLeaseHeartbeat(
  db: Db,
  id: string,
  leaseToken: string,
  options?: {
    initialExpiresAt?: Date | number;
    intervalMs?: number;
    ttlMs?: number;
    onLost?: () => void;
  },
): LeaseHeartbeatHandle {
  const intervalMs = options?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const ttlMs = options?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  let lost = false;
  let running = true;
  let activeRenewal: Promise<void> | null = null;
  let knownExpiresAtMs: number =
    options?.initialExpiresAt instanceof Date
      ? options.initialExpiresAt.getTime()
      : typeof options?.initialExpiresAt === "number"
      ? options.initialExpiresAt
      : Date.now() + ttlMs;

  async function performRenewal(): Promise<void> {
    if (!running || lost) return;
    try {
      const res = await renewUpgradeLease(db, id, leaseToken, { ttlMs });
      if (!res.renewed || !res.expiresAt) {
        lost = true;
        options?.onLost?.();
      } else {
        knownExpiresAtMs = res.expiresAt.getTime();
      }
    } catch {
      // Fail closed
      lost = true;
      options?.onLost?.();
    }
  }

  const timer = setInterval(() => {
    if (activeRenewal) return;
    activeRenewal = performRenewal().finally(() => {
      activeRenewal = null;
    });
  }, intervalMs);
  timer.unref?.();

  return {
    isLost: () => lost || Date.now() >= knownExpiresAtMs,
    getKnownExpiresAtMs: () => knownExpiresAtMs,
    assertActive: () => {
      if (lost || Date.now() >= knownExpiresAtMs) {
        lost = true;
        throw new CompanyMemoryUpgradeError(
          "Upgrade lease lost or expired during operation",
          "LEASE_FENCED_OUT",
        );
      }
    },
    stop: async () => {
      running = false;
      clearInterval(timer);
      if (activeRenewal) {
        await activeRenewal.catch(() => {});
      }
    },
  };
}

/**
 * Advances the state of an upgrade row under lease fencing.
 */
export async function advanceState(
  db: Db,
  id: string,
  leaseToken: string,
  from: UpgradeState,
  to: UpgradeState,
  options?: {
    clock?: Clock;
    lastError?: string | null;
  },
): Promise<CompanyMemoryUpgradeRow> {
  assertValidTransition(from, to);

  const now = options?.clock?.now() ?? new Date();

  const [updated] = await db
    .update(companyMemoryUpgrades)
    .set({
      state: to,
      updatedAt: now,
      ...(to === "completed" ? { completedAt: now } : {}),
      ...(to === "rolled_back" ? { rolledBackAt: now } : {}),
      ...(to === "verified" ? { verifiedAt: now } : {}),
      ...(to === "pruning" ? { prunedAt: now } : {}),
      ...(options?.lastError !== undefined ? { lastError: options.lastError } : {}),
    })
    .where(
      and(
        eq(companyMemoryUpgrades.id, id),
        eq(companyMemoryUpgrades.leaseToken, leaseToken),
        eq(companyMemoryUpgrades.state, from),
        gt(companyMemoryUpgrades.leaseExpiresAt, now),
      ),
    )
    .returning();

  if (!updated) {
    const [existing] = await db
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, id));

    if (!existing) {
      throw new CompanyMemoryUpgradeError(`Upgrade ${id} not found`, "UPGRADE_NOT_FOUND");
    }
    if (existing.state !== from) {
      throw new CompanyMemoryUpgradeError(
        `State mismatch for upgrade ${id}: expected "${from}", found "${existing.state}"`,
        "STATE_MISMATCH",
      );
    }
    if (existing.leaseToken !== leaseToken) {
      throw new CompanyMemoryUpgradeError(
        `Lease token mismatch for upgrade ${id}`,
        "LEASE_FENCED_OUT",
      );
    }
    if (existing.leaseExpiresAt && existing.leaseExpiresAt <= now) {
      throw new CompanyMemoryUpgradeError(
        `Lease expired for upgrade ${id}`,
        "LEASE_EXPIRED",
      );
    }
    throw new CompanyMemoryUpgradeError(
      `Failed to advance state for upgrade ${id}`,
      "CAS_FAILED",
    );
  }

  return updated;
}

/**
 * Transitions an active upgrade whose lease lapsed into 'needs_recovery',
 * recording its prior state in `recover_to_state` and releasing the lease.
 */
export async function failUpgradeLeaseLapse(
  db: Db,
  id: string,
  options?: { clock?: Clock },
): Promise<CompanyMemoryUpgradeRow | null> {
  const now = options?.clock?.now() ?? new Date();

  const [lapsed] = await db
    .update(companyMemoryUpgrades)
    .set({
      state: "needs_recovery",
      recoverToState: sql`${companyMemoryUpgrades.state}`,
      leaseToken: null,
      leaseOwner: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
      lastError: "Lease lapsed during operation",
    })
    .where(
      and(
        eq(companyMemoryUpgrades.id, id),
        lte(companyMemoryUpgrades.leaseExpiresAt, now),
        inArray(companyMemoryUpgrades.state, [
          "sweeping",
          "flipping",
          "draining",
          "verified",
          "pruning",
        ]),
      ),
    )
    .returning();

  return lapsed ?? null;
}

/**
 * Scans all active upgrades with expired leases and moves them to 'needs_recovery'.
 */
export async function reconcileLapsedUpgradeLeases(
  db: Db,
  options?: { clock?: Clock },
): Promise<number> {
  const now = options?.clock?.now() ?? new Date();

  const rows = await db
    .update(companyMemoryUpgrades)
    .set({
      state: "needs_recovery",
      recoverToState: sql`${companyMemoryUpgrades.state}`,
      leaseToken: null,
      leaseOwner: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
      lastError: "Lease lapsed during operation",
    })
    .where(
      and(
        lte(companyMemoryUpgrades.leaseExpiresAt, now),
        inArray(companyMemoryUpgrades.state, [
          "sweeping",
          "flipping",
          "draining",
          "verified",
          "pruning",
        ]),
      ),
    )
    .returning({ id: companyMemoryUpgrades.id });

  return rows.length;
}

/**
 * Recovers an upgrade from 'needs_recovery' back to its recorded prior state,
 * minting a new lease for the recovering owner.
 */
export async function recoverUpgrade(
  db: Db,
  id: string,
  newOwner: string,
  options?: {
    ttlMs?: number;
    clock?: Clock;
  },
): Promise<CompanyMemoryUpgradeRow> {
  const [existing] = await db
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.id, id));

  if (!existing) {
    throw new CompanyMemoryUpgradeError(`Upgrade ${id} not found`, "UPGRADE_NOT_FOUND");
  }

  if (existing.state !== "needs_recovery") {
    throw new CompanyMemoryUpgradeError(
      `Cannot recover upgrade ${id}: current state is "${existing.state}", expected "needs_recovery"`,
      "INVALID_RECOVERY",
    );
  }

  const priorState = existing.recoverToState as UpgradeState | null;
  if (!priorState || !ACTIVE_PRE_LAPSE_STATES.has(priorState)) {
    throw new CompanyMemoryUpgradeError(
      `Cannot recover upgrade ${id}: invalid or missing recover_to_state "${existing.recoverToState}"`,
      "INVALID_RECOVERY",
    );
  }

  assertValidTransition("needs_recovery", priorState, priorState);

  const now = options?.clock?.now() ?? new Date();
  const ttlMs = options?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const newToken = randomUUID();

  const [recovered] = await db
    .update(companyMemoryUpgrades)
    .set({
      state: priorState,
      recoverToState: null,
      leaseToken: newToken,
      leaseOwner: newOwner,
      leaseAcquiredAt: now,
      leaseExpiresAt: expiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(companyMemoryUpgrades.id, id),
        eq(companyMemoryUpgrades.state, "needs_recovery"),
      ),
    )
    .returning();

  if (!recovered) {
    throw new CompanyMemoryUpgradeError(
      `Concurrent recovery conflict for upgrade ${id}`,
      "CAS_FAILED",
    );
  }

  return recovered;
}

/**
 * Atomically increments counters and updates timestamps for an in-flight upgrade under lease fencing.
 */
export async function updateUpgradeCounters(
  db: Db,
  id: string,
  leaseToken: string,
  params: UpdateCountersParams,
  options?: { clock?: Clock },
): Promise<CompanyMemoryUpgradeRow> {
  const now = options?.clock?.now() ?? new Date();

  const setFields: Record<string, unknown> = {
    updatedAt: now,
  };

  if (params.sweepCount) {
    setFields.sweepCount = sql`${companyMemoryUpgrades.sweepCount} + ${params.sweepCount}`;
  }
  if (params.sourceSeenCount) {
    setFields.sourceSeenCount = sql`${companyMemoryUpgrades.sourceSeenCount} + ${params.sourceSeenCount}`;
  }
  if (params.publishedCount) {
    setFields.publishedCount = sql`${companyMemoryUpgrades.publishedCount} + ${params.publishedCount}`;
  }
  if (params.droppedNoiseCount) {
    setFields.droppedNoiseCount = sql`${companyMemoryUpgrades.droppedNoiseCount} + ${params.droppedNoiseCount}`;
  }
  if (params.droppedSensitiveCount) {
    setFields.droppedSensitiveCount = sql`${companyMemoryUpgrades.droppedSensitiveCount} + ${params.droppedSensitiveCount}`;
  }
  if (params.deduplicatedCount) {
    setFields.deduplicatedCount = sql`${companyMemoryUpgrades.deduplicatedCount} + ${params.deduplicatedCount}`;
  }
  if (params.unroutableCount) {
    setFields.unroutableCount = sql`${companyMemoryUpgrades.unroutableCount} + ${params.unroutableCount}`;
  }
  if (params.quarantinedCount) {
    setFields.quarantinedCount = sql`${companyMemoryUpgrades.quarantinedCount} + ${params.quarantinedCount}`;
  }
  if (params.supersededCount) {
    setFields.supersededCount = sql`${companyMemoryUpgrades.supersededCount} + ${params.supersededCount}`;
  }
  if (params.sourceDeletedCount) {
    setFields.sourceDeletedCount = sql`${companyMemoryUpgrades.sourceDeletedCount} + ${params.sourceDeletedCount}`;
  }

  if (params.llmInputTokens) {
    setFields.llmInputTokens = sql`${companyMemoryUpgrades.llmInputTokens} + ${params.llmInputTokens}`;
  }
  if (params.llmOutputTokens) {
    setFields.llmOutputTokens = sql`${companyMemoryUpgrades.llmOutputTokens} + ${params.llmOutputTokens}`;
  }
  if (params.embeddingTokens) {
    setFields.embeddingTokens = sql`${companyMemoryUpgrades.embeddingTokens} + ${params.embeddingTokens}`;
  }
  if (params.estimatedCostNanodollars) {
    setFields.estimatedCostNanodollars = sql`${companyMemoryUpgrades.estimatedCostNanodollars} + ${params.estimatedCostNanodollars}`;
  }

  if (params.markedAt !== undefined) {
    setFields.markedAt = params.markedAt;
  }
  if (params.drainConfirmedAt !== undefined) {
    setFields.drainConfirmedAt = params.drainConfirmedAt;
  }
  if (params.verifiedAt !== undefined) {
    setFields.verifiedAt = params.verifiedAt;
  }
  if (params.prunedAt !== undefined) {
    setFields.prunedAt = params.prunedAt;
  }
  if (params.rolledBackAt !== undefined) {
    setFields.rolledBackAt = params.rolledBackAt;
  }
  if (params.completedAt !== undefined) {
    setFields.completedAt = params.completedAt;
  }
  if (params.lastError !== undefined) {
    setFields.lastError = params.lastError;
  }

  const [updated] = await db
    .update(companyMemoryUpgrades)
    .set(setFields)
    .where(
      and(
        eq(companyMemoryUpgrades.id, id),
        eq(companyMemoryUpgrades.leaseToken, leaseToken),
        gt(companyMemoryUpgrades.leaseExpiresAt, now),
      ),
    )
    .returning();

  if (!updated) {
    const [existing] = await db
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.id, id));

    if (!existing) {
      throw new CompanyMemoryUpgradeError(`Upgrade ${id} not found`, "UPGRADE_NOT_FOUND");
    }
    if (existing.leaseToken !== leaseToken) {
      throw new CompanyMemoryUpgradeError(
        `Lease token mismatch for upgrade ${id}`,
        "LEASE_FENCED_OUT",
      );
    }
    if (existing.leaseExpiresAt && existing.leaseExpiresAt <= now) {
      throw new CompanyMemoryUpgradeError(
        `Lease expired for upgrade ${id}`,
        "LEASE_EXPIRED",
      );
    }
    throw new CompanyMemoryUpgradeError(
      `Failed to update counters for upgrade ${id}`,
      "CAS_FAILED",
    );
  }

  return updated;
}
