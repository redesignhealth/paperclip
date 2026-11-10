/**
 * Pure bigint nanodollar cost accounting for company memory conversion sweeps (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * - All cost arithmetic is performed in bigint nanodollars (1 USD === 1_000_000_000n nanodollars)
 *   to avoid floating point drift across a long-running sweep.
 * - USD inputs (operator --max-cost-usd and price overrides) are capped at MAX_USD_CAP
 *   (1,000,000 USD) and must be finite and nonnegative.
 * - Token-cost conversion uses CEILING division against the per-million-token rate so the
 *   computed cost is never an UNDERESTIMATE of the true cost (conservative, never truncates
 *   a fractional nanodollar away). Example: 1 token at $0.15/M tokens is
 *   150 nanodollars (NOT 1 nanodollar -- see ceilTokenCostNanodollars doc below).
 * - The sweep preflight estimator computes a worst-case cost ceiling for a single source
 *   BEFORE any API key is resolved or any paid call is made, so that a source whose worst
 *   case would blow the budget is rejected with ZERO network calls.
 * - This module is pure: no I/O, no network, no database access.
 */

import {
  CONVERSION_REJECT_CODES,
} from "./converter-contract.js";
import {
  buildConversionRequestBody,
  buildInitialConversionMessages,
  buildRepairConversionMessages,
  PREFLIGHT_MAX_COMPLETION_TOKENS,
} from "./llm-converter.js";
import { CompanyMemoryUpgradeError } from "./types.js";

/** 1 USD === 1_000_000_000 nanodollars. */
export const NANODOLLARS_PER_USD = 1_000_000_000n;

/**
 * Operational cap for any single USD-denominated input to this module (operator
 * --max-cost-usd budget, or a per-million-token price override). This is NOT a
 * claim about real-world OpenAI pricing; it exists purely to keep bigint arithmetic
 * bounded and to reject obviously-malformed operator input (e.g. a price typo of
 * 1e12 USD/M tokens).
 */
export const MAX_USD_CAP = 1_000_000;

/** Max 32-bit-safe-ish cap for raw token counts supplied to cost functions. */
const MAX_TOKEN_COUNT = 1_000_000_000_000; // 1e12 tokens; generous, prevents overflow abuse

const LONGEST_REJECT_CODE = CONVERSION_REJECT_CODES.reduce(
  (longest, code) => (code.length > longest.length ? code : longest),
  "",
);

function assertFiniteNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(value)) {
    throw new CompanyMemoryUpgradeError(
      `Invalid cost input "${fieldName}": must be a finite number.`,
      "INVALID_ARGUMENT",
    );
  }
}

/**
 * Validates and converts a USD amount into bigint nanodollars.
 * Rejects non-finite values, negative values, and values exceeding MAX_USD_CAP.
 *
 * ASYMMETRY CONTRACT:
 * - Prices (rate per million tokens) use roundingMode = "ceil" so token costs are never underestimated.
 * - Budget cap (--max-cost-usd) uses roundingMode = "floor" in createCostTracker so allowed spending is never rounded up.
 */
export function usdToNanodollars(
  usd: number,
  fieldName: string = "usd",
  roundingMode: "ceil" | "floor" = "ceil",
): bigint {
  assertFiniteNumber(usd, fieldName);
  if (usd < 0) {
    throw new CompanyMemoryUpgradeError(
      `Invalid cost input "${fieldName}": must be nonnegative, found ${usd}.`,
      "INVALID_ARGUMENT",
    );
  }
  if (usd > MAX_USD_CAP) {
    throw new CompanyMemoryUpgradeError(
      `Invalid cost input "${fieldName}": exceeds operational cap of $${MAX_USD_CAP.toLocaleString()}.`,
      "INVALID_ARGUMENT",
    );
  }
  // Scale with enough precision to represent sub-cent USD inputs (e.g. 0.000000001)
  // without losing significant digits to floating point rounding before converting to bigint.
  const scaled = usd * 1e9;
  const nanodollars = roundingMode === "floor" ? Math.floor(scaled) : Math.ceil(scaled);
  return BigInt(nanodollars);
}

/**
 * Validates and converts a USD-per-million-tokens price into bigint nanodollars-per-million-tokens.
 * Same validation rules as usdToNanodollars (nonnegative, finite, capped at MAX_USD_CAP).
 */
export function priceUsdPerMillionToNanodollars(usdPerMillion: number, fieldName: string): bigint {
  return usdToNanodollars(usdPerMillion, fieldName);
}

export interface CostRatesNanodollars {
  chatInputNanoPerMillion: bigint;
  chatOutputNanoPerMillion: bigint;
  embeddingNanoPerMillion: bigint;
}

export interface CostRatesUsdInput {
  chatInputUsdPerMillion: number;
  chatOutputUsdPerMillion: number;
  embeddingUsdPerMillion: number;
}

export function buildCostRatesNanodollars(input: CostRatesUsdInput): CostRatesNanodollars {
  return {
    chatInputNanoPerMillion: priceUsdPerMillionToNanodollars(input.chatInputUsdPerMillion, "chatInputUsdPerMillion"),
    chatOutputNanoPerMillion: priceUsdPerMillionToNanodollars(input.chatOutputUsdPerMillion, "chatOutputUsdPerMillion"),
    embeddingNanoPerMillion: priceUsdPerMillionToNanodollars(input.embeddingUsdPerMillion, "embeddingUsdPerMillion"),
  };
}

function coerceTokenCount(tokens: number | bigint, fieldName: string): bigint {
  if (typeof tokens === "bigint") {
    if (tokens < 0n) {
      throw new CompanyMemoryUpgradeError(
        `Invalid token count "${fieldName}": must be nonnegative.`,
        "INVALID_ARGUMENT",
      );
    }
    return tokens;
  }
  assertFiniteNumber(tokens, fieldName);
  if (tokens < 0 || tokens > MAX_TOKEN_COUNT) {
    throw new CompanyMemoryUpgradeError(
      `Invalid token count "${fieldName}": must be between 0 and ${MAX_TOKEN_COUNT}.`,
      "INVALID_ARGUMENT",
    );
  }
  return BigInt(Math.ceil(tokens));
}

/**
 * Computes the nanodollar cost of `tokens` tokens at `priceNanoPerMillion` nanodollars
 * per million tokens, using CEILING division.
 *
 * This is intentionally a ceiling, not a floor/truncation: billing-ceiling division means
 * any fractional nanodollar remainder rounds the cost UP, so the computed figure is never
 * an underestimate of true cost. For example at $0.15/M tokens (150,000,000 nanodollars
 * per million tokens), a single token costs ceil(1 * 150_000_000 / 1_000_000) = 150
 * nanodollars -- NOT 1 nanodollar. (A naive per-million-then-truncate computation that
 * yields "1" for this case is a known flawed heuristic and must not be reproduced.)
 */
export function ceilTokenCostNanodollars(tokens: number | bigint, priceNanoPerMillion: bigint): bigint {
  const t = coerceTokenCount(tokens, "tokens");
  if (priceNanoPerMillion < 0n) {
    throw new CompanyMemoryUpgradeError(
      "Invalid price: nanodollars-per-million-tokens must be nonnegative.",
      "INVALID_ARGUMENT",
    );
  }
  if (t === 0n || priceNanoPerMillion === 0n) {
    return 0n;
  }
  const numerator = t * priceNanoPerMillion;
  const denominator = 1_000_000n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Computes UTF-8 byte length of a string. Used as a conservative (upper-bound) proxy for
 * token count: BPE tokenizers over UTF-8 byte streams never produce more tokens than there
 * are bytes (every token consumes at least one byte), so byte length is a safe ceiling for
 * "worst case" token projection, unlike a fixed characters-per-token ASCII heuristic which
 * silently underestimates for multi-byte Unicode text (e.g. CJK, emoji, accented Latin).
 */
export function utf8ByteLength(text: string | null | undefined): number {
  if (!text) return 0;
  return Buffer.byteLength(text, "utf8");
}

// --- Preflight worst-case per-source cost ceiling -----------------------------------------

/** Converter contract caps max_completion_tokens at 600 for both the initial and repair chat calls. */
export const PREFLIGHT_MAX_OUTPUT_TOKENS_PER_CHAT_CALL = PREFLIGHT_MAX_COMPLETION_TOKENS;
/** At most one initial chat call plus exactly one repair retry. */
export const PREFLIGHT_MAX_CHAT_CALLS = 2;
/** The converter contract allows between 1 and 3 converted records per source, each re-embedded once. */
export const PREFLIGHT_MAX_EMBEDDING_CALLS = 3;
/** Converter contract hard caps each converted record's `data` field at 400 characters (data_too_long). */
export const PREFLIGHT_MAX_RECORD_DATA_CHARS = 400;
/** Max UTF-8 encoding width of a single Unicode code point. */
export const UTF8_MAX_BYTES_PER_CHAR = 4;

export interface PreflightCostInput {
  /** The exact serialized initial chat request body (JSON.stringify of the real request payload). */
  initialRequestBodyBytes: number;
  /** The exact serialized repair-retry chat request body (JSON.stringify of the real repair payload). */
  repairRequestBodyBytes: number;
  rates: CostRatesNanodollars;
}

export interface PreflightCostEstimate {
  worstCaseNanodollars: bigint;
  projectedChatInputTokens: number;
  projectedChatOutputTokens: number;
  projectedEmbeddingTokens: number;
}

/**
 * Computes the worst-case nanodollar cost ceiling for converting ONE source row, covering:
 *   - up to PREFLIGHT_MAX_CHAT_CALLS (2) chat completions calls (initial + one repair retry),
 *     each capped at PREFLIGHT_MAX_OUTPUT_TOKENS_PER_CHAT_CALL (600) output tokens, with input
 *     tokens projected conservatively from the ACTUAL serialized request body byte length
 *     (including full system prompt, schema, wrapper tags, and -- for the repair call -- the
 *     echoed prior turn and repair instruction overhead);
 *   - up to PREFLIGHT_MAX_EMBEDDING_CALLS (3) embedding calls, each projected conservatively
 *     from the maximum possible converted record size (PREFLIGHT_MAX_RECORD_DATA_CHARS Unicode
 *     characters at UTF8_MAX_BYTES_PER_CHAR bytes/char), NOT a fixed-token ASCII heuristic.
 *
 * This is an OPERATIONAL ESTIMATE used purely to gate spend before any API key is resolved or
 * any paid call is made. It is deliberately conservative (an over-estimate) and is NOT a
 * billing guarantee -- actual OpenAI billing is authoritative and is reconciled after each
 * real call via the actual-usage accounting in runMemoryUpgradeSweep (costTracker.addActualCostNanodollars).
 */
export function estimateWorstCaseSourceCostNanodollars(input: PreflightCostInput): PreflightCostEstimate {
  const { rates } = input;

  // Chat: input tokens bounded by actual serialized request body bytes (conservative upper bound).
  const projectedChatInputTokens = input.initialRequestBodyBytes + input.repairRequestBodyBytes;
  const projectedChatOutputTokens = PREFLIGHT_MAX_OUTPUT_TOKENS_PER_CHAT_CALL * PREFLIGHT_MAX_CHAT_CALLS;

  const chatInputCost = ceilTokenCostNanodollars(projectedChatInputTokens, rates.chatInputNanoPerMillion);
  const chatOutputCost = ceilTokenCostNanodollars(projectedChatOutputTokens, rates.chatOutputNanoPerMillion);

  // Embedding: worst case is PREFLIGHT_MAX_EMBEDDING_CALLS records, each at the maximum
  // possible converted record length, projected via UTF-8 byte-length upper bound (not a
  // fixed ASCII tokens-per-row heuristic, which silently undercounts for Unicode text).
  const maxBytesPerRecord = PREFLIGHT_MAX_RECORD_DATA_CHARS * UTF8_MAX_BYTES_PER_CHAR;
  const projectedEmbeddingTokens = maxBytesPerRecord * PREFLIGHT_MAX_EMBEDDING_CALLS;
  const embeddingCost = ceilTokenCostNanodollars(projectedEmbeddingTokens, rates.embeddingNanoPerMillion);

  const worstCaseNanodollars = chatInputCost + chatOutputCost + embeddingCost;

  return {
    worstCaseNanodollars,
    projectedChatInputTokens,
    projectedChatOutputTokens,
    projectedEmbeddingTokens,
  };
}

/**
 * Worst-case assumed bytes-per-output-token when projecting the size of the model's own
 * prior (rejected) response as it gets echoed back into the repair-retry request. There is
 * no way to know the real byte size before the call happens; UTF8_MAX_BYTES_PER_CHAR (4) is
 * used as a deliberately generous ceiling, consistent with the embedding projection above.
 */
export const PREFLIGHT_REPAIR_ECHO_BYTES_PER_OUTPUT_TOKEN = UTF8_MAX_BYTES_PER_CHAR;

/**
 * Builds the ACTUAL serialized initial request body, and a worst-case serialized repair
 * request body (with a maximally-sized placeholder standing in for the not-yet-known prior
 * model response), so byte projections reflect the real wrapper/prompt/schema overhead
 * instead of a guessed constant.
 */
export function projectWorstCaseConversionRequestBytes(
  sourceText: string | null | undefined,
  model: string,
): { initialRequestBodyBytes: number; repairRequestBodyBytes: number } {
  const initialMessages = buildInitialConversionMessages(sourceText ?? "");
  const initialBody = buildConversionRequestBody(model, initialMessages);
  const initialRequestBodyBytes = utf8ByteLength(initialBody);

  const worstCaseEchoBytes = PREFLIGHT_MAX_OUTPUT_TOKENS_PER_CHAT_CALL * PREFLIGHT_REPAIR_ECHO_BYTES_PER_OUTPUT_TOKEN;
  const placeholderPriorResponse = "x".repeat(worstCaseEchoBytes);
  const repairMessages = buildRepairConversionMessages(initialMessages, placeholderPriorResponse, LONGEST_REJECT_CODE);
  const repairBody = buildConversionRequestBody(model, repairMessages);
  const repairRequestBodyBytes = utf8ByteLength(repairBody);

  return { initialRequestBodyBytes, repairRequestBodyBytes };
}

/**
 * Convenience wrapper: projects the real request byte overhead for `sourceText` under
 * `model`, then computes the worst-case nanodollar cost ceiling for converting that one
 * source row. Safe to call before any API key is resolved or any paid call is made.
 */
export function estimateWorstCaseSourceCostNanodollarsForText(
  sourceText: string | null | undefined,
  model: string,
  rates: CostRatesNanodollars,
): PreflightCostEstimate {
  const { initialRequestBodyBytes, repairRequestBodyBytes } = projectWorstCaseConversionRequestBytes(
    sourceText,
    model,
  );
  return estimateWorstCaseSourceCostNanodollars({
    initialRequestBodyBytes,
    repairRequestBodyBytes,
    rates,
  });
}

// --- Running spend tracker --------------------------------------------------------------

export interface CostTracker {
  /** Total nanodollars spent so far across the whole sweep (never reset). */
  readonly spentNanodollars: bigint;
  /** Nanodollars spent since the last successful resetPageDelta() call. */
  readonly pageCostNanodollars: bigint;
  /** The configured budget cap in nanodollars, or null if unbounded. */
  readonly maxCostNanodollars: bigint | null;
  /** Records actual spend (chat + embedding) against both cumulative and page-delta counters. */
  addActualCostNanodollars(nano: bigint): void;
  /**
   * Throws ABORTED_BY_OPERATOR if spending `projectedNano` MORE nanodollars, on top of
   * spend already recorded, would exceed the configured budget (strictly greater than
   * maxCostNanodollars; exact match to budget is permitted as a deliberate choice).
   * Intended to be called with a worst-case PREFLIGHT estimate BEFORE any paid call is issued
   * (so the abort happens with zero additional API calls), and again with zero projected delta
   * immediately after recording actual spend (defense in depth).
   */
  assertBudgetAllows(projectedNano: bigint): void;
  /**
   * Resets the page delta to zero. Callers MUST only call this AFTER the control-plane
   * counter flush carrying `pageCostNanodollars` has been durably committed -- read
   * `pageCostNanodollars` first to get the value to flush, perform the flush, and only
   * call `resetPageDelta()` once that flush has succeeded. If the flush throws, the page
   * delta is deliberately left intact so a retried flush still carries the unflushed spend
   * (never silently dropped, and never re-derived from the cumulative total as if it were
   * a fresh delta).
   */
  resetPageDelta(): void;
}

export function createCostTracker(maxCostUsd: number | null | undefined): CostTracker {
  const maxCostNanodollars =
    maxCostUsd === null || maxCostUsd === undefined
      ? null
      : usdToNanodollars(maxCostUsd, "maxCostUsd", "floor");

  let spentNanodollars = 0n;
  let pageCostNanodollars = 0n;

  return {
    get spentNanodollars() {
      return spentNanodollars;
    },
    get pageCostNanodollars() {
      return pageCostNanodollars;
    },
    get maxCostNanodollars() {
      return maxCostNanodollars;
    },
    addActualCostNanodollars(nano: bigint): void {
      if (nano < 0n) {
        throw new CompanyMemoryUpgradeError(
          "Invalid actual cost delta: must be nonnegative nanodollars.",
          "INVALID_ARGUMENT",
        );
      }
      spentNanodollars += nano;
      pageCostNanodollars += nano;
    },
    assertBudgetAllows(projectedNano: bigint): void {
      if (maxCostNanodollars === null) return;
      if (projectedNano < 0n) {
        throw new CompanyMemoryUpgradeError(
          "Invalid projected cost: must be nonnegative nanodollars.",
          "INVALID_ARGUMENT",
        );
      }
      if (spentNanodollars + projectedNano > maxCostNanodollars) {
        throw new CompanyMemoryUpgradeError(
          "Conversion budget exceeded --max-cost-usd limit.",
          "ABORTED_BY_OPERATOR",
        );
      }
    },
    resetPageDelta(): void {
      pageCostNanodollars = 0n;
    },
  };
}
