// Needs a scratch Postgres: UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://... (tables are truncated!)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { insertCommits } from "../lib/detect.mjs";
import { alertForClassifiedRows, flushAlerts, opsAlerts } from "../lib/alerts.mjs";
import { classifyPending } from "../lib/classify.mjs";
import { loadConfig } from "../lib/config.mjs";

const url = process.env.UPSTREAM_SYNC_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = url ? false : "UPSTREAM_SYNC_TEST_DATABASE_URL not set";

const commit = (n, over = {}) => ({
  sha: String(n).padStart(40, "0"), pr: n, title: `feat: thing ${n} (#${n})`, body: "", author: "a",
  mergedAt: "2026-10-27T00:00:00Z", files: ["server/src/a.ts"], revertsSha: null, ...over,
});

test("ledger: idempotent detector insert, exactly-once alerts, ops alerts", { skip }, async () => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(fs.readFileSync(path.join(here, "../schema.sql"), "utf8"));
    await db.query("TRUNCATE upstream_sync_log, upstream_sync_state, upstream_sync_alerts RESTART IDENTITY");
    const cfg = loadConfig({ UPSTREAM_SYNC_ALERT_SINK: "stdout", UPSTREAM_SYNC_ALERT_CHANNEL: "#eng", UPSTREAM_SYNC_LLM_API_KEY: "" });

    const batch = [commit(1), commit(2), commit(3)];
    assert.equal(await insertCommits(db, batch, null), 3);
    assert.equal(await insertCommits(db, batch, null), 0, "second insert must not duplicate");
    assert.equal((await db.query("SELECT count(*)::int n FROM upstream_sync_log")).rows[0].n, 3);
    const order = (await db.query("SELECT upstream_pr FROM upstream_sync_log ORDER BY id")).rows.map((r) => r.upstream_pr);
    assert.deepEqual(order, [1, 2, 3], "upstream order preserved");

    // Classifier without an API key falls back to the heuristic, so rows never stay unclassified.
    const stats = await classifyPending(db, cfg, { log() {} });
    assert.equal(stats.classified, 3);
    assert.equal((await db.query("SELECT count(*)::int n FROM upstream_sync_log WHERE category IS NULL")).rows[0].n, 0);

    // Make only row 2 a feature; rows 1,3 become fixes.
    await db.query("UPDATE upstream_sync_log SET category='fix' WHERE upstream_pr <> 2");
    await db.query("UPDATE upstream_sync_log SET category='feature', summary='Does a thing' WHERE upstream_pr = 2");
    const a1 = await alertForClassifiedRows(db, cfg);
    assert.equal(a1.queued, 1);
    const a2 = await alertForClassifiedRows(db, cfg);
    assert.equal(a2.queued, 0, "re-run must not re-alert");
    assert.equal((await db.query("SELECT count(*)::int n FROM upstream_sync_alerts WHERE kind='feature'")).rows[0].n, 1);

    const sent = [];
    const f = await flushAlerts(db, { ...cfg, alert: { ...cfg.alert, sink: "slack-webhook", slackWebhookUrl: "http://x" } }, {
      fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return { ok: true }; },
    });
    assert.equal(f.delivered, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, "#eng");
    const f2 = await flushAlerts(db, { ...cfg, alert: { ...cfg.alert, sink: "slack-webhook", slackWebhookUrl: "http://x" } }, {
      fetchImpl: async () => { throw new Error("must not resend"); },
    });
    assert.equal(f2.delivered, 0);

    // Overflow: per-run cap collapses the remainder into one digest.
    const capped = { ...cfg, alert: { ...cfg.alert, maxPerRun: 2 } };
    await insertCommits(db, [10, 11, 12, 13, 14].map((n) => commit(n)), null);
    await db.query("UPDATE upstream_sync_log SET category='feature', summary='s' WHERE upstream_pr >= 10");
    const a3 = await alertForClassifiedRows(db, capped);
    assert.equal(a3.queued, 3); // 2 individual + 1 digest
    assert.equal((await db.query("SELECT count(*)::int n FROM upstream_sync_log WHERE alert_state='suppressed'")).rows[0].n, 3);

    // Ops alerts: edge triggered.
    const lowCfg = { ...cfg, ops: { queueDepthMax: 2, oldestPendingHoursMax: 48 } };
    const o1 = await opsAlerts(db, lowCfg);
    assert.deepEqual(o1.fired, ["queue_depth"]);
    const o2 = await opsAlerts(db, lowCfg);
    assert.deepEqual(o2.fired, [], "no repeat while condition persists");
    await db.query("UPDATE upstream_sync_log SET created_at = now() - interval '49 hours' WHERE upstream_pr = 1");
    const o3 = await opsAlerts(db, lowCfg);
    assert.deepEqual(o3.fired, ["oldest_pending"]);
    await db.query("UPDATE upstream_sync_log SET status='merged'");
    await opsAlerts(db, lowCfg);
    await db.query("UPDATE upstream_sync_log SET status='pending'");
    const o4 = await opsAlerts(db, lowCfg);
    assert.ok(o4.fired.includes("queue_depth"), "new episode alerts again after recovery");
  } finally {
    await db.end();
  }
});
