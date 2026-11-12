/**
 * CLI execution for company memory upgrade flip subcommand (TECH-8191).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatFlipReport,
  runFlip,
  type FlipDependencies,
} from "../server/src/services/company-memory-upgrade/flip.js";
import { sanitizeCliErrorMessage } from "./memory-upgrade.js";
import { parseFlipArgs } from "./memory-upgrade-flip-args.js";
import {
  ALLOWED_FLIP_FLAGS,
  BOOLEAN_FLIP_FLAGS,
} from "./memory-upgrade-flip-flags.js";

export { ALLOWED_FLIP_FLAGS, BOOLEAN_FLIP_FLAGS };

export interface RunFlipCliDependencies extends FlipDependencies {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export async function runFlipCli(
  argv: string[],
  deps: RunFlipCliDependencies = {},
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const repoRoot = deps.repoRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

    const parsed = parseFlipArgs(argv, env, repoRoot);
    if ("exitCode" in parsed) {
      return parsed.exitCode;
    }

    const report = await runFlip(
      {
        companyId: parsed.companyId,
        tenantDatabaseUrl: parsed.databaseUrl,
        controlPlaneDatabaseUrl: parsed.controlPlaneUrl,
        table: parsed.tableName,
        confirm: parsed.confirm,
        mode: parsed.mode,
        probeLimit: parsed.probeLimit,
        ackAgentScopeFlag: parsed.ackAgentScopeFlag,
      },
      deps,
    );

    const reportText = formatFlipReport(report, parsed.format);

    if (parsed.outputPath) {
      const resolvedPath = path.resolve(process.cwd(), parsed.outputPath);
      writeFileSync(resolvedPath, reportText + "\n", { mode: 0o600, flag: "wx" });
      console.error(`Flip report written to ${resolvedPath} (mode 0600, exclusive create).`);
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
