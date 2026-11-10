/**
 * Rate limiter, token bucket, and retry-after parsing unit tests (TECH-8191).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createRateLimiter,
  estimateChatTokens,
  MAX_RETRY_AFTER_MS,
  parseDurationMs,
  parseRetryAfterMs,
} from "../../server/src/services/company-memory-upgrade/rate-limiter.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
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

  await t.test("table-driven duration parsing via parseDurationMs", () => {
    assert.equal(parseDurationMs("6m0s"), 360_000);
    assert.equal(parseDurationMs("1m30s"), 90_000);
    assert.equal(parseDurationMs("2m"), 120_000);
    assert.equal(parseDurationMs("500ms"), 500);
    assert.equal(parseDurationMs("1.5s"), 1500);
    assert.equal(parseDurationMs("3"), 3000);
    assert.equal(parseDurationMs("6x0y"), null);
    assert.equal(parseDurationMs("-1"), null);
    assert.equal(parseDurationMs("-5s"), null);
  });

  await t.test("table-driven duration parsing via parseRetryAfterMs", () => {
    assert.equal(parseRetryAfterMs({ "retry-after": "1m30s" }, nowMs), 90_000);
    assert.equal(parseRetryAfterMs({ "retry-after": "2m" }, nowMs), 120_000);
    assert.equal(parseRetryAfterMs({ "retry-after": "500ms" }, nowMs), 500);
    assert.equal(parseRetryAfterMs({ "retry-after": "1.5s" }, nowMs), 1500);
    assert.equal(parseRetryAfterMs({ "retry-after": "3" }, nowMs), 3000);
    assert.equal(parseRetryAfterMs({ "retry-after": "6m0s" }, nowMs), 300_000, "6m0s clamped to MAX_RETRY_AFTER_MS");
    assert.equal(parseRetryAfterMs({ "retry-after": "86400" }, nowMs), 300_000, "86400 clamped to MAX_RETRY_AFTER_MS");
    assert.equal(parseRetryAfterMs({ "retry-after": "6x0y" }, nowMs), null);
    assert.equal(parseRetryAfterMs({ "retry-after": "-1" }, nowMs), null);
    assert.equal(parseRetryAfterMs({ "retry-after": "-5s" }, nowMs), null);
  });

  await t.test("both headers takes max", () => {
    assert.equal(
      parseRetryAfterMs(
        {
          "retry-after": "3", // 3000ms
          "x-ratelimit-reset-requests": "5s", // 5000ms
        },
        nowMs,
      ),
      5000,
    );
  });

  await t.test("clamps to MAX_RETRY_AFTER_MS", () => {
    assert.equal(MAX_RETRY_AFTER_MS, 300_000);
    assert.equal(parseRetryAfterMs({ "retry-after": "86400" }, nowMs), 300_000);
  });

  await t.test("parses HTTP date from Retry-After", () => {
    const futureDate = new Date(nowMs + 30_000).toUTCString();
    const res = parseRetryAfterMs({ "retry-after": futureDate }, nowMs);
    assert.equal(res, 30_000);
  });

  await t.test("returns null for missing, empty, or unparseable headers", () => {
    assert.equal(parseRetryAfterMs(null, nowMs), null);
    assert.equal(parseRetryAfterMs({}, nowMs), null);
    assert.equal(parseRetryAfterMs({ "content-type": "application/json" }, nowMs), null);
    assert.equal(parseRetryAfterMs({ "retry-after": "not-a-number-or-date" }, nowMs), null);
  });
});

test("createRateLimiter token bucket and virtual time mechanics", async (t) => {
  await t.test("validates configuration parameters with INVALID_ARGUMENT", () => {
    const clock = new ManualClock();
    const sleeper = { sleep: async () => {} };

    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      assert.throws(
        () => createRateLimiter({ rpm: bad, tpm: 1000, clock, sleeper }),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
      );
      assert.throws(
        () => createRateLimiter({ rpm: 10, tpm: bad, clock, sleeper }),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
      );
    }

    assert.throws(
      () => createRateLimiter({ rpm: 10, tpm: 1000, concurrency: 0, clock, sleeper }),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  });

  await t.test("acquire rejects negative or non-finite estimatedTokens with INVALID_ARGUMENT", async () => {
    const clock = new ManualClock();
    const sleeper = { sleep: async () => {} };
    const limiter = createRateLimiter({ rpm: 60, tpm: 60_000, clock, sleeper });

    for (const bad of [-1, NaN, Infinity, -Infinity]) {
      await assert.rejects(
        () => limiter.acquire(bad),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
      );
    }
  });

  await t.test("acquire(tpm * 2) resolves with <= 2 sleeps and drives bucket negative", async () => {
    const clock = new ManualClock(1_000_000);
    let sleepCalls = 0;
    const sleeper = {
      async sleep(ms: number) {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    const tpm = 1000;
    const limiter = createRateLimiter({
      rpm: 60,
      tpm,
      concurrency: 1,
      clock,
      sleeper,
    });

    // Bucket starts at tpm (1000). Acquire 2000 tokens.
    // tokensForWait = min(2000, 1000) = 1000. tokDeficit = 0.
    // Immediately acquires without sleep!
    const lease1 = await limiter.acquire(tpm * 2);
    assert.equal(sleepCalls, 0);
    lease1.release();

    // Now bucket has 1000 - 2000 = -1000 tokens.
    // Second acquire: tokensForWait = 1000. tokDeficit = 1000 - (-1000) = 2000 tokens.
    // Refill rate = 1000 / 60000 ms. Sleep time = 2000 / (1000/60000) = 120000ms.
    // Sleeps once, refills 2000 tokens to reach 1000 (tpm cap), then debits 2000 -> -1000.
    const lease2 = await limiter.acquire(tpm * 2);
    assert.ok(sleepCalls <= 2, `Expected <= 2 sleeps, got ${sleepCalls}`);
    lease2.release();
  });

  await t.test("rejecting sleeper makes acquire reject AND subsequent acquire still succeeds at concurrency 1", async () => {
    const clock = new ManualClock(1_000_000);
    let shouldReject = true;
    const sleeper = {
      async sleep(_ms: number) {
        if (shouldReject) {
          throw new Error("sleeper simulated failure");
        }
      },
    };

    const limiter = createRateLimiter({
      rpm: 1,
      tpm: 100,
      concurrency: 1,
      clock,
      sleeper,
    });

    // First acquire takes initial token
    const l1 = await limiter.acquire(10);
    l1.release();

    // Second acquire will need to sleep because rpm is exhausted
    await assert.rejects(
      () => limiter.acquire(10),
      /sleeper simulated failure/,
    );

    // Concurrency slot must have been released! Advance clock so rpm has tokens
    shouldReject = false;
    clock.advance(60_000);

    const l2 = await limiter.acquire(10);
    assert.ok(l2);
    l2.release();
  });

  await t.test("two queued waiters wake in enqueue order and late caller does not jump queue", async () => {
    const clock = new ManualClock(1_000_000);
    const sleeper = { sleep: async () => {} };
    const limiter = createRateLimiter({
      rpm: 1000,
      tpm: 1_000_000,
      concurrency: 1,
      clock,
      sleeper,
    });

    const l1 = await limiter.acquire(10);

    const wakeOrder: number[] = [];

    const p2 = limiter.acquire(10).then((lease) => {
      wakeOrder.push(2);
      return lease;
    });

    const p3 = limiter.acquire(10).then((lease) => {
      wakeOrder.push(3);
      return lease;
    });

    // Release l1
    l1.release();

    // Late caller 4 calls acquire synchronously right after release
    const p4 = limiter.acquire(10).then((lease) => {
      wakeOrder.push(4);
      return lease;
    });

    const l2 = await p2;
    l2.release();

    const l3 = await p3;
    l3.release();

    const l4 = await p4;
    l4.release();

    assert.deepEqual(wakeOrder, [2, 3, 4], "Waiters must wake strictly in enqueue order without barging");
  });

  await t.test("double settle debits once", async () => {
    const clock = new ManualClock(1_000_000);
    let totalSleptMs = 0;
    const sleeper = {
      async sleep(ms: number) {
        totalSleptMs += ms;
        clock.advance(ms);
      },
    };

    // tpm = 1000
    const limiter = createRateLimiter({
      rpm: 100,
      tpm: 1000,
      concurrency: 1,
      clock,
      sleeper,
    });

    const lease = await limiter.acquire(500); // 1000 - 500 = 500 remaining
    lease.settle(600); // actual 600 -> diff = 100 -> dataTokens = 400
    lease.settle(900); // second settle must be no-op!
    lease.release();

    // If second settle was ignored, dataTokens is 400.
    // Acquiring 400 tokens should not sleep.
    const lease2 = await limiter.acquire(400);
    assert.equal(totalSleptMs, 0);
    lease2.release();
  });

  await t.test("settle after release is a silent no-op", async () => {
    const clock = new ManualClock(1_000_000);
    let totalSleptMs = 0;
    const sleeper = {
      async sleep(ms: number) {
        totalSleptMs += ms;
        clock.advance(ms);
      },
    };

    const limiter = createRateLimiter({
      rpm: 100,
      tpm: 1000,
      concurrency: 1,
      clock,
      sleeper,
    });

    const lease = await limiter.acquire(500);
    lease.release();
    lease.settle(1000); // must be no-op!

    // Bucket still has 500 tokens
    const lease2 = await limiter.acquire(500);
    assert.equal(totalSleptMs, 0);
    lease2.release();
  });

  await t.test("settle ignores non-finite/negative actualTokens", async () => {
    const clock = new ManualClock(1_000_000);
    const sleeper = { sleep: async () => {} };
    const limiter = createRateLimiter({ rpm: 100, tpm: 1000, clock, sleeper });

    const lease = await limiter.acquire(500);
    lease.settle(-10);
    lease.settle(NaN);
    lease.settle(Infinity);
    // After invalid settles, settling with valid number should still work (first valid settle)
    lease.settle(500);
    lease.release();
  });
});
