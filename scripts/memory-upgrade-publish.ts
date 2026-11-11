/**
 * CLI execution for company memory upgrade publish subcommand (TECH-8191).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatPublishReport,
  runPublish,
  type PublishDependencies,
} from "../server/src/services/company-memory-upgrade/publish.js";
import { sanitizeCliErrorMessage } from "./memory-upgrade.js";
import { parsePublishArgs } from "./memory-upgrade-publish-args.js";
import {
  ALLOWED_PUBLISH_FLAGS,
  BOOLEAN_PUBLISH_FLAGS,
} from "./memory-upgrade-publish-flags.js";

export { ALLOWED_PUBLISH_FLAGS, BOOLEAN_PUBLISH_FLAGS };

export interface RunPublishCliDependencies extends PublishDependencies {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export async function runPublishCli(
  argv: string[],
  deps: RunPublishCliDependencies = {},
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const repoRoot = deps.repoRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

    const parsed = parsePublishArgs(argv, env, repoRoot);
    if ("exitCode" in parsed) {
      return parsed.exitCode;
    }

    const report = await runPublish(
      {
        companyId: parsed.companyId,
        tenantDatabaseUrl: parsed.databaseUrl,
        controlPlaneDatabaseUrl: parsed.controlPlaneUrl,
        table: parsed.tableName,
        confirm: parsed.confirm,
        maxRows: parsed.maxRows,
        batchSources: parsed.batchSources,
        pageSize: parsed.pageSize,
        pauseWhenActiveRuns: parsed.pauseWhenActiveRuns,
        activeRunPollMs: parsed.activeRunPollMs,
        maxPauseSeconds: parsed.maxPauseSeconds,
      },
      deps,
    );

    const reportText = formatPublishReport(report, parsed.format);

    if (parsed.outputPath) {
      const resolvedPath = path.resolve(process.cwd(), parsed.outputPath);
      writeFileSync(resolvedPath, reportText + "\n", { mode: 0o600, flag: "wx" });
      console.error(`Publish report written to ${resolvedPath} (mode 0600, exclusive create).`);
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
