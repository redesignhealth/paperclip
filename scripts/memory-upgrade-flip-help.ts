/**
 * CLI help text for flip subcommand (TECH-8191).
 */

export function printFlipHelp(): void {
  console.log(`
Usage: pnpm memory:upgrade flip --database-url <tenant-dsn> --control-plane-url <cp-dsn> --confirm <uuid> --ack-agent-scope-flag [options]

Sets the per-company scope migration marker and advances upgrade state sweeping -> flipping -> draining (TECH-8191).
Without --confirm <uuid> or with --dry-run, runs as a read-only preview, takes no lease, and makes zero mutations.

Required (for confirmed run):
  --database-url <dsn>           Tenant PostgreSQL DSN (or COMPANY_MEMORY_DATABASE_URL env var)
  --control-plane-url <dsn>      Paperclip control-plane DSN (or CONTROL_PLANE_DATABASE_URL env var)
  --confirm <uuid>               Confirmation of target company UUID (enables live transition)
  --ack-agent-scope-flag         Operator acknowledgment that 'agent-scoped-mem0' is enabled

Operator assertion note:
  --ack-agent-scope-flag is an operator assertion, not proof. Setting the database marker
  alone changes nothing at runtime unless 'agent-scoped-mem0' is enabled for the processes
  running this company's agents. Real evidence of agent-scoped memory usage is verified
  independently during drain and verify.

Single-agent pilot note:
  To pilot agent-scoped memory on a single agent before company-wide rollout:
  1. Flip the company (sets the company-wide marker).
  2. Enable PAPERCLIP_MEMORY_HARDENING=agent-scoped-mem0 in exactly that agent's
     adapterConfig.env (while server environment has the flag disabled).
  3. That agent will resolve agent scope; other agents continue reading company scope.
  4. Do NOT run prune while other agents still read company-scoped memory.

Options:
  --company <uuid>               Target company UUID (verified against --confirm)
  --table <name>                 Target Mem0 collection table name (default: "mem0_memories")
  --mode <copy>                  Scope migration mode (only 'copy' is supported, default: "copy")
  --probe-limit <int>            Drain probe limit for unledgered/changed rows (default: 1000)
  --dry-run                      Run in read-only preview mode (takes no lease, zero writes)
  --output, --out <path>         Write flip report to external path (mode 0600, exclusive create)
  --format <text|json>           Output format: human summary (text, default) or JSON (json)
  --prod                         Flag required alongside MEMORY_UPGRADE_ALLOW_PROD=1 when target host is non-localhost
  --help, -h                     Show this help message
`);
}
