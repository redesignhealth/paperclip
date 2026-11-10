import type postgres from "postgres";
import {
  INTERNAL_claimTenantFenceUnguarded,
  TENANT_FENCE_CLAIM_BOUND_MS,
  type TenantFence,
} from "./tenant-fence.js";

/**
 * Test-only / bootstrap convenience: claims the tenant fence WITHOUT the control-plane
 * admission guard. Production code (sweep.ts) must always go through
 * `claimTenantFenceGuarded`; this export exists solely so unit tests that
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
    return await INTERNAL_claimTenantFenceUnguarded(tx as any, upgradeId, leaseOwner, boundMs);
  });
}
