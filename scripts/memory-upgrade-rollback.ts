/**
 * CLI execution for company memory upgrade rollback subcommand (TECH-8191 §Q5, PR5.9).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatRollbackReport,
  runRollback,
  type RollbackDependencies,
} from "../server/src/services/company-memory-upgrade/rollback.js";
import { sanitizeCliErrorMessage } from "./memory-upgrade.js";
import { parseRollbackArgs } from "./memory-upgrade-rollback-args.js";
import {
  ALLOWED_ROLLBACK_FLAGS,
  BOOLEAN_ROLLBACK_FLAGS,
} from "./memory-upgrade-rollback-flags.js";

export { ALLOWED_ROLLBACK_FLAGS, BOOLEAN_ROLLBACK_FLAGS };

export interface RunRollbackCliDependencies extends RollbackDependencies {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export async function runRollbackCli(
  argv: string[],
  deps: RunRollbackCliDependencies = {},
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const repoRoot = deps.repoRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

    const parsed = parseRollbackArgs(argv, env, repoRoot);
    if ("exitCode" in parsed) {
      return parsed.exitCode;
    }

    const report = await runRollback(
      {
        companyId: parsed.companyId,
        tenantDatabaseUrl: parsed.databaseUrl,
        controlPlaneDatabaseUrl: parsed.controlPlaneUrl,
        table: parsed.tableName,
        confirm: parsed.confirm,
        dryRun: parsed.isDryRun,
      },
      deps,
    );

    const reportText = formatRollbackReport(report, parsed.format);

    if (parsed.outputPath) {
      const resolvedPath = path.resolve(process.cwd(), parsed.outputPath);
      writeFileSync(resolvedPath, reportText + "\n", { mode: 0o600, flag: "wx" });
      console.error(`Rollback report written to ${resolvedPath} (mode 0600, exclusive create).`);
    } else {
      console.log(reportText);
    }

    return 0;
  } catch (error) {
    const message = sanitizeCliErrorMessage(error);
    console.error(`Error: ${message}`);
    return 1;
  }
}
