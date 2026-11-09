/**
 * Shared test helpers for company memory upgrade sweep tests (TECH-8191).
 */

import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createDb,
  heartbeatRuns,
  type Db,
} from "../../packages/db/src/index.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  sql,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-census-helpers.js";

import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
export const { eq } = require("drizzle-orm");

export {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  heartbeatRuns,
  sql,
  startEmbeddedPostgresTestDatabase,
};

/**
 * Manual virtual clock implementing both MonotonicClock and Clock interfaces.
 * sleep() advances virtual time without wall-clock waiting.
 */
export class ManualClock {
  private currentTimeMs: number;

  constructor(initialTimeMs: number = 1_700_000_000_000) {
    this.currentTimeMs = initialTimeMs;
  }

  nowMs(): number {
    return this.currentTimeMs;
  }

  now(): Date {
    return new Date(this.currentTimeMs);
  }

  advance(ms: number): void {
    this.currentTimeMs += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.currentTimeMs += ms;
  }
}

/**
 * Prepares a test tenant PostgreSQL database with mem0_memories table.
 */
export async function setupTenantMem0Table(
  sqlClient: any,
  tableName: string = "mem0_memories",
  vectorType: string = '"vector(1536)"',
): Promise<void> {
  await sqlClient.unsafe(`
    DO $$ BEGIN
      CREATE DOMAIN "vector(1536)" AS text;
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `);

  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "payload" jsonb NOT NULL,
      "vector" ${vectorType} NOT NULL
    );
  `);
}

/**
 * Inserts a test Mem0 memory row into the live collection table.
 */
export async function insertTenantMemoryRow(
  sqlClient: any,
  params: {
    id?: string;
    agentId?: string | null;
    userId?: string | null;
    data?: string | null;
    tableName?: string;
  },
): Promise<string> {
  const rowId = params.id ?? randomUUID();
  const tableName = params.tableName ?? "mem0_memories";
  const payload = {
    agent_id: params.agentId ?? null,
    user_id: params.userId ?? "company",
    data: params.data ?? "Substantive preference for testing.",
    created_at: new Date().toISOString(),
  };

  await sqlClient.unsafe(
    `INSERT INTO "${tableName}" (id, payload, vector) VALUES ($1::uuid, $2, $3);`,
    [rowId, payload, "mock-vector-data"],
  );

  return rowId;
}
