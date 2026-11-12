/**
 * Command-line argument parsing and validation for recover subcommand (TECH-8191 §Q6, PR5.11).
 */

import {
  isValidUuid,
  validateDatabaseUrl,
  validateOutputPath,
} from "../server/src/services/company-memory-upgrade/census.js";
import { CompanyMemoryUpgradeError } from "../server/src/services/company-memory-upgrade/types.js";
import { hasBooleanFlag, parseFlagValue, validateNoUnknownFlags } from "./memory-upgrade.js";
import { ALLOWED_RECOVER_FLAGS, BOOLEAN_RECOVER_FLAGS } from "./memory-upgrade-recover-flags.js";
import { printRecoverHelp } from "./memory-upgrade-recover-help.js";

export interface ParsedRecoverArgs {
  companyId: string;
  controlPlaneUrl: string;
  confirm?: string;
  isDryRun: boolean;
  outputPath: string | null;
  format: "text" | "json";
}

export function parseRecoverArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): ParsedRecoverArgs | { exitCode: number } {
  if (hasBooleanFlag("--help", argv) || hasBooleanFlag("-h", argv)) {
    printRecoverHelp();
    return { exitCode: 0 };
  }

  validateNoUnknownFlags(argv, ALLOWED_RECOVER_FLAGS, "recover", BOOLEAN_RECOVER_FLAGS);

  const controlPlaneUrl =
    parseFlagValue("--control-plane-url", argv) ?? env.CONTROL_PLANE_DATABASE_URL ?? null;
  if (!controlPlaneUrl) {
    console.error(
      "Error: Refusing to run recover without explicit control plane --control-plane-url (or CONTROL_PLANE_DATABASE_URL env var).",
    );
    return { exitCode: 1 };
  }

  const allowProd = hasBooleanFlag("--prod", argv);
  validateDatabaseUrl(controlPlaneUrl, env, { allowProd });

  const rawCompanyId = parseFlagValue("--company", argv);
  const rawConfirmId = parseFlagValue("--confirm", argv);
  const companyId = rawCompanyId ?? rawConfirmId ?? null;
  if (!companyId) {
    console.error("Error: Flag --company <uuid> (or --confirm <uuid>) is required for recover.");
    return { exitCode: 1 };
  }
  if (rawCompanyId && rawConfirmId && rawCompanyId !== rawConfirmId) {
    throw new CompanyMemoryUpgradeError(
      "Flag --confirm <uuid> must strictly match --company <uuid>.",
      "INVALID_ARGUMENT",
    );
  }
  if (!isValidUuid(companyId)) {
    console.error("Error: Flag --company must be a valid UUID.");
    return { exitCode: 1 };
  }
  if (rawConfirmId && !isValidUuid(rawConfirmId)) {
    console.error("Error: Flag --confirm must be a valid UUID.");
    return { exitCode: 1 };
  }

  const isDryRun = hasBooleanFlag("--dry-run", argv) || !rawConfirmId;
  const confirm = isDryRun ? undefined : (rawConfirmId ?? undefined);

  const outputPath = parseFlagValue("--output", argv) ?? parseFlagValue("--out", argv) ?? null;
  if (outputPath) validateOutputPath(outputPath, repoRoot);

  const rawFormat = (parseFlagValue("--format", argv) ?? "text").toLowerCase();
  if (rawFormat !== "text" && rawFormat !== "json") {
    console.error(`Error: Invalid --format. Must be "text" or "json".`);
    return { exitCode: 1 };
  }

  return {
    companyId,
    controlPlaneUrl,
    confirm,
    isDryRun,
    outputPath,
    format: rawFormat as "text" | "json",
  };
}
