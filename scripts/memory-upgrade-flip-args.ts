import {
  isValidUuid,
  validateAndResolveTableIdentifier,
  validateDatabaseUrl,
  validateOutputPath,
} from "../server/src/services/company-memory-upgrade/census.js";
import { CompanyMemoryUpgradeError } from "../server/src/services/company-memory-upgrade/types.js";
import { hasBooleanFlag, parseFlagValue, validateNoUnknownFlags } from "./memory-upgrade.js";
import { ALLOWED_FLIP_FLAGS, BOOLEAN_FLIP_FLAGS } from "./memory-upgrade-flip-flags.js";
import { printFlipHelp } from "./memory-upgrade-flip-help.js";

export interface ParsedFlipArgs {
  companyId: string;
  databaseUrl: string;
  controlPlaneUrl: string;
  tableName: string;
  confirm?: string;
  mode: string;
  probeLimit: number;
  ackAgentScopeFlag: boolean;
  outputPath: string | null;
  format: "text" | "json";
}

function parseIntFlag(name: string, argv: string[], kind: "positive integer", def = 1000): number {
  const raw = parseFlagValue(name, argv);
  if (raw === null) return def;
  const num = parseInt(raw, 10);
  if (!Number.isInteger(num) || num <= 0 || String(num) !== raw.trim()) {
    throw new CompanyMemoryUpgradeError(`Flag '${name}' requires a ${kind} value.`, "INVALID_ARGUMENT");
  }
  return num;
}

export function parseFlipArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): ParsedFlipArgs | { exitCode: number } {
  if (hasBooleanFlag("--help", argv) || hasBooleanFlag("-h", argv)) {
    printFlipHelp();
    return { exitCode: 0 };
  }

  validateNoUnknownFlags(argv, ALLOWED_FLIP_FLAGS, "flip", BOOLEAN_FLIP_FLAGS);

  const databaseUrl = parseFlagValue("--database-url", argv) ?? env.COMPANY_MEMORY_DATABASE_URL ?? null;
  if (!databaseUrl) {
    console.error("Error: Refusing to run flip without explicit tenant --database-url (or COMPANY_MEMORY_DATABASE_URL env var).");
    return { exitCode: 1 };
  }

  const controlPlaneUrl = parseFlagValue("--control-plane-url", argv) ?? env.CONTROL_PLANE_DATABASE_URL ?? null;
  if (!controlPlaneUrl) {
    console.error("Error: Refusing to run flip without explicit control plane --control-plane-url (or CONTROL_PLANE_DATABASE_URL env var).");
    return { exitCode: 1 };
  }

  const allowProd = hasBooleanFlag("--prod", argv);
  validateDatabaseUrl(databaseUrl, env, { allowProd });
  validateDatabaseUrl(controlPlaneUrl, env, { allowProd });

  const rawCompanyId = parseFlagValue("--company", argv);
  const rawConfirmId = parseFlagValue("--confirm", argv);
  const companyId = rawCompanyId ?? rawConfirmId ?? null;

  if (!companyId) {
    console.error("Error: Flag --company <uuid> (or --confirm <uuid>) is required for flip.");
    return { exitCode: 1 };
  }
  if (rawCompanyId && rawConfirmId && rawCompanyId !== rawConfirmId) {
    console.error("Error: Flag --confirm <uuid> must strictly match --company <uuid>.");
    return { exitCode: 1 };
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

  const mode = parseFlagValue("--mode", argv) ?? "copy";
  if (mode !== "copy") {
    throw new CompanyMemoryUpgradeError("Invalid --mode. Only 'copy' is supported.", "INVALID_ARGUMENT");
  }

  const probeLimit = parseIntFlag("--probe-limit", argv, "positive integer", 1000);
  const isDryRun = hasBooleanFlag("--dry-run", argv) || !rawConfirmId;
  const confirm = isDryRun ? undefined : (rawConfirmId ?? undefined);
  const ackAgentScopeFlag = hasBooleanFlag("--ack-agent-scope-flag", argv);

  if (confirm !== undefined && !ackAgentScopeFlag) {
    throw new CompanyMemoryUpgradeError(
      "Flag '--ack-agent-scope-flag' is required for flip. The scope marker alone has no effect unless 'agent-scoped-mem0' is enabled for this company's agent processes.",
      "INVALID_ARGUMENT",
    );
  }

  const outputPath = parseFlagValue("--output", argv) ?? parseFlagValue("--out", argv) ?? null;
  if (outputPath) validateOutputPath(outputPath, repoRoot);

  const rawFormat = (parseFlagValue("--format", argv) ?? "text").toLowerCase();
  if (rawFormat !== "text" && rawFormat !== "json") {
    console.error(`Error: Invalid --format. Must be "text" or "json".`);
    return { exitCode: 1 };
  }

  return {
    companyId, databaseUrl, controlPlaneUrl, tableName,
    confirm, mode, probeLimit, ackAgentScopeFlag,
    outputPath, format: rawFormat as "text" | "json",
  };
}
