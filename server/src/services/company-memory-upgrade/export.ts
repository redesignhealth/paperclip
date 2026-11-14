/**
 * Strictly read-only export service for company memory upgrade (TECH-8573).
 *
 * Exports converted memories for a single agent from the tenant upgrade staging table
 * for downstream import into rh-memory-mcp.
 */

import { createDb } from "@paperclipai/db";
import type postgres from "postgres";
import { resolveExportControlPlaneContext } from "./export-control-plane.js";
import { validateOutputDir, writeExportFiles } from "./export-paths.js";
import {
  type ExportDependencies,
  type ExportOptions,
  type ExportReport,
  formatExportTextReport,
} from "./export-report.js";
import { queryTenantExportRows } from "./export-tenant.js";
import { transformAndValidateStagingRows } from "./export-transform.js";
import { openTenantClient } from "./sweep-tenant.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export {
  validateOutputDir,
  writeExportFiles,
  formatExportTextReport,
  type ExportOptions,
  type ExportReport,
  type ExportDependencies,
};

export async function runExport(
  options: ExportOptions,
  deps: ExportDependencies = {},
): Promise<ExportReport> {
  const canonicalCompanyId = options.companyId.trim().toLowerCase();
  const canonicalAgentId = options.agentId.trim().toLowerCase();
  const canonicalUpgradeId = options.upgradeId ? options.upgradeId.trim().toLowerCase() : null;
  const canonicalConfirm = options.confirm ? options.confirm.trim().toLowerCase() : null;

  const cpDb = deps.cpDb ?? createDb(options.controlPlaneDatabaseUrl);
  const ownedCpDb = deps.cpDb ? null : cpDb;

  let tenantSql: postgres.Sql | null = deps.tenantSql ?? null;
  let ownedTenantSql: postgres.Sql | null = null;

  try {
    if (canonicalConfirm && canonicalConfirm !== canonicalCompanyId) {
      throw new CompanyMemoryUpgradeError(
        "Flag --confirm <uuid> must strictly match --company <uuid>.",
        "INVALID_ARGUMENT",
      );
    }

    if (canonicalConfirm && !options.outputDir) {
      throw new CompanyMemoryUpgradeError(
        "Flag --output-dir is required when --confirm is supplied.",
        "INVALID_ARGUMENT",
      );
    }

    // 1. Control plane validation
    const { upgrade } = await resolveExportControlPlaneContext(
      cpDb,
      canonicalCompanyId,
      canonicalAgentId,
      canonicalUpgradeId,
    );

    // 2. Tenant preflight and read-only query
    if (!tenantSql) {
      tenantSql = openTenantClient(options.tenantDatabaseUrl, { max: 1 });
      ownedTenantSql = tenantSql;
    }

    const { stagingRows, skippedCountsByOutcome } = await queryTenantExportRows(
      tenantSql,
      upgrade.id,
      canonicalAgentId,
      deps._internalOnTransaction,
    );

    // 3. Validate payloads and transform records
    const { records, perTypeCounts, charLengths, totalChars } =
      transformAndValidateStagingRows(
        stagingRows,
        canonicalCompanyId,
        canonicalAgentId,
        upgrade.id,
        upgrade.converterId,
        upgrade.converterVersion,
      );

    charLengths.sort((a, b) => a - b);
    const minLen = charLengths[0] ?? 0;
    const maxLen = charLengths[charLengths.length - 1] ?? 0;
    const avgLen =
      charLengths.length > 0
        ? Math.round((totalChars / charLengths.length) * 10) / 10
        : 0;
    const p95Len =
      charLengths.length > 0
        ? charLengths[
            Math.min(
              charLengths.length - 1,
              Math.floor(charLengths.length * 0.95),
            )
          ]
        : 0;

    const isDryRun = !canonicalConfirm;
    let jsonlPath: string | null = null;
    let manifestPath: string | null = null;
    let jsonlSha256: string | null = null;

    if (!isDryRun) {
      const written = await writeExportFiles({
        outputDir: options.outputDir!,
        repoRoot: deps.repoRoot,
        companyId: canonicalCompanyId,
        agentId: canonicalAgentId,
        upgradeId: upgrade.id,
        converterId: upgrade.converterId,
        converterVersion: upgrade.converterVersion,
        records,
        skippedCountsByOutcome,
        _internalManifestWriteFailureHook: deps._internalManifestWriteFailureHook,
      });
      jsonlPath = written.jsonlPath;
      manifestPath = written.manifestPath;
      jsonlSha256 = written.jsonlSha256;
    }

    return {
      isDryRun,
      companyId: canonicalCompanyId,
      agentId: canonicalAgentId,
      upgradeId: upgrade.id,
      recordCount: records.length,
      skippedCountsByOutcome,
      perTypeCounts,
      textLength: {
        min: minLen,
        avg: avgLen,
        p95: p95Len,
        max: maxLen,
      },
      jsonlPath,
      manifestPath,
      jsonlSha256,
    };
  } finally {
    if (ownedTenantSql) {
      await ownedTenantSql.end({ timeout: 1 }).catch(() => {});
    }
    if (ownedCpDb) {
      await ownedCpDb.$client?.end?.({ timeout: 1 }).catch(() => {});
    }
  }
}
