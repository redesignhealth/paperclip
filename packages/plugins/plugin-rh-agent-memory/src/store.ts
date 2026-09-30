/**
 * SQL layer for RH Agent Memory.
 *
 * Every statement in this file:
 *   - filters on BOTH `company_id` and `agent_id`,
 *   - binds those values from a `Tenant` (which can only come from
 *     `resolveTenant(runCtx)`), never from string interpolation,
 *   - takes the tenant as its FIRST argument so a reviewer can see at a glance
 *     that no call site can omit it.
 *
 * The only interpolated value is the host-derived schema namespace from
 * `ctx.db.namespace`, which is produced by the host (not the plugin) and is
 * validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` by
 * `server/src/services/plugin-database.ts#assertIdentifier`. We re-check it
 * here anyway rather than trusting it.
 */

import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { Tenant } from "./tenant.js";

const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MEMORY_TABLE = "agent_memory";
export const MAX_MEMORY_KEY_LENGTH = 512;
/** Guard against an agent parking megabytes of JSON in a memory slot. */
export const MAX_VALUE_BYTES = 256 * 1024;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

export interface AgentMemoryRow {
  memory_key: string;
  value_json: unknown;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

export interface AgentMemoryRecord {
  key: string;
  value: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Fully-qualified, injection-safe table reference. */
export function memoryTable(namespace: string): string {
  if (!SAFE_IDENTIFIER_RE.test(namespace)) {
    throw new Error(`Unsafe plugin database namespace from host: ${namespace}`);
  }
  return `"${namespace}"."${MEMORY_TABLE}"`;
}

export function normalizeMemoryKey(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("`key` is required and must be a string");
  const key = raw.trim();
  if (key.length === 0) throw new Error("`key` must not be blank");
  if (key.length > MAX_MEMORY_KEY_LENGTH) {
    throw new Error(`\`key\` must be at most ${MAX_MEMORY_KEY_LENGTH} characters`);
  }
  return key;
}

/** Serialize a memory value to JSON text for a `jsonb` bind parameter. */
export function serializeValue(value: unknown): string {
  if (value === undefined) throw new Error("`value` is required");
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error("`value` must be JSON-serializable");
  }
  if (json === undefined) throw new Error("`value` must be JSON-serializable");
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_VALUE_BYTES) {
    throw new Error(`\`value\` is ${bytes} bytes, which exceeds the ${MAX_VALUE_BYTES}-byte limit`);
  }
  return json;
}

export function normalizeListLimit(raw: unknown): number {
  if (raw == null) return DEFAULT_LIST_LIMIT;
  const limit = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toRecord(row: AgentMemoryRow): AgentMemoryRecord {
  return {
    key: row.memory_key,
    value: row.value_json,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function getMemory(
  db: PluginDatabaseClient,
  tenant: Tenant,
  key: string,
): Promise<AgentMemoryRecord | null> {
  const rows = await db.query<AgentMemoryRow>(
    `SELECT memory_key, value_json, created_at, updated_at
       FROM ${memoryTable(db.namespace)}
      WHERE company_id = $1 AND agent_id = $2 AND memory_key = $3
      LIMIT 1`,
    [tenant.companyId, tenant.agentId, key],
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

export async function setMemory(
  db: PluginDatabaseClient,
  tenant: Tenant,
  key: string,
  valueJson: string,
): Promise<{ rowCount: number }> {
  // ON CONFLICT targets the (company_id, agent_id, memory_key) unique index, so
  // an upsert can never reach another tenant's row.
  return db.execute(
    `INSERT INTO ${memoryTable(db.namespace)} (company_id, agent_id, memory_key, value_json)
          VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (company_id, agent_id, memory_key)
       DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now()
             WHERE ${memoryTable(db.namespace)}.company_id = $1
               AND ${memoryTable(db.namespace)}.agent_id = $2`,
    [tenant.companyId, tenant.agentId, key, valueJson],
  );
}

export async function deleteMemory(
  db: PluginDatabaseClient,
  tenant: Tenant,
  key: string,
): Promise<{ rowCount: number }> {
  return db.execute(
    `DELETE FROM ${memoryTable(db.namespace)}
      WHERE company_id = $1 AND agent_id = $2 AND memory_key = $3`,
    [tenant.companyId, tenant.agentId, key],
  );
}

export async function listMemory(
  db: PluginDatabaseClient,
  tenant: Tenant,
  limit: number,
): Promise<AgentMemoryRecord[]> {
  const rows = await db.query<AgentMemoryRow>(
    `SELECT memory_key, value_json, created_at, updated_at
       FROM ${memoryTable(db.namespace)}
      WHERE company_id = $1 AND agent_id = $2
      ORDER BY memory_key ASC
      LIMIT $3`,
    [tenant.companyId, tenant.agentId, limit],
  );
  return rows.map(toRecord);
}
