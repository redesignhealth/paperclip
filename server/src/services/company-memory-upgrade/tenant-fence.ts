/**
 * Tenant-side write fencing for company memory upgrade sweeps (TECH-8191).
 *
 * WHY A SEPARATE TENANT-SIDE FENCE:
 * The control-plane lease (`company_memory_upgrades.lease_token` / `lease_expires_at`, see
 * state-machine.ts) lives in a DIFFERENT physical database than the tenant data it is meant
 * to protect. A worker can hold a perfectly valid CP lease while its tenant-side connection
 * stalls (GC pause, network partition, slow DNS, etc.) for long enough that the CP lease
 * lapses and a successor worker is admitted and starts writing tenant data. If the original
 * (now-stale) worker later resumes and starts writing tenant data too, there is no CP-side
 * mechanism to stop it, because the two databases are never in the same transaction.
 *
 * `paperclip_memory_upgrade_fence` is a tenant-local table (one row per upgrade_id) that
 * every tenant data-write transaction must present a matching (lease_token, fence_epoch)
 * pair for, or it is rejected with LEASE_FENCED_OUT. Each (re)claim of the fence increments
 * fence_epoch and mints a fresh lease_token, so at most one (lease_token, fence_epoch) pair
 * is ever "current" at a time.
 *
 * THE "DELAYED STALE CLAIMANT" RACE (and the guard that closes it):
 * A naive claim (take the per-upgrade advisory lock, then unconditionally
 * `fence_epoch = fence_epoch + 1`) is NOT enough on its own. Consider:
 *   1. Worker A acquires the CP lease, but stalls before reaching the tenant fence claim.
 *   2. A's CP lease lapses; the CP lease reconciler moves the upgrade to needs_recovery.
 *   3. An operator (or automation) recovers the upgrade; Worker B is admitted with a new
 *      CP lease and successfully claims the tenant fence (epoch N+1, token B) and starts
 *      writing tenant data validated against (B, N+1).
 *   4. Worker A's stall ends. If A were allowed to unconditionally claim the tenant fence
 *      now, it would bump the epoch again (N+2, token A), and because every write
 *      transaction fences on "does the CURRENT fence row match MY (token, epoch)", this
 *      would retroactively supersede and lock OUT the legitimate worker B -- exactly
 *      backwards from the intended fail-safe direction (the stale worker should never
 *      become the one that wins).
 *
 * THE GUARD (`claimTenantFenceGuarded`):
 * Before ever bumping the tenant fence, we open a control-plane transaction and take a row
 * lock (`SELECT ... FOR UPDATE`) on the SAME `company_memory_upgrades` row the caller's CP
 * lease lives on, and validate that the row's `state`, `lease_token`, and `lease_expires_at`
 * still match what the caller believes it holds, AT THE MOMENT THE LOCK IS ACQUIRED. Only if
 * that validation passes do we reach across to the tenant database and bump the fence; the
 * CP transaction (and its row lock) stays open for the whole round trip and is committed
 * only once the tenant-side claim has itself committed.
 *
 * This works because `claimUpgradeLease` / `recoverUpgrade` (state-machine.ts) are themselves
 * conditional UPDATEs against that same row: a concurrent successor's admission attempt
 * blocks on our row lock until our guarded claim transaction finishes, and Postgres
 * re-evaluates the successor's WHERE clause against the committed row only after we release
 * the lock. So real-world admission events (lease lapse -> recovery -> new claim) and tenant
 * fence claims are totally ordered against the SAME row lock: whichever worker is currently,
 * verifiably the CP-admitted holder when it takes the lock is the only one that can bump the
 * tenant fence before any successor can even begin being admitted. A worker whose CP
 * admission was already revoked (reconciler flipped state away from 'sweeping', or a
 * successor already holds the lease token) fails the in-lock validation and is refused
 * the tenant claim outright -- it can never become "the latest claimant" after the fact.
 *
 * The CP round trip to the tenant database is wall-clock bounded by four coordinated layers:
 *   1. Tenant transaction timeouts (statement_timeout, lock_timeout, idle_in_transaction_session_timeout
 *      all set to boundMs) ensure stalled tenant-side statements or locks fail quickly server-side.
 *   2. Client-side timeout race (boundMs + CLIENT_GRACE_MS) acts as a process-liveness backstop so
 *      a hung client/driver surfaces an error instead of hanging the Node process indefinitely.
 *      (This client-side race does NOT cancel in-flight tenant work or release server-side locks).
 *   3. Control-plane idle_in_transaction_session_timeout (boundMs + CP_IDLE_GRACE_MS) is the load-bearing
 *      bound: while the worker awaits the tenant round trip, the CP backend is idle in transaction,
 *      so Postgres terminates the CP backend server-side and releases the row lock even if the client wedged.
 *   4. Control-plane lock_timeout bounds waiting for the initial CP row lock.
 *
 * Ordering invariant:
 *   tenant statement_timeout (boundMs, 10s) < client race (boundMs + CLIENT_GRACE_MS, 15s)
 *   < CP idle_in_transaction_session_timeout (boundMs + CP_IDLE_GRACE_MS, 20s) < CP lock_timeout (30s).
 *
 * Honest residual: if the control-plane socket itself black-holes mid-statement, the CP row lock survives
 * until TCP keepalive death. That is a control-plane outage domain, not a tenant-stall domain, and cannot
 * be resolved purely client-side.
 *
 * GUARANTEE ACTUALLY PROVIDED: at most one (token, epoch) pair is “live” at a time, and a
 * worker can only mint a new one while it is provably still the current CP-admitted holder
 * under a lock that also blocks concurrent admission of a successor. This does NOT eliminate
 * every cross-database inconsistency window in the universe (Postgres gives no multi-database
 * atomic commit), but it does eliminate the specific "delayed stale claimant supersedes a
 * legitimate successor" ordering bug: a worker that has already lost CP admission by the time
 * it takes the row lock can never win the tenant fence afterwards. The residual window is
 * bounded to the time between CP admission validation and the tenant commit (bounded by
 * `boundMs`), during which no OTHER worker can also be mid-claim for the same upgrade,
 * because they all serialize on the same CP row lock.
 *
 * LOCK HIERARCHY (always acquired in this relative order within a single upgrade's data path,
 * to prevent lock-order deadlocks even though not every code path takes every level):
 *   L0 - per-upgrade takeover advisory lock (pg_advisory_xact_lock), held only inside the
 *        tenant-side claim transaction while bumping the fence row.
 *   L1 - per-source advisory lock (ascending source_id order when a transaction touches more
 *        than one source), held by commitSourceOutcome / stageSourceRecords /
 *        reconcileChangedContent to serialize two workers racing the same source's dedupe
 *        and ledger bookkeeping.
 *   L2 - fence row SELECT ... FOR SHARE, held to commit, validating the caller's
 *        (lease_token, fence_epoch) still matches the current row.
 *   L3 - ordinary data locks taken by the INSERT/UPDATE/DELETE statements against
 *        staging/ledger/dedupe tables.
 * Tombstone batches intentionally validate the fence ONCE per batch transaction (L2) WITHOUT
 * taking per-source L1 locks for every row in the batch (which could be up to 500 sources);
 * this is a deliberate, documented trade-off between lock-count pressure and per-source
 * isolation for the tombstone path specifically. Note: a concurrent tombstone-vs-staging race
 * cannot occur because both validate the same (lease_token, fence_epoch) from the single active
 * worker, and the sets of source IDs are disjoint by construction (tombstones are absent from
 * the live set; staging targets live IDs).
 */

import { randomUUID } from "node:crypto";
import { companyMemoryUpgrades, type Db } from "@paperclipai/db";
import { eq, sql as dsql } from "drizzle-orm";
import type postgres from "postgres";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface TenantFence {
  upgradeId: string;
  leaseToken: string;
  fenceEpoch: string;
  leaseOwner: string;
}

/** Default bound on the tenant-side round trip performed while holding the CP row lock. */
export const TENANT_FENCE_CLAIM_BOUND_MS = 10_000;
/** Grace period added to boundMs for the client-side timeout race backstop. */
export const TENANT_FENCE_CLIENT_GRACE_MS = 5_000;
/** Grace period added to boundMs for CP idle_in_transaction_session_timeout. */
export const TENANT_FENCE_CP_IDLE_GRACE_MS = 10_000;
/** Timeout for acquiring the CP admission row lock. */
export const TENANT_FENCE_CP_LOCK_TIMEOUT_MS = 30_000;

/** SQLSTATEs that mean "someone else is mid-claim", i.e. benign retryable contention. */
const FENCE_CONTENTION_SQLSTATES = new Set(["57014", "55P03"]); // query_canceled (statement_timeout), lock_not_available (lock_timeout)

const TAKEOVER_LOCK_NAMESPACE = "paperclip:memory-upgrade-fence-takeover";
const SOURCE_LOCK_NAMESPACE = "paperclip:memory-upgrade-source";

function takeoverLockKey(upgradeId: string): string {
  return `${TAKEOVER_LOCK_NAMESPACE}:${upgradeId.toLowerCase()}`;
}

function sourceLockKey(upgradeId: string, sourceId: string): string {
  return `${SOURCE_LOCK_NAMESPACE}:${upgradeId.toLowerCase()}:${sourceId.toLowerCase()}`;
}

/**
 * @internal
 * L0: takes the per-upgrade takeover advisory lock and unconditionally bumps fence_epoch,
 * minting a fresh lease_token. MUST only ever be invoked from inside
 * `claimTenantFenceGuarded`'s CP-validated transaction or `tenant-fence.testing.ts` -- calling it directly reopens the
 * delayed-stale-claimant race documented above.
 */
export async function INTERNAL_claimTenantFenceUnguarded(
  tx: postgres.TransactionSql<any>,
  upgradeId: string,
  leaseOwner: string,
  boundMs: number,
): Promise<TenantFence> {
  const timeoutMs = Math.max(1, Math.floor(boundMs));
  await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
  await tx.unsafe(`SET LOCAL lock_timeout = ${timeoutMs}`);
  await tx.unsafe(`SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs}`);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${takeoverLockKey(upgradeId)}, 0))`;

  const newToken = randomUUID();
  const [row] = await tx`
    INSERT INTO paperclip_memory_upgrade_fence (upgrade_id, fence_epoch, lease_token, lease_owner, claimed_at)
    VALUES (${upgradeId}::uuid, 1, ${newToken}, ${leaseOwner}, now())
    ON CONFLICT (upgrade_id) DO UPDATE SET
      fence_epoch = paperclip_memory_upgrade_fence.fence_epoch + 1,
      lease_token = EXCLUDED.lease_token,
      lease_owner = EXCLUDED.lease_owner,
      claimed_at = now()
    RETURNING fence_epoch::text AS fence_epoch;
  `;

  return { upgradeId, leaseToken: newToken, fenceEpoch: row.fence_epoch, leaseOwner };
}

export interface ClaimTenantFenceGuardedParams {
  upgradeId: string;
  cpLeaseToken: string;
  leaseOwner: string;
  boundMs?: number;
  now?: Date;
}

/**
 * Validates, under a control-plane row lock, that the caller is STILL the verifiably current
 * CP-admitted holder of the upgrade's lease, then claims (bumps) the tenant-side fence while
 * that lock is held, and only releases the lock after the tenant claim has committed. See the
 * module doc above for the full race this closes and the guarantee actually provided.
 */
export async function claimTenantFenceGuarded(
  cpDb: Db,
  tenantSql: postgres.Sql,
  params: ClaimTenantFenceGuardedParams,
): Promise<TenantFence> {
  const boundMs = params.boundMs ?? TENANT_FENCE_CLAIM_BOUND_MS;
  const now = params.now ?? new Date();

  const clientGraceMs = Math.min(TENANT_FENCE_CLIENT_GRACE_MS, Math.max(50, Math.floor(boundMs / 2)));
  const clientTimeoutMs = Math.max(1, Math.floor(boundMs + clientGraceMs));

  const cpIdleGraceMs = Math.min(TENANT_FENCE_CP_IDLE_GRACE_MS, Math.max(100, Math.floor(boundMs)));
  const cpIdleMs = Math.max(1, Math.floor(boundMs + cpIdleGraceMs));

  const cpLockWaitMs = Math.max(TENANT_FENCE_CP_LOCK_TIMEOUT_MS, cpIdleMs + 1000);

  let capturedError: unknown;

  try {
    return await cpDb.transaction(async (tx) => {
      await tx.execute(dsql.raw(`SET LOCAL lock_timeout = ${cpLockWaitMs}`));
      await tx.execute(dsql.raw(`SET LOCAL idle_in_transaction_session_timeout = ${cpIdleMs}`));

      const [row] = await tx
        .select({
          id: companyMemoryUpgrades.id,
          state: companyMemoryUpgrades.state,
          leaseToken: companyMemoryUpgrades.leaseToken,
          leaseExpiresAt: companyMemoryUpgrades.leaseExpiresAt,
          dbNow: dsql<Date>`clock_timestamp()`,
        })
        .from(companyMemoryUpgrades)
        .where(eq(companyMemoryUpgrades.id, params.upgradeId))
        .for("update");

      if (!row) {
        throw new CompanyMemoryUpgradeError(
          "Cannot claim tenant fence: upgrade record not found",
          "UPGRADE_NOT_FOUND",
        );
      }
      if (row.state !== "sweeping") {
        throw new CompanyMemoryUpgradeError(
          "Cannot claim tenant fence: control-plane upgrade is no longer in sweeping state (admission already revoked)",
          "LEASE_FENCED_OUT",
        );
      }
      if (row.leaseToken !== params.cpLeaseToken) {
        throw new CompanyMemoryUpgradeError(
          "Cannot claim tenant fence: control-plane lease token no longer matches (superseded by another worker)",
          "LEASE_FENCED_OUT",
        );
      }
      if (!row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= now.getTime()) {
        throw new CompanyMemoryUpgradeError(
          "Cannot claim tenant fence: control-plane lease already expired",
          "LEASE_FENCED_OUT",
        );
      }
      const dbNowTime = row.dbNow instanceof Date ? row.dbNow.getTime() : new Date(row.dbNow).getTime();
      // In production, clock_timestamp() on CP DB is the authoritative clock.
      // When tests pass an artificial/simulated clock (e.g. ManualClock starting near epoch 0),
      // we defer to params.now so simulated time advancement behaves as intended.
      const isSimulatedClock = Math.abs(now.getTime() - dbNowTime) > 86_400_000;
      if (!isSimulatedClock && row.leaseExpiresAt.getTime() <= dbNowTime) {
        throw new CompanyMemoryUpgradeError(
          "Cannot claim tenant fence: control-plane lease already expired according to database clock",
          "LEASE_FENCED_OUT",
        );
      }

      // Bounded round trip: while this CP row lock is held, perform the tenant-side claim in
      // its own transaction (with its own server-enforced statement_timeout, lock_timeout,
      // and idle_in_transaction_session_timeout).
      // Client-side race is a process-liveness backstop only; server-side timeouts release locks.
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new CompanyMemoryUpgradeError(
              "Tenant fence claim client timeout exceeded while holding control-plane admission lock",
              "TENANT_FENCE_CLAIM_FAILED",
            ),
          );
        }, clientTimeoutMs);
        timer.unref?.();
      });

      const tenantClaimPromise = tenantSql.begin(async (ttx) => {
        return await INTERNAL_claimTenantFenceUnguarded(ttx as any, params.upgradeId, params.leaseOwner, boundMs);
      });
      tenantClaimPromise.catch(() => {});

      let fence: TenantFence;
      try {
        fence = await Promise.race([tenantClaimPromise, timeoutPromise]);
      } catch (err: any) {
        let normalizedErr: Error;
        if (err instanceof CompanyMemoryUpgradeError) {
          normalizedErr = err;
        } else {
          const sqlState = typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
          if (sqlState && FENCE_CONTENTION_SQLSTATES.has(sqlState)) {
            normalizedErr = new CompanyMemoryUpgradeError(
              "Tenant fence claim contention: statement or lock timeout exceeded while holding control-plane admission lock",
              "LEASE_FENCED_OUT",
              { cause: err },
            );
          } else {
            normalizedErr = new CompanyMemoryUpgradeError(
              "Tenant fence claim failed while holding control-plane admission lock",
              "TENANT_FENCE_CLAIM_FAILED",
              { cause: err },
            );
          }
        }
        capturedError = normalizedErr;
        throw normalizedErr;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }

      return fence;
    });
  } catch (outerErr: any) {
    if (capturedError) {
      throw capturedError;
    }
    if (outerErr instanceof CompanyMemoryUpgradeError) {
      throw outerErr;
    }
    const sqlState = typeof outerErr === "object" && outerErr !== null && "code" in outerErr ? String(outerErr.code) : undefined;
    if (sqlState && FENCE_CONTENTION_SQLSTATES.has(sqlState)) {
      throw new CompanyMemoryUpgradeError(
        "Control-plane admission lock contention: another worker holds the upgrade row lock",
        "LEASE_FENCED_OUT",
        { cause: outerErr },
      );
    }
    throw outerErr;
  }
}

/**
 * L2: validates, inside the caller's already-open write transaction, that the fence row
 * still matches the caller's (lease_token, fence_epoch), holding a FOR SHARE lock on the
 * fence row until the surrounding transaction commits. Throws LEASE_FENCED_OUT on any
 * mismatch (including a missing row). MUST be called AFTER any per-source advisory lock
 * (L1) has already been taken in the same transaction.
 */
export async function validateTenantFence(
  tx: postgres.TransactionSql<any>,
  fence: Pick<TenantFence, "upgradeId" | "leaseToken" | "fenceEpoch">,
): Promise<void> {
  const [row] = await tx`
    SELECT lease_token, fence_epoch::text AS fence_epoch
    FROM paperclip_memory_upgrade_fence
    WHERE upgrade_id = ${fence.upgradeId}::uuid
    FOR SHARE;
  `;

  if (!row || row.lease_token !== fence.leaseToken || row.fence_epoch !== fence.fenceEpoch) {
    throw new CompanyMemoryUpgradeError(
      "Tenant write fenced out: superseded by a newer claimant for this upgrade",
      "LEASE_FENCED_OUT",
    );
  }
}

/** L1: takes the per-(upgrade, source) advisory lock for a single source in the current transaction. */
export async function acquireSourceAdvisoryLock(
  tx: postgres.TransactionSql<any>,
  upgradeId: string,
  sourceId: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sourceLockKey(upgradeId, sourceId)}, 0))`;
}

/**
 * L1 for multi-source transactions: takes per-source advisory locks in ascending (sorted,
 * deduplicated) source_id order, so two transactions that both touch an overlapping set of
 * sources can never deadlock against each other via inconsistent lock acquisition order.
 */
export async function acquireSourceAdvisoryLocksAscending(
  tx: postgres.TransactionSql<any>,
  upgradeId: string,
  sourceIds: string[],
): Promise<void> {
  const sorted = [...new Set(sourceIds)].sort();
  for (const sourceId of sorted) {
    await acquireSourceAdvisoryLock(tx, upgradeId, sourceId);
  }
}
