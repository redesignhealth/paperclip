# Upstream sync: ledger, detector, classifier, alerts (P0)

Spec: upstream-sync process plan, revision 3. This is phase P0:
**no merging happens here.** The pipeline records, classifies and announces upstream
`paperclipai/paperclip` commits so later phases (worker loop, conflict path) have a queue.

Code: `tools/upstream-sync/` (Node >=24.11.0, matching
`packages/shared/src/node-version.ts`; one dependency: `pg`). Runtime dependencies
and Amazon RDS global CA bundle are baked into the Paperclip container image at
build time. Fork-owned path list:
`FORK_OWNED.md`. Requires **git >= 2.31** (`diff-tree --diff-merges=first-parent`).

## Branch model (TECH-8283)

`master` is the **only long-lived branch** in `redesignhealth/paperclip`. The previous permanent `integration` branch has been retired and archived at branch `archive/integration-2026-11-09` (tag `archive/integration-tip-tech-8283`).

Under the direct-to-master model, upstream sync PRs land directly into `master`:

- **Per-row flow:**
  1. Branch off fresh `origin/master`.
  2. Run `git merge <upstream_sha>` so `<upstream_sha>` is a git parent of the branch HEAD.
  3. **Diff split rule:** If the cumulative patch exceeds ~130,000 characters (to ensure Argus can review within payload bounds), split the change into a sequence of slice PRs targeting `master`. The merge of `<upstream_sha>` must be on the **LAST non-empty slice PR**; never create an empty-diff PR.
  4. Ensure both `ci-aggregate` and `argus-gate` are green on the **same HEAD commit**. Never push empty commits to retrigger Argus.
  5. No admin bypass without Dan's explicit approval.
  6. **Human merge:** A human merges the approved PR into `master` using a **merge commit** (`--no-ff`), **never squash or rebase** (squash/rebase destroys git ancestry and causes false regressions; see PR #293 and PR #302).
  7. **Ledger tracking (post-merge):**
     - While the PR is open and in review, the row remains in `in_review` (conflict path) or `assessed` / `claimed` (clean path) awaiting exact-head checks and human merge. Do not record as `integrated` before merge; direct trunk `verify` checks ancestry in `master` and will fail if the SHA is not yet merged.
     - Post-merge record: `record --status integrated --integration-sha <reviewed PR HEAD> --review-pr N [conflict args]` (`integration_sha` is the reviewed PR HEAD merge commit).
     - Promote: `promote --promote-pr N` (which detects `integration_sha` is an ancestor of `master`, advances the row to `promoted`, sets `promote_pr = N`, and records `master_sha` as the GitHub merge commit SHA on master), followed by `verify`.
     - In this direct-to-master model, rows transition through `integrated` to `promoted` in the same post-merge tracking run; there is **no separate promotion PR**.

## What runs

`node tools/upstream-sync/cli.mjs run` is the hourly job. In order:

1. **detect** (no LLM). Fetches upstream `master` into a blobless bare mirror, lists commits
   after the `upstream-synced` marker (first-parent order, oldest first) and inserts one
   `pending` row per commit. `ON CONFLICT (upstream_sha) DO NOTHING`, so re-runs add nothing.
   A merge commit is diffed against its **first parent only**, so a merged branch's older
   files are not attributed to the merge. The changed-file list for each commit is read from
   its own `git diff-tree` invocation (not from a shared stream), so no crafted file name can
   re-attribute another commit's files.
   Also stores the changed file list, flags `fork_owned_hits` (paths matching `FORK_OWNED.md`)
   and `touches_migrations` (`packages/db/src/migrations/`, `packages/db/src/schema/`),
   and links upstream reverts via `reverts_sha`.
2. **classify**. Rows with no `category` get one of `feature | fix | perf | security | infra |
   breaking` plus a one-line `summary`. Cheap model, 10 commits per call. If the model is
   unreachable, returns junk for a row, or has no API key, a deterministic heuristic fills
   the row (`classified_by = 'heuristic'`), so nothing stays unclassified and no alert is skipped.
   A heuristic `security`/`breaking` verdict is never downgraded by the model: the category is
   kept and `classified_by = 'heuristic(kept)+llm:<model>'` records that the model only
   supplied the summary.
3. **alert** per `feature | breaking | security` row, then **ops alerts**, then flush.

The whole locked section has a run budget (`UPSTREAM_SYNC_RUN_BUDGET_MS`, default 10 min).
Classify and alert/flush stop starting new work once it is exhausted; unclassified rows and
undelivered alerts stay queued and the run logs how many were deferred. Per-call timeouts
(`UPSTREAM_SYNC_HTTP_TIMEOUT_MS`) bound one request; the budget bounds the run.

## Ledger

The ledger lives in the instance's **Paperclip Postgres**. Its schema is owned by
Paperclip's Drizzle migration chain, not by this tool:

- Drizzle source: `packages/db/src/schema/upstream_sync.ts`
- Migration: `packages/db/src/migrations/0380_upstream_sync_ledger.sql`

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
  `status` (`pending|claimed|assessed|skipped|in_review|integrated|promoted|needs_human|failed`),
  `skip_reason`, `reverts_sha`, `alert_state`, `alerted_at`, `created_at`, `updated_at`, plus the
  worker columns from migration `0382` (below).
- `upstream_sync_state`: `upstream_synced_marker`, `detector_paused`, ops-alert episode flags.
- `upstream_sync_alerts`: alert outbox with a unique `dedup_key` (exactly-once enqueue;
  delivery is at-least-once — see Alerts).
- View `upstream_sync_log_view`: readable projection (short sha, URL, flags, pending age).
  `cli.mjs report` renders it as a markdown table for the doc view.

- `upstream_sync_events`: append-only audit trail (migration `0381`). One row per change to
  `upstream_sync_log`, written by the `upstream_sync_log_audit()` trigger, never by the tool:
  `operation` (`insert|update|delete`), `changed_columns[]`, `old_values` / `new_values` (changed
  columns only for an update, the full row for insert/delete), `old_status` / `new_status`,
  `actor` (`session_user`, i.e. the login that connected), `run_ref`, `application_name`,
  `created_at`. No-op updates and `updated_at`-only updates are not recorded. Migration `0381`
  also writes one baseline `insert` event (actor `migration:0381_baseline`) per row that already
  existed. Indexed on `(upstream_sha, id)`, `(new_status, id)` and `created_at`.
  The trigger is `SECURITY DEFINER`, so `upstream_sync_runner` needs only `SELECT` on this table;
  it can cause events but cannot forge, edit or delete them. A trigger also blocks UPDATE, DELETE
  and TRUNCATE for everyone, owner included (disable the trigger deliberately if you truly must).
  A worker should tag its work with `SET upstream_sync.run_ref = '<run issue id>'` per run so
  each event ties back to a Paperclip run.

- **Worker state on `upstream_sync_log` (migration `0382`, RED-583; updated for TECH-8283).** The detector only ever
  writes `pending` rows. The sync worker adds, per row: a claim/lease (`claimed_by` = Paperclip
  run id, `claimed_at`, `lease_expires_at`, `attempt`), the merge evidence (`integration_sha` —
  under TECH-8283, the PR head merge commit landing into master — `resolution_delta_sha256` —
  non-null exactly for a conflict resolution — `review_pr`, `promote_pr`, `master_sha`) and
  the review trail (`argus_verdict`, `argus_rounds`, an append-only jsonb array of
  `{round, sha, verdict, ...}`). Statuses and legal moves:

  ```
  pending -> claimed -> assessed -> integrated (clean path) -> promoted
                    \-> skipped      \-> in_review (conflict path) -> integrated
  any of claimed/assessed/in_review/integrated -> needs_human | failed
  claimed -> pending (release)       claimed -> claimed (extend, or reclaim after expiry)
  ```

  In the direct-to-master model (TECH-8283), rows remain in `in_review` (or `assessed`)
  while a PR is open awaiting exact-head checks and human merge. Once the PR merges to
  `master` with a merge commit, the row is recorded as `integrated` with `integration_sha`
  set to the reviewed PR head merge commit (which is now in master's ancestry). Then `promote`
  records `promote_pr` (the merged PR number) and `master_sha` (the merge commit on master)
  in the same post-merge run; no separate promotion branch or PR exists.

  Worker fields: `claimed_by` is the Paperclip run id holding the lease, `claimed_at` its start,
  `lease_expires_at` when another run may reclaim it (set exactly while `claimed`), `attempt` the
  claim count (starts at 0, +1 per claim or reclaim).

  Claim with one statement (`UPDATE ... WHERE id = (SELECT id ... WHERE status='pending' OR
  (status='claimed' AND lease_expires_at < now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)`
  setting `attempt = attempt + 1`); a crashed run is reclaimed after its lease, and the
  reclaim is an audited event. Row-level evidence is enforced by CHECK constraints (a lease
  exists exactly while `claimed`; `assessed`+ needs `path`; `integrated`+ needs `integration_sha`
  and a delta iff the path is `conflict`; `in_review` needs `review_pr`; `promoted` needs
  `promote_pr` and `master_sha`; `skipped` needs `skip_reason`; sha/hash formats). The
  `upstream_sync_log_guard` trigger enforces the rest: only the edges above; `id`/`upstream_sha`
  immutable; `attempt` moves only on a claim, by one; a live lease cannot be taken or shortened;
  evidence columns are write-once; `argus_rounds` is append-only; `promoted` and `skipped` rows
  are final apart from alert bookkeeping and `prod_pinned_at`; and an `integrated` conflict
  resolution needs `argus_verdict = 'approve'` with the last round approving that exact
  `integration_sha`. **Nothing leaves `needs_human`/`failed` without a human**: a login that is a
  member of the `upstream_sync_human` role (NOLOGIN, created by the migration) bypasses the
  guard, and the override is recorded in `upstream_sync_events` under that login. Note that
  every worker run shares the `upstream_sync_runner` login, so the guard cannot tell one run
  from another; per-run attribution is `upstream_sync.run_ref` in the events.

  **Re-pointing `integration_sha`** (migration 0387). A squash or a late ancestry PR can
  change which commit on `trunk` contains an upstream sha, and the write-once column
  would leave the row failing `verify`. The one sanctioned path is
  `cli.mjs repoint --sha <upstream> --new-sha <rev> --expect-old <current integration_sha> --reason "<why>"`.
  The tool checks git first: the new sha must descend from the old one, contain the upstream
  sha, and be on `trunk` (or already in master). The `upstream_sync_repoint_integration_sha()`
  function then writes an append-only `upstream_sync_integration_repoints` row (row id,
  upstream sha, old sha, new sha, actor, reason, run, time) and changes `integration_sha`
  and nothing else; the guard accepts the change only when that audit row came from the same
  transaction. It applies to a clean `integrated` row only: a conflict resolution's Argus
  verdict is bound to the old sha, so that stays a human override. The database cannot read
  git, so a caller that reaches the SQL function directly skips the ancestry check; it is
  still audited.
  The `upstream_sync_human` role is cluster-global. If the migration login lacks `CREATEROLE`, the
  migration continues with a NOTICE and the guard has no override until an operator runs
  `CREATE ROLE upstream_sync_human NOLOGIN;` and grants it to the human logins that may override.
  The rh-paperclip bootstrap `SELECT` grant on `upstream_sync_events` is redundant with the
  migration's grant and can be dropped.
  `TRUNCATE` on `upstream_sync_log` is blocked for everyone (a `BEFORE TRUNCATE` trigger), as
  it already is on events.

  Runner privileges (stated in the migration as well as in the rh-paperclip bootstrap script,
  and a no-op where the login does not exist): `SELECT, INSERT, UPDATE` on `upstream_sync_log`;
  `SELECT` only on `upstream_sync_events`; no `DELETE`/`TRUNCATE`/`TRIGGER`/`REFERENCES` on
  either; and it must not own either table (an owner can disable or drop the triggers). The
  migration aborts if the runner owns either table. The audit and guard functions have
  `EXECUTE` revoked from `PUBLIC`. `__tests__/worker-state.test.mjs` proves this against real
  logins: the runner cannot update/delete/truncate events, cannot `DISABLE TRIGGER`/`DROP
  TRIGGER`, cannot change ownership, and cannot defeat the guard.

These tables are **global** (no `company_id`) and are intentionally not RLS targets:
the ledger is instance-level metadata, so there is no tenant whose rows could leak
into another tenant. Access control is at the Postgres role level, not the row level:
production runs use the restricted `upstream_sync_runner` login from step 1 below,
which reaches only these three tables and the view — not the application role. The
read surface for humans and agents is the CLI's `status`, `view` and `report`
commands (`report` renders `upstream_sync_log_view` as a markdown table).

## Alerts

One setting picks the destination: `UPSTREAM_SYNC_ALERT_CHANNEL` (default `#eng`).
`UPSTREAM_SYNC_ALERT_SINK` selects how it is delivered. Text derived from upstream commit
fields is untrusted and is **escaped per sink at render time**: the Slack payload HTML-escapes
`& < >` (and disables link/media unfurls, so URLs in commit text are never previewed), the
Paperclip comment body neutralizes `user://`/`agent://`/… and `@name` mention syntax, and the
outbox/stdout text is neutralized the same way before it is printed — the stored payload keeps
the raw text, and `alerts pending` re-renders it. `cli.mjs report` escapes backslashes, pipes,
CR and newlines in the model's summary so a crafted commit cannot break out of its table cell.

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
| `UPSTREAM_SYNC_DATABASE_URL` (or `DATABASE_URL`) | none, required | the instance's Paperclip Postgres |
| `UPSTREAM_SYNC_UPSTREAM_REPO` | `https://github.com/paperclipai/paperclip.git` | |
| `UPSTREAM_SYNC_BRANCH` | `master` | |
| `UPSTREAM_SYNC_MIRROR_DIR` | `~/.cache/upstream-sync/mirror.git` | bare mirror, safe to delete |
| `UPSTREAM_SYNC_INITIAL_MARKER` | `898144f4b…` (catch-up #191) | used until a marker is stored |
| `UPSTREAM_SYNC_FORK_OWNED_FILE` | `<repo>/FORK_OWNED.md` | |
| `UPSTREAM_SYNC_LLM_BASE_URL` / `_MODEL` / `_API_KEY` | OpenAI-compatible, `gpt-4o-mini`, falls back to `OPENAI_API_KEY` | classifier |
| `UPSTREAM_SYNC_HTTP_TIMEOUT_MS` | `30000` | abort LLM + webhook calls; a timed-out LLM call falls back to the heuristic, a timed-out delivery is retried next flush |
| `UPSTREAM_SYNC_RUN_BUDGET_MS` | `600000` (10 min) | cap on the whole locked run; remaining work is deferred to the next run |
| `UPSTREAM_SYNC_TRUNK_REF` | `refs/remotes/origin/master` | worker landing trunk ref (direct-to-master); replaces deprecated `UPSTREAM_SYNC_INTEGRATION_REF` |
| `UPSTREAM_SYNC_INTEGRATION_REF` | none | deprecated alias for `UPSTREAM_SYNC_TRUNK_REF` (kept for compatibility) |
| `UPSTREAM_SYNC_MASTER_REF` | `refs/remotes/origin/master` | worker production master ref |
| `UPSTREAM_SYNC_REPO_DIR` | `process.cwd()` | repository directory for worker git operations |
| `UPSTREAM_SYNC_ARGUS_ROUND_CAP` | `10` | non-approving rounds before moving row to `needs_human` |
| `UPSTREAM_SYNC_LEASE_MINUTES` | `15` | worker claim lease duration |
| `UPSTREAM_SYNC_ALERT_*`, `UPSTREAM_SYNC_SLACK_WEBHOOK_URL` | see Alerts | |

## Production deployment: Scheduled ECS Fargate Task (TECH-9777)

The hourly upstream-sync detector runs as a scheduled ECS Fargate task in AWS,
defined and managed in [redesignhealth/infra#397](https://github.com/redesignhealth/infra/pull/397).
The earlier in-agent Kubernetes sandbox pod routine was retired because sandbox
pods lack egress to public npm registries and Amazon RDS CA host truststores.

The task runs the standard Paperclip production container image within the
Paperclip ECS task security group (granting port 5432 ingress to the RDS instance)
with NAT egress (enabling outbound access to GitHub and LLM provider endpoints).

The container executes:

```sh
node tools/upstream-sync/cli.mjs run
```

directly against the ledger DB using the restricted `upstream_sync_runner` DB role.

### 1. Credentials and Environment Configuration

Task credentials and configuration are provisioned in AWS Secrets Manager / SSM
Parameter Store via [redesignhealth/infra#397](https://github.com/redesignhealth/infra/pull/397),
injected directly into the container definition. No Paperclip company secrets or
sandbox routines are required.

| Environment / Secret | Source | Purpose |
|---|---|---|
| `UPSTREAM_SYNC_DATABASE_URL` | SSM `/paperclip/prod/UPSTREAM_SYNC_DATABASE_URL` | DSN for `upstream_sync_runner` role with `sslmode=require` |
| `UPSTREAM_SYNC_LLM_API_KEY` | SSM `/paperclip/prod/UPSTREAM_SYNC_LLM_API_KEY` | Dedicated OpenAI-compatible key for commit classification |
| `UPSTREAM_SYNC_ALERT_SINK` | plain `slack-webhook` | Alert sink for newly classified upstream commits |
| `UPSTREAM_SYNC_SLACK_WEBHOOK_URL` | SSM `/paperclip/prod/UPSTREAM_SYNC_SLACK_WEBHOOK_URL` | Slack incoming webhook URL for alert delivery |
| `UPSTREAM_SYNC_MIRROR_DIR` | plain `/tmp/upstream-sync/mirror.git` | Writable cache path for the git mirror on ephemeral volume |
| `UPSTREAM_SYNC_RDS_CA` | optional | Override path for CA bundle; defaults to baked `/app/tools/upstream-sync/global-bundle.pem` |
| `UPSTREAM_SYNC_RDS_TRUST` | optional `true`/`false` | Explicit opt-in for fail-closed RDS verified TLS on aliases/CNAMEs |

Note: The public upstream repository (`paperclipai/paperclip.git`) requires no credentials to clone.
The git mirror cache path **must** be set to a writable directory (`/tmp/upstream-sync/mirror.git`),
as the container root `/app` filesystem is read-only at runtime.

#### Database Role (`upstream_sync_runner`)

Production roles are bootstrapped using `scripts/upstream-sync-bootstrap-role.sh`
from `redesignhealth/rh-paperclip` (PR redesignhealth/rh-paperclip#201) inside a
one-off bootstrap ECS task. The role requires migration `0380_upstream_sync_ledger.sql`
to be applied first.

Privileges granted:
- `CONNECT` on database `paperclip` and `USAGE` on schema `public`.
- Append/update on ledger tables:
  - `SELECT, INSERT, UPDATE` on `upstream_sync_log` and `upstream_sync_alerts`
  - `SELECT, INSERT, UPDATE, DELETE` on `upstream_sync_state`
  - `USAGE, SELECT` on bigserial sequences (`upstream_sync_log_id_seq`, `upstream_sync_alerts_id_seq`)
  - `SELECT` on `upstream_sync_log_view`
- No `CREATE`, `DROP`, or access to other tenant/application tables.

### 2. Verified RDS TLS and CA Bundle Build Hash Rotation

The Paperclip Docker image bakes the Amazon RDS global root CA bundle at build time
from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` with pinned
SHA-256 digest `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`.

Strict fail-closed TLS verification is enforced in `tools/upstream-sync/lib/db.mjs`:
- Active for all `*.rds.amazonaws.com` hostnames or when `UPSTREAM_SYNC_RDS_TRUST=true`.
- Any insecure or downgrade SSL mode (`disable`, `allow`, `prefer`, `no-verify`, `false`) throws an immediate fail-closed error.
- All SSL URL query parameters are stripped before passing to `node-postgres` to prevent parameter overrides.
- Certificates are verified against the baked CA bundle with `rejectUnauthorized: true` and SNI hostname verification (`servername: host`).
- Non-RDS database connections without explicit RDS trust preserve native `pg` TLS / CA / mTLS semantics untouched.

**CA Bundle Rotation Procedure**:
If Amazon rotates the global root CA bundle:
1. Update the URL and pinned SHA-256 digest in `Dockerfile`.
2. Run scoped tests in `tools/upstream-sync` (`npm test`) to verify digest matching.
3. The next image build automatically bundles the updated certificates. In an emergency, operators can override the CA bundle path at runtime via `UPSTREAM_SYNC_RDS_CA` without an image rebuild.

### 3. Safe Rollout with Disabled Schedule

In [redesignhealth/infra#397](https://github.com/redesignhealth/infra/pull/397), the EventBridge
schedule rule is deployed **disabled** (`state = "DISABLED"`). This prevents the task from firing
automatically before the one-off backlog load is verified, preventing mass alert spam across hundreds
of older commits. Enable the schedule only after the backlog load verifies below.

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

3. **Drain the outbox by hand — all of it**, so the suppressed-feature and ops
   alerts do not fire later against RED-544 (the per-run cap already collapses the
   overflow into one digest, but the outbox still fills up).

   A single `alerts ack <id>` is **not** enough. A 280-row backfill emits several
   per-row feature alerts, one overflow digest, and the ops alerts, so the outbox
   holds multiple unrelated ids; acking one leaves the rest to fire on the next
   flush. `alerts pending` prints JSON, so pull the ids out and ack each, repeating
   until nothing is pending:

   ```sh
   node cli.mjs alerts pending
   # then, for the ids it printed:
   node cli.mjs alerts pending \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s))console.log(r.id)})' \
     | while read -r id; do node cli.mjs alerts ack "$id" backlog-load; done
   node cli.mjs alerts pending   # must print [] before you continue
   ```

   If that last `alerts pending` prints anything other than `[]`, repeat the loop
   before going on to the verification step.

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

5. **Enable the schedule trigger** in [redesignhealth/infra#397](https://github.com/redesignhealth/infra/pull/397) (set EventBridge rule state to ENABLED) only after step 4 verifies.

## Day-to-day runbook

Run from `tools/upstream-sync` (or in container: `cd /app/tools/upstream-sync`).

- Look: `node cli.mjs status` (counts, marker, paused flag, undelivered alerts) or `node cli.mjs report`.
- **Pause the detector**: `node cli.mjs pause`. Existing rows are still classified and alerted by `run`;
  no new rows are inserted. **Resume**: `node cli.mjs resume`. To stop everything, pause the schedule itself.
- **Move the marker**: `node cli.mjs marker set <sha>` (validated against upstream; must exist). The stored
  marker overrides `UPSTREAM_SYNC_INITIAL_MARKER`. Moving it forward skips the commits in between (they are not
  inserted). Moving it backward re-inserts only commits not already in the ledger. In P1+ the worker advances the
  marker only to the highest SHA where every earlier row is `promoted` or `skipped`; do not move it by hand while
  the worker is running. The detector refuses to run if the marker is not an ancestor of upstream `master`
  (force-push); fix with `marker set`.
- **Detector failed with "malformed git log record"**: the run fails closed rather than skipping a
  commit (a skipped commit would never be inserted, since the marker only moves forward). Nothing was
  inserted. Re-run first; if the range is genuinely unparseable, step past it deliberately with
  `marker set <sha>` — that skips the commits in between, so prefer fixing the cause.
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
- `__tests__/schema-parity.test.mjs` applies `schema.sql` and migration 0380 to two separate schemas and
  asserts their columns, constraints, indexes and view columns/definition match, so the fixture cannot
  silently drift from the production schema.

Schema changes go through `packages/db` (Drizzle + a new migration), never through `schema.sql`: update the
Drizzle schema, regenerate, then bring the fixture and parity test back in line.
