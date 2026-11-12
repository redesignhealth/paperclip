/**
 * CLI execution for company memory upgrade drain subcommand (TECH-8191 §Q3, PR5.7).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatDrainReport,
  runDrain,
  type DrainDependencies,
} from "../server/src/services/company-memory-upgrade/drain.js";
import { sanitizeCliErrorMessage } from "./memory-upgrade.js";
import { parseDrainArgs } from "./memory-upgrade-drain-args.js";
import {
  ALLOWED_DRAIN_FLAGS,
  BOOLEAN_DRAIN_FLAGS,
} from "./memory-upgrade-drain-flags.js";

export { ALLOWED_DRAIN_FLAGS, BOOLEAN_DRAIN_FLAGS };

export interface RunDrainCliDependencies extends DrainDependencies {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export async function runDrainCli(
  argv: string[],
  deps: RunDrainCliDependencies = {},
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const repoRoot = deps.repoRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

    const parsed = parseDrainArgs(argv, env, repoRoot);
    if ("exitCode" in parsed) {
      return parsed.exitCode;
    }

    const report = await runDrain(
      {
        companyId: parsed.companyId,
        tenantDatabaseUrl: parsed.databaseUrl,
        controlPlaneDatabaseUrl: parsed.controlPlaneUrl,
        table: parsed.tableName,
        confirm: parsed.confirm,
        dryRun: parsed.isDryRun,
        once: parsed.once,
        probeIntervalMinutes: parsed.probeIntervalMinutes,
        maxDrainHours: parsed.maxDrainHours,
        probeLimit: parsed.probeLimit,
        blockingRunLimit: parsed.blockingRunLimit,
      },
      deps,
    );

    const reportText = formatDrainReport(report, parsed.format);

    if (parsed.outputPath) {
      const resolvedPath = path.resolve(process.cwd(), parsed.outputPath);
      writeFileSync(resolvedPath, reportText + "\n", { mode: 0o600, flag: "wx" });
      console.error(`Drain report written to ${resolvedPath} (mode 0600, exclusive create).`);
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
