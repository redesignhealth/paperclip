import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../packages/db/src/index.js";
import { redactSensitiveString } from "../packages/adapters/hermes/src/server/memory-config.js";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
type SqlFragment = any;
type SqlTag = {
  (strings: TemplateStringsArray, ...params: unknown[]): SqlFragment;
  raw: (raw: string) => SqlFragment;
  identifier: (identifier: string) => SqlFragment;
};
const { sql } = require("drizzle-orm") as { sql: SqlTag };

export function parseFlag(name: string, argv: string[] = process.argv): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

export function hasFlag(name: string, argv: string[] = process.argv): boolean {
  return argv.includes(name);
}

const SAFE_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateAndResolveTableIdentifier(tableName: string, sqlTag: SqlTag = sql): SqlFragment {
  if (tableName.includes(".")) {
    const parts = tableName.split(".");
    if (parts.length !== 2 || !SAFE_IDENTIFIER_REGEX.test(parts[0]) || !SAFE_IDENTIFIER_REGEX.test(parts[1])) {
      throw new Error(
        `Invalid --table value: "${tableName}". Must be a valid bare identifier (e.g. "mem0_memories") or schema.identifier (e.g. "public.mem0_memories").`,
      );
    }
    return sqlTag`${sqlTag.identifier(parts[0])}.${sqlTag.identifier(parts[1])}`;
  }

  if (!SAFE_IDENTIFIER_REGEX.test(tableName)) {
    throw new Error(
      `Invalid --table value: "${tableName}". Must be a valid bare identifier (e.g. "mem0_memories") or schema.identifier (e.g. "public.mem0_memories").`,
    );
  }
  return sqlTag`${sqlTag.identifier(tableName)}`;
}

export function isPathInside(targetPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, targetPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function validateOutputPath(outPath: string, repoRootPath?: string): string {
  const resolvedOutPath = path.resolve(process.cwd(), outPath);
  const repoRoot = repoRootPath ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

  let realRepoRoot = repoRoot;
  try {
    realRepoRoot = realpathSync(repoRoot);
  } catch {
    // fallback if repoRoot cannot be resolved with realpath
  }

  if (isPathInside(resolvedOutPath, repoRoot) || isPathInside(resolvedOutPath, realRepoRoot)) {
    throw new Error(
      `Refusing to write output inside repository (${resolvedOutPath}). Memory exports contain sensitive content. Use an external directory such as /tmp.`,
    );
  }

  const parentDir = path.dirname(resolvedOutPath);
  if (!existsSync(parentDir)) {
    throw new Error(
      `Parent directory does not exist: "${parentDir}". The output parent directory must exist prior to running the sampler.`,
    );
  }

  const realParentDir = realpathSync(parentDir);
  const simulatedTargetPath = path.resolve(realParentDir, path.basename(resolvedOutPath));
  if (isPathInside(simulatedTargetPath, repoRoot) || isPathInside(simulatedTargetPath, realRepoRoot)) {
    throw new Error(
      `Refusing to write output inside repository via symlinked parent (${resolvedOutPath}). Memory exports contain sensitive content. Use an external directory such as /tmp.`,
    );
  }

  return resolvedOutPath;
}

export function validateRedactPrefixChars(prefixStr: string | null): number {
  if (prefixStr === null) return 16;
  const parsed = parseInt(prefixStr, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== prefixStr.trim()) {
    throw new Error(`Invalid --redact-prefix value: "${prefixStr}". Must be a non-negative integer.`);
  }
  return parsed;
}

/**
 * Masks the first prefixChars of data with [REDACTED_N_CHARS] and scrubs exact
 * matches of process environment secrets.
 *
 * NOTE: The export contains near-raw sensitive memory content and is NOT
 * guaranteed to be free of PII, customer information, or unconfigured secrets.
 * Treat the output file as sensitive restricted data.
 */
export function redactSampleData(
  data: string,
  secrets: readonly string[],
  prefixChars = 16,
): string {
  if (!data) return "";
  const scrubbed = redactSensitiveString(data, secrets);
  if (prefixChars <= 0) return scrubbed;
  const prefixLength = Math.min(prefixChars, scrubbed.length);
  return `[REDACTED_${prefixLength}_CHARS]${scrubbed.slice(prefixLength)}`;
}

export function collectEnvironmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets = new Set<string>();

  for (const [key, value] of Object.entries(env)) {
    if (!value || typeof value !== "string" || value.length < 4) continue;

    // Generic direct credentials
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) {
      secrets.add(value);
    }

    // Known URL connection strings: scrub the password component specifically
    if (/(?:DATABASE_URL|DB_URL|_URL)$/i.test(key)) {
      try {
        const parsed = new URL(value);
        if (parsed.password) {
          secrets.add(decodeURIComponent(parsed.password));
        }
      } catch {
        // Not a standard parseable URL, ignore parse failure
      }
    }
  }

  return Array.from(secrets);
}

export type SampleOptions = {
  outPath: string;
  limit: number;
  databaseUrl: string;
  tableName?: string;
  agentFilter?: string | null;
  redactPrefixChars?: number;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  onTransaction?: (tx: any) => Promise<void> | void;
};

export type SampleResult = {
  outputPath: string;
  totalCount: number;
  sampleCount: number;
  agentBreakdown: Array<{ agent_id: string | null; count: number }>;
  transactionReadOnly?: string;
};

export async function sampleMem0MemoryContent(options: SampleOptions): Promise<SampleResult> {
  const {
    outPath,
    limit,
    databaseUrl,
    tableName = "mem0_memories",
    agentFilter = null,
    redactPrefixChars = 16,
    env = process.env,
    repoRoot,
  } = options;

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid limit value: ${limit}. Must be a positive integer.`);
  }

  const resolvedOutPath = validateOutputPath(outPath, repoRoot);
  const tableIdent = validateAndResolveTableIdentifier(tableName, sql);

  console.log(`Connecting to memory database in read-only mode...`);
  // Enforce single connection for the transaction
  const db = createDb(databaseUrl, { maxConnections: 1 });

  try {
    let totalCount = 0;
    let breakdownRows: Array<{ agent_id: string | null; count: number }> = [];
    let sampleRows: Array<{
      id: string;
      agent_id: string | null;
      user_id: string | null;
      data: string | null;
      created_at: string | null;
    }> = [];
    let transactionReadOnly: string | undefined;

    // Enforce read-only mode on the reserved transaction connection for all queries
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY;`);

      const readOnlyRes = (await tx.execute<{ transaction_read_only: string }>(
        sql`SHOW transaction_read_only;`,
      )) as unknown as Array<{ transaction_read_only: string }>;
      transactionReadOnly = readOnlyRes[0]?.transaction_read_only;

      if (options.onTransaction) {
        await options.onTransaction(tx);
      }

      const whereClause = agentFilter
        ? sql`WHERE payload->>'agent_id' = ${agentFilter}`
        : sql.raw("");

      console.log(`Querying memory counts from table "${tableName}"...`);

      // Total count query
      const totalRowsRes = (await tx.execute<{ total: number }>(sql`
        SELECT COUNT(*)::int AS total
        FROM ${tableIdent}
        ${whereClause}
      `)) as unknown as Array<{ total: number }>;

      const countRow = totalRowsRes[0];
      if (!countRow || typeof countRow.total !== "number") {
        throw new Error(
          `Expected count query to return a total row, received: ${JSON.stringify(totalRowsRes)}`,
        );
      }
      totalCount = countRow.total;

      // Agent breakdown query
      breakdownRows = (await tx.execute<{ agent_id: string | null; count: number }>(sql`
        SELECT
          COALESCE(payload->>'agent_id', '(none)') AS agent_id,
          COUNT(*)::int AS count
        FROM ${tableIdent}
        ${whereClause}
        GROUP BY payload->>'agent_id'
        ORDER BY count DESC
      `)) as unknown as Array<{ agent_id: string | null; count: number }>;

      // Sample query - Mem0 pgvector table shape has columns (id, vector, payload).
      // created_at is stored in payload->>'created_at'.
      console.log(`Extracting sample of up to ${limit} rows (redacted)...`);
      sampleRows = (await tx.execute<{
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
          payload->>'created_at' AS created_at
        FROM ${tableIdent}
        ${whereClause}
        ORDER BY payload->>'created_at' DESC NULLS LAST
        LIMIT ${limit}
      `)) as unknown as Array<{
        id: string;
        agent_id: string | null;
        user_id: string | null;
        data: string | null;
        created_at: string | null;
      }>;
    });

    console.log(`Total memory rows in "${tableName}": ${totalCount}`);
    console.log("Memory count breakdown by agent:");
    for (const row of breakdownRows) {
      console.log(`  - ${row.agent_id}: ${row.count}`);
    }

    const envSecrets = collectEnvironmentSecrets(env);
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

    const exportPayload = {
      metadata: {
        exportedAt: new Date().toISOString(),
        table: tableName,
        agentFilter: agentFilter ?? null,
        totalCount,
        sampleLimit: limit,
        sampleCount: redactedSamples.length,
        redactPrefixChars,
        agentBreakdown: breakdownRows,
      },
      samples: redactedSamples,
    };

    // Re-verify output path and parent realpath immediately before exclusive file creation to avoid TOCTOU
    validateOutputPath(resolvedOutPath, repoRoot);

    // Mode 0600 (owner read/write only) and flag wx (exclusive new file, avoid clobbering)
    await writeFile(resolvedOutPath, JSON.stringify(exportPayload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });

    console.log(
      `Successfully exported ${redactedSamples.length} redacted samples to ${resolvedOutPath}`,
    );
    console.log(
      "CRITICAL: Output contains sensitive near-raw memory data. It must never be committed or published.",
    );

    return {
      outputPath: resolvedOutPath,
      totalCount,
      sampleCount: redactedSamples.length,
      agentBreakdown: breakdownRows,
      transactionReadOnly,
    };
  } finally {
    await db.$client.end({ timeout: 1 }).catch(() => {});
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  if (hasFlag("--company", argv)) {
    console.error(
      "Error: The --company selector has been removed. Mem0 memory databases are single-tenant per company. Scoping is enforced at the database boundary: supply the target company's memory database via --database-url (or COMPANY_MEMORY_DATABASE_URL).",
    );
    process.exitCode = 1;
    return;
  }

  const outPath = parseFlag("--out", argv);
  const limitStr = parseFlag("--limit", argv);
  const tableName = parseFlag("--table", argv) ?? "mem0_memories";
  const agentFilter = parseFlag("--agent", argv);
  const redactPrefixStr = parseFlag("--redact-prefix", argv);

  if (!outPath || !limitStr) {
    console.error("Refuses to run without explicit --out and --limit.");
    console.error(
      "Usage: tsx scripts/sample-mem0-memory-content.ts --out <filepath> --limit <number> [--database-url <url>] [--agent <agentId>] [--table <tableName>] [--redact-prefix <chars>]",
    );
    process.exitCode = 1;
    return;
  }

  const limit = parseInt(limitStr, 10);
  if (!Number.isInteger(limit) || limit <= 0 || String(limit) !== limitStr.trim()) {
    console.error(`Invalid --limit value: "${limitStr}". Must be a positive integer.`);
    process.exitCode = 1;
    return;
  }

  let redactPrefixChars = 16;
  try {
    redactPrefixChars = validateRedactPrefixChars(redactPrefixStr);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const dbUrl =
    parseFlag("--database-url", argv)?.trim() ||
    process.env.COMPANY_MEMORY_DATABASE_URL?.trim();

  if (!dbUrl) {
    console.error(
      "Refuses to run without explicit per-company --database-url (or COMPANY_MEMORY_DATABASE_URL environment variable).",
    );
    console.error(
      "Mem0 memory databases are strictly isolated per company (the database is the tenant boundary). Control-plane databases do not contain Mem0 collection tables.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    await sampleMem0MemoryContent({
      outPath,
      limit,
      databaseUrl: dbUrl,
      tableName,
      agentFilter: agentFilter?.trim() || null,
      redactPrefixChars,
      env: process.env,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      console.error(`Output file already exists at "${outPath}". Refusing to overwrite.`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Sample mem0 memory content failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void main();
}
