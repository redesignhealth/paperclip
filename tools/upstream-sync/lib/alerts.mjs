import { delState, getState, setState } from "./db.mjs";

const ALERT_CATEGORIES = ["feature", "breaking", "security"];
const upstreamUrl = (sha) => `https://github.com/paperclipai/paperclip/commit/${sha}`;
const prUrl = (pr) => `https://github.com/paperclipai/paperclip/pull/${pr}`;

export function formatRowAlert(row) {
  const flags = [];
  if (row.fork_owned_hits?.length) flags.push(`touches fork-owned files (${row.fork_owned_hits.length})`);
  if (row.touches_migrations) flags.push("touches Drizzle migrations/schema");
  const link = row.upstream_pr ? prUrl(row.upstream_pr) : upstreamUrl(row.upstream_sha);
  const icon = { feature: "NEW", breaking: "BREAKING", security: "SECURITY" }[row.category];
  return {
    text:
      `[upstream-sync ${icon}] ${row.summary}\n` +
      `${row.title}\n${link}` +
      (flags.length ? `\nFlags: ${flags.join("; ")}` : "") +
      `\nLedger status: ${row.status}`,
  };
}

// ---- sinks -----------------------------------------------------------------
async function deliver(cfg, alertRow, fetchImpl) {
  const { sink } = cfg.alert;
  const text = alertRow.payload.text;
  if (sink === "outbox") return null; // stays undelivered until drained
  if (sink === "stdout") {
    console.log(`[${alertRow.channel}] ${text}`);
    return "stdout";
  }
  if (sink === "slack-webhook") {
    const res = await fetchImpl(cfg.alert.slackWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: alertRow.channel, text }),
    });
    if (!res.ok) throw new Error(`slack webhook HTTP ${res.status}`);
    return "slack-webhook";
  }
  if (sink === "paperclip-comment") {
    const base = cfg.alert.paperclipApiUrl.replace(/\/$/, "").replace(/\/api$/, "");
    const res = await fetchImpl(`${base}/api/issues/${cfg.alert.issueId}/comments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.alert.paperclipApiKey}`,
        ...(cfg.alert.paperclipRunId ? { "x-paperclip-run-id": cfg.alert.paperclipRunId } : {}),
      },
      body: JSON.stringify({ body: `**Intended channel: ${alertRow.channel}**\n\n${text}` }),
    });
    if (!res.ok) throw new Error(`paperclip comment HTTP ${res.status}`);
    const j = await res.json().catch(() => ({}));
    return `paperclip-comment:${j.id ?? "ok"}`;
  }
  throw new Error(`unknown alert sink ${sink}`);
}

// Enqueue with dedup (exactly-once per key), then try to deliver everything undelivered.
export async function enqueueAlert(db, cfg, { dedupKey, kind, sha = null, payload }) {
  const r = await db.query(
    `INSERT INTO upstream_sync_alerts (dedup_key, kind, upstream_sha, channel, sink, payload)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [dedupKey, kind, sha, cfg.alert.channel, cfg.alert.sink, payload],
  );
  return r.rowCount > 0;
}

export async function flushAlerts(db, cfg, { fetchImpl = fetch, log = console.error } = {}) {
  if (cfg.alert.sink === "outbox") return { delivered: 0, failed: 0 };
  const { rows } = await db.query(
    `SELECT * FROM upstream_sync_alerts WHERE delivered_at IS NULL ORDER BY id LIMIT 50`,
  );
  let delivered = 0, failed = 0;
  for (const a of rows) {
    try {
      // Claim before sending: a crash after send but before mark could resend once;
      // that is the at-least-once edge, kept deliberately narrow.
      const ref = await deliver(cfg, a, fetchImpl);
      await db.query(
        `UPDATE upstream_sync_alerts SET delivered_at=now(), delivery_ref=$2, sink=$3, last_error=NULL WHERE id=$1`,
        [a.id, ref, cfg.alert.sink],
      );
      delivered++;
    } catch (e) {
      failed++;
      log(`alert ${a.dedup_key} delivery failed: ${e.message}`);
      await db.query(`UPDATE upstream_sync_alerts SET last_error=$2 WHERE id=$1`, [a.id, e.message.slice(0, 500)]);
    }
  }
  return { delivered, failed };
}

// One alert per classified feature/breaking/security row. Each run caps the number of
// individual alerts; the remainder is collapsed into one overflow digest so a 390-commit
// backlog load does not spam the channel. Overflowed rows are marked 'suppressed'
// (still visible in the ledger view), never silently dropped.
export async function alertForClassifiedRows(db, cfg) {
  const { rows } = await db.query(
    `SELECT * FROM upstream_sync_log
     WHERE category = ANY($1) AND alert_state IS NULL
     ORDER BY id`,
    [ALERT_CATEGORIES],
  );
  const max = cfg.alert.maxPerRun;
  let queued = 0;
  const overflow = rows.slice(max);
  for (const row of rows.slice(0, max)) {
    const ok = await enqueueAlert(db, cfg, {
      dedupKey: `row:${row.upstream_sha}`,
      kind: row.category,
      sha: row.upstream_sha,
      payload: formatRowAlert(row),
    });
    if (ok) queued++;
    await db.query(`UPDATE upstream_sync_log SET alert_state='sent', alerted_at=now() WHERE upstream_sha=$1`, [row.upstream_sha]);
  }
  if (overflow.length) {
    const shown = overflow.slice(0, 25);
    const lines = shown.map((r) => `- ${r.category}: ${r.summary} (${r.upstream_pr ? "#" + r.upstream_pr : r.upstream_sha.slice(0, 9)})`);
    const digest = `[upstream-sync] ${overflow.length} more feature/breaking/security rows (per-row alerts capped at ${max} per run):\n${lines.join("\n")}${overflow.length > shown.length ? `\n- ... and ${overflow.length - shown.length} more (see upstream_sync_log_view)` : ""}`;
    const key = `overflow:${overflow[0].upstream_sha}`;
    if (await enqueueAlert(db, cfg, { dedupKey: key, kind: "overflow", payload: { text: digest } })) queued++;
    await db.query(`UPDATE upstream_sync_log SET alert_state='suppressed', alerted_at=now() WHERE upstream_sha = ANY($1)`, [overflow.map((r) => r.upstream_sha)]);
  }
  return { queued, rows: rows.length };
}

// ---- ops alerts --------------------------------------------------------------
// Edge-triggered with an episode counter: one alert when a condition starts, one
// "recovered" note is not needed; the flag clears when the condition clears so the
// next episode alerts again.
export async function opsAlerts(db, cfg) {
  const out = [];
  const { rows } = await db.query(
    `SELECT count(*)::int AS depth,
            extract(epoch FROM (now() - min(created_at)))/3600 AS oldest_h
     FROM upstream_sync_log WHERE status = 'pending'`,
  );
  const depth = rows[0].depth;
  const oldestH = rows[0].oldest_h === null ? 0 : Number(rows[0].oldest_h);
  const checks = [
    { name: "queue_depth", bad: depth > cfg.ops.queueDepthMax, text: `[upstream-sync OPS] Queue depth ${depth} > ${cfg.ops.queueDepthMax} pending upstream commits.` },
    { name: "oldest_pending", bad: oldestH > cfg.ops.oldestPendingHoursMax, text: `[upstream-sync OPS] Oldest pending upstream commit is ${oldestH.toFixed(1)}h old (> ${cfg.ops.oldestPendingHoursMax}h).` },
  ];
  for (const c of checks) {
    const flag = `ops_active_${c.name}`;
    const active = (await getState(db, flag)) !== null;
    if (c.bad && !active) {
      const episode = Date.now();
      await setState(db, flag, String(episode));
      if (await enqueueAlert(db, cfg, { dedupKey: `ops:${c.name}:${episode}`, kind: "ops", payload: { text: c.text } })) out.push(c.name);
    } else if (!c.bad && active) {
      await delState(db, flag);
    }
  }
  return { depth, oldestH, fired: out };
}
