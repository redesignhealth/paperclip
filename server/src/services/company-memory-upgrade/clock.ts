/**
 * Monotonic clock and sleeper interfaces for time-dependent operations (TECH-8191).
 */

export interface MonotonicClock {
  nowMs(): number;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export function createSystemClock(): MonotonicClock {
  return {
    nowMs: () => Date.now(),
  };
}

export function createSystemSleeper(): Sleeper {
  return {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}
