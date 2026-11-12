/**
 * Precondition verification for company memory upgrade flip (TECH-8191 §Q2 P4–P8, PR5.6).
 */

import type postgres from "postgres";
import type { CpAgentRow } from "./agent-routing.js";
import { CONVERTER_ID, CONVERTER_VERSION } from "./converter-version.js";
import {
  countPublishPending,
  type PublishPendingResult,
} from "./drain-probe-preflight.js";
import {
  runDrainProbe,
  type DrainProbeResult,
} from "./drain-probe.js";
import type { ScopeMigrationMarker } from "./scope-marker.js";
import {
  CompanyMemoryUpgradeError,
  type CompanyMemoryUpgradeRow,
} from "./types.js";

export { countPublishPending, type PublishPendingResult };

export interface AssertFlipPreconditionsParams {
  upgrade: CompanyMemoryUpgradeRow;
  marker: ScopeMigrationMarker | null;
  tenantSql: postgres.Sql;
  tableName: string;
  cpAgentMap: Map<string, CpAgentRow>;
  probeLimit?: number;
  mode?: string;
}

export interface FlipPreconditionsResult {
  pending: PublishPendingResult;
  probe: DrainProbeResult;
}

/**
 * Asserts flip preconditions P4–P8 prior to claiming the upgrade lease or mutating state.
 *
 * Checks:
 * - P4: State is 'sweeping' or 'flipping' (STATE_MISMATCH)
 * - P5: Converter contract and collection match pinned constants (CONVERTER_CONTRACT_MISMATCH)
 * - P8: Marker is not already set while in 'sweeping' state (FLIP_PRECONDITION_FAILED)
 * - P6: Staging has 0 pending publishable rows, excluding quarantined (FLIP_PRECONDITION_FAILED)
 * - P7: Drain probe finds 0 blocking sources (FLIP_PRECONDITION_FAILED)
 */
export async function assertFlipPreconditions(
  params: AssertFlipPreconditionsParams,
): Promise<FlipPreconditionsResult> {
  const { upgrade, marker, tenantSql, tableName, cpAgentMap, probeLimit } = params;

  // P4: State check
  if (upgrade.state !== "sweeping" && upgrade.state !== "flipping") {
    throw new CompanyMemoryUpgradeError(
      "Cannot run flip: active upgrade is not in sweeping or flipping state.",
      "STATE_MISMATCH",
    );
  }

  // P5: Converter contract and collection name match
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

  // P8: Scope migration marker not set out-of-band while in sweeping state
  if (marker?.completedAt != null && upgrade.state === "sweeping") {
    throw new CompanyMemoryUpgradeError(
      "Flip refused before changing anything: staged rows are still unpublished, or a sweep would still find new or changed company-scoped memories. Run 'pnpm memory:upgrade publish' and 'pnpm memory:upgrade sweep' until both are clean, then retry. Nothing was flipped.",
      "FLIP_PRECONDITION_FAILED",
    );
  }

  // Resumed flip: if marker already exists while state is flipping, require stored mode to equal requested mode
  const expectedMode = params.mode ?? "copy";
  if (marker?.completedAt != null && upgrade.state === "flipping") {
    if (!marker.mode || marker.mode !== expectedMode) {
      throw new CompanyMemoryUpgradeError(
        `Existing scope migration marker mode mismatch: expected '${expectedMode}', found '${marker.mode ?? "null"}'`,
        "FLIP_PRECONDITION_FAILED",
      );
    }
  }

  // P6: Staging publish pending == 0 (excluding quarantined)
  const pending = await countPublishPending(tenantSql, upgrade.id);
  if (pending.pendingRows > 0) {
    throw new CompanyMemoryUpgradeError(
      "Flip refused before changing anything: staged rows are still unpublished, or a sweep would still find new or changed company-scoped memories. Run 'pnpm memory:upgrade publish' and 'pnpm memory:upgrade sweep' until both are clean, then retry. Nothing was flipped.",
      "FLIP_PRECONDITION_FAILED",
    );
  }

  // P7: Drain probe finds 0 blocking sources
  const probe = await runDrainProbe(tenantSql, {
    upgradeId: upgrade.id,
    tableName,
    cpAgentMap,
    limit: probeLimit,
  });

  if (probe.blockingSources > 0 || probe.missingScopeBlockingSources > 0) {
    throw new CompanyMemoryUpgradeError(
      "Flip refused before changing anything: staged rows are still unpublished, or a sweep would still find new or changed company-scoped memories. Run 'pnpm memory:upgrade publish' and 'pnpm memory:upgrade sweep' until both are clean, then retry. Nothing was flipped.",
      "FLIP_PRECONDITION_FAILED",
    );
  }

  return { pending, probe };
}
