-- TEST FIXTURE ONLY. This is NOT the production schema.
--
-- The upstream-sync ledger's real schema is owned by Paperclip's Drizzle
-- migration chain: packages/db/src/schema/upstream_sync.ts plus
-- packages/db/src/migrations/0380_upstream_sync_ledger.sql (+ 0381 events, 0382 worker state). Embedded-PG dev
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
                      CHECK (status IN ('pending','claimed','assessed','skipped','in_review','integrated','promoted','needs_human','failed')),
  skip_reason         text,
  reverts_sha         text,                         -- upstream revert linked to original
  alert_state         text        CHECK (alert_state IN ('sent','suppressed')),
  alerted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Worker claim/lease and merge evidence (migration 0382, RED-583).
  claimed_by          text,                         -- Paperclip run id holding the lease
  claimed_at          timestamptz,
  lease_expires_at    timestamptz,                  -- non-null exactly while status = 'claimed'
  attempt             integer     NOT NULL DEFAULT 0,
  integration_sha     text,                         -- merge commit on `integration`
  resolution_delta_sha256 text,                     -- non-null iff the merge needed a conflict resolution
  review_pr           integer,                      -- Argus review PR for the resolution
  promote_pr          integer,                      -- human-merged integration -> master PR
  master_sha          text,
  argus_rounds        jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- append only
  CONSTRAINT upstream_sync_log_attempt_check CHECK (attempt >= 0),
  CONSTRAINT upstream_sync_log_claim_check CHECK ((status = 'claimed' and claimed_by is not null and claimed_at is not null and lease_expires_at is not null) or (status <> 'claimed' and lease_expires_at is null)),
  CONSTRAINT upstream_sync_log_integration_sha_check CHECK (integration_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT upstream_sync_log_master_sha_check CHECK (master_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT upstream_sync_log_delta_sha256_check CHECK (resolution_delta_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT upstream_sync_log_pr_numbers_check CHECK ((review_pr is null or review_pr > 0) and (promote_pr is null or promote_pr > 0)),
  CONSTRAINT upstream_sync_log_argus_rounds_check CHECK (jsonb_typeof(argus_rounds) = 'array'),
  CONSTRAINT upstream_sync_log_state_path_check CHECK (status not in ('assessed', 'in_review', 'integrated', 'promoted') or path is not null),
  CONSTRAINT upstream_sync_log_state_integrated_check CHECK (status not in ('integrated', 'promoted') or (integration_sha is not null and (path = 'conflict') = (resolution_delta_sha256 is not null))),
  CONSTRAINT upstream_sync_log_state_promoted_check CHECK (status <> 'promoted' or (promote_pr is not null and master_sha is not null)),
  CONSTRAINT upstream_sync_log_state_review_check CHECK (status <> 'in_review' or review_pr is not null),
  CONSTRAINT upstream_sync_log_state_skipped_check CHECK (status <> 'skipped' or skip_reason is not null)
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
