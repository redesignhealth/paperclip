/**
 * Read-only agent-scoped memory row summarisation for rollback report (TECH-8191 §Q5, PR5.9).
 *
 * Scans the live tenant memory collection for agent-scoped rows (user_id != 'company'),
 * groups counts by agent scope, checks overlap with upgrade-created rows in staging,
 * and counts published rows retained. Returns ONLY IDs and counts; never memory text.
 */

import type postgres from "postgres";
import { isValidUuid, validateAndResolveTableIdentifier } from "./census.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface AgentScopedRowGroup {
  agentScope: string;
  rows: number;
  createdByAnUpgrade: number;
}

export interface SummariseAgentScopedRowsOptions {
  upgradeId: string;
  tableName: string;
  limit?: number;
}

export interface SummariseAgentScopedRowsResult {
  groups: AgentScopedRowGroup[];
  agentRows: AgentScopedRowGroup[];
  totalAgentScopedRows: number;
  totalCreatedByAnUpgrade: number;
  publishedRowsRetained: number;
}

export async function summariseAgentScopedRows(
  tenantSql: postgres.Sql,
  options: SummariseAgentScopedRowsOptions,
): Promise<SummariseAgentScopedRowsResult> {
  const { upgradeId, tableName } = options;
  if (!isValidUuid(upgradeId)) {
    throw new CompanyMemoryUpgradeError(
      `Invalid upgrade ID: "${upgradeId}"`,
      "INVALID_ARGUMENT",
    );
  }

  const limit = options.limit && options.limit > 0 ? options.limit : 100;
  const resolved = validateAndResolveTableIdentifier(tableName);

  // Check table presence
  const regclassRows = (await tenantSql.unsafe(
    `SELECT
      to_regclass($1) AS live_table,
      to_regclass('paperclip_memory_upgrade_staging') AS staging_table;`,
    [resolved.regclassArg],
  )) as Array<{
    live_table: string | null;
    staging_table: string | null;
  }>;

  const regclass = regclassRows[0];
  if (!regclass?.live_table) {
    throw new CompanyMemoryUpgradeError(
      `Live table "${tableName}" does not exist.`,
      "LIVE_TABLE_MISSING",
    );
  }

  const hasStaging = Boolean(regclass.staging_table);

  // 1. Grouped counts by agent scope from live table
  const groupRows = hasStaging
    ? ((await tenantSql.unsafe(
        `SELECT
          t.payload->>'user_id' AS agent_scope,
          count(*)::int AS rows,
          count(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM paperclip_memory_upgrade_staging s
              WHERE s.output_id::text = lower(t.id::text)
            )
          )::int AS created_by_an_upgrade
        FROM ${resolved.regclassArg} t
        WHERE coalesce(t.payload->>'user_id', '') <> 'company'
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT $1::int;`,
        [limit],
      )) as Array<{
        agent_scope: string | null;
        rows: number | string | null;
        created_by_an_upgrade: number | string | null;
      }>)
    : ((await tenantSql.unsafe(
        `SELECT
          t.payload->>'user_id' AS agent_scope,
          count(*)::int AS rows,
          0::int AS created_by_an_upgrade
        FROM ${resolved.regclassArg} t
        WHERE coalesce(t.payload->>'user_id', '') <> 'company'
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT $1::int;`,
        [limit],
      )) as Array<{
        agent_scope: string | null;
        rows: number | string | null;
        created_by_an_upgrade: number | string | null;
      }>);

  const groups: AgentScopedRowGroup[] = groupRows.map((r) => ({
    agentScope: String(r.agent_scope ?? "unknown"),
    rows: Number(r.rows ?? 0),
    createdByAnUpgrade: Number(r.created_by_an_upgrade ?? 0),
  }));

  const totalAgentScopedRows = groups.reduce((acc, g) => acc + g.rows, 0);
  const totalCreatedByAnUpgrade = groups.reduce((acc, g) => acc + g.createdByAnUpgrade, 0);

  // 2. Count retained published rows in staging for this upgrade
  let publishedRowsRetained = 0;
  if (hasStaging) {
    const retainedRows = (await tenantSql.unsafe(
      `SELECT count(*)::int AS count
       FROM paperclip_memory_upgrade_staging
       WHERE upgrade_id = $1::uuid AND published_at IS NOT NULL;`,
      [upgradeId],
    )) as Array<{ count: number | string | null }>;
    publishedRowsRetained = Number(retainedRows[0]?.count ?? 0);
  }

  return {
    groups,
    agentRows: groups,
    totalAgentScopedRows,
    totalCreatedByAnUpgrade,
    publishedRowsRetained,
  };
}
