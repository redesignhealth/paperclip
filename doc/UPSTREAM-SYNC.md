# Upstream sync: ledger, detector, classifier, alerts (P0)

Spec: upstream-sync process plan, revision 3. This is phase P0:
**no merging happens here.** The pipeline records, classifies and announces upstream
`paperclipai/paperclip` commits so later phases (worker loop, conflict path) have a queue.

Code: `tools/upstream-sync/` (Node 20+, one dependency: `pg`). Fork-owned path list:
`FORK_OWNED.md`.

## What runs

`node tools/upstream-sync/cli.mjs run` is the hourly job. In order:

1. **detect** (no LLM). Fetches upstream `master` into a blobless bare mirror, lists commits
   after the `upstream-synced` marker (first-parent order, oldest first) and inserts one
   `pending` row per commit. `ON CONFLICT (upstream_sha) DO NOTHING`, so re-runs add nothing.
   Also stores the changed file list, flags `fork_owned_hits` (paths matching `FORK_OWNED.md`)
   and `touches_migrations` (`packages/db/src/migrations/`, `packages/db/src/schema/`),
   and links upstream reverts via `reverts_sha`.
2. **classify**. Rows with no `category` get one of `feature | fix | perf | security | infra |
   breaking` plus a one-line `summary`. Cheap model, 10 commits per call. If the model is
   unreachable, returns junk for a row, or has no API key, a deterministic heuristic fills
   the row (`classified_by = 'heuristic'`), so nothing stays unclassified and no alert is skipped.
3. **alert** per `feature | breaking | security` row, then **ops alerts**, then flush.

## Ledger

Tables (`tools/upstream-sync/schema.sql`, idempotent, apply with `cli.mjs migrate`):

- `upstream_sync_log`: the queue. `id` is assigned in upstream order. Columns: `upstream_sha`
  (unique), `upstream_pr`, `title`, `body`, `author`, `files[]`, `upstream_merged_at`,
  `category`, `summary`, `classified_by`, `fork_owned_hits[]`, `touches_migrations`,
  `fork_pr`, `path` (`clean|conflict`), `argus_verdict`, `merged_at`, `prod_pinned_at`,
  `status` (`pending|in_progress|merged|skipped|conflict|needs-human|reverted`), `skip_reason`,
  `reverts_sha`, `alert_state`, `alerted_at`, `created_at`, `updated_at`.
- `upstream_sync_state`: `upstream_synced_marker`, `detector_paused`, ops-alert episode flags.
- `upstream_sync_alerts`: alert outbox with a unique `dedup_key` (exactly-once enqueue;
  delivery is at-least-once — see Alerts).
- View `upstream_sync_log_view`: readable projection (short sha, URL, flags, pending age).
  `cli.mjs report` renders it as a markdown table for the doc view.

Write access: only the pipeline role. Humans and agents read through the view. Give readers
`SELECT` on the view only; give the pipeline role the table privileges.

## Alerts

One setting picks the destination: `UPSTREAM_SYNC_ALERT_CHANNEL` (default `#eng`).
`UPSTREAM_SYNC_ALERT_SINK` selects how it is delivered. Text derived from upstream commit
fields is untrusted: Slack text is HTML-escaped, and Paperclip comments have mention syntax
neutralized.

| sink | behaviour |
|---|---|
| `outbox` (default) | record only; read with `alerts pending`, mark with `alerts ack <id>` |
| `slack-webhook` | POST `{channel, text}` to `UPSTREAM_SYNC_SLACK_WEBHOOK_URL` |
| `paperclip-comment` | comment on issue `UPSTREAM_SYNC_ALERT_ISSUE_ID` via the Paperclip API (interim until Slack is connected) |
| `stdout` | print (testing) |

Exactly one alert is enqueued per row (`dedup_key = row:<sha>`). Enqueue is exactly-once, but
delivery is at-least-once: an alert is sent and then marked delivered, so a crash between the
two resends it on the next flush. To avoid flooding the channel on a large
backlog load, at most `UPSTREAM_SYNC_ALERT_MAX_PER_RUN` (default 10) per-row alerts go out per run; the rest
are collapsed into one digest and marked `alert_state = 'suppressed'` (still visible in the view).
In P1 the alert moves from classification time to merge time.

Ops alerts are edge-triggered (one alert when a condition starts, re-armed when it clears):
queue depth `> UPSTREAM_SYNC_QUEUE_DEPTH_MAX` (default 40) and oldest `pending` older than
`UPSTREAM_SYNC_OLDEST_PENDING_HOURS_MAX` (default 48).

## Configuration (environment)

| variable | default | meaning |
|---|---|---|
| `UPSTREAM_SYNC_DATABASE_URL` (or `DATABASE_URL`) | none, required | rh-ops Postgres, pipeline role |
| `UPSTREAM_SYNC_UPSTREAM_REPO` | `https://github.com/paperclipai/paperclip.git` | |
| `UPSTREAM_SYNC_BRANCH` | `master` | |
| `UPSTREAM_SYNC_MIRROR_DIR` | `~/.cache/upstream-sync/mirror.git` | bare mirror, safe to delete |
| `UPSTREAM_SYNC_INITIAL_MARKER` | `898144f4b…` (catch-up #191) | used until a marker is stored |
| `UPSTREAM_SYNC_FORK_OWNED_FILE` | `<repo>/FORK_OWNED.md` | |
| `UPSTREAM_SYNC_LLM_BASE_URL` / `_MODEL` / `_API_KEY` | OpenAI-compatible, `gpt-4o-mini`, falls back to `OPENAI_API_KEY` | classifier |
| `UPSTREAM_SYNC_HTTP_TIMEOUT_MS` | `30000` | abort LLM + webhook calls; a timed-out LLM call falls back to the heuristic, a timed-out delivery is retried next flush |
| `UPSTREAM_SYNC_ALERT_*`, `UPSTREAM_SYNC_SLACK_WEBHOOK_URL` | see Alerts | |

## Runbook

Run from a checkout of this repo: `cd tools/upstream-sync && npm ci`.

- First time: `node cli.mjs migrate`, then `node cli.mjs run` (loads the backlog after the marker).
- Hourly: schedule `node cli.mjs run` (cron or a Paperclip routine). A Postgres advisory lock stops overlapping
  runs; a second concurrent run exits immediately.
- Look: `node cli.mjs status` (counts, marker, paused flag, undelivered alerts) or `node cli.mjs report`.
- **Pause the detector**: `node cli.mjs pause`. Existing rows are still classified and alerted by `run`;
  no new rows are inserted. **Resume**: `node cli.mjs resume`. To stop everything, pause the schedule itself.
- **Move the marker**: `node cli.mjs marker set <sha>` (validated against upstream; must exist). The stored
  marker overrides `UPSTREAM_SYNC_INITIAL_MARKER`. Moving it forward skips the commits in between (they are not
  inserted). Moving it backward re-inserts only commits not already in the ledger. In P1+ the worker advances the
  marker only to the highest SHA where every earlier row is `merged` or `skipped`; do not move it by hand while
  the worker is running. The detector refuses to run if the marker is not an ancestor of upstream `master`
  (force-push); fix with `marker set`.
- Re-classify a row: `UPDATE upstream_sync_log SET category=NULL, summary=NULL WHERE upstream_sha='…'` then `run`.
- Drain the outbox by hand: `alerts pending`, post the text, `alerts ack <id> <ref>`.
- Edit `FORK_OWNED.md` in the same PR as any new fork patch. Flags are computed at insert time; run
  `node cli.mjs reflag` to recompute them for `pending` rows after editing it.

## Tests

`cd tools/upstream-sync && npm test`. The DB test needs a scratch Postgres:
`UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://… npm test` (it truncates the ledger tables, never point it at
the real ledger). Without the variable the DB test is skipped.
