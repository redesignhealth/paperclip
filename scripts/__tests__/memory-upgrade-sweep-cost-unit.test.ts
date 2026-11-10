/**
 * Pure bigint nanodollar cost accounting unit tests (TECH-8191).
 *
 * These are pure, dependency-free tests (no embedded postgres, no network). The single
 * end-to-end multi-page accounting test that exercises runSweep() against an embedded
 * postgres fixture stays in memory-upgrade-sweep-orchestrator.test.ts alongside the rest of the
 * sweep orchestrator integration tests (real sweep call sites land in PR C).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CONVERSION_REJECT_CODES } from "../../server/src/services/company-memory-upgrade/converter-contract.js";
import {
  buildConversionRequestBody,
  buildInitialConversionMessages,
  buildRepairConversionMessages,
  createOpenAiConversionClient,
} from "../../server/src/services/company-memory-upgrade/llm-converter.js";
import { createRateLimiter } from "../../server/src/services/company-memory-upgrade/rate-limiter.js";
import { ManualClock } from "./memory-upgrade-sweep-helpers.js";
import {
  buildCostRatesNanodollars,
  ceilTokenCostNanodollars,
  createCostTracker,
  estimateWorstCaseSourceCostNanodollars,
  estimateWorstCaseSourceCostNanodollarsForText,
  MAX_USD_CAP,
  PREFLIGHT_MAX_EMBEDDING_CALLS,
  PREFLIGHT_MAX_OUTPUT_TOKENS_PER_CHAT_CALL,
  priceUsdPerMillionToNanodollars,
  projectWorstCaseConversionRequestBytes,
  usdToNanodollars,
  UTF8_MAX_BYTES_PER_CHAR,
  utf8ByteLength,
} from "../../server/src/services/company-memory-upgrade/cost.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("usdToNanodollars validates and converts USD amounts", () => {
  assert.equal(usdToNanodollars(0), 0n);
  assert.equal(usdToNanodollars(1), 1_000_000_000n);
  assert.equal(usdToNanodollars(0.15), 150_000_000n);
  assert.equal(usdToNanodollars(MAX_USD_CAP), BigInt(MAX_USD_CAP) * 1_000_000_000n);

  for (const bad of [-1, Infinity, -Infinity, NaN, MAX_USD_CAP + 1]) {
    assert.throws(
      () => usdToNanodollars(bad, "testField"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  }

  // Non-numbers must also be rejected without throwing an unrelated TypeError.
  for (const bad of ["1", null, undefined, {}] as any[]) {
    assert.throws(
      () => usdToNanodollars(bad, "testField"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  }
});

test("usdToNanodollars rounding mode: ceil (prices) vs floor (budget cap) differ on a fractional nanodollar", () => {
  // 1.5e-9 USD * 1e9 = 1.5 nanodollars -> ceil rounds up to 2, floor rounds down to 1.
  const usd = 1.5e-9;
  assert.equal(usdToNanodollars(usd, "field", "ceil"), 2n);
  assert.equal(usdToNanodollars(usd, "field", "floor"), 1n);
  // Default (no roundingMode arg) is ceil, matching the price-conversion contract.
  assert.equal(usdToNanodollars(usd, "field"), 2n);
});

test("createCostTracker uses FLOOR rounding for maxCostUsd so the budget cap never rounds UP", () => {
  const tracker = createCostTracker(1.5e-9); // 1.5 nanodollars -> floor = 1, never 2
  assert.equal(tracker.maxCostNanodollars, 1n);

  // An unbounded tracker (null/undefined maxCostUsd) has no cap and never blocks.
  const unbounded = createCostTracker(null);
  assert.equal(unbounded.maxCostNanodollars, null);
  const unboundedUndefined = createCostTracker(undefined);
  assert.equal(unboundedUndefined.maxCostNanodollars, null);
});

test("priceUsdPerMillionToNanodollars enforces the same cap as usdToNanodollars", () => {
  assert.equal(priceUsdPerMillionToNanodollars(0.15, "chatInputUsdPerMillion"), 150_000_000n);
  assert.throws(
    () => priceUsdPerMillionToNanodollars(MAX_USD_CAP + 1, "chatInputUsdPerMillion"),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
});

test("ceilTokenCostNanodollars: $0.15/M tokens is 150 nanodollars per token (NOT 1)", () => {
  // This is the canonical example cited by the finding: a naive "per-million-then-truncate"
  // calculation yields 1 nanodollar for a single token at $0.15/M tokens, which is wrong.
  // 1 token * 150_000_000 nanodollars-per-million / 1_000_000 = 150 nanodollars exactly.
  const ratePerMillion = priceUsdPerMillionToNanodollars(0.15, "chatInputUsdPerMillion");
  assert.equal(ratePerMillion, 150_000_000n);
  assert.equal(ceilTokenCostNanodollars(1, ratePerMillion), 150n);
  assert.equal(ceilTokenCostNanodollars(1_000_000, ratePerMillion), 150_000_000n);
  assert.equal(ceilTokenCostNanodollars(0, ratePerMillion), 0n);
});

test("ceilTokenCostNanodollars rounds UP (ceiling), never truncates a fractional nanodollar away", () => {
  // Use a sub-nanodollar-per-token rate so the division produces a genuine remainder:
  // rate = 1 nanodollar per million tokens -> 1 token costs 1/1_000_000 nanodollars, which
  // must ceiling-round UP to 1, never truncate down to 0.
  const subNanodollarRate = 1n; // 1 nanodollar per million tokens
  assert.equal(ceilTokenCostNanodollars(1, subNanodollarRate), 1n, "must round up, not truncate to 0");
  assert.equal(ceilTokenCostNanodollars(999_999, subNanodollarRate), 1n);
  assert.equal(ceilTokenCostNanodollars(1_000_000, subNanodollarRate), 1n, "exact division has no remainder to round up");
  assert.equal(ceilTokenCostNanodollars(1_000_001, subNanodollarRate), 2n);

  assert.throws(
    () => ceilTokenCostNanodollars(-1, 1n),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => ceilTokenCostNanodollars(1, -1n),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
  // Non-finite token counts are rejected rather than silently coerced.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => ceilTokenCostNanodollars(bad, 1n),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  }
});

test("utf8ByteLength is a conservative (>=) token-count proxy for multi-byte Unicode text", () => {
  assert.equal(utf8ByteLength(""), 0);
  assert.equal(utf8ByteLength(null), 0);
  assert.equal(utf8ByteLength(undefined), 0);
  assert.equal(utf8ByteLength("abcd"), 4); // ASCII: 1 byte/char
  // A fixed "charactersPerToken: 4 ASCII heuristic" (as used for the provisional census
  // estimator) would badly UNDERCOUNT this CJK string -- each of these characters is 3
  // bytes in UTF-8, nowhere near "4 chars per token".
  const cjk = "田中太郎様";
  assert.equal(utf8ByteLength(cjk), cjk.length * 3);
  assert.ok(utf8ByteLength(cjk) > cjk.length, "multi-byte text must project MORE bytes than characters");
});

test("estimateWorstCaseSourceCostNanodollarsForText: embedding projection is conservative for 400-char Unicode, not a 100-token ASCII heuristic", () => {
  const rates = buildCostRatesNanodollars({
    chatInputUsdPerMillion: 0.15,
    chatOutputUsdPerMillion: 0.6,
    embeddingUsdPerMillion: 0.02,
  });

  const shortAscii = "short memory";
  const estimate = estimateWorstCaseSourceCostNanodollarsForText(shortAscii, "gpt-5.4-mini", rates);

  // The OLD flawed heuristic: 400 chars / 4 chars-per-token = 100 tokens per record. The
  // worst-case embedding projection here must be far larger: 400 chars * 4 bytes/char
  // (UTF8_MAX_BYTES_PER_CHAR, a conservative Unicode ceiling) per record, times up to
  // PREFLIGHT_MAX_EMBEDDING_CALLS records.
  const flawedAsciiHeuristicTokens = 100 * PREFLIGHT_MAX_EMBEDDING_CALLS;
  assert.ok(
    estimate.projectedEmbeddingTokens > flawedAsciiHeuristicTokens,
    `projected embedding tokens (${estimate.projectedEmbeddingTokens}) must exceed the flawed 100-token ASCII heuristic (${flawedAsciiHeuristicTokens})`,
  );
  assert.equal(estimate.projectedEmbeddingTokens, 400 * UTF8_MAX_BYTES_PER_CHAR * PREFLIGHT_MAX_EMBEDDING_CALLS);

  // Preflight must be computed BEFORE any key resolution or paid call; it is purely a
  // function of (sourceText, model, rates) -- call it twice and confirm determinism.
  const estimate2 = estimateWorstCaseSourceCostNanodollarsForText(shortAscii, "gpt-5.4-mini", rates);
  assert.deepEqual(estimate, estimate2);
  assert.ok(estimate.worstCaseNanodollars > 0n);
});

test("estimateWorstCaseSourceCostNanodollarsForText includes real serialized chat request overhead (prompt/wrapper/repair), not a guessed constant", () => {
  const rates = buildCostRatesNanodollars({
    chatInputUsdPerMillion: 0.15,
    chatOutputUsdPerMillion: 0.6,
    embeddingUsdPerMillion: 0.02,
  });

  const empty = estimateWorstCaseSourceCostNanodollarsForText("", "gpt-5.4-mini", rates);
  const longer = estimateWorstCaseSourceCostNanodollarsForText("x".repeat(2000), "gpt-5.4-mini", rates);

  // Even with EMPTY source text, the projected input tokens must reflect the real system
  // prompt + schema + wrapper tags + repair-turn overhead (not zero).
  assert.ok(empty.projectedChatInputTokens > 0);
  // Longer source text must increase the projection (wrapper overhead is additive, not
  // replacing the source text).
  assert.ok(longer.projectedChatInputTokens > empty.projectedChatInputTokens);
});

test("estimateWorstCaseSourceCostNanodollars direct calculation", () => {
  const rates = buildCostRatesNanodollars({
    chatInputUsdPerMillion: 0.15,
    chatOutputUsdPerMillion: 0.6,
    embeddingUsdPerMillion: 0.02,
  });

  const estimate = estimateWorstCaseSourceCostNanodollars({
    initialRequestBodyBytes: 1000,
    repairRequestBodyBytes: 2000,
    rates,
  });

  assert.equal(estimate.projectedChatInputTokens, 3000);
  assert.equal(estimate.projectedChatOutputTokens, 1200); // 600 * 2
  assert.equal(estimate.projectedEmbeddingTokens, 4800); // 400 * 4 * 3

  // chatInputCost: ceilTokenCostNanodollars(3000, 150_000_000) = 3000 * 150 = 450,000 nanodollars
  // chatOutputCost: ceilTokenCostNanodollars(1200, 600_000_000) = 1200 * 600 = 720,000 nanodollars
  // embeddingCost: ceilTokenCostNanodollars(4800, 20_000_000) = 4800 * 20 = 96,000 nanodollars
  // worstCaseNanodollars: 450,000 + 720,000 + 96,000 = 1,266,000n
  assert.equal(estimate.worstCaseNanodollars, 1_266_000n);
});

test("projectWorstCaseConversionRequestBytes sizes the repair body using the LONGEST CONVERSION_REJECT_CODE, not a hardcoded 15-char placeholder", () => {
  const longestRejectCode = CONVERSION_REJECT_CODES.reduce(
    (longest, code) => (code.length > longest.length ? code : longest),
    "",
  );
  // "records_not_empty_on_drop" (25 chars) is the actual longest reject code, well past the
  // old hardcoded "data_not_atomic" (15 chars) that this finding flagged as an undercount.
  assert.equal(longestRejectCode, "records_not_empty_on_drop");
  assert.equal(longestRejectCode.length, 25);

  const { repairRequestBodyBytes } = projectWorstCaseConversionRequestBytes("", "gpt-5.4-mini");

  // Reconstruct the expected worst-case repair body using the real longest reject code and
  // confirm a byte-for-byte match -- proving the projection derives the placeholder from
  // CONVERSION_REJECT_CODES at module load rather than a shorter hardcoded literal.
  const initialMessages = buildInitialConversionMessages("");
  const worstCaseEchoBytes = PREFLIGHT_MAX_OUTPUT_TOKENS_PER_CHAT_CALL * UTF8_MAX_BYTES_PER_CHAR;
  const placeholder = "x".repeat(worstCaseEchoBytes);
  const expectedRepairMessages = buildRepairConversionMessages(initialMessages, placeholder, longestRejectCode);
  const expectedBody = buildConversionRequestBody("gpt-5.4-mini", expectedRepairMessages);
  assert.equal(repairRequestBodyBytes, utf8ByteLength(expectedBody));

  // Confirm the real projection is strictly larger than what the old hardcoded 15-char
  // "data_not_atomic" placeholder would have produced (an undercount of the worst case).
  const shorterRepairMessages = buildRepairConversionMessages(initialMessages, placeholder, "data_not_atomic");
  const shorterBody = buildConversionRequestBody("gpt-5.4-mini", shorterRepairMessages);
  assert.ok(
    repairRequestBodyBytes > utf8ByteLength(shorterBody),
    "projection using the longest reject code must exceed the old hardcoded data_not_atomic placeholder",
  );
});

test("createCostTracker: budget cap blocks before any spend is recorded (preflight ceiling)", () => {
  const tracker = createCostTracker(0.000000001); // 1 nanodollar cap
  assert.throws(
    () => tracker.assertBudgetAllows(1_000_000n),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "ABORTED_BY_OPERATOR",
  );
  // Nothing was ever recorded as spent.
  assert.equal(tracker.spentNanodollars, 0n);
  assert.equal(tracker.pageCostNanodollars, 0n);
});

test("createCostTracker: assertBudgetAllows permits an exact match to the budget (meet-or-exceed is a deliberate boundary choice)", () => {
  const tracker = createCostTracker(0.000000001); // 1 nanodollar cap
  // Exactly at budget: must NOT throw (code checks strictly-greater-than, not >=).
  tracker.assertBudgetAllows(1n);
  tracker.addActualCostNanodollars(1n);
  assert.equal(tracker.spentNanodollars, 1n);
  // One nanodollar over: must throw.
  assert.throws(
    () => tracker.assertBudgetAllows(1n),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "ABORTED_BY_OPERATOR",
  );
});

test("createCostTracker: unbounded tracker (null maxCostUsd) never blocks", () => {
  const tracker = createCostTracker(null);
  tracker.assertBudgetAllows(1_000_000_000_000n);
  tracker.addActualCostNanodollars(500n);
  assert.equal(tracker.spentNanodollars, 500n);
});

test("createCostTracker: page delta is reset ONLY via resetPageDelta, and is independent of cumulative spend", () => {
  const tracker = createCostTracker(null);
  tracker.addActualCostNanodollars(100n);
  assert.equal(tracker.pageCostNanodollars, 100n);
  assert.equal(tracker.spentNanodollars, 100n);

  // Simulate a successful flush: read the delta, THEN reset.
  const flushed = tracker.pageCostNanodollars;
  assert.equal(flushed, 100n);
  tracker.resetPageDelta();
  assert.equal(tracker.pageCostNanodollars, 0n);
  // Cumulative total is untouched by resetting the page delta.
  assert.equal(tracker.spentNanodollars, 100n);

  // Second page's spend must be its OWN delta, never the cumulative total re-flushed.
  tracker.addActualCostNanodollars(40n);
  assert.equal(tracker.pageCostNanodollars, 40n, "page 2 delta must be 40, not 140 (cumulative)");
  assert.equal(tracker.spentNanodollars, 140n);
});

test("createCostTracker: addActualCostNanodollars and assertBudgetAllows reject negative nanodollar deltas", () => {
  const tracker = createCostTracker(1);
  assert.throws(
    () => tracker.addActualCostNanodollars(-1n),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => tracker.assertBudgetAllows(-1n),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
});

test("regression guard: quote-heavy/control/multibyte schema-invalid call 1 ensures oversize repair is never sent and first usage counted within preflight projection", async () => {
  const model = "gpt-5.4-mini";
  const sourceText = "A complex user instruction containing multiple facts that require conversion.";
  const { initialRequestBodyBytes, repairRequestBodyBytes } = projectWorstCaseConversionRequestBytes(
    sourceText,
    model,
  );
  const worstCaseInputCap = initialRequestBodyBytes + repairRequestBodyBytes;

  const clock = new ManualClock();
  const limiter = createRateLimiter({
    rpm: 10_000,
    tpm: 1_000_000,
    concurrency: 2,
    clock,
    sleeper: clock,
  });

  let callCount = 0;
  const oversizeSchemaInvalidContent = JSON.stringify({
    invalid: "\"".repeat(1500) + "\n\t".repeat(500) + "日本語漢字🎉".repeat(300),
  });

  const customFetch: typeof fetch = async () => {
    callCount++;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: oversizeSchemaInvalidContent } }],
        usage: { prompt_tokens: 140, completion_tokens: 600 },
      }),
    } as any;
  };

  const client = createOpenAiConversionClient({
    apiKey: "sk-test-key-cost-unit-guard",
    model,
    fetchImpl: customFetch,
    limiter,
    sleeper: clock,
    clock,
  });

  const res = await client.convert(sourceText);

  assert.equal(callCount, 1, "Oversize repair request must never be sent");
  assert.equal(res.status, "quarantined");
  assert.equal(res.rejectCode, "decision_invalid");
  assert.equal(res.inputTokens, 140, "Only first-call input tokens counted");
  assert.equal(res.outputTokens, 600, "Only first-call output tokens counted");
  assert.ok(
    res.inputTokens <= worstCaseInputCap,
    `reported inputTokens (${res.inputTokens}) must not exceed preflight projection (${worstCaseInputCap})`,
  );
  assert.ok(
    res.outputTokens <= 1200,
    `reported outputTokens (${res.outputTokens}) must not exceed 2 * 600 = 1200`,
  );
});

test("regression guard: actual within-bound repair with unreadable call 2 reports both calls within preflight projection", async () => {
  const model = "gpt-5.4-mini";
  const sourceText = "A complex user instruction containing multiple facts that require conversion.";
  const { initialRequestBodyBytes, repairRequestBodyBytes } = projectWorstCaseConversionRequestBytes(
    sourceText,
    model,
  );
  const worstCaseInputCap = initialRequestBodyBytes + repairRequestBodyBytes;

  const clock = new ManualClock();
  const limiter = createRateLimiter({
    rpm: 10_000,
    tpm: 1_000_000,
    concurrency: 2,
    clock,
    sleeper: clock,
  });

  let callCount = 0;
  const requests: Array<{ body: string }> = [];

  const withinBoundSchemaInvalid = JSON.stringify({ invalid: "short text" });

  const customFetch: typeof fetch = async (_url, init) => {
    callCount++;
    requests.push({ body: String(init?.body ?? "") });
    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: withinBoundSchemaInvalid } }],
          usage: { prompt_tokens: 110, completion_tokens: 35 },
        }),
      } as any;
    }
    // Call 2: HTTP 200 with unreadable body (billed_unusable)
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new Error("Premature EOF on unreadable body");
      },
    } as any;
  };

  const client = createOpenAiConversionClient({
    apiKey: "sk-test-key-cost-unit-guard",
    model,
    fetchImpl: customFetch,
    limiter,
    sleeper: clock,
    clock,
    maxAttempts: 3,
  });

  const res = await client.convert(sourceText);

  assert.equal(callCount, 2, "Both initial and repair calls must be made when within bound");
  assert.equal(res.status, "quarantined");
  assert.equal(res.rejectCode, "llm_unavailable");

  const call2BodyBytes = Buffer.byteLength(requests[1].body, "utf8");
  assert.equal(res.inputTokens, 110 + call2BodyBytes);
  assert.equal(res.outputTokens, 35 + 600);

  assert.ok(
    res.inputTokens <= worstCaseInputCap,
    `totalInputTokens (${res.inputTokens}) must not exceed preflight projection (${worstCaseInputCap})`,
  );
  assert.ok(
    res.outputTokens <= 1200,
    `totalOutputTokens (${res.outputTokens}) must not exceed 2 * 600 = 1200`,
  );
});
