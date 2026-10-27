#!/usr/bin/env node
// Upstream sync pipeline CLI (P0). No merging happens here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { connect, delState, getState, setState, withRunLock } from "./lib/db.mjs";
import { detect, getMarker, insertCommits, MARKER_KEY, PAUSED_KEY } from "./lib/detect.mjs";
import { classifyPending } from "./lib/classify.mjs";
import { alertForClassifiedRows, flushAlerts, opsAlerts } from "./lib/alerts.mjs";
import { ensureMirror, resolveCommit } from "./lib/upstreamGit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: node tools/upstream-sync/cli.mjs <command>
  migrate                 create/upgrade ledger tables and view (idempotent)
  run                     detect -> classify -> alert -> ops alerts -> flush   (the hourly job)
  detect                  only insert new pending rows
  classify                only classify rows with no category
  alert                   only enqueue row alerts + ops alerts, then flush
  flush                   deliver undelivered alerts via the configured sink
  status                  counts by status/category, marker, queue depth, paused
  pause | resume          stop/start the detector (run still classifies/alerts existing rows)
  reflag                  recompute fork_owned_hits/touches_migrations for all pending rows from FORK_OWNED.md
  marker show             print the upstream-synced marker
  marker set <sha>        move the marker (validated against upstream; see doc/UPSTREAM-SYNC.md)
  alerts pending          list undelivered alerts (outbox sink)
  alerts ack <id> [ref]   mark an outbox alert delivered
  view                    print the readable ledger view (JSON)
  report                  print the ledger as a markdown table (for the doc view)`;

const [cmd, sub, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
const log = (m) => console.error(`[upstream-sync ${new Date().toISOString()}] ${m}`);

async function migrate(db) {
  await db.query(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
}

async function status(db) {
  const st = await db.query(`SELECT status, count(*)::int n FROM upstream_sync_log GROUP BY 1 ORDER BY 1`);
  const cat = await db.query(`SELECT coalesce(category,'(unclassified)') AS category, count(*)::int n FROM upstream_sync_log GROUP BY 1 ORDER BY 2 DESC`);
  const flags = await db.query(
    `SELECT count(*) FILTER (WHERE cardinality(fork_owned_hits)>0)::int fork_owned,
            count(*) FILTER (WHERE touches_migrations)::int migrations FROM upstream_sync_log`,
  );
  const alerts = await db.query(`SELECT kind, count(*)::int total, count(*) FILTER (WHERE delivered_at IS NULL)::int undelivered FROM upstream_sync_alerts GROUP BY 1 ORDER BY 1`);
  return {
    marker: await getMarker(db, cfg),
    paused: (await getState(db, PAUSED_KEY)) === "true",
    lastDetectAt: await getState(db, "last_detect_at"),
    total: st.rows.reduce((a, r) => a + r.n, 0),
    byStatus: Object.fromEntries(st.rows.map((r) => [r.status, r.n])),
    byCategory: Object.fromEntries(cat.rows.map((r) => [r.category, r.n])),
    flagged: flags.rows[0],
    alerts: alerts.rows,
  };
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(USAGE);
  const pool = await connect(cfg);
  try {
    if (cmd === "migrate") {
      await migrate(pool);
      return log("schema applied");
    }
    if (cmd === "run") {
      const r = await withRunLock(pool, async (db) => {
        const d = await detect(db, cfg, log);
        const c = await classifyPending(db, cfg, { log });
        const a = await alertForClassifiedRows(db, cfg);
        const o = await opsAlerts(db, cfg);
        const f = await flushAlerts(db, cfg, { log });
        return { detect: d, classify: c, alerts: a, ops: o, flush: f };
      });
      if (r.locked) return log("another run holds the lock; exiting");
      return console.log(JSON.stringify(r.value, null, 2));
    }
    if (cmd === "detect") return console.log(JSON.stringify(await detect(pool, cfg, log)));
    if (cmd === "classify") return console.log(JSON.stringify(await classifyPending(pool, cfg, { log })));
    if (cmd === "alert") {
      const a = await alertForClassifiedRows(pool, cfg);
      const o = await opsAlerts(pool, cfg);
      const f = await flushAlerts(pool, cfg, { log });
      return console.log(JSON.stringify({ alerts: a, ops: o, flush: f }));
    }
    if (cmd === "flush") return console.log(JSON.stringify(await flushAlerts(pool, cfg, { log })));
    if (cmd === "status") return console.log(JSON.stringify(await status(pool), null, 2));
    if (cmd === "pause") { await setState(pool, PAUSED_KEY, "true"); return log("detector paused"); }
    if (cmd === "resume") { await delState(pool, PAUSED_KEY); return log("detector resumed"); }
    if (cmd === "reflag") {
      const { loadForkOwnedMatcher, touchesMigrations } = await import("./lib/forkOwned.mjs");
      const matcher = loadForkOwnedMatcher(cfg.forkOwnedFile);
      const { rows } = await pool.query(`SELECT upstream_sha, files FROM upstream_sync_log WHERE status = 'pending'`);
      for (const r of rows) {
        await pool.query(`UPDATE upstream_sync_log SET fork_owned_hits=$2, touches_migrations=$3, updated_at=now() WHERE upstream_sha=$1`,
          [r.upstream_sha, r.files.filter((f) => matcher.matches(f)), touchesMigrations(r.files)]);
      }
      return log(`reflagged ${rows.length} pending rows`);
    }
    if (cmd === "marker" && sub === "show") return console.log(await getMarker(pool, cfg));
    if (cmd === "marker" && sub === "set") {
      const want = rest[0];
      if (!want) throw new Error("marker set <sha>");
      await ensureMirror(cfg);
      const full = await resolveCommit(cfg.mirrorDir, want);
      if (!full) throw new Error(`${want} is not a commit on upstream ${cfg.upstreamBranch}`);
      await setState(pool, MARKER_KEY, full);
      return log(`marker set to ${full}. Rows already in the ledger are untouched; the detector inserts only commits after the new marker that are not already present.`);
    }
    if (cmd === "alerts" && sub === "pending") {
      const r = await pool.query(`SELECT id, dedup_key, kind, channel, payload->>'text' AS text FROM upstream_sync_alerts WHERE delivered_at IS NULL ORDER BY id`);
      return console.log(JSON.stringify(r.rows, null, 2));
    }
    if (cmd === "alerts" && sub === "ack") {
      const r = await pool.query(`UPDATE upstream_sync_alerts SET delivered_at=now(), delivery_ref=$2 WHERE id=$1 AND delivered_at IS NULL`, [rest[0], rest[1] || "manual"]);
      return log(`acked ${r.rowCount}`);
    }
    if (cmd === "view") {
      const r = await pool.query(`SELECT seq, sha, pr, status, category, summary, touches_fork_owned AS fork_owned, touches_migrations AS migr FROM upstream_sync_log_view`);
      return console.log(JSON.stringify(r.rows, null, 2));
    }
    if (cmd === "report") {
      const r = await pool.query(`SELECT seq, sha, pr, status, category, summary, touches_fork_owned, touches_migrations FROM upstream_sync_log_view`);
      const esc = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      const lines = ["| # | sha | PR | status | category | summary | flags |", "|---|---|---|---|---|---|---|"];
      for (const x of r.rows) {
        const flags = [x.touches_fork_owned && "fork-owned", x.touches_migrations && "migrations"].filter(Boolean).join(", ");
        lines.push(`| ${x.seq} | ${x.sha} | ${x.pr ?? ""} | ${x.status} | ${esc(x.category)} | ${esc(x.summary)} | ${flags} |`);
      }
      return console.log(lines.join("\n"));
    }
    console.log(USAGE);
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  log(`FAILED: ${e.message}`);
  process.exit(1);
});
