# Company Memory Lifecycle CLI (TECH-8191)

Operator reference for the live agent-scoped Mem0 migration. For a non-localhost target, pass `--prod` and set `MEMORY_UPGRADE_ALLOW_PROD=1`. Host locality is not proof that a database is non-production.

Confirmed mutations require `--confirm <company-uuid>`, matching `--company` when both are supplied. Without confirmation, commands that support dry runs produce a read-only preview. Reports support `--output`/`--out` and `--format text|json`.

| Command | Purpose | Writes? | Requires `--confirm` | Dry-run support | Key flags | Refusal conditions |
| --- | --- | --- | --- | --- | --- | --- |
| `census` | Inspect legacy rows, routing, and conversion budget. | No; read-only. | No. | Read-only by definition; no `--dry-run`. | `--database-url`, `--company`, `--control-plane-url`, `--table`, `--long-threshold`, `--prod`. | Missing DSN; invalid target/table; production safety gate. |
| `sweep` | Convert legacy rows, embed them, and record ledger/staging outcomes; live collection is `SELECT`-only. | Yes: ledger, staging, counters; no live rows. Uses the company's OpenAI key. | Yes; IDs must match. | No `--dry-run`. | `--model`, `--openai-key-file`, `--max-rows`, `--max-cost-usd`, rate limits, pause flags, `--operator-label`, `--prod`. | Missing/mismatched IDs or DSNs; lease, routing, budget, converter, or preflight failure. |
| `publish` | Publish converted staging rows to the live collection. | Yes: live insert and staging `published_at` in one transaction. | Yes. | Yes, `--dry-run`. | `--batch-sources`, `--max-rows`, `--page-size`, pause flags, `--prod`. | Malformed staging; source, tenant-fence, schema/vector, state, or lease failure. |
| `flip` | Set the company marker and advance `sweeping` through `flipping` to `draining`. | Yes: marker, state, counters. | Yes, plus `--ack-agent-scope-flag`. | Yes, `--dry-run`. | `--ack-agent-scope-flag`, `--mode copy`, `--probe-limit`, `--prod`. | Outstanding publishable source; state/marker, mode, preflight, lease, or fence failure. Acknowledgment is not proof. |
| `drain` | Establish post-flip quiescence evidence; it does not run a sweep. | Yes when confirmed: probe streak/confirmation evidence. | Yes. | Yes, `--dry-run`; `--once` runs one iteration. | `--max-drain-hours`, `--probe-interval-minutes` (minimum 10), `--probe-limit`, `--blocking-run-limit`, `--once`, `--prod`. | Missing observation, pending work, missing-scope rows, unfinished pre-flip runs, competing lease, or timeout. Timeout leaves `draining`. |
| `verify` | Apply completeness gates and advance `draining` to `verified`. | Yes when gates pass: timestamp/state/counters. | Yes. | Yes, `--dry-run`. | `--allow-quarantined`, `--probe-limit`, `--blocking-run-limit`, `--prod`. | Failed gate, including pending publish, probe blockers, quarantines (unless explicitly allowed), or lease conflict. |
| `rollback` | Clear marker and revert/terminate the upgrade state. | Yes: marker/state/lease; never deletes live rows. | Yes. | Yes, `--dry-run`. | `--table`, `--prod`. | `sweeping`, `needs_recovery`, or `pruning`/`completed`; refused once pruning starts. |
| `recover` | Recover `needs_recovery` to recorded prior state and release the lease. | Yes, atomically: state/error/lease. Never changes marker. | Yes. | Yes, `--dry-run`. | `--control-plane-url`, `--prod`. | State is not `needs_recovery`, deletion admission fails, invalid recovery target, or lease/CAS conflict. |
| `export` | Export converted memories for a single agent from tenant staging to JSONL and manifest files for `rh-memory-mcp` import. | No DB writes; writes external files only with `--confirm`. | Yes (`--confirm <company-uuid>`). | Yes (default is dry run). | `--company`, `--agent`, `--upgrade-id`, `--output-dir`, `--confirm`, `--database-url`, `--control-plane-url`, `--format`, `--table`, `--prod`. | Needs recovery, terminal state aborted, missing staging/ledger tables, unknown agent or non-hermes_local / terminated agent, payload user_id mismatch or malformed payload, missing `--output-dir`, or file path rejection. |

`status` and `prune` are not built. Do not substitute manual SQL or attempt those commands.

## Typical single-company pilot

1. Run `census` and confirm the supported embedding pair (§5.5). Deploy the parser and rebuilt Hermes image before changing agent hardening configuration.
2. Run `sweep`, then `publish`, until no publishable staging remains. Quarantined sources do not block `flip`.
3. Add `PAPERCLIP_MEMORY_HARDENING=agent-scoped-mem0` to each intended agent's `adapterConfig.env`, resending the complete existing environment. Do not enable it server-wide for a narrow pilot.
4. Run `flip ... --confirm <uuid> --ack-agent-scope-flag`. This is a live cutover: do not use `NOLOGIN` or terminate connections.
5. Run `drain` until two clean probes at least 10 minutes apart establish quiescence. Other agents' company-scoped writes commonly prevent confirmation; never run prune on a partially flipped company.
6. Run `verify`; treat quarantines as a recorded policy decision, not a routine `--allow-quarantined` override.
7. If state becomes `needs_recovery`, run `recover` first. Rollback retains agent-scoped rows and is near-final: a later upgrade reconverts and duplicates legacy content (TECH-8326).

## Export subcommand (`pnpm memory:upgrade export`)

The `export` subcommand exports converted memories from `paperclip_memory_upgrade_staging` for a single agent to JSONL format for downstream ingestion into the external `rh-memory-mcp` service (TECH-8573).

### Guarantees and read-only behavior
- Runs strictly read-only against the tenant database inside a `READ ONLY REPEATABLE READ` transaction (`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`).
- Acquires no lease, performs no DDL, bumps no fences, updates no counters, and modifies zero database records on tenant or control plane.
- By default runs as a **dry run** (no files written, report counts only). Passing `--confirm <company-uuid>` (matching `--company`) and `--output-dir <dir>` writes export files.

### Flags
- `--database-url <dsn>` (or `COMPANY_MEMORY_DATABASE_URL` env var): Tenant PostgreSQL connection string.
- `--control-plane-url <dsn>` (or `CONTROL_PLANE_DATABASE_URL` env var): Control plane database connection string.
- `--company <uuid>`: Target company UUID (required).
- `--agent <uuid>`: Target agent UUID (required; must be an active or paused `hermes_local` agent belonging to the company).
- `--upgrade-id <uuid>`: Optional upgrade ID (defaults to the most recent upgrade row for the company).
- `--output-dir <dir>`: Target directory for export files (required with `--confirm`). Must exist, must not reside within the repository, and must not be reached through an in-repo symlink.
- `--confirm <company-uuid>`: Confirms execution and enables writing output files (must strictly match `--company`).
- `--format <text|json>`: Output reporting format (default: `text`).
- `--table <name>`: Live table name for tenant preflight (default: `mem0_memories`).
- `--prod`: Required alongside `MEMORY_UPGRADE_ALLOW_PROD=1` when connecting to non-local databases.
- `--help, -h`: Displays command help.

### Output files
When run with `--confirm`:
- `<output-dir>/export-<agent>.jsonl`: Newline-delimited JSON records (mode `0600`, exclusive create `wx`). Line schema:
  `{"import_key": <uuid>, "company_id", "agent_id", "text", "created_at", "type", "subject", "confidence", "migrated_from", "migration_id", "converter_id", "converter_version"}`.
- `<output-dir>/export-<agent>.manifest.json`: JSON manifest (mode `0600`, exclusive create `wx`):
  `{"format_version": 1, "company_id", "agent_id", "upgrade_id", "converter_id", "converter_version", "record_count", "skipped_counts_by_outcome", "jsonl_sha256", "created_at", "tool": "paperclip memory:upgrade export"}`.

### What export does NOT do
- Does NOT publish memories to the live Mem0 collection table (`mem0_memories`).
- Does NOT flip the company scope marker or advance upgrade lifecycle states (`sweeping`, `completed`, etc. remain unchanged).
- Does NOT prune or delete staging, ledger, or live rows.
- Does NOT modify control-plane records, lease tokens, or counters.
- Does NOT import memories into `rh-memory-mcp` (downstream import is performed separately).
