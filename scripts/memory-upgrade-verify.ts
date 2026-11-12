/**
 * CLI execution for company memory upgrade verify subcommand (TECH-8191 §Q4, PR5.8).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatVerifyReport,
  runVerify,
  type VerifyDependencies,
} from "../server/src/services/company-memory-upgrade/verify.js";
import { sanitizeCliErrorMessage } from "./memory-upgrade.js";
import { parseVerifyArgs } from "./memory-upgrade-verify-args.js";
import {
  ALLOWED_VERIFY_FLAGS,
  BOOLEAN_VERIFY_FLAGS,
} from "./memory-upgrade-verify-flags.js";

export { ALLOWED_VERIFY_FLAGS, BOOLEAN_VERIFY_FLAGS };

export interface RunVerifyCliDependencies extends VerifyDependencies {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export async function runVerifyCli(
  argv: string[],
  deps: RunVerifyCliDependencies = {},
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const repoRoot = deps.repoRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

    const parsed = parseVerifyArgs(argv, env, repoRoot);
    if ("exitCode" in parsed) {
      return parsed.exitCode;
    }

    const report = await runVerify(
      {
        companyId: parsed.companyId,
        tenantDatabaseUrl: parsed.databaseUrl,
        controlPlaneDatabaseUrl: parsed.controlPlaneUrl,
        table: parsed.tableName,
        confirm: parsed.confirm,
        dryRun: parsed.isDryRun,
        allowQuarantined: parsed.allowQuarantined,
        probeLimit: parsed.probeLimit,
        blockingRunLimit: parsed.blockingRunLimit,
      },
      deps,
    );

    const reportText = formatVerifyReport(report, parsed.format);

    if (parsed.outputPath) {
      const resolvedPath = path.resolve(process.cwd(), parsed.outputPath);
      writeFileSync(resolvedPath, reportText + "\n", { mode: 0o600, flag: "wx" });
      console.error(`Verify report written to ${resolvedPath} (mode 0600, exclusive create).`);
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
