# Company Memory Upgrade: Publish CLI Reference (TECH-8191)

This companion document to [COMPANY-MEMORY-RUNBOOK.md](./COMPANY-MEMORY-RUNBOOK.md) provides the complete command line reference, verification queries, and remediation procedures for the `publish` subcommand.

## CLI Usage & Options

```bash
pnpm memory:upgrade publish \
  --database-url <tenant-dsn> \
  --control-plane-url <cp-dsn> \
  --confirm <company-uuid> \
  [options]
```

### Flags

| Flag | Type | Description |
| --- | --- | --- |
| `--database-url <dsn>` | Required | Tenant PostgreSQL DSN (or `COMPANY_MEMORY_DATABASE_URL`). |
| `--control-plane-url <dsn>` | Required | Control-plane PostgreSQL DSN (or `CONTROL_PLANE_DATABASE_URL`). |
| `--confirm <uuid>` | Optional | Company UUID confirmation. Enables live writes. |
| `--company <uuid>` | Optional | Target company UUID (must match `--confirm` if both passed). |
| `--dry-run` | Flag | Preview mode. Zero live or staging mutations. |
| `--batch-sources <int>` | Optional | Sources committed per transaction (default: `100`). |
| `--max-rows <int>` | Optional | Max staging rows to publish; source bounded (a source's rows are never split). If the first eligible source alone exceeds this budget, publish refuses with `[INVALID_ARGUMENT]` rather than silently publishing nothing (see Error Codes below). |
| `--page-size <int>` | Optional | Keyset page size for staging scan (default: `1000`). |
| `--table <name>` | Optional | Live Mem0 collection table name (default: `"mem0_memories"`). |
| `--pause-when-active-runs <n>` | Optional | Active heartbeat run pause threshold (default: `1`). |
| `--active-run-poll-ms <int>` | Optional | Polling interval during pause (default: `15000` ms). |
| `--max-pause-seconds <int>` | Optional | Max pause timeout before aborting (default: `0` = unbounded). |
| `--output, --out <path>` | Optional | Output file path (mode `0600`, exclusive create `wx`). |
| `--format <text\|json>` | Optional | Output format: `text` (default) or `json`. |
| `--prod` | Flag | Required with `MEMORY_UPGRADE_ALLOW_PROD=1` for non-local hosts. |

---

## Workflow Examples

### Step 1: Read-Only Preview (Dry Run)

```bash
pnpm memory:upgrade publish \
  --database-url "$TENANT_DSN" \
  --control-plane-url "$CP_DSN" \
  --company "$COMPANY_UUID" \
  --dry-run
```

Validates tenant connection, role privileges, live table insertability, and active upgrade state without modifying data.

### Step 2: Bounded Canary Batch

```bash
pnpm memory:upgrade publish \
  --database-url "$TENANT_DSN" \
  --control-plane-url "$CP_DSN" \
  --confirm "$COMPANY_UUID" \
  --max-rows 500
```

### Step 3: Complete Publish

```bash
pnpm memory:upgrade publish \
  --database-url "$TENANT_DSN" \
  --control-plane-url "$CP_DSN" \
  --confirm "$COMPANY_UUID"
```

---

## Operator Verification SQL

Run these queries on the tenant database after publish to verify counts and data integrity:

```sql
-- 1. Pending vs Published count in staging
SELECT
  count(*) FILTER (WHERE published_at IS NOT NULL) AS published_staging_rows,
  count(*) FILTER (WHERE published_at IS NULL) AS pending_staging_rows,
  count(DISTINCT source_id) FILTER (WHERE published_at IS NULL) AS pending_sources
FROM paperclip_memory_upgrade_staging
WHERE upgrade_id = '<upgrade-uuid>'::uuid;

-- 2. Verify live rows exist and match published staging IDs
SELECT count(*) AS live_published_matches
FROM mem0_memories m
JOIN paperclip_memory_upgrade_staging s ON s.output_id = m.id
WHERE s.upgrade_id = '<upgrade-uuid>'::uuid
  AND s.published_at IS NOT NULL;

-- 3. Verify no staging rows marked published_at are missing from live collection
SELECT s.output_id, s.source_id, s.agent_id
FROM paperclip_memory_upgrade_staging s
LEFT JOIN mem0_memories m ON m.id = s.output_id
WHERE s.upgrade_id = '<upgrade-uuid>'::uuid
  AND s.published_at IS NOT NULL
  AND m.id IS NULL;
```

---

## Error Codes & Remediation

| Error Code | Reason | Remediation |
| --- | --- | --- |
| `LIVE_TABLE_ID_NOT_UNIQUE` | Live collection lacks unique index / PK on `id`. | Restore primary key or unique index on live collection table. |
| `LIVE_TABLE_NOT_INSERTABLE` | Live table has non-null columns without defaults. | Add defaults or remove columns so standard Mem0 insert succeeds. |
| `PUBLISH_LEDGER_INCONSISTENT` | Staging rows lack ledger entries or agent mismatch. | Re-run `pnpm memory:upgrade sweep` to reconcile ledger before retrying. |
| `PUBLISH_CONFLICT_UNEXPECTED` | Constraint conflict on row not created by upgrade. | Investigate ID collision in live table. Batch rolls back safely. |
| `PUBLISH_PRECONDITION_FAILED` | Inconsistent tenant upgrade state. | Verify upgrade state and tenant tables; re-run sweep if needed. |
| `STATE_MISMATCH` | No active sweeping upgrade. | Run `pnpm memory:upgrade sweep` first to initiate upgrade. |
| `INVALID_ARGUMENT` | `Source exceeds --max-rows and cannot be split; increase --max-rows to at least the source's row count.` — the first eligible source (no rows consumed/published yet in this run) has more staging rows than `--max-rows` allows. | Re-run with a larger `--max-rows` (at least the source's row count), or omit `--max-rows` entirely. This only occurs with zero progress; if the budget runs out on a later source after some rows were already published, publish instead stops normally and reports the committed progress for a resumed run. |
