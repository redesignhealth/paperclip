/**
 * CLI execution for company memory upgrade recover subcommand (TECH-8191 §Q6, PR5.11).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatRecoverReport,
  runRecover,
  type RecoverDependencies,
} from "../server/src/services/company-memory-upgrade/recover.js";
import { sanitizeCliErrorMessage } from "./memory-upgrade.js";
import { parseRecoverArgs } from "./memory-upgrade-recover-args.js";
import {
  ALLOWED_RECOVER_FLAGS,
  BOOLEAN_RECOVER_FLAGS,
} from "./memory-upgrade-recover-flags.js";

export { ALLOWED_RECOVER_FLAGS, BOOLEAN_RECOVER_FLAGS };

export interface RunRecoverCliDependencies extends RecoverDependencies {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export async function runRecoverCli(
  argv: string[],
  deps: RunRecoverCliDependencies = {},
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const repoRoot = deps.repoRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

    const parsed = parseRecoverArgs(argv, env, repoRoot);
    if ("exitCode" in parsed) {
      return parsed.exitCode;
    }

    const report = await runRecover(
      {
        companyId: parsed.companyId,
        controlPlaneDatabaseUrl: parsed.controlPlaneUrl,
        confirm: parsed.confirm,
        dryRun: parsed.isDryRun,
      },
      deps,
    );

    const reportText = formatRecoverReport(report, parsed.format);

    if (parsed.outputPath) {
      const resolvedPath = path.resolve(process.cwd(), parsed.outputPath);
      writeFileSync(resolvedPath, reportText + "\n", { mode: 0o600, flag: "wx" });
      console.error(`Recovery report written to ${resolvedPath} (mode 0600, exclusive create).`);
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
