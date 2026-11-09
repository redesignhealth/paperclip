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
  validateAndResolveTableIdentifier,
  validateOutputPath,
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
  if (!text) return "";
  let result = text;
  const secrets = new Set<string>();

  // 1. Identify URL candidates and redact credentials in-place.
  // Supports postgres://, postgresql:// and +driver variants like postgresql+asyncpg://
  const urlCandidateRegex = /(postgres(?:ql)?(?:\+[a-zA-Z0-9_.-]+)?:\/\/)([^\s"'<>]+)/g;
  result = result.replace(urlCandidateRegex, (_fullMatch, scheme, rest) => {
    // The authority ends at the first '/', '?', or '#'
    const pathIdx = rest.search(/[\/?#]/);
    const authority = pathIdx === -1 ? rest : rest.slice(0, pathIdx);
    const remainder = pathIdx === -1 ? "" : rest.slice(pathIdx);

    const lastAt = authority.lastIndexOf("@");
    if (lastAt === -1) {
      return scheme + authority + remainder;
    }

    const userinfo = authority.slice(0, lastAt);
    const hostPort = authority.slice(lastAt + 1);

    const colonIdx = userinfo.indexOf(":");
    let redactedUserinfo: string;
    if (colonIdx !== -1) {
      const user = userinfo.slice(0, colonIdx);
      const pass = userinfo.slice(colonIdx + 1);
      if (pass) {
        secrets.add(pass);
        try {
          secrets.add(decodeURIComponent(pass));
        } catch {}
      }
      redactedUserinfo = `${user}:***`;
    } else {
      secrets.add(userinfo);
      try {
        secrets.add(decodeURIComponent(userinfo));
      } catch {}
      redactedUserinfo = "***";
    }

    return `${scheme}${redactedUserinfo}@${hostPort}${remainder}`;
  });

  // 2. Redact query parameter passwords (?password=... or &password=...) anywhere in text
  const queryParamRegex = /([?&]password=)[^&#\s]*/gi;
  result = result.replace(queryParamRegex, (_m, prefix) => {
    return `${prefix}***`;
  });

  // 3. For any extracted secrets from URLs, only redact in arbitrary prose if length >= 8
  // to avoid corrupting diagnostic codes or normal English words with short passwords like 'a'
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && secret !== "***") {
      result = result.replaceAll(secret, "***");
    }
  }

  return result;
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
      console.error(`Error: Invalid --format. Must be "text" or "json".`);
      return 1;
    }
    const format = rawFormat as "text" | "json";

    const tableName = parseFlagValue("--table", argv) ?? "mem0_memories";

    const longThresholdStr = parseFlagValue("--long-threshold", argv);
    let longThreshold = 500;
    if (longThresholdStr !== null) {
      longThreshold = parseInt(longThresholdStr, 10);
      if (!Number.isInteger(longThreshold) || longThreshold <= 0 || String(longThreshold) !== longThresholdStr.trim()) {
        console.error("Error: Invalid --long-threshold. Must be a positive integer.");
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
          `Invalid ${flagName}. Must be a non-negative number.`,
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
    const message = sanitizeCliErrorMessage(error);
    console.error(`Error: ${message}`);
    return 1;
  }
}

export interface RunSweepCliDependencies extends SweepDependencies {}

const SWEEP_CLI_GENERIC_ERROR_MESSAGES: Record<string, string> = {
  // Census & Preflight codes
  NOT_PGVECTOR: "Target database is missing required vector extension or column is not a valid pgvector column.",
  not_pgvector: "Target database is missing required vector extension or column is not a valid pgvector column.",

  SUPERUSER_REJECTED: "Connecting role on database has superuser privileges. Dedicated non-superuser role required.",
  superuser_rejected: "Connecting role on database has superuser privileges. Dedicated non-superuser role required.",

  BYPASSRLS_REJECTED: "Connecting role on database has BYPASSRLS privileges. Dedicated role required.",
  bypassrls_rejected: "Connecting role on database has BYPASSRLS privileges. Dedicated role required.",

  EXCESSIVE_PRIVILEGE_REJECTED: "Connecting role on database has excessive privileges. Dedicated restricted role required.",
  excessive_privilege_rejected: "Connecting role on database has excessive privileges. Dedicated restricted role required.",

  TABLE_NOT_FOUND: "Mem0 collection table not found or has no columns in target database.",
  table_not_found: "Mem0 collection table not found or has no columns in target database.",

  SCHEMA_MISMATCH: "Mem0 collection table schema does not match required shape.",
  schema_mismatch: "Mem0 collection table schema does not match required shape.",

  EMBEDDING_DIMENSIONS_MISMATCH: "Mem0 collection embedding dimensions do not match expected 1536 dimensions.",
  embedding_dimensions_mismatch: "Mem0 collection embedding dimensions do not match expected 1536 dimensions.",

  CONTROL_PLANE_ROUTING_MISMATCH: "Company memory database routing mismatch between control plane and connected tenant.",
  control_plane_routing_mismatch: "Company memory database routing mismatch between control plane and connected tenant.",

  CONTROL_PLANE_UNREACHABLE: "Unable to reach control plane database.",
  control_plane_unreachable: "Unable to reach control plane database.",

  COMPANY_NOT_FOUND: "Target company record does not exist in control plane database.",
  company_not_found: "Target company record does not exist in control plane database.",

  COMPANY_DELETION_IN_PROGRESS: "Target company is undergoing deletion.",
  company_deletion_in_progress: "Target company is undergoing deletion.",

  ACTIVE_UPGRADE_EXISTS: "An active memory upgrade is already in progress for target company.",
  active_upgrade_exists: "An active memory upgrade is already in progress for target company.",

  UPGRADE_NOT_FOUND: "Upgrade record not found.",
  upgrade_not_found: "Upgrade record not found.",

  CONVERTER_CONTRACT_MISMATCH: "Upgrade record converter contract or collection mismatch.",
  converter_contract_mismatch: "Upgrade record converter contract or collection mismatch.",

  LEASE_FENCED_OUT: "Failed to acquire or maintain lease for upgrade. Another worker may hold the lease.",
  lease_fenced_out: "Failed to acquire or maintain lease for upgrade. Another worker may hold the lease.",

  LEASE_EXPIRED: "Upgrade lease has expired.",
  lease_expired: "Upgrade lease has expired.",

  LEASE_LAPSED: "Upgrade lease has lapsed.",
  lease_lapsed: "Upgrade lease has lapsed.",

  CAS_FAILED: "Failed to advance upgrade state.",
  cas_failed: "Failed to advance upgrade state.",

  INVALID_RECOVERY: "Upgrade cannot be recovered from current state.",
  invalid_recovery: "Upgrade cannot be recovered from current state.",

  INVALID_STATE: "Cannot update counters for upgrade: invalid state.",
  invalid_state: "Cannot update counters for upgrade: invalid state.",

  ILLEGAL_TRANSITION: "Illegal upgrade state transition.",
  illegal_transition: "Illegal upgrade state transition.",

  ROLLBACK_REFUSED: "Rollback refused from current state.",
  rollback_refused: "Rollback refused from current state.",

  UNSUPPORTED_SOURCE_ID: "Collection table contains source row with non-UUID id. Upgrade ledger requires valid UUID source IDs.",
  unsupported_source_id: "Collection table contains source row with non-UUID id. Upgrade ledger requires valid UUID source IDs.",

  ACTIVE_RUN_TIMEOUT: "Active heartbeat runs paused longer than limit.",
  active_run_timeout: "Active heartbeat runs paused longer than limit.",
  paused_too_long: "Active heartbeat runs paused longer than limit.",
  PAUSED_TOO_LONG: "Active heartbeat runs paused longer than limit.",

  DRAIN_TIMEOUT: "Drain timeout exceeded.",
  drain_timeout: "Drain timeout exceeded.",

  STAGING_WRITE_FAILED: "Failed to write to staging ledger.",
  staging_write_failed: "Failed to write to staging ledger.",

  PUBLISH_FAILED: "Failed to publish upgraded memories.",
  publish_failed: "Failed to publish upgraded memories.",

  VERIFICATION_FAILED: "Upgrade verification failed.",
  verification_failed: "Upgrade verification failed.",

  UNEXPECTED_FAILURE: "An unexpected error occurred during upgrade.",
  unexpected_failure: "An unexpected error occurred during upgrade.",

  SCHEMA_INIT_FAILED: "Failed to initialize upgrade tables in tenant schema.",
  schema_init_failed: "Failed to initialize upgrade tables in tenant schema.",

  MIGRATION_FAILED: "Upgrade migration failed.",
  migration_failed: "Upgrade migration failed.",

  SOURCE_READ_FAILED: "Failed to read sources from target collection table.",
  source_read_failed: "Failed to read sources from target collection table.",

  CONVERSION_FAILED: "Memory conversion failed.",
  conversion_failed: "Memory conversion failed.",

  EMBEDDING_FAILED: "Embedding generation failed.",
  embedding_failed: "Embedding generation failed.",

  ROLLBACK_FAILED: "Upgrade rollback failed.",
  rollback_failed: "Upgrade rollback failed.",

  ABORTED_BY_OPERATOR: "Upgrade aborted by operator.",
  aborted_by_operator: "Upgrade aborted by operator.",
};

const SAFE_COMPANY_BINDING_MISMATCH_MESSAGES = new Set([
  "No company_memory_databases record found for target company.",
  "Company memory database binding status is not ready (refusing pending, failed, deprovisioning, archived).",
  "Company memory database binding mismatch between control plane and connected tenant.",
  "Company memory database binding mismatch with derived credentials.",
  "Tenant database does not have vector extension or vector column enabled for company memory.",
]);

const SAFE_STATE_MISMATCH_MESSAGES = new Set([
  "Upgrade is in needs_recovery. Recovery/status/rollback are unavailable in this slice.",
  "Upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' before resuming sweep.",
  "Cannot run sweep: active upgrade is not in sweeping state.",
]);

const SAFE_OUTPUT_PATH_REJECTED_MESSAGES = new Set([
  "Refusing to write output inside repository. Memory reports contain sensitive identifiers. Use an external directory such as /tmp.",
  "Parent directory does not exist. The output parent directory must exist prior to execution.",
  "Refusing to write output inside repository via symlinked parent. Use an external directory such as /tmp.",
]);

const SAFE_INVALID_ARGUMENT_REGEXES = [
  /^Flag '--[a-z0-9-]+' requires a (usable|positive integer|non-negative integer) value\.$/,
  /^Boolean flag '--[a-z0-9-]+' does not take a value\.$/,
  /^Unknown option '--?[a-zA-Z0-9_-]+'\. Only [a-zA-Z0-9_ -]+ options are accepted\.$/,
  /^Invalid --[a-z0-9-]+\. Must be a non-negative number\.$/,
];

const SAFE_INVALID_ARGUMENT_EXACT_MESSAGES = new Set([
  "Invalid --company. Must be a valid UUID.",
  "Invalid --long-threshold. Must be a positive integer.",
  "Invalid --format. Must be \"text\" or \"json\".",
  "Invalid --operator-label. Must be 1-64 characters matching [A-Za-z0-9._:@-].",
  "Invalid --table value. Must be a valid bare identifier (e.g. \"mem0_memories\") or schema.identifier (e.g. \"public.mem0_memories\").",
  "Invalid database URL: URL must be a non-empty string.",
  "Invalid database URL: Unable to parse URL with standard WHATWG parser. Supported format: postgres://user:password@host:port/dbname",
  "Refusing to run census without --company <uuid> when control plane URL is not provided.",
  "Unable to infer company ID for memory database. Please supply --company <uuid>.",
  "Ambiguous company mapping: multiple company_memory_databases records found. Please supply --company <uuid>.",
]);

export function sanitizeCliErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const err = error as { code?: unknown; message?: unknown };
    const code = typeof err.code === "string" ? err.code : undefined;
    const rawMsg = typeof err.message === "string" ? err.message : "";

    if (code) {
      if (code === "COMPANY_BINDING_MISMATCH" || code === "company_binding_mismatch") {
        const msg = SAFE_COMPANY_BINDING_MISMATCH_MESSAGES.has(rawMsg)
          ? rawMsg
          : "Company memory database binding mismatch between control plane and connected tenant.";
        return `[${code}] ${msg}`;
      }

      if (code === "STATE_MISMATCH" || code === "state_mismatch") {
        const msg = SAFE_STATE_MISMATCH_MESSAGES.has(rawMsg)
          ? rawMsg
          : "Cannot run sweep: active upgrade is not in sweeping state.";
        return `[${code}] ${msg}`;
      }

      if (code === "OUTPUT_PATH_REJECTED" || code === "output_path_rejected") {
        const msg = SAFE_OUTPUT_PATH_REJECTED_MESSAGES.has(rawMsg)
          ? rawMsg
          : "Invalid --output path.";
        return `[${code}] ${msg}`;
      }

      if (code === "INVALID_ARGUMENT" || code === "invalid_argument") {
        const isSafe =
          SAFE_INVALID_ARGUMENT_EXACT_MESSAGES.has(rawMsg) ||
          SAFE_INVALID_ARGUMENT_REGEXES.some((re) => re.test(rawMsg));
        const msg = isSafe ? rawMsg : "Invalid command argument.";
        return `[${code}] ${msg}`;
      }

      if (code === "PROD_GUARD_ENFORCED" || code === "prod_guard_enforced") {
        return `[${code}] ${scrubDsnSecrets(rawMsg)}`;
      }

      if (code === "INVALID_DATABASE_URL" || code === "invalid_database_url") {
        return `[${code}] Invalid database URL. Must be a valid postgresql:// or postgres:// connection string.`;
      }

      if (code === "DATABASE_IDENTITY_UNAVAILABLE" || code === "database_identity_unavailable") {
        return `[${code}] Unable to determine current database and user identity from tenant connection.`;
      }

      const generic = SWEEP_CLI_GENERIC_ERROR_MESSAGES[code];
      if (generic) {
        return `[${code}] ${generic}`;
      }

      if (code === "EEXIST") {
        return "Output file already exists (flag 'wx' requires exclusive creation).";
      }
      if (code === "EACCES") {
        return "Permission denied writing output file.";
      }
      if (code === "ENOENT") {
        return "Output file path or parent directory not found.";
      }
      if (code === "ECONNREFUSED") {
        return "Database connection refused.";
      }
    }
  }

  return "[unexpected_failure] An unexpected error occurred during upgrade.";
}

export async function runSweepCli(
  argv: string[],
  deps: RunSweepCliDependencies = {},
): Promise<number> {
  try {
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

    validateNoUnknownFlags(argv, ALLOWED_SWEEP_FLAGS, "sweep");

    const env = deps.env ?? process.env;

    const databaseUrl =
      parseFlagValue("--database-url", argv) ??
      env.COMPANY_MEMORY_DATABASE_URL ??
      null;

    if (!databaseUrl) {
      console.error(
        "Error: Refusing to run sweep without explicit tenant --database-url (or COMPANY_MEMORY_DATABASE_URL env var).",
      );
      return 1;
    }

    const controlPlaneUrl =
      parseFlagValue("--control-plane-url", argv) ??
      env.CONTROL_PLANE_DATABASE_URL ??
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
    validateAndResolveTableIdentifier(tableName);

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
    if (operatorLabel !== null) {
      if (
        operatorLabel.length < 1 ||
        operatorLabel.length > 64 ||
        !/^[A-Za-z0-9._:@-]+$/.test(operatorLabel)
      ) {
        throw new CompanyMemoryUpgradeError(
          "Invalid --operator-label. Must be 1-64 characters matching [A-Za-z0-9._:@-].",
          "INVALID_ARGUMENT",
        );
      }
    }

    const outputPath =
      parseFlagValue("--output", argv) ??
      parseFlagValue("--out", argv) ??
      null;

    const repoRoot = deps.repoRoot ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    if (outputPath) {
      validateOutputPath(outputPath, repoRoot);
    }

    const rawFormat = (parseFlagValue("--format", argv) ?? "text").toLowerCase();
    if (rawFormat !== "text" && rawFormat !== "json") {
      console.error(`Error: Invalid --format. Must be "text" or "json".`);
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
    const message = sanitizeCliErrorMessage(error);
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
