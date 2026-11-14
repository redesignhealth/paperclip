/**
 * CLI help text for export subcommand (TECH-8573).
 */

export function printExportHelp(): void {
  console.log(`
Usage: pnpm memory:upgrade export --database-url <tenant-dsn> --control-plane-url <cp-dsn> --company <uuid> --agent <uuid> [options]

Exports converted memories for a single agent from the tenant upgrade staging table (TECH-8573).
Runs strictly read-only against the tenant database (SET TRANSACTION READ ONLY).
Default is DRY RUN: no files written; report counts only.
Pass --confirm <company-uuid> --output-dir <dir> to write JSONL and manifest files.

Required:
  --company <uuid>               Target company UUID
  --agent <uuid>                 Target agent UUID (memory-eligible hermes_local agent)

Options:
  --database-url <dsn>           Tenant PostgreSQL DSN (or COMPANY_MEMORY_DATABASE_URL env var)
  --control-plane-url <dsn>      Paperclip control-plane DSN (or CONTROL_PLANE_DATABASE_URL env var)
  --upgrade-id <uuid>            Upgrade record UUID (default: most recent upgrade for the company)
  --output-dir <dir>             Output directory for export files (required with --confirm)
  --confirm <company-uuid>       Confirmation of target company UUID (enables writing export files)
  --table <name>                 Target Mem0 collection table name (default: "mem0_memories")
  --format <text|json>           Output format: human summary (text, default) or JSON (json)
  --prod                         Flag required alongside MEMORY_UPGRADE_ALLOW_PROD=1 when target host is non-localhost
  --help, -h                     Show this help message
`);
}
