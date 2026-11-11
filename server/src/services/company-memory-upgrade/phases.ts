import type { UpgradeState } from "./types.js";

/**
 * Upgrade states that accept memory conversion work (sweep and publish).
 *
 * During the initial 'sweeping' phase, the upgrade scans and converts all legacy memories.
 * After flip, in the 'draining' phase, catch-up sweeps scan and convert any late
 * company-scoped writes from pre-flip runs, and catch-up publishes publish them,
 * before the drain can be verified and confirmed.
 *
 * Work is strictly refused in all other states:
 * - 'flipping': intermediate marker-transition state; crash-resumable
 * - 'verified': drain confirmed; no further company-scoped work accepted
 * - 'pruning': PR6 phase
 * - 'completed', 'aborted', 'rolled_back': terminal
 * - 'needs_recovery': requires operator recovery before work can resume
 */
export const UPGRADE_WORK_STATES: ReadonlySet<UpgradeState> = new Set([
  "sweeping",
  "draining",
]);

/**
 * Backward-compatible alias for the allowed work states during sweep/publish (TECH-8191 §5.2).
 */
export const SWEEP_ALLOWED_STATES = UPGRADE_WORK_STATES;

export function isUpgradeWorkState(state: string): state is "sweeping" | "draining" {
  return UPGRADE_WORK_STATES.has(state as UpgradeState);
}
