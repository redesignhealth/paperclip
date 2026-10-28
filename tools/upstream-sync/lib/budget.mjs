// Run-level time budget.
//
// Per-call timeouts (UPSTREAM_SYNC_HTTP_TIMEOUT_MS) bound a single request, not a
// run: classify fans out over many batches and flush sends up to 50 alerts
// serially, all while the advisory run lock is held. 50 alerts at a 30s timeout
// is 25 minutes of lock, which starves the next hourly run. A run budget caps the
// whole thing: work that has not started by the deadline is left for the next run
// (rows stay unclassified, alerts stay undelivered and outboxed), and the run
// reports how much it deferred.
export const DEFAULT_RUN_BUDGET_MS = 10 * 60 * 1000;

export function createBudget({ budgetMs = DEFAULT_RUN_BUDGET_MS, now = Date.now } = {}) {
  const at = now() + budgetMs;
  return {
    budgetMs,
    at,
    // `now` is injectable so the cut-off can be tested without sleeping.
    expired: () => now() >= at,
    remainingMs: () => Math.max(0, at - now()),
  };
}
