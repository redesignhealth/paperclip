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
 * The CP round trip to the tenant database is wall-clock bounded (`boundMs`, enforced via
 * `SET LOCAL statement_timeout` on the tenant transaction) so a stalled tenant connection
 * cannot hold the CP row lock, and therefore cannot block successor admission, indefinitely.
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
 * isolation for the tombstone path specifically.
 */

import { randomUUID } from "node:crypto";
import { companyMemoryUpgrades, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
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

const TAKEOVER_LOCK_NAMESPACE = "paperclip:memory-upgrade-fence-takeover";
const SOURCE_LOCK_NAMESPACE = "paperclip:memory-upgrade-source";

function takeoverLockKey(upgradeId: string): string {
  return `${TAKEOVER_LOCK_NAMESPACE}:${upgradeId}`;
}

function sourceLockKey(upgradeId: string, sourceId: string): string {
  return `${SOURCE_LOCK_NAMESPACE}:${upgradeId}:${sourceId}`;
}

/**
 * L0: takes the per-upgrade takeover advisory lock and unconditionally bumps fence_epoch,
 * minting a fresh lease_token. MUST only ever be invoked from inside
 * `claimTenantFenceGuarded`'s CP-validated transaction -- calling it directly reopens the
 * delayed-stale-claimant race documented above.
 */
async function claimTenantFenceUnguarded(
  tx: postgres.TransactionSql<any>,
  upgradeId: string,
  leaseOwner: string,
  boundMs: number,
): Promise<TenantFence> {
  await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(boundMs))}`);
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

  return await cpDb.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: companyMemoryUpgrades.id,
        state: companyMemoryUpgrades.state,
        leaseToken: companyMemoryUpgrades.leaseToken,
        leaseExpiresAt: companyMemoryUpgrades.leaseExpiresAt,
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

    // Bounded round trip: while this CP row lock is held, perform the tenant-side claim in
    // its own transaction (with its own server-enforced statement_timeout). A stalled tenant
    // connection fails server-side within boundMs rather than holding the CP lock forever.
    let fence: TenantFence;
    try {
      fence = await tenantSql.begin(async (ttx) => {
        return await claimTenantFenceUnguarded(ttx as any, params.upgradeId, params.leaseOwner, boundMs);
      });
    } catch (err: any) {
      if (err instanceof CompanyMemoryUpgradeError) {
        throw err;
      }
      throw new CompanyMemoryUpgradeError(
        "Tenant fence claim failed or exceeded its bounded time limit while holding control-plane admission lock",
        "LEASE_FENCED_OUT",
      );
    }

    return fence;
  });
}

/**
 * Test-only / bootstrap convenience: claims the tenant fence WITHOUT the control-plane
 * admission guard. Production code (sweep.ts) must always go through
 * `claimTenantFenceGuarded`; this export exists solely so narrower unit tests that
 * exercise ledger/staging functions in isolation (without spinning up a full
 * control-plane database) can obtain a valid fence to satisfy the required `fence`
 * parameter on commitSourceOutcome / stageSourceRecords / reconcileChangedContent /
 * reconcileTombstones.
 */
export async function claimTenantFenceForTestSetup(
  sql: postgres.Sql,
  upgradeId: string,
  leaseOwner: string = "test-owner",
  boundMs: number = TENANT_FENCE_CLAIM_BOUND_MS,
): Promise<TenantFence> {
  return await sql.begin(async (tx) => {
    return await claimTenantFenceUnguarded(tx as any, upgradeId, leaseOwner, boundMs);
  });
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
  const sorted = [...new Set(sourceIds.map((s) => s.toLowerCase()))].sort();
  for (const sourceId of sorted) {
    await acquireSourceAdvisoryLock(tx, upgradeId, sourceId);
  }
}
