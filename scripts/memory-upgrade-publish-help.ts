/**
 * CLI help text for publish subcommand (TECH-8191).
 */

export function printPublishHelp(): void {
  console.log(`
Usage: pnpm memory:upgrade publish --database-url <tenant-dsn> --control-plane-url <cp-dsn> --confirm <uuid> [options]

Publishes staged company memories to the live Mem0 collection table (TECH-8191).
Without --confirm <uuid> or with --dry-run, runs as a read-only preview and makes zero mutations.

Required (for confirmed run):
  --database-url <dsn>           Tenant PostgreSQL DSN (or COMPANY_MEMORY_DATABASE_URL env var)
  --control-plane-url <dsn>      Paperclip control-plane DSN (or CONTROL_PLANE_DATABASE_URL env var)
  --confirm <uuid>               Confirmation of target company UUID (enables live writes)

Options:
  --company <uuid>               Target company UUID (verified against --confirm)
  --table <name>                 Target Mem0 collection table name (default: "mem0_memories")
  --batch-sources <int>          Number of sources to commit per live transaction (default: 100)
  --max-rows <int>               Maximum number of staging rows to publish
  --page-size <int>              Keyset page size for unpublished staging sources (default: 1000)
  --dry-run                      Run in read-only preview mode (never mutates live collection or staging)
  --pause-when-active-runs <n>   Active run threshold to pause publish (default: 1, 0 to disable)
  --active-run-poll-ms <int>     Active run polling interval in milliseconds (default: 15000)
  --max-pause-seconds <int>      Maximum total pause time allowed before failing (default: 0 = unbounded)
  --output, --out <path>         Write publish report to external path (mode 0600, exclusive create)
  --format <text|json>           Output format: human summary (text, default) or JSON (json)
  --prod                         Flag required alongside MEMORY_UPGRADE_ALLOW_PROD=1 when target host is non-localhost
  --help, -h                     Show this help message
`);
}
