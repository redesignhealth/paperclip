/**
 * CLI runner for tenant-isolated company memory upgrade operations (TECH-8191).
 *
 * Supported subcommands:
 *   census   - Strictly read-only census and conversion budget inspection.
 *
 * Future subcommands (sweep, flip, drain, prune, rollback, recover, status) are
 * plumbed to fail closed with "not implemented yet" until their PRs land.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatCensusTextReport,
  isValidUuid,
  runCensus,
} from "../server/src/services/company-memory-upgrade/census.js";
import {
  formatSweepTextReport,
  runSweep,
  type SweepDependencies,
} from "../server/src/services/company-memory-upgrade/sweep.js";
import { CompanyMemoryUpgradeError } from "../server/src/services/company-memory-upgrade/types.js";

export const STUB_SUBCOMMANDS = new Set([
  "flip",
  "drain",
  "prune",
  "rollback",
  "recover",
  "status",
]);

export const BOOLEAN_FLAGS = new Set([
  "--prod",
  "--help",
  "-h",
]);

export const VALUE_FLAGS = new Set([
  "--database-url",
  "--company",
  "--confirm",
  "--control-plane-url",
  "--output",
  "--out",
  "--format",
  "--table",
  "--long-threshold",
  "--chat-input-usd-per-mtok",
  "--chat-output-usd-per-mtok",
  "--embedding-usd-per-mtok",
  "--page-size",
  "--max-rows",
  "--pause-when-active-runs",
  "--active-run-poll-ms",
  "--max-pause-seconds",
  "--operator-label",
]);

export const ALLOWED_CENSUS_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  "--database-url",
  "--company",
  "--control-plane-url",
  "--output",
  "--out",
  "--format",
  "--table",
  "--long-threshold",
  "--chat-input-usd-per-mtok",
  "--chat-output-usd-per-mtok",
  "--embedding-usd-per-mtok",
]);

export const ALLOWED_SWEEP_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  "--database-url",
  "--control-plane-url",
  "--company",
  "--confirm",
  "--table",
  "--page-size",
  "--max-rows",
  "--pause-when-active-runs",
  "--active-run-poll-ms",
  "--max-pause-seconds",
  "--operator-label",
  "--output",
  "--out",
  "--format",
]);

export function scrubDsnSecrets(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/[^:@\s]+):[^@\s]+@/g, "$1:***@");
}

export function isNumericString(val: string): boolean {
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(val.trim());
}

export function isUsableFlagValue(val: string | undefined): boolean {
  if (val === undefined || val === "") return false;
  if (val.startsWith("--")) return false;
  if (BOOLEAN_FLAGS.has(val) || VALUE_FLAGS.has(val)) return false;
  if (val.startsWith("-") && !isNumericString(val)) return false;
  return true;
}

export function parseFlagValue(name: string, argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) {
      const next = argv[i + 1];
      if (!isUsableFlagValue(next)) {
        throw new CompanyMemoryUpgradeError(
          `Flag '${name}' requires a usable value.`,
          "INVALID_ARGUMENT",
        );
      }
      return next;
    }
    if (arg.startsWith(`${name}=`)) {
      const val = arg.slice(name.length + 1);
      if (!isUsableFlagValue(val)) {
        throw new CompanyMemoryUpgradeError(
          `Flag '${name}' requires a usable value.`,
          "INVALID_ARGUMENT",
        );
      }
      return val;
    }
  }
  return null;
}

export function hasBooleanFlag(name: string, argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) return true;
    if (arg.startsWith(`${name}=`)) {
      throw new CompanyMemoryUpgradeError(
        `Boolean flag '${name}' does not take a value.`,
        "INVALID_ARGUMENT",
      );
    }
    if (VALUE_FLAGS.has(arg)) {
      i++;
    }
  }
  return false;
}

export function validateNoUnknownFlags(
  argv: string[],
  allowedFlags: Set<string>,
  commandLabel: string = "read-only census",
): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [flagName, ...rest] = arg.split("=");
      if (!allowedFlags.has(flagName)) {
        throw new CompanyMemoryUpgradeError(
          `Unknown option '${flagName}'. Only ${commandLabel} options are accepted.`,
          "INVALID_ARGUMENT",
        );
      }
      if (BOOLEAN_FLAGS.has(flagName)) {
        if (rest.length > 0) {
          throw new CompanyMemoryUpgradeError(
            `Boolean flag '${flagName}' does not take a value.`,
            "INVALID_ARGUMENT",
          );
        }
      } else if (VALUE_FLAGS.has(flagName)) {
        if (rest.length > 0) {
          const val = rest.join("=");
          if (!isUsableFlagValue(val)) {
            throw new CompanyMemoryUpgradeError(
              `Flag '${flagName}' requires a usable value.`,
              "INVALID_ARGUMENT",
            );
          }
        } else {
          const next = argv[i + 1];
          if (!isUsableFlagValue(next)) {
            throw new CompanyMemoryUpgradeError(
              `Flag '${flagName}' requires a usable value.`,
              "INVALID_ARGUMENT",
            );
          }
          i++;
        }
      }
    } else if (arg.startsWith("-")) {
      if (!allowedFlags.has(arg)) {
        throw new CompanyMemoryUpgradeError(
          `Unknown option '${arg}'. Only ${commandLabel} options are accepted.`,
          "INVALID_ARGUMENT",
        );
      }
    }
  }
}

export interface RunCensusCliDependencies {
  /** @internal Test-only option forwarded to runCensus */
  _internalSkipVectorIdentityCheck?: boolean;
}

export async function runCensusCli(
  argv: string[],
  deps: RunCensusCliDependencies = {},
): Promise<number> {
  try {
    validateNoUnknownFlags(argv, ALLOWED_CENSUS_FLAGS);

    if (hasBooleanFlag("--help", argv) || hasBooleanFlag("-h", argv)) {
      console.log(`
Usage: pnpm memory:upgrade census --database-url <tenant-dsn> [options]

Strictly read-only preflight census and conversion budget inspection.
Connects in read-only mode and NEVER modifies any data or tables.

Required:
  --database-url <dsn>         Tenant PostgreSQL DSN (or COMPANY_MEMORY_DATABASE_URL env var)

Options:
  --company <uuid>             Target company UUID (verified against control plane if supplied;
                               required as operator assertion if control plane URL is omitted)
  --control-plane-url <dsn>    Paperclip control-plane DSN to verify company existence and routing
                               (or CONTROL_PLANE_DATABASE_URL env var)
  --output, --out <path>       Write census report to external path (mode 0600, exclusive create)
  --format <text|json>         Output format: human summary (text, default) or JSON (json)
  --table <name>               Target Mem0 collection table name (default: "mem0_memories")
  --long-threshold <number>    Character length threshold for long memory rows (default: 500)
  --chat-input-usd-per-mtok <num>   Override chat input price in USD per 1M tokens (or CHAT_INPUT_USD_PER_MTOK)
  --chat-output-usd-per-mtok <num>  Override chat output price in USD per 1M tokens (or CHAT_OUTPUT_USD_PER_MTOK)
  --embedding-usd-per-mtok <num>    Override embedding price in USD per 1M tokens (or EMBEDDING_USD_PER_MTOK)
  --prod                       Flag required when target host is non-localhost alongside
                               MEMORY_UPGRADE_ALLOW_PROD=1 environment variable.
                               Host locality is not proof of environment. A production database
                               reached over an SSH tunnel or port-forward presents as a local host
                               and will not trigger this gate.
  --help, -h                   Show this help message
`);
      return 0;
    }

    const databaseUrl =
      parseFlagValue("--database-url", argv) ??
      process.env.COMPANY_MEMORY_DATABASE_URL ??
      null;

    if (!databaseUrl) {
      console.error(
        "Error: Refusing to run census without explicit tenant --database-url (or COMPANY_MEMORY_DATABASE_URL env var).",
      );
      return 1;
    }

    const companyId = parseFlagValue("--company", argv);
    const controlPlaneUrl =
      parseFlagValue("--control-plane-url", argv) ??
      process.env.CONTROL_PLANE_DATABASE_URL ??
      null;

    const outputPath =
      parseFlagValue("--output", argv) ??
      parseFlagValue("--out", argv) ??
      null;

    const rawFormat = (parseFlagValue("--format", argv) ?? "text").toLowerCase();
    if (rawFormat !== "text" && rawFormat !== "json") {
      console.error(`Error: Invalid --format "${rawFormat}". Must be "text" or "json".`);
      return 1;
    }
    const format = rawFormat as "text" | "json";

    const tableName = parseFlagValue("--table", argv) ?? "mem0_memories";

    const longThresholdStr = parseFlagValue("--long-threshold", argv);
    let longThreshold = 500;
    if (longThresholdStr !== null) {
      longThreshold = parseInt(longThresholdStr, 10);
      if (!Number.isInteger(longThreshold) || longThreshold <= 0 || String(longThreshold) !== longThresholdStr.trim()) {
        console.error(`Error: Invalid --long-threshold "${longThresholdStr}". Must be a positive integer.`);
        return 1;
      }
    }

    const allowProd = hasBooleanFlag("--prod", argv);

    function parseOptionalPrice(flagName: string, envVal: string | undefined): number | undefined {
      const raw = parseFlagValue(flagName, argv) ?? envVal ?? null;
      if (raw === null) return undefined;
      const num = parseFloat(raw);
      if (!Number.isFinite(num) || Number.isNaN(num) || num < 0) {
        throw new CompanyMemoryUpgradeError(
          `Invalid ${flagName} "${raw}". Must be a non-negative number.`,
          "INVALID_ARGUMENT",
        );
      }
      return num;
    }

    const chatInputUsdPerMillion = parseOptionalPrice("--chat-input-usd-per-mtok", process.env.CHAT_INPUT_USD_PER_MTOK);
    const chatOutputUsdPerMillion = parseOptionalPrice("--chat-output-usd-per-mtok", process.env.CHAT_OUTPUT_USD_PER_MTOK);
    const embeddingUsdPerMillion = parseOptionalPrice("--embedding-usd-per-mtok", process.env.EMBEDDING_USD_PER_MTOK);

    const report = await runCensus({
      databaseUrl,
      companyId,
      controlPlaneUrl,
      outputPath,
      format,
      tableName,
      longThreshold,
      allowProd,
      chatInputUsdPerMillion,
      chatOutputUsdPerMillion,
      embeddingUsdPerMillion,
      _internalSkipVectorIdentityCheck: deps._internalSkipVectorIdentityCheck,
      env: process.env,
    });

    if (outputPath) {
      const resolvedPath = path.resolve(process.cwd(), outputPath);
      console.error(`Census report written to ${resolvedPath} (mode 0600, exclusive create).`);
    } else {
      if (format === "json") {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatCensusTextReport(report));
      }
    }

    return 0;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = scrubDsnSecrets(rawMessage);
    console.error(`Error: ${message}`);
    return 1;
  }
}

export interface RunSweepCliDependencies extends SweepDependencies {}

export async function runSweepCli(
  argv: string[],
  deps: RunSweepCliDependencies = {},
): Promise<number> {
  try {
    validateNoUnknownFlags(argv, ALLOWED_SWEEP_FLAGS, "sweep");

    if (hasBooleanFlag("--help", argv) || hasBooleanFlag("-h", argv)) {
      console.log(`
Usage: pnpm memory:upgrade sweep --database-url <tenant-dsn> --control-plane-url <cp-dsn> --company <uuid> --confirm <uuid> [options]

Classifies legacy Mem0 memory rows into the tenant upgrade ledger (TECH-8191).
Accesses the live collection table strictly read-only (SELECT ONLY).
Zero memories converted or published in this phase (conversion lands in PR3b).

Required:
  --database-url <dsn>           Tenant PostgreSQL DSN (or COMPANY_MEMORY_DATABASE_URL env var)
  --control-plane-url <dsn>      Paperclip control-plane DSN (or CONTROL_PLANE_DATABASE_URL env var)
  --company <uuid>               Target company UUID
  --confirm <uuid>               Confirmation of target company UUID (must strictly equal --company)

Options:
  --table <name>                 Target Mem0 collection table name (default: "mem0_memories")
  --page-size <int>              Keyset page size for scanning sources (default: 1000)
  --max-rows <int>               Maximum number of live source rows to scan
  --pause-when-active-runs <n>   Active run threshold to pause sweep (default: 1, 0 to disable)
  --active-run-poll-ms <int>     Active run polling interval in milliseconds (default: 15000)
  --max-pause-seconds <int>      Maximum total pause time allowed before failing (default: 0 = unbounded)
  --operator-label <text>        Operator-provided label for upgrade record identification
  --output, --out <path>         Write sweep report to external path (mode 0600, exclusive create)
  --format <text|json>           Output format: human summary (text, default) or JSON (json)
  --prod                         Flag required alongside MEMORY_UPGRADE_ALLOW_PROD=1 when target host is non-localhost
  --help, -h                     Show this help message
`);
      return 0;
    }

    const databaseUrl =
      parseFlagValue("--database-url", argv) ??
      process.env.COMPANY_MEMORY_DATABASE_URL ??
      null;

    if (!databaseUrl) {
      console.error(
        "Error: Refusing to run sweep without explicit tenant --database-url (or COMPANY_MEMORY_DATABASE_URL env var).",
      );
      return 1;
    }

    const controlPlaneUrl =
      parseFlagValue("--control-plane-url", argv) ??
      process.env.CONTROL_PLANE_DATABASE_URL ??
      null;

    if (!controlPlaneUrl) {
      console.error(
        "Error: Refusing to run sweep without explicit control plane --control-plane-url (or CONTROL_PLANE_DATABASE_URL env var).",
      );
      return 1;
    }

    const companyId = parseFlagValue("--company", argv);
    if (!companyId) {
      console.error("Error: Flag --company <uuid> is required for sweep.");
      return 1;
    }

    const confirmId = parseFlagValue("--confirm", argv);
    if (!confirmId) {
      console.error("Error: Flag --confirm <uuid> is required for sweep.");
      return 1;
    }

    if (companyId !== confirmId) {
      console.error("Error: Flag --confirm <uuid> must strictly match --company <uuid>.");
      return 1;
    }

    if (!isValidUuid(companyId)) {
      console.error("Error: Flag --company must be a valid UUID.");
      return 1;
    }

    const tableName = parseFlagValue("--table", argv) ?? "mem0_memories";

    function parsePositiveInt(name: string, defaultVal?: number): number | undefined {
      const raw = parseFlagValue(name, argv);
      if (raw === null) return defaultVal;
      const num = parseInt(raw, 10);
      if (!Number.isInteger(num) || num <= 0 || String(num) !== raw.trim()) {
        throw new CompanyMemoryUpgradeError(
          `Flag '${name}' requires a positive integer value.`,
          "INVALID_ARGUMENT",
        );
      }
      return num;
    }

    function parseNonNegativeInt(name: string, defaultVal?: number): number | undefined {
      const raw = parseFlagValue(name, argv);
      if (raw === null) return defaultVal;
      const num = parseInt(raw, 10);
      if (!Number.isInteger(num) || num < 0 || String(num) !== raw.trim()) {
        throw new CompanyMemoryUpgradeError(
          `Flag '${name}' requires a non-negative integer value.`,
          "INVALID_ARGUMENT",
        );
      }
      return num;
    }

    const pageSize = parsePositiveInt("--page-size", 1000);
    const maxRows = parsePositiveInt("--max-rows", undefined);
    const pauseWhenActiveRuns = parseNonNegativeInt("--pause-when-active-runs", 1);
    const activeRunPollMs = parsePositiveInt("--active-run-poll-ms", 15_000);
    const maxPauseSeconds = parseNonNegativeInt("--max-pause-seconds", 0);
    const operatorLabel = parseFlagValue("--operator-label", argv);

    const outputPath =
      parseFlagValue("--output", argv) ??
      parseFlagValue("--out", argv) ??
      null;

    const rawFormat = (parseFlagValue("--format", argv) ?? "text").toLowerCase();
    if (rawFormat !== "text" && rawFormat !== "json") {
      console.error(`Error: Invalid --format "${rawFormat}". Must be "text" or "json".`);
      return 1;
    }
    const format = rawFormat as "text" | "json";

    const allowProd = hasBooleanFlag("--prod", argv);

    const report = await runSweep(
      {
        databaseUrl,
        controlPlaneUrl,
        companyId,
        tableName,
        pageSize,
        maxRows,
        pauseWhenActiveRuns,
        activeRunPollMs,
        maxPauseSeconds,
        operatorLabel,
        allowProd,
        outputPath,
        format,
      },
      deps,
    );

    if (outputPath) {
      const resolvedPath = path.resolve(process.cwd(), outputPath);
      console.error(`Sweep report written to ${resolvedPath} (mode 0600, exclusive create).`);
    } else {
      if (format === "json") {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatSweepTextReport(report));
      }
    }

    return 0;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = scrubDsnSecrets(rawMessage);
    console.error(`Error: ${message}`);
    return 1;
  }
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = argv.slice(2);
  const subcommand = args[0];

  if (!subcommand) {
    console.error("Usage: pnpm memory:upgrade <subcommand> [options]");
    console.error("Available subcommands: census, sweep");
    return 1;
  }

  if (subcommand === "census") {
    return await runCensusCli(args.slice(1));
  }

  if (subcommand === "sweep") {
    return await runSweepCli(args.slice(1));
  }

  if (STUB_SUBCOMMANDS.has(subcommand)) {
    console.error(`Error: Subcommand '${subcommand}' is not implemented yet.`);
    return 1;
  }

  if (/^[a-z-]+$/.test(subcommand)) {
    console.error(`Error: Unknown subcommand '${subcommand}'.`);
  } else {
    console.error("Error: Unknown subcommand.");
  }
  console.error("Usage: pnpm memory:upgrade <subcommand> [options]");
  console.error("Available subcommands: census, sweep");
  return 1;
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main()
    .then((exitCode) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    });
}
