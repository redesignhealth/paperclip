/**
 * Preflight checks and staging counters for drain probe (TECH-8191 §Q2 P6, §Q3, PR5.5).
 */

import type postgres from "postgres";
import { isValidUuid } from "./census.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface PublishPendingResult {
  pendingRows: number;
  pendingSources: number;
  alreadyPublishedRows: number;
}

/**
 * Counts pending publishable rows in paperclip_memory_upgrade_staging (TECH-8191 §Q2 P6).
 * Excludes quarantined sources which keep their staging rows forever by design.
 */
export async function countPublishPending(
  tenantSql: postgres.Sql,
  upgradeId: string,
): Promise<PublishPendingResult> {
  if (!isValidUuid(upgradeId)) {
    throw new CompanyMemoryUpgradeError(
      `Invalid upgrade ID: "${upgradeId}"`,
      "INVALID_ARGUMENT",
    );
  }

  const rows = (await tenantSql.unsafe(
    `SELECT
      count(*) FILTER (WHERE s.published_at IS NULL)::int AS pending_rows,
      count(DISTINCT s.source_id) FILTER (WHERE s.published_at IS NULL)::int AS pending_sources,
      count(*) FILTER (WHERE s.published_at IS NOT NULL)::int AS already_published_rows
    FROM paperclip_memory_upgrade_staging s
    JOIN paperclip_memory_upgrade_ledger l
      ON l.upgrade_id = s.upgrade_id AND l.source_id = s.source_id
    WHERE s.upgrade_id = $1::uuid
      AND l.outcome = 'published';`,
    [upgradeId],
  )) as Array<{
    pending_rows: number | string | null;
    pending_sources: number | string | null;
    already_published_rows: number | string | null;
  }>;

  const first = rows[0];
  return {
    pendingRows: Number(first?.pending_rows ?? 0),
    pendingSources: Number(first?.pending_sources ?? 0),
    alreadyPublishedRows: Number(first?.already_published_rows ?? 0),
  };
}

/**
 * Verifies tenant database version and table readiness without DDL or side effects.
 * Fails closed if tables are missing or PostgreSQL lacks the sha256() builtin (< 11.0).
 */
export async function assertDrainProbePreflight(
  tenantSql: postgres.Sql,
  tableName: string,
  regclassArg: string,
): Promise<void> {
  const versionRows = (await tenantSql.unsafe(
    `SELECT current_setting('server_version_num')::int AS v;`,
  )) as Array<{ v: number }>;
  const serverVersion = Number(versionRows[0]?.v ?? 0);
  if (serverVersion < 110000) {
    throw new CompanyMemoryUpgradeError(
      `PostgreSQL 11+ is required for drain probe sha256() builtin; server version num is ${serverVersion}.`,
      "SOURCE_READ_FAILED",
    );
  }

  const regclassRows = (await tenantSql.unsafe(
    `SELECT
      to_regclass($1) AS live_table,
      to_regclass('paperclip_memory_upgrade_ledger') AS ledger_table,
      to_regclass('paperclip_memory_upgrade_staging') AS staging_table;`,
    [regclassArg],
  )) as Array<{
    live_table: string | null;
    ledger_table: string | null;
    staging_table: string | null;
  }>;

  const regclass = regclassRows[0];
  if (!regclass?.live_table) {
    throw new CompanyMemoryUpgradeError(
      `Live table "${tableName}" does not exist.`,
      "LIVE_TABLE_MISSING",
    );
  }
  if (!regclass?.ledger_table) {
    throw new CompanyMemoryUpgradeError(
      `Upgrade ledger table "paperclip_memory_upgrade_ledger" does not exist.`,
      "TABLE_NOT_FOUND",
    );
  }
  if (!regclass?.staging_table) {
    throw new CompanyMemoryUpgradeError(
      `Upgrade staging table "paperclip_memory_upgrade_staging" does not exist.`,
      "TABLE_NOT_FOUND",
    );
  }
}
