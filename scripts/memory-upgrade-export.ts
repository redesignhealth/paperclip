/**
 * CLI execution for company memory upgrade export subcommand (TECH-8573).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatExportTextReport,
  runExport,
  type ExportDependencies,
} from "../server/src/services/company-memory-upgrade/export.js";
import { sanitizeCliErrorMessage } from "./memory-upgrade.js";
import { parseExportArgs } from "./memory-upgrade-export-args.js";
import {
  ALLOWED_EXPORT_FLAGS,
  BOOLEAN_EXPORT_FLAGS,
} from "./memory-upgrade-export-flags.js";

export { ALLOWED_EXPORT_FLAGS, BOOLEAN_EXPORT_FLAGS };

export interface RunExportCliDependencies extends ExportDependencies {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export async function runExportCli(
  argv: string[],
  deps: RunExportCliDependencies = {},
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const repoRoot = deps.repoRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

    const parsed = parseExportArgs(argv, env, repoRoot);
    if ("exitCode" in parsed) {
      return parsed.exitCode;
    }

    const report = await runExport(
      {
        companyId: parsed.companyId,
        agentId: parsed.agentId,
        upgradeId: parsed.upgradeId,
        confirm: parsed.confirm,
        outputDir: parsed.outputDir,
        tableName: parsed.tableName,
        tenantDatabaseUrl: parsed.databaseUrl,
        controlPlaneDatabaseUrl: parsed.controlPlaneUrl,
        format: parsed.format,
      },
      deps,
    );

    if (parsed.format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatExportTextReport(report));
    }

    return 0;
  } catch (error) {
    const message = sanitizeCliErrorMessage(error);
    console.error(`Error: ${message}`);
    return 1;
  }
}
