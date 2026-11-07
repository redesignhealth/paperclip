/**
 * Conversion budget and time estimator (TECH-8191).
 *
 * Estimates LLM token usage, API costs, and wall-clock rate-limit floor for an offline conversion sweep.
 * All figures produced here are clearly labelled as planning ESTIMATES.
 */

import { CompanyMemoryUpgradeError } from "./types.js";

/**
 * Assumed tokens per converted atomic memory sentence for text-embedding-3-small.
 * During upgrade conversion sweeps, source text is split/summarized into atomic factual
 * sentences (~80 tokens each) prior to generating target embeddings.
 */
export const DEFAULT_ATOMIC_EMBEDDING_TOKENS_PER_ROW = 80;

export const DEFAULT_PRICING_LABEL = "unverified defaults — confirm against the approved rate card";

/**
 * Operator-maintained rate, token, and cost constants for company memory conversion sweeps.
 * Kept in one exported const; update here when model pricing or quota tiers change.
 * Pricing defaults match standard gpt-4o-mini / gpt-5.4-mini tier rates.
 */
export const CONVERSION_BUDGET_CONSTANTS = {
  // Fixed token model per row:
  // ~600 input tokens for system prompt + conversion schema instructions
  // ~80 output tokens for atomic sentence generation
  fixedInputTokensPerRow: 600,
  fixedOutputTokensPerRow: 80,
  atomicEmbeddingTokensPerRow: DEFAULT_ATOMIC_EMBEDDING_TOKENS_PER_ROW,

  // Character-to-token heuristic for original text token overhead
  charactersPerToken: 4,

  // Model pricing in USD per 1M tokens
  pricing: {
    // Chat conversion model (gpt-5.4-mini / gpt-4o-mini rate equivalent)
    chatInputUsdPerMillion: 0.15,
    chatOutputUsdPerMillion: 0.60,
    // Embedding model (text-embedding-3-small, 1536 dims)
    embeddingUsdPerMillion: 0.02,
  },

  // Quota rate limits (per minute)
  rateLimits: {
    // Chat rate limit caps
    chatRpmCap: 500,
    chatTpmCap: 200_000,
    // Embedding rate limit caps
    embeddingRpmCap: 3_000,
    embeddingTpmCap: 1_000_000,
  },
} as const;

export interface ConversionReconciliationBreakdown {
  totalRows: number;
  rowsToConvert: number;
  unroutableRows: number;
  noiseRowsInRoutable: number;
  duplicateSurplusInRoutable: number;
}

export interface BudgetEstimateInput {
  totalRows: number;
  rowsToConvert?: number;
  unroutableRows?: number;
  noiseRowsInRoutable?: number;
  duplicateSurplusInRoutable?: number;
  // Legacy input fields support
  noiseRows?: number;
  duplicateSurplusRows?: number;
  averageTextLength: number;
  basis?: "verified" | "provisional";
  bound?: "exact" | "upper_bound";
  boundDescription?: string;
  chatInputUsdPerMillion?: number;
  chatOutputUsdPerMillion?: number;
  embeddingUsdPerMillion?: number;
  chatRpmCap?: number;
  chatTpmCap?: number;
  embeddingRpmCap?: number;
  embeddingTpmCap?: number;
}

export type BindingRateLimitCap = "chat_rpm" | "chat_tpm" | "embedding_rpm" | "embedding_tpm" | "none";

export interface ConversionBudgetEstimate {
  isEstimate: true;
  basis: "verified" | "provisional";
  bound?: "exact" | "upper_bound";
  boundDescription: string;
  rowsToConvert: number;
  breakdown: ConversionReconciliationBreakdown;
  subtractions: {
    totalRows: number;
    noiseRows: number;
    unroutableRows: number;
    duplicateSurplusRows: number;
  };
  tokenModel: {
    fixedInputPerRow: number;
    fixedOutputPerRow: number;
    estimatedSourceTokensPerRow: number;
    totalInputPerRow: number;
    totalOutputPerRow: number;
    embeddingTokensPerRow: number;
  };
  estimatedTokens: {
    chatInput: number;
    chatOutput: number;
    chatTotal: number;
    embeddingTotal: number;
  };
  pricingSource: string;
  estimatedCostUsd: {
    chat: number;
    embedding: number;
    total: number;
  };
  estimatedWallClock: {
    rateLimitFloorSeconds: number;
    seconds: number;
    humanReadable: string;
    bindingCap: BindingRateLimitCap;
    bottleneck: BindingRateLimitCap;
    label: string;
    durations: {
      chatRpmSeconds: number;
      chatTpmSeconds: number;
      embeddingRpmSeconds: number;
      embeddingTpmSeconds: number;
    };
  };
  constants: typeof CONVERSION_BUDGET_CONSTANTS;
}

export function formatDurationHuman(seconds: number): string {
  if (seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) {
    return `${s}s`;
  }
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function assertValidBudgetNumber(val: unknown, name: string): void {
  if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val) || val < 0) {
    throw new CompanyMemoryUpgradeError(
      `Invalid budget input "${name}": must be a finite non-negative number, found ${val}.`,
      "INVALID_ARGUMENT",
    );
  }
}

/**
 * Calculates conversion budget, cost, and rate-limit floor wall-clock estimates.
 */
export function estimateConversionBudget(input: BudgetEstimateInput): ConversionBudgetEstimate {
  const { totalRows, averageTextLength } = input;

  assertValidBudgetNumber(totalRows, "totalRows");
  assertValidBudgetNumber(averageTextLength, "averageTextLength");

  if (input.rowsToConvert !== undefined) assertValidBudgetNumber(input.rowsToConvert, "rowsToConvert");
  if (input.unroutableRows !== undefined) assertValidBudgetNumber(input.unroutableRows, "unroutableRows");
  if (input.noiseRowsInRoutable !== undefined) assertValidBudgetNumber(input.noiseRowsInRoutable, "noiseRowsInRoutable");
  if (input.duplicateSurplusInRoutable !== undefined) assertValidBudgetNumber(input.duplicateSurplusInRoutable, "duplicateSurplusInRoutable");
  if (input.noiseRows !== undefined) assertValidBudgetNumber(input.noiseRows, "noiseRows");
  if (input.duplicateSurplusRows !== undefined) assertValidBudgetNumber(input.duplicateSurplusRows, "duplicateSurplusRows");
  if (input.chatInputUsdPerMillion !== undefined) assertValidBudgetNumber(input.chatInputUsdPerMillion, "chatInputUsdPerMillion");
  if (input.chatOutputUsdPerMillion !== undefined) assertValidBudgetNumber(input.chatOutputUsdPerMillion, "chatOutputUsdPerMillion");
  if (input.embeddingUsdPerMillion !== undefined) assertValidBudgetNumber(input.embeddingUsdPerMillion, "embeddingUsdPerMillion");

  let rowsToConvert = input.rowsToConvert;
  const unroutableRows = input.unroutableRows ?? 0;
  const noiseRowsInRoutable = input.noiseRowsInRoutable ?? input.noiseRows ?? 0;
  const duplicateSurplusInRoutable = input.duplicateSurplusInRoutable ?? input.duplicateSurplusRows ?? 0;

  if (rowsToConvert === undefined) {
    rowsToConvert = Math.max(0, totalRows - noiseRowsInRoutable - unroutableRows - duplicateSurplusInRoutable);
  }

  const basis = input.basis ?? "verified";
  const bound = input.bound ?? (basis === "verified" ? "exact" : "upper_bound");
  const boundDescription = input.boundDescription ?? (
    basis === "verified"
      ? "Exact conversion volume verified against control plane agent routing."
      : "Upper bound estimate: assumes all syntactically valid agents are routable."
  );

  const breakdown: ConversionReconciliationBreakdown = {
    totalRows,
    rowsToConvert,
    unroutableRows,
    noiseRowsInRoutable,
    duplicateSurplusInRoutable,
  };

  const sourceTokensPerRow = Math.max(
    0,
    Math.ceil(averageTextLength / CONVERSION_BUDGET_CONSTANTS.charactersPerToken),
  );

  const inputPerRow = CONVERSION_BUDGET_CONSTANTS.fixedInputTokensPerRow + sourceTokensPerRow;
  const outputPerRow = CONVERSION_BUDGET_CONSTANTS.fixedOutputTokensPerRow;
  const embeddingPerRow = CONVERSION_BUDGET_CONSTANTS.atomicEmbeddingTokensPerRow;

  const chatInputTokens = rowsToConvert * inputPerRow;
  const chatOutputTokens = rowsToConvert * outputPerRow;
  const chatTotalTokens = chatInputTokens + chatOutputTokens;
  const embeddingTotalTokens = rowsToConvert * embeddingPerRow;

  // Pricing rates (overridable)
  const isPricingOverridden =
    input.chatInputUsdPerMillion !== undefined ||
    input.chatOutputUsdPerMillion !== undefined ||
    input.embeddingUsdPerMillion !== undefined;

  const chatInputRate = input.chatInputUsdPerMillion ?? CONVERSION_BUDGET_CONSTANTS.pricing.chatInputUsdPerMillion;
  const chatOutputRate = input.chatOutputUsdPerMillion ?? CONVERSION_BUDGET_CONSTANTS.pricing.chatOutputUsdPerMillion;
  const embeddingRate = input.embeddingUsdPerMillion ?? CONVERSION_BUDGET_CONSTANTS.pricing.embeddingUsdPerMillion;

  const pricingSource = isPricingOverridden
    ? "operator pricing override"
    : DEFAULT_PRICING_LABEL;

  // Keep full precision internally
  const chatCost = (chatInputTokens / 1_000_000) * chatInputRate + (chatOutputTokens / 1_000_000) * chatOutputRate;
  const embeddingCost = (embeddingTotalTokens / 1_000_000) * embeddingRate;
  const totalCost = chatCost + embeddingCost;

  // Wall-clock rate-limit floor: max(chatRpm, chatTpm, embeddingRpm, embeddingTpm)
  const chatRpmCap = input.chatRpmCap ?? CONVERSION_BUDGET_CONSTANTS.rateLimits.chatRpmCap;
  const chatTpmCap = input.chatTpmCap ?? CONVERSION_BUDGET_CONSTANTS.rateLimits.chatTpmCap;
  const embeddingRpmCap = input.embeddingRpmCap ?? CONVERSION_BUDGET_CONSTANTS.rateLimits.embeddingRpmCap;
  const embeddingTpmCap = input.embeddingTpmCap ?? CONVERSION_BUDGET_CONSTANTS.rateLimits.embeddingTpmCap;

  let chatRpmDurationSeconds = 0;
  let chatTpmDurationSeconds = 0;
  let embeddingRpmDurationSeconds = 0;
  let embeddingTpmDurationSeconds = 0;
  let rateLimitFloorSeconds = 0;
  let bindingCap: BindingRateLimitCap = "none";

  if (rowsToConvert > 0) {
    chatRpmDurationSeconds = (rowsToConvert / chatRpmCap) * 60;
    chatTpmDurationSeconds = (chatTotalTokens / chatTpmCap) * 60;
    embeddingRpmDurationSeconds = (rowsToConvert / embeddingRpmCap) * 60;
    embeddingTpmDurationSeconds = (embeddingTotalTokens / embeddingTpmCap) * 60;

    rateLimitFloorSeconds = Math.max(
      chatRpmDurationSeconds,
      chatTpmDurationSeconds,
      embeddingRpmDurationSeconds,
      embeddingTpmDurationSeconds,
    );

    if (rateLimitFloorSeconds === chatRpmDurationSeconds) {
      bindingCap = "chat_rpm";
    } else if (rateLimitFloorSeconds === chatTpmDurationSeconds) {
      bindingCap = "chat_tpm";
    } else if (rateLimitFloorSeconds === embeddingRpmDurationSeconds) {
      bindingCap = "embedding_rpm";
    } else {
      bindingCap = "embedding_tpm";
    }
  }

  const roundedCeilSeconds = Math.ceil(rateLimitFloorSeconds);

  return {
    isEstimate: true,
    basis,
    bound,
    boundDescription,
    rowsToConvert,
    breakdown,
    subtractions: {
      totalRows,
      noiseRows: noiseRowsInRoutable,
      unroutableRows,
      duplicateSurplusRows: duplicateSurplusInRoutable,
    },
    tokenModel: {
      fixedInputPerRow: CONVERSION_BUDGET_CONSTANTS.fixedInputTokensPerRow,
      fixedOutputPerRow: CONVERSION_BUDGET_CONSTANTS.fixedOutputTokensPerRow,
      estimatedSourceTokensPerRow: sourceTokensPerRow,
      totalInputPerRow: inputPerRow,
      totalOutputPerRow: outputPerRow,
      embeddingTokensPerRow: embeddingPerRow,
    },
    estimatedTokens: {
      chatInput: chatInputTokens,
      chatOutput: chatOutputTokens,
      chatTotal: chatTotalTokens,
      embeddingTotal: embeddingTotalTokens,
    },
    pricingSource,
    estimatedCostUsd: {
      chat: chatCost,
      embedding: embeddingCost,
      total: totalCost,
    },
    estimatedWallClock: {
      rateLimitFloorSeconds: Math.round(rateLimitFloorSeconds * 100) / 100,
      seconds: roundedCeilSeconds,
      humanReadable: formatDurationHuman(roundedCeilSeconds),
      bindingCap,
      bottleneck: bindingCap,
      label: "rate-limit floor; excludes per-request latency, retries and backoff — actual wall clock will be longer",
      durations: {
        chatRpmSeconds: Math.round(chatRpmDurationSeconds * 100) / 100,
        chatTpmSeconds: Math.round(chatTpmDurationSeconds * 100) / 100,
        embeddingRpmSeconds: Math.round(embeddingRpmDurationSeconds * 100) / 100,
        embeddingTpmSeconds: Math.round(embeddingTpmDurationSeconds * 100) / 100,
      },
    },
    constants: CONVERSION_BUDGET_CONSTANTS,
  };
}
