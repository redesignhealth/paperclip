/**
 * LLM client for converting legacy memories to atomic schema (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * - Uses OpenAI Chat Completions with strict json_schema response_format.
 * - PRIVACY INVARIANT: The serialized request body contains ONLY the memory text
 *   inside <source_memory>...</source_memory>. It MUST NEVER include agent ID,
 *   agent name, company ID, company name, or source row ID.
 * - Transport failures (429/5xx/network/timeout) are retried with Retry-After-aware
 *   exponential backoff + jitter. If exhausted, resolves to outcome 'llm_unavailable'.
 * - Failed-attempt token refunds: deliberately NOT implemented (over-debiting is safe).
 * - INVARIANT: At most PREFLIGHT_MAX_CHAT_CALLS (2) billed chat calls per source, reported
 *   tokens >= tokens actually billed and <= preflight projection, no billed response ever retried.
 * - Schema violations trigger exactly ONE repair retry naming the violated rule class
 *   and appending the prior assistant turn. If sensitive content is detected in the raw
 *   model response, no repair turn is issued; it maps immediately to drop_sensitive
 *   (data_sensitive_echo) so sensitive text is never echoed back to the provider.
 * - Sensitive data detected in model output (data_sensitive_echo) maps to drop_sensitive,
 *   not quarantine.
 */

import {
  CANONICAL_CONVERSION_PARAMS,
  CONVERSION_JSON_SCHEMA,
  CONVERSION_REJECT_CODES,
  CONVERSION_SYSTEM_PROMPT,
  type ConversionRecord,
  SUPPORTED_CONVERTER_MODELS,
  type SupportedConverterModel,
  validateConversionOutput,
} from "./converter-contract.js";
import { type MonotonicClock, type Sleeper } from "./clock.js";
import { type RedactionRegistry } from "./openai-key.js";
import { estimateChatTokens, isInsufficientQuotaError, parseRetryAfterMs, type RateLimiter } from "./rate-limiter.js";
import { CompanyMemoryUpgradeError, TERMINAL_LLM_ERROR_CODES } from "./types.js";

/**
 * Exact bounded reason_code literal emitted for `dropped_noise` outcomes that were
 * classified by the model itself (decision: "drop_noise"). Shared as the producer constant
 * so validators can permit it as an exact literal.
 */
export const MODEL_CLASSIFIED_NOISE_REASON_CODE = "model_classified_noise";

/**
 * Exact bounded reason_code literal emitted for `dropped_sensitive` outcomes that were
 * classified by the model itself (decision: "drop_sensitive" with no regex family match
 * on the model's own textual output). This is a SINGLE fixed literal -- distinct from, and
 * never combined with, the sorted comma-separated regex family CSV emitted when our own
 * `detectSensitiveFamilies` regexes match (see sensitive-patterns.ts / converter-contract.ts
 * `data_sensitive_echo`). Shared here as the producer constant so validateOutcomeReason in
 * sweep-tenant.ts can permit it as an exact literal without weakening family CSV validation.
 */
export const MODEL_CLASSIFIED_SENSITIVE_REASON_CODE = "model_classified";

export type ConversionClientResult =
  | {
      status: "convert";
      records: ConversionRecord[];
      inputTokens: number;
      outputTokens: number;
    }
  | {
      status: "drop_noise";
      reasonCode: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      status: "drop_sensitive";
      reasonCode: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      status: "quarantined";
      rejectCode: string;
      inputTokens: number;
      outputTokens: number;
    };

export interface ConversionClient {
  convert(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<ConversionClientResult>;
}

export type ConversionChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Wraps raw source memory text in the privacy-invariant <source_memory> tags. */
export function buildConversionUserMessage(text: string): string {
  return `<source_memory>\n${text}\n</source_memory>`;
}

/** Builds the exact initial chat messages array sent to the conversion endpoint. */
export function buildInitialConversionMessages(text: string): ConversionChatMessage[] {
  return [
    { role: "system", content: CONVERSION_SYSTEM_PROMPT },
    { role: "user", content: buildConversionUserMessage(text) },
  ];
}

/**
 * Builds the exact repair-retry chat messages array, given the initial messages, the
 * (rejected) prior assistant response content, and the violated rule class being repaired.
 */
export function buildRepairConversionMessages(
  initialMessages: ConversionChatMessage[],
  priorResponseContent: string,
  repairRuleClass: string,
): ConversionChatMessage[] {
  return [
    ...initialMessages,
    { role: "assistant", content: priorResponseContent },
    {
      role: "user",
      content: `Your previous response was rejected due to rule violation: ${repairRuleClass}. Please produce a strictly compliant JSON response satisfying all rules.`,
    },
  ];
}

/** Mirrors the literal max_completion_tokens cap applied to every chat conversion call. */
export const PREFLIGHT_MAX_COMPLETION_TOKENS = CANONICAL_CONVERSION_PARAMS.max_completion_tokens;

/** Builds the exact serialized request body sent to the chat completions endpoint. */
export function buildConversionRequestBody(
  model: string,
  messages: ConversionChatMessage[],
): string {
  return JSON.stringify({
    model,
    messages,
    ...CANONICAL_CONVERSION_PARAMS,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "memory_conversion",
        strict: true,
        schema: CONVERSION_JSON_SCHEMA,
      },
    },
  });
}

const LONGEST_REJECT_CODE = CONVERSION_REJECT_CODES.reduce(
  (longest, code) => (code.length > longest.length ? code : longest),
  "",
);

/**
 * Worst-case assumed bytes-per-output-token heuristic when projecting the size of the model's own
 * prior (rejected) response as it gets echoed back into the repair-retry request.
 *
 * Heuristic allowance: assumes an average of up to 4 characters per token, with each
 * character expanding to up to 6 bytes under JSON string escaping (e.g. \u00XX control codes),
 * yielding 4 * 6 = 24 bytes/token. This is a heuristic allowance enforced by the actual-body
 * fail-closed guard (isRepairRequestBodyOversize), not a mathematically proven token ceiling.
 */
export const PREFLIGHT_REPAIR_ECHO_BYTES_PER_OUTPUT_TOKEN = 24;

/**
 * Evaluates whether an actual serialized repair request body exceeds the projected byte bound.
 * Returns true if the repair request is oversize and must be aborted/quarantined.
 */
export function isRepairRequestBodyOversize(
  actualBytes: number,
  projectedBytes: number,
): boolean {
  return actualBytes > projectedBytes;
}

/**
 * Projects the worst-case serialized repair request body byte length for a given source
 * text and model. Serializes a base repair body with an empty echo and adds the worst-case
 * echo bytes analytically (PREFLIGHT_MAX_COMPLETION_TOKENS * PREFLIGHT_REPAIR_ECHO_BYTES_PER_OUTPUT_TOKEN).
 *
 * This is the single source of truth for both preflight cost estimation (cost.ts) and
 * the runtime guard before issuing a repair call (llm-converter.ts).
 */
export function projectWorstCaseRepairRequestBodyBytes(
  sourceText: string | null | undefined,
  model: string,
): number {
  const initialMessages = buildInitialConversionMessages(sourceText ?? "");
  const emptyEchoRepairMessages = buildRepairConversionMessages(
    initialMessages,
    "",
    LONGEST_REJECT_CODE,
  );
  const emptyEchoRepairBody = buildConversionRequestBody(model, emptyEchoRepairMessages);
  const baseBytes = Buffer.byteLength(emptyEchoRepairBody, "utf8");
  const worstCaseEchoBytes =
    PREFLIGHT_MAX_COMPLETION_TOKENS * PREFLIGHT_REPAIR_ECHO_BYTES_PER_OUTPUT_TOKEN;
  return baseBytes + worstCaseEchoBytes;
}

export interface CreateOpenAiConversionClientOptions {
  apiKey: string;
  model?: SupportedConverterModel | string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  limiter: RateLimiter;
  sleeper: Sleeper;
  clock: MonotonicClock;
  redaction?: RedactionRegistry;
  maxAttempts?: number;
  random?: () => number;
}

export function createOpenAiConversionClient(
  options: CreateOpenAiConversionClientOptions,
): ConversionClient {
  const {
    apiKey,
    model = "gpt-5.4-mini",
    baseUrl = "https://api.openai.com/v1",
    fetchImpl = globalThis.fetch,
    limiter,
    sleeper,
    clock,
    redaction,
    maxAttempts = 5,
    random = Math.random,
  } = options;

  if (!SUPPORTED_CONVERTER_MODELS.includes(model as SupportedConverterModel)) {
    throw new CompanyMemoryUpgradeError(
      `Unsupported converter model '${model}'. Supported models: [${SUPPORTED_CONVERTER_MODELS.join(", ")}]`,
      "INVALID_ARGUMENT",
    );
  }

  redaction?.add(apiKey);

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  type AttemptResult =
    | { kind: "ok"; data: { content: string; inputTokens: number; outputTokens: number } }
    | { kind: "billed_unusable"; data: { inputTokens: number; outputTokens: number } }
    | { kind: "retry"; delayMs: number };

  type ExecuteChatResponse =
    | { kind: "ok"; content: string; inputTokens: number; outputTokens: number }
    | { kind: "unusable"; inputTokens: number; outputTokens: number };

  async function executeChatRequest(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    estimatedTokens: number,
    signal?: AbortSignal,
    prebuiltBody?: string,
  ): Promise<ExecuteChatResponse> {
    let attempt = 0;
    let baseDelayMs = 500;

    async function performSingleAttempt(
      currentAttempt: number,
      currentBaseDelayMs: number,
    ): Promise<AttemptResult> {
      const lease = await limiter.acquire(estimatedTokens);
      try {
        const body = prebuiltBody ?? buildConversionRequestBody(model, messages);
        let res: Response;
        try {
          res = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body,
            signal,
          });
        } catch (fetchErr: unknown) {
          if (fetchErr instanceof CompanyMemoryUpgradeError) {
            throw fetchErr;
          }
          if (signal?.aborted) {
            throw new CompanyMemoryUpgradeError("Conversion aborted.", "ABORTED_BY_OPERATOR");
          }
          if (currentAttempt >= maxAttempts) {
            const rawMsg =
              fetchErr && typeof fetchErr === "object" && "message" in fetchErr && (fetchErr as any).message
                ? String((fetchErr as any).message)
                : "network error";
            const msg = redaction
              ? `OpenAI request failed after ${maxAttempts} attempts: ${redaction.scrub(rawMsg)}`
              : `OpenAI request failed after ${maxAttempts} attempts.`;
            throw new CompanyMemoryUpgradeError(msg, "LLM_UNAVAILABLE");
          }
          const jitter = Math.floor(random() * 50);
          const delay = currentBaseDelayMs + jitter;
          return { kind: "retry", delayMs: delay };
        }

        if (signal?.aborted) {
          throw new CompanyMemoryUpgradeError("Conversion aborted.", "ABORTED_BY_OPERATOR");
        }

        if (!res.ok) {
          const status = res.status;
          const isRetryable = status === 408 || status === 409 || status >= 500;

          if (status === 429) {
            const errBody = await res.text().catch(() => "");
            if (isInsufficientQuotaError(errBody)) {
              const msg = redaction
                ? redaction.scrub("OpenAI chat completions failed with HTTP 429: insufficient_quota")
                : "OpenAI chat completions failed with HTTP 429: insufficient_quota";
              throw new CompanyMemoryUpgradeError(msg, "COMPANY_OPENAI_QUOTA_EXHAUSTED");
            }
            if (currentAttempt >= maxAttempts) {
              throw new CompanyMemoryUpgradeError(
                `OpenAI chat completions failed with HTTP 429 after ${maxAttempts} attempts.`,
                "LLM_UNAVAILABLE",
              );
            }
            const nowMs = clock.nowMs();
            const retryAfterMs = parseRetryAfterMs(res.headers, nowMs);
            const jitter = Math.floor(random() * 50);
            const delay = Math.max(retryAfterMs ?? 0, currentBaseDelayMs) + jitter;
            return { kind: "retry", delayMs: delay };
          }

          if (isRetryable) {
            if (currentAttempt >= maxAttempts) {
              throw new CompanyMemoryUpgradeError(
                `OpenAI chat completions failed with HTTP ${status} after ${maxAttempts} attempts.`,
                "LLM_UNAVAILABLE",
              );
            }
            const nowMs = clock.nowMs();
            const retryAfterMs = parseRetryAfterMs(res.headers, nowMs);
            const jitter = Math.floor(random() * 50);
            const delay = Math.max(retryAfterMs ?? 0, currentBaseDelayMs) + jitter;
            return { kind: "retry", delayMs: delay };
          }

          // Terminal 4xx:
          if (status === 401 || status === 403) {
            const msg = redaction
              ? redaction.scrub(`OpenAI chat completions request rejected with HTTP ${status}`)
              : `OpenAI chat completions request rejected with HTTP ${status}`;
            throw new CompanyMemoryUpgradeError(msg, "COMPANY_OPENAI_KEY_REJECTED");
          }

          // Any other terminal 4xx (400, 402, 404, 413, 422, etc.)
          const msg = redaction
            ? redaction.scrub(`OpenAI chat completions request rejected with HTTP ${status}`)
            : `OpenAI chat completions request rejected with HTTP ${status}`;
          throw new CompanyMemoryUpgradeError(msg, "LLM_REQUEST_REJECTED");
        }

        // res.ok: separate try/catch around res.json()
        let data: unknown;
        try {
          data = await res.json();
        } catch (jsonErr: unknown) {
          if (signal?.aborted) {
            throw new CompanyMemoryUpgradeError("Conversion aborted.", "ABORTED_BY_OPERATOR");
          }
          const inputTokens = Buffer.byteLength(body, "utf8");
          const outputTokens = PREFLIGHT_MAX_COMPLETION_TOKENS;
          lease.settle(inputTokens + outputTokens);
          return {
            kind: "billed_unusable",
            data: { inputTokens, outputTokens },
          };
        }

        // Usage extraction ABOVE content-type check, settle once
        const rawUsage =
          data && typeof data === "object" && "usage" in data && data.usage && typeof data.usage === "object"
            ? (data.usage as Record<string, unknown>)
            : undefined;

        const rawPromptTokens = rawUsage?.prompt_tokens;
        const inputTokens =
          typeof rawPromptTokens === "number" && Number.isFinite(rawPromptTokens) && rawPromptTokens >= 0
            ? rawPromptTokens
            : Buffer.byteLength(body, "utf8");

        const rawCompletionTokens = rawUsage?.completion_tokens;
        const outputTokens =
          typeof rawCompletionTokens === "number" && Number.isFinite(rawCompletionTokens) && rawCompletionTokens >= 0
            ? rawCompletionTokens
            : PREFLIGHT_MAX_COMPLETION_TOKENS;

        const rawTotalTokens = rawUsage?.total_tokens;
        const totalTokens =
          typeof rawTotalTokens === "number" && Number.isFinite(rawTotalTokens) && rawTotalTokens >= 0
            ? rawTotalTokens
            : inputTokens + outputTokens;

        lease.settle(totalTokens);

        const rawChoices =
          data && typeof data === "object" && "choices" in data && Array.isArray((data as any).choices)
            ? (data as any).choices
            : undefined;
        const firstChoice = rawChoices?.[0];
        const rawMessage =
          firstChoice && typeof firstChoice === "object" && "message" in firstChoice && firstChoice.message && typeof firstChoice.message === "object"
            ? (firstChoice.message as Record<string, unknown>)
            : undefined;
        const content = rawMessage?.content;

        if (typeof content !== "string") {
          return {
            kind: "billed_unusable",
            data: { inputTokens, outputTokens },
          };
        }

        return {
          kind: "ok",
          data: { content, inputTokens, outputTokens },
        };
      } finally {
        lease.release();
      }
    }

    while (attempt < maxAttempts) {
      if (signal?.aborted) {
        throw new CompanyMemoryUpgradeError("Conversion aborted.", "ABORTED_BY_OPERATOR");
      }

      attempt++;
      const result = await performSingleAttempt(attempt, baseDelayMs);
      if (result.kind === "ok") {
        return { kind: "ok", ...result.data };
      }
      if (result.kind === "billed_unusable") {
        return { kind: "unusable", ...result.data };
      }
      baseDelayMs *= 2;
      await sleeper.sleep(result.delayMs);
    }

    throw new CompanyMemoryUpgradeError(
      `OpenAI request failed: exhausted ${maxAttempts} attempts.`,
      "LLM_UNAVAILABLE",
    );
  }

  return {
    async convert(
      text: string,
      options?: { signal?: AbortSignal },
    ): Promise<ConversionClientResult> {
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      // 1. Initial attempt
      const messages = buildInitialConversionMessages(text);

      const estimatedTokens = estimateChatTokens(text);

      let responseContent: string;
      try {
        const resp = await executeChatRequest(messages, estimatedTokens, options?.signal);
        totalInputTokens += resp.inputTokens;
        totalOutputTokens += resp.outputTokens;
        if (resp.kind === "unusable") {
          return {
            status: "quarantined",
            rejectCode: "llm_unavailable",
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        responseContent = resp.content;
      } catch (err: any) {
        if (
          err instanceof CompanyMemoryUpgradeError &&
          (err.code === "ABORTED_BY_OPERATOR" || TERMINAL_LLM_ERROR_CODES.has(err.code))
        ) {
          throw err;
        }
        return {
          status: "quarantined",
          rejectCode: "llm_unavailable",
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // 2. Validate first output
      let validation = validateConversionOutput(responseContent);

      if (validation.ok) {
        if (validation.decision === "convert") {
          return {
            status: "convert",
            records: validation.records,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        if (validation.decision === "drop_noise") {
          return {
            status: "drop_noise",
            reasonCode: MODEL_CLASSIFIED_NOISE_REASON_CODE,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        // drop_sensitive
        return {
          status: "drop_sensitive",
          reasonCode: MODEL_CLASSIFIED_SENSITIVE_REASON_CODE,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // Sensitive data echo detected in model output maps to drop_sensitive, not quarantine
      if (validation.rejectCode === "data_sensitive_echo") {
        return {
          status: "drop_sensitive",
          reasonCode: validation.sensitiveReasonCode,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // 3. Schema or rule violation -> Exactly ONE repair retry naming the violated rule class
      const repairRuleClass = validation.rejectCode;
      const repairMessages = buildRepairConversionMessages(messages, responseContent, repairRuleClass);
      const repairBody = buildConversionRequestBody(model, repairMessages);
      const repairRequestBodyBytes = Buffer.byteLength(repairBody, "utf8");
      const maxRepairRequestBodyBytes = projectWorstCaseRepairRequestBodyBytes(text, model);

      // Fail-closed bound: if the actual serialized repair request exceeds the preflight
      // byte projection used by cost estimation (e.g. quote-heavy/control/multibyte echo),
      // quarantine immediately with first-call usage and do not issue a paid repair call.
      if (isRepairRequestBodyOversize(repairRequestBodyBytes, maxRepairRequestBodyBytes)) {
        return {
          status: "quarantined",
          rejectCode: validation.rejectCode,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      try {
        const repairEstimatedTokens = Math.max(
          estimatedTokens + 100,
          repairRequestBodyBytes + PREFLIGHT_MAX_COMPLETION_TOKENS,
        );
        const repairResp = await executeChatRequest(repairMessages, repairEstimatedTokens, options?.signal, repairBody);
        totalInputTokens += repairResp.inputTokens;
        totalOutputTokens += repairResp.outputTokens;
        if (repairResp.kind === "unusable") {
          return {
            status: "quarantined",
            rejectCode: "llm_unavailable",
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        responseContent = repairResp.content;
      } catch (err: any) {
        if (
          err instanceof CompanyMemoryUpgradeError &&
          (err.code === "ABORTED_BY_OPERATOR" || TERMINAL_LLM_ERROR_CODES.has(err.code))
        ) {
          throw err;
        }
        return {
          status: "quarantined",
          rejectCode: "llm_unavailable",
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // 4. Validate repaired output
      validation = validateConversionOutput(responseContent);

      if (validation.ok) {
        if (validation.decision === "convert") {
          return {
            status: "convert",
            records: validation.records,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        if (validation.decision === "drop_noise") {
          return {
            status: "drop_noise",
            reasonCode: MODEL_CLASSIFIED_NOISE_REASON_CODE,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        // drop_sensitive
        return {
          status: "drop_sensitive",
          reasonCode: MODEL_CLASSIFIED_SENSITIVE_REASON_CODE,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      if (validation.rejectCode === "data_sensitive_echo") {
        return {
          status: "drop_sensitive",
          reasonCode: validation.sensitiveReasonCode,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // Still invalid after repair retry -> quarantine with rejectCode
      return {
        status: "quarantined",
        rejectCode: validation.rejectCode,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };
    },
  };
}
