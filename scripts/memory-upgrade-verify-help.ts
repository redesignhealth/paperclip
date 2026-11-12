/**
 * CLI help text for verify subcommand (TECH-8191 §Q4, PR5.8).
 */

export function printVerifyHelp(): void {
  console.log(`
Usage: pnpm memory:upgrade verify --database-url <tenant-dsn> --control-plane-url <cp-dsn> --confirm <uuid> [options]

Verifies quiescence, agent scope observation, and migration completeness after drain (TECH-8191 §Q4).
Without --confirm <uuid> or with --dry-run, runs as a read-only preview, takes no lease, and makes zero mutations.

Operation note:
  verify advances upgrade state from 'draining' to 'verified' when all verification gates pass.
  It is idempotent and re-runnable: in state 'verified', it re-evaluates all gates, prints the report,
  makes no state transition, and exits 0.

Verification gates (V1–V7):
  V1: Drain confirmed: drain_confirmed_at must be non-null and no active pre-flip Hermes runs exist.
  V2: Agent scope observed: scope_migration_agent_scope_observed_at must be after marked_at.
  V3: Marker intact: scope_migration_completed_at and mode must match this upgrade's flip.
  V4: No pending publish: staging must contain zero unpublished rows for this upgrade.
  V5: Clean drain probe: fresh point-in-time probe must find zero unmigrated or changed sources.
  V6: No quarantined rows: zero quarantined sources in ledger (unless overridden by --allow-quarantined).
  V7: Lease acquirable: upgrade lease must be claimable without conflict.

What verify does NOT prove:
  - That every legacy memory is now recallable by the right agent — recall quality is never tested.
  - That all agents observed agent scope — agent scope observation proves >=1 run, not coverage.
  - That the observation means a run succeeded — observation records at scope resolution before dispatch.
  - That no further company-scoped write can occur.
  - That legacy rows are safe to delete — that is PR6 prune evidence, not verify's.
  - That the configuration is durable — turning agent-scoped-mem0 off silently reverts to company scope.

Required (for confirmed run):
  --database-url <dsn>           Tenant PostgreSQL DSN (or COMPANY_MEMORY_DATABASE_URL env var)
  --control-plane-url <dsn>      Paperclip control-plane DSN (or CONTROL_PLANE_DATABASE_URL env var)
  --confirm <uuid>               Confirmation of target company UUID (enables transition to verified)

Options:
  --company <uuid>               Target company UUID (verified against --confirm)
  --table <name>                 Target Mem0 collection table name (default: "mem0_memories")
  --dry-run                      Run in read-only preview mode (takes no lease, zero writes)
  --allow-quarantined            Allow verification to pass when quarantined sources exist in the ledger
  --probe-limit <int>            Drain probe query limit for unledgered/changed rows (default: 1000)
  --blocking-run-limit <int>     Maximum number of active pre-flip heartbeat runs to query (default: 25)
  --output, --out <path>         Write verify report to external path (mode 0600, exclusive create)
  --format <text|json>           Output format: human summary (text, default) or JSON (json)
  --prod                         Flag required alongside MEMORY_UPGRADE_ALLOW_PROD=1 when target host is non-localhost
  --help, -h                     Show this help message
`);
}
