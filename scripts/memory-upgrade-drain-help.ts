/**
 * CLI help text for drain subcommand (TECH-8191 §Q3, PR5.7).
 */

export function printDrainHelp(): void {
  console.log(`
Usage: pnpm memory:upgrade drain --database-url <tenant-dsn> --control-plane-url <cp-dsn> --confirm <uuid> [options]

Observes and records proof of quiescence after flip for company memory upgrade (TECH-8191).
Without --confirm <uuid> or with --dry-run, runs as a read-only preview, takes no lease, and makes zero mutations.

Operation note:
  drain does not run a sweep; it proves a sweep would find nothing.
  A catch-up sweep or publish while draining resets the probe streak and any previous drain
  confirmation, because new work invalidates the evidence. Run drain last.
  An actual sweep invokes the LLM converter and embedding models, consuming budget and
  requiring API credentials. The drain probe is a read-only anti-join scan over the live
  collection proving that a sweep or publish run at that moment would find zero pending work.
  Non-waitable blockers (such as live rows missing user_id scope) cause drain to refuse
  immediately rather than waiting for timeout, because a draining sweep only adopts company-scoped rows.

The 10-minute two-probe rule:
  Confirmation requires evidence of quiescence across at least 10 minutes.
  1. The first quiescent probe (clean anti-join, zero active pre-flip Hermes runs,
     positive proof of agent-scoped memory observation after flip, and no concurrent lease)
     records the streak start timestamp in company_memory_upgrades.drain_probe_streak_started_at.
  2. A subsequent clean probe taken at least 10 minutes after the streak start confirms drain
     and sets company_memory_upgrades.drain_confirmed_at.
  3. Any non-quiescent condition resets the streak start to null, requiring a fresh 10-minute window.

Required (for confirmed run):
  --database-url <dsn>           Tenant PostgreSQL DSN (or COMPANY_MEMORY_DATABASE_URL env var)
  --control-plane-url <dsn>      Paperclip control-plane DSN (or CONTROL_PLANE_DATABASE_URL env var)
  --confirm <uuid>               Confirmation of target company UUID (enables streak/confirmation writes)

Options:
  --company <uuid>               Target company UUID (verified against --confirm)
  --table <name>                 Target Mem0 collection table name (default: "mem0_memories")
  --dry-run                      Run in read-only preview mode (takes no lease, zero writes)
  --once                         Run a single probe iteration and exit immediately
  --probe-interval-minutes <int> Minutes to sleep between probes in continuous mode (floor: 10, default: 10)
  --max-drain-hours <num>        Maximum drain duration in hours from flip marker before timeout (0 < h <= 168, default: 24)
  --probe-limit <int>            Drain probe query limit for unledgered/changed rows (default: 1000)
  --blocking-run-limit <int>     Maximum number of active pre-flip heartbeat runs to query (default: 25)
  --output, --out <path>         Write drain report to external path (mode 0600, exclusive create)
  --format <text|json>           Output format: human summary (text, default) or JSON (json)
  --prod                         Flag required alongside MEMORY_UPGRADE_ALLOW_PROD=1 when target host is non-localhost
  --help, -h                     Show this help message
`);
}
