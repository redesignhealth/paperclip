/**
 * Rate limiter, token bucket, and retry-after parsing unit tests (TECH-8191).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createRateLimiter,
  estimateChatTokens,
  parseRetryAfterMs,
} from "../../server/src/services/company-memory-upgrade/rate-limiter.js";
import { ManualClock } from "./memory-upgrade-sweep-helpers.js";

test("estimateChatTokens budget formula", () => {
  // Formula: 600 + Math.ceil(text.length / 4) + 80
  assert.equal(estimateChatTokens(""), 680);
  assert.equal(estimateChatTokens("1234"), 681);
  assert.equal(estimateChatTokens("12345"), 682);
  assert.equal(estimateChatTokens("a".repeat(100)), 600 + 25 + 80);
});

test("parseRetryAfterMs header parsing", async (t) => {
  const nowMs = 1_700_000_000_000;

  await t.test("parses integer seconds from Retry-After", () => {
    assert.equal(parseRetryAfterMs({ "retry-after": "12" }, nowMs), 12_000);
    assert.equal(parseRetryAfterMs({ "Retry-After": "0" }, nowMs), 0);
    assert.equal(parseRetryAfterMs({ "retry-after": "2.5" }, nowMs), 2500);
  });

  await t.test("parses HTTP date from Retry-After", () => {
    const futureDate = new Date(nowMs + 30_000).toUTCString();
    const res = parseRetryAfterMs({ "retry-after": futureDate }, nowMs);
    assert.equal(res, 30_000);
  });

  await t.test("parses x-ratelimit-reset-requests with ms and s units", () => {
    assert.equal(parseRetryAfterMs({ "x-ratelimit-reset-requests": "250ms" }, nowMs), 250);
    assert.equal(parseRetryAfterMs({ "x-ratelimit-reset-requests": "1.5s" }, nowMs), 1500);
    assert.equal(parseRetryAfterMs({ "x-ratelimit-reset-requests": "3" }, nowMs), 3000);
  });

  await t.test("parses x-ratelimit-reset-tokens", () => {
    assert.equal(parseRetryAfterMs({ "x-ratelimit-reset-tokens": "500ms" }, nowMs), 500);
    assert.equal(parseRetryAfterMs({ "x-ratelimit-reset-tokens": "4s" }, nowMs), 4000);
  });

  await t.test("returns null for missing, empty, or unparseable headers", () => {
    assert.equal(parseRetryAfterMs(null, nowMs), null);
    assert.equal(parseRetryAfterMs({}, nowMs), null);
    assert.equal(parseRetryAfterMs({ "content-type": "application/json" }, nowMs), null);
    assert.equal(parseRetryAfterMs({ "retry-after": "not-a-number-or-date" }, nowMs), null);
  });
});

test("createRateLimiter token bucket and virtual time mechanics", async (t) => {
  await t.test("acquires immediately when within RPM and TPM caps", async () => {
    const clock = new ManualClock(1_000_000);
    let sleepCalls = 0;
    const sleeper = {
      async sleep(ms: number) {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    const limiter = createRateLimiter({
      rpm: 60,
      tpm: 60_000,
      concurrency: 2,
      clock,
      sleeper,
    });

    const lease1 = await limiter.acquire(100);
    assert.equal(sleepCalls, 0, "Initial acquire should not sleep");
    lease1.release();

    const lease2 = await limiter.acquire(100);
    assert.equal(sleepCalls, 0, "Second acquire within budget should not sleep");
    lease2.release();
  });

  await t.test("sleeps exact deficit when RPM limit is exhausted", async () => {
    const clock = new ManualClock(1_000_000);
    let totalSleptMs = 0;
    const sleeper = {
      async sleep(ms: number) {
        totalSleptMs += ms;
        clock.advance(ms);
      },
    };

    // 2 RPM = 1 request every 30 seconds (30,000ms)
    const limiter = createRateLimiter({
      rpm: 2,
      tpm: 100_000,
      concurrency: 2,
      clock,
      sleeper,
    });

    // Acquire 2 requests (exhausts capacity)
    const l1 = await limiter.acquire(10);
    l1.release();
    const l2 = await limiter.acquire(10);
    l2.release();

    assert.equal(totalSleptMs, 0);

    // 3rd acquire needs 1 request: deficit = 1, refill = 2/60_000 = 1 per 30,000ms
    const l3 = await limiter.acquire(10);
    l3.release();

    assert.ok(totalSleptMs >= 30_000, `Expected sleep >= 30,000ms, got ${totalSleptMs}ms`);
  });

  await t.test("settle reconciles actual vs estimated tokens debit/credit", async () => {
    const clock = new ManualClock(1_000_000);
    let totalSleptMs = 0;
    const sleeper = {
      async sleep(ms: number) {
        totalSleptMs += ms;
        clock.advance(ms);
      },
    };

    // 60,000 TPM = 1 token per ms
    const limiter = createRateLimiter({
      rpm: 100,
      tpm: 1000,
      concurrency: 2,
      clock,
      sleeper,
    });

    // Acquire with overestimate: estimated 800, actual 200 (credit 600 back)
    const lease = await limiter.acquire(800);
    lease.settle(200);
    lease.release();

    // Now remaining tokens in bucket should be 1000 - 200 = 800
    // Another request for 500 tokens should not sleep
    const lease2 = await limiter.acquire(500);
    assert.equal(totalSleptMs, 0, "Credit from settle should allow next acquire without sleep");
    lease2.release();
  });

  await t.test("concurrency is hard-capped at 2 even if higher concurrency is requested", async () => {
    const clock = new ManualClock(1_000_000);
    const sleeper = {
      async sleep(ms: number) {
        clock.advance(ms);
      },
    };

    const limiter = createRateLimiter({
      rpm: 1000,
      tpm: 1_000_000,
      concurrency: 10, // Request 10 concurrency -> must be clamped to 2
      clock,
      sleeper,
    });

    const l1 = await limiter.acquire(10);
    const l2 = await limiter.acquire(10);

    let l3Acquired = false;
    const l3Promise = limiter.acquire(10).then((lease) => {
      l3Acquired = true;
      return lease;
    });

    // Tick microtasks
    await Promise.resolve();
    assert.equal(l3Acquired, false, "Third acquire must wait on concurrency slot 2");

    l1.release();
    const l3 = await l3Promise;
    assert.equal(l3Acquired, true, "Third acquire proceeds once slot 1 released");

    l2.release();
    l3.release();
  });
});
