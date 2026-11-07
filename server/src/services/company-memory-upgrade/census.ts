/**
 * Strictly read-only Census and Budget Inspection for live Mem0 memory upgrade (TECH-8191).
 *
 * CRITICAL ARCHITECTURAL CONTRACT:
 * - Read-only: Runs under a single connection with SET TRANSACTION READ ONLY.
 * - Fail-closed: Superusers, BYPASSRLS roles, and unhardened environments are rejected.
 * - Zero Memory Text in Output: JSON reports, logs, and text summaries MUST NEVER include memory text.
 * - Single-tenant Scoping: Explicit tenant database URL required; never falls back to control plane.
 */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@paperclipai/db";
import { INVOKABLE_AGENT_STATUSES } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  adapterSupportsRuntimeMemory,
  deriveCompanyMemoryDatabaseNames,
} from "../company-memory-constants.js";
import {
  classifyMemoryNoise,
} from "./classify-noise.js";
import {
  detectSensitiveFamilies,
  type SensitiveFamilyName,
} from "./sensitive-patterns.js";
import {
  CONVERSION_BUDGET_CONSTANTS,
  estimateConversionBudget,
  type ConversionBudgetEstimate,
} from "./budget.js";
import { CompanyMemoryUpgradeError } from "./types.js";

const SAFE_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(val: unknown): boolean {
  return typeof val === "string" && UUID_REGEX.test(val.trim());
}

export function validateAndResolveTableIdentifier(
  tableName: string,
  sqlTag: typeof sql = sql,
): { fragment: any; schema: string | null; bareTable: string; regclassArg: string } {
  if (tableName.includes(".")) {
    const parts = tableName.split(".");
    if (parts.length !== 2 || !SAFE_IDENTIFIER_REGEX.test(parts[0]) || !SAFE_IDENTIFIER_REGEX.test(parts[1])) {
      throw new CompanyMemoryUpgradeError(
        `Invalid --table value: "${tableName}". Must be a valid bare identifier (e.g. "mem0_memories") or schema.identifier (e.g. "public.mem0_memories").`,
        "INVALID_ARGUMENT",
      );
    }
    return {
      fragment: sqlTag`${sqlTag.identifier(parts[0])}.${sqlTag.identifier(parts[1])}`,
      schema: parts[0],
      bareTable: parts[1],
      regclassArg: `"${parts[0].replace(/"/g, '""')}"."${parts[1].replace(/"/g, '""')}"`,
    };
  }

  if (!SAFE_IDENTIFIER_REGEX.test(tableName)) {
    throw new CompanyMemoryUpgradeError(
      `Invalid --table value: "${tableName}". Must be a valid bare identifier (e.g. "mem0_memories") or schema.identifier (e.g. "public.mem0_memories").`,
      "INVALID_ARGUMENT",
    );
  }

  return {
    fragment: sqlTag`${sqlTag.identifier(tableName)}`,
    schema: null,
    bareTable: tableName,
    regclassArg: `"${tableName.replace(/"/g, '""')}"`,
  };
}

export function isPathInside(targetPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, targetPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function validateOutputPath(outPath: string, repoRootPath?: string): string {
  const resolvedOutPath = path.resolve(process.cwd(), outPath);
  const repoRoot = repoRootPath ?? path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

  let realRepoRoot = repoRoot;
  try {
    realRepoRoot = realpathSync(repoRoot);
  } catch {
    // fallback if repoRoot cannot be resolved with realpath
  }

  if (isPathInside(resolvedOutPath, repoRoot) || isPathInside(resolvedOutPath, realRepoRoot)) {
    throw new CompanyMemoryUpgradeError(
      `Refusing to write output inside repository (${resolvedOutPath}). Memory census reports contain sensitive identifiers. Use an external directory such as /tmp.`,
      "OUTPUT_PATH_REJECTED",
    );
  }

  const parentDir = path.dirname(resolvedOutPath);
  if (!existsSync(parentDir)) {
    throw new CompanyMemoryUpgradeError(
      `Parent directory does not exist: "${parentDir}". The output parent directory must exist prior to running census.`,
      "OUTPUT_PATH_REJECTED",
    );
  }

  const realParentDir = realpathSync(parentDir);
  const simulatedTargetPath = path.resolve(realParentDir, path.basename(resolvedOutPath));
  if (isPathInside(simulatedTargetPath, repoRoot) || isPathInside(simulatedTargetPath, realRepoRoot)) {
    throw new CompanyMemoryUpgradeError(
      `Refusing to write output inside repository via symlinked parent (${resolvedOutPath}). Use an external directory such as /tmp.`,
      "OUTPUT_PATH_REJECTED",
    );
  }

  return resolvedOutPath;
}

export function normalizeMemoryContent(text: string | null | undefined): string {
  if (!text) return "";
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function redactPayloadIdentifier(val: string | null | undefined, allowCompany: boolean = false): string | null {
  if (val === null || val === undefined) return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  if (trimmed === "(none)") return "(none)";
  const lower = trimmed.toLowerCase();
  if (isValidUuid(lower)) {
    return lower;
  }
  if (allowCompany && lower === "company") {
    return "company";
  }
  const hash12 = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
  return `sha256:${hash12} (len ${trimmed.length})`;
}

export interface CensusRowData {
  id: string;
  agent_id: string | null;
  user_id: string | null;
  data: string | null;
  created_at: string | null;
}

export interface AgentTracking {
  total: number;
  noise: number;
  textHashMap: Map<string, number>; // textHash -> count for non-noise rows
}

export interface CensusAccumulator {
  longThreshold: number;
  totalScannedRows: number;
  userMap: Map<string, number>;
  agentMap: Map<string, number>;
  agentTracking: Map<string, AgentTracking>;
  missingOrBlankAgentIdCount: number;
  nonUuidAgentIdCount: number;
  createdAtHistogram: Record<string, number>;
  charLengths: number[];
  totalCharLength: number;
  longerThanThresholdCount: number;
  noiseCandidateCount: number;
  sensitiveCandidateCount: number;
  sensitiveFamilyBreakdown: Record<SensitiveFamilyName, number>;
}

export function createCensusAccumulator(longThreshold: number = 500): CensusAccumulator {
  return {
    longThreshold,
    totalScannedRows: 0,
    userMap: new Map(),
    agentMap: new Map(),
    agentTracking: new Map(),
    missingOrBlankAgentIdCount: 0,
    nonUuidAgentIdCount: 0,
    createdAtHistogram: {},
    charLengths: [],
    totalCharLength: 0,
    longerThanThresholdCount: 0,
    noiseCandidateCount: 0,
    sensitiveCandidateCount: 0,
    sensitiveFamilyBreakdown: {
      privateKey: 0,
      bearerToken: 0,
      apiKey: 0,
      ssn: 0,
      creditCard: 0,
      passwordAssignment: 0,
    },
  };
}

export function accumulateCensusRow(acc: CensusAccumulator, row: CensusRowData): void {
  acc.totalScannedRows++;

  // User ID aggregation
  const rawUserId = row.user_id ? row.user_id.trim() : "";
  const userIdKey = rawUserId || "(none)";
  acc.userMap.set(userIdKey, (acc.userMap.get(userIdKey) ?? 0) + 1);

  // Agent ID aggregation & hygiene (lowercase + trim)
  const rawAgentId = row.agent_id ? row.agent_id.trim().toLowerCase() : "";
  const agentKey = rawAgentId || "(none)";
  acc.agentMap.set(agentKey, (acc.agentMap.get(agentKey) ?? 0) + 1);

  if (!rawAgentId) {
    acc.missingOrBlankAgentIdCount++;
  } else if (!isValidUuid(rawAgentId)) {
    acc.nonUuidAgentIdCount++;
  }

  // Created at monthly histogram
  const rawCreatedAt = row.created_at ? row.created_at.trim() : "";
  let monthBucket = "unparseable";
  if (rawCreatedAt) {
    const parsedDate = new Date(rawCreatedAt);
    if (!isNaN(parsedDate.getTime())) {
      const yyyy = parsedDate.getUTCFullYear();
      const mm = String(parsedDate.getUTCMonth() + 1).padStart(2, "0");
      monthBucket = `${yyyy}-${mm}`;
    }
  }
  acc.createdAtHistogram[monthBucket] = (acc.createdAtHistogram[monthBucket] ?? 0) + 1;

  // Memory text length & noise & duplicates & sensitive
  const memoryText = row.data ?? "";
  const textLength = memoryText.length;
  acc.charLengths.push(textLength);
  acc.totalCharLength += textLength;
  if (textLength > acc.longThreshold) {
    acc.longerThanThresholdCount++;
  }

  // Agent-level tracking for noise and non-noise duplicates
  let tracking = acc.agentTracking.get(agentKey);
  if (!tracking) {
    tracking = { total: 0, noise: 0, textHashMap: new Map() };
    acc.agentTracking.set(agentKey, tracking);
  }
  tracking.total++;

  // Deterministic noise
  const isNoise = classifyMemoryNoise(memoryText);
  if (isNoise) {
    acc.noiseCandidateCount++;
    tracking.noise++;
  } else {
    // Only NON-noise rows are tracked for duplicate surplus!
    const normalized = normalizeMemoryContent(memoryText);
    const textHash = createHash("sha256").update(normalized).digest("hex");
    const prevCount = tracking.textHashMap.get(textHash) ?? 0;
    tracking.textHashMap.set(textHash, prevCount + 1);
  }

  // Sensitive detection: count only!
  const sensitiveRes = detectSensitiveFamilies(memoryText);
  if (sensitiveRes.isSensitive) {
    acc.sensitiveCandidateCount++;
    for (const [fam, hit] of Object.entries(sensitiveRes.matches) as Array<[SensitiveFamilyName, boolean]>) {
      if (hit) {
        acc.sensitiveFamilyBreakdown[fam]++;
      }
    }
  }
}

export function finalizeCensusCounts(acc: CensusAccumulator, totalRows: number): CensusCounts {
  let duplicateGroups = 0;
  let surplusRows = 0;

  for (const tracking of acc.agentTracking.values()) {
    for (const count of tracking.textHashMap.values()) {
      if (count > 1) {
        duplicateGroups++;
        surplusRows += count - 1;
      }
    }
  }

  acc.charLengths.sort((a, b) => a - b);
  const avgLen = acc.charLengths.length > 0
    ? Math.round((acc.totalCharLength / acc.charLengths.length) * 10) / 10
    : 0;
  const medianLen = acc.charLengths.length > 0
    ? acc.charLengths[Math.floor(acc.charLengths.length * 0.5)]
    : 0;
  const p95Len = acc.charLengths.length > 0
    ? acc.charLengths[Math.min(acc.charLengths.length - 1, Math.floor(acc.charLengths.length * 0.95))]
    : 0;

  const sanitizedUserMap = new Map<string, number>();
  for (const [userId, count] of acc.userMap.entries()) {
    const safeUserId = redactPayloadIdentifier(userId, true) ?? "(none)";
    sanitizedUserMap.set(safeUserId, (sanitizedUserMap.get(safeUserId) ?? 0) + count);
  }

  const sortedUsers = Array.from(sanitizedUserMap.entries())
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count);

  const topUsers = sortedUsers.slice(0, 10);
  const longTailCount = sortedUsers.slice(10).reduce((a, b) => a + b.count, 0);

  const sanitizedAgentMap = new Map<string | null, number>();
  for (const [agentId, count] of acc.agentMap.entries()) {
    const safeAgentId = agentId === "(none)" ? null : redactPayloadIdentifier(agentId, false);
    sanitizedAgentMap.set(safeAgentId, (sanitizedAgentMap.get(safeAgentId) ?? 0) + count);
  }

  const agentBreakdown = Array.from(sanitizedAgentMap.entries())
    .map(([agentId, count]) => ({ agentId, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalRows,
    distinctUserIds: acc.userMap.size,
    distinctAgentIds: acc.agentMap.size,
    userBreakdown: {
      top: topUsers,
      longTailCount,
    },
    agentBreakdown,
    agentIdHygiene: {
      missingOrBlankCount: acc.missingOrBlankAgentIdCount,
      nonUuidCount: acc.nonUuidAgentIdCount,
      totalMalformedOrMissingCount: acc.missingOrBlankAgentIdCount + acc.nonUuidAgentIdCount,
    },
    createdAtHistogram: acc.createdAtHistogram,
    contentLength: {
      average: avgLen,
      median: medianLen,
      p95: p95Len,
      threshold: acc.longThreshold,
      longerThanThresholdCount: acc.longerThanThresholdCount,
    },
    duplicates: {
      duplicateGroups,
      surplusRows,
    },
    noise: {
      candidateCount: acc.noiseCandidateCount,
    },
    sensitive: {
      candidateCount: acc.sensitiveCandidateCount,
      familyBreakdown: acc.sensitiveFamilyBreakdown,
    },
  };
}

export interface CensusOptions {
  databaseUrl: string;
  companyId?: string | null;
  controlPlaneUrl?: string | null;
  outputPath?: string | null;
  format?: "text" | "json";
  tableName?: string;
  longThreshold?: number;
  pageSize?: number;
  allowProd?: boolean;
  chatInputUsdPerMillion?: number;
  chatOutputUsdPerMillion?: number;
  embeddingUsdPerMillion?: number;
  /** @internal Test-only seam to bypass pgvector catalog identity check when running against embedded PG without pgvector. */
  _internalSkipVectorIdentityCheck?: boolean;
  /** @internal Test-only seam to override database and user identity to simulate empty/null results. */
  _internalDatabaseIdentityOverride?: { database?: string | null; user?: string | null };
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  onTransaction?: (tx: any) => Promise<void> | void;
}

export interface ShapeIntrospectionResult {
  table: string;
  embeddingColumn: string;
  embeddingDims: number;
  embeddingType: string;
  payloadType: "jsonb" | "json";
  rowCount: number;
}

export interface AgentRoutingClassification {
  id: string;
  name: string | null;
  adapterType: string | null;
  status: string | null;
  classification: "routable" | "routable_but_paused" | "unroutable";
  reason?: string;
}

export type UnroutableReason =
  | "missing_agent_id"
  | "malformed_agent_id"
  | "unknown_agent"
  | "non_memory_adapter"
  | "terminated"
  | "pending_approval"
  | "unknown_status";

export interface UnroutableReasonSummary {
  rowCount: number;
  distinctAgentCount: number;
  agentIds: string[];
}

export interface RoutingReadinessResult {
  status: "verified" | "unverified";
  caveat?: string;
  counts: {
    agents: {
      routable: number | null;
      routable_but_paused: number | null;
      unroutable: number | null;
    };
    rows: {
      routable: number | null;
      routable_but_paused: number | null;
      unroutable: number | null;
    };
  };
  unroutableBreakdown: Record<UnroutableReason, UnroutableReasonSummary>;
  unroutableAgentIds: string[];
}

export interface CensusCounts {
  totalRows: number;
  distinctUserIds: number;
  distinctAgentIds: number;
  userBreakdown: {
    top: Array<{ userId: string; count: number }>;
    longTailCount: number;
  };
  agentBreakdown: Array<{ agentId: string | null; count: number }>;
  agentIdHygiene: {
    missingOrBlankCount: number;
    nonUuidCount: number;
    totalMalformedOrMissingCount: number;
  };
  createdAtHistogram: Record<string, number>;
  contentLength: {
    average: number;
    median: number;
    p95: number;
    threshold: number;
    longerThanThresholdCount: number;
  };
  duplicates: {
    duplicateGroups: number;
    surplusRows: number;
  };
  noise: {
    candidateCount: number;
  };
  sensitive: {
    candidateCount: number;
    familyBreakdown: Record<SensitiveFamilyName, number>;
  };
}

export interface CensusReport {
  schemaVersion: "1.0";
  generatedAt: string;
  readOnly: true;
  tenantDatabase: {
    databaseName: string;
    host: string;
    port: number;
    user: string;
  };
  company: {
    id: string;
    name?: string | null;
    verification: "control-plane-verified" | "derived-name-verified" | "operator-asserted" | "unbound";
  };
  shapeIntrospection: ShapeIntrospectionResult;
  census: CensusCounts;
  routing: RoutingReadinessResult;
  budget: ConversionBudgetEstimate;
  caveats: string[];
}

export function validateDatabaseUrl(
  urlString: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { allowProd?: boolean } = {},
): URL {
  if (!urlString || typeof urlString !== "string" || !urlString.trim()) {
    throw new CompanyMemoryUpgradeError(
      "Invalid database URL: URL must be a non-empty string.",
      "INVALID_ARGUMENT",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new CompanyMemoryUpgradeError(
      "Invalid database URL: Unable to parse URL with standard WHATWG parser. Supported format: postgres://user:password@host:port/dbname",
      "INVALID_ARGUMENT",
    );
  }

  // Remote database prod gate:
  const host = parsed.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!isLocal) {
    const hasProdFlag = Boolean(options.allowProd);
    const hasProdEnv = env.MEMORY_UPGRADE_ALLOW_PROD === "1";
    if (!hasProdFlag && !hasProdEnv) {
      throw new CompanyMemoryUpgradeError(
        `Refusing to connect to non-local host '${host}' without --prod flag and MEMORY_UPGRADE_ALLOW_PROD=1 environment variable.`,
        "PROD_GUARD_ENFORCED",
      );
    }
    if (!hasProdFlag) {
      throw new CompanyMemoryUpgradeError(
        `Refusing to connect to non-local host '${host}' without --prod flag.`,
        "PROD_GUARD_ENFORCED",
      );
    }
    if (!hasProdEnv) {
      throw new CompanyMemoryUpgradeError(
        `Refusing to connect to non-local host '${host}' without MEMORY_UPGRADE_ALLOW_PROD=1 environment variable.`,
        "PROD_GUARD_ENFORCED",
      );
    }
  }

  return parsed;
}

export async function assertNonSuperuserAndRestrictedRole(
  tx: any,
  connectionLabel: "tenant" | "control-plane",
): Promise<void> {
  const roleRows = (await tx.execute(sql`
    SELECT
      r.rolname,
      r.rolsuper,
      r.rolbypassrls,
      r.rolcreaterole,
      r.rolreplication,
      (r.rolname = current_user) AS is_self,
      pg_has_role(current_user, r.oid, 'MEMBER') AS is_member
    FROM pg_roles r
    WHERE (
      r.rolname = current_user
      OR pg_has_role(current_user, r.oid, 'MEMBER')
    )
    AND (
      r.rolsuper
      OR r.rolbypassrls
      OR r.rolcreaterole
      OR r.rolreplication
      OR r.rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_read_all_settings')
    );
  `)) as unknown as Array<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    is_self: boolean;
    is_member: boolean;
  }>;

  if (roleRows.length > 0) {
    const superOffender = roleRows.find((r) => r.rolsuper);
    if (superOffender) {
      throw new CompanyMemoryUpgradeError(
        `Refusing to run memory upgrade census: connecting role on ${connectionLabel} database is a superuser or member of superuser role '${superOffender.rolname}'. Dedicated non-superuser role required.`,
        "SUPERUSER_REJECTED",
      );
    }
    const bypassOffender = roleRows.find((r) => r.rolbypassrls);
    if (bypassOffender) {
      throw new CompanyMemoryUpgradeError(
        `Refusing to run memory upgrade census: connecting role on ${connectionLabel} database has or inherits BYPASSRLS privilege from role '${bypassOffender.rolname}'. Dedicated role required.`,
        "BYPASSRLS_REJECTED",
      );
    }
    const offender = roleRows[0];
    throw new CompanyMemoryUpgradeError(
      `Refusing to run memory upgrade census: connecting role on ${connectionLabel} database has excessive privilege or membership in role '${offender.rolname}'. Dedicated restricted role required.`,
      "EXCESSIVE_PRIVILEGE_REJECTED",
    );
  }
}

export async function runCensus(options: CensusOptions): Promise<CensusReport> {
  const {
    databaseUrl,
    companyId: inputCompanyId,
    controlPlaneUrl,
    outputPath,
    format = "text",
    tableName = "mem0_memories",
    longThreshold = 500,
    pageSize: inputPageSize,
    allowProd = false,
    _internalSkipVectorIdentityCheck = false,
    env = process.env,
    repoRoot,
    onTransaction,
  } = options;

  if (inputCompanyId !== undefined && inputCompanyId !== null) {
    if (!isValidUuid(inputCompanyId)) {
      throw new CompanyMemoryUpgradeError(
        `Invalid --company "${inputCompanyId}". Must be a valid UUID.`,
        "INVALID_ARGUMENT",
      );
    }
  }

  const parsedTenantUrl = validateDatabaseUrl(databaseUrl, env, { allowProd });
  const tenantDbName = parsedTenantUrl.pathname.replace(/^\//, "");
  const tenantTable = validateAndResolveTableIdentifier(tableName, sql);

  if (outputPath) {
    validateOutputPath(outputPath, repoRoot);
  }

  const caveats: string[] = [
    "READ-ONLY RUN: No data was written, modified, or migrated.",
    "Host locality is not proof of environment. A production database reached over an SSH tunnel or port-forward presents as a local host and will not trigger this gate.",
  ];

  // Preflight connection to tenant database: single connection, read-only
  const tenantDb = createDb(databaseUrl, { maxConnections: 1 });

  let currentDatabase = "";
  let currentUser = "";
  let shape: ShapeIntrospectionResult | null = null;
  let counts: CensusCounts | null = null;
  let accumulator: CensusAccumulator | null = null;

  try {
    await tenantDb.transaction(
      async (tx) => {
        // 1. Role preflight on tenant connection (executes first query and establishes transaction snapshot)
        await assertNonSuperuserAndRestrictedRole(tx, "tenant");

        if (onTransaction) {
          await onTransaction(tx);
        }

        // 2. Fetch current_database() and current_user
        const dbInfoRows = (await tx.execute<{ current_database: string; current_user: string }>(sql`
          SELECT current_database()::text AS current_database, current_user::text AS current_user;
        `)) as unknown as Array<{ current_database: string; current_user: string }>;

        if (options._internalDatabaseIdentityOverride) {
          currentDatabase = (options._internalDatabaseIdentityOverride.database ?? "").trim();
          currentUser = (options._internalDatabaseIdentityOverride.user ?? "").trim();
        } else {
          currentDatabase = (dbInfoRows[0]?.current_database ?? "").trim();
          currentUser = (dbInfoRows[0]?.current_user ?? "").trim();
        }

        if (!currentDatabase || !currentUser) {
          throw new CompanyMemoryUpgradeError(
            "Unable to determine current database and user identity from tenant connection.",
            "DATABASE_IDENTITY_UNAVAILABLE",
          );
        }

        const pcmemPattern = /^pcmem_[0-9a-f]{32}$/;
        if (pcmemPattern.test(currentDatabase) && inputCompanyId) {
          const derived = deriveCompanyMemoryDatabaseNames(inputCompanyId);
          if (currentDatabase !== derived.databaseName || currentUser !== derived.databaseRole) {
            throw new CompanyMemoryUpgradeError(
              `Company binding mismatch: tenant database "${currentDatabase}" and role "${currentUser}" do not match expected derived database "${derived.databaseName}" and role "${derived.databaseRole}" for company "${inputCompanyId}".`,
              "COMPANY_BINDING_MISMATCH",
            );
          }
        }

        // 3. Shape introspection: introspect columns in target table
        const columnRows = (await tx.execute(sql`
          SELECT
            a.attname,
            format_type(a.atttypid, a.atttypmod) AS formatted_type,
            a.atttypmod,
            t.typname,
            t.typtype,
            nsp.nspname AS typnamespace,
            ext.extname AS extension_name
          FROM pg_attribute a
          JOIN pg_type t ON a.atttypid = t.oid
          JOIN pg_namespace nsp ON t.typnamespace = nsp.oid
          LEFT JOIN pg_depend dep ON dep.objid = t.oid
            AND dep.classid = 'pg_type'::regclass
            AND dep.deptype = 'e'
          LEFT JOIN pg_extension ext ON dep.refobjid = ext.oid
            AND dep.refclassid = 'pg_extension'::regclass
          WHERE a.attrelid = to_regclass(${tenantTable.regclassArg})
            AND a.attnum > 0
            AND NOT a.attisdropped;
        `)) as unknown as Array<{
          attname: string;
          formatted_type: string;
          atttypmod: number;
          typname: string;
          typtype: string;
          typnamespace: string;
          extension_name: string | null;
        }>;

        if (columnRows.length === 0) {
          throw new CompanyMemoryUpgradeError(
            `Table "${tableName}" not found or has no columns in target database.`,
            "TABLE_NOT_FOUND",
          );
        }

        const colMap = new Map<string, (typeof columnRows)[number]>();
        for (const row of columnRows) {
          colMap.set(row.attname, row);
        }

        // Check expected columns: id, payload, and vector/embedding
        const idCol = colMap.get("id");
        if (!idCol) {
          throw new CompanyMemoryUpgradeError(
            `Mem0 table "${tableName}" is missing required "id" primary key column.`,
            "SCHEMA_MISMATCH",
          );
        }

        const idType = idCol.typname.toLowerCase();
        if (idType !== "uuid" && idType !== "text") {
          throw new CompanyMemoryUpgradeError(
            `Mem0 table "${tableName}" primary key column "id" must be type uuid or text, found "${idCol.formatted_type}".`,
            "SCHEMA_MISMATCH",
          );
        }
        const isUuidId = idType === "uuid";

        const payloadCol = colMap.get("payload");
        if (!payloadCol) {
          throw new CompanyMemoryUpgradeError(
            `Mem0 table "${tableName}" is missing required "payload" column.`,
            "SCHEMA_MISMATCH",
          );
        }

        const payloadType = payloadCol.formatted_type.toLowerCase();
        if (payloadType !== "jsonb" && payloadType !== "json") {
          throw new CompanyMemoryUpgradeError(
            `Mem0 table "${tableName}" payload column must be json or jsonb, found "${payloadType}".`,
            "SCHEMA_MISMATCH",
          );
        }

        const vectorColName = colMap.has("vector")
          ? "vector"
          : colMap.has("embedding")
            ? "embedding"
            : null;

        if (!vectorColName) {
          throw new CompanyMemoryUpgradeError(
            `Mem0 table "${tableName}" is missing required vector/embedding column (expected "vector" or "embedding").`,
            "SCHEMA_MISMATCH",
          );
        }

        const vectorCol = colMap.get(vectorColName)!;

        if (!_internalSkipVectorIdentityCheck) {
          const isVectorBaseType = vectorCol.typtype === "b";
          const isVectorTypeName = vectorCol.typname.toLowerCase() === "vector";
          const isOwningExtensionVector = vectorCol.extension_name === "vector";

          if (!isVectorBaseType || !isVectorTypeName || !isOwningExtensionVector) {
            throw new CompanyMemoryUpgradeError(
              `Mem0 table "${tableName}" column "${vectorColName}" is not a valid pgvector column (typtype="${vectorCol.typtype}", typname="${vectorCol.typname}", extension="${vectorCol.extension_name ?? 'none'}"). Real pgvector extension type required.`,
              "NOT_PGVECTOR",
            );
          }

          // Corroborate pg_extension has vector
          const extRows = (await tx.execute(sql`
            SELECT count(*)::int AS count
            FROM pg_extension
            WHERE extname = 'vector';
          `)) as unknown as Array<{ count: number }>;

          if ((extRows[0]?.count ?? 0) === 0) {
            throw new CompanyMemoryUpgradeError(
              `Target database is missing required "vector" extension.`,
              "NOT_PGVECTOR",
            );
          }
        }

        // Allow schema-qualified type like extensions.vector(1536)
        // In production, no quote-stripping (.replace(/^"|"$/g, "")) is performed.
        // Test-only seam (_internalSkipVectorIdentityCheck) strips test domain quotes on embedded PG.
        const cleanedVectorType = _internalSkipVectorIdentityCheck
          ? vectorCol.formatted_type.trim().replace(/^"|"$/g, "")
          : vectorCol.formatted_type.trim();
        const vectorMatch = cleanedVectorType.match(/^(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?vector\((\d+)\)$/i);
        const embeddingDims = vectorMatch ? parseInt(vectorMatch[1], 10) : null;

        if (embeddingDims !== 1536) {
          throw new CompanyMemoryUpgradeError(
            `Invalid embedding dimensions for Mem0 table "${tableName}": expected 1536, found ${embeddingDims ?? cleanedVectorType}. Upgrade target re-embeds at text-embedding-3-small (1536 dimensions).`,
            "EMBEDDING_DIMENSIONS_MISMATCH",
          );
        }

        // Query total row count
        const totalCountRes = (await tx.execute(sql`
          SELECT COUNT(*)::int AS total
          FROM ${tenantTable.fragment};
        `)) as unknown as Array<{ total: number }>;

        const totalRows = totalCountRes[0]?.total ?? 0;

        shape = {
          table: tableName,
          embeddingColumn: vectorColName,
          embeddingDims: 1536,
          embeddingType: cleanedVectorType,
          payloadType: payloadType as "jsonb" | "json",
          rowCount: totalRows,
        };

        // 4. Census inspection: aggregate data via pure accumulator
        accumulator = createCensusAccumulator(longThreshold);
        let lastId: string | null = null;
        const pageSize = inputPageSize && inputPageSize > 0 ? inputPageSize : 1000;

        while (true) {
          const pageQuery = lastId === null
            ? sql`
                SELECT
                  t.id::text AS id,
                  t.payload->>'agent_id' AS agent_id,
                  t.payload->>'user_id' AS user_id,
                  t.payload->>'data' AS data,
                  t.payload->>'created_at' AS created_at
                FROM ${tenantTable.fragment} t
                ORDER BY t.id ASC
                LIMIT ${pageSize};
              `
            : isUuidId
              ? sql`
                  SELECT
                    t.id::text AS id,
                    t.payload->>'agent_id' AS agent_id,
                    t.payload->>'user_id' AS user_id,
                    t.payload->>'data' AS data,
                    t.payload->>'created_at' AS created_at
                  FROM ${tenantTable.fragment} t
                  WHERE t.id > ${lastId}::uuid
                  ORDER BY t.id ASC
                  LIMIT ${pageSize};
                `
              : sql`
                  SELECT
                    t.id::text AS id,
                    t.payload->>'agent_id' AS agent_id,
                    t.payload->>'user_id' AS user_id,
                    t.payload->>'data' AS data,
                    t.payload->>'created_at' AS created_at
                  FROM ${tenantTable.fragment} t
                  WHERE t.id > ${lastId}::text
                  ORDER BY t.id ASC
                  LIMIT ${pageSize};
                `;

          const rows = (await tx.execute(pageQuery)) as unknown as Array<CensusRowData>;

          if (rows.length === 0) {
            break;
          }

          for (const row of rows) {
            lastId = row.id;
            accumulateCensusRow(accumulator, row);
          }
        }

        counts = finalizeCensusCounts(accumulator, totalRows);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    const populatedShape = shape as ShapeIntrospectionResult | null;
    const populatedCounts = counts as CensusCounts | null;
    const populatedAccumulator = accumulator as CensusAccumulator | null;

    if (!populatedShape || !populatedCounts || !populatedAccumulator) {
      throw new CompanyMemoryUpgradeError(
        "Census transaction completed without populating shape or counts.",
        "UNEXPECTED_FAILURE",
      );
    }

    // 5. Routing readiness & disjoint conversion accounting
    const unroutableBreakdown: Record<UnroutableReason, UnroutableReasonSummary> = {
      missing_agent_id: { rowCount: 0, distinctAgentCount: 0, agentIds: [] },
      malformed_agent_id: { rowCount: 0, distinctAgentCount: 0, agentIds: [] },
      unknown_agent: { rowCount: 0, distinctAgentCount: 0, agentIds: [] },
      non_memory_adapter: { rowCount: 0, distinctAgentCount: 0, agentIds: [] },
      terminated: { rowCount: 0, distinctAgentCount: 0, agentIds: [] },
      pending_approval: { rowCount: 0, distinctAgentCount: 0, agentIds: [] },
      unknown_status: { rowCount: 0, distinctAgentCount: 0, agentIds: [] },
    };

    let routableAgentsCount = 0;
    let pausedAgentsCount = 0;
    let unroutableAgentsCount = 0;

    let routableRowsCount = 0;
    let pausedRowsCount = 0;
    let unroutableRowsCount = 0;

    let rowsToConvert = 0;
    let noiseRowsInRoutable = 0;
    let duplicateSurplusInRoutable = 0;

    const unroutableIds = new Set<string>();

    let resolvedCompanyId = inputCompanyId ?? null;
    let resolvedCompanyName: string | null = null;
    let companyVerification: "control-plane-verified" | "derived-name-verified" | "operator-asserted" | "unbound" = "unbound";

    let routingResult: RoutingReadinessResult = {
      status: "unverified",
      counts: {
        agents: { routable: null, routable_but_paused: null, unroutable: null },
        rows: { routable: null, routable_but_paused: null, unroutable: null },
      },
      unroutableBreakdown,
      unroutableAgentIds: [],
    };

    if (controlPlaneUrl) {
      const parsedControlPlaneUrl = validateDatabaseUrl(controlPlaneUrl, env, { allowProd });
      const cpDb = createDb(controlPlaneUrl, { maxConnections: 1 });

      try {
        await cpDb.transaction(
          async (cpTx) => {
            await assertNonSuperuserAndRestrictedRole(cpTx, "control-plane");

            // Verify or resolve company ID
            if (resolvedCompanyId) {
              const compRows = (await cpTx.execute<{ id: string; name: string }>(sql`
                SELECT id::text AS id, name
                FROM companies
                WHERE id = ${resolvedCompanyId}::uuid;
              `)) as unknown as Array<{ id: string; name: string }>;

              if (!compRows[0]) {
                throw new CompanyMemoryUpgradeError(
                  `Company "${resolvedCompanyId}" not found in control plane database.`,
                  "COMPANY_NOT_FOUND",
                );
              }
              resolvedCompanyName = compRows[0].name;

              const memDbRows = (await cpTx.execute<{
                id: string;
                company_id: string;
                database_name: string;
                database_role: string;
                host: string;
                port: number | null;
                status: string;
              }>(sql`
                SELECT
                  id::text AS id,
                  company_id::text AS company_id,
                  database_name,
                  database_role,
                  host,
                  port,
                  status
                FROM company_memory_databases
                WHERE company_id = ${resolvedCompanyId}::uuid
                LIMIT 1;
              `)) as unknown as Array<{
                id: string;
                company_id: string;
                database_name: string;
                database_role: string;
                host: string;
                port: number | null;
                status: string;
              }>;

              if (!memDbRows[0]) {
                throw new CompanyMemoryUpgradeError(
                  `No company_memory_databases record found for company "${resolvedCompanyId}".`,
                  "COMPANY_BINDING_MISMATCH",
                );
              }

              const memRow = memDbRows[0];
              if (memRow.database_name !== currentDatabase || memRow.database_role !== currentUser) {
                throw new CompanyMemoryUpgradeError(
                  `Company memory database binding mismatch: control-plane record specifies database "${memRow.database_name}" and role "${memRow.database_role}", but connected tenant is database "${currentDatabase}" and role "${currentUser}".`,
                  "COMPANY_BINDING_MISMATCH",
                );
              }

              if (memRow.status !== "ready") {
                caveats.push(`CAVEAT: Company memory database record status is "${memRow.status}" (expected "ready").`);
              }

              if (
                parsedTenantUrl.hostname !== memRow.host ||
                (memRow.port && parsedTenantUrl.port && parseInt(parsedTenantUrl.port, 10) !== memRow.port)
              ) {
                caveats.push(
                  `Advisory: Tenant connection endpoint (${parsedTenantUrl.hostname}:${parsedTenantUrl.port || 5432}) differs from control plane registration (${memRow.host}:${memRow.port || 5432}). Host locality is advisory due to possible port-forwarding or SSH tunnels.`,
                );
              }

              companyVerification = "control-plane-verified";
            } else {
              // Attempt to resolve company from company_memory_databases by database_name
              const memDbRows = (await cpTx.execute<{
                company_id: string;
                database_name: string;
                database_role: string;
                host: string;
                port: number | null;
                status: string;
                company_name: string | null;
              }>(sql`
                SELECT
                  cmd.company_id::text AS company_id,
                  cmd.database_name,
                  cmd.database_role,
                  cmd.host,
                  cmd.port,
                  cmd.status,
                  c.name AS company_name
                FROM company_memory_databases cmd
                LEFT JOIN companies c ON cmd.company_id = c.id
                WHERE cmd.database_name = ${currentDatabase};
              `)) as unknown as Array<{
                company_id: string;
                database_name: string;
                database_role: string;
                host: string;
                port: number | null;
                status: string;
                company_name: string | null;
              }>;

              if (memDbRows.length === 0) {
                throw new CompanyMemoryUpgradeError(
                  `Unable to infer company ID for memory database "${currentDatabase}". Please supply --company <uuid>.`,
                  "INVALID_ARGUMENT",
                );
              }
              if (memDbRows.length > 1) {
                throw new CompanyMemoryUpgradeError(
                  `Ambiguous company mapping: multiple company_memory_databases records found for "${currentDatabase}". Please supply --company <uuid>.`,
                  "INVALID_ARGUMENT",
                );
              }

              const inferredRow = memDbRows[0];
              if (inferredRow.database_role !== currentUser) {
                throw new CompanyMemoryUpgradeError(
                  `Company memory database binding mismatch: control-plane record specifies role "${inferredRow.database_role}" for database "${currentDatabase}", but connected user is "${currentUser}".`,
                  "COMPANY_BINDING_MISMATCH",
                );
              }

              if (inferredRow.status !== "ready") {
                caveats.push(`CAVEAT: Company memory database record status is "${inferredRow.status}" (expected "ready").`);
              }

              resolvedCompanyId = inferredRow.company_id;
              resolvedCompanyName = inferredRow.company_name;
              companyVerification = "control-plane-verified";
            }

            // Query company agents
            const agentRows = (await cpTx.execute<{
              id: string;
              name: string;
              adapter_type: string;
              status: string;
              paused_at: string | null;
            }>(sql`
              SELECT
                id::text AS id,
                name,
                adapter_type,
                status,
                paused_at::text AS paused_at
              FROM agents
              WHERE company_id = ${resolvedCompanyId}::uuid;
            `)) as unknown as Array<{
              id: string;
              name: string;
              adapter_type: string;
              status: string;
              paused_at: string | null;
            }>;

            const cpAgentMap = new Map<string, (typeof agentRows)[number]>();
            for (const a of agentRows) {
              cpAgentMap.set(a.id.trim().toLowerCase(), a);
            }

            for (const [agentKey, tracking] of populatedAccumulator.agentTracking.entries()) {
              let agentSurplus = 0;
              for (const count of tracking.textHashMap.values()) {
                if (count > 1) {
                  agentSurplus += count - 1;
                }
              }
              const agentEligible = tracking.total - tracking.noise - agentSurplus;

              if (agentKey === "(none)") {
                unroutableAgentsCount++;
                unroutableRowsCount += tracking.total;
                unroutableBreakdown.missing_agent_id.rowCount += tracking.total;
                unroutableBreakdown.missing_agent_id.distinctAgentCount++;
                continue;
              }

              if (!isValidUuid(agentKey)) {
                unroutableAgentsCount++;
                unroutableRowsCount += tracking.total;
                unroutableBreakdown.malformed_agent_id.rowCount += tracking.total;
                unroutableBreakdown.malformed_agent_id.distinctAgentCount++;
                const safeMalformedKey = redactPayloadIdentifier(agentKey, false)!;
                unroutableBreakdown.malformed_agent_id.agentIds.push(safeMalformedKey);
                unroutableIds.add(safeMalformedKey);
                continue;
              }

              const cpAgent = cpAgentMap.get(agentKey);
              if (!cpAgent) {
                unroutableAgentsCount++;
                unroutableRowsCount += tracking.total;
                unroutableBreakdown.unknown_agent.rowCount += tracking.total;
                unroutableBreakdown.unknown_agent.distinctAgentCount++;
                const safeKey = redactPayloadIdentifier(agentKey, false)!;
                unroutableBreakdown.unknown_agent.agentIds.push(safeKey);
                unroutableIds.add(safeKey);
                continue;
              }

              if (!adapterSupportsRuntimeMemory(cpAgent.adapter_type)) {
                unroutableAgentsCount++;
                unroutableRowsCount += tracking.total;
                unroutableBreakdown.non_memory_adapter.rowCount += tracking.total;
                unroutableBreakdown.non_memory_adapter.distinctAgentCount++;
                const safeKey = redactPayloadIdentifier(agentKey, false)!;
                unroutableBreakdown.non_memory_adapter.agentIds.push(safeKey);
                unroutableIds.add(safeKey);
                continue;
              }

              if (cpAgent.status === "terminated") {
                unroutableAgentsCount++;
                unroutableRowsCount += tracking.total;
                unroutableBreakdown.terminated.rowCount += tracking.total;
                unroutableBreakdown.terminated.distinctAgentCount++;
                const safeKey = redactPayloadIdentifier(agentKey, false)!;
                unroutableBreakdown.terminated.agentIds.push(safeKey);
                unroutableIds.add(safeKey);
                continue;
              }

              if (cpAgent.status === "pending_approval") {
                unroutableAgentsCount++;
                unroutableRowsCount += tracking.total;
                unroutableBreakdown.pending_approval.rowCount += tracking.total;
                unroutableBreakdown.pending_approval.distinctAgentCount++;
                const safeKey = redactPayloadIdentifier(agentKey, false)!;
                unroutableBreakdown.pending_approval.agentIds.push(safeKey);
                unroutableIds.add(safeKey);
                continue;
              }

              const isInvokable = INVOKABLE_AGENT_STATUSES.has(cpAgent.status);
              const isPausedStatus = cpAgent.status === "paused";

              if (!isInvokable && !isPausedStatus) {
                unroutableAgentsCount++;
                unroutableRowsCount += tracking.total;
                unroutableBreakdown.unknown_status.rowCount += tracking.total;
                unroutableBreakdown.unknown_status.distinctAgentCount++;
                const safeKey = redactPayloadIdentifier(agentKey, false)!;
                unroutableBreakdown.unknown_status.agentIds.push(safeKey);
                unroutableIds.add(safeKey);
                caveats.push(`CAVEAT: Agent "${safeKey}" has unrecognized status "${cpAgent.status}". Classified as unroutable.`);
                continue;
              }

              if (isPausedStatus || cpAgent.paused_at !== null) {
                pausedAgentsCount++;
                pausedRowsCount += tracking.total;
                rowsToConvert += agentEligible;
                noiseRowsInRoutable += tracking.noise;
                duplicateSurplusInRoutable += agentSurplus;
              } else {
                routableAgentsCount++;
                routableRowsCount += tracking.total;
                rowsToConvert += agentEligible;
                noiseRowsInRoutable += tracking.noise;
                duplicateSurplusInRoutable += agentSurplus;
              }
            }

            for (const summary of Object.values(unroutableBreakdown)) {
              summary.agentIds.sort();
            }

            routingResult = {
              status: "verified",
              counts: {
                agents: {
                  routable: routableAgentsCount,
                  routable_but_paused: pausedAgentsCount,
                  unroutable: unroutableAgentsCount,
                },
                rows: {
                  routable: routableRowsCount,
                  routable_but_paused: pausedRowsCount,
                  unroutable: unroutableRowsCount,
                },
              },
              unroutableBreakdown,
              unroutableAgentIds: Array.from(unroutableIds).sort(),
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } finally {
        await cpDb.$client.end({ timeout: 1 }).catch(() => {});
      }
    } else {
      // No control plane URL provided
      if (!resolvedCompanyId) {
        throw new CompanyMemoryUpgradeError(
          "Refusing to run census without --company <uuid> when control plane URL is not provided.",
          "INVALID_ARGUMENT",
        );
      }

      const pcmemPattern = /^pcmem_[0-9a-f]{32}$/;
      if (pcmemPattern.test(currentDatabase)) {
        companyVerification = "derived-name-verified";
      } else {
        companyVerification = "unbound";
      }

      for (const [agentKey, tracking] of populatedAccumulator.agentTracking.entries()) {
        let agentSurplus = 0;
        for (const count of tracking.textHashMap.values()) {
          if (count > 1) {
            agentSurplus += count - 1;
          }
        }
        const agentEligible = tracking.total - tracking.noise - agentSurplus;

        if (agentKey === "(none)") {
          unroutableAgentsCount++;
          unroutableRowsCount += tracking.total;
          unroutableBreakdown.missing_agent_id.rowCount += tracking.total;
          unroutableBreakdown.missing_agent_id.distinctAgentCount++;
        } else if (!isValidUuid(agentKey)) {
          unroutableAgentsCount++;
          unroutableRowsCount += tracking.total;
          unroutableBreakdown.malformed_agent_id.rowCount += tracking.total;
          unroutableBreakdown.malformed_agent_id.distinctAgentCount++;
          const safeMalformedKey = redactPayloadIdentifier(agentKey, false)!;
          unroutableBreakdown.malformed_agent_id.agentIds.push(safeMalformedKey);
          unroutableIds.add(safeMalformedKey);
        } else {
          // In unverified/provisional mode, syntactically valid agents are treated as provisional upper-bound candidates
          rowsToConvert += agentEligible;
          noiseRowsInRoutable += tracking.noise;
          duplicateSurplusInRoutable += agentSurplus;
        }
      }

      for (const summary of Object.values(unroutableBreakdown)) {
        summary.agentIds.sort();
      }

      routingResult = {
        status: "unverified",
        caveat: "Control plane URL was not provided. Agent routing readiness could not be verified against the control plane.",
        counts: {
          agents: {
            routable: null,
            routable_but_paused: null,
            unroutable: unroutableAgentsCount,
          },
          rows: {
            routable: null,
            routable_but_paused: null,
            unroutable: unroutableRowsCount,
          },
        },
        unroutableBreakdown,
        unroutableAgentIds: Array.from(unroutableIds).sort(),
      };
    }

    if (companyVerification === "unbound") {
      routingResult = {
        ...routingResult,
        status: "unverified",
        caveat: routingResult.caveat ?? "Company binding is unbound; agent routing readiness cannot be verified.",
      };
    }

    // 6. Conversion budget estimate
    const isProvisional = routingResult.status === "unverified" || companyVerification === "unbound";
    const budgetEstimate = estimateConversionBudget({
      totalRows: populatedCounts.totalRows,
      rowsToConvert,
      unroutableRows: unroutableRowsCount,
      noiseRowsInRoutable,
      duplicateSurplusInRoutable,
      averageTextLength: populatedCounts.contentLength.average,
      basis: isProvisional ? "provisional" : "verified",
      bound: isProvisional ? "upper_bound" : "exact",
      boundDescription: isProvisional
        ? "Upper bound estimate: assumes all syntactically valid agents are routable and excludes only known unroutable hygiene rows, noise, and duplicate surplus."
        : "Exact conversion volume verified against control plane agent routing and active memory adapters.",
      chatInputUsdPerMillion: options.chatInputUsdPerMillion,
      chatOutputUsdPerMillion: options.chatOutputUsdPerMillion,
      embeddingUsdPerMillion: options.embeddingUsdPerMillion,
    });

    if (routingResult.status === "unverified") {
      caveats.push(
        "ROUTING UNVERIFIED: Control plane URL was not provided or company binding is unbound. Agent existence and routing status could not be verified.",
      );
    } else {
      caveats.push("ROUTING VERIFIED: Agent routing verified against control plane.");
    }
    caveats.push("BUDGET ESTIMATE: Costs and durations are planning estimates based on standard rate tiers and token models.");

    const report: CensusReport = {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      readOnly: true,
      tenantDatabase: {
        databaseName: currentDatabase || tenantDbName,
        host: parsedTenantUrl.hostname,
        port: parseInt(parsedTenantUrl.port || "5432", 10),
        user: currentUser || parsedTenantUrl.username || "current_user",
      },
      company: {
        id: resolvedCompanyId!,
        name: resolvedCompanyName,
        verification: companyVerification,
      },
      shapeIntrospection: populatedShape,
      census: populatedCounts,
      routing: routingResult,
      budget: budgetEstimate,
      caveats,
    };

    if (outputPath) {
      const resolvedOutPath = validateOutputPath(outputPath, repoRoot);
      const outputText = format === "json"
        ? JSON.stringify(report, null, 2)
        : formatCensusTextReport(report);

      await writeFile(resolvedOutPath, outputText, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    }

    return report;
  } finally {
    await tenantDb.$client.end({ timeout: 1 }).catch(() => {});
  }
}

export function formatCostUsd(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) {
    return `$${cost.toPrecision(3)}`;
  }
  return `$${cost.toFixed(4)}`;
}

export function formatCensusTextReport(report: CensusReport): string {
  const lines: string[] = [];

  lines.push("================================================================================");
  lines.push("           PAPERCLIP MEM0 UPGRADE CENSUS & BUDGET REPORT");
  lines.push("                    READ-ONLY / NOTHING WRITTEN");
  lines.push("================================================================================");
  lines.push("");

  lines.push("CAVEATS & WARNINGS:");
  for (const caveat of report.caveats) {
    lines.push(`  * ${caveat}`);
  }
  lines.push("");

  lines.push("DATABASE & COMPANY CONTEXT:");
  lines.push(`  - Tenant Database: ${report.tenantDatabase.databaseName} (${report.tenantDatabase.host}:${report.tenantDatabase.port})`);
  lines.push(`  - Connecting Role: ${report.tenantDatabase.user} (non-superuser verified)`);
  lines.push(`  - Company ID:      ${report.company.id} (${report.company.verification}${report.company.name ? ` - "${report.company.name}"` : ""})`);
  lines.push("");

  lines.push("SHAPE INTROSPECTION:");
  lines.push(`  - Target Table:         ${report.shapeIntrospection.table}`);
  lines.push(`  - Embedding Column:     ${report.shapeIntrospection.embeddingColumn} (declared: ${report.shapeIntrospection.embeddingType})`);
  lines.push(`  - Embedding Dimensions: ${report.shapeIntrospection.embeddingDims} (compatible with text-embedding-3-small)`);
  lines.push(`  - Payload Format:       ${report.shapeIntrospection.payloadType}`);
  lines.push(`  - Total Rows:           ${report.shapeIntrospection.rowCount.toLocaleString()}`);
  lines.push("");

  lines.push("--- CENSUS AGGREGATES ---");
  lines.push(`  - Total Memory Rows:    ${report.census.totalRows.toLocaleString()}`);
  lines.push(`  - Distinct User IDs:    ${report.census.distinctUserIds.toLocaleString()}`);
  lines.push(`  - Distinct Agent IDs:   ${report.census.distinctAgentIds.toLocaleString()}`);
  lines.push("");

  lines.push("Agent ID Breakdown:");
  for (const b of report.census.agentBreakdown) {
    lines.push(`  - ${b.agentId ?? "(missing/blank)"}: ${b.count.toLocaleString()} rows`);
  }
  lines.push("");

  lines.push("Agent ID Hygiene:");
  lines.push(`  - Missing or Blank:     ${report.census.agentIdHygiene.missingOrBlankCount.toLocaleString()} rows`);
  lines.push(`  - Malformed Non-UUID:   ${report.census.agentIdHygiene.nonUuidCount.toLocaleString()} rows`);
  lines.push(`  - Total Hygiene Issues: ${report.census.agentIdHygiene.totalMalformedOrMissingCount.toLocaleString()} rows`);
  lines.push("");

  lines.push("User ID Breakdown:");
  for (const u of report.census.userBreakdown.top) {
    lines.push(`  - ${u.userId}: ${u.count.toLocaleString()} rows`);
  }
  if (report.census.userBreakdown.longTailCount > 0) {
    lines.push(`  - (long tail remainder): ${report.census.userBreakdown.longTailCount.toLocaleString()} rows`);
  }
  lines.push("");

  lines.push("Created-At Monthly Histogram (derived from payload->>'created_at'):");
  const sortedMonths = Object.keys(report.census.createdAtHistogram).sort();
  for (const m of sortedMonths) {
    lines.push(`  - ${m}: ${report.census.createdAtHistogram[m].toLocaleString()} rows`);
  }
  lines.push("");

  lines.push("Memory Text Length Statistics:");
  lines.push(`  - Average Length:       ${report.census.contentLength.average} chars`);
  lines.push(`  - Median Length:        ${report.census.contentLength.median} chars`);
  lines.push(`  - P95 Length:           ${report.census.contentLength.p95} chars`);
  lines.push(`  - Rows > ${report.census.contentLength.threshold} chars:     ${report.census.contentLength.longerThanThresholdCount.toLocaleString()} rows`);
  lines.push("");

  lines.push("Quality & Sensitivity Signals:");
  lines.push(`  - Deterministic Noise:  ${report.census.noise.candidateCount.toLocaleString()} rows`);
  lines.push(`  - Duplicate Content:    ${report.census.duplicates.duplicateGroups.toLocaleString()} groups (${report.census.duplicates.surplusRows.toLocaleString()} surplus rows)`);
  lines.push(`  - Likely-Sensitive:     ${report.census.sensitive.candidateCount.toLocaleString()} rows (privateKey: ${report.census.sensitive.familyBreakdown.privateKey}, bearerToken: ${report.census.sensitive.familyBreakdown.bearerToken}, apiKey: ${report.census.sensitive.familyBreakdown.apiKey}, ssn: ${report.census.sensitive.familyBreakdown.ssn}, creditCard: ${report.census.sensitive.familyBreakdown.creditCard}, passwordAssignment: ${report.census.sensitive.familyBreakdown.passwordAssignment})`);
  lines.push("  * Note: Sensitive counts are detection hits only; no memory text was logged or exported.");
  lines.push("");

  lines.push("--- ROUTING READINESS ---");
  lines.push(`  - Status: ${report.routing.status.toUpperCase()}`);
  if (report.routing.status === "verified") {
    lines.push(`  - Routable Agents:            ${report.routing.counts.agents.routable} (${report.routing.counts.rows.routable?.toLocaleString()} rows)`);
    lines.push(`  - Routable-but-Paused Agents: ${report.routing.counts.agents.routable_but_paused} (${report.routing.counts.rows.routable_but_paused?.toLocaleString()} rows)`);
    lines.push(`  - Unroutable Agents:          ${report.routing.counts.agents.unroutable} (${report.routing.counts.rows.unroutable?.toLocaleString()} rows)`);
  } else {
    lines.push(`  - ${report.routing.caveat}`);
    lines.push(`  - Unroutable Hygiene Rows:    ${report.routing.counts.rows.unroutable?.toLocaleString()} rows`);
  }
  lines.push("  - Unroutable Reasons Breakdown:");
  for (const [reason, s] of Object.entries(report.routing.unroutableBreakdown)) {
    if (s.rowCount > 0 || s.distinctAgentCount > 0) {
      lines.push(`      * ${reason}: ${s.rowCount.toLocaleString()} rows (${s.distinctAgentCount} agents${s.agentIds.length > 0 ? `: [ ${s.agentIds.join(", ")} ]` : ""})`);
    }
  }
  if (report.routing.unroutableAgentIds.length > 0) {
    lines.push(`  - All Unroutable Agent IDs:   [ ${report.routing.unroutableAgentIds.join(", ")} ]`);
  }
  lines.push("");

  if (report.budget.basis === "provisional") {
    lines.push("================================================================================");
    lines.push("*** PROVISIONAL BUDGET ESTIMATE (UNVERIFIED ROUTING OR UNBOUND COMPANY) ***");
    lines.push(`  * BASIS: PROVISIONAL (${report.budget.bound?.toUpperCase() ?? "UPPER_BOUND"})`);
    lines.push(`  * ${report.budget.boundDescription}`);
    lines.push("================================================================================");
  } else {
    lines.push("--- ESTIMATED CONVERSION BUDGET (VERIFIED ROUTING) ---");
    lines.push(`  * BASIS: VERIFIED (${report.budget.bound?.toUpperCase() ?? "EXACT"})`);
  }
  lines.push(`  - Rows to Convert:            ${report.budget.rowsToConvert.toLocaleString()} rows`);
  lines.push(`    Breakdown: total (${report.budget.breakdown.totalRows}) = rowsToConvert (${report.budget.breakdown.rowsToConvert}) + unroutable (${report.budget.breakdown.unroutableRows}) + noiseInRoutable (${report.budget.breakdown.noiseRowsInRoutable}) + duplicateSurplusInRoutable (${report.budget.breakdown.duplicateSurplusInRoutable})`);
  lines.push(`  - Chat Input Tokens:          ~${report.budget.estimatedTokens.chatInput.toLocaleString()} tokens`);
  lines.push(`  - Chat Output Tokens:         ~${report.budget.estimatedTokens.chatOutput.toLocaleString()} tokens`);
  lines.push(`  - Embedding Tokens:           ~${report.budget.estimatedTokens.embeddingTotal.toLocaleString()} tokens`);
  lines.push(`  - Estimated Chat Cost:        ~${formatCostUsd(report.budget.estimatedCostUsd.chat)} USD`);
  lines.push(`  - Estimated Embedding Cost:   ~${formatCostUsd(report.budget.estimatedCostUsd.embedding)} USD`);
  lines.push(`  - Total Estimated USD:        ~${formatCostUsd(report.budget.estimatedCostUsd.total)} USD (${report.budget.pricingSource})`);
  lines.push(`  - Rate-Limit Floor Duration:  ~${report.budget.estimatedWallClock.humanReadable} (floor: ${report.budget.estimatedWallClock.rateLimitFloorSeconds}s, binding cap: ${report.budget.estimatedWallClock.bindingCap})`);
  lines.push(`    Note: ${report.budget.estimatedWallClock.label}`);
  lines.push("================================================================================");

  return lines.join("\n");
}
