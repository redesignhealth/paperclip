import {
  isValidUuid,
  validateAndResolveTableIdentifier,
  validateDatabaseUrl,
  validateOutputPath,
} from "../server/src/services/company-memory-upgrade/census.js";
import { CompanyMemoryUpgradeError } from "../server/src/services/company-memory-upgrade/types.js";
import { hasBooleanFlag, parseFlagValue, validateNoUnknownFlags } from "./memory-upgrade.js";
import { ALLOWED_VERIFY_FLAGS, BOOLEAN_VERIFY_FLAGS } from "./memory-upgrade-verify-flags.js";
import { printVerifyHelp } from "./memory-upgrade-verify-help.js";

export interface ParsedVerifyArgs {
  companyId: string;
  databaseUrl: string;
  controlPlaneUrl: string;
  tableName: string;
  confirm?: string;
  isDryRun: boolean;
  allowQuarantined: boolean;
  probeLimit: number;
  blockingRunLimit: number;
  outputPath: string | null;
  format: "text" | "json";
}

function parseIntFlag(name: string, argv: string[], def: number, min = 1): number {
  const raw = parseFlagValue(name, argv);
  if (raw === null) return def;
  const num = parseInt(raw, 10);
  if (!Number.isInteger(num) || num <= 0 || String(num) !== raw.trim() || num < min) {
    const msg = min > 1 && Number.isInteger(num) && num < min
      ? `Flag '${name}' requires an integer value >= ${min}.`
      : `Flag '${name}' requires a positive integer value.`;
    throw new CompanyMemoryUpgradeError(msg, "INVALID_ARGUMENT");
  }
  return num;
}

export function parseVerifyArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): ParsedVerifyArgs | { exitCode: number } {
  if (hasBooleanFlag("--help", argv) || hasBooleanFlag("-h", argv)) {
    printVerifyHelp();
    return { exitCode: 0 };
  }

  validateNoUnknownFlags(argv, ALLOWED_VERIFY_FLAGS, "verify", BOOLEAN_VERIFY_FLAGS);

  const databaseUrl = parseFlagValue("--database-url", argv) ?? env.COMPANY_MEMORY_DATABASE_URL ?? null;
  const controlPlaneUrl = parseFlagValue("--control-plane-url", argv) ?? env.CONTROL_PLANE_DATABASE_URL ?? null;
  if (!databaseUrl) {
    console.error("Error: Refusing to run verify without explicit tenant --database-url (or COMPANY_MEMORY_DATABASE_URL env var).");
    return { exitCode: 1 };
  }
  if (!controlPlaneUrl) {
    console.error("Error: Refusing to run verify without explicit control plane --control-plane-url (or CONTROL_PLANE_DATABASE_URL env var).");
    return { exitCode: 1 };
  }

  const allowProd = hasBooleanFlag("--prod", argv);
  validateDatabaseUrl(databaseUrl, env, { allowProd });
  validateDatabaseUrl(controlPlaneUrl, env, { allowProd });

  const rawCompanyId = parseFlagValue("--company", argv);
  const rawConfirmId = parseFlagValue("--confirm", argv);
  const companyId = rawCompanyId ?? rawConfirmId ?? null;
  if (!companyId) {
    console.error("Error: Flag --company <uuid> (or --confirm <uuid>) is required for verify.");
    return { exitCode: 1 };
  }
  if (rawCompanyId && rawConfirmId && rawCompanyId !== rawConfirmId) {
    throw new CompanyMemoryUpgradeError("Flag --confirm <uuid> must strictly match --company <uuid>.", "INVALID_ARGUMENT");
  }
  if (!isValidUuid(companyId)) {
    console.error("Error: Flag --company must be a valid UUID.");
    return { exitCode: 1 };
  }
  if (rawConfirmId && !isValidUuid(rawConfirmId)) {
    console.error("Error: Flag --confirm must be a valid UUID.");
    return { exitCode: 1 };
  }

  const tableName = parseFlagValue("--table", argv) ?? "mem0_memories";
  validateAndResolveTableIdentifier(tableName);

  const isDryRun = hasBooleanFlag("--dry-run", argv) || !rawConfirmId;
  const confirm = isDryRun ? undefined : (rawConfirmId ?? undefined);
  const allowQuarantined = hasBooleanFlag("--allow-quarantined", argv);
  const probeLimit = parseIntFlag("--probe-limit", argv, 1000);
  const blockingRunLimit = parseIntFlag("--blocking-run-limit", argv, 25);
  const outputPath = parseFlagValue("--output", argv) ?? parseFlagValue("--out", argv) ?? null;
  if (outputPath) validateOutputPath(outputPath, repoRoot);

  const rawFormat = (parseFlagValue("--format", argv) ?? "text").toLowerCase();
  if (rawFormat !== "text" && rawFormat !== "json") {
    console.error(`Error: Invalid --format. Must be "text" or "json".`);
    return { exitCode: 1 };
  }

  return {
    companyId,
    databaseUrl,
    controlPlaneUrl,
    tableName,
    confirm,
    isDryRun,
    allowQuarantined,
    probeLimit,
    blockingRunLimit,
    outputPath,
    format: rawFormat as "text" | "json",
  };
}
