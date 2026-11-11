/**
 * Error messages and allowlisted strings for lifecycle commands (TECH-8191).
 */

export const LIFECYCLE_CLI_GENERIC_ERROR_MESSAGES: Record<string, string> = {
  FLIP_PRECONDITION_FAILED:
    "Flip refused before changing anything: staged rows are still unpublished, or a sweep would still find new or changed company-scoped memories. Run 'pnpm memory:upgrade publish' and 'pnpm memory:upgrade sweep' until both are clean, then retry. Nothing was flipped.",
  get flip_precondition_failed(): string {
    return this.FLIP_PRECONDITION_FAILED;
  },

  FLIP_MARKER_WRITE_FAILED:
    "Failed to write the scope migration marker. The upgrade is left in 'flipping'; re-run 'pnpm memory:upgrade flip' to resume. Flip is idempotent.",
  get flip_marker_write_failed(): string {
    return this.FLIP_MARKER_WRITE_FAILED;
  },

  FLIP_MARKER_MISSING:
    "The scope migration marker is not set, or does not match this upgrade's recorded flip time. Do not hand-edit scope_migration_completed_at; investigate before continuing.",
  get flip_marker_missing(): string {
    return this.FLIP_MARKER_MISSING;
  },

  AGENT_SCOPE_NOT_OBSERVED:
    "No agent-scoped memory use has been observed for this company since the flip. The marker alone changes nothing unless 'agent-scoped-mem0' is enabled for the processes running this company's agents.",
  get agent_scope_not_observed(): string {
    return this.AGENT_SCOPE_NOT_OBSERVED;
  },

  DRAIN_NOT_CONFIRMED:
    "Verify refused: drain has not been confirmed for this upgrade. Run 'pnpm memory:upgrade drain' first.",
  get drain_not_confirmed(): string {
    return this.DRAIN_NOT_CONFIRMED;
  },

  VERIFY_QUARANTINE_PRESENT:
    "Verify refused: quarantined sources remain in the ledger. Quarantined content never reached agent scope. Resolve them, or pass --allow-quarantined to accept the gap explicitly.",
  get verify_quarantine_present(): string {
    return this.VERIFY_QUARANTINE_PRESENT;
  },

  ROLLBACK_MARKER_CLEAR_FAILED:
    "Rollback refused: the scope migration marker could not be cleared. Nothing was changed and the upgrade state was not advanced; retry.",
  get rollback_marker_clear_failed(): string {
    return this.ROLLBACK_MARKER_CLEAR_FAILED;
  },
};

export const LIFECYCLE_SAFE_STATE_MISMATCH_MESSAGES = [
  "Cannot run flip: active upgrade is not in sweeping or flipping state.",
  "Cannot run drain: active upgrade is not in draining state.",
  "Cannot run verify: active upgrade is not in draining or verified state.",
  "Cannot run rollback: active upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' first.",
  "Cannot run rollback: no flip has been performed for this upgrade.",
  "Cannot run recover: active upgrade is not in needs_recovery.",
  "No active memory upgrade for this company.",
] as const;

export const LIFECYCLE_SAFE_INVALID_ARGUMENT_EXACT_MESSAGES = [
  "Invalid --mode. Only 'copy' is supported.",
  "Flag '--ack-agent-scope-flag' is required for flip. The scope marker alone has no effect unless 'agent-scoped-mem0' is enabled for this company's agent processes.",
  "Invalid --max-drain-hours. Must be a positive number of hours not exceeding 168.",
  "Invalid --probe-interval-minutes. Must be an integer of at least 10.",
] as const;
