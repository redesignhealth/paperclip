/**
 * Conversion budget and time estimator (TECH-8191).
 *
 * Estimates LLM token usage, API costs, and wall-clock time for an offline conversion sweep.
 * All figures produced here are clearly labelled as planning ESTIMATES.
 */

/**
 * Operator-maintained rate, token, and cost constants for company memory conversion sweeps.
 * Kept in one exported const; update here when model pricing or quota tiers change.
 */
export const CONVERSION_BUDGET_CONSTANTS = {
  // Fixed token model per row:
  // ~600 input tokens for system prompt + conversion schema instructions
  // ~80 output tokens for atomic sentence generation
  fixedInputTokensPerRow: 600,
  fixedOutputTokensPerRow: 80,

  // Character-to-token heuristic for original text token overhead
  charactersPerToken: 4,

  // Model pricing in USD per 1M tokens
  pricing: {
    // Chat conversion model (gpt-5.4-mini)
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

  // Target worker concurrency
  defaultConcurrency: 2,
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
}

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
  estimatedCostUsd: {
    chat: number;
    embedding: number;
    total: number;
  };
  estimatedWallClock: {
    seconds: number;
    humanReadable: string;
    concurrency: number;
    bottleneck: "rpm" | "tpm" | "none";
    rpmDurationSeconds: number;
    tpmDurationSeconds: number;
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

/**
 * Calculates conversion budget and time estimates.
 */
export function estimateConversionBudget(input: BudgetEstimateInput): ConversionBudgetEstimate {
  const {
    totalRows,
    averageTextLength,
  } = input;

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
  // Converted atomic text embedding tokens (approx equivalent to output tokens)
  const embeddingPerRow = outputPerRow;

  const chatInputTokens = rowsToConvert * inputPerRow;
  const chatOutputTokens = rowsToConvert * outputPerRow;
  const chatTotalTokens = chatInputTokens + chatOutputTokens;
  const embeddingTotalTokens = rowsToConvert * embeddingPerRow;

  const chatInputCost = (chatInputTokens / 1_000_000) * CONVERSION_BUDGET_CONSTANTS.pricing.chatInputUsdPerMillion;
  const chatOutputCost = (chatOutputTokens / 1_000_000) * CONVERSION_BUDGET_CONSTANTS.pricing.chatOutputUsdPerMillion;
  const chatCost = Math.round((chatInputCost + chatOutputCost) * 10_000) / 10_000;

  const embeddingCostRaw = (embeddingTotalTokens / 1_000_000) * CONVERSION_BUDGET_CONSTANTS.pricing.embeddingUsdPerMillion;
  const embeddingCost = Math.round(embeddingCostRaw * 100_000) / 100_000;

  const totalCost = Math.round((chatCost + embeddingCost) * 10_000) / 10_000;

  // Wall-clock calculation at concurrency 2 with RPM & TPM caps applied:
  // Take the max of the two constraint-derived durations.
  let rpmDurationSeconds = 0;
  let tpmDurationSeconds = 0;
  let bottleneck: "rpm" | "tpm" | "none" = "none";

  if (rowsToConvert > 0) {
    rpmDurationSeconds = (rowsToConvert / CONVERSION_BUDGET_CONSTANTS.rateLimits.chatRpmCap) * 60;
    tpmDurationSeconds = (chatTotalTokens / CONVERSION_BUDGET_CONSTANTS.rateLimits.chatTpmCap) * 60;
    bottleneck = rpmDurationSeconds >= tpmDurationSeconds ? "rpm" : "tpm";
  }

  const maxConstraintSeconds = Math.ceil(Math.max(rpmDurationSeconds, tpmDurationSeconds));

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
    estimatedCostUsd: {
      chat: chatCost,
      embedding: embeddingCost,
      total: totalCost,
    },
    estimatedWallClock: {
      seconds: maxConstraintSeconds,
      humanReadable: formatDurationHuman(maxConstraintSeconds),
      concurrency: CONVERSION_BUDGET_CONSTANTS.defaultConcurrency,
      bottleneck,
      rpmDurationSeconds: Math.round(rpmDurationSeconds * 10) / 10,
      tpmDurationSeconds: Math.round(tpmDurationSeconds * 10) / 10,
    },
    constants: CONVERSION_BUDGET_CONSTANTS,
  };
}
