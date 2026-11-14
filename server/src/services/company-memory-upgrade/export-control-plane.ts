/**
 * Control-plane validation and upgrade resolution for export (TECH-8573).
 */

import {
  agents,
  companyMemoryUpgrades,
  type Db,
} from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { assertNonSuperuserAndRestrictedRole } from "./census.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface ResolvedExportContext {
  upgrade: typeof companyMemoryUpgrades.$inferSelect;
}

export async function resolveExportControlPlaneContext(
  cpDb: Db,
  companyId: string,
  agentId: string,
  upgradeId?: string | null,
): Promise<ResolvedExportContext> {
  await cpDb.transaction(async (tx) => {
    await assertNonSuperuserAndRestrictedRole(tx, "control-plane");
  });

  const agentRows = await cpDb
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId));

  const agentRow = agentRows[0];
  if (!agentRow || agentRow.companyId !== companyId) {
    throw new CompanyMemoryUpgradeError(
      "Target agent record does not exist in control plane database for target company.",
      "AGENT_NOT_FOUND",
    );
  }

  if (agentRow.adapterType !== "hermes_local" || agentRow.status === "terminated") {
    throw new CompanyMemoryUpgradeError(
      "Target agent is not a memory-eligible hermes_local agent.",
      "AGENT_INELIGIBLE",
    );
  }

  let upgradeRow: typeof companyMemoryUpgrades.$inferSelect | undefined;
  if (upgradeId) {
    const rows = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(
        and(
          eq(companyMemoryUpgrades.id, upgradeId),
          eq(companyMemoryUpgrades.companyId, companyId),
        ),
      );
    upgradeRow = rows[0];
    if (!upgradeRow) {
      throw new CompanyMemoryUpgradeError(
        "Upgrade record not found.",
        "UPGRADE_NOT_FOUND",
      );
    }
  } else {
    const rows = await cpDb
      .select()
      .from(companyMemoryUpgrades)
      .where(eq(companyMemoryUpgrades.companyId, companyId))
      .orderBy(desc(companyMemoryUpgrades.createdAt));

    if (rows.length === 0) {
      throw new CompanyMemoryUpgradeError(
        "Upgrade record not found.",
        "UPGRADE_NOT_FOUND",
      );
    }
    if (rows.length > 1) {
      const candidates = rows
        .map((r) => `${r.id} (state: ${r.state}, created_at: ${r.createdAt.toISOString()})`)
        .join(", ");
      throw new CompanyMemoryUpgradeError(
        `Multiple upgrade records exist for company (${rows.length} candidates: ${candidates}). Please specify --upgrade-id <uuid>.`,
        "AMBIGUOUS_UPGRADE",
      );
    }
    upgradeRow = rows[0];
  }

  if (upgradeRow.state === "needs_recovery") {
    throw new CompanyMemoryUpgradeError(
      "Upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' first.",
      "STATE_MISMATCH",
    );
  }

  if (upgradeRow.state === "aborted") {
    throw new CompanyMemoryUpgradeError(
      "Cannot run export: active upgrade is in aborted state.",
      "STATE_MISMATCH",
    );
  }

  return { upgrade: upgradeRow };
}
