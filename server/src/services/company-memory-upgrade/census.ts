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
import { sql } from "drizzle-orm";
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
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(val: unknown): boolean {
  return typeof val === "string" && UUID_REGEX.test(val);
}

export function validateAndResolveTableIdentifier(
  tableName: string,
  sqlTag: typeof sql = sql,
): { fragment: any; schema: string | null; bareTable: string } {
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

export interface CensusOptions {
  databaseUrl: string;
  companyId?: string | null;
  controlPlaneUrl?: string | null;
  outputPath?: string | null;
  format?: "text" | "json";
  tableName?: string;
  longThreshold?: number;
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
    verification: "control-plane-verified" | "operator-asserted";
  };
  shapeIntrospection: ShapeIntrospectionResult;
  census: CensusCounts;
  routing: RoutingReadinessResult;
  budget: ConversionBudgetEstimate;
  caveats: string[];
}

export function validateDatabaseUrl(urlString: string, env: NodeJS.ProcessEnv = process.env): URL {
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
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (!isLocal && env.MEMORY_UPGRADE_ALLOW_PROD !== "1") {
    throw new CompanyMemoryUpgradeError(
      `Refusing to connect to non-local host '${host}' without MEMORY_UPGRADE_ALLOW_PROD=1 environment variable.`,
      "PROD_GUARD_ENFORCED",
    );
  }

  return parsed;
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
    env = process.env,
    repoRoot,
    onTransaction,
  } = options;

  const parsedTenantUrl = validateDatabaseUrl(databaseUrl, env);
  const tenantDbName = parsedTenantUrl.pathname.replace(/^\//, "");
  const tenantTable = validateAndResolveTableIdentifier(tableName, sql);

  if (outputPath) {
    validateOutputPath(outputPath, repoRoot);
  }

  // Preflight connection to tenant database: single connection, read-only
  const tenantDb = createDb(databaseUrl, { maxConnections: 1 });

  try {
    let roleCheck: { rolsuper: boolean; rolbypassrls: boolean } | null = null;
    let shape: ShapeIntrospectionResult | null = null;
    let counts: CensusCounts | null = null;

    await tenantDb.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY;`);

      if (onTransaction) {
        await onTransaction(tx);
      }

      // 1. Role preflight: query pg_roles for current_user
      const roleRows = (await tx.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(sql`
        SELECT rolsuper, rolbypassrls
        FROM pg_roles
        WHERE rolname = current_user;
      `)) as unknown as Array<{ rolsuper: boolean; rolbypassrls: boolean }>;

      if (!roleRows[0]) {
        throw new CompanyMemoryUpgradeError(
          "Preflight check failed: Unable to query pg_roles for current_user.",
          "PREFLIGHT_FAILED",
        );
      }

      roleCheck = roleRows[0];
      if (roleCheck.rolsuper) {
        throw new CompanyMemoryUpgradeError(
          `Refusing to run memory upgrade census: connecting role '${parsedTenantUrl.username || "current_user"}' is a superuser. Dedicated non-superuser tenant role required.`,
          "SUPERUSER_REJECTED",
        );
      }
      if (roleCheck.rolbypassrls) {
        throw new CompanyMemoryUpgradeError(
          `Refusing to run memory upgrade census: connecting role '${parsedTenantUrl.username || "current_user"}' has BYPASSRLS privilege. Dedicated tenant role required.`,
          "BYPASSRLS_REJECTED",
        );
      }

      // 2. Shape introspection: introspect columns in target table
      const columnRows = (await tx.execute<{ attname: string; formatted_type: string; typname: string }>(sql`
        SELECT
          a.attname,
          format_type(a.atttypid, a.atttypmod) AS formatted_type,
          t.typname
        FROM pg_attribute a
        JOIN pg_type t ON a.atttypid = t.oid
        WHERE a.attrelid = to_regclass(${tableName})
          AND a.attnum > 0
          AND NOT a.attisdropped;
      `)) as unknown as Array<{ attname: string; formatted_type: string; typname: string }>;

      if (columnRows.length === 0) {
        throw new CompanyMemoryUpgradeError(
          `Table "${tableName}" not found or has no columns in target database.`,
          "TABLE_NOT_FOUND",
        );
      }

      const colMap = new Map<string, { formatted_type: string; typname: string }>();
      for (const row of columnRows) {
        colMap.set(row.attname, row);
      }

      // Check expected columns: id, payload, and vector/embedding
      if (!colMap.has("id")) {
        throw new CompanyMemoryUpgradeError(
          `Mem0 table "${tableName}" is missing required "id" primary key column.`,
          "SCHEMA_MISMATCH",
        );
      }

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
      // Strip outer quotes from domain or type names: e.g. '"vector(1536)"' -> 'vector(1536)'
      const cleanedVectorType = vectorCol.formatted_type.replace(/^"|"$/g, "").trim();

      const vectorMatch = cleanedVectorType.match(/^vector\((\d+)\)$/i);
      const embeddingDims = vectorMatch ? parseInt(vectorMatch[1], 10) : null;

      if (embeddingDims !== 1536) {
        throw new CompanyMemoryUpgradeError(
          `Invalid embedding dimensions for Mem0 table "${tableName}": expected 1536, found ${embeddingDims ?? cleanedVectorType}. Upgrade target re-embeds at text-embedding-3-small (1536 dimensions).`,
          "EMBEDDING_DIMENSIONS_MISMATCH",
        );
      }

      // Query total row count
      const totalCountRes = (await tx.execute<{ total: number }>(sql`
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

      // 3. Census inspection: aggregate data
      const userMap = new Map<string, number>();
      const agentMap = new Map<string, number>();
      let missingOrBlankAgentIdCount = 0;
      let nonUuidAgentIdCount = 0;
      const createdAtHistogram: Record<string, number> = {};
      const charLengths: number[] = [];
      let totalCharLength = 0;
      let longerThanThresholdCount = 0;
      const duplicateGroupMap = new Map<string, number>();
      let noiseCandidateCount = 0;
      let sensitiveCandidateCount = 0;
      const sensitiveFamilyBreakdown: Record<SensitiveFamilyName, number> = {
        privateKey: 0,
        bearerToken: 0,
        apiKey: 0,
        ssn: 0,
        creditCard: 0,
        passwordAssignment: 0,
      };

      // Keyset pagination: ORDER BY id LIMIT 1000
      let lastId: string | null = null;
      const pageSize = 1000;

      while (true) {
        const pageQuery = lastId === null
          ? sql`
              SELECT
                id::text AS id,
                payload->>'agent_id' AS agent_id,
                payload->>'user_id' AS user_id,
                payload->>'data' AS data,
                payload->>'created_at' AS created_at
              FROM ${tenantTable.fragment}
              ORDER BY id ASC
              LIMIT ${pageSize};
            `
          : sql`
              SELECT
                id::text AS id,
                payload->>'agent_id' AS agent_id,
                payload->>'user_id' AS user_id,
                payload->>'data' AS data,
                payload->>'created_at' AS created_at
              FROM ${tenantTable.fragment}
              WHERE id::text > ${lastId}
              ORDER BY id ASC
              LIMIT ${pageSize};
            `;

        const rows = (await tx.execute<{
          id: string;
          agent_id: string | null;
          user_id: string | null;
          data: string | null;
          created_at: string | null;
        }>(pageQuery)) as unknown as Array<{
          id: string;
          agent_id: string | null;
          user_id: string | null;
          data: string | null;
          created_at: string | null;
        }>;

        if (rows.length === 0) {
          break;
        }

        for (const row of rows) {
          lastId = row.id;

          // User ID aggregation
          const rawUserId = row.user_id ? row.user_id.trim() : "";
          const userIdKey = rawUserId || "(none)";
          userMap.set(userIdKey, (userMap.get(userIdKey) ?? 0) + 1);

          // Agent ID aggregation & hygiene
          const rawAgentId = row.agent_id ? row.agent_id.trim() : "";
          if (!rawAgentId) {
            missingOrBlankAgentIdCount++;
            agentMap.set("(none)", (agentMap.get("(none)") ?? 0) + 1);
          } else {
            agentMap.set(rawAgentId, (agentMap.get(rawAgentId) ?? 0) + 1);
            if (!isValidUuid(rawAgentId)) {
              nonUuidAgentIdCount++;
            }
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
          createdAtHistogram[monthBucket] = (createdAtHistogram[monthBucket] ?? 0) + 1;

          // Memory text length & noise & duplicates & sensitive
          const memoryText = row.data ?? "";
          const textLength = memoryText.length;
          charLengths.push(textLength);
          totalCharLength += textLength;
          if (textLength > longThreshold) {
            longerThanThresholdCount++;
          }

          // Deterministic noise
          if (classifyMemoryNoise(memoryText)) {
            noiseCandidateCount++;
          }

          // Duplicate candidate: normalized text SHA-256 grouped per agent
          const normalized = normalizeMemoryContent(memoryText);
          const textHash = createHash("sha256").update(normalized).digest("hex");
          const agentKey = rawAgentId || "(none)";
          const dupKey = `${agentKey}:${textHash}`;
          duplicateGroupMap.set(dupKey, (duplicateGroupMap.get(dupKey) ?? 0) + 1);

          // Sensitive detection: count only!
          const sensitiveRes = detectSensitiveFamilies(memoryText);
          if (sensitiveRes.isSensitive) {
            sensitiveCandidateCount++;
            for (const [fam, hit] of Object.entries(sensitiveRes.matches) as Array<[SensitiveFamilyName, boolean]>) {
              if (hit) {
                sensitiveFamilyBreakdown[fam]++;
              }
            }
          }
        }
      }

      // Compute duplicate groups and surplus rows
      let duplicateGroups = 0;
      let surplusRows = 0;
      for (const count of duplicateGroupMap.values()) {
        if (count > 1) {
          duplicateGroups++;
          surplusRows += count - 1;
        }
      }

      // Compute character length percentiles
      charLengths.sort((a, b) => a - b);
      const avgLen = totalRows > 0 ? Math.round((totalCharLength / totalRows) * 10) / 10 : 0;
      const medianLen = charLengths.length > 0
        ? charLengths[Math.floor(charLengths.length * 0.5)]
        : 0;
      const p95Len = charLengths.length > 0
        ? charLengths[Math.min(charLengths.length - 1, Math.floor(charLengths.length * 0.95))]
        : 0;

      // User breakdown: top 10 + long tail
      const sortedUsers = Array.from(userMap.entries())
        .map(([userId, count]) => ({ userId, count }))
        .sort((a, b) => b.count - a.count);

      const topUsers = sortedUsers.slice(0, 10);
      const longTailCount = sortedUsers.slice(10).reduce((acc, curr) => acc + curr.count, 0);

      // Agent breakdown
      const agentBreakdown = Array.from(agentMap.entries())
        .map(([agentId, count]) => ({ agentId: agentId === "(none)" ? null : agentId, count }))
        .sort((a, b) => b.count - a.count);

      counts = {
        totalRows,
        distinctUserIds: userMap.size,
        distinctAgentIds: agentMap.size,
        userBreakdown: {
          top: topUsers,
          longTailCount,
        },
        agentBreakdown,
        agentIdHygiene: {
          missingOrBlankCount: missingOrBlankAgentIdCount,
          nonUuidCount: nonUuidAgentIdCount,
          totalMalformedOrMissingCount: missingOrBlankAgentIdCount + nonUuidAgentIdCount,
        },
        createdAtHistogram,
        contentLength: {
          average: avgLen,
          median: medianLen,
          p95: p95Len,
          threshold: longThreshold,
          longerThanThresholdCount,
        },
        duplicates: {
          duplicateGroups,
          surplusRows,
        },
        noise: {
          candidateCount: noiseCandidateCount,
        },
        sensitive: {
          candidateCount: sensitiveCandidateCount,
          familyBreakdown: sensitiveFamilyBreakdown,
        },
      };
    });

    const populatedShape = shape as ShapeIntrospectionResult | null;
    const populatedCounts = counts as CensusCounts | null;

    if (!populatedShape || !populatedCounts) {
      throw new CompanyMemoryUpgradeError(
        "Census transaction completed without populating shape or counts.",
        "UNEXPECTED_FAILURE",
      );
    }

    // 4. Routing readiness verification
    let routingResult: RoutingReadinessResult = {
      status: "unverified",
      counts: {
        agents: { routable: null, routable_but_paused: null, unroutable: null },
        rows: { routable: null, routable_but_paused: null, unroutable: null },
      },
      unroutableAgentIds: [],
    };
    let resolvedCompanyId = inputCompanyId ?? null;
    let resolvedCompanyName: string | null = null;
    let companyVerification: "control-plane-verified" | "operator-asserted" = "operator-asserted";

    const observedAgentIds = new Set<string>();
    for (const b of populatedCounts.agentBreakdown) {
      if (b.agentId) {
        observedAgentIds.add(b.agentId);
      }
    }

    if (controlPlaneUrl) {
      const parsedControlPlaneUrl = validateDatabaseUrl(controlPlaneUrl, env);
      const cpDb = createDb(controlPlaneUrl, { maxConnections: 1 });

      try {
        await cpDb.transaction(async (cpTx) => {
          await cpTx.execute(sql`SET TRANSACTION READ ONLY;`);

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
            companyVerification = "control-plane-verified";
          } else {
            // Attempt to resolve company from company_memory_databases
            const memDbRows = (await cpTx.execute<{ company_id: string; company_name: string | null }>(sql`
              SELECT
                cmd.company_id::text AS company_id,
                c.name AS company_name
              FROM company_memory_databases cmd
              LEFT JOIN companies c ON cmd.company_id = c.id
              WHERE cmd.database_name = ${tenantDbName}
              LIMIT 1;
            `)) as unknown as Array<{ company_id: string; company_name: string | null }>;

            if (memDbRows[0]) {
              resolvedCompanyId = memDbRows[0].company_id;
              resolvedCompanyName = memDbRows[0].company_name;
              companyVerification = "control-plane-verified";
            } else {
              throw new CompanyMemoryUpgradeError(
                `Unable to infer company ID for memory database "${tenantDbName}". Please supply --company <uuid>.`,
                "INVALID_ARGUMENT",
              );
            }
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
            cpAgentMap.set(a.id, a);
          }

          let routableAgentsCount = 0;
          let pausedAgentsCount = 0;
          let unroutableAgentsCount = 0;

          let routableRowsCount = 0;
          let pausedRowsCount = 0;
          let unroutableRowsCount = 0;

          const unroutableIds = new Set<string>();

          for (const breakdown of populatedCounts.agentBreakdown) {
            const aid = breakdown.agentId;
            const rowCount = breakdown.count;

            if (!aid || !isValidUuid(aid)) {
              unroutableAgentsCount++;
              unroutableRowsCount += rowCount;
              if (aid) unroutableIds.add(aid);
              continue;
            }

            const cpAgent = cpAgentMap.get(aid);
            if (!cpAgent) {
              unroutableAgentsCount++;
              unroutableRowsCount += rowCount;
              unroutableIds.add(aid);
              continue;
            }

            const isHermes = cpAgent.adapter_type.toLowerCase().startsWith("hermes");
            if (!isHermes) {
              unroutableAgentsCount++;
              unroutableRowsCount += rowCount;
              unroutableIds.add(aid);
              continue;
            }

            if (cpAgent.status === "terminated") {
              unroutableAgentsCount++;
              unroutableRowsCount += rowCount;
              unroutableIds.add(aid);
              continue;
            }

            if (cpAgent.status === "paused" || cpAgent.paused_at !== null) {
              pausedAgentsCount++;
              pausedRowsCount += rowCount;
            } else {
              routableAgentsCount++;
              routableRowsCount += rowCount;
            }
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
            unroutableAgentIds: Array.from(unroutableIds).sort(),
          };
        });
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

      const unroutableIds = new Set<string>();
      let unroutableRowCount = 0;
      let unroutableAgentsCount = 0;

      for (const breakdown of populatedCounts.agentBreakdown) {
        const aid = breakdown.agentId;
        if (!aid || !isValidUuid(aid)) {
          unroutableAgentsCount++;
          unroutableRowCount += breakdown.count;
          if (aid) unroutableIds.add(aid);
        }
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
            unroutable: unroutableRowCount,
          },
        },
        unroutableAgentIds: Array.from(unroutableIds).sort(),
      };
    }

    // 5. Budget estimate
    // Unroutable rows: if verified, use verified unroutable row count; if unverified, use malformed/missing agent rows
    const unroutableRowsForBudget = routingResult.status === "verified"
      ? (routingResult.counts.rows.unroutable ?? 0)
      : populatedCounts.agentIdHygiene.totalMalformedOrMissingCount;

    const budgetEstimate = estimateConversionBudget({
      totalRows: populatedCounts.totalRows,
      noiseRows: populatedCounts.noise.candidateCount,
      unroutableRows: unroutableRowsForBudget,
      duplicateSurplusRows: populatedCounts.duplicates.surplusRows,
      averageTextLength: populatedCounts.contentLength.average,
    });

    const report: CensusReport = {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      readOnly: true,
      tenantDatabase: {
        databaseName: tenantDbName,
        host: parsedTenantUrl.hostname,
        port: parseInt(parsedTenantUrl.port || "5432", 10),
        user: parsedTenantUrl.username || "current_user",
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
      caveats: [
        "READ-ONLY RUN: No data was written, modified, or migrated.",
        routingResult!.status === "unverified"
          ? "ROUTING UNVERIFIED: Control plane URL was not provided. Agent existence and routing status could not be verified."
          : "ROUTING VERIFIED: Agent routing verified against control plane.",
        "BUDGET ESTIMATE: Costs and durations are planning estimates based on standard rate tiers and token models.",
      ],
    };

    if (outputPath) {
      validateOutputPath(outputPath, repoRoot);
      const outputText = format === "json"
        ? JSON.stringify(report, null, 2)
        : formatCensusTextReport(report);

      await writeFile(outputPath, outputText, {
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
  if (report.routing.unroutableAgentIds.length > 0) {
    lines.push(`  - Unroutable Agent IDs:       [ ${report.routing.unroutableAgentIds.join(", ")} ]`);
  }
  lines.push("");

  lines.push("--- ESTIMATED CONVERSION BUDGET (ESTIMATE ONLY) ---");
  lines.push(`  - Rows to Convert:            ${report.budget.rowsToConvert.toLocaleString()} rows`);
  lines.push(`    (total: ${report.budget.subtractions.totalRows} - noise: ${report.budget.subtractions.noiseRows} - unroutable: ${report.budget.subtractions.unroutableRows} - duplicates: ${report.budget.subtractions.duplicateSurplusRows})`);
  lines.push(`  - Chat Input Tokens:          ~${report.budget.estimatedTokens.chatInput.toLocaleString()} tokens`);
  lines.push(`  - Chat Output Tokens:         ~${report.budget.estimatedTokens.chatOutput.toLocaleString()} tokens`);
  lines.push(`  - Embedding Tokens:           ~${report.budget.estimatedTokens.embeddingTotal.toLocaleString()} tokens`);
  lines.push(`  - Estimated Chat Cost:        ~$${report.budget.estimatedCostUsd.chat.toFixed(4)} USD`);
  lines.push(`  - Estimated Embedding Cost:   ~$${report.budget.estimatedCostUsd.embedding.toFixed(4)} USD`);
  lines.push(`  - Total Estimated USD:        ~$${report.budget.estimatedCostUsd.total.toFixed(4)} USD`);
  lines.push(`  - Estimated Wall Clock:       ~${report.budget.estimatedWallClock.humanReadable} (concurrency: ${report.budget.estimatedWallClock.concurrency}, bottleneck: ${report.budget.estimatedWallClock.bottleneck})`);
  lines.push("================================================================================");

  return lines.join("\n");
}
