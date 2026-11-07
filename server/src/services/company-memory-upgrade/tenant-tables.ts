import type postgres from "postgres";
import { UPGRADE_LEDGER_OUTCOMES, type UpgradeLedgerOutcome } from "./types.js";

export { UPGRADE_LEDGER_OUTCOMES, type UpgradeLedgerOutcome };

/**
 * Strict allowlist for vector column types.
 *
 * Supported formats:
 * - pgvector syntax: `vector(N)` where N is 1 to 5 digits (e.g. `vector(1536)`)
 * - literal `text`: permitted strictly for test harnesses lacking pgvector (e.g. embedded-postgres)
 *
 * Any other value is rejected to prevent SQL injection when interpolating the type name into DDL.
 */
export const VECTOR_TYPE_ALLOWLIST_REGEX = /^(?:vector\(\d{1,5}\)|text)$/i;

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
  if (!VECTOR_TYPE_ALLOWLIST_REGEX.test(normalizedVectorType)) {
    throw new Error(
      `Invalid vectorType: "${vectorType}". Must match ^(?:vector\\(\\d{1,5}\\)|text)$`,
    );
  }

  // 1. Staging table for converted agent-scoped memories
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "paperclip_memory_upgrade_staging" (
      "upgrade_id" uuid NOT NULL,
      "source_id" uuid NOT NULL,
      "output_id" uuid PRIMARY KEY,
      "agent_id" uuid NOT NULL,
      "payload" jsonb NOT NULL,
      "embedding" ${normalizedVectorType} NOT NULL,
      "content_sha256" text NOT NULL,
      "published_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    );
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS "pmu_staging_src_idx"
    ON "paperclip_memory_upgrade_staging" ("upgrade_id", "source_id");
  `);

  // 2. Audit and progress ledger recording decisions for every source legacy memory
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "paperclip_memory_upgrade_ledger" (
      "source_id" uuid PRIMARY KEY,
      "upgrade_id" uuid NOT NULL,
      "source_content_sha256" text NOT NULL,
      "agent_id" uuid,
      "outcome" text NOT NULL,
      "reason_code" text,
      "output_ids" uuid[] NOT NULL DEFAULT '{}',
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    );
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS "pmu_ledger_outcome_idx"
    ON "paperclip_memory_upgrade_ledger" ("upgrade_id", "outcome");
  `);

  // 3. Deduplication registry per agent to avoid redundant memory publications
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "paperclip_memory_upgrade_dedupe" (
      "agent_id" uuid NOT NULL,
      "data_sha256" text NOT NULL,
      "output_id" uuid NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    );
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "pmu_dedupe_uq"
    ON "paperclip_memory_upgrade_dedupe" ("agent_id", "data_sha256");
  `);
}
