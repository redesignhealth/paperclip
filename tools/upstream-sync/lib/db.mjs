import fs from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const DEFAULT_CA_PATH = fileURLToPath(new URL("../global-bundle.pem", import.meta.url));

const INSECURE_SSL_MODES = new Set(["disable", "allow", "prefer", "no-verify", "false"]);
const SSL_PARAM_KEYS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"];

export function resolveCaPath(customPath) {
  return customPath || process.env.UPSTREAM_SYNC_RDS_CA || DEFAULT_CA_PATH;
}

export function getRdsCaBundle(customPath) {
  const p = resolveCaPath(customPath);
  if (p && fs.existsSync(p)) {
    return fs.readFileSync(p, "utf8");
  }
  return null;
}

export function prepareConnectionOptions(databaseUrl, options = {}) {
  if (!databaseUrl) throw new Error("UPSTREAM_SYNC_DATABASE_URL (or DATABASE_URL) is not set");

  const caFilePath = typeof options === "string" ? options : options?.caFile;
  const explicitRdsTrust = typeof options === "object" ? Boolean(options?.rdsTrust) : false;

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    // Sanitize: do not leak raw URL or credentials on parse failure
    throw new Error("Invalid database URL");
  }

  const host = (parsed.hostname || "").toLowerCase();
  const isRdsHost = host.endsWith(".rds.amazonaws.com");
  const envRdsTrust = process.env.UPSTREAM_SYNC_RDS_TRUST === "true" || process.env.UPSTREAM_SYNC_RDS_TRUST === "1";
  const useRdsTrust = isRdsHost || explicitRdsTrust || envRdsTrust;

  const rawSslmode = (parsed.searchParams.get("sslmode") || "").toLowerCase();
  const rawSsl = (parsed.searchParams.get("ssl") || "").toLowerCase();

  if (useRdsTrust) {
    // For RDS or explicitly trusted RDS endpoints: fail-closed against any insecure or downgrade SSL mode
    if (INSECURE_SSL_MODES.has(rawSslmode) || INSECURE_SSL_MODES.has(rawSsl)) {
      throw new Error(
        `Insecure SSL mode '${rawSslmode || rawSsl}' is rejected for Amazon RDS endpoint '${host}'. Strict verified TLS is required.`,
      );
    }

    const ca = getRdsCaBundle(caFilePath);
    if (!ca) {
      const targetPath = resolveCaPath(caFilePath);
      throw new Error(
        `RDS database connection requires CA certificate bundle, but not found at ${targetPath}`,
      );
    }

    // Strip all SSL-related query params from the URL so node-postgres connection-parameters
    // does not reparse sslmode and override/drop our explicit ssl configuration.
    const cleanedUrl = new URL(databaseUrl);
    for (const k of SSL_PARAM_KEYS) {
      cleanedUrl.searchParams.delete(k);
    }

    const ssl = {
      ca,
      rejectUnauthorized: true,
      servername: host,
    };

    return {
      connectionString: cleanedUrl.toString(),
      ssl,
    };
  }

  // Non-RDS endpoint without explicit RDS trust:
  // Preserve existing node-postgres TLS / CA / mTLS semantics untouched.
  // pg.Pool parses the connectionString natively, honoring standard libpq params
  // (sslmode=require, sslrootcert, sslcert, sslkey) and system truststores.
  return {
    connectionString: databaseUrl,
    ssl: undefined,
  };
}

export async function connect(cfg) {
  if (!cfg.databaseUrl) throw new Error("UPSTREAM_SYNC_DATABASE_URL (or DATABASE_URL) is not set");
  const connOpts = prepareConnectionOptions(cfg.databaseUrl, {
    caFile: cfg.caFile,
    rdsTrust: cfg.rdsTrust,
  });
  const poolConfig = { connectionString: connOpts.connectionString, max: 4 };
  if (connOpts.ssl !== undefined) {
    poolConfig.ssl = connOpts.ssl;
  }
  const pool = new pg.Pool(poolConfig);
  return pool;
}

export async function getState(db, key) {
  const r = await db.query("SELECT value FROM upstream_sync_state WHERE key = $1", [key]);
  return r.rows[0]?.value ?? null;
}

export async function setState(db, key, value) {
  await db.query(
    `INSERT INTO upstream_sync_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

export async function delState(db, key) {
  await db.query("DELETE FROM upstream_sync_state WHERE key = $1", [key]);
}

// Session-level advisory lock so overlapping cron runs never interleave.
//
// Postgres advisory locks are keyed by a (int4, int4) pair, or by a single
// bigint. A one-argument call like `pg_try_advisory_lock(hashtext('x'))`
// resolves to the *single-key* form, which shares one flat 64-bit space with
// every other single-key advisory lock in the database. Paperclip's own
// application code also takes single-key `hashtext(...)` locks, so an
// unrelated key that happened to hash to the same int4 would silently serialize
// the two -- and, worse, a short-lived collision would look like "another run
// holds the lock" and skip a whole hourly sync.
//
// Using the two-key form gives this tool its own private int4 namespace: a
// two-key lock can never collide with a single-key lock, whatever the hash.
// Keep this literal stable -- changing it orphans any lock a running process
// still holds.
const UPSTREAM_SYNC_LOCK_NAMESPACE = 0x55505359; // 'UPSY' as a positive int4 = 1431327577
const UPSTREAM_SYNC_LOCK_KEY = "upstream_sync_run";

export async function withRunLock(pool, fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS ok",
      [UPSTREAM_SYNC_LOCK_NAMESPACE, UPSTREAM_SYNC_LOCK_KEY],
    );
    if (!rows[0].ok) return { locked: true };
    try {
      return { locked: false, value: await fn(client) };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::int, hashtext($2))", [
        UPSTREAM_SYNC_LOCK_NAMESPACE,
        UPSTREAM_SYNC_LOCK_KEY,
      ]);
    }
  } finally {
    client.release();
  }
}
