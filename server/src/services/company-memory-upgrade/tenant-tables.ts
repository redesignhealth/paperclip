import type postgres from "postgres";
import { CompanyMemoryUpgradeError } from "./state-machine.js";
import { UPGRADE_LEDGER_OUTCOMES, type UpgradeLedgerOutcome } from "./types.js";

export { UPGRADE_LEDGER_OUTCOMES, type UpgradeLedgerOutcome };

const VECTOR_TYPE_PARSER = /^(?:(?:"([a-zA-Z_][a-zA-Z0-9_]*)"|([a-zA-Z_][a-zA-Z0-9_]*))\.)?(?:"?vector"?)\((\d{1,5})\)$/i;

const SAFE_CATALOG_TYPE =
  /^(?:(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\.)?(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\(\d{1,5}(?:,\d{1,5})?\))?$/;

/**
 * Validates that a type name from the database catalog is safe to interpolate as a SQL cast target.
 */
export function assertSafeCatalogTypeCast(typeName: string): void {
  if (
    typeof typeName !== "string" ||
    typeName.length === 0 ||
    typeName.length > 128 ||
    !SAFE_CATALOG_TYPE.test(typeName)
  ) {
    throw new CompanyMemoryUpgradeError(
      `Unsafe catalog type name "${typeName}" cannot be used as a SQL cast target.`,
      "UNSAFE_CATALOG_TYPE",
    );
  }
}

/**
 * Queries the staging table's `embedding` column format_type from pg_attribute.
 * Returns null if the staging table does not exist or has no embedding column.
 */
export async function introspectStagingEmbeddingType(
  sql: SqlClient | ReturnType<typeof postgres> | { unsafe(query: string, args?: unknown[]): Promise<unknown> },
): Promise<string | null> {
  const rows = (await sql.unsafe(`
    SELECT format_type(a.atttypid, a.atttypmod) AS formatted_type
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass('paperclip_memory_upgrade_staging')
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped;
  `)) as Array<{ formatted_type: string }>;

  if (!rows || rows.length === 0 || !rows[0]?.formatted_type) {
    return null;
  }
  const rawType = rows[0].formatted_type.trim();
  assertSafeCatalogTypeCast(rawType);
  return rawType;
}

export function parseVectorType(vectorType: string): { schema: string | null; dimensions: number } | null {
  const normalized = vectorType.trim();
  if (normalized.toLowerCase() === "text") {
    return null;
  }
  const match = normalized.match(VECTOR_TYPE_PARSER);
  if (!match) {
    return null;
  }
  const schema = match[1] || match[2] || null;
  const dimStr = match[3];
  const dim = Number.parseInt(dimStr, 10);
  if (dim < 1 || dim > 16000 || String(dim) !== dimStr) {
    return null;
  }
  return { schema, dimensions: dim };
}

export function isValidVectorType(vectorType: string): boolean {
  const normalized = vectorType.trim();
  if (normalized.toLowerCase() === "text") {
    return true;
  }
  return parseVectorType(normalized) !== null;
}

export function quoteVectorType(vectorType: string): string {
  const normalized = vectorType.trim();
  if (normalized.toLowerCase() === "text") {
    return "text";
  }
  const parsed = parseVectorType(normalized);
  if (!parsed) {
    throw new CompanyMemoryUpgradeError(
      "Invalid vectorType: must be text or vector(N) with 1 <= N <= 16000",
      "INVALID_ARGUMENT",
    );
  }
  if (parsed.schema) {
    return `"${parsed.schema}"."vector"(${parsed.dimensions})`;
  }
  return `vector(${parsed.dimensions})`;
}

/**
 * The staging INSERT in sweep-tenant.ts parameterises the vector cast from the staging column's
 * resolved type, so the staging column must be `text` or an unqualified `vector(1536)`. A schema-qualified
 * type means pgvector is not visible in the connection's search_path (format_type only qualifies in that
 * case) — we refuse up front instead of failing on the first staging write.
 * TECH-8191 follow-up: the cast is now parameterised and only the schema-qualified pgvector fixture is missing.
 */
export function assertSupportedStagingVectorType(vectorType: string): void {
  const quoted = quoteVectorType(vectorType);
  if (quoted !== "text" && quoted !== "vector(1536)") {
    throw new CompanyMemoryUpgradeError(
      `Unsupported staging vectorType: only unqualified vector(1536) (visible in search_path) or text is currently supported, received "${quoted}".`,
      "UNSUPPORTED_VECTOR_TYPE",
    );
  }
}

/**
 * Resolves the staging embedding cast target from the tenant catalog and proves it matches the
 * requested (already validated) contract. Fail-closed: never falls back to the requested type or a
 * default when the catalog cannot be read. Returns the canonical, interpolation-safe cast target.
 */
export async function resolveStagingVectorType(
  sql: SqlClient | ReturnType<typeof postgres> | { unsafe(query: string, args?: unknown[]): Promise<unknown> },
  requestedVectorType: string,
): Promise<string> {
  const requested = (requestedVectorType ?? "").trim();
  if (!isValidVectorType(requested)) {
    throw new CompanyMemoryUpgradeError(
      "Invalid vectorType: must be text or vector(N) with 1 <= N <= 16000",
      "INVALID_ARGUMENT",
    );
  }
  assertSupportedStagingVectorType(requested); // UNSUPPORTED_VECTOR_TYPE
  const quotedRequested = quoteVectorType(requested);

  const detected = await introspectStagingEmbeddingType(sql); // UNSAFE_CATALOG_TYPE on junk catalog names
  if (detected === null) {
    throw new CompanyMemoryUpgradeError(
      "Staging table paperclip_memory_upgrade_staging has no readable embedding column; refusing to stage.",
      "SCHEMA_INIT_FAILED",
    );
  }
  if (!isValidVectorType(detected)) {
    throw new CompanyMemoryUpgradeError(
      `Staging embedding column type "${detected}" is neither text nor vector(N); refusing to stage.`,
      "STAGING_VECTOR_TYPE_MISMATCH",
    );
  }
  assertSupportedStagingVectorType(detected); // UNSUPPORTED_VECTOR_TYPE: stale vector(768), schema-qualified
  const quotedDetected = quoteVectorType(detected);
  if (quotedDetected !== quotedRequested) {
    throw new CompanyMemoryUpgradeError(
      `Staging embedding column is "${quotedDetected}" but this upgrade requires "${quotedRequested}"; refusing to stage.`,
      "STAGING_VECTOR_TYPE_MISMATCH",
    );
  }
  return quotedDetected;
}

export interface SqlClient {
  unsafe(query: string, args?: unknown[]): Promise<unknown>;
}

/**
 * ARCHITECTURAL INVARIANT:
 * NEVER create a unique index on the live mem0 collection table!
 *
 * The live mem0 collection (typically `mem0_memories`) is written to concurrently by
 * live Mem0 pipelines and agent heartbeats. Mem0 relies on its own non-unique index
 * structure and application-level payload management; adding a unique constraint or unique
 * index on the live table causes write errors, prevents valid memory re-ingestion, and
 * creates deadlock risks under concurrent access.
 *
 * Deduplication for upgraded memories is managed strictly within Paperclip's own tenant-side
 * tables (`paperclip_memory_upgrade_dedupe` and `paperclip_memory_upgrade_staging`),
 * never by altering or constraining the live Mem0 collection table.
 */

/**
 * Ensures tenant-side upgrade tables exist in the company's dedicated PostgreSQL database.
 * This runs with the credentials of the tenant role, which owns the database.
 */
export async function ensureUpgradeTables(
  sql: SqlClient | ReturnType<typeof postgres>,
  vectorType: string,
): Promise<void> {
  const normalizedVectorType = vectorType.trim();
  if (!isValidVectorType(normalizedVectorType)) {
    throw new CompanyMemoryUpgradeError(
      "Invalid vectorType: must be text or vector(N) with 1 <= N <= 16000",
      "INVALID_ARGUMENT",
    );
  }
  assertSupportedStagingVectorType(normalizedVectorType);
  const quotedVectorType = quoteVectorType(normalizedVectorType);

  const outcomesList = UPGRADE_LEDGER_OUTCOMES.map((o) => `'${o}'`).join(", ");

  const ddl = `
    CREATE TABLE IF NOT EXISTS "paperclip_memory_upgrade_staging" (
      "upgrade_id" uuid NOT NULL,
      "source_id" uuid NOT NULL,
      "output_id" uuid PRIMARY KEY,
      "agent_id" uuid NOT NULL,
      "payload" jsonb NOT NULL,
      "embedding" ${quotedVectorType} NOT NULL,
      "content_sha256" text NOT NULL,
      "published_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS "pmu_staging_src_idx"
    ON "paperclip_memory_upgrade_staging" ("upgrade_id", "source_id");

    CREATE INDEX IF NOT EXISTS "pmu_staging_unpublished_idx"
    ON "paperclip_memory_upgrade_staging" ("upgrade_id", "source_id", "output_id")
    WHERE "published_at" IS NULL;

    CREATE INDEX IF NOT EXISTS "pmu_staging_output_id_idx"
    ON "paperclip_memory_upgrade_staging" ("output_id");

    CREATE INDEX IF NOT EXISTS "pmu_staging_output_id_lower_idx"
    ON "paperclip_memory_upgrade_staging" ((lower("output_id"::text)));

    CREATE TABLE IF NOT EXISTS "paperclip_memory_upgrade_ledger" (
      "upgrade_id" uuid NOT NULL,
      "source_id" uuid NOT NULL,
      "source_content_sha256" text NOT NULL,
      "agent_id" uuid,
      "outcome" text NOT NULL,
      "reason_code" text,
      "output_ids" uuid[] NOT NULL DEFAULT '{}',
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("upgrade_id", "source_id"),
      CONSTRAINT "pmu_ledger_outcome_check" CHECK ("outcome" IN (${outcomesList}))
    );

    CREATE INDEX IF NOT EXISTS "pmu_ledger_outcome_idx"
    ON "paperclip_memory_upgrade_ledger" ("upgrade_id", "outcome");

    CREATE TABLE IF NOT EXISTS "paperclip_memory_upgrade_dedupe" (
      "upgrade_id" uuid NOT NULL,
      "agent_id" uuid NOT NULL,
      "data_sha256" text NOT NULL,
      "output_id" uuid NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "pmu_dedupe_uq"
    ON "paperclip_memory_upgrade_dedupe" ("upgrade_id", "agent_id", "data_sha256");

    CREATE TABLE IF NOT EXISTS "paperclip_memory_upgrade_fence" (
      "upgrade_id" uuid PRIMARY KEY,
      -- Note: DEFAULT 0 is retained because CREATE TABLE IF NOT EXISTS has no migration path
      -- and claim inserts 1 explicitly.
      "fence_epoch" bigint NOT NULL DEFAULT 0,
      "lease_token" text NOT NULL,
      "lease_owner" text NOT NULL,
      "claimed_at" timestamp with time zone NOT NULL DEFAULT now()
    );
  `;

  if ("begin" in sql && typeof (sql as any).begin === "function") {
    await (sql as any).begin(async (tx: SqlClient) => {
      await tx.unsafe(ddl);
    });
  } else {
    await sql.unsafe(ddl);
  }

  // CREATE TABLE IF NOT EXISTS silently no-ops on a pre-existing staging table, so the
  // embedding column may not be the type validated above. Verify against the catalog.
  await resolveStagingVectorType(sql, normalizedVectorType);
}
