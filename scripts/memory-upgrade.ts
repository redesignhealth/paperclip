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
  runCensus,
} from "../server/src/services/company-memory-upgrade/census.js";

export const STUB_SUBCOMMANDS = new Set([
  "sweep",
  "flip",
  "drain",
  "prune",
  "rollback",
  "recover",
  "status",
]);

export const ALLOWED_CENSUS_FLAGS = new Set([
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
  "--prod",
  "--help",
  "-h",
]);

export function parseFlagValue(name: string, argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        return null;
      }
      return next;
    }
    if (arg.startsWith(`${name}=`)) {
      const val = arg.slice(name.length + 1);
      if (!val || val.startsWith("-")) {
        return null;
      }
      return val;
    }
  }
  return null;
}

export function hasBooleanFlag(name: string, argv: string[]): boolean {
  return argv.includes(name);
}

export function validateNoUnknownFlags(argv: string[], allowedFlags: Set<string>): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("-")) {
      const flagName = arg.split("=")[0];
      if (!allowedFlags.has(flagName)) {
        throw new Error(`Unknown option '${flagName}'. Only read-only census options are accepted.`);
      }
    }
  }
}

export async function runCensusCli(argv: string[]): Promise<number> {
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

  validateNoUnknownFlags(argv, ALLOWED_CENSUS_FLAGS);

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
      throw new Error(`Invalid ${flagName} "${raw}". Must be a non-negative number.`);
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
    env: process.env,
  });

  if (outputPath) {
    console.error(`Census report written to ${outputPath} (mode 0600, exclusive create).`);
  }

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCensusTextReport(report));
  }

  return 0;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = argv.slice(2);
  const subcommand = args[0];

  if (!subcommand) {
    console.error("Usage: pnpm memory:upgrade <subcommand> [options]");
    console.error("Available subcommands: census");
    return 1;
  }

  if (subcommand === "census") {
    return await runCensusCli(args.slice(1));
  }

  if (STUB_SUBCOMMANDS.has(subcommand)) {
    console.error(`Error: Subcommand '${subcommand}' is not implemented yet.`);
    return 1;
  }

  console.error(`Error: Unknown subcommand '${subcommand}'.`);
  console.error("Available subcommands: census");
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
