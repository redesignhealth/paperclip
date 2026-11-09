/**
 * Monotonic clock and sleeper interfaces for time-dependent operations (TECH-8191).
 */

export interface MonotonicClock {
  nowMs(): number;
  now?(): Date;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export function createSystemClock(): MonotonicClock & { now(): Date } {
  return {
    nowMs: () => performance.timeOrigin + performance.now(),
    now: () => new Date(performance.timeOrigin + performance.now()),
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
