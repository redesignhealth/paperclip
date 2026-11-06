import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { MemoryHardeningFlags } from "../../packages/shared/src/memory-hardening.js";
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

/**
 * Format guards for tenant database and role names.
 *
 * NOTE: The drop guard checks that names match the expected tenant format and match
 * the names derived from the freshly created fixture company. Real isolation
 * relies on the operator supplying a throwaway admin DSN; regex format and name
 * equality checks do not isolate tests from production.
 */
export const TENANT_DB_NAME_REGEX =
  /^(?:pcmem_[0-9a-f]{32}|paperclip_tenant_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12})$/;
export const TENANT_ROLE_NAME_REGEX =
  /^(?:pcmem_r_[0-9a-f]{32}|paperclip_tenant_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}_owner)$/;

// Backwards-compatible aliases
export const TEST_TENANT_DB_REGEX = TENANT_DB_NAME_REGEX;
export const TEST_TENANT_ROLE_REGEX = TENANT_ROLE_NAME_REGEX;

export async function openTenantReader(
  adminDsn: string,
  databaseName: string,
): Promise<TenantMemoryReader> {
  const tenantUrl = new URL(adminDsn);
  tenantUrl.pathname = `/${databaseName}`;
  const sql = postgres(tenantUrl.toString(), { max: 1 });
  try {
    await sql.unsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;");
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw err;
  }

  return {
    async snapshotMemoryIds(): Promise<Set<string>> {
      const rows = await sql<{ id: string }[]>`
        SELECT id::text as id FROM mem0_memories ORDER BY id ASC;
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
        FROM mem0_memories
        ORDER BY id ASC;
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

export interface DropTenantDatabaseOptions {
  expectedDatabaseName: string;
  expectedRoleName: string;
  sqlFactory?: (dsn: string, options: { max: number }) => any;
}

/**
 * Drops an ephemeral tenant database and its dedicated role.
 *
 * NOTE: The drop guard enforces that target names match the format pattern and match
 * the names derived from the freshly created fixture company. Real isolation relies
 * on the operator supplying a throwaway admin DSN; regex validation and name equality
 * do not isolate tests from production.
 */
export async function dropTenantDatabase(
  adminDsn: string,
  databaseName: string,
  roleName: string,
  options: DropTenantDatabaseOptions,
): Promise<void> {
  if (!options?.expectedDatabaseName || !options?.expectedRoleName) {
    throw new Error(
      "dropTenantDatabase requires expectedDatabaseName and expectedRoleName options",
    );
  }
  if (!TENANT_DB_NAME_REGEX.test(databaseName)) {
    throw new Error(
      `Refusing to drop database "${databaseName}": does not match expected tenant database naming format`,
    );
  }
  if (!TENANT_ROLE_NAME_REGEX.test(roleName)) {
    throw new Error(
      `Refusing to drop role "${roleName}": does not match expected tenant role naming format`,
    );
  }
  if (databaseName !== options.expectedDatabaseName) {
    throw new Error(
      `Refusing to drop database "${databaseName}": does not match expected fixture-derived database name "${options.expectedDatabaseName}"`,
    );
  }
  if (roleName !== options.expectedRoleName) {
    throw new Error(
      `Refusing to drop role "${roleName}": does not match expected fixture-derived role name "${options.expectedRoleName}"`,
    );
  }

  const sql = options?.sqlFactory
    ? options.sqlFactory(adminDsn, { max: 1 })
    : postgres(adminDsn, { max: 1 });
  try {
    await sql.unsafe(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${databaseName.replace(/'/g, "''")}'
        AND pid <> pg_backend_pid();
    `);
    await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE);`);
    if (roleName) {
      let roleDepError: unknown;
      try {
        await sql.unsafe(`REASSIGN OWNED BY ${quoteIdentifier(roleName)} TO CURRENT_USER;`);
        await sql.unsafe(`DROP OWNED BY ${quoteIdentifier(roleName)};`);
      } catch (err) {
        roleDepError = err;
        console.warn(
          `[dropTenantDatabase] REASSIGN/DROP OWNED failed for role "${roleName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(roleName)};`);
      } catch (err) {
        if (roleDepError) {
          throw new AggregateError(
            [roleDepError, err],
            `Failed to drop role "${roleName}" after dependency cleanup failure: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface ServerBootProof {
  line: string;
  flags: MemoryHardeningFlags;
  toString(): string;
}

export function extractBootProof(serverLogContent: string): ServerBootProof {
  const lines = serverLogContent.split(/\r?\n/);

  interface BootCandidate {
    initLine?: string;
    pid?: number | string;
    flags?: MemoryHardeningFlags;
  }

  function isNewLogEntryStart(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("{")) return true;
    if (/^\[?\d{2,4}[-:/.]/.test(trimmed)) return true;
    if (/^\[?(?:INFO|WARN|ERROR|DEBUG|TRACE)\]?/i.test(trimmed)) return true;
    return false;
  }

  const boots: BootCandidate[] = [];
  let currentBoot: BootCandidate = {};

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    let text = rawLine;
    let parsedObj: any = null;
    try {
      parsedObj = JSON.parse(rawLine.trim());
      if (parsedObj && typeof parsedObj === "object") {
        if (typeof parsedObj.msg === "string") {
          text = parsedObj.msg;
        }
      }
    } catch {
      // not JSON line
    }

    const isInitLine =
      rawLine.includes("[company-memory] Initialized company memory configuration") ||
      text.includes("[company-memory] Initialized company memory configuration");

    if (isInitLine) {
      let qualifies = false;
      if (parsedObj && typeof parsedObj === "object") {
        const hasEnabledField = "enabled" in parsedObj;
        const hasScopeField = "companyScope" in parsedObj;
        if (hasEnabledField || hasScopeField) {
          if (parsedObj.enabled === true && parsedObj.companyScope === "all") {
            qualifies = true;
          }
        } else {
          qualifies = checkBoundedWindow(i);
        }
      } else {
        qualifies = checkBoundedWindow(i);
      }

      if (qualifies) {
        if (currentBoot.initLine) {
          boots.push(currentBoot);
          currentBoot = {};
        }
        currentBoot.initLine = rawLine.trim();
        if (parsedObj?.pid !== undefined) {
          currentBoot.pid = parsedObj.pid;
        }
      }
    }

    const isFlagsLine =
      (rawLine.includes("[company-memory-hardening]") || text.includes("[company-memory-hardening]")) &&
      (rawLine.includes("resolved hardening flags") || text.includes("resolved hardening flags"));

    if (isFlagsLine) {
      const source = (text.includes("[company-memory-hardening]") && text.includes("resolved hardening flags"))
        ? text
        : rawLine;
      const flagsMatch = /(?:\[company-memory-hardening\][^\n:]*resolved hardening flags(?:[^\n:]*)?:\s*)(.*)/.exec(source);
      if (flagsMatch && flagsMatch[1]) {
        try {
          const parsed = JSON.parse(flagsMatch[1].trim());
          if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.hermesMemoryConfig === "boolean" &&
            typeof parsed.hermesPromptSplit === "boolean" &&
            typeof parsed.agentScopedMem0 === "boolean" &&
            typeof parsed.capabilityMemoryGuidance === "boolean"
          ) {
            if (
              (currentBoot.flags !== undefined && currentBoot.initLine !== undefined) ||
              (currentBoot.pid !== undefined && parsedObj?.pid !== undefined && currentBoot.pid !== parsedObj.pid)
            ) {
              boots.push(currentBoot);
              currentBoot = { flags: parsed, pid: parsedObj?.pid };
            } else {
              currentBoot.flags = parsed;
              if (currentBoot.pid === undefined && parsedObj?.pid !== undefined) {
                currentBoot.pid = parsedObj.pid;
              }
            }
          }
        } catch {
          // invalid JSON line
        }
      }
    }
  }

  boots.push(currentBoot);

  function checkBoundedWindow(startIdx: number): boolean {
    const windowLines: string[] = [lines[startIdx]!];
    for (let j = startIdx + 1; j < Math.min(startIdx + 15, lines.length); j++) {
      const candidateLine = lines[j]!;
      if (isNewLogEntryStart(candidateLine)) {
        break;
      }
      windowLines.push(candidateLine);
    }
    const windowText = windowLines.join("\n");
    if (/["']?enabled["']?\s*:\s*false\b/i.test(windowText)) return false;
    if (/["']?companyScope["']?\s*:\s*["'](?!all["'])/i.test(windowText)) return false;
    const hasEnabledTrue = /["']?enabled["']?\s*:\s*true\b/i.test(windowText);
    const hasCompanyScopeAll = /["']?companyScope["']?\s*:\s*["']all["']/i.test(windowText);
    return hasEnabledTrue && hasCompanyScopeAll;
  }

  const bootsWithInit = boots.filter((b) => Boolean(b.initLine));
  if (bootsWithInit.length === 0) {
    throw new Error(
      "Server log missing required '[company-memory] Initialized company memory configuration' with enabled=true and companyScope='all'",
    );
  }

  // Evaluate latest boot only
  const latestBoot = bootsWithInit[bootsWithInit.length - 1]!;
  if (!latestBoot.flags) {
    throw new Error(
      "Server log missing required '[company-memory-hardening] Server resolved hardening flags (harness wrapper self-attestation)' proof line for latest boot",
    );
  }

  const line = latestBoot.initLine!;
  const flags = latestBoot.flags;
  return {
    line,
    flags,
    toString() {
      return line;
    },
  };
}
