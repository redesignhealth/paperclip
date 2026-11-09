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
import { ensureUpgradeTables } from "./tenant-tables.js";
import { CompanyMemoryUpgradeError, type UpgradeLedgerOutcome } from "./types.js";

export { ensureUpgradeTables };

export interface TenantSourceRow {
  id: string;
  agentId: string | null;
  userId: string | null;
  data: string | null;
  createdAt: string | null;
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
    const tokens = reasonCode.split(",");
    for (const token of tokens) {
      if (!KNOWN_SENSITIVE_FAMILY_NAMES.includes(token as KnownSensitiveFamilyName)) {
        throw new CompanyMemoryUpgradeError(
          `Invalid sensitive family "${token}" in reason_code. Must be one of [${KNOWN_SENSITIVE_FAMILY_NAMES.join(", ")}]`,
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
  if (reasonCode.length > 100 || !/^[a-zA-Z0-9_, -]+$/.test(reasonCode)) {
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
          t.payload->>'created_at' AS created_at
        FROM ${resolved.regclassArg} t
        ORDER BY ${isUuidId ? "t.id" : "lower(t.id::text)"} ASC
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
          t.payload->>'created_at' AS created_at
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
          t.payload->>'created_at' AS created_at
        FROM ${resolved.regclassArg} t
        WHERE lower(t.id::text) > $1::text
        ORDER BY lower(t.id::text) ASC
        LIMIT ${currentLimit};
      `,
        [lastId],
      );
    }

    if (rows.length === 0) {
      break;
    }

    const page: TenantSourceRow[] = rows.map((r) => ({
      id: String(r.id).toLowerCase(),
      agentId: r.agent_id ?? null,
      userId: r.user_id ?? null,
      data: r.data ?? null,
      createdAt: r.created_at ?? null,
    }));

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
): Promise<ReconcileTombstonesResult> {
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

  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 500;

  for (let i = 0; i < tombstoneIds.length; i += batchSize) {
    options.assertLeaseActive?.();
    const batch = tombstoneIds.slice(i, i + batchSize);

    await sql.begin(async (tx: any) => {
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

      // 4. Update ledger outcome to source_deleted
      const updatedRows = await tx`
        UPDATE paperclip_memory_upgrade_ledger
        SET
          outcome = 'source_deleted',
          reason_code = NULL,
          updated_at = now()
        WHERE upgrade_id = ${upgradeId}::uuid
          AND source_id = ANY(${batch}::uuid[])
          AND outcome <> 'source_deleted'
        RETURNING source_id;
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

/**
 * Reconciles changed content for a single source.
 * Clears unpublished staging and dedupe rows, and deletes the stale ledger row so
 * the source can reclassify cleanly without leaving stale superseded rows.
 */
export async function reconcileChangedContent(
  sql: postgres.Sql,
  upgradeId: string,
  sourceId: string,
): Promise<{ deletedStagingCount: number; deletedDedupeCount: number }> {
  if (!isValidUuid(sourceId)) {
    throw new CompanyMemoryUpgradeError(
      "sourceId must be a valid UUID string.",
      "UNSUPPORTED_SOURCE_ID",
    );
  }

  let deletedStagingCount = 0;
  let deletedDedupeCount = 0;

  await sql.begin(async (tx: any) => {
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

    // 4. Delete stale ledger row so changed source can reclassify cleanly
    await tx`
      DELETE FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ${sourceId}::uuid;
    `;
  });

  return { deletedStagingCount, deletedDedupeCount };
}

/**
 * Commits a single source outcome to the ledger table.
 * Uses an ON CONFLICT (upgrade_id, source_id) DO UPDATE upsert in a single tenant transaction.
 */
export async function commitSourceOutcome(
  sql: postgres.Sql,
  params: CommitSourceOutcomeParams,
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

  const validatedReason = validateOutcomeReason(outcome, reasonCode);

  await sql.begin(async (tx: any) => {
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
        '{}',
        now(),
        now()
      )
      ON CONFLICT (upgrade_id, source_id) DO UPDATE SET
        source_content_sha256 = EXCLUDED.source_content_sha256,
        agent_id = EXCLUDED.agent_id,
        outcome = EXCLUDED.outcome,
        reason_code = EXCLUDED.reason_code,
        updated_at = now();
    `;
  });
}
