/**
 * Tenant SQL operations for company memory upgrade sweep (TECH-8191).
 *
 * ARCHITECTURAL INVARIANTS:
 * - All tenant SQL operations live in this file.
 * - postgres.js is used directly for tenant connections (required for multi-statement DDL via simple protocol).
 * - The ONLY statement class issued against the LIVE collection table is SELECT.
 *   Every live table query includes a header comment documenting this invariant.
 * - Never create unique constraints or secondary indexes on the live collection table.
 */

import postgres from "postgres";
import {
  assertNoElevatedRolePrivileges,
  isValidUuid,
  ROLE_PRIVILEGE_PREFLIGHT_SQL_TEXT,
  type RolePrivilegeRow,
  validateAndResolveTableIdentifier,
} from "./census.js";
import {
  MODEL_CLASSIFIED_NOISE_REASON_CODE,
  MODEL_CLASSIFIED_SENSITIVE_REASON_CODE,
} from "./llm-converter.js";
import {
  acquireSourceAdvisoryLock,
  type TenantFence,
  validateTenantFence,
} from "./tenant-fence.js";
import {
  assertSupportedStagingVectorType,
  ensureUpgradeTables,
} from "./tenant-tables.js";

export type { TenantFence } from "./tenant-fence.js";
import {
  CompanyMemoryUpgradeError,
  UPGRADE_LEDGER_OUTCOMES,
  type UpgradeLedgerOutcome,
} from "./types.js";

export { assertSupportedStagingVectorType, ensureUpgradeTables, UPGRADE_LEDGER_OUTCOMES };

export interface TenantSourceRow {
  id: string;
  agentId: string | null;
  userId: string | null;
  data: string | null;
  createdAt: string | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface TenantCollectionShape {
  table: string;
  embeddingColumn: string;
  embeddingDims: number;
  embeddingType: string;
  payloadType: "jsonb" | "json";
  rowCount: number;
  isUuidId: boolean;
}

export const VALID_UNROUTABLE_REASONS = [
  "missing_agent_id",
  "malformed_agent_id",
  "unknown_agent",
  "non_memory_adapter",
  "terminated",
  "pending_approval",
  "unknown_status",
] as const;

export type UnroutableReasonCode = (typeof VALID_UNROUTABLE_REASONS)[number];

export const VALID_NOISE_REASONS = [
  "empty",
  "exact_placeholder_or_greeting",
  // Model-decided drop_noise outcomes (no deterministic preflight match) carry this exact
  // bounded literal, mirroring the MODEL_CLASSIFIED_SENSITIVE_REASON_CODE precedent for
  // dropped_sensitive below (TECH-8191 Argus round 1 finding: model_classified_noise).
  MODEL_CLASSIFIED_NOISE_REASON_CODE,
] as const;

export type NoiseReasonCode = (typeof VALID_NOISE_REASONS)[number];

export const KNOWN_SENSITIVE_FAMILY_NAMES = [
  "apiKey",
  "bearerToken",
  "creditCard",
  "passwordAssignment",
  "privateKey",
  "ssn",
] as const;

export type KnownSensitiveFamilyName = (typeof KNOWN_SENSITIVE_FAMILY_NAMES)[number];

export function validateOutcomeReason(
  outcome: UpgradeLedgerOutcome,
  reasonCode: unknown,
): string | null {
  if (!UPGRADE_LEDGER_OUTCOMES.includes(outcome as UpgradeLedgerOutcome)) {
    throw new CompanyMemoryUpgradeError(
      `Invalid ledger outcome: must be one of [${UPGRADE_LEDGER_OUTCOMES.join(", ")}]`,
      "INVALID_ARGUMENT",
    );
  }

  if (outcome === "unroutable") {
    if (typeof reasonCode !== "string" || !VALID_UNROUTABLE_REASONS.includes(reasonCode as UnroutableReasonCode)) {
      throw new CompanyMemoryUpgradeError(
        `Invalid reason_code for outcome 'unroutable': must be one of [${VALID_UNROUTABLE_REASONS.join(", ")}]`,
        "INVALID_ARGUMENT",
      );
    }
    return reasonCode;
  }

  if (outcome === "dropped_noise") {
    if (typeof reasonCode !== "string" || !VALID_NOISE_REASONS.includes(reasonCode as NoiseReasonCode)) {
      throw new CompanyMemoryUpgradeError(
        `Invalid reason_code for outcome 'dropped_noise': must be one of [${VALID_NOISE_REASONS.join(", ")}]`,
        "INVALID_ARGUMENT",
      );
    }
    return reasonCode;
  }

  if (outcome === "dropped_sensitive") {
    if (typeof reasonCode !== "string" || reasonCode.trim() === "") {
      throw new CompanyMemoryUpgradeError(
        "reason_code is required for outcome 'dropped_sensitive'",
        "INVALID_ARGUMENT",
      );
    }

    // Exact bounded literal for model-classified sensitivity (no regex family matched on the
    // model's own output text, but the model itself decided drop_sensitive). This is a single
    // fixed value and is NEVER combined with family tokens in a CSV -- it is validated as an
    // exact match here, separately from the sorted family CSV validation below.
    if (reasonCode === MODEL_CLASSIFIED_SENSITIVE_REASON_CODE) {
      return reasonCode;
    }

    const tokens = reasonCode.split(",");
    for (const token of tokens) {
      if (!KNOWN_SENSITIVE_FAMILY_NAMES.includes(token as KnownSensitiveFamilyName)) {
        throw new CompanyMemoryUpgradeError(
          `Invalid sensitive family in reason_code. Must be one of [${KNOWN_SENSITIVE_FAMILY_NAMES.join(", ")}]`,
          "INVALID_ARGUMENT",
        );
      }
    }
    const sorted = [...new Set(tokens)].sort();
    if (sorted.length !== tokens.length || sorted.join(",") !== reasonCode) {
      throw new CompanyMemoryUpgradeError(
        `Sensitive reason_code must be sorted and deduplicated tokens (expected "${sorted.join(",")}")`,
        "INVALID_ARGUMENT",
      );
    }
    return reasonCode;
  }

  if (outcome === "superseded" || outcome === "source_deleted") {
    if (reasonCode !== null && reasonCode !== undefined) {
      throw new CompanyMemoryUpgradeError(
        `Outcome '${outcome}' does not permit a reason_code`,
        "INVALID_ARGUMENT",
      );
    }
    return null;
  }

  if (reasonCode === null || reasonCode === undefined) {
    return null;
  }
  if (typeof reasonCode !== "string") {
    throw new CompanyMemoryUpgradeError(
      `reason_code must be a string or null for outcome '${outcome}'`,
      "INVALID_ARGUMENT",
    );
  }
  if (reasonCode.length > 100 || !/^[a-z0-9_,-]+$/.test(reasonCode)) {
    throw new CompanyMemoryUpgradeError(
      `Invalid reason_code format for outcome '${outcome}'`,
      "INVALID_ARGUMENT",
    );
  }
  return reasonCode;
}

export interface LedgerRow {
  upgradeId: string;
  sourceId: string;
  sourceContentSha256: string;
  agentId: string | null;
  outcome: UpgradeLedgerOutcome;
  reasonCode: string | null;
  outputIds: string[];
}

export type CommitSourceOutcomeParams =
  | {
      upgradeId: string;
      sourceId: string;
      sourceContentSha256: string;
      agentId: string | null;
      outcome: "unroutable";
      reasonCode: UnroutableReasonCode;
    }
  | {
      upgradeId: string;
      sourceId: string;
      sourceContentSha256: string;
      agentId: string | null;
      outcome: "dropped_noise";
      reasonCode: NoiseReasonCode;
    }
  | {
      upgradeId: string;
      sourceId: string;
      sourceContentSha256: string;
      agentId: string | null;
      outcome: "dropped_sensitive";
      reasonCode: string;
    }
  | {
      upgradeId: string;
      sourceId: string;
      sourceContentSha256: string;
      agentId: string | null;
      outcome: "superseded" | "source_deleted";
      reasonCode?: null;
    }
  | {
      upgradeId: string;
      sourceId: string;
      sourceContentSha256: string;
      agentId: string | null;
      outcome: "published" | "deduplicated" | "quarantined";
      reasonCode?: string | null;
    };

export interface ReconcileTombstonesOptions {
  tombstoneSourceIds?: string[];
  minSourceId?: string;
  maxSourceId?: string;
  liveSourceIds?: string[];
  liveTableName?: string;
  isUuidId?: boolean;
  batchSize?: number;
  assertLeaseActive?: () => void;
}

export interface ReconcileTombstonesResult {
  tombstonesCount: number;
  deletedStagingCount: number;
  deletedDedupeCount: number;
  tombstoneSourceIds: string[];
}

/**
 * Opens a tenant postgres client connection.
 */
export function openTenantClient(
  databaseUrl: string,
  options?: { max?: number; onnotice?: () => void },
): postgres.Sql {
  return postgres(databaseUrl, {
    max: options?.max ?? 1,
    onnotice: options?.onnotice ?? (() => {}),
  });
}

/**
 * Runs role privilege preflight against tenant connection.
 */
export async function assertTenantRolePreflight(
  sql: postgres.Sql,
  connectionLabel: "tenant" | "control-plane" = "tenant",
): Promise<void> {
  const rows = (await sql.unsafe(
    ROLE_PRIVILEGE_PREFLIGHT_SQL_TEXT,
  )) as unknown as RolePrivilegeRow[];
  assertNoElevatedRolePrivileges(rows, connectionLabel, "memory upgrade sweep");
}

/**
 * Introspects the live collection table columns and validates pgvector(1536).
 */
export async function introspectCollection(
  sql: postgres.Sql,
  tableName: string = "mem0_memories",
  options?: { skipVectorIdentityCheck?: boolean },
): Promise<TenantCollectionShape> {
  const resolved = validateAndResolveTableIdentifier(tableName);

  /* Live collection table query (SELECT ONLY) */
  const columnRows = await sql`
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
    WHERE a.attrelid = to_regclass(${resolved.regclassArg})
      AND a.attnum > 0
      AND NOT a.attisdropped;
  `;

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

  if (!options?.skipVectorIdentityCheck) {
    const isVectorBaseType = vectorCol.typtype === "b";
    const isVectorTypeName = vectorCol.typname.toLowerCase() === "vector";
    const isOwningExtensionVector = vectorCol.extension_name === "vector";

    if (!isVectorBaseType || !isVectorTypeName || !isOwningExtensionVector) {
      throw new CompanyMemoryUpgradeError(
        `Mem0 table "${tableName}" column "${vectorColName}" is not a valid pgvector column (typtype="${vectorCol.typtype}", typname="${vectorCol.typname}", extension="${vectorCol.extension_name ?? "none"}"). Real pgvector extension type required.`,
        "NOT_PGVECTOR",
      );
    }

    const extRows = await sql`
      SELECT count(*)::int AS count
      FROM pg_extension
      WHERE extname = 'vector';
    `;

    if ((extRows[0]?.count ?? 0) === 0) {
      throw new CompanyMemoryUpgradeError(
        `Target database is missing required "vector" extension.`,
        "NOT_PGVECTOR",
      );
    }
  }

  const cleanedVectorType = options?.skipVectorIdentityCheck
    ? vectorCol.formatted_type.trim().replace(/^"|"$/g, "")
    : vectorCol.formatted_type.trim();
  // Introspection describes schema-qualified vector types; assertSupportedStagingVectorType enforces unqualified vector(1536) / text before staging.
  const vectorMatch = cleanedVectorType.match(
    /^(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?vector\((\d+)\)$/i,
  );
  const embeddingDims = vectorMatch ? parseInt(vectorMatch[1], 10) : null;

  if (embeddingDims !== 1536) {
    throw new CompanyMemoryUpgradeError(
      `Invalid embedding dimensions for Mem0 table "${tableName}": expected 1536, found ${embeddingDims ?? cleanedVectorType}. Upgrade target re-embeds at text-embedding-3-small (1536 dimensions).`,
      "EMBEDDING_DIMENSIONS_MISMATCH",
    );
  }

  /* Live collection table query (SELECT ONLY) */
  const countRows = await sql.unsafe(
    `/* Live collection table query (SELECT ONLY) */ SELECT count(*)::int AS count FROM ${resolved.regclassArg};`,
  );
  const rowCount = countRows[0]?.count ?? 0;

  // Preflight text-ID collections to ensure no duplicate IDs differing only in case
  if (!isUuidId && rowCount > 0) {
    const dupRows = await sql.unsafe(
      `/* Live collection table query (SELECT ONLY) */
      SELECT lower(t.id::text) AS id
      FROM ${resolved.regclassArg} t
      GROUP BY lower(t.id::text)
      HAVING count(*) > 1
      LIMIT 1;`,
    );
    if (dupRows.length > 0) {
      throw new CompanyMemoryUpgradeError(
        `Mem0 table "${tableName}" contains duplicate text IDs differing only in case.`,
        "UNSUPPORTED_SOURCE_ID",
      );
    }
  }

  return {
    table: tableName,
    embeddingColumn: vectorColName,
    embeddingDims: 1536,
    embeddingType: cleanedVectorType,
    payloadType: payloadType as "jsonb" | "json",
    rowCount,
    isUuidId,
  };
}

/**
 * Async generator to paginate through live source collection rows using keyset pagination.
 */
export async function* iterateSourcePages(
  sql: postgres.Sql,
  tableName: string,
  options: {
    pageSize?: number;
    maxRows?: number;
    isUuidId?: boolean;
    startAfterId?: string | null;
  } = {},
): AsyncGenerator<TenantSourceRow[]> {
  const resolved = validateAndResolveTableIdentifier(tableName);
  const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 1000;
  const isUuidId = options.isUuidId ?? true;

  let lastId: string | null = options.startAfterId ?? null;
  let totalYielded = 0;

  while (true) {
    if (options.maxRows !== undefined && totalYielded >= options.maxRows) {
      break;
    }

    const currentLimit = options.maxRows !== undefined
      ? Math.min(pageSize, options.maxRows - totalYielded)
      : pageSize;

    let rows: any[];

    /* Live collection table query (SELECT ONLY) */
    if (lastId === null) {
      rows = await sql.unsafe(`
        /* Live collection table query (SELECT ONLY) */
        SELECT
          lower(t.id::text) AS id,
          t.payload->>'agent_id' AS agent_id,
          t.payload->>'user_id' AS user_id,
          t.payload->>'data' AS data,
          t.payload->>'created_at' AS created_at,
          t.payload AS raw_payload
        FROM ${resolved.regclassArg} t
        ORDER BY ${isUuidId ? "t.id" : "lower(t.id::text) COLLATE \"C\""} ASC
        LIMIT ${currentLimit};
      `);
    } else if (isUuidId) {
      rows = await sql.unsafe(
        `
        /* Live collection table query (SELECT ONLY) */
        SELECT
          lower(t.id::text) AS id,
          t.payload->>'agent_id' AS agent_id,
          t.payload->>'user_id' AS user_id,
          t.payload->>'data' AS data,
          t.payload->>'created_at' AS created_at,
          t.payload AS raw_payload
        FROM ${resolved.regclassArg} t
        WHERE t.id > $1::uuid
        ORDER BY t.id ASC
        LIMIT ${currentLimit};
      `,
        [lastId],
      );
    } else {
      rows = await sql.unsafe(
        `
        /* Live collection table query (SELECT ONLY) */
        SELECT
          lower(t.id::text) AS id,
          t.payload->>'agent_id' AS agent_id,
          t.payload->>'user_id' AS user_id,
          t.payload->>'data' AS data,
          t.payload->>'created_at' AS created_at,
          t.payload AS raw_payload
        FROM ${resolved.regclassArg} t
        WHERE lower(t.id::text) COLLATE "C" > $1::text COLLATE "C"
        ORDER BY lower(t.id::text) COLLATE "C" ASC
        LIMIT ${currentLimit};
      `,
        [lastId],
      );
    }

    if (rows.length === 0) {
      break;
    }

    const page: TenantSourceRow[] = rows.map((r) => {
      let rawPayload: Record<string, unknown> | null = null;
      if (r.raw_payload) {
        if (typeof r.raw_payload === "object") {
          rawPayload = r.raw_payload;
        } else if (typeof r.raw_payload === "string") {
          try {
            // Note: postgres.js parses json/jsonb columns natively; this fallback is defensive and consumed downstream by conversion.
            rawPayload = JSON.parse(r.raw_payload);
          } catch {
            rawPayload = null;
          }
        }
      }
      return {
        id: String(r.id).toLowerCase(),
        agentId: r.agent_id ?? null,
        userId: r.user_id ?? null,
        data: r.data ?? null,
        createdAt: r.created_at ?? null,
        rawPayload,
      };
    });

    lastId = page[page.length - 1].id;
    totalYielded += page.length;

    yield page;
  }
}

/**
 * Loads upgrade ledger entries for a list of source IDs.
 */
export async function loadLedgerForSources(
  sql: postgres.Sql,
  upgradeId: string,
  sourceIds: string[],
): Promise<Map<string, LedgerRow>> {
  const map = new Map<string, LedgerRow>();
  if (sourceIds.length === 0) {
    return map;
  }

  for (const id of sourceIds) {
    if (!isValidUuid(id)) {
      throw new CompanyMemoryUpgradeError(
        "sourceIds must be valid UUID strings.",
        "UNSUPPORTED_SOURCE_ID",
      );
    }
  }

  const rows = await sql`
    SELECT
      upgrade_id,
      source_id,
      source_content_sha256,
      agent_id,
      outcome,
      reason_code,
      output_ids
    FROM paperclip_memory_upgrade_ledger
    WHERE upgrade_id = ${upgradeId}::uuid
      AND source_id = ANY(${sourceIds}::uuid[]);
  `;

  for (const r of rows) {
    const canonicalId = String(r.source_id).toLowerCase();
    map.set(canonicalId, {
      upgradeId: r.upgrade_id,
      sourceId: canonicalId,
      sourceContentSha256: r.source_content_sha256,
      agentId: r.agent_id ?? null,
      outcome: r.outcome as UpgradeLedgerOutcome,
      reasonCode: r.reason_code ?? null,
      outputIds: r.output_ids ?? [],
    });
  }

  return map;
}

/**
 * Reconciles tombstones: ledger rows whose source_id no longer exists in the live table.
 * Sets outcome to 'source_deleted' and deletes unpublished staging and dedupe rows.
 * Published staging rows are NEVER deleted.
 * Rows already in 'source_deleted' outcome are skipped.
 */
export async function reconcileTombstones(
  sql: postgres.Sql,
  upgradeId: string,
  options: ReconcileTombstonesOptions,
  fence: TenantFence,
): Promise<ReconcileTombstonesResult> {
  if (!fence || fence.upgradeId !== upgradeId) {
    throw new CompanyMemoryUpgradeError(
      "reconcileTombstones requires a valid tenant fence for this upgrade.",
      "INVALID_ARGUMENT",
    );
  }
  options.assertLeaseActive?.();

  let tombstoneIds: string[] = [];

  if (options.tombstoneSourceIds && options.tombstoneSourceIds.length > 0) {
    for (const id of options.tombstoneSourceIds) {
      if (!isValidUuid(id)) {
        throw new CompanyMemoryUpgradeError(
          "tombstoneSourceIds must be valid UUID strings.",
          "UNSUPPORTED_SOURCE_ID",
        );
      }
    }
    // Check which ones are not already source_deleted
    const checkRows = await sql`
      SELECT source_id
      FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ANY(${options.tombstoneSourceIds}::uuid[])
        AND outcome != 'source_deleted'
      ORDER BY source_id ASC;
    `;
    tombstoneIds = checkRows.map((r) => r.source_id);
  } else if (
    options.minSourceId !== undefined &&
    options.maxSourceId !== undefined &&
    options.liveSourceIds !== undefined
  ) {
    if (!isValidUuid(options.minSourceId) || !isValidUuid(options.maxSourceId)) {
      throw new CompanyMemoryUpgradeError(
        "minSourceId and maxSourceId must be valid UUID strings.",
        "UNSUPPORTED_SOURCE_ID",
      );
    }
    for (const id of options.liveSourceIds) {
      if (!isValidUuid(id)) {
        throw new CompanyMemoryUpgradeError(
          "liveSourceIds must contain valid UUID strings.",
          "UNSUPPORTED_SOURCE_ID",
        );
      }
    }
    const liveSet = new Set(options.liveSourceIds.map((id) => id.toLowerCase()));
    const rangeRows = await sql`
      SELECT source_id
      FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id >= ${options.minSourceId.toLowerCase()}::uuid
        AND source_id <= ${options.maxSourceId.toLowerCase()}::uuid
        AND outcome != 'source_deleted'
      ORDER BY source_id ASC;
    `;
    tombstoneIds = rangeRows
      .map((r) => String(r.source_id).toLowerCase())
      .filter((id) => !liveSet.has(id));
  } else if (options.liveTableName) {
    options.assertLeaseActive?.();
    const resolved = validateAndResolveTableIdentifier(options.liveTableName);
    const isUuid = options.isUuidId ?? true;
    const missingRows = await sql.unsafe(`
      SELECT l.source_id
      FROM paperclip_memory_upgrade_ledger l
      WHERE l.upgrade_id = $1::uuid
        AND l.outcome != 'source_deleted'
        AND NOT EXISTS (
          /* Live collection table query (SELECT ONLY) */
          SELECT 1 FROM ${resolved.regclassArg} t WHERE ${isUuid ? "t.id = l.source_id" : "lower(t.id::text) = l.source_id::text"}
        )
      ORDER BY l.source_id ASC;
    `, [upgradeId]);
    tombstoneIds = missingRows.map((r) => String(r.source_id).toLowerCase());
  }

  if (tombstoneIds.length === 0) {
    return {
      tombstonesCount: 0,
      deletedStagingCount: 0,
      deletedDedupeCount: 0,
      tombstoneSourceIds: [],
    };
  }

  let deletedStagingCount = 0;
  let deletedDedupeCount = 0;
  let actualTombstonesCount = 0;

  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 200;

  for (let i = 0; i < tombstoneIds.length; i += batchSize) {
    options.assertLeaseActive?.();
    const batch = tombstoneIds.slice(i, i + batchSize);

    await sql.begin(async (tx: any) => {
      // L1: per-source advisory locks in ascending canonical order via one unnest() statement
      const sortedKeys = [...new Set(batch.map((s) => `paperclip:memory-upgrade-source:${upgradeId.toLowerCase()}:${s.toLowerCase()}`))].sort();
      if (sortedKeys.length > 0) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(k, 0)) FROM unnest(${sortedKeys}::text[]) AS k`;
      }
      // L2: fence row SHARE lock, held to commit
      await validateTenantFence(tx, fence);

      // 1. Find unpublished staging output_ids
      const stagingRows = await tx`
        SELECT output_id
        FROM paperclip_memory_upgrade_staging
        WHERE upgrade_id = ${upgradeId}::uuid
          AND source_id = ANY(${batch}::uuid[])
          AND published_at IS NULL;
      `;
      const outputIds = stagingRows.map((r: any) => r.output_id);

      // 2. Delete matching dedupe rows
      if (outputIds.length > 0) {
        const deletedDedupe = await tx`
          DELETE FROM paperclip_memory_upgrade_dedupe
          WHERE upgrade_id = ${upgradeId}::uuid
            AND output_id = ANY(${outputIds}::uuid[])
          RETURNING output_id;
        `;
        deletedDedupeCount += deletedDedupe.length;
      }

      // 3. Delete unpublished staging rows
      const deletedStaging = await tx`
        DELETE FROM paperclip_memory_upgrade_staging
        WHERE upgrade_id = ${upgradeId}::uuid
          AND source_id = ANY(${batch}::uuid[])
          AND published_at IS NULL
        RETURNING output_id;
      `;
      deletedStagingCount += deletedStaging.length;

      // 4. Update ledger outcome to source_deleted, recomputing output_ids from staging
      // AFTER the unpublished-row deletes above so the ledger never references a staging
      // row that no longer exists. By construction, anything still staged for these
      // sources at this point has published_at IS NOT NULL (still-live published outputs),
      // which must be retained and kept referenced going forward.
      const updatedRows = await tx`
        UPDATE paperclip_memory_upgrade_ledger AS l
        SET
          outcome = 'source_deleted',
          reason_code = NULL,
          output_ids = COALESCE((
            SELECT array_agg(s.output_id ORDER BY s.output_id)
            FROM paperclip_memory_upgrade_staging s
            WHERE s.upgrade_id = l.upgrade_id
              AND s.source_id = l.source_id
          ), '{}'),
          updated_at = now()
        WHERE l.upgrade_id = ${upgradeId}::uuid
          AND l.source_id = ANY(${batch}::uuid[])
          AND l.outcome <> 'source_deleted'
        RETURNING l.source_id;
      `;
      actualTombstonesCount += updatedRows.length;
    });
  }

  return {
    tombstonesCount: actualTombstonesCount,
    deletedStagingCount,
    deletedDedupeCount,
    tombstoneSourceIds: tombstoneIds,
  };
}

export interface ReconcileChangedContentParams {
  upgradeId: string;
  sourceId: string;
  sourceContentSha256?: string;
  agentId?: string | null;
}

/**
 * Reconciles changed content for a single source.
 * Clears unpublished staging and dedupe rows, and deletes the stale ledger row so
 * the source can reclassify cleanly without leaving stale superseded rows.
 * If published rows remain, the ledger row is marked 'superseded' with the new
 * hash and agent (if provided) and retained output_ids.
 */
export async function reconcileChangedContent(
  sql: postgres.Sql,
  paramsOrUpgradeId: ReconcileChangedContentParams | string,
  sourceIdOrFence: string | TenantFence,
  fenceMaybe?: TenantFence,
): Promise<{ deletedStagingCount: number; deletedDedupeCount: number; retainedOutputIds: string[] }> {
  let upgradeId: string;
  let sourceId: string;
  let sourceContentSha256: string | undefined;
  let agentId: string | null | undefined;
  let fence: TenantFence;

  if (typeof paramsOrUpgradeId === "string") {
    upgradeId = paramsOrUpgradeId;
    sourceId = sourceIdOrFence as string;
    fence = fenceMaybe!;
  } else {
    upgradeId = paramsOrUpgradeId.upgradeId;
    sourceId = paramsOrUpgradeId.sourceId;
    sourceContentSha256 = paramsOrUpgradeId.sourceContentSha256;
    agentId = paramsOrUpgradeId.agentId;
    fence = sourceIdOrFence as TenantFence;
  }

  if (!isValidUuid(sourceId)) {
    throw new CompanyMemoryUpgradeError(
      "sourceId must be a valid UUID string.",
      "UNSUPPORTED_SOURCE_ID",
    );
  }
  if (!isValidUuid(upgradeId)) {
    throw new CompanyMemoryUpgradeError(
      "upgradeId must be a valid UUID string.",
      "INVALID_ARGUMENT",
    );
  }
  if (agentId && !isValidUuid(agentId)) {
    throw new CompanyMemoryUpgradeError(
      "agentId must be a valid UUID string.",
      "INVALID_ARGUMENT",
    );
  }
  if (!fence || fence.upgradeId !== upgradeId) {
    throw new CompanyMemoryUpgradeError(
      "reconcileChangedContent requires a valid tenant fence for this upgrade.",
      "INVALID_ARGUMENT",
    );
  }

  let deletedStagingCount = 0;
  let deletedDedupeCount = 0;
  let retainedOutputIds: string[] = [];

  await sql.begin(async (tx: any) => {
    // L1: per-source advisory lock BEFORE the fence row lock, serializing two workers that
    // might otherwise race this source's dedupe/staging/ledger bookkeeping concurrently.
    await acquireSourceAdvisoryLock(tx, upgradeId, sourceId);
    // L2: fence row SHARE lock, held to commit.
    await validateTenantFence(tx, fence);

    // 1. Find unpublished staging output_ids
    const stagingRows = await tx`
      SELECT output_id
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ${sourceId}::uuid
        AND published_at IS NULL;
    `;
    const outputIds = stagingRows.map((r: any) => r.output_id);

    // 2. Delete matching dedupe rows
    if (outputIds.length > 0) {
      const deletedDedupe = await tx`
        DELETE FROM paperclip_memory_upgrade_dedupe
        WHERE upgrade_id = ${upgradeId}::uuid
          AND output_id = ANY(${outputIds}::uuid[])
        RETURNING output_id;
      `;
      deletedDedupeCount = deletedDedupe.length;
    }

    // 3. Delete unpublished staging rows
    const deletedStaging = await tx`
      DELETE FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ${sourceId}::uuid
        AND published_at IS NULL
      RETURNING output_id;
    `;
    deletedStagingCount = deletedStaging.length;

    // 4. Recompute remaining (still-published) staging output_ids for this source, AFTER
    // the unpublished-row deletes above.
    const remainingRows = await tx`
      SELECT output_id
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ${sourceId}::uuid
      ORDER BY output_id ASC;
    `;
    retainedOutputIds = remainingRows.map((r: any) => String(r.output_id));

    if (retainedOutputIds.length === 0) {
      // No published rows remain referencing this source: safe to delete the stale ledger
      // row entirely so the changed source can reclassify cleanly from scratch.
      await tx`
        DELETE FROM paperclip_memory_upgrade_ledger
        WHERE upgrade_id = ${upgradeId}::uuid
          AND source_id = ${sourceId}::uuid;
      `;
    } else {
      // Published rows remain live and must stay referenced by SOME ledger row: mark the
      // row 'superseded' (rather than deleting it) and retain exactly the ids still staged.
      // If the new content hash and agent were provided, update them onto the row so the
      // ledger accurately describes the source at the time it was superseded.
      if (sourceContentSha256 !== undefined) {
        if (agentId !== undefined) {
          const agentSql = agentId ? sql`${agentId}::uuid` : null;
          await tx`
            UPDATE paperclip_memory_upgrade_ledger
            SET
              outcome = 'superseded',
              reason_code = NULL,
              output_ids = ${retainedOutputIds}::uuid[],
              source_content_sha256 = ${sourceContentSha256},
              agent_id = ${agentSql},
              updated_at = now()
            WHERE upgrade_id = ${upgradeId}::uuid
              AND source_id = ${sourceId}::uuid;
          `;
        } else {
          await tx`
            UPDATE paperclip_memory_upgrade_ledger
            SET
              outcome = 'superseded',
              reason_code = NULL,
              output_ids = ${retainedOutputIds}::uuid[],
              source_content_sha256 = ${sourceContentSha256},
              updated_at = now()
            WHERE upgrade_id = ${upgradeId}::uuid
              AND source_id = ${sourceId}::uuid;
          `;
        }
      } else {
        await tx`
          UPDATE paperclip_memory_upgrade_ledger
          SET
            outcome = 'superseded',
            reason_code = NULL,
            output_ids = ${retainedOutputIds}::uuid[],
            updated_at = now()
          WHERE upgrade_id = ${upgradeId}::uuid
            AND source_id = ${sourceId}::uuid;
        `;
      }
    }
  });

  return { deletedStagingCount, deletedDedupeCount, retainedOutputIds };
}

/**
 * Commits a single source outcome to the ledger table.
 * Uses an ON CONFLICT (upgrade_id, source_id) DO UPDATE upsert in a single tenant transaction.
 */
export async function commitSourceOutcome(
  sql: postgres.Sql,
  params: CommitSourceOutcomeParams,
  fence: TenantFence,
): Promise<void> {
  const {
    upgradeId,
    sourceId,
    sourceContentSha256,
    agentId,
    outcome,
    reasonCode = null,
  } = params;

  if (!isValidUuid(sourceId)) {
    throw new CompanyMemoryUpgradeError(
      "sourceId must be a valid UUID string.",
      "UNSUPPORTED_SOURCE_ID",
    );
  }
  if (!isValidUuid(upgradeId)) {
    throw new CompanyMemoryUpgradeError(
      "upgradeId must be a valid UUID string.",
      "INVALID_ARGUMENT",
    );
  }
  if (agentId && !isValidUuid(agentId)) {
    throw new CompanyMemoryUpgradeError(
      "agentId must be a valid UUID string.",
      "INVALID_ARGUMENT",
    );
  }
  if (!fence || fence.upgradeId !== upgradeId) {
    throw new CompanyMemoryUpgradeError(
      "commitSourceOutcome requires a valid tenant fence for this upgrade.",
      "INVALID_ARGUMENT",
    );
  }

  const validatedReason = validateOutcomeReason(outcome, reasonCode);

  await sql.begin(async (tx: any) => {
    // L1 before L2: per-source advisory lock, then fence row validation.
    await acquireSourceAdvisoryLock(tx, upgradeId, sourceId);
    await validateTenantFence(tx, fence);

    await tx`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id,
        source_id,
        source_content_sha256,
        agent_id,
        outcome,
        reason_code,
        output_ids,
        created_at,
        updated_at
      ) VALUES (
        ${upgradeId}::uuid,
        ${sourceId}::uuid,
        ${sourceContentSha256},
        ${agentId ? sql`${agentId}::uuid` : null},
        ${outcome},
        ${validatedReason},
        COALESCE((
          SELECT array_agg(s.output_id ORDER BY s.output_id)
          FROM paperclip_memory_upgrade_staging s
          WHERE s.upgrade_id = ${upgradeId}::uuid
            AND s.source_id = ${sourceId}::uuid
        ), '{}'),
        now(),
        now()
      )
      ON CONFLICT (upgrade_id, source_id) DO UPDATE SET
        source_content_sha256 = EXCLUDED.source_content_sha256,
        agent_id = EXCLUDED.agent_id,
        outcome = EXCLUDED.outcome,
        reason_code = EXCLUDED.reason_code,
        output_ids = COALESCE((
          SELECT array_agg(s.output_id ORDER BY s.output_id)
          FROM paperclip_memory_upgrade_staging s
          WHERE s.upgrade_id = paperclip_memory_upgrade_ledger.upgrade_id
            AND s.source_id = paperclip_memory_upgrade_ledger.source_id
        ), '{}'),
        updated_at = now();
    `;
  });
}

export interface StageSourceRecordItem {
  outputId: string;
  dataSha256: string;
  payload: Record<string, unknown>;
  embedding: number[];
}

export interface StageSourceRecordsParams {
  upgradeId: string;
  sourceId: string;
  sourceContentSha256: string;
  agentId: string;
  records: StageSourceRecordItem[];
  vectorType?: string;
}

export interface StageSourceRecordsResult {
  outcome: "published" | "deduplicated";
  outputIds: string[];
  stagedCount: number;
  deduplicatedCount: number;
}

/**
 * Stages converted records for a single source row in one atomic tenant transaction.
 *
 * Operational rules:
 * - Deletes unpublished staging rows for the source and their matching dedupe slots.
 *   Published staging rows (published_at IS NOT NULL) are NEVER deleted.
 * - Claims dedupe slots via INSERT ... ON CONFLICT (upgrade_id, agent_id, data_sha256) DO NOTHING.
 * - Stages won records with published_at NULL (unambiguously not live).
 * - Upserts ledger with outcome 'published' (if >= 1 won) or 'deduplicated' (if all duplicate).
 *   NOTE: The ledger CHECK vocabulary has no 'staged'; published_at IS NULL is the
 *   authoritative marker for not-live staging rows.
 */
export async function stageSourceRecords(
  sql: postgres.Sql,
  params: StageSourceRecordsParams,
  fence: TenantFence,
): Promise<StageSourceRecordsResult> {
  const { upgradeId, sourceId, sourceContentSha256, agentId, records } = params;

  if (!isValidUuid(sourceId)) {
    throw new CompanyMemoryUpgradeError(
      "sourceId must be a valid UUID string.",
      "UNSUPPORTED_SOURCE_ID",
    );
  }
  if (!isValidUuid(upgradeId)) {
    throw new CompanyMemoryUpgradeError(
      "upgradeId must be a valid UUID string.",
      "INVALID_ARGUMENT",
    );
  }
  if (!isValidUuid(agentId)) {
    throw new CompanyMemoryUpgradeError(
      "agentId must be a valid UUID string.",
      "INVALID_ARGUMENT",
    );
  }
  if (!fence || fence.upgradeId !== upgradeId) {
    throw new CompanyMemoryUpgradeError(
      "stageSourceRecords requires a valid tenant fence for this upgrade.",
      "INVALID_ARGUMENT",
    );
  }

  const normalizedVectorType = params.vectorType?.trim().toLowerCase();
  const isTextVector = normalizedVectorType === "text";

  if (!isTextVector) {
    // TECH-8191 follow-up: the staging INSERT hardcodes an unqualified ::vector(1536) cast;
    // schema-qualified or non-1536 pgvector is unsupported until the cast is parameterised.
    assertSupportedStagingVectorType(params.vectorType ?? "vector(1536)");
    for (const record of records) {
      if (!Array.isArray(record.embedding) || record.embedding.length !== 1536) {
        throw new CompanyMemoryUpgradeError(
          "Embedding dimensions mismatch: records must contain exactly 1536 dimensions",
          "INVALID_ARGUMENT",
        );
      }
    }
  }

  let resultOutcome: "published" | "deduplicated" = "published";
  const wonOutputIds: string[] = [];

  await sql.begin(async (tx: any) => {
    // L1 before L2: per-source advisory lock, then fence row validation. Serializes two
    // workers racing this source's dedupe slots and ledger bookkeeping.
    await acquireSourceAdvisoryLock(tx, upgradeId, sourceId);
    await validateTenantFence(tx, fence);

    // 1. Find unpublished staging output_ids for this source
    const existingStaging = await tx`
      SELECT output_id
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ${sourceId}::uuid
        AND published_at IS NULL;
    `;
    const oldOutputIds = existingStaging.map((r: any) => r.output_id);

    // 2. Delete matching dedupe rows and unpublished staging rows
    if (oldOutputIds.length > 0) {
      await tx`
        DELETE FROM paperclip_memory_upgrade_dedupe
        WHERE upgrade_id = ${upgradeId}::uuid
          AND output_id = ANY(${oldOutputIds}::uuid[]);
      `;
      await tx`
        DELETE FROM paperclip_memory_upgrade_staging
        WHERE upgrade_id = ${upgradeId}::uuid
          AND source_id = ${sourceId}::uuid
          AND published_at IS NULL;
      `;
    }

    // 3. Claim dedupe slots for each record
    const wonRecords: StageSourceRecordItem[] = [];
    for (const rec of records) {
      if (!isValidUuid(rec.outputId)) {
        throw new CompanyMemoryUpgradeError(
          "outputId must be a valid UUID string.",
          "INVALID_ARGUMENT",
        );
      }

      const claimRows = await tx`
        INSERT INTO paperclip_memory_upgrade_dedupe (
          upgrade_id,
          agent_id,
          data_sha256,
          output_id,
          created_at
        ) VALUES (
          ${upgradeId}::uuid,
          ${agentId}::uuid,
          ${rec.dataSha256},
          ${rec.outputId}::uuid,
          now()
        )
        ON CONFLICT (upgrade_id, agent_id, data_sha256) DO NOTHING
        RETURNING output_id;
      `;

      if (claimRows.length > 0) {
        wonRecords.push(rec);
        wonOutputIds.push(rec.outputId);
      }
    }

    // 4. Stage won records (published_at IS NULL)
    for (const won of wonRecords) {
      const vectorLiteral = JSON.stringify(won.embedding);
      if (isTextVector) {
        await tx`
          INSERT INTO paperclip_memory_upgrade_staging (
            upgrade_id,
            source_id,
            output_id,
            agent_id,
            payload,
            embedding,
            content_sha256,
            published_at,
            created_at
          ) VALUES (
            ${upgradeId}::uuid,
            ${sourceId}::uuid,
            ${won.outputId}::uuid,
            ${agentId}::uuid,
            ${JSON.stringify(won.payload)}::jsonb,
            ${vectorLiteral}::text,
            ${won.dataSha256},
            NULL,
            now()
          );
        `;
      } else {
        await tx`
          INSERT INTO paperclip_memory_upgrade_staging (
            upgrade_id,
            source_id,
            output_id,
            agent_id,
            payload,
            embedding,
            content_sha256,
            published_at,
            created_at
          ) VALUES (
            ${upgradeId}::uuid,
            ${sourceId}::uuid,
            ${won.outputId}::uuid,
            ${agentId}::uuid,
            ${JSON.stringify(won.payload)}::jsonb,
            ${vectorLiteral}::vector(1536),
            ${won.dataSha256},
            NULL,
            now()
          );
        `;
      }
    }

    // 5. Recompute the FULL set of output_ids referenced by this source's ledger row from
    // staging, AFTER all staging mutations above. This must include not just the records
    // just won in step 4, but also any PRE-EXISTING published rows for this source that
    // were untouched by this call (the delete in step 2 only ever removes unpublished
    // rows) -- otherwise a still-live published row would silently become unreferenced by
    // any ledger row, violating the "every staging output is referenced in the source
    // ledger" invariant.
    const allStagingRows = await tx`
      SELECT output_id
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ${sourceId}::uuid
      ORDER BY output_id ASC;
    `;
    const recomputedOutputIds = allStagingRows.map((r: any) => String(r.output_id));

    // 6. Upsert ledger outcome
    // NOTE: The CHECK vocabulary has no 'staged'; published_at IS NULL in staging
    // is the authoritative not-live marker.
    if (wonRecords.length > 0) {
      resultOutcome = "published";
      await tx`
        INSERT INTO paperclip_memory_upgrade_ledger (
          upgrade_id,
          source_id,
          source_content_sha256,
          agent_id,
          outcome,
          reason_code,
          output_ids,
          created_at,
          updated_at
        ) VALUES (
          ${upgradeId}::uuid,
          ${sourceId}::uuid,
          ${sourceContentSha256},
          ${agentId}::uuid,
          'published',
          NULL,
          ${recomputedOutputIds}::uuid[],
          now(),
          now()
        )
        ON CONFLICT (upgrade_id, source_id) DO UPDATE SET
          source_content_sha256 = EXCLUDED.source_content_sha256,
          agent_id = EXCLUDED.agent_id,
          outcome = EXCLUDED.outcome,
          reason_code = EXCLUDED.reason_code,
          output_ids = EXCLUDED.output_ids,
          updated_at = now();
      `;
    } else {
      resultOutcome = "deduplicated";
      await tx`
        INSERT INTO paperclip_memory_upgrade_ledger (
          upgrade_id,
          source_id,
          source_content_sha256,
          agent_id,
          outcome,
          reason_code,
          output_ids,
          created_at,
          updated_at
        ) VALUES (
          ${upgradeId}::uuid,
          ${sourceId}::uuid,
          ${sourceContentSha256},
          ${agentId}::uuid,
          'deduplicated',
          NULL,
          ${recomputedOutputIds}::uuid[],
          now(),
          now()
        )
        ON CONFLICT (upgrade_id, source_id) DO UPDATE SET
          source_content_sha256 = EXCLUDED.source_content_sha256,
          agent_id = EXCLUDED.agent_id,
          outcome = EXCLUDED.outcome,
          reason_code = EXCLUDED.reason_code,
          output_ids = EXCLUDED.output_ids,
          updated_at = now();
      `;
    }
  });

  return {
    outcome: resultOutcome,
    outputIds: wonOutputIds,
    stagedCount: wonOutputIds.length,
    deduplicatedCount: records.length - wonOutputIds.length,
  };
}
