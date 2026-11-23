import { describe, expect, it, vi } from "vitest";
import { createLifecycleWorker } from "../application/worker.js";
import { isStuckStop, pendingRetryDelayMs, STUCK_AFTER_ATTEMPTS, STUCK_RETRY_MS } from "../application/backoff.js";
import type { LifecycleAgent, LifecycleDriver, LifecycleStore } from "../application/ports.js";

function pausing(attempts: number): LifecycleAgent {
  return { id: "agent", companyId: "company", lifecycleState: "pausing", lifecycleVersion: 3,
    lifecycleRequiredPluginIds: [], lifecycleError: null,
    lifecycleOperation: { id: "operation", hostComplete: false, completedPluginIds: [], attempts } };
}

async function deferralFor(attempts: number) {
  const agent = pausing(attempts);
  const store = { get: vi.fn(), claim: vi.fn().mockResolvedValue(agent), renew: vi.fn().mockResolvedValue(true),
    setRequiredPlugins: vi.fn().mockResolvedValue(true), completeHost: vi.fn(), completePlugin: vi.fn(),
    defer: vi.fn().mockResolvedValue(true), change: vi.fn(), pending: vi.fn() } satisfies LifecycleStore;
  const driver = { requiredPluginIds: vi.fn().mockResolvedValue([]), runHost: vi.fn().mockResolvedValue("pending"),
    runPlugin: vi.fn() } satisfies LifecycleDriver;
  const worker = createLifecycleWorker(store, driver, vi.fn());
  await worker.process(agent.id);
  await worker.stop();
  expect(store.defer).toHaveBeenCalledTimes(1);
  return store.defer.mock.calls[0]!;
}

describe("pending lifecycle stop backoff", () => {
  it("keeps early polls quick, then doubles up to a cap", () => {
    const delays = Array.from({ length: 12 }, (_, index) => pendingRetryDelayMs(index + 1));
    expect(delays.slice(0, 3)).toEqual([2_000, 2_000, 2_000]);
    expect(delays.slice(3, 7)).toEqual([4_000, 8_000, 16_000, 32_000]);
    expect(Math.max(...delays)).toBe(60_000);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(pendingRetryDelayMs(10_000)).toBe(60_000);
  });

  it("does not poll a stuck pausing agent faster than the backoff", async () => {
    let previous = 0;
    for (const attempts of [1, 4, 6, 8, 20]) {
      const [, , error, , retryAfterMs] = await deferralFor(attempts);
      expect(error).toBeNull();
      expect(retryAfterMs).toBe(pendingRetryDelayMs(attempts));
      expect(retryAfterMs).toBeGreaterThanOrEqual(previous);
      previous = retryAfterMs!;
    }
  });

  it("flags an agent stuck in pausing and polls it slowly", async () => {
    expect(isStuckStop("pausing", STUCK_AFTER_ATTEMPTS - 1)).toBe(false);
    expect(isStuckStop("verifying", STUCK_AFTER_ATTEMPTS)).toBe(false);
    const [, , error, , retryAfterMs] = await deferralFor(STUCK_AFTER_ATTEMPTS);
    expect(error).toContain("taking longer than expected");
    expect(retryAfterMs).toBe(STUCK_RETRY_MS);
    expect(STUCK_RETRY_MS).toBeGreaterThan(pendingRetryDelayMs(STUCK_AFTER_ATTEMPTS));
  });
});
