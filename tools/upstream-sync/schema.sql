-- TEST FIXTURE ONLY. This is NOT the production schema.
--
-- The upstream-sync ledger's real schema is owned by Paperclip's Drizzle
-- migration chain: packages/db/src/schema/upstream_sync.ts plus
-- packages/db/src/migrations/0380_upstream_sync_ledger.sql. Embedded-PG dev
-- and test databases only ever get that chain, and `cli.mjs migrate` verifies
-- those objects exist rather than creating anything.
--
-- This file exists solely so tools/upstream-sync/__tests__/db.test.mjs can spin
-- up the three tables and the view on a bare scratch database without running a
-- full Paperclip migration. __tests__/schema-parity.test.mjs asserts this file
-- and migration 0380 produce the same columns and constraints, so drift between
-- them fails a test instead of a production run.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS upstream_sync_log (
  id                  bigserial PRIMARY KEY,   -- assigned in upstream commit order
  upstream_sha        text        NOT NULL UNIQUE,
  upstream_pr         integer,
  title               text        NOT NULL,
  body                text,                     -- commit message body (classifier input)
  author              text,
  files               text[]      NOT NULL DEFAULT '{}',
  upstream_merged_at  timestamptz,
  category            text        CHECK (category IN ('feature','fix','perf','security','infra','breaking')),
  summary             text,
  classified_by       text,                         -- 'llm:<model>' | 'heuristic' | 'heuristic(kept)+llm:<model>'
                                                    --   (heuristic pinned security/breaking, model wrote the summary)
  classified_at       timestamptz,
  fork_owned_hits     text[]      NOT NULL DEFAULT '{}',   -- files matching FORK_OWNED.md
  touches_migrations  boolean     NOT NULL DEFAULT false,  -- Drizzle migrations / schema
  fork_pr             text,
  path                text        CHECK (path IN ('clean','conflict')),
  argus_verdict       text,
  merged_at           timestamptz,
  prod_pinned_at      timestamptz,
  status              text        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','in_progress','merged','skipped','conflict','needs-human','reverted')),
  skip_reason         text,
  reverts_sha         text,                         -- upstream revert linked to original
  alert_state         text        CHECK (alert_state IN ('sent','suppressed')),
  alerted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upstream_sync_log_status_idx   ON upstream_sync_log (status, id);
CREATE INDEX IF NOT EXISTS upstream_sync_log_category_idx ON upstream_sync_log (category);

-- Small key/value state: upstream_synced_marker, paused, ops-alert episode flags.
CREATE TABLE IF NOT EXISTS upstream_sync_state (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Alert outbox. One row per alert; the unique dedup_key makes ENQUEUE
-- exactly-once. Delivery is at-least-once: each row is sent then marked
-- delivered, so a crash between the two resends it on the next flush.
CREATE TABLE IF NOT EXISTS upstream_sync_alerts (
  id            bigserial PRIMARY KEY,
  dedup_key     text        NOT NULL UNIQUE,   -- 'row:<sha>' | 'ops:<name>:<episode>' | 'overflow:<run>'
  kind          text        NOT NULL,          -- feature | breaking | security | ops | overflow
  upstream_sha  text,
  channel       text        NOT NULL,          -- e.g. #eng
  sink          text        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  delivery_ref  text,
  last_error    text
);

-- Readable doc view (what the doc/Slack/humans read).
CREATE OR REPLACE VIEW upstream_sync_log_view AS
SELECT
  id                                                           AS seq,
  left(upstream_sha, 9)                                        AS sha,
  upstream_pr                                                  AS pr,
  'https://github.com/paperclipai/paperclip/commit/' || upstream_sha AS url,
  status,
  category,
  summary,
  title,
  author,
  upstream_merged_at,
  (cardinality(fork_owned_hits) > 0)                           AS touches_fork_owned,
  touches_migrations,
  fork_pr, path, argus_verdict, merged_at, prod_pinned_at, skip_reason,
  CASE WHEN status = 'pending' THEN now() - created_at END     AS pending_age
FROM upstream_sync_log
ORDER BY id;
