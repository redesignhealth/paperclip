/**
 * CLI help text for recover subcommand (TECH-8191 §Q6, PR5.11).
 */

export function printRecoverHelp(): void {
  console.log(`
Usage: pnpm memory:upgrade recover --control-plane-url <cp-dsn> --confirm <uuid> [options]

Recovers an upgrade from 'needs_recovery' back to its recorded prior state and immediately releases the lease (TECH-8191 §Q6).
Without --confirm <uuid> or with --dry-run, runs as a read-only preview, takes no lease, and makes zero mutations.

Recovery properties:
  - Parity admission check: verifies the company is not undergoing deletion.
  - Requires state 'needs_recovery': upgrades in any other state are refused.
  - Clears last_error and restores the upgrade to recover_to_state.
  - Immediately releases the newly minted lease so subsequent commands (sweep/flip/drain) can claim it.
  - If restored to 'flipping', operators should re-run 'pnpm memory:upgrade flip' (idempotent) to finish.
  - Never touches the scope migration marker.

Required (for confirmed run):
  --control-plane-url <dsn>      Paperclip control-plane DSN (or CONTROL_PLANE_DATABASE_URL env var)
  --confirm <uuid>               Confirmation of target company UUID (enables recovery)

Options:
  --company <uuid>               Target company UUID (verified against --confirm)
  --dry-run                      Run in read-only preview mode (takes no lease, zero writes)
  --output, --out <path>         Write recovery report to external path (mode 0600, exclusive create)
  --format <text|json>           Output format: human summary (text, default) or JSON (json)
  --prod                         Flag required alongside MEMORY_UPGRADE_ALLOW_PROD=1 when target host is non-localhost
  --help, -h                     Show this help message
`);
}
