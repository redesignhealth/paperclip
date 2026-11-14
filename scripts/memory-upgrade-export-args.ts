import {
  isValidUuid,
  validateAndResolveTableIdentifier,
  validateDatabaseUrl,
} from "../server/src/services/company-memory-upgrade/census.js";
import { CompanyMemoryUpgradeError } from "../server/src/services/company-memory-upgrade/types.js";
import { hasBooleanFlag, parseFlagValue, validateNoUnknownFlags } from "./memory-upgrade.js";
import { ALLOWED_EXPORT_FLAGS, BOOLEAN_EXPORT_FLAGS } from "./memory-upgrade-export-flags.js";
import { printExportHelp } from "./memory-upgrade-export-help.js";

export interface ParsedExportArgs {
  companyId: string;
  agentId: string;
  upgradeId: string | null;
  databaseUrl: string;
  controlPlaneUrl: string;
  tableName: string;
  outputDir: string | null;
  confirm: string | null;
  isDryRun: boolean;
  format: "text" | "json";
}

export function parseExportArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  _repoRoot: string,
): ParsedExportArgs | { exitCode: number } {
  if (hasBooleanFlag("--help", argv) || hasBooleanFlag("-h", argv)) {
    printExportHelp();
    return { exitCode: 0 };
  }

  validateNoUnknownFlags(argv, ALLOWED_EXPORT_FLAGS, "export", BOOLEAN_EXPORT_FLAGS);

  const databaseUrl =
    parseFlagValue("--database-url", argv) ??
    env.COMPANY_MEMORY_DATABASE_URL ??
    null;

  if (!databaseUrl) {
    console.error(
      "Error: Refusing to run export without explicit tenant --database-url (or COMPANY_MEMORY_DATABASE_URL env var).",
    );
    return { exitCode: 1 };
  }

  const controlPlaneUrl =
    parseFlagValue("--control-plane-url", argv) ??
    env.CONTROL_PLANE_DATABASE_URL ??
    null;

  if (!controlPlaneUrl) {
    console.error(
      "Error: Refusing to run export without explicit control plane --control-plane-url (or CONTROL_PLANE_DATABASE_URL env var).",
    );
    return { exitCode: 1 };
  }

  const allowProd = hasBooleanFlag("--prod", argv);
  validateDatabaseUrl(databaseUrl, env, { allowProd });
  validateDatabaseUrl(controlPlaneUrl, env, { allowProd });

  const rawCompanyId = parseFlagValue("--company", argv);
  if (!rawCompanyId) {
    console.error("Error: Flag --company <uuid> is required for export.");
    return { exitCode: 1 };
  }
  const companyId = rawCompanyId.trim().toLowerCase();
  if (!isValidUuid(companyId)) {
    console.error("Error: Invalid --company. Must be a valid UUID.");
    return { exitCode: 1 };
  }

  const rawAgentId = parseFlagValue("--agent", argv);
  if (!rawAgentId) {
    console.error("Error: Flag --agent <uuid> is required for export.");
    return { exitCode: 1 };
  }
  const agentId = rawAgentId.trim().toLowerCase();
  if (!isValidUuid(agentId)) {
    console.error("Error: Invalid --agent. Must be a valid UUID.");
    return { exitCode: 1 };
  }

  const rawUpgradeId = parseFlagValue("--upgrade-id", argv);
  const upgradeId = rawUpgradeId ? rawUpgradeId.trim().toLowerCase() : null;
  if (upgradeId && !isValidUuid(upgradeId)) {
    console.error("Error: Invalid --upgrade-id. Must be a valid UUID.");
    return { exitCode: 1 };
  }

  const rawConfirm = parseFlagValue("--confirm", argv);
  const confirm = rawConfirm ? rawConfirm.trim().toLowerCase() : null;
  if (confirm && !isValidUuid(confirm)) {
    console.error("Error: Invalid --confirm. Must be a valid UUID.");
    return { exitCode: 1 };
  }

  if (confirm && confirm !== companyId) {
    throw new CompanyMemoryUpgradeError(
      "Flag --confirm <uuid> must strictly match --company <uuid>.",
      "INVALID_ARGUMENT",
    );
  }

  const outputDir = parseFlagValue("--output-dir", argv);
  if (confirm && !outputDir) {
    throw new CompanyMemoryUpgradeError(
      "Flag --output-dir is required when --confirm is supplied.",
      "INVALID_ARGUMENT",
    );
  }

  const tableName = parseFlagValue("--table", argv) ?? "mem0_memories";
  validateAndResolveTableIdentifier(tableName);

  const rawFormat = (parseFlagValue("--format", argv) ?? "text").toLowerCase();
  if (rawFormat !== "text" && rawFormat !== "json") {
    console.error(`Error: Invalid --format. Must be "text" or "json".`);
    return { exitCode: 1 };
  }
  const format = rawFormat as "text" | "json";

  const isDryRun = !confirm;

  return {
    companyId,
    agentId,
    upgradeId,
    databaseUrl,
    controlPlaneUrl,
    tableName,
    outputDir,
    confirm,
    isDryRun,
    format,
  };
}
