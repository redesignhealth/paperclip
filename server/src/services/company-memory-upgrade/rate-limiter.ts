/**
 * Two-bucket rate limiter with concurrency semaphore (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * - Rate limiting uses two token buckets (requests RPM, tokens TPM) + concurrency semaphore.
 * - Concurrency is hard-capped at 2 regardless of flag configuration.
 * - acquire() waits for deficit sleep, debits estimated tokens, and returns a lease.
 * - settle() reconciles actual vs estimated tokens (can push token bucket negative).
 * - release() releases concurrency slot (must be called in finally).
 * - Virtual time supported via injected MonotonicClock and Sleeper.
 */

import { type MonotonicClock, type Sleeper } from "./clock.js";

export interface RateLimiterOptions {
  rpm: number;
  tpm: number;
  concurrency?: number;
  clock: MonotonicClock;
  sleeper: Sleeper;
}

export interface RateLimitLease {
  settle(actualTokens: number): void;
  release(): void;
}

export interface RateLimiter {
  acquire(estimatedTokens: number): Promise<RateLimitLease>;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { rpm, tpm, clock, sleeper } = options;
  const maxConcurrency = Math.min(options.concurrency ?? 2, 2);

  let inFlight = 0;
  const waiters: Array<() => void> = [];

  let reqTokens = rpm;
  let dataTokens = tpm;
  let lastRefillMs = clock.nowMs();

  const reqRefillPerMs = rpm / 60_000;
  const dataRefillPerMs = tpm / 60_000;

  function refill(): void {
    const now = clock.nowMs();
    const elapsed = Math.max(0, now - lastRefillMs);
    lastRefillMs = now;

    reqTokens = Math.min(rpm, reqTokens + elapsed * reqRefillPerMs);
    dataTokens = Math.min(tpm, dataTokens + elapsed * dataRefillPerMs);
  }

  return {
    async acquire(estimatedTokens: number): Promise<RateLimitLease> {
      // 1. Wait for concurrency slot
      while (inFlight >= maxConcurrency) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      inFlight++;

      // 2. Wait for token bucket deficit
      while (true) {
        refill();

        const reqDeficit = Math.max(0, 1 - reqTokens);
        const tokDeficit = Math.max(0, estimatedTokens - dataTokens);

        const reqWaitMs = reqDeficit > 0 ? reqDeficit / reqRefillPerMs : 0;
        const tokWaitMs = tokDeficit > 0 ? tokDeficit / dataRefillPerMs : 0;
        const sleepMs = Math.max(reqWaitMs, tokWaitMs);

        if (sleepMs > 0) {
          await sleeper.sleep(Math.ceil(sleepMs));
        } else {
          reqTokens -= 1;
          dataTokens -= estimatedTokens;
          break;
        }
      }

      let released = false;

      return {
        settle(actualTokens: number): void {
          const diff = actualTokens - estimatedTokens;
          dataTokens -= diff;
        },
        release(): void {
          if (!released) {
            released = true;
            inFlight--;
            const next = waiters.shift();
            if (next) {
              next();
            }
          }
        },
      };
    },
  };
}

/**
 * Extracts a header value case-insensitively from Headers or Record.
 */
function getHeaderValue(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lowerName = name.toLowerCase();

  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(lowerName);
  }

  const rec = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(rec)) {
    if (key.toLowerCase() === lowerName) {
      const val = rec[key];
      if (Array.isArray(val)) return val[0] ?? null;
      return val ?? null;
    }
  }
  return null;
}

/**
 * Parses Retry-After or OpenAI rate-limit reset headers into milliseconds.
 */
export function parseRetryAfterMs(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined,
  nowMs: number,
): number | null {
  if (!headers) return null;

  const retryAfter = getHeaderValue(headers, "retry-after");
  if (retryAfter) {
    const trimmed = retryAfter.trim();
    const seconds = Number(trimmed);
    if (!Number.isNaN(seconds) && Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
    const parsedDate = Date.parse(trimmed);
    if (!Number.isNaN(parsedDate)) {
      return Math.max(0, Math.ceil(parsedDate - nowMs));
    }
  }

  // Check x-ratelimit-reset-requests / x-ratelimit-reset-tokens
  for (const headerName of [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ]) {
    const val = getHeaderValue(headers, headerName);
    if (val) {
      const trimmed = val.trim();
      // Handle durations like "6ms", "1s", "500ms"
      if (trimmed.endsWith("ms")) {
        const ms = parseFloat(trimmed.slice(0, -2));
        if (!Number.isNaN(ms) && Number.isFinite(ms) && ms >= 0) {
          return Math.ceil(ms);
        }
      }
      if (trimmed.endsWith("s")) {
        const s = parseFloat(trimmed.slice(0, -1));
        if (!Number.isNaN(s) && Number.isFinite(s) && s >= 0) {
          return Math.ceil(s * 1000);
        }
      }
      const s = Number(trimmed);
      if (!Number.isNaN(s) && Number.isFinite(s) && s >= 0) {
        return Math.ceil(s * 1000);
      }
    }
  }

  return null;
}

/**
 * Estimates LLM input+output tokens for a single conversion request based on budget.ts heuristic.
 * 600 fixed prompt/schema tokens + ceil(text.length / 4) input source tokens + 80 expected output tokens.
 */
export function estimateChatTokens(text: string): number {
  return 600 + Math.ceil(text.length / 4) + 80;
}
