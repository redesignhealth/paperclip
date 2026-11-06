import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { redactSensitiveString } from "../packages/adapters/hermes/src/server/memory-config.js";

const require = createRequire(import.meta.url);
const drizzleOrmPath = require.resolve("drizzle-orm", {
  paths: [path.resolve(process.cwd(), "packages/db")],
});
const { sql } = require(drizzleOrmPath) as typeof import("drizzle-orm");

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

export function redactSampleData(
  data: string,
  secrets: readonly string[],
  prefixChars = 16,
): string {
  if (!data) return "";
  const scrubbed = redactSensitiveString(data, secrets);
  const prefixLength = Math.min(prefixChars, scrubbed.length);
  return `[REDACTED_${prefixLength}_CHARS]${scrubbed.slice(prefixLength)}`;
}

async function main() {
  const outPath = parseFlag("--out");
  const limitStr = parseFlag("--limit");
  const tableName = parseFlag("--table") ?? "mem0_memories";
  const redactPrefixChars = parseInt(parseFlag("--redact-prefix") ?? "16", 10);
  const companyFilter = parseFlag("--company");

  if (!outPath || !limitStr) {
    console.error("Refuses to run without explicit --out and --limit.");
    console.error(
      "Usage: tsx scripts/sample-mem0-memory-content.ts --out <filepath> --limit <number> [--table <tableName>] [--company <companyId>] [--redact-prefix <chars>]",
    );
    process.exitCode = 1;
    return;
  }

  const limit = parseInt(limitStr, 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error(`Invalid --limit value: "${limitStr}". Must be a positive integer.`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const dbUrl =
    process.env.COMPANY_MEMORY_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    config.databaseUrl ||
    `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  console.log(`Connecting to memory database in read-only mode...`);
  const db = createDb(dbUrl);

  // Strictly enforce read-only transaction mode
  await db.execute(sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;`);

  console.log(`Querying memory counts by agent from table "${tableName}"...`);

  // Breakdown by agent_id
  const breakdownRows = (await db.execute<{ agent_id: string | null; count: number }>(sql`
    SELECT
      COALESCE(payload->>'agent_id', '(none)') AS agent_id,
      COUNT(*)::int AS count
    FROM ${sql.identifier(tableName)}
    GROUP BY payload->>'agent_id'
    ORDER BY count DESC
  `)) as unknown as Array<{ agent_id: string | null; count: number }>;

  // Total count
  const totalRowsRes = (await db.execute<{ total: number }>(sql`
    SELECT COUNT(*)::int AS total
    FROM ${sql.identifier(tableName)}
  `)) as unknown as Array<{ total: number }>;

  const totalCount = Number(totalRowsRes[0]?.total ?? 0);

  console.log(`Total memory rows in "${tableName}": ${totalCount}`);
  console.log("Memory count breakdown by agent:");
  for (const row of breakdownRows) {
    console.log(`  - ${row.agent_id}: ${row.count}`);
  }

  // Sample data up to limit
  console.log(`Extracting sample of up to ${limit} rows (redacted)...`);
  const sampleRows = (await db.execute<{
    id: string;
    agent_id: string | null;
    user_id: string | null;
    data: string | null;
    created_at: string | null;
  }>(sql`
    SELECT
      id,
      payload->>'agent_id' AS agent_id,
      payload->>'user_id' AS user_id,
      payload->>'data' AS data,
      created_at
    FROM ${sql.identifier(tableName)}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)) as unknown as Array<{
    id: string;
    agent_id: string | null;
    user_id: string | null;
    data: string | null;
    created_at: string | null;
  }>;

  // Collect sensitive strings from environment
  const envSecrets = Object.entries(process.env)
    .filter(
      ([k, v]) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD|URL)$/i.test(k) &&
        typeof v === "string" &&
        v.length >= 4,
    )
    .map(([, v]) => v as string);

  const redactedSamples = sampleRows.map((row) => {
    const rawData = String(row.data ?? "");
    const redacted = redactSampleData(rawData, envSecrets, redactPrefixChars);
    return {
      id: row.id,
      agentId: row.agent_id,
      userId: row.user_id,
      dataRedacted: redacted,
      createdAt: row.created_at,
    };
  });

  const resolvedOutPath = path.resolve(process.cwd(), outPath);
  const exportPayload = {
    metadata: {
      exportedAt: new Date().toISOString(),
      table: tableName,
      companyFilter: companyFilter ?? null,
      totalCount,
      sampleLimit: limit,
      sampleCount: redactedSamples.length,
      redactPrefixChars,
      agentBreakdown: breakdownRows,
    },
    samples: redactedSamples,
  };

  await writeFile(resolvedOutPath, JSON.stringify(exportPayload, null, 2), "utf8");
  console.log(`Successfully exported ${redactedSamples.length} redacted samples to ${resolvedOutPath}`);
  console.log("CRITICAL: Raw memory content is never written to stdout and must never be committed.");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Sample mem0 memory content failed: ${message}`);
  process.exitCode = 1;
});
