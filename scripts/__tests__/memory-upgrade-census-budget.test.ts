import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONVERSION_BUDGET_CONSTANTS,
  DEFAULT_ATOMIC_EMBEDDING_TOKENS_PER_ROW,
  estimateConversionBudget,
  formatDurationHuman,
} from "../../server/src/services/company-memory-upgrade/budget.js";
import {
  formatCostUsd,
} from "../../server/src/services/company-memory-upgrade/census.js";

describe("estimateConversionBudget unit tests", () => {
  it("produces zero cost and zero time for zero rows", () => {
    const budget = estimateConversionBudget({
      totalRows: 0,
      noiseRowsInRoutable: 0,
      unroutableRows: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 0,
    });

    assert.equal(budget.rowsToConvert, 0);
    assert.equal(budget.estimatedCostUsd.total, 0);
    assert.equal(budget.estimatedWallClock.seconds, 0);
    assert.equal(budget.estimatedWallClock.bottleneck, "none");
    assert.equal(budget.isEstimate, true);
  });

  it("reconciliation breakdown correctly accounts for disjoint rows and supports legacy subtractions", () => {
    const budget = estimateConversionBudget({
      totalRows: 1000,
      rowsToConvert: 700,
      unroutableRows: 150,
      noiseRowsInRoutable: 100,
      duplicateSurplusInRoutable: 50,
      averageTextLength: 120,
    });

    assert.equal(budget.rowsToConvert, 700);
    assert.equal(budget.breakdown.totalRows, 1000);
    assert.equal(budget.breakdown.rowsToConvert, 700);
    assert.equal(budget.breakdown.unroutableRows, 150);
    assert.equal(budget.breakdown.noiseRowsInRoutable, 100);
    assert.equal(budget.breakdown.duplicateSurplusInRoutable, 50);

    // Exact reconciliation
    assert.equal(
      budget.breakdown.rowsToConvert +
        budget.breakdown.unroutableRows +
        budget.breakdown.noiseRowsInRoutable +
        budget.breakdown.duplicateSurplusInRoutable,
      budget.breakdown.totalRows,
    );

    // Legacy subtractions compatibility
    assert.equal(budget.subtractions.totalRows, 1000);
    assert.equal(budget.subtractions.noiseRows, 100);
    assert.equal(budget.subtractions.unroutableRows, 150);
    assert.equal(budget.subtractions.duplicateSurplusRows, 50);
  });

  it("handles overlap matrix where rows are simultaneously noise, duplicate, and unroutable", () => {
    // Overlap matrix scenario:
    // If a simple 3-way subtraction were used:
    // total(10) - noise(4) - unroutable(6) - duplicates(4) would equal -4!
    // With disjoint accounting:
    // unroutable: 6 rows (including 2 that are noise and 2 that are duplicates)
    // noiseInRoutable: 2 rows (including 1 duplicate of noise that is NOT counted in duplicate surplus)
    // duplicateSurplusInRoutable: 1 row (duplicate of substantive row)
    // rowsToConvert: 1 row (the 1 unique substantive row)
    // Total = 1 + 6 + 2 + 1 = 10!
    const budget = estimateConversionBudget({
      totalRows: 10,
      rowsToConvert: 1,
      unroutableRows: 6,
      noiseRowsInRoutable: 2,
      duplicateSurplusInRoutable: 1,
      averageTextLength: 80,
    });

    assert.equal(budget.rowsToConvert, 1);
    assert.equal(
      budget.breakdown.rowsToConvert +
        budget.breakdown.unroutableRows +
        budget.breakdown.noiseRowsInRoutable +
        budget.breakdown.duplicateSurplusInRoutable,
      10,
    );
  });

  it("exhibits cost monotonicity with increasing rows", () => {
    const b1 = estimateConversionBudget({
      totalRows: 500,
      noiseRowsInRoutable: 0,
      unroutableRows: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 100,
    });

    const b2 = estimateConversionBudget({
      totalRows: 1000,
      noiseRowsInRoutable: 0,
      unroutableRows: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 100,
    });

    assert.ok(b2.estimatedCostUsd.total > b1.estimatedCostUsd.total);
    assert.ok(b2.estimatedTokens.chatTotal > b1.estimatedTokens.chatTotal);
    assert.ok(b2.estimatedTokens.embeddingTotal > b1.estimatedTokens.embeddingTotal);
  });

  it("exhibits token and cost monotonicity with increasing text length", () => {
    const bShort = estimateConversionBudget({
      totalRows: 1000,
      noiseRowsInRoutable: 0,
      unroutableRows: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 50,
    });

    const bLong = estimateConversionBudget({
      totalRows: 1000,
      noiseRowsInRoutable: 0,
      unroutableRows: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 800,
    });

    assert.ok(bLong.estimatedCostUsd.total > bShort.estimatedCostUsd.total);
    assert.ok(bLong.estimatedTokens.chatInput > bShort.estimatedTokens.chatInput);
  });

  it("correctly identifies which of the 4 rate limit caps binds (chat_rpm, chat_tpm, embedding_rpm, embedding_tpm)", () => {
    // 1. chat_tpm binds (default normal run: ~625 tokens per row against 200k TPM cap)
    const bTpm = estimateConversionBudget({
      totalRows: 1000,
      rowsToConvert: 1000,
      unroutableRows: 0,
      noiseRowsInRoutable: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 100,
    });
    assert.equal(bTpm.estimatedWallClock.bindingCap, "chat_tpm");
    assert.equal(bTpm.estimatedWallClock.bottleneck, "chat_tpm");
    assert.ok(bTpm.estimatedWallClock.label.includes("rate-limit floor"));
    assert.equal((bTpm.estimatedWallClock as any).concurrency, undefined);

    // 2. chat_rpm binds when chatRpmCap is lowered relative to TPM
    const bChatRpm = estimateConversionBudget({
      totalRows: 1000,
      rowsToConvert: 1000,
      unroutableRows: 0,
      noiseRowsInRoutable: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 20,
      chatRpmCap: 10, // strict 10 RPM -> 1000 rows = 6000s
    });
    assert.equal(bChatRpm.estimatedWallClock.bindingCap, "chat_rpm");

    // 3. embedding_rpm binds when embeddingRpmCap is lowest
    const bEmbRpm = estimateConversionBudget({
      totalRows: 1000,
      rowsToConvert: 1000,
      unroutableRows: 0,
      noiseRowsInRoutable: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 20,
      chatRpmCap: 10_000,
      chatTpmCap: 10_000_000,
      embeddingRpmCap: 5, // 5 RPM -> 12000s
    });
    assert.equal(bEmbRpm.estimatedWallClock.bindingCap, "embedding_rpm");

    // 4. embedding_tpm binds when embeddingTpmCap is lowest
    const bEmbTpm = estimateConversionBudget({
      totalRows: 1000,
      rowsToConvert: 1000,
      unroutableRows: 0,
      noiseRowsInRoutable: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 20,
      chatRpmCap: 10_000,
      chatTpmCap: 10_000_000,
      embeddingRpmCap: 10_000,
      embeddingTpmCap: 100, // 100 TPM -> 80,000 tokens = 48000s
    });
    assert.equal(bEmbTpm.estimatedWallClock.bindingCap, "embedding_tpm");
  });

  it("validates budget inputs rejecting negative, NaN, and non-finite values", () => {
    assert.throws(
      () => estimateConversionBudget({ totalRows: -1, averageTextLength: 50 }),
      /Invalid budget input "totalRows": must be a finite non-negative number/,
    );
    assert.throws(
      () => estimateConversionBudget({ totalRows: NaN, averageTextLength: 50 }),
      /Invalid budget input "totalRows": must be a finite non-negative number/,
    );
    assert.throws(
      () => estimateConversionBudget({ totalRows: 100, averageTextLength: Infinity }),
      /Invalid budget input "averageTextLength": must be a finite non-negative number/,
    );
    assert.throws(
      () => estimateConversionBudget({ totalRows: 100, averageTextLength: 50, chatInputUsdPerMillion: -0.5 }),
      /Invalid budget input "chatInputUsdPerMillion": must be a finite non-negative number/,
    );
    assert.throws(
      () => estimateConversionBudget({ totalRows: 100, averageTextLength: 50, chatRpmCap: 0 }),
      (err: any) => err.code === "INVALID_ARGUMENT" && /must be a finite positive number/.test(err.message),
    );
    assert.throws(
      () => estimateConversionBudget({ totalRows: 100, averageTextLength: 50, chatRpmCap: -10 }),
      (err: any) => err.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => estimateConversionBudget({ totalRows: 100, averageTextLength: 50, chatTpmCap: NaN }),
      (err: any) => err.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => estimateConversionBudget({ totalRows: 100, averageTextLength: 50, embeddingRpmCap: 0 }),
      (err: any) => err.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => estimateConversionBudget({ totalRows: 100, averageTextLength: 50, embeddingTpmCap: -1 }),
      (err: any) => err.code === "INVALID_ARGUMENT",
    );
  });

  it("preserves full precision internally and formats tiny runs properly without showing $0.0000", () => {
    // 1 row run
    const bTiny = estimateConversionBudget({
      totalRows: 1,
      rowsToConvert: 1,
      unroutableRows: 0,
      noiseRowsInRoutable: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 40,
    });
    assert.ok(bTiny.estimatedCostUsd.total > 0);
    // Full precision raw number
    assert.ok(bTiny.estimatedCostUsd.total < 0.001);

    // formatCostUsd does not display $0.0000 for non-zero cost
    const formatted = formatCostUsd(bTiny.estimatedCostUsd.total);
    assert.notEqual(formatted, "$0.0000");
    assert.ok(formatted.startsWith("$"));
  });

  it("supports overridable pricing rates and labels defaults honestly", () => {
    // Defaults label
    const bDef = estimateConversionBudget({
      totalRows: 10,
      rowsToConvert: 10,
      unroutableRows: 0,
      noiseRowsInRoutable: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 40,
    });
    assert.equal(bDef.pricingSource, "unverified defaults — confirm against the approved rate card");

    // Overridden pricing
    const bCustom = estimateConversionBudget({
      totalRows: 10,
      rowsToConvert: 10,
      unroutableRows: 0,
      noiseRowsInRoutable: 0,
      duplicateSurplusInRoutable: 0,
      averageTextLength: 40,
      chatInputUsdPerMillion: 2.50,
      chatOutputUsdPerMillion: 10.00,
      embeddingUsdPerMillion: 0.10,
    });
    assert.equal(bCustom.pricingSource, "operator pricing override");
    assert.ok(bCustom.estimatedCostUsd.total > bDef.estimatedCostUsd.total);
  });

  it("documents embedding tokens assumption via DEFAULT_ATOMIC_EMBEDDING_TOKENS_PER_ROW", () => {
    assert.equal(DEFAULT_ATOMIC_EMBEDDING_TOKENS_PER_ROW, 80);
    assert.equal(CONVERSION_BUDGET_CONSTANTS.atomicEmbeddingTokensPerRow, 80);
  });

  it("formats human duration string properly", () => {
    assert.equal(formatDurationHuman(0), "0s");
    assert.equal(formatDurationHuman(45), "45s");
    assert.equal(formatDurationHuman(59.4), "59s");
    assert.equal(formatDurationHuman(59.6), "1m");
    assert.equal(formatDurationHuman(60), "1m");
    assert.equal(formatDurationHuman(119.6), "2m");
    assert.equal(formatDurationHuman(125), "2m 5s");
  });
});
