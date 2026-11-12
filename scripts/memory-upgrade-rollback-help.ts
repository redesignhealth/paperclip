/**
 * CLI help text for rollback subcommand (TECH-8191 §Q5, PR5.9).
 */

export function printRollbackHelp(): void {
  console.log(`
Usage: pnpm memory:upgrade rollback --database-url <tenant-dsn> --control-plane-url <cp-dsn> --confirm <uuid> [options]

Rolls back a company memory upgrade, clears the scope migration marker, and transitions state (TECH-8191 §Q5).
Without --confirm <uuid> or with --dry-run, runs as a read-only preview, takes no lease, and makes zero mutations.

State transitions:
  - flipping: reverts to sweeping (undo-flip). Exit 0.
  - draining / verified: transitions to rolled_back (terminal state; clears lease, sets rolled_back_at). Exit 0.
  - sweeping: refused (no flip has been performed for this upgrade).
  - pruning / completed: refused with ROLLBACK_REFUSED (no marker mutation).
  - needs_recovery: refused (must recover first via 'pnpm memory:upgrade recover').

Rollback properties & warnings:
  - Rollback deletes nothing: live memory rows are never deleted. Agent-scoped rows created by the
    upgrade remain in the live collection but will become invisible to company-scoped reads.
  - Reverting scope: Clearing the marker reverts reads to company scope for all agents.
    Operators should also remove 'agent-scoped-mem0' from agent configs to keep configuration consistent.
    Rollback does not modify agent configurations.
  - Treat rollback as near-final: If this company is upgraded again later, a new upgrade row is created
    and all legacy memories will be swept and converted again from scratch, paying model costs again
    and publishing duplicate copies into agent scope alongside the retained rows (TECH-8326).

Required (for confirmed run):
  --database-url <dsn>           Tenant PostgreSQL DSN (or COMPANY_MEMORY_DATABASE_URL env var)
  --control-plane-url <dsn>      Paperclip control-plane DSN (or CONTROL_PLANE_DATABASE_URL env var)
  --confirm <uuid>               Confirmation of target company UUID (enables live transition)

Options:
  --company <uuid>               Target company UUID (verified against --confirm)
  --table <name>                 Target Mem0 collection table name (default: "mem0_memories")
  --dry-run                      Run in read-only preview mode (takes no lease, zero writes)
  --output, --out <path>         Write rollback report to external path (mode 0600, exclusive create)
  --format <text|json>           Output format: human summary (text, default) or JSON (json)
  --prod                         Flag required alongside MEMORY_UPGRADE_ALLOW_PROD=1 when target host is non-localhost
  --help, -h                     Show this help message
`);
}
