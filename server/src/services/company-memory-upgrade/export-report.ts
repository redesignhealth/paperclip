/**
 * Report types and formatting for memory upgrade export (TECH-8573).
 */

import type { Db } from "@paperclipai/db";
import type postgres from "postgres";

export interface ExportOptions {
  companyId: string;
  agentId: string;
  upgradeId?: string | null;
  confirm?: string | null;
  outputDir?: string | null;
  tableName?: string;
  format?: "text" | "json";
  tenantDatabaseUrl: string;
  controlPlaneDatabaseUrl: string;
  allowProd?: boolean;
}

export interface ExportReport {
  isDryRun: boolean;
  companyId: string;
  agentId: string;
  upgradeId: string;
  recordCount: number;
  skippedCountsByOutcome: Record<string, number>;
  perTypeCounts: Record<string, number>;
  textLength: {
    min: number;
    avg: number;
    p95: number;
    max: number;
  };
  jsonlPath: string | null;
  manifestPath: string | null;
  jsonlSha256: string | null;
}

export interface ExportDependencies {
  cpDb?: Db;
  tenantSql?: postgres.Sql;
  repoRoot?: string;
  _internalOnTransaction?: (tx: any) => Promise<void>;
  _internalSkipVectorIdentityCheck?: boolean;
  _internalManifestWriteFailureHook?: () => Promise<void> | void;
}

export function formatExportTextReport(report: ExportReport): string {
  const lines: string[] = [
    "=== Memory Upgrade Export Report ===",
    `Mode:                    ${report.isDryRun ? "DRY RUN (no files written; pass --confirm <company-id> --output-dir <dir> to export)" : "CONFIRMED (files written)"}`,
    `Company ID:              ${report.companyId}`,
    `Agent ID:                ${report.agentId}`,
    `Upgrade ID:              ${report.upgradeId}`,
    `Exported records:        ${report.recordCount}`,
  ];

  lines.push("Skipped ledger rows by outcome:");
  const skippedEntries = Object.entries(report.skippedCountsByOutcome);
  if (skippedEntries.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [outcome, count] of skippedEntries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  - ${outcome}: ${count}`);
    }
  }

  lines.push("Record counts by type:");
  const typeEntries = Object.entries(report.perTypeCounts);
  if (typeEntries.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [type, count] of typeEntries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  - ${type}: ${count}`);
    }
  }

  lines.push("Memory text length:");
  lines.push(`  - Min: ${report.textLength.min} chars`);
  lines.push(`  - Avg: ${report.textLength.avg} chars`);
  lines.push(`  - P95: ${report.textLength.p95} chars`);
  lines.push(`  - Max: ${report.textLength.max} chars`);

  if (!report.isDryRun && report.jsonlPath && report.manifestPath) {
    lines.push("Files written:");
    lines.push(`  - JSONL:    ${report.jsonlPath} (SHA-256: ${report.jsonlSha256})`);
    lines.push(`  - Manifest: ${report.manifestPath}`);
  }

  return lines.join("\n");
}
