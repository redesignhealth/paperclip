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
 * - Schema violations trigger exactly ONE repair retry naming the violated rule class
 *   and appending the prior assistant turn (note: secrets are stripped prior to repair turn
 *   so no secret is echoed back to the provider).
 * - Sensitive data detected in model output (data_sensitive_echo) maps to drop_sensitive,
 *   not quarantine.
 */

import {
  CONVERSION_JSON_SCHEMA,
  CONVERSION_SYSTEM_PROMPT,
  type ConversionRecord,
  SUPPORTED_CONVERTER_MODELS,
  type SupportedConverterModel,
  validateConversionOutput,
} from "./converter-contract.js";
import { type MonotonicClock, type Sleeper } from "./clock.js";
import { type RedactionRegistry } from "./openai-key.js";
import { estimateChatTokens, parseRetryAfterMs, type RateLimiter } from "./rate-limiter.js";
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
export const PREFLIGHT_MAX_COMPLETION_TOKENS = 600;

/** Builds the exact serialized request body sent to the chat completions endpoint. */
export function buildConversionRequestBody(
  model: string,
  messages: ConversionChatMessage[],
): string {
  return JSON.stringify({
    model,
    messages,
    temperature: 0,
    top_p: 1,
    seed: 8191,
    max_completion_tokens: PREFLIGHT_MAX_COMPLETION_TOKENS,
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
    | { kind: "retry"; delayMs: number };

  async function executeChatRequest(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    estimatedTokens: number,
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    let attempt = 0;
    let baseDelayMs = 500;

    async function performSingleAttempt(
      currentAttempt: number,
      currentBaseDelayMs: number,
    ): Promise<AttemptResult> {
      const lease = await limiter.acquire(estimatedTokens);
      try {
        const body = buildConversionRequestBody(model, messages);
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
        } catch (fetchErr: any) {
          if (signal?.aborted) {
            throw new CompanyMemoryUpgradeError("Conversion aborted.", "ABORTED_BY_OPERATOR");
          }
          if (currentAttempt >= maxAttempts) {
            const rawMsg = fetchErr?.message ? String(fetchErr.message) : "network error";
            const scrubbed = redaction ? redaction.scrub(rawMsg) : rawMsg;
            throw new CompanyMemoryUpgradeError(
              `OpenAI request failed after ${maxAttempts} attempts: ${scrubbed}`,
              "LLM_UNAVAILABLE",
            );
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
            if (errBody.includes("insufficient_quota")) {
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

        // res.ok
        const data: any = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          if (currentAttempt >= maxAttempts) {
            throw new CompanyMemoryUpgradeError(
              `OpenAI chat completions failed: missing string content after ${maxAttempts} attempts`,
              "LLM_UNAVAILABLE",
            );
          }
          const jitter = Math.floor(random() * 50);
          const delay = currentBaseDelayMs + jitter;
          return { kind: "retry", delayMs: delay };
        }

        const rawPromptTokens = data.usage?.prompt_tokens;
        const inputTokens =
          typeof rawPromptTokens === "number" && Number.isFinite(rawPromptTokens) && rawPromptTokens >= 0
            ? rawPromptTokens
            : Buffer.byteLength(body, "utf8");

        const rawCompletionTokens = data.usage?.completion_tokens;
        const outputTokens =
          typeof rawCompletionTokens === "number" && Number.isFinite(rawCompletionTokens) && rawCompletionTokens >= 0
            ? rawCompletionTokens
            : PREFLIGHT_MAX_COMPLETION_TOKENS;

        const rawTotalTokens = data.usage?.total_tokens;
        const totalTokens =
          typeof rawTotalTokens === "number" && Number.isFinite(rawTotalTokens) && rawTotalTokens >= 0
            ? rawTotalTokens
            : inputTokens + outputTokens;

        lease.settle(totalTokens);

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
        return result.data;
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

      try {
        const repairResp = await executeChatRequest(repairMessages, estimatedTokens + 100, options?.signal);
        totalInputTokens += repairResp.inputTokens;
        totalOutputTokens += repairResp.outputTokens;
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
