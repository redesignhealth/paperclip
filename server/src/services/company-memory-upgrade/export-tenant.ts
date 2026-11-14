/**
 * Tenant preflight and read-only staging query for export (TECH-8573).
 */

import type postgres from "postgres";
import type { StagingExportRow } from "./export-transform.js";
import { assertTenantRolePreflight } from "./sweep-tenant.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface TenantExportQueryResult {
  stagingRows: StagingExportRow[];
  skippedCountsByOutcome: Record<string, number>;
}

export async function queryTenantExportRows(
  tenantSql: postgres.Sql,
  upgradeId: string,
  agentId: string,
  onTransaction?: (tx: any) => Promise<void>,
): Promise<TenantExportQueryResult> {
  await assertTenantRolePreflight(tenantSql, "tenant");

  const regclassRows = (await tenantSql.unsafe(`
    SELECT
      to_regclass('paperclip_memory_upgrade_staging') AS staging_table,
      to_regclass('paperclip_memory_upgrade_ledger') AS ledger_table;
  `)) as Array<{
    staging_table: string | null;
    ledger_table: string | null;
  }>;

  const regclass = regclassRows[0];
  if (!regclass?.staging_table || !regclass?.ledger_table) {
    throw new CompanyMemoryUpgradeError(
      "Upgrade staging or ledger table does not exist in target database. Run 'pnpm memory:upgrade sweep' first.",
      "UPGRADE_TABLES_MISSING",
    );
  }

  let stagingRows: StagingExportRow[] = [];
  const skippedCountsByOutcome: Record<string, number> = {};

  await tenantSql.begin(async (tx: any) => {
    await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;");

    if (onTransaction) {
      await onTransaction(tx);
    }

    // Fail closed if ANY staging row for this agent and upgrade is already published
    const publishedCheck = (await tx.unsafe(
      `SELECT COUNT(*)::int AS count
       FROM paperclip_memory_upgrade_staging
       WHERE upgrade_id = $1::uuid AND agent_id = $2::uuid AND published_at IS NOT NULL;`,
      [upgradeId, agentId],
    )) as Array<{ count: number }>;

    const publishedCount = publishedCheck[0]?.count ?? 0;
    if (publishedCount > 0) {
      throw new CompanyMemoryUpgradeError(
        `This upgrade has ${publishedCount} staging row(s) already published to the company collection; export supports unpublished upgrades only.`,
        "EXPORT_UPGRADE_ALREADY_PUBLISHED",
      );
    }

    const ledgerCounts = (await tx.unsafe(
      `SELECT outcome, COUNT(*)::int AS count
       FROM paperclip_memory_upgrade_ledger
       WHERE upgrade_id = $1::uuid AND agent_id = $2::uuid
       GROUP BY outcome;`,
      [upgradeId, agentId],
    )) as Array<{ outcome: string; count: number }>;

    for (const r of ledgerCounts) {
      if (r.outcome !== "published") {
        skippedCountsByOutcome[r.outcome] = r.count;
      }
    }

    stagingRows = (await tx.unsafe(
      `SELECT
         s.output_id::text AS output_id,
         s.source_id::text AS source_id,
         s.agent_id::text AS staging_agent_id,
         s.payload,
         l.agent_id::text AS ledger_agent_id,
         l.outcome,
         l.output_ids
       FROM paperclip_memory_upgrade_staging s
       JOIN paperclip_memory_upgrade_ledger l
         ON s.upgrade_id = l.upgrade_id AND s.source_id = l.source_id
       WHERE s.upgrade_id = $1::uuid
         AND l.agent_id = $2::uuid
         AND l.outcome = 'published'
         AND s.published_at IS NULL
       ORDER BY s.output_id ASC;`,
      [upgradeId, agentId],
    )) as StagingExportRow[];
  });

  return { stagingRows, skippedCountsByOutcome };
}
