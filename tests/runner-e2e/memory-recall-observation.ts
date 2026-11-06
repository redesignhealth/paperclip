import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  deriveCompanyMemoryDatabaseNames,
  quoteIdentifier,
} from "../../server/src/services/company-memory-databases.js";

const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const postgres = (serverRequire("postgres")?.default ?? serverRequire("postgres")) as any;

export function deriveTenantNames(companyId: string): {
  databaseName: string;
  databaseRole: string;
} {
  return deriveCompanyMemoryDatabaseNames(companyId);
}

export interface TypedToolRecord {
  tool: string;
  durationSec: number;
  durationMs: number;
  chars: number;
  raw: string;
}

const TYPED_TOOL_RECORD_PATTERN =
  /^\d{2}:\d{2}:\d{2} - agent\.tool_executor - INFO(?: \[[^\]\n]{1,64}\])? - tool ([A-Za-z0-9_]{1,64}) completed \((\d+\.\d{2})s, (\d+) chars\)$/;

export function extractLogText(rawContent: string): string {
  if (!rawContent) return "";
  const lines = rawContent.split(/\r?\n/);
  const chunks: string[] = [];
  let parsedAnyNdjson = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "stream" in parsed &&
        typeof parsed.chunk === "string"
      ) {
        parsedAnyNdjson = true;
        if (parsed.stream === "stderr") {
          chunks.push(parsed.chunk);
        }
        continue;
      }
    } catch {
      // not JSON line
    }
    if (!parsedAnyNdjson) {
      chunks.push(line);
    }
  }

  return chunks.join(parsedAnyNdjson ? "" : "\n");
}

export function typedToolRecords(logText: string): TypedToolRecord[] {
  if (!logText) return [];
  const records: TypedToolRecord[] = [];
  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = TYPED_TOOL_RECORD_PATTERN.exec(line);
    if (match) {
      const durationSec = parseFloat(match[2]!);
      records.push({
        tool: match[1]!,
        durationSec,
        durationMs: Math.round(durationSec * 1000),
        chars: parseInt(match[3]!, 10),
        raw: match[0],
      });
    }
  }
  return records;
}

export async function verifyAdminPreflight(
  adminDsn: string,
  tenantDbName: string,
): Promise<void> {
  const template1Url = new URL(adminDsn);
  template1Url.pathname = "/template1";
  const sql = postgres(template1Url.toString(), { max: 1 });
  try {
    await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;`;
    const vectorExt = await sql<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'vector';
    `;
    if (vectorExt.length === 0) {
      throw new Error(
        "Admin preflight failed: pgvector extension is not preinstalled in template1",
      );
    }
    const dbRows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname = ${tenantDbName};
    `;
    if (dbRows.length > 0) {
      throw new Error(
        `Admin preflight failed: derived tenant database "${tenantDbName}" already exists`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface TenantMemoryRow {
  id: string;
  data: string;
  agentId?: string;
  userId?: string;
  createdAt?: string;
}

export interface TenantMemoryReader {
  snapshotMemoryIds(): Promise<Set<string>>;
  readMemoriesSince(knownIds: Set<string>): Promise<TenantMemoryRow[]>;
  close(): Promise<void>;
}

export async function openTenantReader(
  adminDsn: string,
  databaseName: string,
): Promise<TenantMemoryReader> {
  const tenantUrl = new URL(adminDsn);
  tenantUrl.pathname = `/${databaseName}`;
  const sql = postgres(tenantUrl.toString(), { max: 1 });
  await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;`;

  return {
    async snapshotMemoryIds(): Promise<Set<string>> {
      const rows = await sql<{ id: string }[]>`
        SELECT id::text as id FROM mem0_memories;
      `;
      return new Set(rows.map((r: { id: string }) => String(r.id)));
    },
    async readMemoriesSince(knownIds: Set<string>): Promise<TenantMemoryRow[]> {
      const rows = await sql<
        Array<{
          id: string;
          data: string | null;
          agent_id: string | null;
          user_id: string | null;
          created_at: string | null;
        }>
      >`
        SELECT
          id::text as id,
          payload->>'data' as data,
          payload->>'agent_id' as agent_id,
          payload->>'user_id' as user_id,
          payload->>'created_at' as created_at
        FROM mem0_memories;
      `;
      const results: TenantMemoryRow[] = [];
      for (const row of rows) {
        if (knownIds.has(String(row.id))) continue;
        if (row.data === null || row.data === undefined) {
          throw new Error(
            `Memory row ${row.id} in tenant database has no data in payload`,
          );
        }
        results.push({
          id: String(row.id),
          data: row.data,
          agentId: row.agent_id ?? undefined,
          userId: row.user_id ?? undefined,
          createdAt: row.created_at ?? undefined,
        });
      }
      return results;
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}

export async function dropTenantDatabase(
  adminDsn: string,
  databaseName: string,
  roleName?: string,
): Promise<void> {
  const sql = postgres(adminDsn, { max: 1 });
  try {
    await sql.unsafe(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${databaseName.replace(/'/g, "''")}'
        AND pid <> pg_backend_pid();
    `);
    await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)};`);
    if (roleName) {
      await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(roleName)};`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function extractBootProof(serverLogContent: string): string {
  const lines = serverLogContent.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes("[company-memory] Initialized company memory configuration")) {
      // Must reflect enabled=true and companyScope=all
      const hasEnabledTrue = /"enabled"\s*:\s*true\b/.test(line);
      const hasCompanyScopeAll = /"companyScope"\s*:\s*"all"/.test(line);
      if (hasEnabledTrue && hasCompanyScopeAll) {
        return line.trim();
      }
    }
  }
  throw new Error(
    "Server log missing required '[company-memory] Initialized company memory configuration' with enabled=true and companyScope='all'",
  );
}
