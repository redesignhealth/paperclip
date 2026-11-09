import type postgres from "postgres";
import { CompanyMemoryUpgradeError } from "./state-machine.js";
import { UPGRADE_LEDGER_OUTCOMES, type UpgradeLedgerOutcome } from "./types.js";

export { UPGRADE_LEDGER_OUTCOMES, type UpgradeLedgerOutcome };

const VECTOR_TYPE_PARSER = /^(?:(?:"([a-zA-Z_][a-zA-Z0-9_]*)"|([a-zA-Z_][a-zA-Z0-9_]*))\.)?(?:"?vector"?)\((\d{1,5})\)$/i;

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
}
