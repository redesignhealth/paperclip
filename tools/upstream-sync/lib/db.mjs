import pg from "pg";

export async function connect(cfg) {
  if (!cfg.databaseUrl) throw new Error("UPSTREAM_SYNC_DATABASE_URL (or DATABASE_URL) is not set");
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4 });
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
