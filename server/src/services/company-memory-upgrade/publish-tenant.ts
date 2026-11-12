/**
 * Tenant SQL operations for company memory upgrade publish (TECH-8191).
 *
 * ARCHITECTURAL INVARIANTS:
 * - All tenant SQL operations for publish live in this file.
 * - The ONLY non-SELECT statement ever issued against the live collection table is a single
 *   INSERT ... ON CONFLICT (id) DO NOTHING. No UPDATE, no DELETE, no DO UPDATE, no DDL, no index creation.
 * - The live INSERT and the published_at mark MUST be one tenant transaction.
 * - The embedding never leaves the database: INSERT ... SELECT output_id, payload, embedding<cast> FROM staging.
 * - Ownership is verified before marking published: every skipped row must match migration_id and migrated_from.
 * - Output_ids is recomputed via correlated subquery from staging; never use EXCLUDED.output_ids.
 */

import type postgres from "postgres";
import { isValidUuid, validateAndResolveTableIdentifier } from "./census.js";
import { CompanyMemoryUpgradeError } from "./state-machine.js";
import type { TenantCollectionShape } from "./sweep-tenant.js";
import {
  acquireSourceAdvisoryLocksAscending,
  type TenantFence,
  validateTenantFence,
} from "./tenant-fence.js";
import { assertSafeCatalogTypeCast } from "./tenant-tables.js";

export interface LiveSourceRow {
  id: string;
  agentId: string | null;
  userId: string | null;
  data: string | null;
  createdAt: string | null;
  rawPayload: Record<string, unknown>;
}

export interface PublishSourceBatchParams {
  upgradeId: string;
  sourceIds: string[];
  tableName: string;
  shape: TenantCollectionShape;
  vectorCast: string | null;
}

export interface PublishSourceBatchResult {
  insertedCount: number;
  alreadyPresentCount: number;
  publishedCount: number;
}

export async function assertLiveCollectionInsertable(
  sql: postgres.Sql,
  tableName: string,
  shape: TenantCollectionShape,
): Promise<void> {
  validateAndResolveTableIdentifier(tableName);

  const uniqueRows = (await sql.unsafe(
    `SELECT i.indexrelid::regclass::text AS index_name
     FROM pg_index i
     JOIN pg_attribute a
       ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = to_regclass($1)
       AND i.indisunique
       AND i.indnatts = 1
       AND i.indnkeyatts = 1
       AND a.attname = 'id'
       AND i.indpred IS NULL
     LIMIT 1;`,
    [tableName],
  )) as Array<{ index_name: string }>;

  if (!uniqueRows || uniqueRows.length === 0) {
    throw new CompanyMemoryUpgradeError(
      `Live table "${tableName}" does not have a single-column unique index or primary key on "id".`,
      "LIVE_TABLE_ID_NOT_UNIQUE",
    );
  }

  const nonInsertableCols = (await sql.unsafe(
    `SELECT a.attname
     FROM pg_attribute a
     WHERE a.attrelid = to_regclass($1)
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attnotnull
       AND NOT a.atthasdef
       AND a.attidentity = ''
       AND a.attgenerated = ''
       AND a.attname NOT IN ('id', 'payload', $2);`,
    [tableName, shape.embeddingColumn],
  )) as Array<{ attname: string }>;

  if (nonInsertableCols && nonInsertableCols.length > 0) {
    const colNames = nonInsertableCols.map((c) => c.attname).join(", ");
    throw new CompanyMemoryUpgradeError(
      `Live table "${tableName}" has non-nullable columns without defaults: ${colNames}.`,
      "LIVE_TABLE_NOT_INSERTABLE",
    );
  }

  assertSafeCatalogTypeCast(shape.embeddingTypeRaw);
}

export function resolveLiveVectorCast(
  shape: TenantCollectionShape,
  stagingType: string,
): string | null {
  assertSafeCatalogTypeCast(shape.embeddingTypeRaw);
  if (stagingType === shape.embeddingTypeRaw) {
    return null;
  }
  return `::${shape.embeddingTypeRaw}`;
}

export async function selectUnpublishedSourcePage(
  sql: postgres.Sql,
  upgradeId: string,
  options?: { afterSourceId?: string | null; limit?: number },
): Promise<{ sourceIds: string[]; maxSourceId: string | null }> {
  if (!isValidUuid(upgradeId)) {
    throw new CompanyMemoryUpgradeError("upgradeId must be a valid UUID.", "INVALID_ARGUMENT");
  }
  const limit = options?.limit && options.limit > 0 ? options.limit : 1000;
  const afterSourceId = options?.afterSourceId ?? null;

  const rows = (await sql.unsafe(
    `SELECT DISTINCT source_id
     FROM paperclip_memory_upgrade_staging
     WHERE upgrade_id = $1::uuid
       AND published_at IS NULL
       AND ($2::uuid IS NULL OR source_id > $2::uuid)
     ORDER BY source_id ASC
     LIMIT $3;`,
    [upgradeId, afterSourceId, limit],
  )) as Array<{ source_id: string }>;

  const sourceIds = rows.map((r) => String(r.source_id).toLowerCase());
  const maxSourceId = sourceIds.length > 0 ? sourceIds[sourceIds.length - 1] : null;
  return { sourceIds, maxSourceId };
}

export async function loadLiveSourceRows(
  sql: postgres.Sql,
  tableName: string,
  sourceIds: string[],
  isUuidId: boolean,
): Promise<Map<string, LiveSourceRow>> {
  const result = new Map<string, LiveSourceRow>();
  if (!sourceIds || sourceIds.length === 0) {
    return result;
  }
  const resolved = validateAndResolveTableIdentifier(tableName);

  const rows = (await sql.unsafe(
    `/* Live collection table query (SELECT ONLY) */
     SELECT
       lower(t.id::text) AS id,
       t.payload->>'agent_id' AS agent_id,
       t.payload->>'user_id' AS user_id,
       t.payload->>'data' AS data,
       t.payload->>'created_at' AS created_at,
       t.payload AS raw_payload
     FROM ${resolved.regclassArg} t
     WHERE ${isUuidId ? "t.id = ANY($1::uuid[])" : "lower(t.id::text) = ANY($1::text[])"};`,
    [sourceIds],
  )) as Array<{
    id: string;
    agent_id: string | null;
    user_id: string | null;
    data: string | null;
    created_at: string | null;
    raw_payload: Record<string, unknown>;
  }>;

  for (const r of rows) {
    result.set(String(r.id).toLowerCase(), {
      id: String(r.id).toLowerCase(),
      agentId: r.agent_id ? String(r.agent_id).toLowerCase() : null,
      userId: r.user_id ? String(r.user_id) : null,
      data: r.data ?? null,
      createdAt: r.created_at ?? null,
      rawPayload: r.raw_payload ?? {},
    });
  }

  return result;
}

export async function publishSourceBatch(
  sql: postgres.Sql,
  params: PublishSourceBatchParams,
  fence: TenantFence,
): Promise<PublishSourceBatchResult> {
  const { upgradeId, sourceIds, tableName, shape, vectorCast } = params;
  if (!isValidUuid(upgradeId)) {
    throw new CompanyMemoryUpgradeError("upgradeId must be a valid UUID.", "INVALID_ARGUMENT");
  }
  if (!fence || fence.upgradeId !== upgradeId) {
    throw new CompanyMemoryUpgradeError("Valid tenant fence is required.", "INVALID_ARGUMENT");
  }
  if (!sourceIds || sourceIds.length === 0) {
    return { insertedCount: 0, alreadyPresentCount: 0, publishedCount: 0 };
  }
  const resolved = validateAndResolveTableIdentifier(tableName);

  return (await sql.begin(async (tx: any) => {
    // L1 before L2: per-source advisory locks in ascending canonical order
    await acquireSourceAdvisoryLocksAscending(tx, upgradeId, sourceIds);
    // L2: fence SHARE lock held to commit
    await validateTenantFence(tx, fence);

    // Statement 1: lock and re-read candidates
    const stagingRows = (await tx.unsafe(
      `SELECT output_id, source_id, agent_id, jsonb_typeof(payload) AS payload_type
       FROM paperclip_memory_upgrade_staging
       WHERE upgrade_id = $1::uuid
         AND source_id = ANY($2::uuid[])
         AND published_at IS NULL
       ORDER BY output_id ASC
       FOR UPDATE;`,
      [upgradeId, sourceIds],
    )) as Array<{ output_id: string; source_id: string; agent_id: string | null; payload_type: string }>;

    if (stagingRows.length === 0) {
      return { insertedCount: 0, alreadyPresentCount: 0, publishedCount: 0 };
    }

    // Fail-closed validation: all staging payloads must be JSON objects at root before live INSERT
    for (const sr of stagingRows) {
      if (sr.payload_type !== "object") {
        throw new CompanyMemoryUpgradeError(
          `Candidate staging record ${sr.output_id} has non-object payload (jsonb_typeof: ${sr.payload_type}).`,
          "PUBLISH_LEDGER_INCONSISTENT",
        );
      }
    }

    const candidateOutputIds = stagingRows.map((r) => r.output_id);
    const affectedSourceIds = Array.from(new Set(stagingRows.map((r) => String(r.source_id).toLowerCase())));

    // Statement 2: ledger consistency gate
    const ledgerRows = (await tx.unsafe(
      `SELECT source_id, agent_id, outcome
       FROM paperclip_memory_upgrade_ledger
       WHERE upgrade_id = $1::uuid
         AND source_id = ANY($2::uuid[])
       FOR UPDATE;`,
      [upgradeId, affectedSourceIds],
    )) as Array<{ source_id: string; agent_id: string | null; outcome: string }>;

    if (ledgerRows.length !== affectedSourceIds.length) {
      throw new CompanyMemoryUpgradeError(
        "Missing ledger rows for candidate sources during publish.",
        "PUBLISH_LEDGER_INCONSISTENT",
      );
    }

    const ledgerBySource = new Map<string, { agentId: string | null; outcome: string }>();
    for (const row of ledgerRows) {
      ledgerBySource.set(String(row.source_id).toLowerCase(), {
        agentId: row.agent_id ? String(row.agent_id).toLowerCase() : null,
        outcome: row.outcome,
      });
    }

    for (const sr of stagingRows) {
      const led = ledgerBySource.get(String(sr.source_id).toLowerCase());
      if (!led || led.outcome !== "published") {
        throw new CompanyMemoryUpgradeError(
          `Candidate source has non-published ledger outcome: ${led?.outcome ?? "missing"}.`,
          "PUBLISH_LEDGER_INCONSISTENT",
        );
      }
      const stAgent = sr.agent_id ? String(sr.agent_id).toLowerCase() : null;
      if (stAgent !== led.agentId) {
        throw new CompanyMemoryUpgradeError(
          "Staging and ledger disagree on owning agent for candidate source.",
          "PUBLISH_LEDGER_INCONSISTENT",
        );
      }
    }

    // Statement 3: the ONE live-table write (INSERT ... ON CONFLICT (id) DO NOTHING ONLY)
    const idCast = shape.isUuidId ? "" : "::text";
    const payloadCast = shape.payloadType === "json" ? "::json" : "";
    const castArg = vectorCast ? vectorCast : "";

    const inserted = (await tx.unsafe(
      `/* Live collection table write (INSERT ... ON CONFLICT (id) DO NOTHING ONLY -- never UPDATE/DELETE/DDL) */
       INSERT INTO ${resolved.regclassArg} (id, payload, ${shape.embeddingColumn})
       SELECT
         s.output_id${idCast},
         s.payload${payloadCast},
         s.embedding${castArg}
       FROM paperclip_memory_upgrade_staging s
       WHERE s.upgrade_id = $1::uuid
         AND s.output_id = ANY($2::uuid[])
         AND s.published_at IS NULL
       ON CONFLICT (id) DO NOTHING
       RETURNING id${idCast};`,
      [upgradeId, candidateOutputIds],
    )) as Array<{ id: string }>;

    const insertedIds = new Set(inserted.map((r) => String(r.id).toLowerCase()));
    const skippedIds = candidateOutputIds.filter((id) => !insertedIds.has(String(id).toLowerCase()));

    // Statement 4: verify ownership of skipped rows before marking published
    if (skippedIds.length > 0) {
      const verified = (await tx.unsafe(
        `/* Live collection table query (SELECT ONLY) */
         SELECT lower(t.id::text) AS id
         FROM ${resolved.regclassArg} t
         JOIN paperclip_memory_upgrade_staging s
           ON ${shape.isUuidId ? "s.output_id = t.id" : "s.output_id::text = t.id"}
           AND s.upgrade_id = $1::uuid
         WHERE ${shape.isUuidId ? "t.id = ANY($2::uuid[])" : "lower(t.id::text) = ANY($2::text[])"}
           AND t.payload->>'migration_id' = $1::text
           AND t.payload->>'migrated_from' = s.source_id::text;`,
        [upgradeId, skippedIds],
      )) as Array<{ id: string }>;

      const verifiedSet = new Set(verified.map((r) => String(r.id).toLowerCase()));
      for (const skipped of skippedIds) {
        if (!verifiedSet.has(String(skipped).toLowerCase())) {
          throw new CompanyMemoryUpgradeError(
            `A live-collection insert conflicted on unowned row ${skipped}.`,
            "PUBLISH_CONFLICT_UNEXPECTED",
          );
        }
      }
    }

    // Statement 5: mark published (same transaction)
    const marked = (await tx.unsafe(
      `UPDATE paperclip_memory_upgrade_staging
       SET published_at = now()
       WHERE upgrade_id = $1::uuid
         AND output_id = ANY($2::uuid[])
         AND published_at IS NULL
       RETURNING output_id;`,
      [upgradeId, candidateOutputIds],
    )) as Array<{ output_id: string }>;

    if (marked.length !== candidateOutputIds.length) {
      throw new CompanyMemoryUpgradeError(
        "Failed to mark all staged records published.",
        "PUBLISH_LEDGER_INCONSISTENT",
      );
    }

    // Statement 6: ledger refresh plus consistency re-assert
    const updatedLedger = (await tx.unsafe(
      `UPDATE paperclip_memory_upgrade_ledger AS l
       SET output_ids = COALESCE((
             SELECT array_agg(s.output_id ORDER BY s.output_id)
             FROM paperclip_memory_upgrade_staging s
             WHERE s.upgrade_id = l.upgrade_id AND s.source_id = l.source_id), '{}'),
           updated_at = now()
       WHERE l.upgrade_id = $1::uuid
         AND l.source_id = ANY($2::uuid[])
         AND l.outcome = 'published'
       RETURNING l.source_id;`,
      [upgradeId, affectedSourceIds],
    )) as Array<{ source_id: string }>;

    if (updatedLedger.length !== affectedSourceIds.length) {
      throw new CompanyMemoryUpgradeError(
        "Ledger row missing or changed outcome during publish commit.",
        "PUBLISH_LEDGER_INCONSISTENT",
      );
    }

    const insertedCount = inserted.length;
    const alreadyPresentCount = skippedIds.length;
    return {
      insertedCount,
      alreadyPresentCount,
      publishedCount: insertedCount + alreadyPresentCount,
    };
  })) as PublishSourceBatchResult;
}
