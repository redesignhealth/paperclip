# Upstream sync: ledger, detector, classifier, alerts (P0)

Spec: upstream-sync process plan, revision 3. This is phase P0:
**no merging happens here.** The pipeline records, classifies and announces upstream
`paperclipai/paperclip` commits so later phases (worker loop, conflict path) have a queue.

Code: `tools/upstream-sync/` (Node >=24.11.0, matching
`packages/shared/src/node-version.ts`; one dependency: `pg`). Fork-owned path list:
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

The ledger lives in the instance's **Paperclip Postgres**. Its schema is owned by
Paperclip's Drizzle migration chain, not by this tool:

- Drizzle source: `packages/db/src/schema/upstream_sync.ts`
- Migration: `packages/db/src/migrations/0379_upstream_sync_ledger.sql`

Apply it the same way as any other Paperclip migration
(`pnpm --filter @paperclipai/db migrate`, or just start the app so boot applies
pending migrations). It is in the migration journal, so boot, `check:migrations`
and the migration-snapshot drift test all cover it. `tools/upstream-sync/schema.sql`
is now **only** the fixture for `__tests__/db.test.mjs`; `cli.mjs migrate` writes no
DDL and simply verifies the tables and view exist. `__tests__/schema-parity.test.mjs`
fails if the fixture and the migration drift.

Tables:

- `upstream_sync_log`: the queue. `id` is assigned in upstream order. Columns: `upstream_sha`
  (unique), `upstream_pr`, `title`, `body`, `author`, `files[]`, `upstream_merged_at`,
  `category`, `summary`, `classified_by`, `fork_owned_hits[]`, `touches_migrations`,
  `fork_pr`, `path` (`clean|conflict`), `argus_verdict`, `merged_at`, `prod_pinned_at`,
  `status` (`pending|in_progress|merged|skipped|conflict|needs-human|reverted`), `skip_reason`,
  `reverts_sha`, `alert_state`, `alerted_at`, `created_at`, `updated_at`.
- `upstream_sync_state`: `upstream_synced_marker`, `detector_paused`, ops-alert episode flags.
- `upstream_sync_alerts`: alert outbox with a unique `dedup_key` (exactly-once alerting).
- View `upstream_sync_log_view`: readable projection (short sha, URL, flags, pending age).
  `cli.mjs report` renders it as a markdown table for the doc view.

These tables are **global** (no `company_id`) and are intentionally not RLS targets:
the ledger is instance-level metadata, so there is no tenant whose rows could leak
into another tenant. Access control is at the Postgres role level, not the row level:
production runs use the restricted `upstream_sync_runner` login from step 1 below,
which reaches only these three tables and the view — not the application role. The
read surface for humans and agents is the CLI's `status`, `view` and `report`
commands (`report` renders `upstream_sync_log_view` as a markdown table).

## Alerts

One setting picks the destination: `UPSTREAM_SYNC_ALERT_CHANNEL` (default `#eng`).
`UPSTREAM_SYNC_ALERT_SINK` selects how it is delivered:

| sink | behaviour |
|---|---|
| `outbox` (default) | record only; read with `alerts pending`, mark with `alerts ack <id>` |
| `slack-webhook` | POST `{channel, text}` to `UPSTREAM_SYNC_SLACK_WEBHOOK_URL` |
| `paperclip-comment` | comment on issue `UPSTREAM_SYNC_ALERT_ISSUE_ID` via the Paperclip API (interim until Slack is connected) |
| `stdout` | print (testing) |

Exactly one alert per row (`dedup_key = row:<sha>`). To avoid flooding the channel on a large
backlog load, at most `UPSTREAM_SYNC_ALERT_MAX_PER_RUN` (default 10) per-row alerts go out per run; the rest
are collapsed into one digest and marked `alert_state = 'suppressed'` (still visible in the view).
In P1 the alert moves from classification time to merge time.

Ops alerts are edge-triggered (one alert when a condition starts, re-armed when it clears):
queue depth `> UPSTREAM_SYNC_QUEUE_DEPTH_MAX` (default 40) and oldest `pending` older than
`UPSTREAM_SYNC_OLDEST_PENDING_HOURS_MAX` (default 48).

## Configuration (environment)

| variable | default | meaning |
|---|---|---|
| `UPSTREAM_SYNC_DATABASE_URL` (or `DATABASE_URL`) | none, required | the instance's Paperclip Postgres |
| `UPSTREAM_SYNC_UPSTREAM_REPO` | `https://github.com/paperclipai/paperclip.git` | |
| `UPSTREAM_SYNC_BRANCH` | `master` | |
| `UPSTREAM_SYNC_MIRROR_DIR` | `~/.cache/upstream-sync/mirror.git` | bare mirror, safe to delete |
| `UPSTREAM_SYNC_INITIAL_MARKER` | `898144f4b…` (catch-up #191) | used until a marker is stored |
| `UPSTREAM_SYNC_FORK_OWNED_FILE` | `<repo>/FORK_OWNED.md` | |
| `UPSTREAM_SYNC_LLM_BASE_URL` / `_MODEL` / `_API_KEY` | OpenAI-compatible, `gpt-4o-mini`, falls back to `OPENAI_API_KEY` | classifier |
| `UPSTREAM_SYNC_ALERT_*`, `UPSTREAM_SYNC_SLACK_WEBHOOK_URL` | see Alerts | |

## Routine setup (one-off runbook)

The hourly job runs as a Paperclip **routine** on an ops/CTO agent, not as a
hand-rolled cron on a box. The secrets below come first, then one routine.

### 1. Three company secrets: a restricted DB login, a classifier key, a repo read token

Create all three in the company that owns the routine (Secrets -> company scope).
The routine binds them by `secretId` as `secret_ref` env values, so no value is
ever pasted into a routine body or a run log.

| secret key | what it holds |
|---|---|
| `UPSTREAM_SYNC_DATABASE_URL` | the DSN of the **restricted** login below, including its password |
| `UPSTREAM_SYNC_LLM_API_KEY` | an OpenAI-compatible classifier key |
| `UPSTREAM_SYNC_GIT_TOKEN` | a **read-only** credential for `redesignhealth/paperclip` |

`redesignhealth/paperclip` is a **private** repo, so the bootstrap checkout needs
a credential. Use either a fine-grained GitHub token scoped to
`redesignhealth/paperclip` only with `contents: read`, or a deploy key for that
repo with read access. Nothing wider: this token can read the fork's source and
nothing else.

Keep it distinct from the upstream mirror. `UPSTREAM_SYNC_UPSTREAM_REPO`
(`paperclipai/paperclip`) is a **public** repo, so the hourly detect step's mirror
fetch needs no credential at all. `UPSTREAM_SYNC_GIT_TOKEN` is only ever used by
the one-off bootstrap below.

A `secret_ref` protects how the value is *stored*. It does not limit what the
routine's process can *do* once it is running, so the login in the DSN is the
real privilege boundary. Give this routine its own Postgres login that can reach
nothing but the three ledger tables and the read view.

#### Create the restricted login (`upstream_sync_runner`)

```sql
CREATE ROLE upstream_sync_runner LOGIN PASSWORD '<generate-and-store-as-the-secret>';

GRANT CONNECT ON DATABASE <paperclip_database> TO upstream_sync_runner;
GRANT USAGE  ON SCHEMA public TO upstream_sync_runner;

-- the three ledger tables
GRANT SELECT, INSERT, UPDATE, DELETE ON upstream_sync_log    TO upstream_sync_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON upstream_sync_state  TO upstream_sync_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON upstream_sync_alerts TO upstream_sync_runner;

-- the sequences behind their bigserial ids
GRANT USAGE, SELECT ON SEQUENCE upstream_sync_log_id_seq    TO upstream_sync_runner;
GRANT USAGE, SELECT ON SEQUENCE upstream_sync_alerts_id_seq TO upstream_sync_runner;

-- the read surface used by `cli.mjs view|report`
GRANT SELECT ON upstream_sync_log_view TO upstream_sync_runner;
```

The view is not `security_invoker`, so Postgres evaluates it with the view owner's
privileges: the `SELECT` on the view above is what makes `view`/`report` work, and
it would keep working even without the table grant. `upstream_sync_runner` reaches
no other company's rows because it has no privilege on any other table — `issues`
and every other app table are denied to it.

This needs a Postgres that supports role management (managed Postgres, or a
self-hosted instance where you can run the statements). **The embedded dev
database has no extra roles**, so on dev the routine falls back to the
application DSN (`DATABASE_URL`) — dev only, never production.

> **Warning — application role in production.** Pointing
> `UPSTREAM_SYNC_DATABASE_URL` at the application DSN in production gives the
> routine process the application's full cross-tenant read access to every
> table. That is an instance-wide grant made for the life of every run, not a
> per-query restriction. Choosing it must be a deliberate, recorded decision
> (note it in the routine or issue), never the default path.

Use a dedicated classifier key rather than a general `OPENAI_API_KEY` so the
secret can be rotated or revoked without touching anything else.

### 2. Create the routine

On the ops/CTO agent, create a routine `upstream-sync: hourly detect, classify, alert` with:

- `concurrencyPolicy: "skip_if_active"` — a slow run must not stack up.
- `catchUpPolicy: "skip_missed"` — a missed hour is not replayed; the detector
  reads from the stored marker, so the next run picks the gap up anyway.
- `activityGatePolicy: "always"` — this is infrastructure upkeep, not work that
  should be gated on company activity.
- env bindings:
  - `UPSTREAM_SYNC_DATABASE_URL` -> `secret_ref` (the DSN secret above)
  - `UPSTREAM_SYNC_LLM_API_KEY` -> `secret_ref` (the classifier key above)
  - `UPSTREAM_SYNC_GIT_TOKEN` -> `secret_ref` (the read-only repo token above; bootstrap only)
  - `UPSTREAM_SYNC_ALERT_SINK` -> plain `paperclip-comment`
  - `UPSTREAM_SYNC_ALERT_ISSUE_ID` -> plain issue identifier, e.g. `RED-544`
  - `UPSTREAM_SYNC_MIRROR_DIR` -> plain path inside the agent workspace, e.g. `.cache/upstream-sync/mirror.git`
- a `schedule` trigger: `cronExpression: "0 * * * *"`, `timezone: "UTC"`.

**Do not bind `PAPERCLIP_API_KEY`.** The harness mints and injects the run token
per run, and a user or routine binding for it is stripped before the run env is
built (see `FORBIDDEN_ENV_BINDING_KEYS` in
`server/src/services/heartbeat/run-preparation.ts`), so a binding there is a
silent no-op that looks like it should work. `PAPERCLIP_API_URL` is not forbidden
— it is resolved at runtime from the server's configured base URL, so leave it
unbound as well. `paperclip-comment` uses the harness-injected values, which is
why the sink works with no explicit binding.

### 3. Routine description (self-bootstrapping)

The description carries the bootstrap step, mirroring
`server/src/services/default-kb-ingest-routine.ts`: the agent fetches
`tools/upstream-sync` **and** the root `FORK_OWNED.md` at a pinned SHA into a
checkout of its own on first run, so the routine does not depend on a
pre-existing workspace. Paste this as the routine description, replacing the
`<PINNED_SHA>` placeholder before you save, and bumping it when the tool changes.

`<PINNED_SHA>` **must** be a commit on `master` at or after the merge of this
change — the commit that adds `packages/db/src/migrations/0379_upstream_sync_ledger.sql`
and the verify-only `cli.mjs migrate`. An older commit has the old `migrate`, which
writes DDL, and the old single-key advisory lock. The DDL fails under the
restricted `upstream_sync_runner` login (no `CREATE` privilege), and the single-key
lock can collide with Paperclip's own locks. The bootstrap checks this after
checkout and stops if it does not hold.

Both paths are required: `loadForkOwnedMatcher()` reads
`forkOwnedFile`, which `loadConfig()` defaults to
`path.resolve(<tools/upstream-sync/lib>, "../../../FORK_OWNED.md")` — i.e. the
repository root — and `cli.mjs reflag` calls it. A checkout that contains only
the tool throws `ENOENT` on `reflag`.

`redesignhealth/paperclip` is private, so the fetch authenticates with the
read-only `UPSTREAM_SYNC_GIT_TOKEN` from step 1, passed as a request header
rather than written into the remote URL, the config, or a log. The upstream
mirror (`paperclipai/paperclip`) is public and needs no credential; do not reuse
this token for it.

```
Hourly upstream-sync run for paperclipai/paperclip. Checkout dir: this agent's
own workspace, under `upstream-sync` (create if missing). Never merge anything;
this tool only records, classifies and announces upstream commits.

1. Node guard. Run `node --version`. If it is older than 24.11.0 (the
   MINIMUM_NODE_VERSION in packages/shared/src/node-version.ts), comment on the
   run issue with the version you saw and this requirement, then stop. Do not
   attempt install, `npm ci`, or `cli.mjs` on an unsupported runtime.
2. Bootstrap (first run only). If `<checkout>/tools/upstream-sync/cli.mjs` does
   not exist, fetch the pinned tree into `<checkout>`. The sparse checkout must
   include BOTH `tools/upstream-sync` and the root `FORK_OWNED.md`. This repo is
   private, so the fetch authenticates with `UPSTREAM_SYNC_GIT_TOKEN`:

     mkdir -p <checkout> && cd <checkout>
     git init -q
     git remote add origin https://github.com/redesignhealth/paperclip.git
     git config core.sparseCheckout true
     printf '%s\n' '/FORK_OWNED.md' '/tools/upstream-sync/' > .git/info/sparse-checkout
     git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$UPSTREAM_SYNC_GIT_TOKEN" | base64 | tr -d '\n')" \
       fetch --depth 1 --filter=blob:none origin <PINNED_SHA>
     git checkout --detach <PINNED_SHA>
     git rev-parse HEAD   # must print the full pinned SHA

   Never put the token in a remote URL, in `.git/config`, or in a log; the
   `-c http.extraHeader` form above keeps it out of all three. If
   `UPSTREAM_SYNC_GIT_TOKEN` is unset or the fetch is denied, comment on the run
   issue and stop rather than guessing.

   Then enforce the pin's minimum. `<PINNED_SHA>` must be a commit on `master` at
   or after the merge of the upstream-sync ledger change (the commit that adds
   `packages/db/src/migrations/0379_upstream_sync_ledger.sql` and the
   verify-only `migrate`). Check for it directly:

     grep -q UPSTREAM_SYNC_LOCK_NAMESPACE tools/upstream-sync/lib/db.mjs

   If that grep fails, the pinned commit predates the change: its `migrate` would
   write DDL (denied for the restricted login) and its run lock would be the old
   single-key form. Comment on the run issue with that reason and stop; do not
   work around it. If `rev-parse HEAD` does not print `<PINNED_SHA>`, comment and
   stop the same way.
3. From `<checkout>/tools/upstream-sync` (not `<checkout>`): `npm ci`.
4. From the same directory: `node cli.mjs migrate` to confirm the ledger schema
   is present. It writes no DDL; if it reports missing tables, the Paperclip
   migrations have not run and you should comment on the run issue and stop.
5. From the same directory: `node cli.mjs run`.
6. Comment the JSON result on the run issue only when something is notable
   (rows inserted, classifications failed, alerts failed); a quiet run closes
   with one line.
```


### 4. Enable the schedule

**Leave the schedule trigger disabled until the backlog load below verifies.**
Then enable it. Enabling earlier would alert on hundreds of backfilled rows at
once.

## Backlog load (one-off runbook)

Run this once, deliberately, before the schedule is enabled. It backfills every
upstream commit since the catch-up marker and deliberately suppresses per-row
alert spam.

1. **Move the marker back** to the fork point so the detector re-inserts the
   backlog. Rows already in the ledger are untouched (`ON CONFLICT DO NOTHING`).

   ```sh
   node cli.mjs marker set 898144f4b3025ecca5ce7907069e19660298bf7b
   ```

2. **Load with the outbox sink**, so nothing is posted anywhere:

   ```sh
   UPSTREAM_SYNC_ALERT_SINK=outbox node cli.mjs run
   ```

3. **Drain the outbox by hand** and ack it, so the suppressed-feature and ops
   alerts do not fire later against RED-544 (the per-run cap already collapses the
   overflow into one digest, but the outbox still fills up):

   ```sh
   node cli.mjs alerts pending
   node cli.mjs alerts ack <id> backlog-load
   ```

4. **Verify the load** in the ledger:

   ```sql
   SELECT category, count(*) FROM upstream_sync_log GROUP BY 1 ORDER BY 2 DESC;
   ```

   Expected shape at the time of writing: **280 rows total** — 127 fix, 58 perf,
   53 feature, 37 infra, 5 security, 0 breaking.

   **Drift is expected and is not a failure.** Upstream has gained commits since
   that count was taken, and LLM classification is not deterministic. Accept:

   - an **exact total for rows up to the original HEAD SHA** (the marker's
     commit set is immutable, so the row count for that range should match), and
   - **± a few per category**, since a borderline commit can land in `fix` instead
     of `perf` across runs.

   If the total for the pinned range is off by more than a rounding error, or a
   category is empty where it should not be, stop and investigate before enabling
   the schedule.

5. **Enable the schedule trigger** only after step 4 verifies.

## Day-to-day runbook

Run from `<checkout>/tools/upstream-sync` (`cd <checkout>/tools/upstream-sync && npm ci`).

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
- A Postgres advisory lock (a two-key lock in this tool's own namespace) stops overlapping runs; a second
  concurrent run exits immediately.

## Tests

`cd tools/upstream-sync && npm test`. The DB tests need a scratch Postgres:
`UPSTREAM_SYNC_TEST_DATABASE_URL=postgres://… npm test` (they truncate the ledger tables, never point it at
the real ledger). Without the variable the DB tests are skipped.

- `__tests__/db.test.mjs` exercises the pipeline against `schema.sql` (the test fixture).
- `__tests__/migrate-cli.test.mjs` covers `cli.mjs migrate`: exit 0 when the tables and view exist, exit 1
  with a pointer at the Paperclip migrations when they do not, and no DDL written either way (each test uses
  its own throwaway schema).
- `__tests__/schema-parity.test.mjs` applies `schema.sql` and migration 0379 to two separate schemas and
  asserts their columns, constraints, indexes and view columns/definition match, so the fixture cannot
  silently drift from the production schema.

Schema changes go through `packages/db` (Drizzle + a new migration), never through `schema.sql`: update the
Drizzle schema, regenerate, then bring the fixture and parity test back in line.
