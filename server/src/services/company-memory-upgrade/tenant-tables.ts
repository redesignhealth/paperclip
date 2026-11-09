import type postgres from "postgres";
import { CompanyMemoryUpgradeError } from "./state-machine.js";
import { UPGRADE_LEDGER_OUTCOMES, type UpgradeLedgerOutcome } from "./types.js";

export { UPGRADE_LEDGER_OUTCOMES, type UpgradeLedgerOutcome };

export function isValidVectorType(vectorType: string): boolean {
  const normalized = vectorType.trim();
  if (normalized.toLowerCase() === "text") {
    return true;
  }
  const match = normalized.match(/^vector\((\d{1,5})\)$/i);
  if (!match) {
    return false;
  }
  const dim = Number.parseInt(match[1], 10);
  return dim >= 1 && dim <= 16000 && String(dim) === match[1];
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

  const outcomesList = UPGRADE_LEDGER_OUTCOMES.map((o) => `'${o}'`).join(", ");

  const ddl = `
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
  `;

  if ("begin" in sql && typeof (sql as any).begin === "function") {
    await (sql as any).begin(async (tx: SqlClient) => {
      await tx.unsafe(ddl);
    });
  } else {
    await sql.unsafe(ddl);
  }
}
