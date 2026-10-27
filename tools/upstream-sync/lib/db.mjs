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
export async function withRunLock(pool, fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext('upstream_sync_run')) AS ok");
    if (!rows[0].ok) return { locked: true };
    try {
      return { locked: false, value: await fn(client) };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('upstream_sync_run'))");
    }
  } finally {
    client.release();
  }
}
