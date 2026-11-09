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

export interface LedgerRow {
  upgradeId: string;
  sourceId: string;
  sourceContentSha256: string;
  agentId: string | null;
  outcome: UpgradeLedgerOutcome;
  reasonCode: string | null;
  outputIds: string[];
}

export interface CommitSourceOutcomeParams {
  upgradeId: string;
  sourceId: string;
  sourceContentSha256: string;
  agentId: string | null;
  outcome: UpgradeLedgerOutcome;
  reasonCode?: string | null;
}

export interface ReconcileTombstonesOptions {
  tombstoneSourceIds?: string[];
  minSourceId?: string;
  maxSourceId?: string;
  liveSourceIds?: string[];
  liveTableName?: string;
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
          t.id::text AS id,
          t.payload->>'agent_id' AS agent_id,
          t.payload->>'user_id' AS user_id,
          t.payload->>'data' AS data,
          t.payload->>'created_at' AS created_at
        FROM ${resolved.regclassArg} t
        ORDER BY t.id ASC
        LIMIT ${currentLimit};
      `);
    } else if (isUuidId) {
      rows = await sql.unsafe(
        `
        /* Live collection table query (SELECT ONLY) */
        SELECT
          t.id::text AS id,
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
          t.id::text AS id,
          t.payload->>'agent_id' AS agent_id,
          t.payload->>'user_id' AS user_id,
          t.payload->>'data' AS data,
          t.payload->>'created_at' AS created_at
        FROM ${resolved.regclassArg} t
        WHERE t.id > $1::text
        ORDER BY t.id ASC
        LIMIT ${currentLimit};
      `,
        [lastId],
      );
    }

    if (rows.length === 0) {
      break;
    }

    const page: TenantSourceRow[] = rows.map((r) => ({
      id: r.id,
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
    map.set(r.source_id, {
      upgradeId: r.upgrade_id,
      sourceId: r.source_id,
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
  let tombstoneIds: string[] = [];

  if (options.tombstoneSourceIds && options.tombstoneSourceIds.length > 0) {
    // Check which ones are not already source_deleted
    const checkRows = await sql`
      SELECT source_id
      FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ANY(${options.tombstoneSourceIds}::uuid[])
        AND outcome != 'source_deleted';
    `;
    tombstoneIds = checkRows.map((r) => r.source_id);
  } else if (
    options.minSourceId !== undefined &&
    options.maxSourceId !== undefined &&
    options.liveSourceIds !== undefined
  ) {
    const liveSet = new Set(options.liveSourceIds);
    const rangeRows = await sql`
      SELECT source_id
      FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id >= ${options.minSourceId}::uuid
        AND source_id <= ${options.maxSourceId}::uuid
        AND outcome != 'source_deleted';
    `;
    tombstoneIds = rangeRows
      .map((r) => r.source_id)
      .filter((id) => !liveSet.has(id));
  } else if (options.liveTableName) {
    const resolved = validateAndResolveTableIdentifier(options.liveTableName);
    const missingRows = await sql.unsafe(`
      SELECT l.source_id
      FROM paperclip_memory_upgrade_ledger l
      WHERE l.upgrade_id = $1::uuid
        AND l.outcome != 'source_deleted'
        AND NOT EXISTS (
          /* Live collection table query (SELECT ONLY) */
          SELECT 1 FROM ${resolved.regclassArg} t WHERE t.id = l.source_id
        );
    `, [upgradeId]);
    tombstoneIds = missingRows.map((r) => r.source_id);
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

  await sql.begin(async (tx: any) => {
    // 1. Find unpublished staging output_ids
    const stagingRows = await tx`
      SELECT output_id
      FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ANY(${tombstoneIds}::uuid[])
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
        AND source_id = ANY(${tombstoneIds}::uuid[])
        AND published_at IS NULL
      RETURNING output_id;
    `;
    deletedStagingCount = deletedStaging.length;

    // 4. Update ledger outcome to source_deleted
    await tx`
      UPDATE paperclip_memory_upgrade_ledger
      SET
        outcome = 'source_deleted',
        updated_at = now()
      WHERE upgrade_id = ${upgradeId}::uuid
        AND source_id = ANY(${tombstoneIds}::uuid[]);
    `;
  });

  return {
    tombstonesCount: tombstoneIds.length,
    deletedStagingCount,
    deletedDedupeCount,
    tombstoneSourceIds: tombstoneIds,
  };
}

/**
 * Reconciles changed content for a single source.
 * Sets ledger outcome to 'superseded' and clears unpublished staging and dedupe rows.
 */
export async function reconcileChangedContent(
  sql: postgres.Sql,
  upgradeId: string,
  sourceId: string,
): Promise<{ deletedStagingCount: number; deletedDedupeCount: number }> {
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

    // 4. Mark ledger as superseded
    await tx`
      UPDATE paperclip_memory_upgrade_ledger
      SET
        outcome = 'superseded',
        updated_at = now()
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
        ${reasonCode},
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
