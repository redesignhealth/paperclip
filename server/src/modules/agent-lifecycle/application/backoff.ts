import type { AgentLifecycleState } from "@paperclipai/shared";

const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
const FAST_ATTEMPTS = 3;
/** About 30 minutes of retries at the capped interval. */
export const STUCK_AFTER_ATTEMPTS = 40;
export const STUCK_RETRY_MS = 10 * 60_000;

/** Delay before retrying a step that reported "pending". The first few polls
 * stay quick so a normal stop settles promptly; after that the delay doubles
 * up to a cap so an agent that cannot settle does not load the database. */
export function pendingRetryDelayMs(attempts: number) {
  const exponent = Math.min(Math.max(0, attempts - FAST_ATTEMPTS), 10);
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** exponent);
}

/** A stop that is still pending after this many attempts is flagged on the
 * agent and polled slowly instead of spinning forever. */
export function isStuckStop(state: AgentLifecycleState | undefined, attempts: number) {
  return (state === "pausing" || state === "terminating" || state === "cleaning_up") && attempts >= STUCK_AFTER_ATTEMPTS;
}
