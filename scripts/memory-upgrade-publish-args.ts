import {
  isValidUuid,
  validateAndResolveTableIdentifier,
  validateDatabaseUrl,
  validateOutputPath,
} from "../server/src/services/company-memory-upgrade/census.js";
import { CompanyMemoryUpgradeError } from "../server/src/services/company-memory-upgrade/types.js";
import {
  hasBooleanFlag,
  parseFlagValue,
  validateNoUnknownFlags,
} from "./memory-upgrade.js";
import { ALLOWED_PUBLISH_FLAGS } from "./memory-upgrade-publish-flags.js";
import { printPublishHelp } from "./memory-upgrade-publish-help.js";

export interface ParsedPublishArgs {
  companyId: string; databaseUrl: string; controlPlaneUrl: string; tableName: string;
  confirm?: string; maxRows?: number; batchSources?: number; pageSize?: number;
  pauseWhenActiveRuns?: number; activeRunPollMs?: number; maxPauseSeconds?: number;
  outputPath: string | null; format: "text" | "json";
}

function parseIntFlag(name: string, argv: string[], kind: "positive integer" | "non-negative integer", def?: number): number | undefined {
  const raw = parseFlagValue(name, argv);
  if (raw === null) return def;
  const num = parseInt(raw, 10);
  if (!Number.isInteger(num) || (kind === "positive integer" ? num <= 0 : num < 0) || String(num) !== raw.trim()) {
    throw new CompanyMemoryUpgradeError(`Flag '${name}' requires a ${kind} value.`, "INVALID_ARGUMENT");
  }
  return num;
}

export function parsePublishArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): ParsedPublishArgs | { exitCode: number } {
  if (hasBooleanFlag("--help", argv) || hasBooleanFlag("-h", argv)) {
    printPublishHelp();
    return { exitCode: 0 };
  }

  validateNoUnknownFlags(argv, ALLOWED_PUBLISH_FLAGS, "publish");

  const databaseUrl = parseFlagValue("--database-url", argv) ?? env.COMPANY_MEMORY_DATABASE_URL ?? null;
  if (!databaseUrl) {
    console.error("Error: Refusing to run publish without explicit tenant --database-url (or COMPANY_MEMORY_DATABASE_URL env var).");
    return { exitCode: 1 };
  }

  const controlPlaneUrl = parseFlagValue("--control-plane-url", argv) ?? env.CONTROL_PLANE_DATABASE_URL ?? null;
  if (!controlPlaneUrl) {
    console.error("Error: Refusing to run publish without explicit control plane --control-plane-url (or CONTROL_PLANE_DATABASE_URL env var).");
    return { exitCode: 1 };
  }

  const allowProd = hasBooleanFlag("--prod", argv);
  validateDatabaseUrl(databaseUrl, env, { allowProd });
  validateDatabaseUrl(controlPlaneUrl, env, { allowProd });

  const rawCompanyId = parseFlagValue("--company", argv), rawConfirmId = parseFlagValue("--confirm", argv);
  const companyId = rawCompanyId ?? rawConfirmId ?? null;
  if (!companyId) {
    console.error("Error: Flag --company <uuid> (or --confirm <uuid>) is required for publish.");
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

  const batchSources = parseIntFlag("--batch-sources", argv, "positive integer", 100),
    maxRows = parseIntFlag("--max-rows", argv, "positive integer"),
    pageSize = parseIntFlag("--page-size", argv, "positive integer", 1000),
    pauseWhenActiveRuns = parseIntFlag("--pause-when-active-runs", argv, "non-negative integer", 1),
    activeRunPollMs = parseIntFlag("--active-run-poll-ms", argv, "positive integer", 15_000),
    maxPauseSeconds = parseIntFlag("--max-pause-seconds", argv, "non-negative integer", 0),
    confirm = hasBooleanFlag("--dry-run", argv) ? undefined : (rawConfirmId ?? undefined);
  const outputPath = parseFlagValue("--output", argv) ?? parseFlagValue("--out", argv) ?? null;
  if (outputPath) validateOutputPath(outputPath, repoRoot);

  const rawFormat = (parseFlagValue("--format", argv) ?? "text").toLowerCase();
  if (rawFormat !== "text" && rawFormat !== "json") {
    console.error(`Error: Invalid --format. Must be "text" or "json".`);
    return { exitCode: 1 };
  }

  return {
    companyId, databaseUrl, controlPlaneUrl, tableName,
    confirm, maxRows, batchSources, pageSize,
    pauseWhenActiveRuns, activeRunPollMs, maxPauseSeconds,
    outputPath, format: rawFormat as "text" | "json",
  };
}
